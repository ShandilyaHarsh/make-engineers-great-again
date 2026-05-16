# TS-005: Medusa Order Tags For Internal Operations

## Metadata

- `id`: TS-005
- `source_repo`: [medusajs/medusa](https://github.com/medusajs/medusa)
- `repo_area`: admin order API, order module model, order update workflow, order change audit records, event emission, database migration
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 605
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about order ownership, audit trails, workflow events, and modeling tradeoffs without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds internal order tags for operations teams.

Admins can tag orders with labels such as `vip`, `fraud-review`, `warehouse-hold`, or `priority`. Tags are returned in admin order list/detail responses and can be replaced, appended, or removed through new admin endpoints.

The PR adds:

- a `tags` field on orders,
- migration support for the new field,
- admin response/query support,
- tag validators and normalization helpers,
- `POST /admin/orders/:id/tags` and `DELETE /admin/orders/:id/tags/:tag`,
- tests for adding, replacing, removing, and deduplicating tags.

## Existing Code Context

The real Medusa codebase already has these relevant contracts:

- `packages/medusa/src/api/admin/orders/[id]/route.ts` updates orders by running `updateOrderWorkflow(req.scope).run(...)`, then re-queries the order through the query graph.
- `packages/core/core-flows/src/order/workflows/update-order.ts` validates order updates, calls `updateOrdersStep`, registers order changes with `created_by` and `confirmed_by`, and emits `OrderWorkflowEvents.UPDATED`.
- `packages/core/core-flows/src/order/steps/update-orders.ts` wraps order service updates as a workflow step and records previous data for compensation.
- `packages/modules/order/src/models/order.ts` models order-owned columns such as status, locale, metadata, addresses, summaries, line items, shipping methods, transactions, and returns.
- `metadata` exists for custom extension data, but Medusa workflows use explicit order changes and events for product-visible order state transitions.
- Admin order list/detail field selection is controlled by `packages/medusa/src/api/admin/orders/query-config.ts`.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/modules/order/src/models/order.ts`
- `packages/modules/order/src/types/order.ts`
- `packages/modules/order/src/schema/index.ts`
- `packages/modules/order/src/migrations/Migration20260501123000.ts`
- `packages/medusa/src/api/admin/orders/query-config.ts`
- `packages/medusa/src/api/admin/orders/validators.ts`
- `packages/medusa/src/api/admin/orders/[id]/tags/utils.ts`
- `packages/medusa/src/api/admin/orders/[id]/tags/route.ts`
- `integration-tests/http/__tests__/order/admin/order-tags.spec.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally focused on the backend contract and is over the 500-line threshold.

## Diff

```diff
diff --git a/packages/modules/order/src/models/order.ts b/packages/modules/order/src/models/order.ts
index f1893c984f..2df12b1071 100644
--- a/packages/modules/order/src/models/order.ts
+++ b/packages/modules/order/src/models/order.ts
@@ -19,6 +19,7 @@ const _Order = model
     locale: model.text().nullable(),
     no_notification: model.boolean().nullable(),
     metadata: model.json().nullable(),
+    tags: model.json().nullable(),
     canceled_at: model.dateTime().nullable(),
     shipping_address: model
       .hasOne<any>(() => OrderAddress, {
@@ -74,6 +75,14 @@ const _Order = model
       unique: false,
       where: "deleted_at IS NULL",
     },
+    {
+      name: "IDX_order_tags",
+      on: ["tags"],
+      unique: false,
+      where: "deleted_at IS NULL",
+    },
     {
       name: "IDX_order_deleted_at",
       on: ["deleted_at"],
diff --git a/packages/modules/order/src/types/order.ts b/packages/modules/order/src/types/order.ts
index a933ab82b2..a716654bd7 100644
--- a/packages/modules/order/src/types/order.ts
+++ b/packages/modules/order/src/types/order.ts
@@ -8,6 +8,7 @@ export interface CreateOrderDTO {
   status?: OrderStatus
   no_notification?: boolean
   metadata?: Record<string, unknown> | null
+  tags?: string[] | null
 }
 
 export interface UpdateOrderDTO {
@@ -21,6 +22,7 @@ export interface UpdateOrderDTO {
   status?: OrderStatus
   no_notification?: boolean
   metadata?: Record<string, unknown> | null
+  tags?: string[] | null
 }
+
+export type OrderTag = string
+
+export type OrderTagChange = {
+  order_id: string
+  tags: OrderTag[]
+  actor_id?: string
+}
diff --git a/packages/modules/order/src/schema/index.ts b/packages/modules/order/src/schema/index.ts
index 4f11d8c7bb..5f08111237 100644
--- a/packages/modules/order/src/schema/index.ts
+++ b/packages/modules/order/src/schema/index.ts
@@ -17,6 +17,7 @@ type Order {
   locale: String
   no_notification: Boolean
   metadata: JSON
+  tags: [String!]
   canceled_at: DateTime
   shipping_address: OrderAddress
   billing_address: OrderAddress
@@ -72,6 +73,7 @@ input CreateOrderInput {
   status: String
   no_notification: Boolean
   metadata: JSON
+  tags: [String!]
 }
 
 input UpdateOrderInput {
@@ -84,5 +86,6 @@ input UpdateOrderInput {
   status: String
   no_notification: Boolean
   metadata: JSON
+  tags: [String!]
 }
 `
diff --git a/packages/modules/order/src/migrations/Migration20260501123000.ts b/packages/modules/order/src/migrations/Migration20260501123000.ts
new file mode 100644
index 0000000000..61e0bd9351
--- /dev/null
+++ b/packages/modules/order/src/migrations/Migration20260501123000.ts
@@ -0,0 +1,69 @@
+import { Migration } from "@medusajs/framework/mikro-orm/migrations"
+
+export class Migration20260501123000 extends Migration {
+  async up(): Promise<void> {
+    this.addSql(
+      'alter table if exists "order" add column if not exists "tags" jsonb null;'
+    )
+
+    this.addSql(
+      'create index if not exists "IDX_order_tags" on "order" using gin ("tags") where "deleted_at" is null;'
+    )
+
+    this.addSql(`
+      update "order"
+      set "tags" = coalesce(
+        case
+          when jsonb_typeof("metadata"->'tags') = 'array' then "metadata"->'tags'
+          when jsonb_typeof("metadata"->'internal_tags') = 'array' then "metadata"->'internal_tags'
+          else '[]'::jsonb
+        end,
+        '[]'::jsonb
+      )
+      where "tags" is null
+        and "deleted_at" is null
+        and (
+          jsonb_typeof("metadata"->'tags') = 'array'
+          or jsonb_typeof("metadata"->'internal_tags') = 'array'
+        );
+    `)
+  }
+
+  async down(): Promise<void> {
+    this.addSql('drop index if exists "IDX_order_tags";')
+    this.addSql('alter table if exists "order" drop column if exists "tags";')
+  }
+}
diff --git a/packages/medusa/src/api/admin/orders/query-config.ts b/packages/medusa/src/api/admin/orders/query-config.ts
index 225c8c6731..f750297bd4 100644
--- a/packages/medusa/src/api/admin/orders/query-config.ts
+++ b/packages/medusa/src/api/admin/orders/query-config.ts
@@ -11,6 +11,7 @@ export const defaultAdminOrderFields = [
   "total",
   "metadata",
   "locale",
+  "tags",
   "created_at",
   "updated_at",
 ]
@@ -32,6 +33,7 @@ export const defaultAdminRetrieveOrderFields = [
   "original_item_tax_total",
   "shipping_total",
   "shipping_subtotal",
+  "tags",
   "shipping_tax_total",
   "original_shipping_tax_total",
   "original_shipping_subtotal",
@@ -104,6 +106,7 @@ export const defaultAdminExportOrderFields = [
   "currency_code",
   "region_id",
   "subtotal",
+  "tags",
   "tax_total",
   "shipping_total",
   "discount_total",
diff --git a/packages/medusa/src/api/admin/orders/validators.ts b/packages/medusa/src/api/admin/orders/validators.ts
index 016d68fe72..e07b8cf665 100644
--- a/packages/medusa/src/api/admin/orders/validators.ts
+++ b/packages/medusa/src/api/admin/orders/validators.ts
@@ -128,6 +128,47 @@ export const AdminTransferOrder = z.object({
   update_order_email: z.boolean().optional(),
 })
 
+const OrderTag = z
+  .string()
+  .trim()
+  .min(1)
+  .max(40)
+  .regex(/^[a-zA-Z0-9 _.-]+$/)
+
+const OrderTagArray = z.array(OrderTag).max(50)
+
+export type AdminOrderTagsBodyType = z.infer<typeof AdminOrderTagsBody>
+export const AdminOrderTagsBody = z.object({
+  tags: OrderTagArray,
+  mode: z.enum(["append", "replace"]).default("append"),
+})
+
+export type AdminDeleteOrderTagParamsType = z.infer<
+  typeof AdminDeleteOrderTagParams
+>
+export const AdminDeleteOrderTagParams = z.object({
+  tag: OrderTag,
+})
+
+export const AdminOrderTagsQuery = z.object({
+  fields: z.string().optional(),
+})
+
+export type AdminOrderTagsResponse = {
+  order: {
+    id: string
+    tags: string[]
+    metadata?: Record<string, unknown> | null
+  }
+}
+
 export type AdminUpdateOrderType = z.infer<typeof AdminUpdateOrder>
 export const AdminUpdateOrder = z.object({
   email: z.string().optional(),
   shipping_address: AddressPayload.optional(),
   billing_address: AddressPayload.optional(),
   locale: z.string().nullish(),
   metadata: z.record(z.string(), z.unknown()).nullish(),
+  tags: OrderTagArray.nullish(),
 })
diff --git a/packages/medusa/src/api/admin/orders/[id]/tags/utils.ts b/packages/medusa/src/api/admin/orders/[id]/tags/utils.ts
new file mode 100644
index 0000000000..1ae8e951b8
--- /dev/null
+++ b/packages/medusa/src/api/admin/orders/[id]/tags/utils.ts
@@ -0,0 +1,113 @@
+export type OrderTagOperation = "append" | "replace"
+
+export type OrderWithTags = {
+  id: string
+  tags?: string[] | null
+  metadata?: Record<string, unknown> | null
+}
+
+export type OrderTagAuditSnapshot = {
+  before: string[]
+  after: string[]
+  changed: string[]
+}
+
+export const normalizeOrderTag = (tag: string): string => {
+  return tag.trim()
+}
+
+export const normalizeOrderTags = (tags: string[]): string[] => {
+  const seen = new Set<string>()
+  const result: string[] = []
+
+  for (const raw of tags) {
+    const tag = normalizeOrderTag(raw)
+
+    if (!tag) {
+      continue
+    }
+
+    if (seen.has(tag)) {
+      continue
+    }
+
+    seen.add(tag)
+    result.push(tag)
+  }
+
+  return result.slice(0, 50)
+}
+
+export const getExistingOrderTags = (order: OrderWithTags): string[] => {
+  if (Array.isArray(order.tags)) {
+    return normalizeOrderTags(order.tags)
+  }
+
+  if (Array.isArray(order.metadata?.tags)) {
+    return normalizeOrderTags(order.metadata.tags as string[])
+  }
+
+  if (Array.isArray(order.metadata?.internal_tags)) {
+    return normalizeOrderTags(order.metadata.internal_tags as string[])
+  }
+
+  return []
+}
+
+export const applyOrderTagOperation = ({
+  existing,
+  incoming,
+  mode,
+}: {
+  existing: string[]
+  incoming: string[]
+  mode: OrderTagOperation
+}): string[] => {
+  const normalizedIncoming = normalizeOrderTags(incoming)
+
+  if (mode === "replace") {
+    return normalizedIncoming
+  }
+
+  return normalizeOrderTags([...existing, ...normalizedIncoming])
+}
+
+export const removeOrderTag = ({
+  existing,
+  tag,
+}: {
+  existing: string[]
+  tag: string
+}): string[] => {
+  const normalized = normalizeOrderTag(tag)
+
+  return existing.filter((existingTag) => existingTag !== normalized)
+}
+
+export const getOrderTagAuditSnapshot = ({
+  before,
+  after,
+}: {
+  before: string[]
+  after: string[]
+}): OrderTagAuditSnapshot => {
+  const beforeSet = new Set(before)
+  const afterSet = new Set(after)
+  const changed = [
+    ...after.filter((tag) => !beforeSet.has(tag)),
+    ...before.filter((tag) => !afterSet.has(tag)),
+  ]
+
+  return {
+    before,
+    after,
+    changed,
+  }
+}
+
+export const mergeOrderTagMetadata = ({
+  metadata,
+  tags,
+  actorId,
+}: {
+  metadata?: Record<string, unknown> | null
+  tags: string[]
+  actorId?: string
+}) => {
+  return {
+    ...(metadata ?? {}),
+    internal_tags: tags,
+    internal_tags_updated_by: actorId,
+    internal_tags_updated_at: new Date().toISOString(),
+  }
+}
diff --git a/packages/medusa/src/api/admin/orders/[id]/tags/route.ts b/packages/medusa/src/api/admin/orders/[id]/tags/route.ts
new file mode 100644
index 0000000000..704c62ad79
--- /dev/null
+++ b/packages/medusa/src/api/admin/orders/[id]/tags/route.ts
@@ -0,0 +1,184 @@
+import type { IOrderModuleService } from "@medusajs/framework/types"
+import {
+  AuthenticatedMedusaRequest,
+  MedusaResponse,
+} from "@medusajs/framework/http"
+import {
+  ContainerRegistrationKeys,
+  MedusaError,
+  Modules,
+} from "@medusajs/framework/utils"
+import { AdminOrder } from "@medusajs/framework/types"
+import {
+  AdminDeleteOrderTagParamsType,
+  AdminOrderTagsBodyType,
+} from "../../../validators"
+import {
+  applyOrderTagOperation,
+  getExistingOrderTags,
+  getOrderTagAuditSnapshot,
+  mergeOrderTagMetadata,
+  removeOrderTag,
+} from "./utils"
+
+const ORDER_TAG_FIELDS = ["id", "tags", "metadata"] as const
+
+const readOrderForTags = async (
+  orderModuleService: IOrderModuleService,
+  orderId: string
+) => {
+  const [order] = await orderModuleService.listOrders(
+    { id: orderId },
+    {
+      select: [...ORDER_TAG_FIELDS],
+    }
+  )
+
+  if (!order) {
+    throw new MedusaError(
+      MedusaError.Types.NOT_FOUND,
+      `Order ${orderId} was not found`
+    )
+  }
+
+  return order
+}
+
+export const POST = async (
+  req: AuthenticatedMedusaRequest<
+    AdminOrderTagsBodyType,
+    {
+      id: string
+    }
+  >,
+  res: MedusaResponse
+) => {
+  const orderModuleService = req.scope.resolve<IOrderModuleService>(
+    Modules.ORDER
+  )
+  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
+
+  const order = await readOrderForTags(orderModuleService, req.params.id)
+  const existingTags = getExistingOrderTags(order)
+  const nextTags = applyOrderTagOperation({
+    existing: existingTags,
+    incoming: req.validatedBody.tags,
+    mode: req.validatedBody.mode,
+  })
+  const audit = getOrderTagAuditSnapshot({
+    before: existingTags,
+    after: nextTags,
+  })
+
+  await orderModuleService.updateOrders(req.params.id, {
+    id: req.params.id,
+    tags: nextTags,
+    metadata: mergeOrderTagMetadata({
+      metadata: order.metadata,
+      tags: nextTags,
+      actorId: req.auth_context.actor_id,
+    }),
+  })
+
+  req.scope
+    .resolve("logger")
+    .info(
+      `Updated order tags for ${req.params.id}: ${audit.changed.join(",")}`
+    )
+
+  const result = await query.graph({
+    entity: "order",
+    filters: {
+      id: req.params.id,
+    },
+    fields: req.queryConfig.fields,
+  })
+
+  res.status(200).json({
+    order: result.data[0] as AdminOrder,
+  })
+}
+
+export const DELETE = async (
+  req: AuthenticatedMedusaRequest<
+    never,
+    {
+      id: string
+      tag: AdminDeleteOrderTagParamsType["tag"]
+    }
+  >,
+  res: MedusaResponse
+) => {
+  const orderModuleService = req.scope.resolve<IOrderModuleService>(
+    Modules.ORDER
+  )
+  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
+
+  const order = await readOrderForTags(orderModuleService, req.params.id)
+  const existingTags = getExistingOrderTags(order)
+  const nextTags = removeOrderTag({
+    existing: existingTags,
+    tag: req.params.tag,
+  })
+  const audit = getOrderTagAuditSnapshot({
+    before: existingTags,
+    after: nextTags,
+  })
+
+  await orderModuleService.updateOrders(req.params.id, {
+    id: req.params.id,
+    tags: nextTags,
+    metadata: mergeOrderTagMetadata({
+      metadata: order.metadata,
+      tags: nextTags,
+      actorId: req.auth_context.actor_id,
+    }),
+  })
+
+  req.scope
+    .resolve("logger")
+    .info(
+      `Removed order tag for ${req.params.id}: ${audit.changed.join(",")}`
+    )
+
+  const result = await query.graph({
+    entity: "order",
+    filters: {
+      id: req.params.id,
+    },
+    fields: req.queryConfig.fields,
+  })
+
+  res.status(200).json({
+    order: result.data[0] as AdminOrder,
+  })
+}
diff --git a/integration-tests/http/__tests__/order/admin/order-tags.spec.ts b/integration-tests/http/__tests__/order/admin/order-tags.spec.ts
new file mode 100644
index 0000000000..1d90228aa0
--- /dev/null
+++ b/integration-tests/http/__tests__/order/admin/order-tags.spec.ts
@@ -0,0 +1,170 @@
+import {
+  adminHeaders,
+  createAdminUser,
+} from "../../../helpers/create-admin-user"
+import { medusaIntegrationTestRunner } from "../../../medusa-test-runner"
+import { createOrderSeeder } from "../../helpers/order"
+
+medusaIntegrationTestRunner({
+  testSuite: ({ api, getContainer }) => {
+    describe("Admin order tags", () => {
+      let orderId: string
+
+      beforeEach(async () => {
+        await createAdminUser(getContainer())
+
+        const seeder = createOrderSeeder({ api, getContainer })
+        const order = await seeder.create({
+          email: "order-tags@example.com",
+          currency_code: "usd",
+        })
+
+        orderId = order.id
+      })
+
+      it("appends tags to an order", async () => {
+        const response = await api.post(
+          `/admin/orders/${orderId}/tags`,
+          {
+            tags: ["vip", "warehouse-hold"],
+          },
+          adminHeaders
+        )
+
+        expect(response.status).toBe(200)
+        expect(response.data.order.tags).toEqual(["vip", "warehouse-hold"])
+      })
+
+      it("deduplicates exact repeated tags", async () => {
+        const response = await api.post(
+          `/admin/orders/${orderId}/tags`,
+          {
+            tags: ["vip", "vip"],
+          },
+          adminHeaders
+        )
+
+        expect(response.status).toBe(200)
+        expect(response.data.order.tags).toEqual(["vip"])
+      })
+
+      it("replaces tags when requested", async () => {
+        await api.post(
+          `/admin/orders/${orderId}/tags`,
+          {
+            tags: ["vip", "fraud-review"],
+          },
+          adminHeaders
+        )
+
+        const response = await api.post(
+          `/admin/orders/${orderId}/tags`,
+          {
+            mode: "replace",
+            tags: ["priority"],
+          },
+          adminHeaders
+        )
+
+        expect(response.status).toBe(200)
+        expect(response.data.order.tags).toEqual(["priority"])
+      })
+
+      it("removes a tag", async () => {
+        await api.post(
+          `/admin/orders/${orderId}/tags`,
+          {
+            tags: ["vip", "fraud-review"],
+          },
+          adminHeaders
+        )
+
+        const response = await api.delete(
+          `/admin/orders/${orderId}/tags/vip`,
+          adminHeaders
+        )
+
+        expect(response.status).toBe(200)
+        expect(response.data.order.tags).toEqual(["fraud-review"])
+      })
+
+      it("returns tags in the order detail response", async () => {
+        await api.post(
+          `/admin/orders/${orderId}/tags`,
+          {
+            tags: ["vip"],
+          },
+          adminHeaders
+        )
+
+        const response = await api.get(
+          `/admin/orders/${orderId}`,
+          adminHeaders
+        )
+
+        expect(response.status).toBe(200)
+        expect(response.data.order.tags).toEqual(["vip"])
+      })
+    })
+  },
+})
```

## Intended Flaws

### Flaw 1: Tags Are Modeled As Free-Form Order Row State

- `type`: `invariant_drift`
- `location`: `packages/modules/order/src/models/order.ts:19-83`, `packages/modules/order/src/types/order.ts:8-31`, `packages/modules/order/src/migrations/Migration20260501123000.ts:4-32`, `packages/medusa/src/api/admin/orders/[id]/tags/utils.ts:1-113`
- `learner_prompt`: Is `tags: string[]` on the order row a strong enough domain model for operational tags?

Expected answer:

- `identify`: The PR treats tags as a free-form JSON list owned by the order row and mirrors them into metadata. There is no tag definition model, normalized value, scoped uniqueness rule, ownership boundary, assignment record, actor/timestamp per assignment, rename/delete semantics, or lifecycle for who can create a tag versus apply one. The helper only trims strings and deduplicates exact matches, so `VIP`, `vip`, and `vip ` can become different operational states.
- `impact`: Operations data will drift quickly. Reporting and filtering become unreliable, support cannot answer who applied or removed a tag, product cannot add colors/categories/permissions later without a migration, and downstream automation may disagree about which tags mean the same thing. A "small internal label" becomes a core operational taxonomy hidden inside arbitrary order JSON.
- `fix_direction`: Model tags as a small domain concept. Use an `order_tag` table/module with normalized unique values and optional display metadata, plus an `order_tag_assignment` table with `order_id`, `tag_id`, `created_by`, `removed_by` or soft-delete/history fields, and timestamps. Expose order tags through a service boundary so creation, assignment, rename, removal, permissions, and reporting share one invariant.

Hints:

1. Ask whether the product is storing a label or creating a reusable operational taxonomy.
2. Compare a JSON string list with the questions support and operations will ask later: who, when, why, rename, delete, report.
3. The suspicious places are the new `tags` order column and the helper that only trims strings before saving them.

### Flaw 2: Tag Mutations Bypass The Order Workflow And Audit/Event Contract

- `type`: `ownership_boundary_violation`
- `location`: `packages/medusa/src/api/admin/orders/[id]/tags/route.ts:39-154`, `integration-tests/http/__tests__/order/admin/order-tags.spec.ts:23-96`
- `learner_prompt`: Do tag changes behave like other product-visible order state transitions in Medusa?

Expected answer:

- `identify`: The new tag endpoints read and write through `orderModuleService.updateOrders` directly from the HTTP route. They do not run a workflow step, do not use `updateOrderWorkflow`, do not register an order change with `created_by`/`confirmed_by`, do not emit `OrderWorkflowEvents.UPDATED` after workflow success, and do not get workflow compensation semantics. The tests only assert the response shape, not audit records, events, or subscriber-visible behavior.
- `impact`: Admin views show the changed tags, but systems that depend on order changes or order-updated events can miss the transition. Audit trails are incomplete, retries can partially update metadata without a domain event, cache/search/indexing subscribers may stay stale, and future order invariants can be bypassed because the route became its own mini domain service.
- `fix_direction`: Put tag application/removal behind an order-tag workflow or extend the order update workflow with an explicit tag step. The workflow should validate the order, perform assignment changes through the tag service, register an order change/audit entry with actor context, emit a stable event such as `order.tags_updated` or `OrderWorkflowEvents.UPDATED`, and return the re-queried order.

Hints:

1. Start from how the existing admin order update endpoint changes an order.
2. Look for order changes, workflow steps, and events, not only for a successful database write.
3. The key line is the route-level `orderModuleService.updateOrders(...)` call; compare it to `updateOrderWorkflow(req.scope).run(...)`.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the modeling problem, not merely say "add validation." The issue is that operational tags need definitions, assignments, normalization, ownership, and history; a JSON array on `order` cannot carry that contract.

For flaw 2, a correct answer must identify the workflow/audit/event bypass. Answers that only mention "the route has business logic" are close, but complete answers connect the direct write to missing order changes, actor history, event emission, retry behavior, and subscriber consistency.

### Product-Level Change

The PR tries to let operations teams classify orders for internal handling. That is useful product behavior: tags can drive support triage, fraud review, fulfillment holds, and priority handling. Because those labels affect how humans and automations treat an order, they are not throwaway UI state.

### Changed Contracts

- Database contract: orders now have a `tags` JSON field and a GIN index.
- API contract: admin order detail/list/export responses include `tags`.
- Mutation contract: new admin endpoints can append, replace, and remove tags.
- Audit contract: tag changes should be attributable to an actor and visible as order history.
- Event contract: subscribers need a reliable signal when order classification changes.
- Domain contract: the system now needs to define what a valid tag is, who owns tag creation, and how tags are renamed or removed.

### Failure Modes

An operations team uses `fraud-review` for automation. One admin enters `Fraud Review`, another enters `fraud-review`, and a third enters `fraud_review`. The UI may show all three, while reports and jobs miss some orders because the code only deduplicates exact strings.

A warehouse hold is removed through `DELETE /admin/orders/:id/tags/warehouse-hold`. The order response changes, but no order change record or workflow event is emitted. A subscriber that syncs order state to the warehouse system never sees the removal, so the warehouse continues holding the package.

### Reviewer Thought Process

A strong reviewer first classifies the change: this is not just response decoration. It introduces new operational state on orders. That immediately raises modeling questions: whether tags are reusable entities, whether they need normalization, whether assignments need history, and whether future reporting can rely on them.

The second move is to follow the mutation path. In Medusa, order updates normally go through workflows that validate, update, register changes, and emit events. A reviewer should compare the new tag route to `updateOrderWorkflow`, then ask what subscribers, audits, and compensating steps will miss.

### Better Implementation Direction

Design order tags as a small domain surface:

- Create normalized tag definitions scoped to the store or tenant.
- Store assignments separately from the order row, with actor and timestamp history.
- Mutate assignments through an order-tag service or workflow step.
- Emit a stable tag-updated event after workflow success.
- Register an order change or equivalent audit record with before/after tags.
- Add tests for normalization, duplicate display names, audit rows, events, and subscriber-visible behavior.

## Why This Case Exists

This case trains a reviewer to be suspicious of "simple internal fields" that quietly become domain state. Great engineers ask where invariants live, who owns the data, how state changes are observed, and whether the implementation fits the codebase's existing mutation path.
