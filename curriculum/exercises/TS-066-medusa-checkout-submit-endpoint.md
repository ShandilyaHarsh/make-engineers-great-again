# TS-066: Medusa Checkout Submit Endpoint

## Metadata

- `id`: TS-066
- `source_repo`: [medusajs/medusa](https://github.com/medusajs/medusa)
- `repo_area`: store cart completion API, checkout workflow orchestration, cart/order links, idempotency records, inventory reservations, payment authorization, migrations, HTTP tests
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 2060
- `flaw_count`: 2

## PR Description Shown To Learner

This PR adds a new `POST /store/carts/:id/submit` endpoint for storefronts that want a simpler checkout submit call than `POST /store/carts/:id/complete`.

The existing complete-cart route directly invokes `completeCartWorkflow`. The new endpoint introduces an explicit checkout submit workflow, an idempotency key in the request body/header, a `checkout_submit_attempt` table for retry tracking, and a new inventory reservation step. The PR claims this lets storefronts safely retry checkout submits, expose clearer submit-attempt status to apps, and keep the legacy complete-cart endpoint unchanged.

The PR description says submit is "idempotent for the same cart and idempotency key" and "will not create an order unless inventory can be reserved."

## Existing Code Context

The real Medusa codebase already has these relevant contracts:

- `packages/medusa/src/api/store/carts/[id]/complete/route.ts` invokes `completeCartWorkflow` through the workflow engine and returns either an order or a still-actionable cart.
- `completeCartWorkflow` acquires a cart lock, checks the existing `order_cart` link for the cart, validates cart items/shipping/payments, creates the order, links order and cart, marks the cart completed, reserves inventory, registers promotion usage, emits the `order.placed` event, and authorizes payment.
- `completeCartWorkflow` is marked `idempotent: false`, so safety comes from the cart lock, the existing order-cart link check, workflow compensation, and step ordering.
- `reserveInventoryStep` reserves inventory inside the workflow under inventory item locks and has compensation that deletes reservations if a later step fails.
- `validateCartStep` rejects carts with `completed_at`, but only after the route/workflow actually reads the cart state in the protected completion flow.
- Storefront checkout calls are retried by browsers, mobile clients, payment-provider redirects, and customer double-clicks. The endpoint cannot rely on the client being perfectly single-flight.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/medusa/src/api/store/carts/[id]/submit/route.ts`
- `packages/medusa/src/api/store/carts/[id]/submit/validators.ts`
- `packages/core/core-flows/src/cart/workflows/submit-checkout.ts`
- `packages/core/core-flows/src/cart/steps/create-checkout-submit-attempt.ts`
- `packages/core/core-flows/src/cart/steps/reserve-inventory-after-submit.ts`
- `packages/core/core-flows/src/cart/workflows/index.ts`
- `packages/core/core-flows/src/cart/steps/index.ts`
- `packages/modules/cart/src/models/checkout-submit-attempt.ts`
- `packages/modules/cart/src/models/index.ts`
- `packages/modules/cart/src/migrations/Migration20260601090000.ts`
- `packages/modules/cart/src/services/cart-module-service.ts`
- `packages/core/types/src/cart/checkout-submit-attempt.ts`
- `packages/core/types/src/cart/index.ts`
- `packages/medusa/src/api/store/carts/[id]/submit/__tests__/submit.spec.ts`
- `packages/core/core-flows/src/cart/workflows/__tests__/submit-checkout.spec.ts`
- `packages/core/core-flows/src/cart/steps/__tests__/reserve-inventory-after-submit.spec.ts`
- `www/apps/api-reference/specs/store/paths/store_carts_{id}_submit.yaml`
- `www/apps/book/app/resources/references/store/checkout-submit/page.mdx`

The line references below use synthetic PR line numbers. This is a backend/API review surface because the important behavior is distributed across route contract, idempotency persistence, workflow orchestration, DB constraints, and inventory mutation order.

## Diff

```diff
diff --git a/packages/medusa/src/api/store/carts/[id]/submit/validators.ts b/packages/medusa/src/api/store/carts/[id]/submit/validators.ts
new file mode 100644
index 00000000000..1d43ee676b1
--- /dev/null
+++ b/packages/medusa/src/api/store/carts/[id]/submit/validators.ts
@@ -0,0 +1,136 @@
+import { z } from "zod"
+
+export const StoreSubmitCart = z.object({
+  idempotency_key: z.string().min(1).max(128).optional(),
+  return_cart: z.boolean().optional(),
+  metadata: z.record(z.string(), z.unknown()).optional(),
+})
+
+export type StoreSubmitCartType = z.infer<typeof StoreSubmitCart>
+
+export const submitCartResponseFields = [
+  "id",
+  "status",
+  "email",
+  "currency_code",
+  "total",
+  "subtotal",
+  "tax_total",
+  "shipping_total",
+  "discount_total",
+  "items.*",
+  "shipping_address.*",
+  "billing_address.*",
+  "shipping_methods.*",
+  "transactions.*",
+]
+
+export const submitCartReturnCartFields = [
+  "id",
+  "email",
+  "currency_code",
+  "completed_at",
+  "total",
+  "subtotal",
+  "tax_total",
+  "shipping_total",
+  "items.*",
+  "shipping_methods.*",
+  "payment_collection.*",
+  "payment_collection.payment_sessions.*",
+]
diff --git a/packages/medusa/src/api/store/carts/[id]/submit/route.ts b/packages/medusa/src/api/store/carts/[id]/submit/route.ts
new file mode 100644
index 00000000000..9a65b96286b
--- /dev/null
+++ b/packages/medusa/src/api/store/carts/[id]/submit/route.ts
@@ -0,0 +1,312 @@
+import { submitCheckoutWorkflowId } from "@medusajs/core-flows"
+import { prepareRetrieveQuery } from "@medusajs/framework"
+import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
+import { HttpTypes } from "@medusajs/framework/types"
+import {
+  ContainerRegistrationKeys,
+  MedusaError,
+  Modules,
+} from "@medusajs/framework/utils"
+import { randomUUID } from "crypto"
+import { refetchCart } from "../../helpers"
+import { defaultStoreCartFields } from "../../query-config"
+import {
+  StoreSubmitCartType,
+  submitCartResponseFields,
+  submitCartReturnCartFields,
+} from "./validators"
+
+type StoreSubmitCartResponse =
+  | {
+      type: "order"
+      order: HttpTypes.StoreOrder
+      submit_attempt_id: string
+    }
+  | {
+      type: "cart"
+      cart: HttpTypes.StoreCart
+      submit_attempt_id?: string
+      error?: {
+        message: string
+        name?: string
+        type?: string
+      }
+    }
+
+const IDEMPOTENCY_HEADER = "idempotency-key"
+
+export const POST = async (
+  req: MedusaRequest<StoreSubmitCartType, HttpTypes.SelectParams>,
+  res: MedusaResponse<StoreSubmitCartResponse>
+) => {
+  const cartId = req.params.id
+  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
+  const workflowEngine = req.scope.resolve(Modules.WORKFLOW_ENGINE)
+  const body = req.validatedBody ?? {}
+
+  const idempotencyKey =
+    body.idempotency_key ??
+    getHeaderValue(req.headers[IDEMPOTENCY_HEADER]) ??
+    randomUUID()
+
+  const metadata = {
+    ...(body.metadata ?? {}),
+    user_agent: getHeaderValue(req.headers["user-agent"]),
+    source: "store-api",
+  }
+
+  const { errors, result, transaction } = await workflowEngine.run(
+    submitCheckoutWorkflowId,
+    {
+      input: {
+        cart_id: cartId,
+        idempotency_key: idempotencyKey,
+        metadata,
+      },
+      throwOnError: false,
+    }
+  )
+
+  if (!transaction.hasFinished()) {
+    throw new MedusaError(
+      MedusaError.Types.CONFLICT,
+      "Cart submit is already in progress"
+    )
+  }
+
+  if (errors?.[0]) {
+    const error = errors[0].error
+    const statusOKErrors = [
+      MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
+      MedusaError.Types.PAYMENT_REQUIRES_MORE_ERROR,
+      MedusaError.Types.INVALID_DATA,
+    ]
+
+    if (!body.return_cart && !statusOKErrors.includes(error?.type)) {
+      throw error
+    }
+
+    const cartReq = await prepareRetrieveQuery(
+      {},
+      {
+        defaults: submitCartReturnCartFields.concat(defaultStoreCartFields),
+      },
+      req as MedusaRequest
+    )
+
+    const cart = await refetchCart(
+      cartId,
+      req.scope,
+      cartReq.remoteQueryConfig.fields
+    )
+
+    res.status(200).json({
+      type: "cart",
+      cart,
+      submit_attempt_id: result?.submit_attempt_id,
+      error: {
+        message: error.message,
+        name: error.name,
+        type: error.type,
+      },
+    })
+    return
+  }
+
+  const { data } = await query.graph({
+    entity: "order",
+    fields: req.queryConfig.fields?.length
+      ? req.queryConfig.fields
+      : submitCartResponseFields,
+    filters: { id: result.order_id },
+  })
+
+  res.status(200).json({
+    type: "order",
+    order: data[0],
+    submit_attempt_id: result.submit_attempt_id,
+  })
+}
+
+function getHeaderValue(value: string | string[] | undefined) {
+  if (Array.isArray(value)) {
+    return value[0]
+  }
+
+  return value
+}
diff --git a/packages/core/core-flows/src/cart/steps/create-checkout-submit-attempt.ts b/packages/core/core-flows/src/cart/steps/create-checkout-submit-attempt.ts
new file mode 100644
index 00000000000..12f581c8fc3
--- /dev/null
+++ b/packages/core/core-flows/src/cart/steps/create-checkout-submit-attempt.ts
@@ -0,0 +1,304 @@
+import {
+  CreateCheckoutSubmitAttemptDTO,
+  CheckoutSubmitAttemptDTO,
+} from "@medusajs/framework/types"
+import { MedusaError, Modules } from "@medusajs/framework/utils"
+import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
+
+export type CreateCheckoutSubmitAttemptStepInput = {
+  cart_id: string
+  idempotency_key: string
+  metadata?: Record<string, unknown>
+}
+
+export type CompleteCheckoutSubmitAttemptStepInput = {
+  submit_attempt_id: string
+  order_id: string
+}
+
+export type FailCheckoutSubmitAttemptStepInput = {
+  submit_attempt_id: string
+  message: string
+  type?: string
+}
+
+export const createCheckoutSubmitAttemptStepId =
+  "create-checkout-submit-attempt"
+
+export const completeCheckoutSubmitAttemptStepId =
+  "complete-checkout-submit-attempt"
+
+export const failCheckoutSubmitAttemptStepId = "fail-checkout-submit-attempt"
+
+export const createCheckoutSubmitAttemptStep = createStep(
+  createCheckoutSubmitAttemptStepId,
+  async (
+    input: CreateCheckoutSubmitAttemptStepInput,
+    { container }
+  ): Promise<StepResponse<CheckoutSubmitAttemptDTO, string>> => {
+    const cartModule = container.resolve(Modules.CART)
+
+    const existing = await cartModule.listCheckoutSubmitAttempts({
+      cart_id: input.cart_id,
+      idempotency_key: input.idempotency_key,
+      status: ["completed"],
+    })
+
+    if (existing[0]) {
+      return new StepResponse(existing[0], existing[0].id)
+    }
+
+    const payload: CreateCheckoutSubmitAttemptDTO = {
+      cart_id: input.cart_id,
+      idempotency_key: input.idempotency_key,
+      status: "pending",
+      metadata: input.metadata ?? {},
+    }
+
+    const attempt = await cartModule.createCheckoutSubmitAttempts(payload)
+
+    return new StepResponse(attempt, attempt.id)
+  },
+  async (attemptId, { container }) => {
+    if (!attemptId) {
+      return
+    }
+
+    const cartModule = container.resolve(Modules.CART)
+    const [attempt] = await cartModule.listCheckoutSubmitAttempts({
+      id: attemptId,
+    })
+
+    if (!attempt || attempt.status === "completed") {
+      return
+    }
+
+    await cartModule.deleteCheckoutSubmitAttempts(attemptId)
+  }
+)
+
+export const completeCheckoutSubmitAttemptStep = createStep(
+  completeCheckoutSubmitAttemptStepId,
+  async (input: CompleteCheckoutSubmitAttemptStepInput, { container }) => {
+    const cartModule = container.resolve(Modules.CART)
+
+    const [attempt] = await cartModule.listCheckoutSubmitAttempts({
+      id: input.submit_attempt_id,
+    })
+
+    if (!attempt) {
+      throw new MedusaError(
+        MedusaError.Types.NOT_FOUND,
+        `Checkout submit attempt ${input.submit_attempt_id} was not found`
+      )
+    }
+
+    if (attempt.status === "completed" && attempt.order_id) {
+      return new StepResponse({
+        ...attempt,
+        order_id: attempt.order_id,
+      })
+    }
+
+    const updated = await cartModule.updateCheckoutSubmitAttempts({
+      id: input.submit_attempt_id,
+      order_id: input.order_id,
+      status: "completed",
+      completed_at: new Date(),
+    })
+
+    return new StepResponse(updated)
+  }
+)
+
+export const failCheckoutSubmitAttemptStep = createStep(
+  failCheckoutSubmitAttemptStepId,
+  async (input: FailCheckoutSubmitAttemptStepInput, { container }) => {
+    const cartModule = container.resolve(Modules.CART)
+
+    const updated = await cartModule.updateCheckoutSubmitAttempts({
+      id: input.submit_attempt_id,
+      status: "failed",
+      error_message: input.message,
+      error_type: input.type,
+      failed_at: new Date(),
+    })
+
+    return new StepResponse(updated)
+  }
+)
diff --git a/packages/core/core-flows/src/cart/steps/reserve-inventory-after-submit.ts b/packages/core/core-flows/src/cart/steps/reserve-inventory-after-submit.ts
new file mode 100644
index 00000000000..df2d3566c54
--- /dev/null
+++ b/packages/core/core-flows/src/cart/steps/reserve-inventory-after-submit.ts
@@ -0,0 +1,316 @@
+import {
+  BigNumberInput,
+  OrderDTO,
+  OrderLineItemDTO,
+} from "@medusajs/framework/types"
+import { MathBN, Modules } from "@medusajs/framework/utils"
+import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
+
+type SubmitInventoryReservationInput = {
+  order: OrderDTO
+  sales_channel_id: string | null
+  items: {
+    id: string
+    variant_id: string | null
+    quantity: BigNumberInput
+    inventory_items?: {
+      inventory_item_id: string
+      required_quantity: number
+      allow_backorder: boolean
+      location_ids: string[]
+    }[]
+  }[]
+}
+
+type SubmitInventoryReservationCompensation = {
+  reservation_ids: string[]
+  inventory_item_ids: string[]
+}
+
+export const reserveInventoryAfterSubmitStepId =
+  "reserve-inventory-after-submit"
+
+export const reserveInventoryAfterSubmitStep = createStep(
+  reserveInventoryAfterSubmitStepId,
+  async (
+    input: SubmitInventoryReservationInput,
+    { container }
+  ): Promise<StepResponse<string[], SubmitInventoryReservationCompensation>> => {
+    const inventoryService = container.resolve(Modules.INVENTORY)
+    const locking = container.resolve(Modules.LOCKING)
+
+    const reservationItems = input.items
+      .map((item) => {
+        return buildReservationItems(item)
+      })
+      .flat(1)
+
+    if (!reservationItems.length) {
+      return new StepResponse([], {
+        reservation_ids: [],
+        inventory_item_ids: [],
+      })
+    }
+
+    const inventoryItemIds = Array.from(
+      new Set(reservationItems.map((item) => item.inventory_item_id))
+    )
+
+    const reservations = await locking.execute(inventoryItemIds, async () => {
+      return await inventoryService.createReservationItems(
+        reservationItems.map((item) => ({
+          ...item,
+          line_item_id: item.line_item_id,
+          metadata: {
+            ...(item.metadata ?? {}),
+            order_id: input.order.id,
+            checkout_submit: true,
+          },
+        }))
+      )
+    })
+
+    return new StepResponse(
+      reservations.map((reservation) => reservation.id),
+      {
+        reservation_ids: reservations.map((reservation) => reservation.id),
+        inventory_item_ids: inventoryItemIds,
+      }
+    )
+  },
+  async (compensation, { container }) => {
+    if (!compensation?.reservation_ids?.length) {
+      return
+    }
+
+    const inventoryService = container.resolve(Modules.INVENTORY)
+    const locking = container.resolve(Modules.LOCKING)
+    const lockingKeys = Array.from(new Set(compensation.inventory_item_ids))
+
+    await locking.execute(lockingKeys, async () => {
+      await inventoryService.deleteReservationItems(
+        compensation.reservation_ids
+      )
+    })
+
+    return new StepResponse()
+  }
+)
+
+function buildReservationItems(item: {
+  id: string
+  variant_id: string | null
+  quantity: BigNumberInput
+  inventory_items?: {
+    inventory_item_id: string
+    required_quantity: number
+    allow_backorder: boolean
+    location_ids: string[]
+  }[]
+}) {
+  if (!item.variant_id || !item.inventory_items?.length) {
+    return []
+  }
+
+  return item.inventory_items.map((inventoryItem) => {
+    return {
+      line_item_id: item.id,
+      inventory_item_id: inventoryItem.inventory_item_id,
+      quantity: MathBN.mult(
+        inventoryItem.required_quantity,
+        item.quantity
+      ) as BigNumberInput,
+      allow_backorder: inventoryItem.allow_backorder,
+      location_id: inventoryItem.location_ids[0],
+      metadata: {
+        variant_id: item.variant_id,
+      },
+    }
+  })
+}
diff --git a/packages/core/core-flows/src/cart/workflows/submit-checkout.ts b/packages/core/core-flows/src/cart/workflows/submit-checkout.ts
new file mode 100644
index 00000000000..d94ce8f2222
--- /dev/null
+++ b/packages/core/core-flows/src/cart/workflows/submit-checkout.ts
@@ -0,0 +1,624 @@
+import {
+  CartCreditLineDTO,
+  CartWorkflowDTO,
+  LinkDefinition,
+  PromotionDTO,
+  UsageComputedActions,
+} from "@medusajs/framework/types"
+import {
+  EventPriority,
+  isDefined,
+  Modules,
+  OrderStatus,
+  OrderWorkflowEvents,
+} from "@medusajs/framework/utils"
+import {
+  createWorkflow,
+  parallelize,
+  transform,
+  when,
+  WorkflowData,
+  WorkflowResponse,
+} from "@medusajs/framework/workflows-sdk"
+import {
+  createRemoteLinkStep,
+  emitEventStep,
+  useQueryGraphStep,
+} from "../../common"
+import { addOrderTransactionStep } from "../../order/steps/add-order-transaction"
+import { createOrdersStep } from "../../order/steps/create-orders"
+import { authorizePaymentSessionStep } from "../../payment/steps/authorize-payment-session"
+import { registerUsageStep } from "../../promotion/steps/register-usage"
+import {
+  updateCartsStep,
+  validateCartItemsStep,
+  validateCartPaymentsStep,
+  validateShippingStep,
+} from "../steps"
+import {
+  completeCheckoutSubmitAttemptStep,
+  createCheckoutSubmitAttemptStep,
+} from "../steps/create-checkout-submit-attempt"
+import { reserveInventoryAfterSubmitStep } from "../steps/reserve-inventory-after-submit"
+import { completeCartFields } from "../utils/fields"
+import {
+  prepareAdjustmentsData,
+  prepareLineItemData,
+  PrepareLineItemDataInput,
+  prepareTaxLinesData,
+} from "../utils/prepare-line-item-data"
+
+export type SubmitCheckoutWorkflowInput = {
+  cart_id: string
+  idempotency_key: string
+  metadata?: Record<string, unknown>
+}
+
+export type SubmitCheckoutWorkflowOutput = {
+  order_id: string
+  submit_attempt_id: string
+}
+
+const THREE_DAYS = 60 * 60 * 24 * 3
+
+export const submitCheckoutWorkflowId = "submit-checkout"
+
+export const submitCheckoutWorkflow = createWorkflow(
+  {
+    name: submitCheckoutWorkflowId,
+    store: true,
+    idempotent: true,
+    retentionTime: THREE_DAYS,
+  },
+  (input: WorkflowData<SubmitCheckoutWorkflowInput>) => {
+    const submitAttempt = createCheckoutSubmitAttemptStep({
+      cart_id: input.cart_id,
+      idempotency_key: input.idempotency_key,
+      metadata: input.metadata,
+    })
+
+    const existingOrderId = transform(
+      { submitAttempt },
+      ({ submitAttempt }) => {
+        return submitAttempt.status === "completed"
+          ? submitAttempt.order_id
+          : null
+      }
+    )
+
+    const existingOrderResult = when(
+      "checkout-submit-existing-order",
+      { existingOrderId, submitAttempt },
+      ({ existingOrderId }) => {
+        return !!existingOrderId
+      }
+    ).then(() => {
+      return transform(
+        { existingOrderId, submitAttempt },
+        ({ existingOrderId, submitAttempt }) => {
+          return {
+            order_id: existingOrderId!,
+            submit_attempt_id: submitAttempt.id,
+          }
+        }
+      )
+    })
+
+    const newOrderResult = when(
+      "checkout-submit-create-order",
+      { existingOrderId },
+      ({ existingOrderId }) => {
+        return !existingOrderId
+      }
+    ).then(() => {
+      const [orderCart, cartData] = parallelize(
+        useQueryGraphStep({
+          entity: "order_cart",
+          fields: ["cart_id", "order_id"],
+          filters: { cart_id: input.cart_id },
+          options: {
+            isList: false,
+          },
+        }).config({ name: "checkout-submit-order-cart-query" }),
+        useQueryGraphStep({
+          entity: "cart",
+          fields: completeCartFields.concat([
+            "items.variant.inventory_items.*",
+            "items.variant.inventory_items.inventory.location_levels.*",
+          ]),
+          filters: { id: input.cart_id },
+          options: {
+            isList: false,
+          },
+        }).config({
+          name: "checkout-submit-cart-query",
+        })
+      )
+
+      const orderIdFromCartLink = transform({ orderCart }, ({ orderCart }) => {
+        return orderCart?.data?.order_id ?? null
+      })
+
+      validateCartItemsStep({ cart: cartData.data })
+
+      const paymentSessions = validateCartPaymentsStep({ cart: cartData.data })
+
+      const cartOptionIds = transform({ cart: cartData.data }, ({ cart }) => {
+        return cart.shipping_methods?.map((sm) => sm.shipping_option_id)
+      })
+
+      const shippingOptionsData = useQueryGraphStep({
+        entity: "shipping_option",
+        fields: ["id", "shipping_profile_id"],
+        filters: { id: cartOptionIds },
+        options: {
+          cache: {
+            enable: true,
+          },
+        },
+      }).config({
+        name: "checkout-submit-shipping-options-query",
+      })
+
+      validateShippingStep({
+        cart: cartData.data,
+        shippingOptions: shippingOptionsData.data,
+      })
+
+      const cartToOrder = transform({ cart: cartData.data }, ({ cart }) => {
+        const allItems = (cart.items ?? []).map((item) => {
+          const input: PrepareLineItemDataInput = {
+            item,
+            variant: item.variant,
+            cartId: cart.id,
+            unitPrice: item.unit_price,
+            isTaxInclusive: item.is_tax_inclusive,
+            taxLines: item.tax_lines ?? [],
+            adjustments: item.adjustments ?? [],
+          }
+
+          return prepareLineItemData(input)
+        })
+
+        const shippingMethods = (cart.shipping_methods ?? []).map((sm) => {
+          return {
+            name: sm.name,
+            description: sm.description,
+            amount: sm.raw_amount ?? sm.amount,
+            is_tax_inclusive: sm.is_tax_inclusive,
+            shipping_option_id: sm.shipping_option_id,
+            data: sm.data,
+            metadata: sm.metadata,
+            tax_lines: prepareTaxLinesData(sm.tax_lines ?? []),
+            adjustments: prepareAdjustmentsData(sm.adjustments ?? []),
+          }
+        })
+
+        const creditLines = (cart.credit_lines ?? []).map(
+          (creditLine: CartCreditLineDTO) => {
+            return {
+              amount: creditLine.amount,
+              raw_amount: creditLine.raw_amount,
+              reference: creditLine.reference,
+              reference_id: creditLine.reference_id,
+              metadata: creditLine.metadata,
+            }
+          }
+        )
+
+        const itemAdjustments = allItems
+          .map((item) => item.adjustments ?? [])
+          .flat(1)
+        const shippingAdjustments = shippingMethods
+          .map((sm) => sm.adjustments ?? [])
+          .flat(1)
+
+        const promoCodes = [...itemAdjustments, ...shippingAdjustments]
+          .map((adjustment) => adjustment.code)
+          .filter(Boolean)
+
+        const shippingAddress = cart.shipping_address
+          ? { ...cart.shipping_address }
+          : null
+        const billingAddress = cart.billing_address
+          ? { ...cart.billing_address }
+          : null
+
+        if (shippingAddress) {
+          delete shippingAddress.id
+        }
+
+        if (billingAddress) {
+          delete billingAddress.id
+        }
+
+        return {
+          region_id: cart.region?.id,
+          customer_id: cart.customer?.id,
+          sales_channel_id: cart.sales_channel_id,
+          status: OrderStatus.PENDING,
+          email: cart.email,
+          currency_code: cart.currency_code,
+          locale: cart.locale,
+          shipping_address: shippingAddress,
+          billing_address: billingAddress,
+          no_notification: false,
+          items: allItems,
+          shipping_methods: shippingMethods,
+          metadata: {
+            ...(cart.metadata ?? {}),
+            checkout_submit_attempt_id: submitAttempt.id,
+          },
+          promo_codes: promoCodes,
+          credit_lines: creditLines,
+        }
+      })
+
+      const createdOrders = when(
+        "checkout-submit-create-order-if-cart-has-no-link",
+        { orderIdFromCartLink },
+        ({ orderIdFromCartLink }) => {
+          return !orderIdFromCartLink
+        }
+      ).then(() => {
+        return createOrdersStep([cartToOrder])
+      })
+
+      const createdOrder = transform(
+        { createdOrders, orderIdFromCartLink },
+        ({ createdOrders, orderIdFromCartLink }) => {
+          if (orderIdFromCartLink) {
+            return {
+              id: orderIdFromCartLink,
+            }
+          }
+
+          return createdOrders[0]
+        }
+      )
+
+      const linksToCreate = transform(
+        { cart: cartData.data, createdOrder },
+        ({ cart, createdOrder }) => {
+          const links: LinkDefinition[] = [
+            {
+              [Modules.ORDER]: { order_id: createdOrder.id },
+              [Modules.CART]: { cart_id: cart.id },
+            },
+          ]
+
+          if (cart.promotions?.length) {
+            cart.promotions.forEach((promotion: PromotionDTO) => {
+              links.push({
+                [Modules.ORDER]: { order_id: createdOrder.id },
+                [Modules.PROMOTION]: { promotion_id: promotion.id },
+              })
+            })
+          }
+
+          if (isDefined(cart.payment_collection?.id)) {
+            links.push({
+              [Modules.ORDER]: { order_id: createdOrder.id },
+              [Modules.PAYMENT]: {
+                payment_collection_id: cart.payment_collection.id,
+              },
+            })
+          }
+
+          return links
+        }
+      )
+
+      const promotionUsage = transform(
+        { cart: cartData.data },
+        ({ cart }: { cart: CartWorkflowDTO }) => {
+          const promotionUsage: UsageComputedActions[] = []
+
+          const itemAdjustments = (cart.items ?? [])
+            .map((item) => item.adjustments ?? [])
+            .flat(1)
+
+          const shippingAdjustments = (cart.shipping_methods ?? [])
+            .map((item) => item.adjustments ?? [])
+            .flat(1)
+
+          for (const adjustment of itemAdjustments) {
+            promotionUsage.push({
+              amount: adjustment.amount,
+              code: adjustment.code!,
+            })
+          }
+
+          for (const adjustment of shippingAdjustments) {
+            promotionUsage.push({
+              amount: adjustment.amount,
+              code: adjustment.code!,
+            })
+          }
+
+          return {
+            computedActions: promotionUsage,
+            registrationContext: {
+              customer_id: cart.customer?.id || null,
+              customer_email: cart.email || null,
+            },
+          }
+        }
+      )
+
+      const updateCompletedAt = transform(
+        { cart: cartData.data },
+        ({ cart }) => {
+          return {
+            id: cart.id,
+            completed_at: new Date(),
+          }
+        }
+      )
+
+      parallelize(
+        createRemoteLinkStep(linksToCreate),
+        updateCartsStep([updateCompletedAt]),
+        registerUsageStep(promotionUsage),
+        emitEventStep({
+          eventName: OrderWorkflowEvents.PLACED,
+          data: { id: createdOrder.id },
+          options: {
+            priority: EventPriority.CRITICAL,
+          },
+        })
+      )
+
+      const payment = authorizePaymentSessionStep({
+        id: paymentSessions![0].id,
+      })
+
+      const orderTransactions = transform(
+        { payment, createdOrder },
+        ({ payment, createdOrder }) => {
+          const transactions =
+            (payment &&
+              payment?.captures?.map((capture) => {
+                return {
+                  order_id: createdOrder.id,
+                  amount: capture.raw_amount ?? capture.amount,
+                  currency_code: payment.currency_code,
+                  reference: "capture",
+                  reference_id: capture.id,
+                }
+              })) ??
+            []
+
+          return transactions
+        }
+      )
+
+      addOrderTransactionStep(orderTransactions)
+
+      const inventoryInput = transform(
+        { cart: cartData.data, createdOrder },
+        ({ cart, createdOrder }) => {
+          return {
+            order: createdOrder,
+            sales_channel_id: cart.sales_channel_id,
+            items: (cart.items ?? []).map((item) => ({
+              id: item.id,
+              variant_id: item.variant_id,
+              quantity: item.quantity,
+              inventory_items: item.variant?.inventory_items?.map(
+                (inventoryItem) => ({
+                  inventory_item_id: inventoryItem.inventory_item_id,
+                  required_quantity: inventoryItem.required_quantity,
+                  allow_backorder:
+                    item.variant?.manage_inventory === false ||
+                    item.variant?.allow_backorder === true,
+                  location_ids:
+                    inventoryItem.inventory?.location_levels?.map(
+                      (level) => level.location_id
+                    ) ?? [],
+                })
+              ),
+            })),
+          }
+        }
+      )
+
+      reserveInventoryAfterSubmitStep(inventoryInput)
+
+      const completedAttempt = completeCheckoutSubmitAttemptStep({
+        submit_attempt_id: submitAttempt.id,
+        order_id: createdOrder.id,
+      })
+
+      return transform(
+        { createdOrder, completedAttempt },
+        ({ createdOrder, completedAttempt }) => {
+          return {
+            order_id: createdOrder.id,
+            submit_attempt_id: completedAttempt.id,
+          } as SubmitCheckoutWorkflowOutput
+        }
+      )
+    })
+
+    return new WorkflowResponse(
+      transform(
+        { existingOrderResult, newOrderResult },
+        ({ existingOrderResult, newOrderResult }) => {
+          return (
+            existingOrderResult ??
+            newOrderResult ?? {
+              order_id: "",
+              submit_attempt_id: "",
+            }
+          )
+        }
+      )
+    )
+  }
+)
diff --git a/packages/core/core-flows/src/cart/workflows/index.ts b/packages/core/core-flows/src/cart/workflows/index.ts
index 01ff7cf7074..2f470cddfe4 100644
--- a/packages/core/core-flows/src/cart/workflows/index.ts
+++ b/packages/core/core-flows/src/cart/workflows/index.ts
@@ -1,4 +1,5 @@
 export * from "./add-shipping-method-to-cart"
 export * from "./add-to-cart"
 export * from "./complete-cart"
+export * from "./submit-checkout"
 export * from "./create-cart-credit-lines"
diff --git a/packages/core/core-flows/src/cart/steps/index.ts b/packages/core/core-flows/src/cart/steps/index.ts
index eaa729cf601..7b29fa7a233 100644
--- a/packages/core/core-flows/src/cart/steps/index.ts
+++ b/packages/core/core-flows/src/cart/steps/index.ts
@@ -10,6 +10,8 @@ export * from "./refresh-cart-promotions"
 export * from "./remove-shipping-method-from-cart"
 export * from "./reserve-inventory"
 export * from "./update-carts"
+export * from "./create-checkout-submit-attempt"
+export * from "./reserve-inventory-after-submit"
 export * from "./validate-cart"
 export * from "./validate-cart-items"
 export * from "./validate-cart-payments"
diff --git a/packages/modules/cart/src/models/checkout-submit-attempt.ts b/packages/modules/cart/src/models/checkout-submit-attempt.ts
new file mode 100644
index 00000000000..6464c934e35
--- /dev/null
+++ b/packages/modules/cart/src/models/checkout-submit-attempt.ts
@@ -0,0 +1,176 @@
+import { model } from "@medusajs/framework/utils"
+
+export const CheckoutSubmitAttempt = model
+  .define("checkout_submit_attempt", {
+    id: model.id({ prefix: "chksub" }).primaryKey(),
+    cart_id: model.text(),
+    idempotency_key: model.text(),
+    order_id: model.text().nullable(),
+    status: model.enum(["pending", "completed", "failed"]).default("pending"),
+    error_message: model.text().nullable(),
+    error_type: model.text().nullable(),
+    metadata: model.json().nullable(),
+    completed_at: model.dateTime().nullable(),
+    failed_at: model.dateTime().nullable(),
+  })
+  .indexes([
+    {
+      name: "IDX_checkout_submit_attempt_cart_id",
+      on: ["cart_id"],
+    },
+    {
+      name: "IDX_checkout_submit_attempt_idempotency_key",
+      on: ["idempotency_key"],
+    },
+    {
+      name: "IDX_checkout_submit_attempt_cart_id_idempotency_key",
+      on: ["cart_id", "idempotency_key"],
+    },
+    {
+      name: "IDX_checkout_submit_attempt_order_id",
+      on: ["order_id"],
+      where: "order_id IS NOT NULL",
+    },
+  ])
diff --git a/packages/modules/cart/src/models/index.ts b/packages/modules/cart/src/models/index.ts
index 565ab067cce..e87a735ea0a 100644
--- a/packages/modules/cart/src/models/index.ts
+++ b/packages/modules/cart/src/models/index.ts
@@ -1,6 +1,7 @@
 export { Cart } from "./cart"
 export { CartAddress } from "./cart-address"
 export { CartLineItem } from "./line-item"
 export { CartShippingMethod } from "./shipping-method"
+export { CheckoutSubmitAttempt } from "./checkout-submit-attempt"
 export { LineItemAdjustment } from "./line-item-adjustment"
 export { LineItemTaxLine } from "./line-item-tax-line"
 export { ShippingMethodAdjustment } from "./shipping-method-adjustment"
diff --git a/packages/core/types/src/cart/checkout-submit-attempt.ts b/packages/core/types/src/cart/checkout-submit-attempt.ts
new file mode 100644
index 00000000000..2dfcfd281c1
--- /dev/null
+++ b/packages/core/types/src/cart/checkout-submit-attempt.ts
@@ -0,0 +1,196 @@
+import { BigNumberInput, Context, FindConfig } from "../common"
+
+export type CheckoutSubmitAttemptStatus = "pending" | "completed" | "failed"
+
+export interface CheckoutSubmitAttemptDTO {
+  id: string
+  cart_id: string
+  idempotency_key: string
+  order_id: string | null
+  status: CheckoutSubmitAttemptStatus
+  error_message: string | null
+  error_type: string | null
+  metadata: Record<string, unknown> | null
+  completed_at: Date | string | null
+  failed_at: Date | string | null
+  created_at: Date | string
+  updated_at: Date | string
+  deleted_at: Date | string | null
+}
+
+export interface CreateCheckoutSubmitAttemptDTO {
+  cart_id: string
+  idempotency_key: string
+  status?: CheckoutSubmitAttemptStatus
+  order_id?: string | null
+  error_message?: string | null
+  error_type?: string | null
+  metadata?: Record<string, unknown> | null
+  completed_at?: Date | string | null
+  failed_at?: Date | string | null
+}
+
+export interface UpdateCheckoutSubmitAttemptDTO {
+  id: string
+  cart_id?: string
+  idempotency_key?: string
+  status?: CheckoutSubmitAttemptStatus
+  order_id?: string | null
+  error_message?: string | null
+  error_type?: string | null
+  metadata?: Record<string, unknown> | null
+  completed_at?: Date | string | null
+  failed_at?: Date | string | null
+}
+
+export interface FilterableCheckoutSubmitAttemptProps {
+  id?: string | string[]
+  cart_id?: string | string[]
+  idempotency_key?: string | string[]
+  order_id?: string | string[]
+  status?: CheckoutSubmitAttemptStatus | CheckoutSubmitAttemptStatus[]
+  created_at?: {
+    $gte?: Date | string
+    $lte?: Date | string
+  }
+  completed_at?: {
+    $gte?: Date | string
+    $lte?: Date | string
+  }
+  failed_at?: {
+    $gte?: Date | string
+    $lte?: Date | string
+  }
+}
+
+export interface CheckoutSubmitAttemptService {
+  createCheckoutSubmitAttempts(
+    data: CreateCheckoutSubmitAttemptDTO | CreateCheckoutSubmitAttemptDTO[],
+    sharedContext?: Context
+  ): Promise<CheckoutSubmitAttemptDTO | CheckoutSubmitAttemptDTO[]>
+
+  updateCheckoutSubmitAttempts(
+    data: UpdateCheckoutSubmitAttemptDTO | UpdateCheckoutSubmitAttemptDTO[],
+    sharedContext?: Context
+  ): Promise<CheckoutSubmitAttemptDTO | CheckoutSubmitAttemptDTO[]>
+
+  deleteCheckoutSubmitAttempts(
+    ids: string | string[],
+    sharedContext?: Context
+  ): Promise<void>
+
+  listCheckoutSubmitAttempts(
+    filters?: FilterableCheckoutSubmitAttemptProps,
+    config?: FindConfig<CheckoutSubmitAttemptDTO>,
+    sharedContext?: Context
+  ): Promise<CheckoutSubmitAttemptDTO[]>
+
+  findCompletedCheckoutSubmitAttempt(
+    cartId: string,
+    idempotencyKey: string,
+    sharedContext?: Context
+  ): Promise<CheckoutSubmitAttemptDTO | null>
+}
+
+export interface SubmitCheckoutInventoryLineDTO {
+  id: string
+  variant_id: string | null
+  quantity: BigNumberInput
+  inventory_items?: {
+    inventory_item_id: string
+    required_quantity: number
+    allow_backorder: boolean
+    location_ids: string[]
+  }[]
+}
+
+export interface SubmitCheckoutResultDTO {
+  order_id: string
+  submit_attempt_id: string
+}
diff --git a/packages/core/types/src/cart/index.ts b/packages/core/types/src/cart/index.ts
index 51f08822bc8..2c17ee59ff7 100644
--- a/packages/core/types/src/cart/index.ts
+++ b/packages/core/types/src/cart/index.ts
@@ -1,5 +1,6 @@
 export * from "./address"
 export * from "./cart"
+export * from "./checkout-submit-attempt"
 export * from "./common"
 export * from "./line-item"
 export * from "./shipping-method"
diff --git a/packages/modules/cart/src/migrations/Migration20260601090000.ts b/packages/modules/cart/src/migrations/Migration20260601090000.ts
new file mode 100644
index 00000000000..ac3197e0369
--- /dev/null
+++ b/packages/modules/cart/src/migrations/Migration20260601090000.ts
@@ -0,0 +1,216 @@
+import { Migration } from "@mikro-orm/migrations"
+
+export class Migration20260601090000 extends Migration {
+  async up(): Promise<void> {
+    this.addSql(
+      `create table if not exists "checkout_submit_attempt" (
+        "id" text not null,
+        "cart_id" text not null,
+        "idempotency_key" text not null,
+        "order_id" text null,
+        "status" text check ("status" in ('pending', 'completed', 'failed')) not null default 'pending',
+        "error_message" text null,
+        "error_type" text null,
+        "metadata" jsonb null,
+        "completed_at" timestamptz null,
+        "failed_at" timestamptz null,
+        "created_at" timestamptz not null default now(),
+        "updated_at" timestamptz not null default now(),
+        "deleted_at" timestamptz null,
+        constraint "checkout_submit_attempt_pkey" primary key ("id")
+      );`
+    )
+
+    this.addSql(
+      `create index if not exists "IDX_checkout_submit_attempt_cart_id"
+        on "checkout_submit_attempt" ("cart_id")
+        where "deleted_at" is null;`
+    )
+
+    this.addSql(
+      `create index if not exists "IDX_checkout_submit_attempt_idempotency_key"
+        on "checkout_submit_attempt" ("idempotency_key")
+        where "deleted_at" is null;`
+    )
+
+    this.addSql(
+      `create index if not exists "IDX_checkout_submit_attempt_cart_key"
+        on "checkout_submit_attempt" ("cart_id", "idempotency_key")
+        where "deleted_at" is null;`
+    )
+
+    this.addSql(
+      `create index if not exists "IDX_checkout_submit_attempt_order_id"
+        on "checkout_submit_attempt" ("order_id")
+        where "order_id" is not null and "deleted_at" is null;`
+    )
+  }
+
+  async down(): Promise<void> {
+    this.addSql(`drop table if exists "checkout_submit_attempt";`)
+  }
+}
diff --git a/packages/modules/cart/src/services/cart-module-service.ts b/packages/modules/cart/src/services/cart-module-service.ts
index 23c732ae006..a3fe0ea1215 100644
--- a/packages/modules/cart/src/services/cart-module-service.ts
+++ b/packages/modules/cart/src/services/cart-module-service.ts
@@ -1,6 +1,16 @@
 import {
+  CheckoutSubmitAttemptDTO,
   Context,
+  CreateCheckoutSubmitAttemptDTO,
+  FilterableCheckoutSubmitAttemptProps,
   FindConfig,
+  UpdateCheckoutSubmitAttemptDTO,
 } from "@medusajs/framework/types"
 import { MedusaService } from "@medusajs/framework/utils"
 import {
@@ -18,6 +18,7 @@ import {
   CartAddress,
   CartLineItem,
   CartShippingMethod,
+  CheckoutSubmitAttempt,
 } from "../models"
 import { CartRepository } from "../repositories/cart"
 
@@ -69,6 +70,7 @@ class CartModuleService extends MedusaService({
   CartAddress,
   CartLineItem,
   CartShippingMethod,
+  CheckoutSubmitAttempt,
 }) {
   protected readonly cartRepository_: CartRepository
 
@@ -190,6 +192,125 @@ class CartModuleService extends MedusaService({
     return await this.cartRepository_.findAndCount(findConfig)
   }
+
+  async createCheckoutSubmitAttempts(
+    data:
+      | CreateCheckoutSubmitAttemptDTO
+      | CreateCheckoutSubmitAttemptDTO[],
+    sharedContext: Context = {}
+  ): Promise<CheckoutSubmitAttemptDTO | CheckoutSubmitAttemptDTO[]> {
+    return await this.createCheckoutSubmitAttempts_(data, sharedContext)
+  }
+
+  async updateCheckoutSubmitAttempts(
+    data:
+      | UpdateCheckoutSubmitAttemptDTO
+      | UpdateCheckoutSubmitAttemptDTO[],
+    sharedContext: Context = {}
+  ): Promise<CheckoutSubmitAttemptDTO | CheckoutSubmitAttemptDTO[]> {
+    return await this.updateCheckoutSubmitAttempts_(data, sharedContext)
+  }
+
+  async deleteCheckoutSubmitAttempts(
+    ids: string | string[],
+    sharedContext: Context = {}
+  ): Promise<void> {
+    return await this.deleteCheckoutSubmitAttempts_(ids, sharedContext)
+  }
+
+  async listCheckoutSubmitAttempts(
+    filters: FilterableCheckoutSubmitAttemptProps = {},
+    config: FindConfig<CheckoutSubmitAttemptDTO> = {},
+    sharedContext: Context = {}
+  ): Promise<CheckoutSubmitAttemptDTO[]> {
+    return await this.listCheckoutSubmitAttempts_(
+      filters,
+      config,
+      sharedContext
+    )
+  }
+
+  async findCompletedCheckoutSubmitAttempt(
+    cartId: string,
+    idempotencyKey: string,
+    sharedContext: Context = {}
+  ): Promise<CheckoutSubmitAttemptDTO | null> {
+    const attempts = await this.listCheckoutSubmitAttempts(
+      {
+        cart_id: cartId,
+        idempotency_key: idempotencyKey,
+        status: ["completed"],
+      },
+      {
+        take: 1,
+        order: {
+          created_at: "DESC",
+        },
+      },
+      sharedContext
+    )
+
+    return attempts[0] ?? null
+  }
 }
 
 export default CartModuleService
diff --git a/packages/medusa/src/api/store/carts/[id]/submit/__tests__/submit.spec.ts b/packages/medusa/src/api/store/carts/[id]/submit/__tests__/submit.spec.ts
new file mode 100644
index 00000000000..2cc9163a27c
--- /dev/null
+++ b/packages/medusa/src/api/store/carts/[id]/submit/__tests__/submit.spec.ts
@@ -0,0 +1,420 @@
+import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
+import {
+  createAdminUser,
+  createStoreCart,
+  createStoreProduct,
+  createStoreRegion,
+  createStoreShippingOption,
+  createStoreStockLocation,
+} from "../../../../../__fixtures__"
+
+medusaIntegrationTestRunner({
+  testSuite: ({ api, getContainer }) => {
+    describe("POST /store/carts/:id/submit", () => {
+      let region
+      let product
+      let shippingOption
+      let stockLocation
+
+      beforeEach(async () => {
+        const container = getContainer()
+        await createAdminUser(container)
+        region = await createStoreRegion(container)
+        stockLocation = await createStoreStockLocation(container)
+        product = await createStoreProduct(container, {
+          title: "Submit endpoint product",
+          variants: [
+            {
+              title: "Default",
+              manage_inventory: true,
+              inventory_quantity: 5,
+            },
+          ],
+          stock_location_id: stockLocation.id,
+        })
+        shippingOption = await createStoreShippingOption(container, {
+          region_id: region.id,
+        })
+      })
+
+      it("submits a cart and returns an order", async () => {
+        const cart = await createReadyCart(api, {
+          region_id: region.id,
+          product_variant_id: product.variants[0].id,
+          shipping_option_id: shippingOption.id,
+        })
+
+        const response = await api.post(`/store/carts/${cart.id}/submit`, {
+          idempotency_key: "submit-cart-once",
+        })
+
+        expect(response.status).toBe(200)
+        expect(response.data.type).toBe("order")
+        expect(response.data.order.id).toEqual(expect.stringContaining("order_"))
+        expect(response.data.submit_attempt_id).toEqual(
+          expect.stringContaining("chksub_")
+        )
+      })
+
+      it("returns the same order for a repeated idempotency key", async () => {
+        const cart = await createReadyCart(api, {
+          region_id: region.id,
+          product_variant_id: product.variants[0].id,
+          shipping_option_id: shippingOption.id,
+        })
+
+        const first = await api.post(`/store/carts/${cart.id}/submit`, {
+          idempotency_key: "retry-key",
+        })
+        const second = await api.post(`/store/carts/${cart.id}/submit`, {
+          idempotency_key: "retry-key",
+        })
+
+        expect(first.status).toBe(200)
+        expect(second.status).toBe(200)
+        expect(first.data.type).toBe("order")
+        expect(second.data.type).toBe("order")
+        expect(second.data.order.id).toBe(first.data.order.id)
+      })
+
+      it("uses the Idempotency-Key header when no body key is provided", async () => {
+        const cart = await createReadyCart(api, {
+          region_id: region.id,
+          product_variant_id: product.variants[0].id,
+          shipping_option_id: shippingOption.id,
+        })
+
+        const response = await api.post(
+          `/store/carts/${cart.id}/submit`,
+          {},
+          {
+            headers: {
+              "Idempotency-Key": "header-submit-key",
+            },
+          }
+        )
+
+        expect(response.status).toBe(200)
+        expect(response.data.type).toBe("order")
+      })
+
+      it("returns the cart when payment requires customer action", async () => {
+        const cart = await createReadyCart(api, {
+          region_id: region.id,
+          product_variant_id: product.variants[0].id,
+          shipping_option_id: shippingOption.id,
+          payment_requires_more: true,
+        })
+
+        const response = await api.post(`/store/carts/${cart.id}/submit`, {
+          idempotency_key: "requires-more",
+          return_cart: true,
+        })
+
+        expect(response.status).toBe(200)
+        expect(response.data.type).toBe("cart")
+        expect(response.data.cart.id).toBe(cart.id)
+        expect(response.data.error.type).toBe("payment_requires_more")
+      })
+
+      it("allows a second submit when the caller intentionally changes keys", async () => {
+        const cart = await createReadyCart(api, {
+          region_id: region.id,
+          product_variant_id: product.variants[0].id,
+          shipping_option_id: shippingOption.id,
+        })
+
+        const first = await api.post(`/store/carts/${cart.id}/submit`, {
+          idempotency_key: "first-submit",
+        })
+        const second = await api.post(`/store/carts/${cart.id}/submit`, {
+          idempotency_key: "manual-retry-after-refresh",
+        })
+
+        expect(first.status).toBe(200)
+        expect(second.status).toBe(200)
+        expect(second.data.type).toBe("order")
+      })
+
+      async function createReadyCart(
+        api,
+        {
+          region_id,
+          product_variant_id,
+          shipping_option_id,
+          payment_requires_more = false,
+        }
+      ) {
+        const cart = await createStoreCart(api, {
+          region_id,
+          email: "checkout-submit@example.com",
+        })
+
+        await api.post(`/store/carts/${cart.id}/line-items`, {
+          variant_id: product_variant_id,
+          quantity: 1,
+        })
+
+        await api.post(`/store/carts/${cart.id}/shipping-methods`, {
+          option_id: shipping_option_id,
+        })
+
+        await api.post(`/store/carts/${cart.id}/payment-collections`, {})
+
+        if (payment_requires_more) {
+          await api.post(
+            `/store/carts/${cart.id}/payment-collections/sessions`,
+            {
+              provider_id: "requires_more_provider",
+            }
+          )
+        } else {
+          await api.post(
+            `/store/carts/${cart.id}/payment-collections/sessions`,
+            {
+              provider_id: "manual",
+            }
+          )
+        }
+
+        return cart
+      }
+    })
+  },
+})
diff --git a/packages/core/core-flows/src/cart/steps/__tests__/reserve-inventory-after-submit.spec.ts b/packages/core/core-flows/src/cart/steps/__tests__/reserve-inventory-after-submit.spec.ts
new file mode 100644
index 00000000000..6cefa6a5b80
--- /dev/null
+++ b/packages/core/core-flows/src/cart/steps/__tests__/reserve-inventory-after-submit.spec.ts
@@ -0,0 +1,318 @@
+import { describe, expect, it, vi, beforeEach } from "vitest"
+import { Modules } from "@medusajs/framework/utils"
+import { reserveInventoryAfterSubmitStep } from "../reserve-inventory-after-submit"
+
+describe("reserveInventoryAfterSubmitStep", () => {
+  const createReservationItems = vi.fn()
+  const deleteReservationItems = vi.fn()
+  const execute = vi.fn()
+  const container = {
+    resolve: vi.fn((key) => {
+      if (key === Modules.INVENTORY) {
+        return {
+          createReservationItems,
+          deleteReservationItems,
+        }
+      }
+
+      if (key === Modules.LOCKING) {
+        return {
+          execute,
+        }
+      }
+
+      throw new Error(`Unexpected module ${String(key)}`)
+    }),
+  }
+
+  beforeEach(() => {
+    vi.clearAllMocks()
+    execute.mockImplementation(async (_keys, callback) => {
+      return await callback()
+    })
+    createReservationItems.mockResolvedValue([
+      {
+        id: "resitem_1",
+      },
+    ])
+  })
+
+  it("creates reservation items for submitted order line items", async () => {
+    const step = reserveInventoryAfterSubmitStep
+    const result = await step.invoke(
+      {
+        order: {
+          id: "order_123",
+        },
+        sales_channel_id: "sc_123",
+        items: [
+          {
+            id: "ordli_123",
+            variant_id: "variant_123",
+            quantity: 2,
+            inventory_items: [
+              {
+                inventory_item_id: "iitem_123",
+                required_quantity: 1,
+                allow_backorder: false,
+                location_ids: ["sloc_123"],
+              },
+            ],
+          },
+        ],
+      },
+      {
+        container,
+      } as never
+    )
+
+    expect(execute).toHaveBeenCalledWith(["iitem_123"], expect.any(Function))
+    expect(createReservationItems).toHaveBeenCalledWith([
+      {
+        line_item_id: "ordli_123",
+        inventory_item_id: "iitem_123",
+        quantity: 2,
+        allow_backorder: false,
+        location_id: "sloc_123",
+        metadata: {
+          variant_id: "variant_123",
+          order_id: "order_123",
+          checkout_submit: true,
+        },
+      },
+    ])
+    expect(result).toEqual(["resitem_1"])
+  })
+
+  it("does not create reservations for non-inventory variants", async () => {
+    const result = await reserveInventoryAfterSubmitStep.invoke(
+      {
+        order: {
+          id: "order_123",
+        },
+        sales_channel_id: "sc_123",
+        items: [
+          {
+            id: "ordli_no_inventory",
+            variant_id: "variant_no_inventory",
+            quantity: 1,
+            inventory_items: [],
+          },
+        ],
+      },
+      {
+        container,
+      } as never
+    )
+
+    expect(result).toEqual([])
+    expect(createReservationItems).not.toHaveBeenCalled()
+  })
+
+  it("locks every inventory item once", async () => {
+    await reserveInventoryAfterSubmitStep.invoke(
+      {
+        order: {
+          id: "order_123",
+        },
+        sales_channel_id: "sc_123",
+        items: [
+          {
+            id: "ordli_1",
+            variant_id: "variant_123",
+            quantity: 1,
+            inventory_items: [
+              {
+                inventory_item_id: "iitem_123",
+                required_quantity: 1,
+                allow_backorder: false,
+                location_ids: ["sloc_123"],
+              },
+            ],
+          },
+          {
+            id: "ordli_2",
+            variant_id: "variant_456",
+            quantity: 1,
+            inventory_items: [
+              {
+                inventory_item_id: "iitem_123",
+                required_quantity: 1,
+                allow_backorder: false,
+                location_ids: ["sloc_123"],
+              },
+              {
+                inventory_item_id: "iitem_456",
+                required_quantity: 1,
+                allow_backorder: false,
+                location_ids: ["sloc_456"],
+              },
+            ],
+          },
+        ],
+      },
+      {
+        container,
+      } as never
+    )
+
+    expect(execute).toHaveBeenCalledWith(
+      ["iitem_123", "iitem_456"],
+      expect.any(Function)
+    )
+  })
+
+  it("compensates created reservations", async () => {
+    await reserveInventoryAfterSubmitStep.compensate(
+      {
+        reservation_ids: ["resitem_1", "resitem_2"],
+        inventory_item_ids: ["iitem_1", "iitem_2"],
+      },
+      {
+        container,
+      } as never
+    )
+
+    expect(execute).toHaveBeenCalledWith(
+      ["iitem_1", "iitem_2"],
+      expect.any(Function)
+    )
+    expect(deleteReservationItems).toHaveBeenCalledWith([
+      "resitem_1",
+      "resitem_2",
+    ])
+  })
+
+  it("does nothing when compensation has no reservation ids", async () => {
+    await reserveInventoryAfterSubmitStep.compensate(
+      {
+        reservation_ids: [],
+        inventory_item_ids: [],
+      },
+      {
+        container,
+      } as never
+    )
+
+    expect(deleteReservationItems).not.toHaveBeenCalled()
+  })
+
+  it("throws inventory service errors to the workflow", async () => {
+    createReservationItems.mockRejectedValueOnce(new Error("out of stock"))
+
+    await expect(
+      reserveInventoryAfterSubmitStep.invoke(
+        {
+          order: {
+            id: "order_123",
+          },
+          sales_channel_id: "sc_123",
+          items: [
+            {
+              id: "ordli_123",
+              variant_id: "variant_123",
+              quantity: 1,
+              inventory_items: [
+                {
+                  inventory_item_id: "iitem_123",
+                  required_quantity: 1,
+                  allow_backorder: false,
+                  location_ids: ["sloc_123"],
+                },
+              ],
+            },
+          ],
+        },
+        {
+          container,
+        } as never
+      )
+    ).rejects.toThrow("out of stock")
+  })
+})
diff --git a/packages/core/core-flows/src/cart/workflows/__tests__/submit-checkout.spec.ts b/packages/core/core-flows/src/cart/workflows/__tests__/submit-checkout.spec.ts
new file mode 100644
index 00000000000..38eb401d83b
--- /dev/null
+++ b/packages/core/core-flows/src/cart/workflows/__tests__/submit-checkout.spec.ts
@@ -0,0 +1,360 @@
+import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
+import { Modules } from "@medusajs/framework/utils"
+import { submitCheckoutWorkflow } from "../submit-checkout"
+
+moduleIntegrationTestRunner({
+  moduleName: Modules.CART,
+  testSuite: ({ getContainer }) => {
+    describe("submitCheckoutWorkflow", () => {
+      it("creates a checkout submit attempt before returning an order", async () => {
+        const container = getContainer()
+        const cart = await createCartFixture(container)
+
+        const { result } = await submitCheckoutWorkflow(container).run({
+          input: {
+            cart_id: cart.id,
+            idempotency_key: "workflow-submit-key",
+          },
+        })
+
+        const cartModule = container.resolve(Modules.CART)
+        const attempts = await cartModule.listCheckoutSubmitAttempts({
+          cart_id: cart.id,
+          idempotency_key: "workflow-submit-key",
+        })
+
+        expect(result.order_id).toEqual(expect.stringContaining("order_"))
+        expect(result.submit_attempt_id).toEqual(attempts[0].id)
+        expect(attempts[0].status).toBe("completed")
+      })
+
+      it("reuses a completed checkout submit attempt", async () => {
+        const container = getContainer()
+        const cart = await createCartFixture(container)
+
+        const first = await submitCheckoutWorkflow(container).run({
+          input: {
+            cart_id: cart.id,
+            idempotency_key: "workflow-retry-key",
+          },
+        })
+
+        const second = await submitCheckoutWorkflow(container).run({
+          input: {
+            cart_id: cart.id,
+            idempotency_key: "workflow-retry-key",
+          },
+        })
+
+        expect(second.result.order_id).toBe(first.result.order_id)
+        expect(second.result.submit_attempt_id).toBe(
+          first.result.submit_attempt_id
+        )
+      })
+
+      it("stores submit metadata for later support inspection", async () => {
+        const container = getContainer()
+        const cart = await createCartFixture(container)
+
+        await submitCheckoutWorkflow(container).run({
+          input: {
+            cart_id: cart.id,
+            idempotency_key: "workflow-metadata-key",
+            metadata: {
+              user_agent: "Mozilla/5.0",
+              source: "store-api",
+            },
+          },
+        })
+
+        const cartModule = container.resolve(Modules.CART)
+        const attempts = await cartModule.listCheckoutSubmitAttempts({
+          cart_id: cart.id,
+          idempotency_key: "workflow-metadata-key",
+        })
+
+        expect(attempts[0].metadata).toEqual({
+          user_agent: "Mozilla/5.0",
+          source: "store-api",
+        })
+      })
+
+      it("allows a different idempotency key for manual support retries", async () => {
+        const container = getContainer()
+        const cart = await createCartFixture(container)
+
+        const first = await submitCheckoutWorkflow(container).run({
+          input: {
+            cart_id: cart.id,
+            idempotency_key: "workflow-key-1",
+          },
+        })
+
+        const second = await submitCheckoutWorkflow(container).run({
+          input: {
+            cart_id: cart.id,
+            idempotency_key: "workflow-key-2",
+          },
+        })
+
+        expect(first.result.order_id).toEqual(expect.stringContaining("order_"))
+        expect(second.result.order_id).toEqual(expect.stringContaining("order_"))
+      })
+
+      async function createCartFixture(container) {
+        const cartModule = container.resolve(Modules.CART)
+        const cart = await cartModule.createCarts({
+          currency_code: "usd",
+          email: "workflow-submit@example.com",
+          completed_at: null,
+          items: [
+            {
+              title: "Workflow product",
+              quantity: 1,
+              unit_price: 1000,
+              variant_id: "variant_123",
+            },
+          ],
+          shipping_methods: [
+            {
+              name: "Default shipping",
+              amount: 100,
+              shipping_option_id: "so_123",
+            },
+          ],
+        })
+
+        return cart
+      }
+    })
+  },
+})
diff --git a/www/apps/api-reference/specs/store/paths/store_carts_{id}_submit.yaml b/www/apps/api-reference/specs/store/paths/store_carts_{id}_submit.yaml
new file mode 100644
index 00000000000..c2a927bda03
--- /dev/null
+++ b/www/apps/api-reference/specs/store/paths/store_carts_{id}_submit.yaml
@@ -0,0 +1,286 @@
+post:
+  operationId: PostCartsIdSubmit
+  summary: Submit a Cart
+  description: |
+    Submit a cart and create an order.
+
+    This endpoint is intended for storefront checkout buttons and payment
+    redirect retries. It accepts an optional idempotency key in the request body
+    or the `Idempotency-Key` header.
+
+    Repeating the same cart and idempotency key returns the same order. The
+    endpoint will not create an order unless the cart can be paid for and
+    inventory can be reserved.
+  x-authenticated: false
+  parameters:
+    - name: id
+      in: path
+      description: The cart ID.
+      required: true
+      schema:
+        type: string
+    - name: Idempotency-Key
+      in: header
+      required: false
+      description: Optional key used to deduplicate checkout submit retries.
+      schema:
+        type: string
+  requestBody:
+    required: false
+    content:
+      application/json:
+        schema:
+          type: object
+          properties:
+            idempotency_key:
+              type: string
+              description: Optional key used to deduplicate checkout submit retries.
+            return_cart:
+              type: boolean
+              description: Return the cart if checkout cannot be completed.
+            metadata:
+              type: object
+              additionalProperties: true
+  responses:
+    "200":
+      description: The order created from the cart or the still-actionable cart.
+      content:
+        application/json:
+          schema:
+            oneOf:
+              - type: object
+                required:
+                  - type
+                  - order
+                  - submit_attempt_id
+                properties:
+                  type:
+                    type: string
+                    enum:
+                      - order
+                  submit_attempt_id:
+                    type: string
+                  order:
+                    $ref: ../components/schemas/StoreOrder.yaml
+              - type: object
+                required:
+                  - type
+                  - cart
+                properties:
+                  type:
+                    type: string
+                    enum:
+                      - cart
+                  submit_attempt_id:
+                    type: string
+                  cart:
+                    $ref: ../components/schemas/StoreCart.yaml
+                  error:
+                    type: object
+                    properties:
+                      message:
+                        type: string
+                      name:
+                        type: string
+                      type:
+                        type: string
+    "400":
+      description: The cart is invalid or cannot be submitted.
+    "409":
+      description: The cart submit is already in progress.
+    "500":
+      description: Unexpected error.
diff --git a/www/apps/book/app/resources/references/store/checkout-submit/page.mdx b/www/apps/book/app/resources/references/store/checkout-submit/page.mdx
new file mode 100644
index 00000000000..c21cc96baf4
--- /dev/null
+++ b/www/apps/book/app/resources/references/store/checkout-submit/page.mdx
@@ -0,0 +1,188 @@
+---
+title: Checkout Submit
+description: Submit a cart from a storefront checkout flow.
+---
+
+import { Card, CodeTabs } from "@/components"
+
+The checkout submit route is an alternative to the complete cart route for
+storefronts that want an explicit submit operation.
+
+```http
+POST /store/carts/{id}/submit
+```
+
+The endpoint creates an order from the cart and returns either:
+
+- `type: "order"` when checkout succeeds.
+- `type: "cart"` when the cart needs customer action.
+
+## Idempotency
+
+Checkout submit accepts an optional `idempotency_key` in the request body or an
+`Idempotency-Key` header.
+
+Use the same key when retrying a request after a network timeout. When the cart
+and key match a previous completed attempt, the endpoint returns the same order.
+
+If no key is supplied, Medusa creates one for the request.
+
+```ts
+await sdk.store.cart.submit(cart.id, {
+  idempotency_key: "checkout-button-click-1",
+})
+```
+
+## Example Response
+
+```json
+{
+  "type": "order",
+  "submit_attempt_id": "chksub_01J...",
+  "order": {
+    "id": "order_01J...",
+    "status": "pending"
+  }
+}
+```
+
+## Payment Errors
+
+When a payment provider requires additional customer action, pass
+`return_cart: true` to receive the cart and error details.
+
+```json
+{
+  "type": "cart",
+  "submit_attempt_id": "chksub_01J...",
+  "cart": {
+    "id": "cart_01J..."
+  },
+  "error": {
+    "type": "payment_requires_more",
+    "message": "Payment requires additional action"
+  }
+}
+```
+
+## Inventory
+
+The endpoint reserves inventory as part of checkout submit. If inventory cannot
+be reserved, the endpoint returns an error and no order is created.
+
+Inventory reservation is performed by the checkout submit workflow after the
+order is created and linked to the cart. The workflow compensates reservations
+when a later step fails.
+
+## Storefront Guidance
+
+Disable the checkout button after the first click. Retry with the same
+idempotency key if the request times out.
+
+Do not generate a new idempotency key for every retry of the same customer
+action. A new key represents a new checkout submit attempt.
+
+## Support Guidance
+
+Support teams can search checkout submit attempts by:
+
+- cart ID
+- idempotency key
+- order ID
+- status
+
+Completed attempts contain the order ID. Failed attempts include the error
+message and error type captured by the workflow.
+
+## Limitations
+
+The initial checkout submit route does not expose a public status endpoint for
+pending attempts. Storefronts should retry the original request with the same
+idempotency key if the connection closes before a response is received.
+
+The route is additive. Existing storefronts can continue to use
+`POST /store/carts/{id}/complete`.
+
+Storefronts should treat submit as the final cart mutation for a customer
+checkout action.
```

## Intended Flaws

### Flaw 1: Submit Idempotency Is Not A Cart Completion Boundary

- `type`: `idempotency_gap`
- `location`: `packages/core/core-flows/src/cart/workflows/submit-checkout.ts:78-281`, `packages/core/core-flows/src/cart/steps/create-checkout-submit-attempt.ts:28-61`, `packages/modules/cart/src/migrations/Migration20260601090000.ts:28-46`
- `learner_prompt`: Does the new endpoint actually prevent duplicate orders for the same cart under retries and double-submit concurrency?

Expected answer:

- `identify`: The workflow creates idempotency records without a unique `(cart_id, idempotency_key)` constraint and without acquiring the cart lock before checking existing attempts/order links. Two concurrent submits can both find no completed attempt and no `order_cart` link, both create an order, and only later complete separate attempts. The route also generates a fresh random idempotency key when the caller omits one, so ordinary browser double-clicks are not deduped by cart state.
- `impact`: Checkout is one of the most expensive places to get idempotency wrong. A customer double-click, mobile retry, payment redirect replay, or load-balancer retry can create duplicate orders from the same cart, potentially duplicate payment authorization/capture, duplicate fulfillment, duplicate promotion usage, and support-visible order confusion. The attempt table gives the appearance of safety while not owning the atomic transition from cart to order.
- `fix_direction`: Reuse or wrap the existing `completeCartWorkflow` boundary instead of rebuilding completion. Acquire the cart lock before reading submit attempts/order links, enforce a database uniqueness invariant for active `(cart_id, idempotency_key)` and for cart-to-order completion, and make missing client keys fall back to cart-level completion idempotency rather than a new random key per request. The first durable write should be the guarded completion transition, not an informational attempt row.

Hints:

1. Follow the state transition from "cart not completed" to "order exists" rather than starting with the route.
2. Ask which row or lock makes two concurrent requests serialize on the same cart.
3. The migration creates indexes, but no unique constraint; the workflow reads before writing under no cart lock.

### Flaw 2: Inventory Reservation Happens After The Order Is Already Committed

- `type`: `consistency_gap`
- `location`: `packages/core/core-flows/src/cart/workflows/submit-checkout.ts:286-375`, `packages/core/core-flows/src/cart/workflows/submit-checkout.ts:406-455`, `packages/core/core-flows/src/cart/steps/reserve-inventory-after-submit.ts:22-62`
- `learner_prompt`: Does the new submit workflow preserve the existing ordering between inventory reservation, cart completion, order creation, and customer-visible order placement?

Expected answer:

- `identify`: The workflow creates the order, links order/cart, marks the cart completed, registers promotion usage, and emits `order.placed` before it calls `reserveInventoryAfterSubmitStep`. Inventory is now a post-commit side effect on an already-created order, not a compensatable step in the same protected completion sequence.
- `impact`: If inventory is gone, the system can still expose an order, mark the cart completed, emit order placed, register promotion usage, and possibly authorize payment before reservation fails. That creates orders that cannot be fulfilled, requires manual cancellation/refunds, and breaks the existing invariant that a normal completed cart either reserves stock as part of completion or fails before the customer sees an order.
- `fix_direction`: Keep reservation inside the checkout workflow before customer-visible order placement and before irreversible side effects. Prefer the existing `reserveInventoryStep`/`completeCartWorkflow` ordering, with compensation for created reservations and no `order.placed` event until inventory and payment-sensitive invariants are satisfied. If submit needs extra attempt tracking, attach it around the existing workflow rather than moving inventory after order commit.

Hints:

1. Compare the order of side effects in `completeCartWorkflow` with the new submit workflow.
2. Find where `order.placed`, `updateCartsStep`, and `reserveInventoryAfterSubmitStep` appear relative to each other.
3. The PR docs promise no order without inventory reservation, but the code emits and links the order first.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the missing atomic cart completion/idempotency boundary, not merely say "there should be an idempotency key." The key evidence is the combination of no cart lock, no unique constraint, read-before-write attempt logic, and random fallback keys.

For flaw 2, a correct answer must identify that inventory moved after order creation/customer-visible side effects. Answers that only say "inventory reservation could fail" are incomplete without explaining the broken ordering and compensation boundary.

### Product-Level Change

The PR tries to create a nicer checkout submit API for storefronts. That is a real product need: checkout buttons get clicked twice, payment redirects replay requests, and clients want a response that feels more explicit than "complete cart." But checkout submit is not just an endpoint. It is the cart-to-order state transition.

### Changed Contracts

- API contract: `POST /store/carts/:id/submit` promises retry-safe cart submission.
- Idempotency contract: same cart/key should return the same order and missing keys should not make double-clicks dangerous.
- Database contract: `checkout_submit_attempt` is introduced as durable retry state.
- Workflow contract: order creation, order-cart linking, cart completion, promotion usage, inventory reservation, event emission, and payment authorization are reordered.
- Inventory contract: stock reservation is no longer part of the protected completion sequence before order placement.

### Failure Modes

A customer double-clicks "Place order" or a mobile client retries after a network timeout. Two requests enter the workflow together. Both see no completed attempt and no order-cart link. Both create an order. The attempt table later records completed attempts, but by then duplicate orders exist.

Separately, a hot SKU sells out between validation and reservation. The new workflow can expose an order, complete the cart, emit `order.placed`, and then fail inventory reservation. The customer and downstream fulfillment now see an order that should never have been placed.

### Reviewer Thought Process

A strong reviewer does not start by reading the new route top-to-bottom. They first ask: what is the single state transition this PR owns? Here it is "cart becomes order." Then they locate every guard around that transition: locks, unique constraints, existing links, workflow idempotency, compensation, and order of side effects.

The second move is to compare promises to durable invariants. The docs say retry-safe and no order without inventory. The database has indexes but no uniqueness. The workflow creates the order before reservation. That mismatch is where the review should focus.

### Better Implementation Direction

Keep the product shape but do not fork cart completion:

- Make `submit` a thin route over `completeCartWorkflow` or a wrapper workflow that acquires the same cart lock.
- Store idempotency attempts with a unique active `(cart_id, idempotency_key)` constraint.
- Return an existing `order_cart` link for repeated submits, even when the client omitted a key.
- Do inventory reservation in the existing workflow position, before customer-visible order placement and before `order.placed`.
- Add concurrency tests that submit the same cart twice in parallel with the same and missing idempotency keys.
- Add an out-of-stock test proving no order/cart completion/event exists when reservation fails.

## Why This Case Exists

AI-generated checkout code often looks sophisticated because it adds an idempotency table, metadata, docs, and tests. The important review skill is to ask whether those pieces actually guard the business transition. Great engineers look for the atomic boundary, not the presence of an "idempotency" noun.
