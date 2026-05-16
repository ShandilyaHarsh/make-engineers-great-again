# TS-014: Medusa Checkout Inventory Reservations

## Metadata

- `id`: TS-014
- `source_repo`: [medusajs/medusa](https://github.com/medusajs/medusa)
- `repo_area`: cart completion workflow, inventory module, reservation models, store cart completion API, scheduled cleanup jobs
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 900
- `flaw_count`: 2

## PR Description Shown To Learner

This PR adds checkout inventory reservations so items are held while a cart is being completed.

Today Medusa checks inventory when items are added to the cart and reserves inventory during cart completion. That still allows a tight race: two shoppers can attempt to complete carts for the last unit at roughly the same time. The new implementation creates short-lived checkout reservation rows before running `completeCartWorkflow`, attaches those reservations to the order after creation, and releases expired reservations with a scheduled job.

The feature is meant to reduce oversells during payment authorization and make inventory holds visible in admin/debugging tools.

## Existing Code Context

The real Medusa codebase already has these relevant contracts:

- `packages/medusa/src/api/store/carts/[id]/complete/route.ts` runs `completeCartWorkflow` through the workflow engine and returns either an order or the still-actionable cart.
- `packages/core/core-flows/src/cart/workflows/complete-cart.ts` acquires a cart lock, checks the existing `order_cart` link, creates the order once, then reserves inventory through `reserveInventoryStep`.
- `packages/core/core-flows/src/cart/steps/reserve-inventory.ts` resolves `Modules.INVENTORY`, locks by inventory item id, creates reservation items, and deletes those reservations in workflow compensation.
- `packages/modules/inventory/src/services/inventory-module.ts` creates reservation items inside the inventory module and updates `inventory_level.reserved_quantity` in the same service transaction.
- `packages/modules/inventory/src/models/reservation-item.ts` models reservation rows with `line_item_id`, `inventory_item_id`, `location_id`, and `quantity`.
- `completeCartWorkflow` is explicitly non-idempotent, so the existing code relies on the cart lock, `order_cart` link, workflow steps, and compensation instead of random side effects around the route.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/modules/inventory/src/models/checkout-reservation.ts`
- `packages/modules/inventory/src/models/inventory-item.ts`
- `packages/modules/inventory/src/models/index.ts`
- `packages/modules/inventory/src/schema/index.ts`
- `packages/modules/inventory/src/migrations/Migration20260218094500.ts`
- `packages/modules/inventory/src/services/inventory-module.ts`
- `packages/core/core-flows/src/cart/steps/attach-checkout-reservations-to-order.ts`
- `packages/core/core-flows/src/cart/steps/index.ts`
- `packages/core/core-flows/src/cart/workflows/complete-cart.ts`
- `packages/medusa/src/api/store/carts/[id]/complete/route.ts`
- `packages/medusa/src/jobs/release-expired-checkout-reservations.ts`
- `integration-tests/http/__tests__/cart/store/checkout-reservations.spec.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally focused on the backend contract and is over the 500-line threshold.

## Diff

```diff
diff --git a/packages/modules/inventory/src/models/checkout-reservation.ts b/packages/modules/inventory/src/models/checkout-reservation.ts
new file mode 100644
index 0000000000..8d1d7e2d01
--- /dev/null
+++ b/packages/modules/inventory/src/models/checkout-reservation.ts
@@ -0,0 +1,61 @@
+import { model } from "@medusajs/framework/utils"
+import InventoryItem from "./inventory-item"
+
+export enum CheckoutReservationStatus {
+  PENDING = "pending",
+  ATTACHED = "attached",
+  RELEASED = "released",
+}
+
+const CheckoutReservation = model
+  .define("CheckoutReservation", {
+    id: model.id({ prefix: "chkres" }).primaryKey(),
+    cart_id: model.text(),
+    order_id: model.text().nullable(),
+    line_item_id: model.text(),
+    location_id: model.text(),
+    quantity: model.bigNumber(),
+    raw_quantity: model.json(),
+    required_quantity: model.number().default(1),
+    allow_backorder: model.boolean().default(false),
+    status: model.enum(CheckoutReservationStatus).default(
+      CheckoutReservationStatus.PENDING
+    ),
+    expires_at: model.dateTime(),
+    released_at: model.dateTime().nullable(),
+    attached_at: model.dateTime().nullable(),
+    metadata: model.json().nullable(),
+    inventory_item: model
+      .belongsTo(() => InventoryItem, {
+        mappedBy: "checkout_reservations",
+      })
+      .searchable(),
+  })
+  .indexes([
+    {
+      name: "IDX_checkout_reservation_cart_id",
+      on: ["cart_id"],
+      where: "deleted_at IS NULL",
+    },
+    {
+      name: "IDX_checkout_reservation_line_item_id",
+      on: ["line_item_id"],
+      where: "deleted_at IS NULL",
+    },
+    {
+      name: "IDX_checkout_reservation_inventory_item_id",
+      on: ["inventory_item_id"],
+      where: "deleted_at IS NULL",
+    },
+    {
+      name: "IDX_checkout_reservation_status_expires_at",
+      on: ["status", "expires_at"],
+      where: "deleted_at IS NULL",
+    },
+    {
+      name: "IDX_checkout_reservation_order_id",
+      on: ["order_id"],
+      where: "deleted_at IS NULL",
+    },
+  ])
+
+export default CheckoutReservation
diff --git a/packages/modules/inventory/src/models/inventory-item.ts b/packages/modules/inventory/src/models/inventory-item.ts
index 42061524c3..3e5f46d249 100644
--- a/packages/modules/inventory/src/models/inventory-item.ts
+++ b/packages/modules/inventory/src/models/inventory-item.ts
@@ -1,6 +1,7 @@
 import { model } from "@medusajs/framework/utils"
+import CheckoutReservation from "./checkout-reservation"
 import InventoryLevel from "./inventory-level"
 import ReservationItem from "./reservation-item"
 
 const InventoryItem = model
@@ -22,12 +23,15 @@ const InventoryItem = model
     reservation_items: model.hasMany(() => ReservationItem, {
       mappedBy: "inventory_item",
     }),
+    checkout_reservations: model.hasMany(() => CheckoutReservation, {
+      mappedBy: "inventory_item",
+    }),
     reserved_quantity: model.number().computed(),
     stocked_quantity: model.number().computed(),
   })
   .cascades({
-    delete: ["location_levels", "reservation_items"],
+    delete: ["location_levels", "reservation_items", "checkout_reservations"],
   })
   .indexes([
     {
diff --git a/packages/modules/inventory/src/models/index.ts b/packages/modules/inventory/src/models/index.ts
index 27971be898..a0d5a5d111 100644
--- a/packages/modules/inventory/src/models/index.ts
+++ b/packages/modules/inventory/src/models/index.ts
@@ -1,3 +1,4 @@
 export { default as InventoryItem } from "./inventory-item"
 export { default as InventoryLevel } from "./inventory-level"
 export { default as ReservationItem } from "./reservation-item"
+export { default as CheckoutReservation } from "./checkout-reservation"
diff --git a/packages/modules/inventory/src/schema/index.ts b/packages/modules/inventory/src/schema/index.ts
index bb9086f333..e179d1db72 100644
--- a/packages/modules/inventory/src/schema/index.ts
+++ b/packages/modules/inventory/src/schema/index.ts
@@ -16,6 +16,7 @@ type InventoryItem {
   metadata: JSON
   location_levels: [InventoryLevel]
   reservation_items: [ReservationItem]
+  checkout_reservations: [CheckoutReservation]
   reserved_quantity: Int!
   stocked_quantity: Int!
 }
@@ -52,4 +53,22 @@ type ReservationItem {
   created_by: String
   metadata: JSON
 }
+
+type CheckoutReservation {
+  id: ID!
+  created_at: DateTime!
+  updated_at: DateTime!
+  deleted_at: DateTime
+  cart_id: String!
+  order_id: String
+  line_item_id: String!
+  allow_backorder: Boolean!
+  inventory_item_id: String!
+  inventory_item: InventoryItem!
+  location_id: String!
+  quantity: Int!
+  required_quantity: Int!
+  status: String!
+  expires_at: DateTime!
+  released_at: DateTime
+  attached_at: DateTime
+}
 `
diff --git a/packages/modules/inventory/src/migrations/Migration20260218094500.ts b/packages/modules/inventory/src/migrations/Migration20260218094500.ts
new file mode 100644
index 0000000000..0a5bb09c91
--- /dev/null
+++ b/packages/modules/inventory/src/migrations/Migration20260218094500.ts
@@ -0,0 +1,67 @@
+import { Migration } from "@medusajs/framework/mikro-orm/migrations"
+
+export class Migration20260218094500 extends Migration {
+  async up(): Promise<void> {
+    this.addSql(
+      'create table if not exists "checkout_reservation" ("id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, "cart_id" text not null, "order_id" text null, "line_item_id" text not null, "location_id" text not null, "quantity" numeric not null, "raw_quantity" jsonb not null, "required_quantity" integer not null default 1, "allow_backorder" boolean not null default false, "status" text not null default \\'pending\\', "expires_at" timestamptz not null, "released_at" timestamptz null, "attached_at" timestamptz null, "metadata" jsonb null, "inventory_item_id" text not null, constraint "checkout_reservation_pkey" primary key ("id"));'
+    )
+
+    this.addSql(
+      'CREATE INDEX IF NOT EXISTS "IDX_checkout_reservation_cart_id" ON "checkout_reservation" (cart_id) WHERE deleted_at IS NULL;'
+    )
+
+    this.addSql(
+      'CREATE INDEX IF NOT EXISTS "IDX_checkout_reservation_line_item_id" ON "checkout_reservation" (line_item_id) WHERE deleted_at IS NULL;'
+    )
+
+    this.addSql(
+      'CREATE INDEX IF NOT EXISTS "IDX_checkout_reservation_inventory_item_id" ON "checkout_reservation" (inventory_item_id) WHERE deleted_at IS NULL;'
+    )
+
+    this.addSql(
+      'CREATE INDEX IF NOT EXISTS "IDX_checkout_reservation_status_expires_at" ON "checkout_reservation" (status, expires_at) WHERE deleted_at IS NULL;'
+    )
+
+    this.addSql(
+      'CREATE INDEX IF NOT EXISTS "IDX_checkout_reservation_order_id" ON "checkout_reservation" (order_id) WHERE deleted_at IS NULL;'
+    )
+
+    this.addSql(
+      'alter table if exists "checkout_reservation" add constraint "checkout_reservation_inventory_item_id_foreign" foreign key ("inventory_item_id") references "inventory_item" ("id") on update cascade on delete cascade;'
+    )
+  }
+
+  async down(): Promise<void> {
+    this.addSql(
+      'alter table if exists "checkout_reservation" drop constraint if exists "checkout_reservation_inventory_item_id_foreign";'
+    )
+
+    this.addSql('drop table if exists "checkout_reservation" cascade;')
+  }
+}
diff --git a/packages/modules/inventory/src/services/inventory-module.ts b/packages/modules/inventory/src/services/inventory-module.ts
index 1fdb1b6628..b19fbf48ce 100644
--- a/packages/modules/inventory/src/services/inventory-module.ts
+++ b/packages/modules/inventory/src/services/inventory-module.ts
@@ -26,7 +26,12 @@ import {
   MathBN,
   MedusaError,
 } from "@medusajs/framework/utils"
-import { InventoryItem, InventoryLevel, ReservationItem } from "@models"
+import {
+  CheckoutReservation,
+  InventoryItem,
+  InventoryLevel,
+  ReservationItem,
+} from "@models"
 
 type InjectedDependencies = {
   baseRepository: DAL.RepositoryService
@@ -50,6 +55,10 @@ class InventoryModuleService extends MedusaService({
     ReservationItem: {
       dto: InventoryTypes.ReservationItemDTO
     },
+    CheckoutReservation: {
+      dto: InventoryTypes.ReservationItemDTO
+    },
   },
 }) {
   protected readonly baseRepository_: DAL.RepositoryService
@@ -77,6 +86,62 @@ class InventoryModuleService extends MedusaService({
     super(...arguments)
   }
 
+  async createCheckoutReservationsForCart(
+    input: {
+      cart_id: string
+      expires_at: Date
+      items: {
+        line_item_id: string
+        inventory_item_id: string
+        location_id: string
+        quantity: BigNumberInput
+        required_quantity: number
+        allow_backorder: boolean
+      }[]
+    },
+    context: Context = {}
+  ) {
+    const items = input.items
+      .filter((item) => item.inventory_item_id && item.location_id)
+      .map((item) => ({
+        cart_id: input.cart_id,
+        line_item_id: item.line_item_id,
+        inventory_item_id: item.inventory_item_id,
+        location_id: item.location_id,
+        required_quantity: item.required_quantity,
+        allow_backorder: item.allow_backorder,
+        quantity: MathBN.mult(item.quantity, item.required_quantity),
+        expires_at: input.expires_at,
+        status: "pending",
+      }))
+
+    if (!items.length) {
+      return []
+    }
+
+    const inventoryLevels = await this.ensureInventoryLevels(
+      items.map((item) => ({
+        location_id: item.location_id,
+        inventory_item_id: item.inventory_item_id,
+        quantity: item.quantity,
+        allow_backorder: item.allow_backorder,
+      })),
+      {
+        validateQuantityAtLocation: true,
+      },
+      context
+    )
+
+    const created = await this.checkoutReservationService_.create(items, context)
+
+    const adjustments = this.buildCheckoutReservationAdjustments(items, 1)
+    const levelAdjustmentUpdates = inventoryLevels.map((level) => {
+      const adjustment = adjustments
+        .get(level.inventory_item_id)
+        ?.get(level.location_id)
+
+      if (!adjustment) {
+        return
+      }
+
+      return {
+        id: level.id,
+        reserved_quantity: MathBN.add(level.reserved_quantity, adjustment),
+      }
+    })
+
+    await this.inventoryLevelService_.update(levelAdjustmentUpdates, context)
+    return await this.baseRepository_.serialize(created)
+  }
+
+  async attachCheckoutReservationsToOrder(
+    input: {
+      cart_id: string
+      order_id: string
+      reservation_ids: string[]
+    },
+    context: Context = {}
+  ) {
+    if (!input.reservation_ids.length) {
+      return []
+    }
+
+    const reservations = await this.checkoutReservationService_.list(
+      {
+        id: input.reservation_ids,
+        cart_id: input.cart_id,
+        status: "pending",
+      },
+      {},
+      context
+    )
+
+    const updated = await this.checkoutReservationService_.update(
+      reservations.map((reservation) => ({
+        id: reservation.id,
+        order_id: input.order_id,
+        status: "attached",
+        attached_at: new Date(),
+      })),
+      context
+    )
+
+    return await this.baseRepository_.serialize(updated)
+  }
+
+  async releaseCheckoutReservations(
+    input: {
+      reservation_ids: string[]
+      reason?: string
+    },
+    context: Context = {}
+  ) {
+    if (!input.reservation_ids.length) {
+      return []
+    }
+
+    const reservations = await this.checkoutReservationService_.list(
+      {
+        id: input.reservation_ids,
+        status: ["pending", "attached"],
+      },
+      {},
+      context
+    )
+
+    if (!reservations.length) {
+      return []
+    }
+
+    const adjustments = this.buildCheckoutReservationAdjustments(
+      reservations,
+      -1
+    )
+
+    const inventoryLevels = await this.ensureInventoryLevels(
+      reservations.map((reservation) => ({
+        inventory_item_id: reservation.inventory_item_id,
+        location_id: reservation.location_id,
+      })),
+      undefined,
+      context
+    )
+
+    const levelAdjustmentUpdates = inventoryLevels.map((level) => {
+      const adjustment = adjustments
+        .get(level.inventory_item_id)
+        ?.get(level.location_id)
+
+      if (!adjustment) {
+        return
+      }
+
+      return {
+        id: level.id,
+        reserved_quantity: MathBN.add(level.reserved_quantity, adjustment),
+      }
+    })
+
+    await this.inventoryLevelService_.update(levelAdjustmentUpdates, context)
+
+    const updated = await this.checkoutReservationService_.update(
+      reservations.map((reservation) => ({
+        id: reservation.id,
+        status: "released",
+        released_at: new Date(),
+        metadata: {
+          ...(reservation.metadata ?? {}),
+          release_reason: input.reason,
+        },
+      })),
+      context
+    )
+
+    return await this.baseRepository_.serialize(updated)
+  }
+
+  async releaseExpiredCheckoutReservations(
+    input: { limit?: number; now?: Date } = {},
+    context: Context = {}
+  ) {
+    const now = input.now ?? new Date()
+    const reservations = await this.checkoutReservationService_.list(
+      {
+        status: "pending",
+        expires_at: { $lte: now },
+      },
+      {
+        take: input.limit ?? 100,
+      },
+      context
+    )
+
+    if (!reservations.length) {
+      return []
+    }
+
+    const adjustments = this.buildCheckoutReservationAdjustments(
+      reservations,
+      -1
+    )
+
+    const inventoryLevels = await this.ensureInventoryLevels(
+      reservations.map((reservation) => ({
+        inventory_item_id: reservation.inventory_item_id,
+        location_id: reservation.location_id,
+      })),
+      undefined,
+      context
+    )
+
+    const levelAdjustmentUpdates = inventoryLevels.map((level) => {
+      const adjustment = adjustments
+        .get(level.inventory_item_id)
+        ?.get(level.location_id)
+
+      if (!adjustment) {
+        return
+      }
+
+      return {
+        id: level.id,
+        reserved_quantity: MathBN.add(level.reserved_quantity, adjustment),
+      }
+    })
+
+    await this.inventoryLevelService_.update(levelAdjustmentUpdates, context)
+
+    const updated = await this.checkoutReservationService_.update(
+      reservations.map((reservation) => ({
+        id: reservation.id,
+        status: "released",
+        released_at: now,
+      })),
+      context
+    )
+
+    return await this.baseRepository_.serialize(updated)
+  }
+
+  private buildCheckoutReservationAdjustments(
+    reservations: {
+      inventory_item_id: string
+      location_id: string
+      quantity: BigNumberInput
+    }[],
+    multiplier: 1 | -1
+  ) {
+    return reservations.reduce((acc, curr) => {
+      const locationMap = acc.get(curr.inventory_item_id) ?? new Map()
+      const current = locationMap.get(curr.location_id) ?? 0
+      locationMap.set(
+        curr.location_id,
+        MathBN.add(current, MathBN.mult(curr.quantity, multiplier))
+      )
+      acc.set(curr.inventory_item_id, locationMap)
+      return acc
+    }, new Map<string, Map<string, number>>())
+  }
+
   // reserved_quantity should solely be handled through creating & updating reservation items
   async updateInventoryLevels(
     input: InventoryTypes.UpdateInventoryLevelInput[],
diff --git a/packages/core/core-flows/src/cart/steps/attach-checkout-reservations-to-order.ts b/packages/core/core-flows/src/cart/steps/attach-checkout-reservations-to-order.ts
new file mode 100644
index 0000000000..725f1d93d0
--- /dev/null
+++ b/packages/core/core-flows/src/cart/steps/attach-checkout-reservations-to-order.ts
@@ -0,0 +1,83 @@
+import { Modules } from "@medusajs/framework/utils"
+import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
+
+export type AttachCheckoutReservationsToOrderInput = {
+  cart_id: string
+  order_id: string
+  reservation_ids: string[]
+}
+
+export const attachCheckoutReservationsToOrderStepId =
+  "attach-checkout-reservations-to-order"
+
+/**
+ * Marks checkout reservations as attached once an order has been created.
+ *
+ * The inventory quantity has already been moved into reserved_quantity before
+ * this workflow starts, so this step only records the relationship for admin
+ * and debugging views.
+ */
+export const attachCheckoutReservationsToOrderStep = createStep(
+  attachCheckoutReservationsToOrderStepId,
+  async (input: AttachCheckoutReservationsToOrderInput, { container }) => {
+    if (!input.reservation_ids.length) {
+      return new StepResponse([], {
+        cart_id: input.cart_id,
+        order_id: input.order_id,
+        reservation_ids: [],
+      })
+    }
+
+    const inventoryService = container.resolve(Modules.INVENTORY)
+    const updated = await inventoryService.attachCheckoutReservationsToOrder({
+      cart_id: input.cart_id,
+      order_id: input.order_id,
+      reservation_ids: input.reservation_ids,
+    })
+
+    return new StepResponse(updated, {
+      cart_id: input.cart_id,
+      order_id: input.order_id,
+      reservation_ids: updated.map((reservation) => reservation.id),
+    })
+  },
+  async (data, { container }) => {
+    if (!data?.reservation_ids?.length) {
+      return
+    }
+
+    const inventoryService = container.resolve(Modules.INVENTORY)
+    await inventoryService.releaseCheckoutReservations({
+      reservation_ids: data.reservation_ids,
+      reason: "workflow_compensation",
+    })
+  }
+)
diff --git a/packages/core/core-flows/src/cart/steps/index.ts b/packages/core/core-flows/src/cart/steps/index.ts
index 756d671ef1..8f7bd219af 100644
--- a/packages/core/core-flows/src/cart/steps/index.ts
+++ b/packages/core/core-flows/src/cart/steps/index.ts
@@ -1,3 +1,4 @@
+export * from "./attach-checkout-reservations-to-order"
 export * from "./confirm-inventory"
 export * from "./reserve-inventory"
 export * from "./validate-cart"
diff --git a/packages/core/core-flows/src/cart/workflows/complete-cart.ts b/packages/core/core-flows/src/cart/workflows/complete-cart.ts
index efaa231842..cd4017d9f4 100644
--- a/packages/core/core-flows/src/cart/workflows/complete-cart.ts
+++ b/packages/core/core-flows/src/cart/workflows/complete-cart.ts
@@ -37,8 +37,8 @@ import {
   registerUsageStep,
 } from "../../promotion"
 import { createOrdersStep } from "../../order/steps/create-orders"
-import { reserveInventoryStep } from "../steps/reserve-inventory"
 import { completeCartFields } from "../utils/fields"
+import { attachCheckoutReservationsToOrderStep } from "../steps"
-import { prepareConfirmInventoryInput } from "../utils/prepare-confirm-inventory-input"
 
 export type CompleteCartWorkflowInput = {
@@ -48,6 +48,7 @@ export type CompleteCartWorkflowInput = {
    * The ID of the cart to complete.
    */
   id: string
+  checkout_reservation_ids?: string[]
 }
 
 export const completeCartWorkflowId = "complete-cart"
@@ -479,18 +480,24 @@ export const completeCartWorkflow = createWorkflow(
 
       const createdOrders = createOrdersStep([cartToOrder])
 
       const createdOrder = transform({ createdOrders }, ({ createdOrders }) => {
         return createdOrders[0]
       })
 
-      const reservationItemsData = transform(
-        { createdOrder },
-        ({ createdOrder }) =>
-          createdOrder.items!.map((i) => ({
-            variant_id: i.variant_id,
-            quantity: i.quantity,
-            id: i.id,
-          }))
-      )
+      const checkoutReservationIds = transform({ input }, ({ input }) => {
+        return input.checkout_reservation_ids ?? []
+      })
 
-      const formatedInventoryItems = transform(
-        {
-          input: {
-            sales_channel_id,
-            variants,
-            items: reservationItemsData,
-          },
-        },
-        prepareConfirmInventoryInput
+      attachCheckoutReservationsToOrderStep(
+        transform(
+          {
+            createdOrder,
+            checkoutReservationIds,
+            input,
+          },
+          ({ createdOrder, checkoutReservationIds, input }) => ({
+            cart_id: input.id,
+            order_id: createdOrder.id,
+            reservation_ids: checkoutReservationIds,
+          })
+        )
       )
 
       const updateCompletedAt = transform(
@@ -590,7 +597,6 @@ export const completeCartWorkflow = createWorkflow(
       parallelize(
         createRemoteLinkStep(linksToCreate),
         updateCartsStep([updateCompletedAt]),
-        reserveInventoryStep(formatedInventoryItems),
         registerUsageStep(promotionUsage),
         emitEventStep({
           eventName: OrderWorkflowEvents.PLACED,
diff --git a/packages/medusa/src/api/store/carts/[id]/complete/route.ts b/packages/medusa/src/api/store/carts/[id]/complete/route.ts
index f24c79d9a0..891473ef31 100644
--- a/packages/medusa/src/api/store/carts/[id]/complete/route.ts
+++ b/packages/medusa/src/api/store/carts/[id]/complete/route.ts
@@ -1,16 +1,25 @@
 import { completeCartWorkflowId } from "@medusajs/core-flows"
 import { prepareRetrieveQuery } from "@medusajs/framework"
 import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
 import { HttpTypes } from "@medusajs/framework/types"
 import {
   ContainerRegistrationKeys,
+  isDefined,
   MedusaError,
   Modules,
 } from "@medusajs/framework/utils"
 import { refetchCart } from "../../helpers"
 import { defaultStoreCartFields } from "../../query-config"
 
+const CHECKOUT_RESERVATION_TTL_MS = 15 * 60 * 1000
+
 export const POST = async (
   req: MedusaRequest<{}, HttpTypes.SelectParams>,
   res: MedusaResponse<HttpTypes.StoreCompleteCartResponse>
 ) => {
   const cart_id = req.params.id
   const we = req.scope.resolve(Modules.WORKFLOW_ENGINE)
+  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
+  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
+  const inventoryService = req.scope.resolve(Modules.INVENTORY)
+
+  let checkoutReservationIds: string[] = []
+  const { data: carts } = await query.graph({
+    entity: "cart",
+    fields: [
+      "id",
+      "sales_channel_id",
+      "items.id",
+      "items.quantity",
+      "items.variant_id",
+      "items.variant.manage_inventory",
+      "items.variant.allow_backorder",
+      "items.variant.inventory_items.required_quantity",
+      "items.variant.inventory_items.inventory_item_id",
+      "items.variant.inventory_items.inventory.location_levels.location_id",
+    ],
+    filters: { id: cart_id },
+  })
+
+  const cart = carts[0]
+  const reservationInput = (cart?.items ?? []).flatMap((item) => {
+    const inventoryItems = item.variant?.inventory_items ?? []
+
+    return inventoryItems
+      .filter((inventoryItem) => item.variant?.manage_inventory)
+      .map((inventoryItem) => {
+        const locationLevel =
+          inventoryItem.inventory?.location_levels?.[0]
+
+        if (!isDefined(locationLevel?.location_id)) {
+          return
+        }
+
+        return {
+          line_item_id: item.id,
+          inventory_item_id: inventoryItem.inventory_item_id,
+          location_id: locationLevel.location_id,
+          quantity: item.quantity,
+          required_quantity: inventoryItem.required_quantity ?? 1,
+          allow_backorder: item.variant.allow_backorder,
+        }
+      })
+      .filter(isDefined)
+  })
+
+  try {
+    const reservations =
+      await inventoryService.createCheckoutReservationsForCart({
+        cart_id,
+        expires_at: new Date(Date.now() + CHECKOUT_RESERVATION_TTL_MS),
+        items: reservationInput,
+      })
+
+    checkoutReservationIds = reservations.map((reservation) => reservation.id)
+  } catch (error) {
+    logger.warn("Unable to create checkout inventory reservations", {
+      cart_id,
+      error: error instanceof Error ? error.message : String(error),
+    })
+  }
 
   const { errors, result, transaction } = await we.run(completeCartWorkflowId, {
-    input: { id: cart_id },
+    input: { id: cart_id, checkout_reservation_ids: checkoutReservationIds },
     throwOnError: false,
   })
@@ -24,8 +33,6 @@ export const POST = async (
     )
   }
 
-  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
-
   // When an error occurs on the workflow, its potentially got to with cart validations, payments
   // or inventory checks. Return the cart here along with errors for the consumer to take more action
   // and fix them
diff --git a/packages/medusa/src/jobs/release-expired-checkout-reservations.ts b/packages/medusa/src/jobs/release-expired-checkout-reservations.ts
new file mode 100644
index 0000000000..58032ed7fa
--- /dev/null
+++ b/packages/medusa/src/jobs/release-expired-checkout-reservations.ts
@@ -0,0 +1,64 @@
+import { Modules } from "@medusajs/framework/utils"
+import { MedusaContainer } from "@medusajs/framework/types"
+
+export default async function releaseExpiredCheckoutReservations(
+  container: MedusaContainer
+) {
+  const inventoryService = container.resolve(Modules.INVENTORY)
+  const logger = container.resolve("logger")
+
+  let releasedTotal = 0
+  let released = []
+
+  do {
+    released = await inventoryService.releaseExpiredCheckoutReservations({
+      limit: 100,
+      now: new Date(),
+    })
+    releasedTotal += released.length
+  } while (released.length)
+
+  if (releasedTotal) {
+    logger.info("Released expired checkout inventory reservations", {
+      released: releasedTotal,
+    })
+  }
+}
+
+export const config = {
+  name: "release-expired-checkout-reservations",
+  schedule: "*/5 * * * *",
+}
diff --git a/integration-tests/http/__tests__/cart/store/checkout-reservations.spec.ts b/integration-tests/http/__tests__/cart/store/checkout-reservations.spec.ts
new file mode 100644
index 0000000000..e1e7b88542
--- /dev/null
+++ b/integration-tests/http/__tests__/cart/store/checkout-reservations.spec.ts
@@ -0,0 +1,186 @@
+import { Modules } from "@medusajs/framework/utils"
+import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
+
+medusaIntegrationTestRunner({
+  testSuite: ({ api, getContainer }) => {
+    describe("store cart completion checkout reservations", () => {
+      let cartId: string
+      let inventoryItemId: string
+      let locationId: string
+
+      beforeEach(async () => {
+        const container = getContainer()
+        const inventory = container.resolve(Modules.INVENTORY)
+
+        const location = (
+          await api.post(
+            "/admin/stock-locations",
+            { name: "Main warehouse" },
+            { headers: { authorization: "Bearer test_token" } }
+          )
+        ).data.stock_location
+
+        locationId = location.id
+
+        const product = (
+          await api.post(
+            "/admin/products",
+            {
+              title: "T-Shirt",
+              options: [{ title: "Size", values: ["M"] }],
+              variants: [
+                {
+                  title: "M",
+                  sku: "tee-m",
+                  manage_inventory: true,
+                  options: { Size: "M" },
+                  prices: [{ amount: 1000, currency_code: "usd" }],
+                },
+              ],
+            },
+            { headers: { authorization: "Bearer test_token" } }
+          )
+        ).data.product
+
+        const variant = product.variants[0]
+        const inventoryItem = await inventory.createInventoryItems({
+          sku: "tee-m-inventory",
+        })
+
+        inventoryItemId = inventoryItem.id
+
+        await api.post(
+          `/admin/products/${product.id}/variants/${variant.id}/inventory-items`,
+          {
+            inventory_item_id: inventoryItem.id,
+            required_quantity: 1,
+          },
+          { headers: { authorization: "Bearer test_token" } }
+        )
+
+        await api.post(
+          `/admin/inventory-items/${inventoryItem.id}/location-levels`,
+          {
+            location_id: location.id,
+            stocked_quantity: 1,
+          },
+          { headers: { authorization: "Bearer test_token" } }
+        )
+
+        const cart = (
+          await api.post("/store/carts", {
+            currency_code: "usd",
+            region_id: "reg_123",
+          })
+        ).data.cart
+
+        cartId = cart.id
+
+        await api.post(`/store/carts/${cartId}/line-items`, {
+          variant_id: variant.id,
+          quantity: 1,
+        })
+
+        await api.post(`/store/carts/${cartId}/shipping-methods`, {
+          option_id: "so_123",
+        })
+      })
+
+      it("creates checkout reservations when completing a cart", async () => {
+        await api.post(`/store/carts/${cartId}/complete`)
+
+        const inventory = getContainer().resolve(Modules.INVENTORY)
+        const reservations = await inventory.listCheckoutReservations({
+          cart_id: cartId,
+        })
+
+        expect(reservations).toHaveLength(1)
+        expect(reservations[0]).toEqual(
+          expect.objectContaining({
+            cart_id: cartId,
+            inventory_item_id: inventoryItemId,
+            location_id: locationId,
+            status: "attached",
+          })
+        )
+      })
+
+      it("releases expired checkout reservations", async () => {
+        const inventory = getContainer().resolve(Modules.INVENTORY)
+        await inventory.createCheckoutReservationsForCart({
+          cart_id: cartId,
+          expires_at: new Date(Date.now() - 1000),
+          items: [
+            {
+              line_item_id: "line_123",
+              inventory_item_id: inventoryItemId,
+              location_id: locationId,
+              quantity: 1,
+              required_quantity: 1,
+              allow_backorder: false,
+            },
+          ],
+        })
+
+        const released = await inventory.releaseExpiredCheckoutReservations({
+          now: new Date(),
+        })
+
+        expect(released).toHaveLength(1)
+        expect(released[0].status).toEqual("released")
+      })
+    })
+  },
+})
```

## Intended Flaws

### Flaw 1: Checkout reservation creation is not idempotent

- `type`: `idempotency_gap`
- `location`: `packages/modules/inventory/src/models/checkout-reservation.ts:10-56`, `packages/modules/inventory/src/migrations/Migration20260218094500.ts:4-35`, `packages/modules/inventory/src/services/inventory-module.ts:86-154`
- `learner_prompt`: What happens if the same cart completion attempt is retried after the route creates checkout reservations but before the caller receives a successful response?

Expected answer:

- Identify: The new reservation rows have no idempotency key, source/action identity, or unique constraint for the cart completion attempt. `createCheckoutReservationsForCart` creates a fresh row for every cart line every time it is called, and increments `inventory_level.reserved_quantity` each time. The migration only adds lookup indexes, not a uniqueness guarantee such as `(cart_id, line_item_id, inventory_item_id, location_id, status)` or a source idempotency key.
- Impact: A client retry, load balancer retry, timeout retry, or double-click can reserve the same cart inventory multiple times. One real order can consume two or more units of reserved stock, which causes false out-of-stock states, stuck inventory, cancelled good orders, and cleanup races. The tests miss it because they only complete a cart once and only release a single expired reservation.
- Fix direction: Treat reservation creation as an idempotent command. Use a stable source key such as `cart_completion:{cart_id}:{line_item_id}:{inventory_item_id}:{location_id}` or a workflow transaction/action id. Enforce it with a database unique index for active holds, and make the service upsert or return the existing active reservation without applying `reserved_quantity` twice.

Hints:

1. Review this like a payment or order-placement path: assume the HTTP request can be retried after a partial success.
2. Look for a stable identity that says "this reservation is for this cart line and this completion attempt."
3. The model and migration add indexes for reads, but nothing prevents two active rows for the same cart line and inventory location.

### Flaw 2: Inventory reservation is moved outside the cart-completion workflow boundary

- `type`: `consistency_gap`
- `location`: `packages/medusa/src/api/store/carts/[id]/complete/route.ts:24-76`, `packages/core/core-flows/src/cart/workflows/complete-cart.ts:480-606`, `packages/core/core-flows/src/cart/steps/attach-checkout-reservations-to-order.ts:19-53`
- `learner_prompt`: Does the new inventory hold participate in the same workflow, lock, compensation, and failure semantics as order creation?

Expected answer:

- Identify: The route creates checkout reservations before invoking `completeCartWorkflow`, catches reservation errors, logs them, and still completes the cart. The workflow then removes the original `reserveInventoryStep` and only attaches pre-created reservation ids to the order. That means inventory mutation is no longer an ordered, compensatable step in the same workflow as order creation, cart completion, event emission, and payment authorization.
- Impact: If reservation creation fails or the route query misses an inventory item, the order can still be created without holding stock. If reservations are created and the workflow later fails during validation, linking, promotions, events, or payment authorization, the hold is left for the TTL cleanup job rather than immediate compensation. A retry can create more holds. The system can now produce both "order without reserved inventory" and "reserved inventory without an order" states.
- Fix direction: Keep the inventory mutation inside the cart-completion workflow, behind the existing cart lock and workflow compensation. If checkout holds need to exist before payment authorization, model them as a workflow step with compensation and idempotency. Do not swallow reservation failures; a cart with managed inventory should not complete unless the inventory hold step succeeds. Attach/convert the hold to the order in the same orchestrated workflow transaction boundary.

Hints:

1. Compare the old `reserveInventoryStep` contract with the new route-level call before `we.run`.
2. Ask what compensates the inventory hold if the workflow returns a payment error or fails after order creation.
3. The most dangerous line is the catch block that logs reservation failure and still runs `completeCartWorkflow`.

## Final Expert Debrief

### Product-level change

The PR is trying to reduce oversells by holding stock during checkout completion. That is a real ecommerce problem: payment authorization and order creation are not instantaneous, and inventory can disappear during that window.

### Changed contracts

- Database contract: a new active inventory-hold table affects `inventory_level.reserved_quantity`.
- Cart completion contract: inventory reservation moves from a workflow step to route-level pre-work.
- Idempotency contract: cart completion can now create durable inventory side effects before the workflow has established whether this is a first execution or a retry.
- Failure contract: inventory failures become warnings instead of hard blockers for managed inventory.
- Cleanup contract: correctness now depends on a scheduled job releasing expired rows later.

### Failure modes

- A retried cart completion reserves the same unit twice.
- A checkout request times out after reservation creation; the browser retries and creates another hold.
- The reservation pre-step fails, logs a warning, and the workflow still creates an order.
- The workflow fails on payment authorization after a reservation is created, leaving stock unavailable until TTL cleanup.
- The scheduled cleanup job races with a slow payment flow and releases a hold that is still being attached.
- Tests pass because they verify the happy path and expiry path, but not retry, partial failure, or compensation behavior.

### Reviewer thought process

A strong reviewer should not start with the new table. They should first locate the existing inventory mutation path and ask: "What currently owns this side effect?" In Medusa, `reserveInventoryStep` runs inside `completeCartWorkflow`, under inventory-item locking, with compensation that deletes reservations if a later step fails.

Then they should ask: "What is the command identity?" Any path that reserves inventory, charges payment, creates orders, sends notifications, or enqueues fulfillment work has to survive retries. The new model has many useful read indexes, but no uniqueness around the business action. That is the clue that the same command can be applied twice.

Finally, they should trace failure order. The PR creates reservations before the workflow, catches reservation errors, removes the original reservation step, and relies on a TTL job for cleanup. That is a contract change, not an implementation detail. The product claim is "fewer oversells," but the code can now create orders without reservations and reservations without orders.

### Better implementation direction

- Keep reservation mutation inside `completeCartWorkflow`.
- Add a workflow step such as `createCheckoutReservationsStep` with compensation.
- Lock by inventory item id before checking and mutating available quantity.
- Use a stable idempotency key per cart line, inventory item, location, and completion transaction.
- Enforce idempotency with a unique active-hold index, not only application code.
- Do not continue cart completion when managed inventory cannot be reserved.
- Convert or attach checkout holds to order reservations in the same workflow path.
- Release holds through compensation first; use the scheduled job only as a stale-row safety net.
- Add tests for HTTP retry after reservation creation, payment failure after reservation creation, and reservation failure before order creation.

## Correctness Verdict Rubric

The learner is correct on flaw 1 if they mention all three:

- repeated cart completion can create multiple active reservations for the same cart line,
- the table/service lacks a stable idempotency key or active unique constraint,
- the fix must make reservation creation an idempotent command and avoid applying `reserved_quantity` twice.

The learner is correct on flaw 2 if they mention all three:

- inventory reservation moved out of the existing workflow step/compensation path,
- reservation failures are swallowed while order creation still proceeds,
- the fix is to keep inventory mutation inside the cart-completion workflow with hard failure and compensation semantics.

## Why This Case Exists

This case trains the reviewer to see distributed-system shape inside ordinary SaaS code. "Create a row and clean it up later" sounds simple. In checkout, it is a concurrency and consistency contract. The engineer should learn to follow side effects across retries, workflow boundaries, locks, database constraints, and cleanup jobs before deciding that a large PR is safe.
