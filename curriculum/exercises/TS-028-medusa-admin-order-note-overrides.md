# TS-028: Medusa Admin Order Note Overrides

## Metadata

- `id`: TS-028
- `source_repo`: [medusajs/medusa](https://github.com/medusajs/medusa)
- `repo_area`: admin order APIs, store order APIs, order workflows, order module models, actor context, customer ownership, order note visibility
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 1,100-1,400
- `represented_diff_lines`: 1,114
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about admin/store route boundaries, order ownership, workflow actor context, customer-facing notes, internal notes, policy middleware, and read-model visibility without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds order notes so support teams can annotate orders and optionally add a customer-facing message.

Support agents currently use order metadata or external helpdesk links to remember why an order was adjusted, transferred, refunded, or manually corrected. That is hard to audit and does not show the customer anything useful. This change adds an order-note model, store/customer APIs for reading and creating notes, and admin APIs that let support create or override notes on behalf of the customer.

The PR adds:

- a new `order_note` module model,
- a reusable customer order-note workflow,
- store routes for customers to list and create notes on their orders,
- admin routes for support to list and create notes,
- note fields on order retrieve payloads,
- tests for customer notes, admin-created notes, and note retrieval through store/admin APIs.

## Existing Code Context

The real Medusa codebase already has these relevant contracts:

- `packages/medusa/src/api/admin/orders/[id]/route.ts` passes `user_id: req.auth_context.actor_id` into `updateOrderWorkflow`, preserving the admin actor on order updates.
- `packages/medusa/src/api/admin/orders/middlewares.ts` applies `PolicyOperation.update` to mutating admin order routes.
- `packages/medusa/src/api/store/orders/route.ts` lists store orders with `customer_id: req.auth_context.actor_id`, so customer-owned store reads are scoped by the authenticated customer.
- `packages/medusa/src/api/store/orders/middlewares.ts` authenticates `/store/orders`, transfer request, and transfer cancel routes as `customer`.
- `packages/core/core-flows/src/order/workflows/transfer/cancel-order-transfer.ts` explicitly distinguishes `actor_type: "user"` from `actor_type: "customer"`; admin users can cancel any transfer, while customers must match the request owner.
- `packages/core/core-flows/src/order/workflows/transfer/request-order-transfer.ts` stores `created_by`, `requested_by`, and `internal_note` on order changes instead of flattening all actors into a customer path.
- `packages/modules/order/src/models/order-change.ts` has separate audit/provenance fields such as `created_by`, `requested_by`, `confirmed_by`, `declined_by`, `canceled_by`, plus `internal_note`.
- `packages/medusa/src/api/admin/orders/query-config.ts` includes `internal_note` in admin order-change defaults; store order query defaults do not include order changes or internal notes.
- `packages/medusa/src/api/store/orders/query-config.ts` has a comment saying store order fields were copied from admin and still need scoped store-safe fields, which is a warning sign for adding sensitive relations to store responses.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/modules/order/src/models/order-note.ts`
- `packages/modules/order/src/models/order.ts`
- `packages/modules/order/src/models/index.ts`
- `packages/modules/order/src/migrations/Migration20260115094500.ts`
- `packages/modules/order/src/services/order-note-service.ts`
- `packages/framework/types/src/http/order-note.ts`
- `packages/core/core-flows/src/order/workflows/create-customer-order-note.ts`
- `packages/medusa/src/api/store/orders/[id]/notes/route.ts`
- `packages/medusa/src/api/admin/orders/[id]/notes/route.ts`
- `packages/medusa/src/api/store/orders/validators.ts`
- `packages/medusa/src/api/admin/orders/validators.ts`
- `packages/medusa/src/api/store/orders/query-config.ts`
- `packages/medusa/src/api/admin/orders/query-config.ts`
- `packages/medusa/src/api/store/orders/middlewares.ts`
- `packages/medusa/src/api/admin/orders/middlewares.ts`
- `integration-tests/http/admin/order-notes.spec.ts`
- `integration-tests/http/store/order-notes.spec.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on backend/API behavior, workflow ownership, actor context, note visibility, and tests.

## Diff

```diff
diff --git a/packages/modules/order/src/models/order-note.ts b/packages/modules/order/src/models/order-note.ts
new file mode 100644
index 0000000000..a11d1aa940
--- /dev/null
+++ b/packages/modules/order/src/models/order-note.ts
@@ -0,0 +1,74 @@
+import { model } from "@medusajs/framework/utils"
+import { Order } from "./order"
+
+const _OrderNote = model
+  .define("OrderNote", {
+    id: model.id({ prefix: "ordnote" }).primaryKey(),
+    order_id: model.text(),
+    body: model.text().searchable(),
+    title: model.text().nullable(),
+    pinned: model.boolean().default(false),
+    created_by: model.text().nullable(),
+    created_by_type: model.text().nullable(),
+    metadata: model.json().nullable(),
+    order: model.belongsTo<() => typeof Order>(() => Order, {
+      mappedBy: "notes",
+    }),
+  })
+  .indexes([
+    {
+      name: "IDX_order_note_order_id",
+      on: ["order_id"],
+      unique: false,
+      where: "deleted_at IS NULL",
+    },
+    {
+      name: "IDX_order_note_created_by",
+      on: ["created_by"],
+      unique: false,
+      where: "created_by IS NOT NULL AND deleted_at IS NULL",
+    },
+    {
+      name: "IDX_order_note_deleted_at",
+      on: ["deleted_at"],
+      unique: false,
+      where: "deleted_at IS NOT NULL",
+    },
+  ])
+
+export const OrderNote = _OrderNote
+
+export type OrderNoteModel = typeof OrderNote
+
+export type OrderNoteCreateInput = {
+  order_id: string
+  body: string
+  title?: string | null
+  pinned?: boolean
+  created_by?: string | null
+  created_by_type?: string | null
+  metadata?: Record<string, unknown> | null
+}
+
+export type OrderNoteDTO = {
+  id: string
+  order_id: string
+  body: string
+  title?: string | null
+  pinned: boolean
+  created_by?: string | null
+  created_by_type?: string | null
+  metadata?: Record<string, unknown> | null
+  created_at: Date
+  updated_at: Date
+}
diff --git a/packages/modules/order/src/models/order.ts b/packages/modules/order/src/models/order.ts
index 68c4699476..f8ad15a78b 100644
--- a/packages/modules/order/src/models/order.ts
+++ b/packages/modules/order/src/models/order.ts
@@ -7,6 +7,7 @@ import { OrderShipping } from "./order-shipping-method"
 import { OrderSummary } from "./order-summary"
 import { OrderTransaction } from "./transaction"
+import { OrderNote } from "./order-note"
 
 const _Order = model
   .define("Order", {
@@ -48,6 +49,9 @@ const _Order = model
     credit_lines: model.hasMany<any>(() => OrderCreditLine, {
       mappedBy: "order",
     }),
+    notes: model.hasMany<any>(() => OrderNote, {
+      mappedBy: "order",
+    }),
     returns: model.hasMany<any>(() => Return, {
       mappedBy: "order",
     }),
diff --git a/packages/modules/order/src/models/index.ts b/packages/modules/order/src/models/index.ts
index f95c2644ed..fd9715b0a0 100644
--- a/packages/modules/order/src/models/index.ts
+++ b/packages/modules/order/src/models/index.ts
@@ -18,3 +18,4 @@ export { OrderTransaction } from "./transaction"
 export { OrderSummary } from "./order-summary"
 export { OrderChange } from "./order-change"
 export { OrderChangeAction } from "./order-change-action"
+export { OrderNote } from "./order-note"
diff --git a/packages/modules/order/src/migrations/Migration20260115094500.ts b/packages/modules/order/src/migrations/Migration20260115094500.ts
new file mode 100644
index 0000000000..e22ad7db45
--- /dev/null
+++ b/packages/modules/order/src/migrations/Migration20260115094500.ts
@@ -0,0 +1,78 @@
+import { Migration } from "@mikro-orm/migrations"
+
+export class Migration20260115094500 extends Migration {
+  async up(): Promise<void> {
+    this.addSql(`
+      create table if not exists "order_note" (
+        "id" text not null,
+        "order_id" text not null,
+        "body" text not null,
+        "title" text null,
+        "pinned" boolean not null default false,
+        "created_by" text null,
+        "created_by_type" text null,
+        "metadata" jsonb null,
+        "created_at" timestamptz not null default now(),
+        "updated_at" timestamptz not null default now(),
+        "deleted_at" timestamptz null,
+        constraint "order_note_pkey" primary key ("id")
+      );
+    `)
+
+    this.addSql(`
+      alter table if exists "order_note"
+      add constraint "order_note_order_id_foreign"
+      foreign key ("order_id") references "order" ("id")
+      on update cascade on delete cascade;
+    `)
+
+    this.addSql(`
+      create index if not exists "IDX_order_note_order_id"
+      on "order_note" ("order_id")
+      where deleted_at is null;
+    `)
+
+    this.addSql(`
+      create index if not exists "IDX_order_note_created_by"
+      on "order_note" ("created_by")
+      where created_by is not null and deleted_at is null;
+    `)
+
+    this.addSql(`
+      create index if not exists "IDX_order_note_deleted_at"
+      on "order_note" ("deleted_at")
+      where deleted_at is not null;
+    `)
+  }
+
+  async down(): Promise<void> {
+    this.addSql(`
+      alter table if exists "order_note"
+      drop constraint if exists "order_note_order_id_foreign";
+    `)
+
+    this.addSql(`drop index if exists "IDX_order_note_deleted_at";`)
+    this.addSql(`drop index if exists "IDX_order_note_created_by";`)
+    this.addSql(`drop index if exists "IDX_order_note_order_id";`)
+    this.addSql(`drop table if exists "order_note" cascade;`)
+  }
+}
diff --git a/packages/modules/order/src/services/order-note-service.ts b/packages/modules/order/src/services/order-note-service.ts
new file mode 100644
index 0000000000..62e61f33ca
--- /dev/null
+++ b/packages/modules/order/src/services/order-note-service.ts
@@ -0,0 +1,142 @@
+import { Context, InferEntityType } from "@medusajs/framework/types"
+import {
+  InjectManager,
+  InjectTransactionManager,
+  MedusaContext,
+  MedusaError,
+  ModulesSdkUtils,
+} from "@medusajs/framework/utils"
+import { OrderNote, OrderNoteCreateInput, OrderNoteDTO } from "../models"
+
+type InjectedDependencies = {
+  orderNoteService: ModulesSdkUtils.IMedusaInternalService<
+    InferEntityType<typeof OrderNote>
+  >
+}
+
+export default class OrderNoteService {
+  protected readonly orderNoteService_: ModulesSdkUtils.IMedusaInternalService<
+    InferEntityType<typeof OrderNote>
+  >
+
+  constructor({ orderNoteService }: InjectedDependencies) {
+    this.orderNoteService_ = orderNoteService
+  }
+
+  @InjectManager()
+  async listOrderNotes(
+    filters: {
+      order_id?: string
+      created_by?: string
+      pinned?: boolean
+    },
+    config: {
+      take?: number
+      skip?: number
+      order?: Record<string, unknown>
+    } = {},
+    @MedusaContext() sharedContext: Context = {}
+  ): Promise<OrderNoteDTO[]> {
+    const notes = await this.orderNoteService_.list(
+      filters,
+      {
+        take: config.take ?? 50,
+        skip: config.skip ?? 0,
+        order: config.order ?? { created_at: "DESC" },
+      },
+      sharedContext
+    )
+
+    return notes as unknown as OrderNoteDTO[]
+  }
+
+  @InjectManager()
+  async retrieveOrderNote(
+    id: string,
+    @MedusaContext() sharedContext: Context = {}
+  ): Promise<OrderNoteDTO> {
+    const note = await this.orderNoteService_.retrieve(
+      id,
+      {
+        select: [
+          "id",
+          "order_id",
+          "body",
+          "title",
+          "pinned",
+          "created_by",
+          "created_by_type",
+          "metadata",
+          "created_at",
+          "updated_at",
+        ],
+      },
+      sharedContext
+    )
+
+    return note as unknown as OrderNoteDTO
+  }
+
+  @InjectTransactionManager()
+  async createOrderNotes(
+    data: OrderNoteCreateInput | OrderNoteCreateInput[],
+    @MedusaContext() sharedContext: Context = {}
+  ): Promise<OrderNoteDTO | OrderNoteDTO[]> {
+    const input = Array.isArray(data) ? data : [data]
+
+    input.forEach((note) => {
+      if (!note.body?.trim()) {
+        throw new MedusaError(
+          MedusaError.Types.INVALID_DATA,
+          "Order note body is required"
+        )
+      }
+    })
+
+    const created = await this.orderNoteService_.create(
+      input.map((note) => ({
+        order_id: note.order_id,
+        body: note.body.trim(),
+        title: note.title?.trim() || null,
+        pinned: note.pinned ?? false,
+        created_by: note.created_by ?? null,
+        created_by_type: note.created_by_type ?? null,
+        metadata: note.metadata ?? null,
+      })),
+      sharedContext
+    )
+
+    if (Array.isArray(data)) {
+      return created as unknown as OrderNoteDTO[]
+    }
+
+    return created[0] as unknown as OrderNoteDTO
+  }
+
+  @InjectTransactionManager()
+  async deleteOrderNotes(
+    ids: string | string[],
+    @MedusaContext() sharedContext: Context = {}
+  ): Promise<void> {
+    await this.orderNoteService_.delete(ids, sharedContext)
+  }
+}
diff --git a/packages/framework/types/src/http/order-note.ts b/packages/framework/types/src/http/order-note.ts
new file mode 100644
index 0000000000..da6d2c5091
--- /dev/null
+++ b/packages/framework/types/src/http/order-note.ts
@@ -0,0 +1,96 @@
+export type AdminOrderNote = {
+  id: string
+  order_id: string
+  title?: string | null
+  body: string
+  pinned: boolean
+  created_by?: string | null
+  created_by_type?: string | null
+  metadata?: Record<string, unknown> | null
+  created_at: string
+  updated_at: string
+}
+
+export type StoreOrderNote = {
+  id: string
+  order_id: string
+  title?: string | null
+  body: string
+  pinned: boolean
+  created_by?: string | null
+  created_by_type?: string | null
+  metadata?: Record<string, unknown> | null
+  created_at: string
+  updated_at: string
+}
+
+export type AdminCreateOrderNote = {
+  title?: string
+  body: string
+  pinned?: boolean
+  metadata?: Record<string, unknown> | null
+}
+
+export type StoreCreateOrderNote = {
+  title?: string
+  body: string
+  metadata?: Record<string, unknown> | null
+}
+
+export type AdminOrderNoteResponse = {
+  note: AdminOrderNote
+}
+
+export type StoreOrderNoteResponse = {
+  note: StoreOrderNote
+}
+
+export type AdminOrderNotesResponse = {
+  notes: AdminOrderNote[]
+  count: number
+  offset: number
+  limit: number
+}
+
+export type StoreOrderNotesResponse = {
+  notes: StoreOrderNote[]
+  count: number
+  offset: number
+  limit: number
+}
+
+export type AdminOrderWithNotes = {
+  id: string
+  notes?: AdminOrderNote[]
+}
+
+export type StoreOrderWithNotes = {
+  id: string
+  notes?: StoreOrderNote[]
+}
diff --git a/packages/core/core-flows/src/order/workflows/create-customer-order-note.ts b/packages/core/core-flows/src/order/workflows/create-customer-order-note.ts
new file mode 100644
index 0000000000..2cf640fe1d
--- /dev/null
+++ b/packages/core/core-flows/src/order/workflows/create-customer-order-note.ts
@@ -0,0 +1,210 @@
+import {
+  OrderDTO,
+  OrderWorkflow,
+  OrderNoteDTO,
+} from "@medusajs/framework/types"
+import {
+  ChangeActionType,
+  MedusaError,
+  Modules,
+  OrderStatus,
+} from "@medusajs/framework/utils"
+import {
+  createStep,
+  createWorkflow,
+  transform,
+  useRemoteQueryStep,
+  WorkflowData,
+  WorkflowResponse,
+} from "@medusajs/framework/workflows-sdk"
+import { useQueryGraphStep } from "../../../common"
+
+export type CreateCustomerOrderNoteInput = {
+  order_id: string
+  customer_id: string
+  body: string
+  title?: string
+  pinned?: boolean
+  metadata?: Record<string, unknown>
+  actor_type?: "customer" | "user"
+  created_by?: string
+}
+
+export const validateCustomerOrderNoteWriteStep = createStep(
+  "validate-customer-order-note-write",
+  async function ({
+    order,
+    input,
+  }: {
+    order: OrderDTO
+    input: CreateCustomerOrderNoteInput
+  }) {
+    if (order.status === OrderStatus.CANCELED) {
+      throw new MedusaError(
+        MedusaError.Types.INVALID_DATA,
+        "Cannot add customer notes to a canceled order"
+      )
+    }
+
+    if (order.customer_id !== input.customer_id) {
+      throw new MedusaError(
+        MedusaError.Types.NOT_ALLOWED,
+        "Customer is not allowed to add notes to this order"
+      )
+    }
+
+    if (input.body.length > 4000) {
+      throw new MedusaError(
+        MedusaError.Types.INVALID_DATA,
+        "Order notes must be shorter than 4000 characters"
+      )
+    }
+  }
+)
+
+export const createOrderNoteStep = createStep(
+  "create-order-note",
+  async function (input: CreateCustomerOrderNoteInput, { container }) {
+    const orderNoteService = container.resolve("orderNoteService")
+
+    return (await orderNoteService.createOrderNotes({
+      order_id: input.order_id,
+      body: input.body,
+      title: input.title,
+      pinned: input.pinned,
+      created_by: input.created_by ?? input.customer_id,
+      created_by_type: input.actor_type ?? "customer",
+      metadata: {
+        ...input.metadata,
+        action: ChangeActionType.UPDATE_ORDER_PROPERTIES,
+      },
+    })) as OrderNoteDTO
+  }
+)
+
+export const createCustomerOrderNoteWorkflowId =
+  "create-customer-order-note-workflow"
+
+/**
+ * Creates a customer-visible order note.
+ *
+ * This workflow is intentionally shared by store and admin routes so support can
+ * create a customer-facing note without duplicating route code.
+ */
+export const createCustomerOrderNoteWorkflow = createWorkflow(
+  createCustomerOrderNoteWorkflowId,
+  function (
+    input: WorkflowData<CreateCustomerOrderNoteInput>
+  ): WorkflowResponse<OrderNoteDTO> {
+    const order = useRemoteQueryStep({
+      entry_point: "orders",
+      fields: [
+        "id",
+        "status",
+        "customer_id",
+        "email",
+        "version",
+        "is_draft_order",
+      ],
+      variables: { id: input.order_id },
+      list: false,
+      throw_if_key_not_found: true,
+    })
+
+    validateCustomerOrderNoteWriteStep({ order, input })
+
+    const note = createOrderNoteStep(input)
+
+    useQueryGraphStep({
+      entity: "order",
+      fields: ["id", "notes.*"],
+      filters: { id: input.order_id },
+    }).config({ name: "order-note-refresh-query" })
+
+    return new WorkflowResponse(note)
+  }
+)
+
+export const listOrderNotesForCustomerStep = createStep(
+  "list-order-notes-for-customer",
+  async function (
+    input: {
+      order_id: string
+      customer_id: string
+      limit?: number
+      offset?: number
+    },
+    { container }
+  ) {
+    const orderNoteService = container.resolve("orderNoteService")
+
+    return await orderNoteService.listOrderNotes(
+      {
+        order_id: input.order_id,
+      },
+      {
+        take: input.limit ?? 50,
+        skip: input.offset ?? 0,
+      }
+    )
+  }
+)
+
+export const toOrderNoteResponse = transform(
+  { now: new Date() },
+  ({ now }) => {
+    return {
+      generated_at: now.toISOString(),
+    }
+  }
+)
diff --git a/packages/medusa/src/api/store/orders/[id]/notes/route.ts b/packages/medusa/src/api/store/orders/[id]/notes/route.ts
new file mode 100644
index 0000000000..ebf916f5f2
--- /dev/null
+++ b/packages/medusa/src/api/store/orders/[id]/notes/route.ts
@@ -0,0 +1,143 @@
+import {
+  createCustomerOrderNoteWorkflow,
+  getOrderDetailWorkflow,
+  listOrderNotesForCustomerStep,
+} from "@medusajs/core-flows"
+import {
+  AuthenticatedMedusaRequest,
+  MedusaResponse,
+} from "@medusajs/framework/http"
+import { HttpTypes } from "@medusajs/framework/types"
+import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
+import {
+  StoreCreateOrderNoteType,
+  StoreGetOrderNotesParamsType,
+} from "../../validators"
+
+export const GET = async (
+  req: AuthenticatedMedusaRequest<StoreGetOrderNotesParamsType>,
+  res: MedusaResponse
+) => {
+  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
+  const customerId = req.auth_context.actor_id
+  const orderId = req.params.id
+
+  const order = await query.graph({
+    entity: "order",
+    filters: {
+      id: orderId,
+      customer_id: customerId,
+      is_draft_order: false,
+    },
+    fields: ["id", "customer_id"],
+  })
+
+  if (!order.data.length) {
+    res.status(404).json({ message: "Order not found" })
+    return
+  }
+
+  const notes = await listOrderNotesForCustomerStep({
+    order_id: orderId,
+    customer_id: customerId,
+    limit: req.validatedQuery.limit,
+    offset: req.validatedQuery.offset,
+  })
+
+  res.status(200).json({
+    notes,
+    count: notes.length,
+    limit: req.validatedQuery.limit ?? 50,
+    offset: req.validatedQuery.offset ?? 0,
+  })
+}
+
+export const POST = async (
+  req: AuthenticatedMedusaRequest<
+    StoreCreateOrderNoteType,
+    HttpTypes.StoreGetOrderParams
+  >,
+  res: MedusaResponse
+) => {
+  const orderId = req.params.id
+  const customerId = req.auth_context.actor_id
+
+  const { result: note } = await createCustomerOrderNoteWorkflow(
+    req.scope
+  ).run({
+    input: {
+      order_id: orderId,
+      customer_id: customerId,
+      body: req.validatedBody.body,
+      title: req.validatedBody.title,
+      metadata: req.validatedBody.metadata,
+      actor_type: "customer",
+      created_by: customerId,
+    },
+  })
+
+  const { result: order } = await getOrderDetailWorkflow(req.scope).run({
+    input: {
+      fields: req.queryConfig.fields,
+      order_id: orderId,
+      filters: {
+        customer_id: customerId,
+        is_draft_order: false,
+      },
+    },
+  })
+
+  res.status(201).json({
+    note,
+    order: order as HttpTypes.StoreOrder,
+  })
+}
diff --git a/packages/medusa/src/api/admin/orders/[id]/notes/route.ts b/packages/medusa/src/api/admin/orders/[id]/notes/route.ts
new file mode 100644
index 0000000000..530b07c15e
--- /dev/null
+++ b/packages/medusa/src/api/admin/orders/[id]/notes/route.ts
@@ -0,0 +1,160 @@
+import {
+  createCustomerOrderNoteWorkflow,
+  listOrderNotesForCustomerStep,
+} from "@medusajs/core-flows"
+import {
+  AuthenticatedMedusaRequest,
+  MedusaResponse,
+} from "@medusajs/framework/http"
+import { AdminOrder, HttpTypes } from "@medusajs/framework/types"
+import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
+import {
+  AdminCreateOrderNoteType,
+  AdminGetOrderNotesParamsType,
+} from "../../validators"
+
+export const GET = async (
+  req: AuthenticatedMedusaRequest<AdminGetOrderNotesParamsType>,
+  res: MedusaResponse
+) => {
+  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
+
+  const notes = await query.graph({
+    entity: "order_note",
+    filters: {
+      order_id: req.params.id,
+    },
+    fields: [
+      "id",
+      "order_id",
+      "title",
+      "body",
+      "pinned",
+      "created_by",
+      "created_by_type",
+      "metadata",
+      "created_at",
+      "updated_at",
+    ],
+    pagination: req.queryConfig.pagination,
+  })
+
+  res.status(200).json({
+    notes: notes.data,
+    count: notes.metadata?.count ?? notes.data.length,
+    offset: notes.metadata?.skip ?? 0,
+    limit: notes.metadata?.take ?? 50,
+  })
+}
+
+export const POST = async (
+  req: AuthenticatedMedusaRequest<
+    AdminCreateOrderNoteType,
+    HttpTypes.AdminGetOrderParams
+  >,
+  res: MedusaResponse<HttpTypes.AdminOrderResponse>
+) => {
+  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
+  const orderId = req.params.id
+  const userId = req.auth_context.actor_id
+
+  const orderResult = await query.graph({
+    entity: "order",
+    filters: { id: orderId },
+    fields: ["id", "customer_id", "is_draft_order"],
+  })
+  const order = orderResult.data[0]
+
+  const { result: note } = await createCustomerOrderNoteWorkflow(
+    req.scope
+  ).run({
+    input: {
+      order_id: orderId,
+      customer_id: order.customer_id,
+      body: req.validatedBody.body,
+      title: req.validatedBody.title,
+      pinned: req.validatedBody.pinned,
+      metadata: {
+        ...req.validatedBody.metadata,
+        admin_override: true,
+        admin_user_id: userId,
+      },
+      actor_type: "customer",
+      created_by: order.customer_id,
+    },
+  })
+
+  const updatedOrder = await query.graph({
+    entity: "order",
+    filters: { id: orderId },
+    fields: req.queryConfig.fields,
+  })
+
+  res.status(201).json({
+    order: updatedOrder.data[0] as AdminOrder,
+    note,
+  } as any)
+}
diff --git a/packages/medusa/src/api/store/orders/validators.ts b/packages/medusa/src/api/store/orders/validators.ts
index fcd1eac0de..787192a82d 100644
--- a/packages/medusa/src/api/store/orders/validators.ts
+++ b/packages/medusa/src/api/store/orders/validators.ts
@@ -1,5 +1,9 @@
 import { z } from "@medusajs/framework/zod"
 import { createFindParams, createSelectParams } from "../../utils/validators"
 import { applyAndAndOrOperators } from "../../utils/common-validators"
+import { isString } from "@medusajs/framework/utils"
+
+const Metadata = z.record(z.string(), z.unknown()).nullish()
 
 export const StoreGetOrderParams = createSelectParams()
 export type StoreGetOrderParamsType = z.infer<typeof StoreGetOrderParams>
@@ -33,3 +37,34 @@ export const StoreDeclineOrderTransferRequest = z.object({
   token: z.string().min(1),
 })
+export const StoreGetOrderNotesParams = createFindParams({
+  offset: 0,
+  limit: 50,
+}).merge(
+  z.object({
+    pinned: z
+      .preprocess((value) => {
+        if (isString(value)) {
+          return value === "true"
+        }
+        return value
+      }, z.boolean().optional())
+      .optional(),
+  })
+)
+
+export type StoreGetOrderNotesParamsType = z.infer<
+  typeof StoreGetOrderNotesParams
+>
+
+export const StoreCreateOrderNote = z.object({
+  title: z.string().max(120).optional(),
+  body: z.string().min(1).max(4000),
+  metadata: Metadata,
+})
+
+export type StoreCreateOrderNoteType = z.infer<typeof StoreCreateOrderNote>
diff --git a/packages/medusa/src/api/admin/orders/validators.ts b/packages/medusa/src/api/admin/orders/validators.ts
index 6f81b095f6..aa3b9a1e95 100644
--- a/packages/medusa/src/api/admin/orders/validators.ts
+++ b/packages/medusa/src/api/admin/orders/validators.ts
@@ -151,3 +151,35 @@ export const AdminCreateOrderCreditLines = z.object({
   reference_id: z.string(),
   metadata: z.record(z.string(), z.unknown()).nullish(),
 })
+
+export const AdminGetOrderNotesParams = createFindParams({
+  limit: 50,
+  offset: 0,
+}).merge(
+  z.object({
+    pinned: z.boolean().optional(),
+    created_by: z.union([z.string(), z.array(z.string())]).optional(),
+  })
+)
+
+export type AdminGetOrderNotesParamsType = z.infer<
+  typeof AdminGetOrderNotesParams
+>
+
+export const AdminCreateOrderNote = WithAdditionalData(
+  z.object({
+    title: z.string().max(120).optional(),
+    body: z.string().min(1).max(4000),
+    pinned: z.boolean().optional(),
+    metadata: z.record(z.string(), z.unknown()).nullish(),
+  })
+)
+
+export type AdminCreateOrderNoteType = z.infer<typeof AdminCreateOrderNote>
diff --git a/packages/medusa/src/api/store/orders/query-config.ts b/packages/medusa/src/api/store/orders/query-config.ts
index 6ea1ea939a..bbcd332d2b 100644
--- a/packages/medusa/src/api/store/orders/query-config.ts
+++ b/packages/medusa/src/api/store/orders/query-config.ts
@@ -7,6 +7,7 @@ export const defaultStoreOrderFields = [
   "metadata",
   "created_at",
   "updated_at",
+  "*notes",
 ]
 
 export const defaultStoreRetrieveOrderFields = [
@@ -47,6 +48,7 @@ export const defaultStoreRetrieveOrderFields = [
   "*shipping_methods.tax_lines",
   "*shipping_methods.adjustments",
   "*payment_collections",
+  "*notes",
 ]
 
 export const retrieveTransformQueryConfig = {
diff --git a/packages/medusa/src/api/admin/orders/query-config.ts b/packages/medusa/src/api/admin/orders/query-config.ts
index 8e83774d8c..d2b0e1e9d0 100644
--- a/packages/medusa/src/api/admin/orders/query-config.ts
+++ b/packages/medusa/src/api/admin/orders/query-config.ts
@@ -12,6 +12,7 @@ export const defaultAdminOrderFields = [
   "metadata",
   "locale",
   "created_at",
+  "*notes",
   "updated_at",
 ]
@@ -48,6 +49,7 @@ export const defaultAdminRetrieveOrderFields = [
   "*payment_collections",
   "*payment_collections.payments",
   "*payment_collections.payments.refunds",
+  "*notes",
   "*payment_collections.payments.captures",
 ]
diff --git a/packages/medusa/src/api/store/orders/middlewares.ts b/packages/medusa/src/api/store/orders/middlewares.ts
index 4ceae32241..a8d41cb18a 100644
--- a/packages/medusa/src/api/store/orders/middlewares.ts
+++ b/packages/medusa/src/api/store/orders/middlewares.ts
@@ -10,6 +10,8 @@ import {
   StoreRequestOrderTransfer,
   StoreDeclineOrderTransferRequest,
+  StoreGetOrderNotesParams,
+  StoreCreateOrderNote,
 } from "./validators"
 
 export const storeOrderRoutesMiddlewares: MiddlewareRoute[] = [
@@ -30,6 +32,28 @@ export const storeOrderRoutesMiddlewares: MiddlewareRoute[] = [
       ),
     ],
   },
+  {
+    method: ["GET"],
+    matcher: "/store/orders/:id/notes",
+    middlewares: [
+      authenticate("customer", ["session", "bearer"]),
+      validateAndTransformQuery(
+        StoreGetOrderNotesParams,
+        QueryConfig.listTransformQueryConfig
+      ),
+    ],
+  },
+  {
+    method: ["POST"],
+    matcher: "/store/orders/:id/notes",
+    middlewares: [
+      authenticate("customer", ["session", "bearer"]),
+      validateAndTransformBody(StoreCreateOrderNote),
+      validateAndTransformQuery(
+        StoreGetOrderParams,
+        QueryConfig.retrieveTransformQueryConfig
+      ),
+    ],
+  },
   {
     method: ["POST"],
     matcher: "/store/orders/:id/transfer/request",
diff --git a/packages/medusa/src/api/admin/orders/middlewares.ts b/packages/medusa/src/api/admin/orders/middlewares.ts
index 9432fe7b73..d7c55ecda8 100644
--- a/packages/medusa/src/api/admin/orders/middlewares.ts
+++ b/packages/medusa/src/api/admin/orders/middlewares.ts
@@ -12,6 +12,8 @@ import {
   AdminGetOrderShippingOptionList,
   AdminGetOrdersOrderItemsParams,
   AdminGetOrdersOrderParams,
+  AdminGetOrderNotesParams,
+  AdminCreateOrderNote,
   AdminGetOrdersParams,
   AdminMarkOrderFulfillmentAsDelivered,
   AdminOrderCancelFulfillment,
@@ -78,6 +80,32 @@ export const adminOrderRoutesMiddlewares: MiddlewareRoute[] = [
       },
     ],
   },
+  {
+    method: ["GET"],
+    matcher: "/admin/orders/:id/notes",
+    middlewares: [
+      validateAndTransformQuery(
+        AdminGetOrderNotesParams,
+        QueryConfig.listTransformQueryConfig
+      ),
+    ],
+    policies: [
+      {
+        resource: Entities.order,
+        operation: PolicyOperation.read,
+      },
+    ],
+  },
+  {
+    method: ["POST"],
+    matcher: "/admin/orders/:id/notes",
+    middlewares: [
+      validateAndTransformBody(AdminCreateOrderNote),
+      validateAndTransformQuery(
+        AdminGetOrdersOrderParams,
+        QueryConfig.retrieveTransformQueryConfig
+      ),
+    ],
+  },
   {
     method: ["GET"],
     matcher: "/admin/orders/:id/line-items",
diff --git a/integration-tests/http/admin/order-notes.spec.ts b/integration-tests/http/admin/order-notes.spec.ts
new file mode 100644
index 0000000000..b173f031a4
--- /dev/null
+++ b/integration-tests/http/admin/order-notes.spec.ts
@@ -0,0 +1,176 @@
+import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
+import { createAdminUser, adminHeaders } from "../../helpers/create-admin-user"
+
+medusaIntegrationTestRunner({
+  testSuite: ({ api, getContainer }) => {
+    describe("POST /admin/orders/:id/notes", () => {
+      let orderId: string
+      let customerId: string
+
+      beforeEach(async () => {
+        await createAdminUser(getContainer())
+
+        customerId = "cus_note_owner"
+        orderId = "order_note_admin"
+
+        const orderModule = getContainer().resolve("order")
+        await orderModule.createOrders({
+          id: orderId,
+          customer_id: customerId,
+          email: "ada@example.com",
+          currency_code: "usd",
+        })
+      })
+
+      it("lets an admin create a note on behalf of the order customer", async () => {
+        const response = await api.post(
+          `/admin/orders/${orderId}/notes`,
+          {
+            title: "Address correction",
+            body: "Customer asked support to update the apartment number.",
+            pinned: true,
+            metadata: {
+              ticket_id: "zd_123",
+            },
+          },
+          adminHeaders
+        )
+
+        expect(response.status).toBe(201)
+        expect(response.data.note.body).toContain("apartment")
+        expect(response.data.note.created_by).toBe(customerId)
+        expect(response.data.note.created_by_type).toBe("customer")
+        expect(response.data.order.notes[0].body).toContain("apartment")
+      })
+
+      it("lists notes through the admin route", async () => {
+        await api.post(
+          `/admin/orders/${orderId}/notes`,
+          {
+            body: "Keep delivery before 5pm. Customer gets anxious.",
+          },
+          adminHeaders
+        )
+
+        const response = await api.get(
+          `/admin/orders/${orderId}/notes`,
+          adminHeaders
+        )
+
+        expect(response.status).toBe(200)
+        expect(response.data.notes).toHaveLength(1)
+        expect(response.data.notes[0].created_by).toBe(customerId)
+      })
+
+      it("returns notes on admin order retrieval", async () => {
+        await api.post(
+          `/admin/orders/${orderId}/notes`,
+          {
+            body: "Refund promise approved by support lead.",
+            metadata: {
+              internal_reason: "manual exception",
+            },
+          },
+          adminHeaders
+        )
+
+        const response = await api.get(`/admin/orders/${orderId}`, adminHeaders)
+
+        expect(response.status).toBe(200)
+        expect(response.data.order.notes[0].metadata.internal_reason).toBe(
+          "manual exception"
+        )
+      })
+    })
+  },
+})
diff --git a/integration-tests/http/store/order-notes.spec.ts b/integration-tests/http/store/order-notes.spec.ts
new file mode 100644
index 0000000000..7e6e79901d
--- /dev/null
+++ b/integration-tests/http/store/order-notes.spec.ts
@@ -0,0 +1,160 @@
+import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
+import {
+  createAuthenticatedCustomer,
+  storeHeaders,
+} from "../../helpers/create-authenticated-customer"
+
+medusaIntegrationTestRunner({
+  testSuite: ({ api, getContainer }) => {
+    describe("store order notes", () => {
+      let orderId: string
+      let customerId: string
+
+      beforeEach(async () => {
+        const customer = await createAuthenticatedCustomer(getContainer(), api)
+        customerId = customer.customer.id
+        orderId = "order_note_store"
+
+        const orderModule = getContainer().resolve("order")
+        await orderModule.createOrders({
+          id: orderId,
+          customer_id: customerId,
+          email: customer.customer.email,
+          currency_code: "usd",
+        })
+      })
+
+      it("lets the owning customer create and retrieve order notes", async () => {
+        const createResponse = await api.post(
+          `/store/orders/${orderId}/notes`,
+          {
+            title: "Delivery note",
+            body: "Please call when the driver is downstairs.",
+          },
+          storeHeaders
+        )
+
+        expect(createResponse.status).toBe(201)
+        expect(createResponse.data.note.created_by).toBe(customerId)
+
+        const listResponse = await api.get(
+          `/store/orders/${orderId}/notes`,
+          storeHeaders
+        )
+
+        expect(listResponse.status).toBe(200)
+        expect(listResponse.data.notes[0].body).toContain("downstairs")
+      })
+
+      it("shows support-created notes in the store order payload", async () => {
+        const orderNoteService = getContainer().resolve("orderNoteService")
+        await orderNoteService.createOrderNotes({
+          order_id: orderId,
+          body: "Support flagged this order as potential fraud.",
+          title: "Risk review",
+          pinned: true,
+          created_by: "usr_support",
+          created_by_type: "user",
+          metadata: {
+            internal_ticket: "risk_1",
+          },
+        })
+
+        const response = await api.get(`/store/orders/${orderId}`, storeHeaders)
+
+        expect(response.status).toBe(200)
+        expect(response.data.order.notes[0].body).toContain("fraud")
+        expect(response.data.order.notes[0].metadata.internal_ticket).toBe(
+          "risk_1"
+        )
+      })
+    })
+  },
+})
```

## Intended Flaws

### Flaw 1: Admin Note Creation Reuses The Customer Workflow And Loses Admin Actor Context

- `type`: `actor_boundary_mismatch`
- `location`: `packages/medusa/src/api/admin/orders/[id]/notes/route.ts:43-78`, `packages/core/core-flows/src/order/workflows/create-customer-order-note.ts:23-58`, `packages/core/core-flows/src/order/workflows/create-customer-order-note.ts:60-82`, `integration-tests/http/admin/order-notes.spec.ts:25-41`
- `learner_prompt`: Is an admin support override the same product action as a customer writing a note on their own order?

Expected answer:

- `identify`: The admin route calls `createCustomerOrderNoteWorkflow`, passes `customer_id: order.customer_id`, forces `actor_type: "customer"`, and records `created_by: order.customer_id`. The customer workflow only validates that `order.customer_id === input.customer_id`, so the admin route satisfies a customer-only invariant by impersonating the order customer. The admin user is hidden inside metadata instead of being the actor/provenance of the write.
- `impact`: Support-created notes look like customer-authored notes. Audits, exports, webhooks, moderation, and downstream automations cannot distinguish "customer said this" from "support wrote this." Any future customer-specific checks in the workflow can be bypassed by the admin route because it calls the customer command with the customer's ID. This is exactly how boundary mistakes fossilize: the route works, tests pass, but the domain model now lies about who did the action.
- `fix_direction`: Split the commands. Keep a customer workflow for self-service notes with `actor_type: "customer"` and owner validation. Add an admin workflow/command that requires `actor_type: "user"`, `created_by: req.auth_context.actor_id`, and admin policy enforcement. If support writes on behalf of a customer, model both identities explicitly: `created_by` as the user and `on_behalf_of_customer_id` or `customer_visible_author` separately.

Hints:

1. Compare this PR to the transfer cancellation workflow, which treats `actor_type: "user"` and `actor_type: "customer"` differently.
2. Look at what the admin route passes into the workflow. Which identity is used for validation, and which identity is stored?
3. A support action can be customer-facing without pretending that the customer performed it.

### Flaw 2: Note Visibility Is Not Modeled, So Internal Notes Leak To Store Customers

- `type`: `read_contract_leak`
- `location`: `packages/modules/order/src/models/order-note.ts:7-17`, `packages/medusa/src/api/store/orders/query-config.ts:7-50`, `packages/medusa/src/api/store/orders/[id]/notes/route.ts:20-43`, `packages/medusa/src/api/admin/orders/[id]/notes/route.ts:43-78`, `integration-tests/http/store/order-notes.spec.ts:36-58`
- `learner_prompt`: Which notes should appear in store/customer responses, and where is that rule encoded?

Expected answer:

- `identify`: The note model has `body`, `created_by`, `created_by_type`, `pinned`, and metadata, but no visibility field such as `customer_visible`, `internal`, or `audience`. Store order defaults add `*notes`, and the store notes route lists all notes for the order without filtering by visibility or author type. The tests even assert that a support-created note containing "potential fraud" and `internal_ticket` appears in the store order payload.
- `impact`: Internal support context, fraud/risk notes, refund exceptions, supplier problems, and customer-service ticket IDs can be returned to the customer. Once `*notes` is in the default store retrieve fields, any app using the store order endpoint can accidentally display those notes. The leak is not fixable by UI hiding because the sensitive data has already crossed the API boundary.
- `fix_direction`: Add an explicit visibility/audience contract before exposing notes. For example, `visibility: "internal" | "customer"` or `customer_visible: boolean`, default admin-created notes to internal, and require an explicit customer-visible action. Store query defaults and store note routes must filter to customer-visible notes only and strip internal metadata. Admin reads can include all notes with visibility and actor fields.

Hints:

1. The store query-config warning is a clue: copied admin fields are dangerous on customer-facing APIs.
2. Search for how the route distinguishes staff-only notes from customer-visible notes before deciding what can be overridden.
3. The failing mental model is "admin-created note" vs "customer-visible note." Those are separate dimensions.

## Expert Debrief

### Product-Level Change

The PR tries to make support workflows better by adding order notes and letting support leave customer-facing messages. That is a useful feature: notes can reduce helpdesk context switching and make order history more explainable.

But it changes two contracts that strong reviewers should protect carefully: who is allowed to perform a product action, and which data is safe to show to the customer.

### Changed Contracts

- Data model contract: orders now have note records, not just metadata and order-change internals.
- Actor contract: notes have `created_by` and `created_by_type`, so the system is claiming provenance.
- Workflow contract: customer note creation becomes a reusable command used by both store and admin routes.
- Admin API contract: support can create notes from an authenticated admin route.
- Store API contract: order retrieve/list note responses become customer-visible.
- Query defaults contract: `*notes` becomes part of default order payloads.

### Failure Modes

- A support note is stored as if the customer wrote it.
- A downstream notification says "customer added a note" when support actually did.
- Future customer-only workflow checks are bypassed because admin routes pass the customer's ID into a customer workflow.
- Fraud/risk/internal support notes appear in the customer's order details.
- Internal ticket IDs and metadata leak through store order payloads.
- An app displays notes because they are now returned by default store order fields, even if no UI was intentionally built for them.

### Reviewer Thought Process

A strong reviewer would ask two questions before accepting the PR:

1. Is "admin writing a customer-facing note" the same command as "customer writing a note"?
2. What is the read policy for each kind of note?

For the first question, Medusa already provides the pattern in transfer workflows: `actor_type` matters. Admin users and customers may reach the same business outcome, but they do not carry the same validation, provenance, or audit semantics.

For the second question, the reviewer should inspect the model and the store query defaults. If the model has no visibility field and the store route returns `*notes`, then every note is customer-visible by construction.

### Better Implementation Direction

Use explicit command boundaries:

- `createCustomerOrderNoteWorkflow` for authenticated customers,
- `createAdminOrderNoteWorkflow` for authenticated admin users,
- `actor_type`, `created_by`, and policy checks set from auth context, not request body or inferred customer ownership,
- optional `on_behalf_of_customer_id` if support is writing a customer-facing message.

Use explicit visibility:

- add `visibility` or `customer_visible`,
- default admin notes to internal,
- require an explicit flag or separate endpoint to publish a customer-visible support note,
- filter store reads to customer-visible notes,
- exclude internal metadata from store responses,
- test both admin-only internal notes and customer-visible support notes.

## Correctness Verdict Rubric

- Full credit for flaw 1: The answer identifies that the admin route reuses the customer workflow with customer actor context, explains audit/provenance and invariant-bypass impact, and proposes a distinct admin command with explicit admin actor plus optional on-behalf-of customer context.
- Partial credit for flaw 1: The answer notices `created_by` is wrong but does not explain why reusing the customer workflow is architecturally wrong.
- No credit for flaw 1: The answer focuses on route naming, response shape, or metadata formatting without identifying the actor boundary.

- Full credit for flaw 2: The answer identifies missing note visibility/read policy, cites the store `*notes` default or unfiltered store notes route, explains internal note leakage, and proposes explicit visibility plus store filtering and metadata stripping.
- Partial credit for flaw 2: The answer says "hide support notes in the UI" but misses that store APIs already return the data.
- No credit for flaw 2: The answer treats all order notes as naturally customer-visible.

## Golden Answer Summary

The PR adds useful support tooling but collapses two boundaries. Admin support notes are routed through a customer workflow and stored as customer-authored, so the audit trail lies and customer-only invariants can be bypassed. Notes also have no visibility model, while store order responses return `*notes`, so internal support/risk metadata can leak to customers. A correct implementation would split customer and admin note commands, preserve actor context, and make customer visibility an explicit field enforced by store read policies.
