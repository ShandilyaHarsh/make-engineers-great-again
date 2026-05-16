# TS-046: Medusa Fulfillment Workflow Compensation

## Metadata

- `id`: TS-046
- `source_repo`: [medusajs/medusa](https://github.com/medusajs/medusa)
- `repo_area`: fulfillment workflows, workflow compensation, provider side effects, shipment events, order fulfillment state, workflow recovery
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,550-1,950
- `represented_diff_lines`: 1552
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Medusa workflows, compensating actions, fulfillment providers, event outbox semantics, shipment state, and recovery after partial failure without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a new order fulfillment workflow with rollback support. The goal is to let an admin create a fulfillment and shipment in one operation while relying on workflow compensation to restore order, inventory, provider, and event state if any later step fails.

Today Medusa has lower-level fulfillment workflows and order workflows. This PR adds a higher-level workflow that:

- creates a fulfillment through the configured fulfillment provider,
- records provider response data,
- links the fulfillment to the order,
- marks the fulfillment shipped,
- registers the shipment on the order,
- emits fulfillment and shipment events,
- stores a workflow run record for retries and recovery,
- compensates earlier steps when a later step fails.

The intended product behavior is: if the workflow fails after touching a provider or emitting shipment events, Medusa should leave both internal state and external consumers in a recoverable, truthful state.

## Existing Code Context

The real Medusa codebase already has these relevant contracts:

- `packages/core/orchestration/src/transaction/transaction-orchestrator.ts` invokes workflow steps by increasing depth and compensates by decreasing depth. Reverse compensation is a framework primitive, but each step still owns the domain semantics of undoing its side effects.
- `packages/core/core-flows/src/fulfillment/steps/create-fulfillment.ts` returns `new StepResponse(fulfillment, fulfillment.id)` and compensates by calling `service.cancelFulfillment(id)`.
- `packages/modules/fulfillment/src/services/fulfillment-module-service.ts` creates a local fulfillment row, calls the provider's `createFulfillment(...)`, then persists `providerResult.data` and labels back onto the fulfillment. If provider creation fails, it deletes the local fulfillment row.
- `packages/core/utils/src/fulfillment/provider.ts` documents that provider `createFulfillment(...)` returns data stored in the fulfillment's `data` property, and provider `cancelFulfillment(...)` later receives that data.
- `packages/core/core-flows/src/order/workflows/create-fulfillment.ts` composes provider fulfillment, order registration, links, inventory reservation updates, and `OrderWorkflowEvents.FULFILLMENT_CREATED`.
- `packages/core/core-flows/src/order/workflows/create-shipment.ts` creates a shipment by updating fulfillment shipped state, registering the shipment on the order, and emitting `FulfillmentWorkflowEvents.SHIPMENT_CREATED`.
- `packages/core/core-flows/src/order/steps/register-shipment.ts` compensates order shipment registration with `service.revertLastVersion(orderId)`. That only reverts order module state.
- `packages/core/core-flows/src/fulfillment/steps/update-fulfillment.ts` compensates by restoring the prior fulfillment row, while the surrounding tests note that relationship rows such as labels are not uniformly reverted.
- `integration-tests/modules/__tests__/fulfillment/fulfillment.workflows.spec.ts` already tests that a following failure cancels created fulfillments and rolls back `shipped_at`, while explicitly noting shipment label relationships are not reverted uniformly.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the new workflow compensates all committed side effects and whether provider response data is treated as durable domain state correctly.

## Review Surface

Changed files in the synthetic PR:

- `packages/core/core-flows/src/order/migrations/20260516A-create-fulfillment-workflow-runs.ts`
- `packages/core/core-flows/src/order/types/fulfillment-workflow-run.ts`
- `packages/core/core-flows/src/order/repositories/fulfillment-workflow-run.ts`
- `packages/core/core-flows/src/order/steps/fulfillment-workflow-run.ts`
- `packages/core/core-flows/src/order/steps/provider-fulfillment-with-run.ts`
- `packages/core/core-flows/src/order/steps/shipment-workflow-events.ts`
- `packages/core/core-flows/src/order/workflows/create-fulfillment-with-rollback.ts`
- `packages/medusa/src/api/admin/orders/[id]/fulfillment-workflow/route.ts`
- `packages/core/core-flows/src/order/workflows/__tests__/create-fulfillment-with-rollback.spec.ts`
- `packages/core/core-flows/src/order/steps/__tests__/provider-fulfillment-with-run.spec.ts`
- `docs/operations/fulfillment-workflow-rollback.md`

The line references below use synthetic PR line numbers. The represented diff is focused on compensation semantics, durable event side effects, provider response persistence, idempotent retries, and tests that normalize unsafe rollback behavior.

## Diff

```diff
diff --git a/packages/core/core-flows/src/order/migrations/20260516A-create-fulfillment-workflow-runs.ts b/packages/core/core-flows/src/order/migrations/20260516A-create-fulfillment-workflow-runs.ts
new file mode 100644
index 0000000000..b3c8d6a9e3
--- /dev/null
+++ b/packages/core/core-flows/src/order/migrations/20260516A-create-fulfillment-workflow-runs.ts
@@ -0,0 +1,82 @@
+import type { Knex } from "knex"
+
+const table = "order_fulfillment_workflow_runs"
+
+export async function up(knex: Knex): Promise<void> {
+  await knex.schema.createTable(table, (t) => {
+    t.string("id").primary()
+    t.string("order_id").notNullable()
+    t.string("fulfillment_id").nullable()
+    t.string("shipment_id").nullable()
+    t.string("provider_id").nullable()
+    t.string("shipping_option_id").nullable()
+    t.string("status").notNullable().defaultTo("pending")
+    t.string("idempotency_key").notNullable()
+    t.string("failed_step").nullable()
+    t.jsonb("provider_response").nullable()
+    t.jsonb("provider_request").nullable()
+    t.jsonb("shipment_event_payload").nullable()
+    t.jsonb("compensation_log").notNullable().defaultTo("[]")
+    t.text("error_message").nullable()
+    t.timestamp("started_at", { useTz: true }).nullable()
+    t.timestamp("completed_at", { useTz: true }).nullable()
+    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now())
+    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now())
+    t.unique(["idempotency_key"], {
+      indexName: "order_fulfillment_workflow_runs_idempotency_key_unique",
+    })
+    t.index(["order_id", "status"], "order_fulfillment_workflow_runs_order_status_idx")
+    t.index(["fulfillment_id"], "order_fulfillment_workflow_runs_fulfillment_idx")
+    t.index(["shipment_id"], "order_fulfillment_workflow_runs_shipment_idx")
+  })
+}
+
+export async function down(knex: Knex): Promise<void> {
+  await knex.schema.dropTableIfExists(table)
+}
diff --git a/packages/core/core-flows/src/order/types/fulfillment-workflow-run.ts b/packages/core/core-flows/src/order/types/fulfillment-workflow-run.ts
new file mode 100644
index 0000000000..e423d83497
--- /dev/null
+++ b/packages/core/core-flows/src/order/types/fulfillment-workflow-run.ts
@@ -0,0 +1,168 @@
+import type {
+  FulfillmentDTO,
+  FulfillmentWorkflow,
+  OrderWorkflow,
+} from "@medusajs/framework/types"
+
+export type FulfillmentWorkflowRunStatus =
+  | "pending"
+  | "creating_provider_fulfillment"
+  | "provider_created"
+  | "order_registered"
+  | "shipment_registered"
+  | "events_emitted"
+  | "completed"
+  | "compensating"
+  | "compensated"
+  | "failed"
+
+export type FulfillmentWorkflowCompensationAction =
+  | "cancel_provider_fulfillment"
+  | "revert_order_fulfillment"
+  | "revert_order_shipment"
+  | "skip_event_compensation"
+  | "restore_fulfillment_snapshot"
+
+export interface FulfillmentWorkflowRunDTO {
+  id: string
+  order_id: string
+  fulfillment_id: string | null
+  shipment_id: string | null
+  provider_id: string | null
+  shipping_option_id: string | null
+  status: FulfillmentWorkflowRunStatus
+  idempotency_key: string
+  failed_step: string | null
+  provider_response: ProviderFulfillmentResponse | null
+  provider_request: ProviderFulfillmentRequest | null
+  shipment_event_payload: ShipmentEventPayload | null
+  compensation_log: FulfillmentWorkflowCompensationEntry[]
+  error_message: string | null
+  started_at: Date | null
+  completed_at: Date | null
+  created_at: Date
+  updated_at: Date
+}
+
+export interface ProviderFulfillmentRequest {
+  order_id: string
+  shipping_option_id: string
+  provider_id: string
+  location_id: string
+  items: OrderWorkflow.CreateOrderFulfillmentWorkflowInput["items"]
+  delivery_address: FulfillmentWorkflow.CreateFulfillmentWorkflowInput["delivery_address"]
+  data?: Record<string, unknown>
+}
+
+export interface ProviderFulfillmentResponse {
+  provider_id: string
+  fulfillment_id?: string
+  external_fulfillment_id?: string
+  external_shipment_id?: string
+  carrier?: string
+  service?: string
+  tracking_number?: string
+  tracking_url?: string
+  label_url?: string
+  label_format?: string
+  commercial_invoice_url?: string
+  rate_id?: string
+  request_id?: string
+  provider_status?: string
+  provider_payload?: Record<string, unknown>
+  labels?: ProviderFulfillmentLabel[]
+  data?: Record<string, unknown>
+}
+
+export interface ProviderFulfillmentLabel {
+  tracking_number?: string
+  tracking_url?: string
+  label_url?: string
+  carrier?: string
+  service?: string
+  metadata?: Record<string, unknown>
+}
+
+export interface ShipmentEventPayload {
+  order_id: string
+  fulfillment_id: string
+  shipment_id: string
+  no_notification?: boolean
+  tracking_number?: string
+  source: "create-fulfillment-with-rollback"
+}
+
+export interface FulfillmentWorkflowCompensationEntry {
+  action: FulfillmentWorkflowCompensationAction
+  at: string
+  status: "skipped" | "completed" | "failed"
+  message?: string
+  data?: Record<string, unknown>
+}
+
+export interface CreateFulfillmentWithRollbackInput
+  extends OrderWorkflow.CreateOrderFulfillmentWorkflowInput {
+  idempotency_key: string
+  auto_ship?: boolean
+  no_notification?: boolean
+  created_by?: string | null
+}
+
+export interface ProviderFulfillmentStepInput {
+  run: FulfillmentWorkflowRunDTO
+  request: ProviderFulfillmentRequest
+  fulfillment: FulfillmentDTO | null
+}
+
+export interface ProviderFulfillmentStepOutput {
+  run: FulfillmentWorkflowRunDTO
+  fulfillment: FulfillmentDTO
+  providerResponse: ProviderFulfillmentResponse
+}
+
+export interface ShipmentEventStepInput {
+  run: FulfillmentWorkflowRunDTO
+  payload: ShipmentEventPayload
+}
+
+export interface WorkflowRunPatch {
+  status?: FulfillmentWorkflowRunStatus
+  fulfillment_id?: string | null
+  shipment_id?: string | null
+  provider_id?: string | null
+  shipping_option_id?: string | null
+  provider_response?: ProviderFulfillmentResponse | null
+  provider_request?: ProviderFulfillmentRequest | null
+  shipment_event_payload?: ShipmentEventPayload | null
+  failed_step?: string | null
+  error_message?: string | null
+  compensation_log?: FulfillmentWorkflowCompensationEntry[]
+  started_at?: Date | null
+  completed_at?: Date | null
+}
+
+export function makeCompensationEntry(
+  action: FulfillmentWorkflowCompensationAction,
+  status: "skipped" | "completed" | "failed",
+  message?: string,
+  data?: Record<string, unknown>
+): FulfillmentWorkflowCompensationEntry {
+  return {
+    action,
+    status,
+    message,
+    data,
+    at: new Date().toISOString(),
+  }
+}
diff --git a/packages/core/core-flows/src/order/repositories/fulfillment-workflow-run.ts b/packages/core/core-flows/src/order/repositories/fulfillment-workflow-run.ts
new file mode 100644
index 0000000000..7d8e78d32f
--- /dev/null
+++ b/packages/core/core-flows/src/order/repositories/fulfillment-workflow-run.ts
@@ -0,0 +1,174 @@
+import { randomUUID } from "crypto"
+import type { Knex } from "knex"
+import { Modules } from "@medusajs/framework/utils"
+import type {
+  CreateFulfillmentWithRollbackInput,
+  FulfillmentWorkflowRunDTO,
+  WorkflowRunPatch,
+} from "../types/fulfillment-workflow-run"
+
+const table = "order_fulfillment_workflow_runs"
+
+export class FulfillmentWorkflowRunRepository {
+  constructor(private readonly manager: Knex) {}
+
+  async create(input: CreateFulfillmentWithRollbackInput): Promise<FulfillmentWorkflowRunDTO> {
+    const id = `fwfr_${randomUUID()}`
+    const now = new Date()
+
+    await this.manager(table).insert({
+      id,
+      order_id: input.order_id,
+      fulfillment_id: null,
+      shipment_id: null,
+      provider_id: null,
+      shipping_option_id: input.shipping_option_id ?? null,
+      status: "pending",
+      idempotency_key: input.idempotency_key,
+      failed_step: null,
+      provider_response: null,
+      provider_request: null,
+      shipment_event_payload: null,
+      compensation_log: JSON.stringify([]),
+      error_message: null,
+      started_at: now,
+      completed_at: null,
+      created_at: now,
+      updated_at: now,
+    })
+
+    return this.findById(id) as Promise<FulfillmentWorkflowRunDTO>
+  }
+
+  async findById(id: string): Promise<FulfillmentWorkflowRunDTO | null> {
+    const row = await this.manager(table).where({ id }).first()
+    return row ? this.deserialize(row) : null
+  }
+
+  async findByIdempotencyKey(idempotencyKey: string): Promise<FulfillmentWorkflowRunDTO | null> {
+    const row = await this.manager(table).where({ idempotency_key: idempotencyKey }).first()
+    return row ? this.deserialize(row) : null
+  }
+
+  async getOrCreate(input: CreateFulfillmentWithRollbackInput): Promise<FulfillmentWorkflowRunDTO> {
+    const existing = await this.findByIdempotencyKey(input.idempotency_key)
+
+    if (existing) {
+      return existing
+    }
+
+    return this.create(input)
+  }
+
+  async patch(id: string, patch: WorkflowRunPatch): Promise<FulfillmentWorkflowRunDTO> {
+    await this.manager(table)
+      .where({ id })
+      .update({
+        ...this.serializePatch(patch),
+        updated_at: new Date(),
+      })
+
+    return this.findById(id) as Promise<FulfillmentWorkflowRunDTO>
+  }
+
+  async appendCompensation(
+    id: string,
+    entry: FulfillmentWorkflowRunDTO["compensation_log"][number]
+  ): Promise<FulfillmentWorkflowRunDTO> {
+    const current = await this.findById(id)
+    const compensationLog = current?.compensation_log ?? []
+
+    return this.patch(id, {
+      compensation_log: [...compensationLog, entry],
+      status: "compensating",
+    })
+  }
+
+  async markCompleted(id: string): Promise<FulfillmentWorkflowRunDTO> {
+    return this.patch(id, {
+      status: "completed",
+      completed_at: new Date(),
+    })
+  }
+
+  async markFailed(id: string, failedStep: string, error: unknown): Promise<FulfillmentWorkflowRunDTO> {
+    return this.patch(id, {
+      status: "failed",
+      failed_step: failedStep,
+      error_message: error instanceof Error ? error.message : String(error),
+      completed_at: new Date(),
+    })
+  }
+
+  private serializePatch(patch: WorkflowRunPatch): Record<string, unknown> {
+    return {
+      ...patch,
+      provider_response: patch.provider_response === undefined ? undefined : JSON.stringify(patch.provider_response),
+      provider_request: patch.provider_request === undefined ? undefined : JSON.stringify(patch.provider_request),
+      shipment_event_payload:
+        patch.shipment_event_payload === undefined ? undefined : JSON.stringify(patch.shipment_event_payload),
+      compensation_log: patch.compensation_log === undefined ? undefined : JSON.stringify(patch.compensation_log),
+    }
+  }
+
+  private deserialize(row: any): FulfillmentWorkflowRunDTO {
+    return {
+      ...row,
+      provider_response:
+        typeof row.provider_response === "string" ? JSON.parse(row.provider_response) : row.provider_response,
+      provider_request: typeof row.provider_request === "string" ? JSON.parse(row.provider_request) : row.provider_request,
+      shipment_event_payload:
+        typeof row.shipment_event_payload === "string"
+          ? JSON.parse(row.shipment_event_payload)
+          : row.shipment_event_payload,
+      compensation_log:
+        typeof row.compensation_log === "string" ? JSON.parse(row.compensation_log) : row.compensation_log ?? [],
+    }
+  }
+}
+
+export function resolveFulfillmentWorkflowRunRepository(container): FulfillmentWorkflowRunRepository {
+  const manager = container.resolve(Modules.ORDER).manager_
+  return new FulfillmentWorkflowRunRepository(manager)
+}
diff --git a/packages/core/core-flows/src/order/steps/fulfillment-workflow-run.ts b/packages/core/core-flows/src/order/steps/fulfillment-workflow-run.ts
new file mode 100644
index 0000000000..9e159a4e8c
--- /dev/null
+++ b/packages/core/core-flows/src/order/steps/fulfillment-workflow-run.ts
@@ -0,0 +1,126 @@
+import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
+import type {
+  CreateFulfillmentWithRollbackInput,
+  FulfillmentWorkflowRunDTO,
+  WorkflowRunPatch,
+} from "../types/fulfillment-workflow-run"
+import { makeCompensationEntry } from "../types/fulfillment-workflow-run"
+import { resolveFulfillmentWorkflowRunRepository } from "../repositories/fulfillment-workflow-run"
+
+export const createFulfillmentWorkflowRunStepId = "create-fulfillment-workflow-run"
+
+export const createFulfillmentWorkflowRunStep = createStep(
+  createFulfillmentWorkflowRunStepId,
+  async (input: CreateFulfillmentWithRollbackInput, { container }) => {
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    const run = await repo.getOrCreate(input)
+    return new StepResponse(run, run.id)
+  },
+  async (runId, { container }) => {
+    if (!runId) {
+      return
+    }
+
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    await repo.appendCompensation(
+      runId,
+      makeCompensationEntry("restore_fulfillment_snapshot", "completed", "Workflow run left for audit")
+    )
+  }
+)
+
+export const patchFulfillmentWorkflowRunStepId = "patch-fulfillment-workflow-run"
+
+export const patchFulfillmentWorkflowRunStep = createStep(
+  patchFulfillmentWorkflowRunStepId,
+  async (input: { runId: string; patch: WorkflowRunPatch }, { container }) => {
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    const run = await repo.patch(input.runId, input.patch)
+    return new StepResponse(run, {
+      runId: input.runId,
+      previousPatch: input.patch,
+    })
+  },
+  async (compensation, { container }) => {
+    if (!compensation?.runId) {
+      return
+    }
+
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    await repo.appendCompensation(
+      compensation.runId,
+      makeCompensationEntry("restore_fulfillment_snapshot", "skipped", "Run patches are audit-only")
+    )
+  }
+)
+
+export const completeFulfillmentWorkflowRunStepId = "complete-fulfillment-workflow-run"
+
+export const completeFulfillmentWorkflowRunStep = createStep(
+  completeFulfillmentWorkflowRunStepId,
+  async (run: FulfillmentWorkflowRunDTO, { container }) => {
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    const completed = await repo.markCompleted(run.id)
+    return new StepResponse(completed, run.id)
+  },
+  async (runId, { container }) => {
+    if (!runId) {
+      return
+    }
+
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    await repo.appendCompensation(
+      runId,
+      makeCompensationEntry("restore_fulfillment_snapshot", "completed", "Completed run compensated by workflow")
+    )
+  }
+)
diff --git a/packages/core/core-flows/src/order/steps/provider-fulfillment-with-run.ts b/packages/core/core-flows/src/order/steps/provider-fulfillment-with-run.ts
new file mode 100644
index 0000000000..24b810bd95
--- /dev/null
+++ b/packages/core/core-flows/src/order/steps/provider-fulfillment-with-run.ts
@@ -0,0 +1,238 @@
+import type {
+  FulfillmentDTO,
+  IFulfillmentModuleService,
+} from "@medusajs/framework/types"
+import { Modules } from "@medusajs/framework/utils"
+import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
+import type {
+  ProviderFulfillmentResponse,
+  ProviderFulfillmentStepInput,
+  ProviderFulfillmentStepOutput,
+} from "../types/fulfillment-workflow-run"
+import { makeCompensationEntry } from "../types/fulfillment-workflow-run"
+import { resolveFulfillmentWorkflowRunRepository } from "../repositories/fulfillment-workflow-run"
+
+export const createProviderFulfillmentWithRunStepId = "create-provider-fulfillment-with-run"
+
+export const createProviderFulfillmentWithRunStep = createStep(
+  createProviderFulfillmentWithRunStepId,
+  async (
+    input: ProviderFulfillmentStepInput,
+    { container }
+  ): Promise<StepResponse<ProviderFulfillmentStepOutput, ProviderFulfillmentResponse>> => {
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    const fulfillmentService = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT)
+
+    if (input.run.provider_response) {
+      const restoredFulfillment = await fulfillmentService.retrieveFulfillment(
+        input.run.fulfillment_id!,
+        {
+          relations: ["items", "labels"],
+        }
+      )
+
+      return new StepResponse(
+        {
+          run: input.run,
+          fulfillment: restoredFulfillment,
+          providerResponse: input.run.provider_response,
+        },
+        input.run.provider_response
+      )
+    }
+
+    await repo.patch(input.run.id, {
+      status: "creating_provider_fulfillment",
+      provider_request: input.request,
+      provider_id: input.request.provider_id,
+      shipping_option_id: input.request.shipping_option_id,
+    })
+
+    const fulfillment = await fulfillmentService.createFulfillment({
+      provider_id: input.request.provider_id,
+      location_id: input.request.location_id,
+      delivery_address: input.request.delivery_address,
+      items: input.request.items.map((item) => ({
+        line_item_id: item.id,
+        quantity: item.quantity,
+      })),
+      order: {
+        id: input.request.order_id,
+      },
+      data: input.request.data ?? {},
+    } as any)
+
+    const providerResponse = normalizeProviderResponse({
+      provider_id: input.request.provider_id,
+      fulfillment,
+    })
+
+    const run = await repo.patch(input.run.id, {
+      status: "provider_created",
+      fulfillment_id: fulfillment.id,
+      provider_response: providerResponse,
+    })
+
+    return new StepResponse(
+      {
+        run,
+        fulfillment,
+        providerResponse,
+      },
+      providerResponse
+    )
+  },
+  async (providerResponse, { container }) => {
+    if (!providerResponse?.fulfillment_id) {
+      return
+    }
+
+    const fulfillmentService = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT)
+    await fulfillmentService.cancelFulfillment(providerResponse.fulfillment_id)
+  }
+)
+
+function normalizeProviderResponse({
+  provider_id,
+  fulfillment,
+}: {
+  provider_id: string
+  fulfillment: FulfillmentDTO
+}): ProviderFulfillmentResponse {
+  const labels = fulfillment.labels ?? []
+  const firstLabel = labels[0]
+  const providerData = (fulfillment.data ?? {}) as Record<string, unknown>
+
+  return {
+    provider_id,
+    fulfillment_id: fulfillment.id,
+    external_fulfillment_id: providerData.external_fulfillment_id as string | undefined,
+    external_shipment_id: providerData.external_shipment_id as string | undefined,
+    carrier: providerData.carrier as string | undefined,
+    service: providerData.service as string | undefined,
+    tracking_number: firstLabel?.tracking_number ?? (providerData.tracking_number as string | undefined),
+    tracking_url: firstLabel?.tracking_url ?? (providerData.tracking_url as string | undefined),
+    label_url: firstLabel?.label_url ?? (providerData.label_url as string | undefined),
+    label_format: providerData.label_format as string | undefined,
+    commercial_invoice_url: providerData.commercial_invoice_url as string | undefined,
+    rate_id: providerData.rate_id as string | undefined,
+    request_id: providerData.request_id as string | undefined,
+    provider_status: providerData.status as string | undefined,
+    provider_payload: providerData,
+    labels: labels.map((label) => ({
+      tracking_number: label.tracking_number,
+      tracking_url: label.tracking_url,
+      label_url: label.label_url,
+      carrier: providerData.carrier as string | undefined,
+      service: providerData.service as string | undefined,
+      metadata: label.metadata ?? {},
+    })),
+    data: providerData,
+  }
+}
+
+export const recordProviderCompensationStepId = "record-provider-compensation"
+
+export const recordProviderCompensationStep = createStep(
+  recordProviderCompensationStepId,
+  async (
+    input: {
+      runId: string
+      providerResponse: ProviderFulfillmentResponse | null
+      status: "skipped" | "completed" | "failed"
+      message: string
+    },
+    { container }
+  ) => {
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    await repo.appendCompensation(
+      input.runId,
+      makeCompensationEntry("cancel_provider_fulfillment", input.status, input.message, {
+        external_fulfillment_id: input.providerResponse?.external_fulfillment_id,
+        external_shipment_id: input.providerResponse?.external_shipment_id,
+      })
+    )
+    return new StepResponse(void 0)
+  }
+)
diff --git a/packages/core/core-flows/src/order/steps/shipment-workflow-events.ts b/packages/core/core-flows/src/order/steps/shipment-workflow-events.ts
new file mode 100644
index 0000000000..5c029ba079
--- /dev/null
+++ b/packages/core/core-flows/src/order/steps/shipment-workflow-events.ts
@@ -0,0 +1,162 @@
+import { FulfillmentWorkflowEvents } from "@medusajs/framework/utils"
+import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
+import { emitEventStep } from "../../common"
+import type { ShipmentEventStepInput } from "../types/fulfillment-workflow-run"
+import { makeCompensationEntry } from "../types/fulfillment-workflow-run"
+import { resolveFulfillmentWorkflowRunRepository } from "../repositories/fulfillment-workflow-run"
+
+export const emitShipmentWorkflowEventsStepId = "emit-shipment-workflow-events"
+
+export const emitShipmentWorkflowEventsStep = createStep(
+  emitShipmentWorkflowEventsStepId,
+  async (input: ShipmentEventStepInput, { container }) => {
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+
+    emitEventStep({
+      eventName: FulfillmentWorkflowEvents.SHIPMENT_CREATED,
+      data: {
+        id: input.payload.fulfillment_id,
+        no_notification: input.payload.no_notification,
+        order_id: input.payload.order_id,
+        shipment_id: input.payload.shipment_id,
+        tracking_number: input.payload.tracking_number,
+        source: input.payload.source,
+      },
+    })
+
+    const run = await repo.patch(input.run.id, {
+      status: "events_emitted",
+      shipment_event_payload: input.payload,
+    })
+
+    return new StepResponse(run, {
+      runId: input.run.id,
+      shipmentEventPayload: input.payload,
+    })
+  },
+  async (compensation, { container }) => {
+    if (!compensation?.runId) {
+      return
+    }
+
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    await repo.appendCompensation(
+      compensation.runId,
+      makeCompensationEntry(
+        "skip_event_compensation",
+        "skipped",
+        "shipment.created is already committed to the event bus; rollback only reverts internal state"
+      )
+    )
+  }
+)
+
+export const emitFulfillmentWorkflowRunFailedStepId = "emit-fulfillment-workflow-run-failed"
+
+export const emitFulfillmentWorkflowRunFailedStep = createStep(
+  emitFulfillmentWorkflowRunFailedStepId,
+  async (
+    input: {
+      runId: string
+      orderId: string
+      fulfillmentId: string | null
+      shipmentId: string | null
+      error: string
+    },
+    { container }
+  ) => {
+    const repo = resolveFulfillmentWorkflowRunRepository(container)
+    await repo.appendCompensation(
+      input.runId,
+      makeCompensationEntry("skip_event_compensation", "completed", "Recorded failure in run table", {
+        order_id: input.orderId,
+        fulfillment_id: input.fulfillmentId ?? undefined,
+        shipment_id: input.shipmentId ?? undefined,
+        error: input.error,
+      })
+    )
+
+    return new StepResponse(void 0)
+  }
+)
diff --git a/packages/core/core-flows/src/order/workflows/create-fulfillment-with-rollback.ts b/packages/core/core-flows/src/order/workflows/create-fulfillment-with-rollback.ts
new file mode 100644
index 0000000000..897b6f2f1c
--- /dev/null
+++ b/packages/core/core-flows/src/order/workflows/create-fulfillment-with-rollback.ts
@@ -0,0 +1,318 @@
+import {
+  FulfillmentWorkflowEvents,
+  Modules,
+  OrderWorkflowEvents,
+} from "@medusajs/framework/utils"
+import {
+  createWorkflow,
+  parallelize,
+  transform,
+  WorkflowData,
+  WorkflowResponse,
+} from "@medusajs/framework/workflows-sdk"
+import { emitEventStep, useQueryGraphStep } from "../../common"
+import { createShipmentWorkflow } from "../../fulfillment"
+import {
+  createFulfillmentWorkflowRunStep,
+  completeFulfillmentWorkflowRunStep,
+  patchFulfillmentWorkflowRunStep,
+} from "../steps/fulfillment-workflow-run"
+import { createProviderFulfillmentWithRunStep } from "../steps/provider-fulfillment-with-run"
+import { emitShipmentWorkflowEventsStep } from "../steps/shipment-workflow-events"
+import {
+  registerOrderFulfillmentStep,
+  registerOrderShipmentStep,
+} from "../steps"
+import {
+  CreateFulfillmentWithRollbackInput,
+  ProviderFulfillmentRequest,
+} from "../types/fulfillment-workflow-run"
+
+export const createFulfillmentWithRollbackWorkflowId =
+  "create-fulfillment-with-rollback"
+
+export const createFulfillmentWithRollbackWorkflow = createWorkflow(
+  createFulfillmentWithRollbackWorkflowId,
+  (input: WorkflowData<CreateFulfillmentWithRollbackInput>) => {
+    const { data: order } = useQueryGraphStep({
+      entity: "order",
+      filters: { id: input.order_id },
+      fields: [
+        "id",
+        "display_id",
+        "status",
+        "currency_code",
+        "items.*",
+        "shipping_address.*",
+        "shipping_methods.id",
+        "shipping_methods.shipping_option_id",
+        "shipping_methods.data",
+        "fulfillments.*",
+        "fulfillments.items.*",
+      ],
+      options: { throwIfKeyNotFound: true, isList: false },
+    }).config({ name: "get-order" })
+
+    const shippingOptionId = transform({ order, input }, ({ order, input }) => {
+      return (
+        input.shipping_option_id ??
+        order.shipping_methods?.[0]?.shipping_option_id
+      )
+    })
+
+    const shippingOption = useQueryGraphStep({
+      entity: "shipping_options",
+      filters: { id: shippingOptionId },
+      fields: [
+        "id",
+        "provider_id",
+        "service_zone.fulfillment_set.location.id",
+        "shipping_profile_id",
+      ],
+      options: { throwIfKeyNotFound: true, isList: false },
+    }).config({ name: "get-shipping-option" })
+
+    const run = createFulfillmentWorkflowRunStep(input)
+
+    const providerRequest = transform(
+      { input, shippingOption, order },
+      ({ input, shippingOption, order }): ProviderFulfillmentRequest => {
+        return {
+          order_id: input.order_id,
+          shipping_option_id: shippingOption.id,
+          provider_id: shippingOption.provider_id,
+          location_id: shippingOption.service_zone.fulfillment_set.location.id,
+          items: input.items,
+          delivery_address: input.delivery_address ?? order.shipping_address,
+          data: {
+            shipping_method_data: order.shipping_methods?.find(
+              (method) => method.shipping_option_id === shippingOption.id
+            )?.data,
+            created_by: input.created_by,
+          },
+        }
+      }
+    )
+
+    const providerFulfillment = createProviderFulfillmentWithRunStep({
+      run,
+      request: providerRequest,
+      fulfillment: null,
+    })
+
+    const registerFulfillmentData = transform(
+      { input, providerFulfillment },
+      ({ input, providerFulfillment }) => {
+        return {
+          order_id: input.order_id,
+          reference: Modules.FULFILLMENT,
+          reference_id: providerFulfillment.fulfillment.id,
+          items: input.items.map((item) => ({
+            id: item.id,
+            quantity: item.quantity,
+          })),
+        }
+      }
+    )
+
+    const fulfillmentLink = transform(
+      { input, providerFulfillment },
+      ({ input, providerFulfillment }) => {
+        return [
+          {
+            [Modules.ORDER]: { order_id: input.order_id },
+            [Modules.FULFILLMENT]: {
+              fulfillment_id: providerFulfillment.fulfillment.id,
+            },
+          },
+        ]
+      }
+    )
+
+    const shipmentInput = transform(
+      { providerFulfillment, input },
+      ({ providerFulfillment, input }) => {
+        return {
+          id: providerFulfillment.fulfillment.id,
+          labels: providerFulfillment.providerResponse.labels ?? [],
+          marked_shipped_by: input.created_by ?? undefined,
+        }
+      }
+    )
+
+    const shipment = createShipmentWorkflow.runAsStep({
+      input: shipmentInput,
+    })
+
+    const registerShipmentData = transform(
+      { input, providerFulfillment, shipment },
+      ({ input, providerFulfillment, shipment }) => {
+        return {
+          order_id: input.order_id,
+          reference: Modules.FULFILLMENT,
+          reference_id: providerFulfillment.fulfillment.id,
+          created_by: input.created_by ?? undefined,
+          items: input.items.map((item) => ({
+            id: item.id,
+            quantity: item.quantity,
+          })),
+          metadata: {
+            workflow_run_id: providerFulfillment.run.id,
+            provider_request_id: providerFulfillment.providerResponse.request_id,
+            shipment_id: shipment.id,
+          },
+        }
+      }
+    )
+
+    const eventPayload = transform(
+      { input, providerFulfillment, shipment },
+      ({ input, providerFulfillment, shipment }) => {
+        return {
+          order_id: input.order_id,
+          fulfillment_id: providerFulfillment.fulfillment.id,
+          shipment_id: shipment.id,
+          no_notification: input.no_notification,
+          tracking_number: providerFulfillment.providerResponse.tracking_number,
+          source: "create-fulfillment-with-rollback" as const,
+        }
+      }
+    )
+
+    parallelize(
+      registerOrderFulfillmentStep(registerFulfillmentData),
+      patchFulfillmentWorkflowRunStep({
+        runId: run.id,
+        patch: {
+          status: "order_registered",
+          fulfillment_id: providerFulfillment.fulfillment.id,
+          provider_response: providerFulfillment.providerResponse,
+        },
+      }),
+      emitEventStep({
+        eventName: OrderWorkflowEvents.FULFILLMENT_CREATED,
+        data: {
+          order_id: input.order_id,
+          fulfillment_id: providerFulfillment.fulfillment.id,
+          no_notification: input.no_notification,
+        },
+      })
+    )
+
+    parallelize(
+      registerOrderShipmentStep(registerShipmentData),
+      patchFulfillmentWorkflowRunStep({
+        runId: run.id,
+        patch: {
+          status: "shipment_registered",
+          shipment_id: shipment.id,
+          shipment_event_payload: eventPayload,
+        },
+      }),
+      emitShipmentWorkflowEventsStep({
+        run: providerFulfillment.run,
+        payload: eventPayload,
+      })
+    )
+
+    const completedRun = completeFulfillmentWorkflowRunStep(run)
+
+    return new WorkflowResponse(
+      {
+        fulfillment_id: providerFulfillment.fulfillment.id,
+        shipment_id: shipment.id,
+        run_id: completedRun.id,
+      },
+      {
+        hooks: [],
+      }
+    )
+  }
+)
diff --git a/packages/medusa/src/api/admin/orders/[id]/fulfillment-workflow/route.ts b/packages/medusa/src/api/admin/orders/[id]/fulfillment-workflow/route.ts
new file mode 100644
index 0000000000..57cd2daf34
--- /dev/null
+++ b/packages/medusa/src/api/admin/orders/[id]/fulfillment-workflow/route.ts
@@ -0,0 +1,94 @@
+import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
+import { createFulfillmentWithRollbackWorkflow } from "@medusajs/core-flows"
+
+type AdminCreateFulfillmentWithRollbackBody = {
+  idempotency_key: string
+  shipping_option_id?: string
+  location_id?: string
+  items: { id: string; quantity: number }[]
+  delivery_address?: Record<string, unknown>
+  no_notification?: boolean
+  auto_ship?: boolean
+}
+
+export async function POST(
+  req: MedusaRequest<AdminCreateFulfillmentWithRollbackBody>,
+  res: MedusaResponse
+) {
+  const workflow = createFulfillmentWithRollbackWorkflow(req.scope)
+  const { result, errors } = await workflow.run({
+    input: {
+      ...req.validatedBody,
+      order_id: req.params.id,
+      created_by: req.auth_context?.actor_id ?? null,
+    },
+    throwOnError: false,
+  })
+
+  if (errors.length) {
+    res.status(409).json({
+      message: "Fulfillment workflow failed and compensation was started",
+      errors: errors.map((error) => ({
+        action: error.action,
+        handlerType: error.handlerType,
+        message: error.error?.message,
+      })),
+      run_id: result?.run_id,
+    })
+    return
+  }
+
+  res.status(200).json({
+    fulfillment_id: result.fulfillment_id,
+    shipment_id: result.shipment_id,
+    run_id: result.run_id,
+  })
+}
diff --git a/packages/core/core-flows/src/order/workflows/__tests__/create-fulfillment-with-rollback.spec.ts b/packages/core/core-flows/src/order/workflows/__tests__/create-fulfillment-with-rollback.spec.ts
new file mode 100644
index 0000000000..c5f733a66b
--- /dev/null
+++ b/packages/core/core-flows/src/order/workflows/__tests__/create-fulfillment-with-rollback.spec.ts
@@ -0,0 +1,382 @@
+import { describe, expect, it, vi } from "vitest"
+import { FulfillmentWorkflowEvents, OrderWorkflowEvents } from "@medusajs/framework/utils"
+import { createFulfillmentWithRollbackWorkflow } from "../create-fulfillment-with-rollback"
+
+const emittedEvents: { eventName: string; data: Record<string, unknown> }[] = []
+const compensationLog: string[] = []
+
+vi.mock("../../../common", () => ({
+  useQueryGraphStep: vi.fn((input) => {
+    if (input.entity === "order") {
+      return {
+        data: {
+          id: "order_123",
+          status: "pending",
+          currency_code: "usd",
+          shipping_address: {
+            address_1: "100 Test St",
+            city: "New York",
+            country_code: "us",
+            postal_code: "10001",
+          },
+          shipping_methods: [
+            {
+              id: "osm_123",
+              shipping_option_id: "so_123",
+              data: { rate_id: "rate_123" },
+            },
+          ],
+          items: [
+            {
+              id: "orli_123",
+              quantity: 1,
+            },
+          ],
+          fulfillments: [],
+        },
+      }
+    }
+
+    return {
+      id: "so_123",
+      provider_id: "manual_test",
+      service_zone: {
+        fulfillment_set: {
+          location: {
+            id: "sloc_123",
+          },
+        },
+      },
+    }
+  }),
+  emitEventStep: vi.fn((event) => {
+    emittedEvents.push(event)
+  }),
+}))
+
+vi.mock("../../steps", () => ({
+  registerOrderFulfillmentStep: vi.fn((input) => {
+    return { order_id: input.order_id }
+  }),
+  registerOrderShipmentStep: vi.fn((input) => {
+    return { order_id: input.order_id, shipment_id: input.metadata.shipment_id }
+  }),
+}))
+
+vi.mock("../../../fulfillment", () => ({
+  createShipmentWorkflow: {
+    runAsStep: vi.fn(({ input }) => {
+      return {
+        id: "ship_123",
+        fulfillment_id: input.id,
+        labels: input.labels,
+      }
+    }),
+  },
+}))
+
+vi.mock("../../steps/fulfillment-workflow-run", () => ({
+  createFulfillmentWorkflowRunStep: vi.fn((input) => ({
+    id: "fwfr_123",
+    order_id: input.order_id,
+    fulfillment_id: null,
+    shipment_id: null,
+    provider_response: null,
+    status: "pending",
+  })),
+  patchFulfillmentWorkflowRunStep: vi.fn(({ runId, patch }) => ({
+    id: runId,
+    ...patch,
+  })),
+  completeFulfillmentWorkflowRunStep: vi.fn((run) => ({
+    ...run,
+    id: run.id,
+    status: "completed",
+  })),
+}))
+
+vi.mock("../../steps/provider-fulfillment-with-run", () => ({
+  createProviderFulfillmentWithRunStep: vi.fn(({ run }) => ({
+    run,
+    fulfillment: {
+      id: "ful_123",
+      provider_id: "manual_test",
+      data: {
+        external_fulfillment_id: "ext_ful_123",
+      },
+      labels: [
+        {
+          tracking_number: "trk_123",
+          tracking_url: "https://carrier.test/track/trk_123",
+          label_url: "https://carrier.test/label.pdf",
+        },
+      ],
+    },
+    providerResponse: {
+      provider_id: "manual_test",
+      fulfillment_id: "ful_123",
+      external_fulfillment_id: "ext_ful_123",
+      external_shipment_id: "ext_ship_123",
+      tracking_number: "trk_123",
+      tracking_url: "https://carrier.test/track/trk_123",
+      label_url: "https://carrier.test/label.pdf",
+      request_id: "req_123",
+      labels: [
+        {
+          tracking_number: "trk_123",
+          tracking_url: "https://carrier.test/track/trk_123",
+          label_url: "https://carrier.test/label.pdf",
+        },
+      ],
+    },
+  })),
+}))
+
+vi.mock("../../steps/shipment-workflow-events", () => ({
+  emitShipmentWorkflowEventsStep: vi.fn(({ payload }) => {
+    emittedEvents.push({
+      eventName: FulfillmentWorkflowEvents.SHIPMENT_CREATED,
+      data: payload,
+    })
+    return {
+      id: "fwfr_123",
+      status: "events_emitted",
+      shipment_event_payload: payload,
+    }
+  }),
+}))
+
+describe("createFulfillmentWithRollbackWorkflow", () => {
+  it("emits fulfillment and shipment events during the combined workflow", async () => {
+    emittedEvents.splice(0, emittedEvents.length)
+    const workflow = createFulfillmentWithRollbackWorkflow({} as any)
+
+    const { result } = await workflow.run({
+      input: {
+        order_id: "order_123",
+        idempotency_key: "key_123",
+        shipping_option_id: "so_123",
+        items: [
+          {
+            id: "orli_123",
+            quantity: 1,
+          },
+        ],
+        auto_ship: true,
+      },
+    })
+
+    expect(result).toEqual({
+      fulfillment_id: "ful_123",
+      shipment_id: "ship_123",
+      run_id: "fwfr_123",
+    })
+    expect(emittedEvents).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          eventName: OrderWorkflowEvents.FULFILLMENT_CREATED,
+        }),
+        expect.objectContaining({
+          eventName: FulfillmentWorkflowEvents.SHIPMENT_CREATED,
+          data: expect.objectContaining({
+            fulfillment_id: "ful_123",
+            shipment_id: "ship_123",
+            tracking_number: "trk_123",
+          }),
+        }),
+      ])
+    )
+  })
+
+  it("expects rollback after a following step to keep the shipment.created event committed", async () => {
+    emittedEvents.splice(0, emittedEvents.length)
+    compensationLog.splice(0, compensationLog.length)
+    const workflow = createFulfillmentWithRollbackWorkflow({} as any)
+
+    workflow.appendAction("throw-after-shipment-event", createFulfillmentWithRollbackWorkflow.name, {
+      invoke: async () => {
+        throw new Error("analytics write failed")
+      },
+      compensate: async () => {
+        compensationLog.push("throw-step-compensated")
+      },
+    })
+
+    const { errors } = await workflow.run({
+      input: {
+        order_id: "order_123",
+        idempotency_key: "key_rollback",
+        shipping_option_id: "so_123",
+        items: [
+          {
+            id: "orli_123",
+            quantity: 1,
+          },
+        ],
+        auto_ship: true,
+      },
+      throwOnError: false,
+    })
+
+    expect(errors[0].error.message).toBe("analytics write failed")
+    expect(emittedEvents).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          eventName: FulfillmentWorkflowEvents.SHIPMENT_CREATED,
+          data: expect.objectContaining({
+            fulfillment_id: "ful_123",
+            shipment_id: "ship_123",
+          }),
+        }),
+      ])
+    )
+    expect(emittedEvents).not.toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          eventName: "shipment.canceled",
+        }),
+      ])
+    )
+  })
+})
diff --git a/packages/core/core-flows/src/order/steps/__tests__/provider-fulfillment-with-run.spec.ts b/packages/core/core-flows/src/order/steps/__tests__/provider-fulfillment-with-run.spec.ts
new file mode 100644
index 0000000000..ad7e988ef2
--- /dev/null
+++ b/packages/core/core-flows/src/order/steps/__tests__/provider-fulfillment-with-run.spec.ts
@@ -0,0 +1,236 @@
+import { describe, expect, it, vi } from "vitest"
+import { createProviderFulfillmentWithRunStep } from "../provider-fulfillment-with-run"
+
+const cancelFulfillment = vi.fn()
+const createFulfillment = vi.fn()
+const retrieveFulfillment = vi.fn()
+const patch = vi.fn()
+
+const container = {
+  resolve: vi.fn((key: string) => {
+    if (key === "fulfillment") {
+      return {
+        createFulfillment,
+        cancelFulfillment,
+        retrieveFulfillment,
+      }
+    }
+
+    if (key === "order") {
+      return {
+        manager_: {},
+      }
+    }
+
+    throw new Error(`unknown dependency ${key}`)
+  }),
+}
+
+vi.mock("../../repositories/fulfillment-workflow-run", () => ({
+  resolveFulfillmentWorkflowRunRepository: vi.fn(() => ({
+    patch,
+    appendCompensation: vi.fn(),
+  })),
+}))
+
+describe("createProviderFulfillmentWithRunStep", () => {
+  it("normalizes provider labels into the workflow run provider_response", async () => {
+    createFulfillment.mockResolvedValueOnce({
+      id: "ful_123",
+      provider_id: "manual_test",
+      data: {
+        external_fulfillment_id: "ext_ful_123",
+        external_shipment_id: "ext_ship_123",
+        request_id: "req_123",
+        status: "purchased",
+      },
+      labels: [
+        {
+          tracking_number: "trk_123",
+          tracking_url: "https://carrier.test/track/trk_123",
+          label_url: "https://carrier.test/label.pdf",
+          metadata: {
+            page: 1,
+          },
+        },
+      ],
+    })
+    patch.mockResolvedValueOnce({
+      id: "fwfr_123",
+      status: "creating_provider_fulfillment",
+    })
+    patch.mockResolvedValueOnce({
+      id: "fwfr_123",
+      status: "provider_created",
+      fulfillment_id: "ful_123",
+      provider_response: {
+        fulfillment_id: "ful_123",
+      },
+    })
+
+    const response = await createProviderFulfillmentWithRunStep.invoke(
+      {
+        run: {
+          id: "fwfr_123",
+          provider_response: null,
+        },
+        request: {
+          order_id: "order_123",
+          shipping_option_id: "so_123",
+          provider_id: "manual_test",
+          location_id: "sloc_123",
+          items: [
+            {
+              id: "orli_123",
+              quantity: 1,
+            },
+          ],
+          delivery_address: {
+            address_1: "100 Test St",
+            city: "New York",
+            country_code: "us",
+            postal_code: "10001",
+          },
+        },
+        fulfillment: null,
+      } as any,
+      { container } as any
+    )
+
+    expect(response.output.providerResponse).toMatchObject({
+      fulfillment_id: "ful_123",
+      external_fulfillment_id: "ext_ful_123",
+      external_shipment_id: "ext_ship_123",
+      request_id: "req_123",
+      tracking_number: "trk_123",
+      label_url: "https://carrier.test/label.pdf",
+    })
+  })
+
+  it("resumes from provider_response instead of reconstructing from fulfillment domain state", async () => {
+    retrieveFulfillment.mockResolvedValueOnce({
+      id: "ful_123",
+      provider_id: "manual_test",
+      data: {
+        external_fulfillment_id: "ext_ful_current",
+        external_shipment_id: "ext_ship_current",
+      },
+      labels: [],
+    })
+
+    const response = await createProviderFulfillmentWithRunStep.invoke(
+      {
+        run: {
+          id: "fwfr_123",
+          fulfillment_id: "ful_123",
+          provider_response: {
+            provider_id: "manual_test",
+            fulfillment_id: "ful_123",
+            external_fulfillment_id: "ext_ful_stale",
+            external_shipment_id: "ext_ship_stale",
+            request_id: "req_stale",
+            label_url: "https://carrier.test/stale.pdf",
+          },
+        },
+        request: {
+          order_id: "order_123",
+          shipping_option_id: "so_123",
+          provider_id: "manual_test",
+          location_id: "sloc_123",
+          items: [{ id: "orli_123", quantity: 1 }],
+          delivery_address: {},
+        },
+        fulfillment: null,
+      } as any,
+      { container } as any
+    )
+
+    expect(createFulfillment).not.toHaveBeenCalled()
+    expect(response.output.providerResponse).toMatchObject({
+      external_fulfillment_id: "ext_ful_stale",
+      external_shipment_id: "ext_ship_stale",
+      request_id: "req_stale",
+    })
+  })
+
+  it("compensates provider fulfillment using the provider_response fulfillment id", async () => {
+    await createProviderFulfillmentWithRunStep.compensate(
+      {
+        provider_id: "manual_test",
+        fulfillment_id: "ful_123",
+        external_fulfillment_id: "ext_ful_123",
+      },
+      { container } as any
+    )
+
+    expect(cancelFulfillment).toHaveBeenCalledWith("ful_123")
+  })
+})
diff --git a/docs/operations/fulfillment-workflow-rollback.md b/docs/operations/fulfillment-workflow-rollback.md
new file mode 100644
index 0000000000..b617782bd3
--- /dev/null
+++ b/docs/operations/fulfillment-workflow-rollback.md
@@ -0,0 +1,160 @@
+# Fulfillment Workflow Rollback
+
+The combined fulfillment workflow creates a provider fulfillment, registers the
+fulfillment on the order, creates a shipment, emits shipment events, and records
+a workflow run row.
+
+## Recovery model
+
+Workflow compensation runs in reverse order. The combined workflow relies on
+that ordering to undo internal state:
+
+1. mark the workflow run as compensating,
+2. revert shipment registration with the order module,
+3. restore fulfillment shipped state,
+4. cancel the provider fulfillment,
+5. keep the workflow run as audit evidence.
+
+The shipment event is not removed from the event bus. Once `shipment.created` is
+emitted, downstream consumers may already have received it. The rollback logs a
+`skip_event_compensation` entry and leaves event consumers to reconcile from the
+current API state.
+
+## Provider response
+
+The workflow stores the provider response in `order_fulfillment_workflow_runs`.
+On retry, if `provider_response` exists, the workflow treats it as the source of
+truth and does not call the provider again.
+
+The stored response includes:
+
+- provider id,
+- fulfillment id,
+- external fulfillment id,
+- external shipment id,
+- tracking number,
+- label URL,
+- rate id,
+- request id,
+- raw provider payload.
+
+This lets operators inspect the provider response even when later order steps
+fail.
+
+## Manual rollback check
+
+When a workflow fails after shipment event emission, check:
+
+```sql
+SELECT id, order_id, fulfillment_id, shipment_id, status, provider_response, compensation_log
+FROM order_fulfillment_workflow_runs
+WHERE id = '<run-id>';
+```
+
+Then inspect the fulfillment:
+
+```sql
+SELECT id, data, labels, shipped_at, canceled_at
+FROM fulfillment
+WHERE id = '<fulfillment-id>';
+```
+
+Finally check downstream delivery systems for the `shipment.created` event.
+There is no compensating event. Downstream systems should query the order API if
+they need the final state after a failed workflow.
+
+## Retry guidance
+
+Retries use the same `idempotency_key`. If the run has `provider_response`, the
+workflow resumes from that response.
+
+If the provider response is stale, clear it manually before retrying:
+
+```sql
+UPDATE order_fulfillment_workflow_runs
+SET provider_response = null,
+    status = 'pending',
+    updated_at = now()
+WHERE id = '<run-id>';
+```
+
+Only clear the response if the provider fulfillment is known to be absent or
+fully canceled.
+
+## Weekly review
+
+During fulfillment operations review, record:
+
+- failed combined fulfillment workflows,
+- workflows that failed after `shipment.created`,
+- provider cancellations attempted,
+- provider cancellations failed,
+- retries resumed from stored provider response,
+- manual provider response clears.
+
+## Failure timeline
+
+When investigating a failed run, reconstruct the timeline in this order:
+
+1. workflow run row was created,
+2. provider fulfillment was requested,
+3. provider response was stored,
+4. order fulfillment was registered,
+5. fulfillment was marked shipped,
+6. order shipment was registered,
+7. shipment event was emitted,
+8. later step failed,
+9. workflow compensation started.
+
+The important boundary is step 7. After that point, external systems may have
+consumed the shipment event even if compensation later restores local order
+state.
+
+## Support questions
+
+Ask support for:
+
+- order id,
+- fulfillment id,
+- workflow run id,
+- provider external fulfillment id,
+- provider external shipment id,
+- whether the customer received a shipment notification,
+- whether the warehouse received the shipment event,
+- whether the provider label was voided manually.
+
+## Provider cleanup
+
+If provider cancellation failed, use the provider response to find the external
+object, but verify it against the fulfillment row before taking action. The
+workflow run may have an older response than the fulfillment's latest data.
+
+```sql
+SELECT id, data, labels, canceled_at
+FROM fulfillment
+WHERE id = '<fulfillment-id>';
+```
+
+Compare that to:
+
+```sql
+SELECT provider_response
+FROM order_fulfillment_workflow_runs
+WHERE id = '<run-id>';
+```
+
+If the two disagree, prefer the fulfillment row and provider dashboard over the
+workflow run response.
+
+## Event cleanup
+
+There is no automatic cleanup event. If downstream systems need correction,
+operators must coordinate manually with the integration owner and provide:
+
+- original shipment event payload,
+- workflow run id,
+- rollback timestamp,
+- current order status,
+- current fulfillment status,
+- provider cancellation status.
```
```

## Intended Flaws

### Flaw 1: Rollback skips compensating events for already committed shipment side effects

The PR assumes reverse workflow compensation is enough. It reverts local order and fulfillment state but explicitly treats `shipment.created` as already committed and emits no compensating event for external consumers.

Relevant line references:

- `packages/core/core-flows/src/order/steps/shipment-workflow-events.ts:12-34` emits `FulfillmentWorkflowEvents.SHIPMENT_CREATED` after shipment registration.
- `packages/core/core-flows/src/order/steps/shipment-workflow-events.ts:35-52` compensates that step by writing `skip_event_compensation` instead of emitting a shipment rollback/cancellation event.
- `packages/core/core-flows/src/order/workflows/create-fulfillment-with-rollback.ts:202-222` registers the shipment, patches run state, and emits shipment events together, so a later failure can leave the event committed while internal state is reverted.
- `packages/core/core-flows/src/order/workflows/__tests__/create-fulfillment-with-rollback.spec.ts:191-242` asserts that rollback keeps `shipment.created` committed and does not emit `shipment.canceled`.
- `docs/operations/fulfillment-workflow-rollback.md:8-24` documents that shipment events are not compensated.

Why this is a real flaw:

Shipment events are external side effects. Email, ERP, warehouse, analytics, and webhook consumers may act as soon as `shipment.created` is delivered. Reverting local order versions or canceling the provider fulfillment does not tell those consumers that the shipment is no longer valid. The system becomes internally corrected but externally inconsistent. That is the exact distinction a reviewer needs to make in workflow code: reverse compensation only undoes what each compensating step actually does.

Better implementation direction:

Model event emission as a durable domain side effect with its own compensation. If a workflow can fail after `shipment.created`, emit a causally linked `shipment.canceled`, `shipment.reverted`, or `fulfillment.rollback_requested` event after rollback succeeds. Include the original event id, run id, fulfillment id, shipment id, and reason. Better still, move event emission after all non-compensatable steps or use an outbox state machine where events become publishable only once the workflow reaches a committed state.

### Flaw 2: The workflow stores transient provider response as the source of truth for retries and compensation

The PR persists the raw provider response in a workflow-run table and later resumes from that JSON blob. It treats provider response as authoritative instead of using Medusa-owned fulfillment domain state that is persisted and normalized for cancellation, labels, and recovery.

Relevant line references:

- `packages/core/core-flows/src/order/types/fulfillment-workflow-run.ts:43-78` defines provider response fields such as request id, rate id, label URL, provider status, and raw payload as workflow-run state.
- `packages/core/core-flows/src/order/steps/provider-fulfillment-with-run.ts:21-43` resumes from `input.run.provider_response` and returns that stale blob without reconstructing state from the fulfillment domain row.
- `packages/core/core-flows/src/order/steps/provider-fulfillment-with-run.ts:45-86` creates the provider fulfillment and saves normalized provider response to the run as the recoverable state.
- `packages/core/core-flows/src/order/steps/__tests__/provider-fulfillment-with-run.spec.ts:110-153` asserts that retry uses stale `provider_response` even when the current fulfillment row contains different external ids.
- `docs/operations/fulfillment-workflow-rollback.md:26-44` documents the workflow run's provider response as retry source of truth.

Why this is a real flaw:

Provider responses are integration artifacts, not the domain source of truth. They can contain one-time label URLs, request ids, quoted rate ids, transient statuses, and raw payloads that are useful for audit but unsafe for recovery. Medusa's fulfillment module already persists provider data and labels onto the fulfillment because `cancelFulfillment(...)` later depends on `fulfillment.data`. If retry/compensation uses a stale workflow JSON blob, it can cancel the wrong external object, skip a needed provider call, lose labels created after the response was stored, or become unrecoverable when the blob is partial.

Better implementation direction:

Normalize provider output into domain-owned fulfillment state before downstream workflow steps run. Store stable external identifiers, labels, and idempotency keys on the fulfillment or a provider-operation table with versioning. Use the workflow-run row for audit and correlation, not source-of-truth recovery. On retry, reload the fulfillment and provider operation state, compare idempotency keys, and resume from durable domain state. Compensation should call provider cancellation using the same stable state that normal cancellation uses.

## Hints

### Flaw 1 Hints

1. What external systems can act on `shipment.created` before compensation starts?
2. Which compensation step tells those systems that the shipment was rolled back?
3. Does reverting the order module version undo an event that has already left the process?

### Flaw 2 Hints

1. What does Medusa's fulfillment provider contract say about where provider data is stored?
2. On retry, does the workflow read current fulfillment state or reuse the old JSON response?
3. Which fields in the provider response are stable identifiers versus transient response details?

## Expected Answer

A strong review should say that the product-level change is a combined fulfillment/shipment workflow with rollback, but the implementation confuses workflow compensation mechanics with complete business compensation.

For flaw 1, the learner should identify that `shipment.created` is emitted and then explicitly skipped during compensation. The impact is external inconsistency: downstream systems can ship, notify, invoice, or sync a shipment that Medusa later reverted internally. The fix is to either delay event publication until the workflow is committed or emit a compensating event with causality after rollback.

For flaw 2, the learner should identify that the workflow stores raw provider response JSON as retry and compensation source of truth. The impact is stale or partial provider state, failed cancellations, duplicate provider fulfillments, lost labels, and unrecoverable manual cleanup. The fix is domain-owned durable provider operation state and fulfillment data, with workflow-run rows used only for audit/correlation.

The best answers should connect the flaws to Medusa's existing contracts: workflow compensation runs in reverse but each step must compensate its own side effects, provider cancellation depends on persisted fulfillment data, order version revert is local state, and emitted events are durable side effects.

## Expert Debrief

At the product level, this PR tries to make fulfillment safer by bundling creation, shipment, and rollback. The trap is that a workflow framework can only call compensating handlers. It cannot magically undo effects that handlers choose not to compensate.

The first contract is event truth. If Medusa emits `shipment.created`, downstream systems are allowed to believe a shipment was created. If the workflow later fails and reverses internal state, the outside world needs a new fact. "We reverted a row" is not a message to the warehouse. This PR even documents the skip, which is a sign the implementation noticed the side effect but did not design the compensation.

The second contract is ownership of provider state. A provider response is evidence of what happened at an integration boundary. It is not the durable model. Durable recovery should be based on stable identifiers persisted in Medusa's fulfillment state or a provider-operation record. Otherwise retries depend on a stale snapshot of a response that may not match the current fulfillment row.

The failure modes are concrete:

- A customer receives a shipment notification from a committed event even though the workflow later failed.
- An ERP records a shipment with no corresponding compensating cancellation event.
- A retry skips provider creation because `provider_response` exists, even though the fulfillment row was corrected.
- Provider cancellation uses stale external ids or lacks the provider data normal cancellation expects.
- Operators have to clear JSON blobs manually to recover retries.

The reviewer thought process should be: first list every side effect that crosses a boundary: provider call, order version, inventory update, event emission, webhook/email/ERP consumption. Then ask how each side effect is compensated. Second, identify source of truth. Audit logs and workflow run rows are useful, but recovery must come from the domain model that normal operations also use.

The better implementation is a state machine around fulfillment provider operations and shipment event publication. Persist provider operation state with idempotency keys and stable external ids. Publish shipment events only after the workflow reaches a committed point, or publish compensating events when rollback happens after publication. Keep workflow runs as traceability, not as the place production state is reconstructed from.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: skipped compensation for committed shipment events and use of transient provider response as recovery source of truth. It explains external inconsistency, stale provider state, failed cancellations, duplicate fulfillments, and suggests compensating events/outbox commit plus domain-owned provider operation state.
- `partial`: The answer finds one flaw completely and mentions either event inconsistency or provider response fragility without tying it to workflow compensation and Medusa fulfillment contracts.
- `miss`: The answer focuses on route shape, table naming, missing type validation, or generic rollback concerns while missing committed event side effects and provider-state ownership.
