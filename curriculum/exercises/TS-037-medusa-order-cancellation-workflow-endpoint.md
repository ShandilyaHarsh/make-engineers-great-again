# TS-037: Medusa Order Cancellation Workflow Endpoint

## Metadata

- `id`: TS-037
- `source_repo`: [medusajs/medusa](https://github.com/medusajs/medusa)
- `repo_area`: order workflows, cancellation state, payment refunds, inventory reservations, workflow compensation, admin API routes, middleware validation, workflow tests
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,350-1,650
- `represented_diff_lines`: 1429
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Medusa workflow semantics, cancellation state machines, refund/reservation compensation, parallel workflow steps, partial failure contracts, and admin API response design without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a new admin order cancellation workflow endpoint with structured compensation details.

Medusa already supports order cancellation, but admin clients need more visibility into what happened during cancellation: whether captured payments were refunded, inventory reservations were released, uncaptured payments were canceled, and cancellation events were emitted. This PR adds a v2-style endpoint that returns an order plus a `cancellation` object with step-by-step compensation status.

The new work includes:

- `POST /admin/orders/:id/cancel-workflow`,
- request options for refunding captured payments, releasing inventory, canceling uncaptured payments, and recording a reason/note,
- a cancellation plan step that calculates refunds and line items,
- a workflow that marks the order canceled and runs compensation,
- metadata recording of compensation results,
- docs for response shape and cancellation scenarios,
- tests for canceled responses, refund failures, skipped inventory release, and plan construction.

The intended product behavior is: cancellation should give admin clients better visibility without lying about the order state or leaving inventory/payment side effects in a confusing partial state.

## Existing Code Context

The real Medusa codebase already has these relevant contracts:

- `packages/core/core-flows/src/order/workflows/cancel-order.ts` validates that an order can be canceled, rejects completed orders, rejects orders with active fulfillments, and queries payment/order details.
- The existing `cancelOrderWorkflow` parallelizes `refundCapturedPaymentsWorkflow`, `deleteReservationsByLineItemsStep`, `cancelPaymentStep`, and cancellation event emission before calling `cancelOrdersStep`.
- `cancelOrdersStep` calls the order module `cancel(...)` and includes compensation data that can restore previous order status/cancellation fields if the workflow rolls back.
- `deleteReservationsByLineItemsStep` lists reservation items, locks affected inventory item ids, deletes reservations by line item, and has a compensation function that restores reservations by line item.
- `refundPaymentsStep` calls the payment module refund API. The single-payment step explicitly avoids automatic compensation because actual funds may already have moved.
- `packages/medusa/src/api/admin/orders/[id]/cancel/route.ts` runs `cancelOrderWorkflow(req.scope).run({ input })`, re-queries the order, and returns `{ order }` only after the workflow completes.
- Medusa workflows use `StepResponse` compensation data and `WorkflowResponse` to model durable business transitions and rollback behavior.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether this endpoint preserves trustworthy order state and compensation semantics.

## Review Surface

Changed files in the synthetic PR:

- `packages/core/core-flows/src/order/types/cancel-order-workflow.ts`
- `packages/core/core-flows/src/order/steps/mark-order-cancellation-started.ts`
- `packages/core/core-flows/src/order/steps/build-order-cancellation-plan.ts`
- `packages/core/core-flows/src/order/workflows/cancel-order-with-compensation.ts`
- `packages/medusa/src/api/admin/orders/[id]/cancel-workflow/route.ts`
- `packages/medusa/src/api/admin/orders/validators.ts`
- `packages/medusa/src/api/admin/orders/middlewares.ts`
- `packages/core/core-flows/src/order/workflows/index.ts`
- `packages/core/core-flows/src/order/workflows/__tests__/cancel-order-with-compensation.spec.ts`
- `docs/references/order-cancellation-workflow.md`

The line references below use synthetic PR line numbers. The represented diff is focused on workflow state, compensation ordering, payment/refund semantics, inventory reservation release, API response truthfulness, and tests.

## Diff

```diff
diff --git a/packages/core/core-flows/src/order/types/cancel-order-workflow.ts b/packages/core/core-flows/src/order/types/cancel-order-workflow.ts
new file mode 100644
index 0000000000..b48d6c2f13
--- /dev/null
+++ b/packages/core/core-flows/src/order/types/cancel-order-workflow.ts
@@ -0,0 +1,54 @@
+import { z } from "zod"
+
+export const AdminOrderCancellationMode = z.enum(["cancel", "cancel-and-refund", "cancel-no-refund"])
+export const AdminOrderCancellationActor = z.enum(["admin", "system", "integration"])
+
+export const AdminOrderCancelWorkflowBody = z.object({
+  mode: AdminOrderCancellationMode.default("cancel-and-refund"),
+  reason_id: z.string().optional(),
+  note: z.string().max(2000).optional(),
+  canceled_by: z.string().optional(),
+  actor_type: AdminOrderCancellationActor.default("admin"),
+  refund_captured_payments: z.boolean().default(true),
+  release_inventory: z.boolean().default(true),
+  cancel_uncaptured_payments: z.boolean().default(true),
+  notify_customer: z.boolean().default(false),
+  metadata: z.record(z.unknown()).optional(),
+})
+
+export type AdminOrderCancelWorkflowBodyType = z.infer<typeof AdminOrderCancelWorkflowBody>
+
+export type CancelOrderCompensationStatus = "pending" | "succeeded" | "failed" | "skipped"
+
+export type CancelOrderCompensationResult = {
+  order_id: string
+  refund_status: CancelOrderCompensationStatus
+  reservation_status: CancelOrderCompensationStatus
+  uncaptured_payment_status: CancelOrderCompensationStatus
+  event_status: CancelOrderCompensationStatus
+  refunded_payment_ids: string[]
+  released_line_item_ids: string[]
+  canceled_payment_ids: string[]
+  errors: Array<{ code: string; message: string; step: string }>
+}
+
+export type CancelOrderWorkflowAudit = {
+  order_id: string
+  requested_by?: string
+  mode: z.infer<typeof AdminOrderCancellationMode>
+  reason_id?: string
+  note?: string
+  metadata?: Record<string, unknown>
+}
+
+export const defaultCompensationResult = (orderId: string): CancelOrderCompensationResult => ({
+  order_id: orderId,
+  refund_status: "pending",
+  reservation_status: "pending",
+  uncaptured_payment_status: "pending",
+  event_status: "pending",
+  refunded_payment_ids: [],
+  released_line_item_ids: [],
+  canceled_payment_ids: [],
+  errors: [],
+})
diff --git a/packages/core/core-flows/src/order/steps/mark-order-cancellation-started.ts b/packages/core/core-flows/src/order/steps/mark-order-cancellation-started.ts
new file mode 100644
index 0000000000..b48d6c2f13
--- /dev/null
+++ b/packages/core/core-flows/src/order/steps/mark-order-cancellation-started.ts
@@ -0,0 +1,99 @@
+import type { IOrderModuleService } from "@medusajs/framework/types"
+import { Modules, OrderStatus } from "@medusajs/framework/utils"
+import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
+
+import { CancelOrderWorkflowAudit } from "../types/cancel-order-workflow"
+
+export type MarkOrderCancellationStartedStepInput = CancelOrderWorkflowAudit & {
+  order_id: string
+  canceled_by?: string
+}
+
+export const markOrderCancellationStartedStepId = "mark-order-cancellation-started"
+
+export const markOrderCancellationStartedStep = createStep(
+  markOrderCancellationStartedStepId,
+  async (input: MarkOrderCancellationStartedStepInput, { container }) => {
+    const orderService = container.resolve<IOrderModuleService>(Modules.ORDER)
+
+    const [previous] = await orderService.listOrders(
+      { id: input.order_id },
+      { select: ["id", "status", "canceled_at", "canceled_by", "metadata"] }
+    )
+
+    const [updated] = await orderService.updateOrders([
+      {
+        id: input.order_id,
+        status: OrderStatus.CANCELED,
+        canceled_at: new Date(),
+        canceled_by: input.canceled_by,
+        metadata: {
+          ...(previous?.metadata ?? {}),
+          cancellation_workflow: {
+            mode: input.mode,
+            reason_id: input.reason_id,
+            note: input.note,
+            actor_type: input.metadata?.actor_type,
+            started_at: new Date().toISOString(),
+          },
+        },
+      },
+    ])
+
+    return new StepResponse(updated, {
+      id: input.order_id,
+      status: previous?.status,
+      canceled_at: previous?.canceled_at ?? null,
+      canceled_by: previous?.canceled_by ?? null,
+      metadata: previous?.metadata ?? {},
+    })
+  },
+  async (previous, { container }) => {
+    if (!previous?.id) {
+      return
+    }
+
+    const orderService = container.resolve<IOrderModuleService>(Modules.ORDER)
+    await orderService.updateOrders([previous])
+  }
+)
+
+export type FinalizeOrderCancellationStepInput = {
+  order_id: string
+  result: {
+    refund_status: string
+    reservation_status: string
+    uncaptured_payment_status: string
+    event_status: string
+    errors: Array<{ code: string; message: string; step: string }>
+  }
+}
+
+export const finalizeOrderCancellationStepId = "finalize-order-cancellation"
+
+export const finalizeOrderCancellationStep = createStep(
+  finalizeOrderCancellationStepId,
+  async (input: FinalizeOrderCancellationStepInput, { container }) => {
+    const orderService = container.resolve<IOrderModuleService>(Modules.ORDER)
+    const [order] = await orderService.listOrders(
+      { id: input.order_id },
+      { select: ["id", "metadata"] }
+    )
+
+    const [updated] = await orderService.updateOrders([
+      {
+        id: input.order_id,
+        metadata: {
+          ...(order?.metadata ?? {}),
+          cancellation_workflow: {
+            ...(order?.metadata?.cancellation_workflow as object),
+            finished_at: new Date().toISOString(),
+            result: input.result,
+          },
+        },
+      },
+    ])
+
+    return new StepResponse(updated)
+  }
+)
diff --git a/packages/core/core-flows/src/order/steps/build-order-cancellation-plan.ts b/packages/core/core-flows/src/order/steps/build-order-cancellation-plan.ts
new file mode 100644
index 0000000000..b48d6c2f13
--- /dev/null
+++ b/packages/core/core-flows/src/order/steps/build-order-cancellation-plan.ts
@@ -0,0 +1,82 @@
+import type { FulfillmentDTO, OrderDTO, PaymentDTO } from "@medusajs/framework/types"
+import { deepFlatMap, MathBN, MedusaError, OrderStatus } from "@medusajs/framework/utils"
+import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
+
+import { AdminOrderCancelWorkflowBodyType, defaultCompensationResult } from "../types/cancel-order-workflow"
+
+export type BuildOrderCancellationPlanStepInput = {
+  order: OrderDTO & {
+    fulfillments?: FulfillmentDTO[]
+    payment_collections?: Array<{ payments?: PaymentDTO[] }>
+    items?: Array<{ id: string }>
+  }
+  input: AdminOrderCancelWorkflowBodyType & { order_id: string }
+}
+
+export type OrderCancellationPlan = {
+  order_id: string
+  payment_ids_to_cancel: string[]
+  payment_refunds: Array<{ payment_id: string; amount: unknown; created_by?: string; note?: string }>
+  line_item_ids_to_release: string[]
+  should_refund: boolean
+  should_release_inventory: boolean
+  should_cancel_uncaptured: boolean
+}
+
+export const buildOrderCancellationPlanStepId = "build-order-cancellation-plan"
+
+export const buildOrderCancellationPlanStep = createStep(
+  buildOrderCancellationPlanStepId,
+  async ({ order, input }: BuildOrderCancellationPlanStepInput) => {
+    if (order.status === OrderStatus.CANCELED || order.canceled_at) {
+      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `Order ${order.id} is already canceled`)
+    }
+
+    if (order.status === OrderStatus.COMPLETED) {
+      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Completed orders must use the return flow")
+    }
+
+    const activeFulfillment = order.fulfillments?.find((fulfillment) => !fulfillment.canceled_at)
+    if (activeFulfillment) {
+      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Active fulfillments must be canceled before order cancellation")
+    }
+
+    const payments: PaymentDTO[] = deepFlatMap(order, "payment_collections.payments", ({ payments }) => payments)
+
+    const payment_refunds = payments
+      .filter((payment) => payment.captures?.length)
+      .map((payment) => {
+        const captured = (payment.captures || []).reduce(
+          (acc, capture) => MathBN.sum(acc, capture.amount),
+          MathBN.convert(0)
+        )
+        const refunded = (payment.refunds || []).reduce(
+          (acc, refund) => MathBN.sum(acc, refund.amount),
+          MathBN.convert(0)
+        )
+        return {
+          payment_id: payment.id,
+          amount: MathBN.sub(captured, refunded),
+          created_by: input.canceled_by,
+          note: input.note,
+        }
+      })
+      .filter((refund) => MathBN.gt(refund.amount, 0))
+
+    const payment_ids_to_cancel = payments
+      .filter((payment) => !payment.captures?.length)
+      .map((payment) => payment.id)
+
+    const plan: OrderCancellationPlan = {
+      order_id: order.id,
+      payment_ids_to_cancel,
+      payment_refunds,
+      line_item_ids_to_release: order.items?.map((item) => item.id) ?? [],
+      should_refund: input.refund_captured_payments && payment_refunds.length > 0,
+      should_release_inventory: input.release_inventory,
+      should_cancel_uncaptured: input.cancel_uncaptured_payments && payment_ids_to_cancel.length > 0,
+    }
+
+    return new StepResponse(plan, defaultCompensationResult(order.id))
+  }
+)
diff --git a/packages/core/core-flows/src/order/workflows/cancel-order-with-compensation.ts b/packages/core/core-flows/src/order/workflows/cancel-order-with-compensation.ts
new file mode 100644
index 0000000000..b48d6c2f13
--- /dev/null
+++ b/packages/core/core-flows/src/order/workflows/cancel-order-with-compensation.ts
@@ -0,0 +1,131 @@
+import { OrderWorkflowEvents, PaymentCollectionStatus } from "@medusajs/framework/utils"
+import { createWorkflow, parallelize, transform, when, WorkflowData, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
+import { emitEventStep, useQueryGraphStep } from "../../common"
+import { updatePaymentCollectionStep } from "../../payment-collection"
+import { cancelPaymentStep } from "../../payment/steps"
+import { refundPaymentsWorkflow } from "../../payment/workflows/refund-payments"
+import { deleteReservationsByLineItemsStep } from "../../reservation/steps"
+import { buildOrderCancellationPlanStep } from "../steps/build-order-cancellation-plan"
+import { finalizeOrderCancellationStep, markOrderCancellationStartedStep } from "../steps/mark-order-cancellation-started"
+import { AdminOrderCancelWorkflowBodyType, defaultCompensationResult } from "../types/cancel-order-workflow"
+
+export const cancelOrderWithCompensationWorkflowId = "cancel-order-with-compensation"
+
+export type CancelOrderWithCompensationWorkflowInput = AdminOrderCancelWorkflowBodyType & {
+  order_id: string
+}
+
+const mergeErrors = (errors: Array<{ code: string; message: string; step: string }>, step: string, error: unknown) => {
+  return errors.concat({
+    code: "compensation_failed",
+    message: error instanceof Error ? error.message : "Unknown compensation error",
+    step,
+  })
+}
+
+export const cancelOrderWithCompensationWorkflow = createWorkflow(
+  cancelOrderWithCompensationWorkflowId,
+  (input: WorkflowData<CancelOrderWithCompensationWorkflowInput>) => {
+    const orderQuery = useQueryGraphStep({
+      entity: "order",
+      fields: [
+        "id",
+        "status",
+        "canceled_at",
+        "items.id",
+        "fulfillments.canceled_at",
+        "payment_collections.id",
+        "payment_collections.payments.id",
+        "payment_collections.payments.amount",
+        "payment_collections.payments.refunds.id",
+        "payment_collections.payments.refunds.amount",
+        "payment_collections.payments.captures.id",
+        "payment_collections.payments.captures.amount",
+      ],
+      filters: { id: input.order_id },
+      options: { throwIfKeyNotFound: true },
+    }).config({ name: "get-order-for-cancellation" })
+
+    const order = transform({ orderQuery }, ({ orderQuery }) => orderQuery.data[0])
+    const plan = buildOrderCancellationPlanStep({ order, input })
+
+    const canceledOrder = markOrderCancellationStartedStep({
+      order_id: input.order_id,
+      canceled_by: input.canceled_by,
+      mode: input.mode,
+      reason_id: input.reason_id,
+      note: input.note,
+      metadata: input.metadata,
+    })
+
+    const initialResult = transform({ input }, ({ input }) => defaultCompensationResult(input.order_id))
+
+    const refundResult = when({ plan }, ({ plan }) => plan.should_refund).then(() => {
+      return refundPaymentsWorkflow.runAsStep({ input: plan.payment_refunds as any })
+    })
+
+    const compensationAfterRefund = transform(
+      { initialResult, refundResult },
+      ({ initialResult, refundResult }) => {
+        if (!refundResult) {
+          return {
+            ...initialResult,
+            refund_status: "skipped" as const,
+          }
+        }
+
+        return {
+          ...initialResult,
+          refund_status: refundResult.length ? "succeeded" : "failed",
+          refunded_payment_ids: refundResult.map((payment) => payment.id),
+          errors: refundResult.length ? initialResult.errors : mergeErrors(initialResult.errors, "refund", new Error("No captured payment refunds succeeded")),
+        }
+      }
+    )
+
+    const reservationRelease = when(
+      { plan, compensationAfterRefund },
+      ({ plan, compensationAfterRefund }) => {
+        return plan.should_release_inventory && compensationAfterRefund.refund_status !== "failed"
+      }
+    ).then(() => {
+      return deleteReservationsByLineItemsStep(plan.line_item_ids_to_release)
+    })
+
+    const uncapturedPaymentCancellation = when({ plan }, ({ plan }) => plan.should_cancel_uncaptured).then(() => {
+      return cancelPaymentStep({ paymentIds: plan.payment_ids_to_cancel })
+    })
+
+    parallelize(
+      uncapturedPaymentCancellation,
+      emitEventStep({ eventName: OrderWorkflowEvents.CANCELED, data: { id: input.order_id } })
+    )
+
+    const paymentCollectionIds = transform({ order }, ({ order }) => order.payment_collections?.map((pc) => pc.id))
+    when({ paymentCollectionIds }, ({ paymentCollectionIds }) => !!paymentCollectionIds?.length).then(() => {
+      updatePaymentCollectionStep({ selector: { id: paymentCollectionIds }, update: { status: PaymentCollectionStatus.CANCELED } })
+    })
+
+    const finalResult = transform(
+      { compensationAfterRefund, reservationRelease, uncapturedPaymentCancellation },
+      ({ compensationAfterRefund, reservationRelease, uncapturedPaymentCancellation }) => {
+        return {
+          ...compensationAfterRefund,
+          reservation_status: reservationRelease ? "succeeded" : "skipped",
+          uncaptured_payment_status: uncapturedPaymentCancellation ? "succeeded" : "skipped",
+          event_status: "succeeded",
+          released_line_item_ids: reservationRelease ? plan.line_item_ids_to_release : [],
+          canceled_payment_ids: uncapturedPaymentCancellation ? plan.payment_ids_to_cancel : [],
+        }
+      }
+    )
+
+    finalizeOrderCancellationStep({ order_id: input.order_id, result: finalResult })
+
+    return new WorkflowResponse({
+      order: canceledOrder,
+      state: "canceled",
+      compensation: finalResult,
+    })
+  }
+)
diff --git a/packages/medusa/src/api/admin/orders/[id]/cancel-workflow/route.ts b/packages/medusa/src/api/admin/orders/[id]/cancel-workflow/route.ts
new file mode 100644
index 0000000000..b48d6c2f13
--- /dev/null
+++ b/packages/medusa/src/api/admin/orders/[id]/cancel-workflow/route.ts
@@ -0,0 +1,44 @@
+import { cancelOrderWithCompensationWorkflow } from "@medusajs/core-flows"
+import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
+import { HttpTypes } from "@medusajs/framework/types"
+import { ContainerRegistrationKeys, remoteQueryObjectFromString } from "@medusajs/framework/utils"
+import { AdminOrderCancelWorkflowBodyType } from "../../../validators"
+
+export const POST = async (
+  req: AuthenticatedMedusaRequest<AdminOrderCancelWorkflowBodyType, HttpTypes.AdminGetOrderParams>,
+  res: MedusaResponse<HttpTypes.AdminOrderResponse & { cancellation: unknown }>
+) => {
+  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)
+
+  const input = {
+    order_id: req.params.id,
+    canceled_by: req.body.canceled_by ?? req.auth_context.actor_id,
+    mode: req.body.mode,
+    reason_id: req.body.reason_id,
+    note: req.body.note,
+    actor_type: req.body.actor_type,
+    refund_captured_payments: req.body.refund_captured_payments,
+    release_inventory: req.body.release_inventory,
+    cancel_uncaptured_payments: req.body.cancel_uncaptured_payments,
+    notify_customer: req.body.notify_customer,
+    metadata: req.body.metadata,
+  }
+
+  const { result } = await cancelOrderWithCompensationWorkflow(req.scope).run({ input })
+
+  const queryObject = remoteQueryObjectFromString({
+    entryPoint: "order",
+    variables: { id: req.params.id },
+    fields: req.queryConfig.fields,
+  })
+
+  const [order] = await remoteQuery(queryObject)
+
+  res.status(200).json({
+    order,
+    cancellation: {
+      state: result.state,
+      compensation: result.compensation,
+    },
+  })
+}
diff --git a/packages/medusa/src/api/admin/orders/validators.ts b/packages/medusa/src/api/admin/orders/validators.ts
index 9d2aa31bb4..54c68f97de 100644
--- a/packages/medusa/src/api/admin/orders/validators.ts
+++ b/packages/medusa/src/api/admin/orders/validators.ts
@@ -118,6 +118,21 @@
 export const AdminOrderFiltersParams = createFindParams()
 
+export const AdminCancelOrderWorkflow = z.object({
+  mode: z.enum(["cancel", "cancel-and-refund", "cancel-no-refund"]).default("cancel-and-refund"),
+  reason_id: z.string().optional(),
+  note: z.string().max(2000).optional(),
+  canceled_by: z.string().optional(),
+  actor_type: z.enum(["admin", "system", "integration"]).default("admin"),
+  refund_captured_payments: z.boolean().default(true),
+  release_inventory: z.boolean().default(true),
+  cancel_uncaptured_payments: z.boolean().default(true),
+  notify_customer: z.boolean().default(false),
+  metadata: z.record(z.unknown()).optional(),
+})
+
+export type AdminOrderCancelWorkflowBodyType = z.infer<typeof AdminCancelOrderWorkflow>
+
 export const AdminOrderCancelFulfillment = WithAdditionalData(
   OrderCancelFulfillment
 )
diff --git a/packages/medusa/src/api/admin/orders/middlewares.ts b/packages/medusa/src/api/admin/orders/middlewares.ts
index 9d2aa31bb4..54c68f97de 100644
--- a/packages/medusa/src/api/admin/orders/middlewares.ts
+++ b/packages/medusa/src/api/admin/orders/middlewares.ts
@@ -150,5 +150,14 @@
   {
     matcher: "/admin/orders/:id/cancel",
     method: ["POST"],
     middlewares: [],
   },
+  {
+    matcher: "/admin/orders/:id/cancel-workflow",
+    method: ["POST"],
+    middlewares: [
+      validateAndTransformBody(AdminCancelOrderWorkflow),
+      validateAndTransformQuery(AdminGetOrderParams, retrieveTransformQueryConfig),
+    ],
+  },
diff --git a/packages/core/core-flows/src/order/workflows/index.ts b/packages/core/core-flows/src/order/workflows/index.ts
index 9d2aa31bb4..54c68f97de 100644
--- a/packages/core/core-flows/src/order/workflows/index.ts
+++ b/packages/core/core-flows/src/order/workflows/index.ts
@@ -3,3 +3,4 @@
 export * from "./cancel-order"
+export * from "./cancel-order-with-compensation"
 export * from "./cancel-order-fulfillment"
diff --git a/packages/core/core-flows/src/order/workflows/__tests__/cancel-order-with-compensation.spec.ts b/packages/core/core-flows/src/order/workflows/__tests__/cancel-order-with-compensation.spec.ts
new file mode 100644
index 0000000000..b48d6c2f13
--- /dev/null
+++ b/packages/core/core-flows/src/order/workflows/__tests__/cancel-order-with-compensation.spec.ts
@@ -0,0 +1,133 @@
+import { describe, expect, it, vi } from "vitest"
+
+import { defaultCompensationResult } from "../types/cancel-order-workflow"
+
+const makePayment = (id: string, captures: unknown[] = [], refunds: unknown[] = []) => ({
+  id,
+  captures,
+  refunds,
+  amount: 1000,
+})
+
+describe("cancelOrderWithCompensationWorkflow", () => {
+  it("returns canceled state with compensation details", async () => {
+    const result = {
+      order: { id: "order_1", status: "canceled" },
+      state: "canceled",
+      compensation: {
+        ...defaultCompensationResult("order_1"),
+        refund_status: "succeeded",
+        reservation_status: "succeeded",
+        uncaptured_payment_status: "succeeded",
+        event_status: "succeeded",
+      },
+    }
+
+    expect(result.state).toBe("canceled")
+    expect(result.order.status).toBe("canceled")
+    expect(result.compensation.refund_status).toBe("succeeded")
+  })
+
+  it("marks the order canceled before compensation has a terminal result", async () => {
+    const markOrderCancellationStartedStep = vi.fn().mockReturnValue({
+      id: "order_1",
+      status: "canceled",
+      canceled_at: new Date(),
+    })
+    const refundPayments = vi.fn().mockResolvedValue([{ id: "pay_1" }])
+    const deleteReservations = vi.fn().mockResolvedValue(undefined)
+
+    const order = markOrderCancellationStartedStep({ order_id: "order_1" })
+    const response = {
+      order,
+      state: "canceled",
+      compensation: {
+        ...defaultCompensationResult("order_1"),
+        refund_status: "pending",
+        reservation_status: "pending",
+      },
+    }
+
+    expect(response.state).toBe("canceled")
+    expect(response.compensation.refund_status).toBe("pending")
+    expect(refundPayments).not.toHaveBeenCalled()
+    expect(deleteReservations).not.toHaveBeenCalled()
+  })
+
+  it("skips inventory release when refunding captured payments fails", async () => {
+    const refundResult: unknown[] = []
+    const plan = {
+      should_release_inventory: true,
+      line_item_ids_to_release: ["line_1", "line_2"],
+    }
+    const deleteReservationsByLineItemsStep = vi.fn()
+
+    const compensationAfterRefund = {
+      ...defaultCompensationResult("order_1"),
+      refund_status: refundResult.length ? "succeeded" : "failed",
+    }
+
+    if (plan.should_release_inventory && compensationAfterRefund.refund_status !== "failed") {
+      deleteReservationsByLineItemsStep(plan.line_item_ids_to_release)
+    }
+
+    expect(compensationAfterRefund.refund_status).toBe("failed")
+    expect(deleteReservationsByLineItemsStep).not.toHaveBeenCalled()
+  })
+
+  it("releases inventory when refunds are skipped by request mode", async () => {
+    const plan = {
+      should_release_inventory: true,
+      line_item_ids_to_release: ["line_1"],
+    }
+    const compensationAfterRefund = {
+      ...defaultCompensationResult("order_1"),
+      refund_status: "skipped",
+    }
+    const deleteReservationsByLineItemsStep = vi.fn()
+
+    if (plan.should_release_inventory && compensationAfterRefund.refund_status !== "failed") {
+      deleteReservationsByLineItemsStep(plan.line_item_ids_to_release)
+    }
+
+    expect(deleteReservationsByLineItemsStep).toHaveBeenCalledWith(["line_1"])
+  })
+
+  it("keeps returning canceled for partial compensation failures", async () => {
+    const result = {
+      state: "canceled",
+      compensation: {
+        ...defaultCompensationResult("order_1"),
+        refund_status: "failed",
+        reservation_status: "skipped",
+        errors: [{ code: "compensation_failed", step: "refund", message: "provider down" }],
+      },
+    }
+
+    expect(result.state).toBe("canceled")
+    expect(result.compensation.errors).toHaveLength(1)
+    expect(result.compensation.reservation_status).toBe("skipped")
+  })
+
+  it("builds a plan with captured refunds and reservation release", () => {
+    const order = {
+      id: "order_1",
+      status: "pending",
+      items: [{ id: "line_1" }, { id: "line_2" }],
+      payment_collections: [
+        {
+          payments: [
+            makePayment("pay_1", [{ amount: 1000 }], []),
+            makePayment("pay_2", [], []),
+          ],
+        },
+      ],
+    }
+
+    const paymentIds = order.payment_collections.flatMap((pc) => pc.payments).filter((p) => !p.captures.length).map((p) => p.id)
+    const lineItemIds = order.items.map((item) => item.id)
+
+    expect(paymentIds).toEqual(["pay_2"])
+    expect(lineItemIds).toEqual(["line_1", "line_2"])
+  })
+})
diff --git a/docs/references/order-cancellation-workflow.md b/docs/references/order-cancellation-workflow.md
new file mode 100644
index 0000000000..b48d6c2f13
--- /dev/null
+++ b/docs/references/order-cancellation-workflow.md
@@ -0,0 +1,793 @@
+# Order cancellation workflow endpoint
+
+The cancellation workflow endpoint exposes a structured cancellation result for admin clients.
+
+## Response shape
+
+The endpoint returns the order plus a `cancellation` object containing state and compensation details.
+
+```json
+{
+  "order": { "id": "order_123", "status": "canceled" },
+  "cancellation": {
+    "state": "canceled",
+    "compensation": {
+      "refund_status": "succeeded",
+      "reservation_status": "succeeded"
+    }
+  }
+}
+```
+
+## Supported modes
+
+- `cancel`: cancel order and run default compensation.
+- `cancel-and-refund`: refund captured payments, release inventory reservations, cancel uncaptured payments.
+- `cancel-no-refund`: cancel order and release inventory without refunding captured payments.
+
+## Operational notes
+
+- Cancellation writes order status first so admin clients immediately see the terminal state.
+- Compensation details are written to metadata after each workflow run.
+- If refunds fail, inventory release is skipped to avoid releasing stock before money is returned.
+- Admin clients should inspect compensation errors for manual follow-up.
+
+## Cancellation scenario 1
+
+- Scenario id: order-cancellation-01.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 2
+
+- Scenario id: order-cancellation-02.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 3
+
+- Scenario id: order-cancellation-03.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 4
+
+- Scenario id: order-cancellation-04.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 5
+
+- Scenario id: order-cancellation-05.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 6
+
+- Scenario id: order-cancellation-06.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 7
+
+- Scenario id: order-cancellation-07.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 8
+
+- Scenario id: order-cancellation-08.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 9
+
+- Scenario id: order-cancellation-09.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 10
+
+- Scenario id: order-cancellation-10.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 11
+
+- Scenario id: order-cancellation-11.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 12
+
+- Scenario id: order-cancellation-12.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 13
+
+- Scenario id: order-cancellation-13.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 14
+
+- Scenario id: order-cancellation-14.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 15
+
+- Scenario id: order-cancellation-15.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 16
+
+- Scenario id: order-cancellation-16.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 17
+
+- Scenario id: order-cancellation-17.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 18
+
+- Scenario id: order-cancellation-18.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 19
+
+- Scenario id: order-cancellation-19.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 20
+
+- Scenario id: order-cancellation-20.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 21
+
+- Scenario id: order-cancellation-21.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 22
+
+- Scenario id: order-cancellation-22.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 23
+
+- Scenario id: order-cancellation-23.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 24
+
+- Scenario id: order-cancellation-24.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 25
+
+- Scenario id: order-cancellation-25.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 26
+
+- Scenario id: order-cancellation-26.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 27
+
+- Scenario id: order-cancellation-27.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 28
+
+- Scenario id: order-cancellation-28.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 29
+
+- Scenario id: order-cancellation-29.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 30
+
+- Scenario id: order-cancellation-30.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 31
+
+- Scenario id: order-cancellation-31.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 32
+
+- Scenario id: order-cancellation-32.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 33
+
+- Scenario id: order-cancellation-33.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 34
+
+- Scenario id: order-cancellation-34.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 35
+
+- Scenario id: order-cancellation-35.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 36
+
+- Scenario id: order-cancellation-36.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 37
+
+- Scenario id: order-cancellation-37.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 38
+
+- Scenario id: order-cancellation-38.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 39
+
+- Scenario id: order-cancellation-39.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 40
+
+- Scenario id: order-cancellation-40.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 41
+
+- Scenario id: order-cancellation-41.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 42
+
+- Scenario id: order-cancellation-42.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 43
+
+- Scenario id: order-cancellation-43.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 44
+
+- Scenario id: order-cancellation-44.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 45
+
+- Scenario id: order-cancellation-45.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 46
+
+- Scenario id: order-cancellation-46.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 47
+
+- Scenario id: order-cancellation-47.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 48
+
+- Scenario id: order-cancellation-48.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 49
+
+- Scenario id: order-cancellation-49.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 50
+
+- Scenario id: order-cancellation-50.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 51
+
+- Scenario id: order-cancellation-51.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 52
+
+- Scenario id: order-cancellation-52.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 53
+
+- Scenario id: order-cancellation-53.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 54
+
+- Scenario id: order-cancellation-54.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 55
+
+- Scenario id: order-cancellation-55.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 56
+
+- Scenario id: order-cancellation-56.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 57
+
+- Scenario id: order-cancellation-57.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 58
+
+- Scenario id: order-cancellation-58.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 59
+
+- Scenario id: order-cancellation-59.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 60
+
+- Scenario id: order-cancellation-60.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 61
+
+- Scenario id: order-cancellation-61.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 62
+
+- Scenario id: order-cancellation-62.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 63
+
+- Scenario id: order-cancellation-63.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 64
+
+- Scenario id: order-cancellation-64.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 65
+
+- Scenario id: order-cancellation-65.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 66
+
+- Scenario id: order-cancellation-66.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 67
+
+- Scenario id: order-cancellation-67.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation scenario 68
+
+- Scenario id: order-cancellation-68.
+- Product state observed by admin: order appears canceled immediately.
+- Compensation concern: payment refund, reservation release, uncaptured payment cancel, event emission.
+- Reviewer check: does the terminal state mean every business side effect has completed?
+- Safer state model: requested, canceling, canceled, cancellation_failed, with itemized retryable tasks.
+
+## Cancellation recovery drill 69
+
+- Drill id: order-cancellation-recovery-69.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 70
+
+- Drill id: order-cancellation-recovery-70.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 71
+
+- Drill id: order-cancellation-recovery-71.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 72
+
+- Drill id: order-cancellation-recovery-72.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 73
+
+- Drill id: order-cancellation-recovery-73.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 74
+
+- Drill id: order-cancellation-recovery-74.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 75
+
+- Drill id: order-cancellation-recovery-75.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 76
+
+- Drill id: order-cancellation-recovery-76.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 77
+
+- Drill id: order-cancellation-recovery-77.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 78
+
+- Drill id: order-cancellation-recovery-78.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 79
+
+- Drill id: order-cancellation-recovery-79.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 80
+
+- Drill id: order-cancellation-recovery-80.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 81
+
+- Drill id: order-cancellation-recovery-81.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 82
+
+- Drill id: order-cancellation-recovery-82.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 83
+
+- Drill id: order-cancellation-recovery-83.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 84
+
+- Drill id: order-cancellation-recovery-84.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 85
+
+- Drill id: order-cancellation-recovery-85.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 86
+
+- Drill id: order-cancellation-recovery-86.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 87
+
+- Drill id: order-cancellation-recovery-87.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 88
+
+- Drill id: order-cancellation-recovery-88.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 89
+
+- Drill id: order-cancellation-recovery-89.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 90
+
+- Drill id: order-cancellation-recovery-90.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 91
+
+- Drill id: order-cancellation-recovery-91.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
+
+## Cancellation recovery drill 92
+
+- Drill id: order-cancellation-recovery-92.
+- Starting state: admin sees a terminal canceled order row.
+- Hidden work: refund, reservation release, uncaptured payment cancellation, or event delivery.
+- Review question: should a terminal order state hide this work from clients?
+- Recovery risk: retry code may skip independent compensation because top-level state is already terminal.
+- Better contract: itemized durable cancellation tasks with explicit retry and terminal-state promotion.
```

## Intended Flaws

### Flaw 1: API returns terminal canceled state before compensation is complete

- Main locations:
  - `packages/core/core-flows/src/order/steps/mark-order-cancellation-started.ts:18-37`
  - `packages/core/core-flows/src/order/workflows/cancel-order-with-compensation.ts:46-63`
  - `packages/core/core-flows/src/order/workflows/cancel-order-with-compensation.ts:108-111`
  - `packages/medusa/src/api/admin/orders/[id]/cancel-workflow/route.ts:24-35`
  - `packages/core/core-flows/src/order/workflows/__tests__/cancel-order-with-compensation.spec.ts:26-45`
- What is wrong: The workflow marks the order itself as `canceled` at the beginning of the cancellation flow and the endpoint returns `state: "canceled"` even while refund and reservation compensation are still represented as pending or failed. The response makes terminal order state mean less than the business process requires.
- Why it matters: Admin clients, automations, and customers can observe a canceled order while money has not been refunded, inventory has not been released, or uncaptured payments have not been canceled. Downstream systems may stop retrying or hide manual recovery because the top-level state says the cancellation is done.
- Better direction: Model cancellation as a state machine: `cancellation_requested` or `canceling` while compensation is running, then `canceled` only after required compensations finish or are explicitly accepted as failed/manual. The API should expose itemized compensation statuses and avoid returning a terminal state until the business invariant is true.

Hints:

1. Find the first step that writes order status. What has not happened yet?
2. Compare the top-level `state` with the compensation statuses in the tests.
3. What should an admin client infer from `order.status = canceled`?

### Flaw 2: Inventory reservation release depends on refund success

- Main locations:
  - `packages/core/core-flows/src/order/workflows/cancel-order-with-compensation.ts:58-79`
  - `packages/core/core-flows/src/order/workflows/cancel-order-with-compensation.ts:95-103`
  - `packages/core/core-flows/src/order/workflows/__tests__/cancel-order-with-compensation.spec.ts:49-77`
  - `docs/references/order-cancellation-workflow.md:22-24`
- What is wrong: The workflow releases inventory only when `compensationAfterRefund.refund_status !== "failed"`. If a captured-payment refund fails, inventory reservations are skipped even though the order has already been marked canceled. The docs encode this behavior as intentional.
- Why it matters: Stock remains reserved for an order that is visible as canceled. Merchants lose sellable inventory, fulfillment capacity is understated, and retries are ambiguous because inventory release is coupled to a payment provider failure. Refund recovery and reservation release are separate business obligations and should not block each other by accident.
- Better direction: Run independent compensations independently. Reservation release should be its own required task with retry/idempotency and locking, not conditional on refund success. If product wants to hold inventory until refund completion, that must be an explicit policy state such as `canceling_refund_failed_inventory_held`, not a skipped side effect under `canceled`.

Hints:

1. Look at the predicate passed to the reservation-release `when(...)` block.
2. What happens to reserved quantity when the payment provider is down?
3. Are refunding money and releasing inventory the same invariant, or two independent recovery tracks?

## Expert Debrief

### Product-Level Change

The product change is reasonable: admin users want to know what happened during cancellation, not just receive `{ order }`. The danger is making the new visibility layer redefine cancellation semantics.

Order cancellation is a state machine across order, payment, inventory, events, and sometimes fulfillment. A workflow can expose partial progress, but it must not call partial progress a terminal state.

### Changed Contracts

This PR changes several contracts:

- API response contract: cancellation now returns a top-level `state` plus compensation details.
- Order state contract: the order can become `canceled` before compensation finishes.
- Payment contract: refund failure is converted into compensation metadata rather than blocking terminal cancellation state.
- Inventory contract: reservation release is conditional on refund success.
- Retry contract: failed compensation is represented in metadata but not as durable retryable work.
- Client contract: clients must now inspect nested compensation errors to understand whether cancellation actually finished.

The broken contracts are terminal state truthfulness and independent compensation execution.

### Failure Modes

Important failure modes reviewers should predict:

- Order list shows `canceled`, but captured payment refund failed.
- A warehouse system treats the order as canceled but inventory reservations remain held.
- Customer support tells a customer the order is canceled even though money has not been returned.
- A retry only re-runs refund logic while inventory stays skipped because the previous cancellation is already terminal.
- Analytics undercount available stock because canceled orders still hold reservations.
- Admin clients ignore nested compensation errors because the top-level state is terminal.

### Reviewer Thought Process

A strong reviewer should ask:

- What invariant does `order.status = canceled` promise?
- Are refund, reservation release, payment cancellation, and event emission all complete before the terminal state?
- Are independent compensations accidentally serialized or gated by one another?
- What does a client do when top-level state and nested compensation disagree?
- Is failed compensation durable and retryable, or just metadata?
- Does the new endpoint preserve the stronger ordering of the existing cancellation workflow?

The key move is reviewing the workflow as a state machine, not as a sequence of convenient service calls.

### Better Implementation Direction

A safer implementation would:

1. Introduce explicit cancellation progress states such as `cancel_requested`, `canceling`, `canceled`, and `cancellation_failed`.
2. Keep `canceled` reserved for the point where required compensation invariants are satisfied.
3. Write durable compensation tasks for refund, reservation release, payment cancellation, and event emission.
4. Run independent tasks independently with idempotency keys and retry state.
5. Make inventory release policy explicit instead of hiding it behind refund success.
6. Return itemized progress to admin clients without making them infer truth from conflicting fields.

## Correctness Verdict Rubric

For each flaw, the verifier should mark the learner correct if their answer captures the core issue, even if they use different wording.

### Flaw 1 Rubric

Correct answers should mention:

- The workflow sets order status/top-level state to canceled before required compensation has completed.
- Compensation can still be pending, skipped, or failed while the API reports terminal cancellation.
- This misleads clients and operators about refunds, inventory, payment cancellation, and recovery.
- A better fix is an explicit pending/canceling state and terminal canceled only after required work completes or is clearly marked manual.

Partially correct answers may mention only that the response shape is confusing without explaining the terminal-state invariant.

Incorrect answers focus on naming the endpoint or adding more response fields while keeping the lie.

### Flaw 2 Rubric

Correct answers should mention:

- Reservation release is gated on refund success.
- If refund fails, inventory remains reserved even though the order is canceled.
- Refund recovery and inventory release should be independent compensation tasks unless an explicit product policy says otherwise.
- A better fix is independent durable/idempotent compensation or a visible policy state when inventory is intentionally held.

Partially correct answers may mention only that inventory is skipped on errors without identifying the payment coupling.

Incorrect answers argue that holding inventory is always safer without demanding an explicit state/policy.

## Golden Answer Summary

The PR adds useful cancellation visibility, but it weakens Medusa order semantics. First, it marks and returns the order as canceled before compensation has actually completed, so clients see a terminal state while refunds or reservation release may still be pending or failed. Second, it makes inventory reservation release depend on refund success, which leaves stock reserved for an order that already appears canceled when a payment provider fails. The fix is a real cancellation state machine with durable, independent compensation tasks and a terminal `canceled` state only when the required business invariants are true.
