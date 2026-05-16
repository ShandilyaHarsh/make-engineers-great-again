# TS-058: Medusa Inventory Stock-Adjusted Events

## Metadata

- `id`: TS-058
- `source_repo`: [medusajs/medusa](https://github.com/medusajs/medusa)
- `repo_area`: inventory module service, inventory levels, reservation items, stocked/reserved/available quantity contracts, workflow steps, event bus metadata, order/cart reservation flows, fulfillment stock movement
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,850-2,300
- `represented_diff_lines`: 1859
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Medusa inventory levels, reservations, workflow event groups, event idempotency, available-vs-stocked quantity, and subscriber reconciliation without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a new `inventory.stock_adjusted` event. The goal is to let search indexes, warehouse syncs, admin dashboards, forecasting jobs, and third-party inventory integrations react when item availability changes at a stock location.

The PR adds:

- a stock-adjusted event envelope,
- an event publishing helper for inventory levels,
- inventory module integration for manual adjustments,
- reservation integration so checkout availability changes emit events,
- workflow-step integration tests,
- subscriber examples for search/warehouse sync,
- docs for consuming inventory stock-adjusted events.

The intended product behavior is: consumers should be able to dedupe/reconcile the business cause of every stock event, and events should distinguish physical stock movement from temporary reservation/availability changes.

## Existing Code Context

The real Medusa codebase already has these relevant contracts:

- `packages/modules/inventory/src/models/inventory-level.ts` stores `stocked_quantity`, `reserved_quantity`, `incoming_quantity`, and computed `available_quantity`.
- `packages/modules/inventory/src/models/reservation-item.ts` stores reservation rows with `inventory_item_id`, `location_id`, `quantity`, `line_item_id`, `external_id`, and metadata.
- `InventoryModuleService.createReservationItems_` validates available quantity, creates reservation rows, and increases `reserved_quantity` on inventory levels.
- `InventoryModuleService.updateReservationItems_` adjusts `reserved_quantity` when reservation quantity or location changes.
- `InventoryModuleService.deleteReservationItems_` and related delete/restore helpers adjust `reserved_quantity` when reservations are removed or restored.
- `InventoryModuleService.adjustInventory_` updates `stocked_quantity`; this is the direct stock adjustment path.
- `packages/core/core-flows/src/cart/steps/reserve-inventory.ts` creates reservations during checkout; it reserves availability but does not represent final fulfillment or physical stock leaving the warehouse.
- `packages/core/core-flows/src/inventory/steps/adjust-inventory-levels.ts` wraps `adjustInventory` in workflow locking and provides compensation.
- `packages/core/core-flows/src/common/steps/emit-event.ts` forwards `eventGroupId` metadata and only releases grouped events after successful workflow completion.
- Medusa workflows often need causality and grouping metadata because multiple steps can touch the same inventory item during checkout, fulfillment, cancellation, return, exchange, or order edit flows.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this event is a reliable inventory contract for downstream consumers.

## Review Surface

Changed files in the synthetic PR:

- `packages/core/utils/src/inventory/stock-adjusted-events.ts`
- `packages/modules/inventory/src/services/stock-adjusted-event-publisher.ts`
- `packages/modules/inventory/src/services/inventory-module.ts`
- `packages/core/core-flows/src/inventory/steps/adjust-inventory-levels.ts`
- `packages/core/core-flows/src/reservation/steps/create-reservations.ts`
- `packages/modules/inventory/integration-tests/__tests__/stock-adjusted-events.spec.ts`
- `packages/core/core-flows/src/inventory/steps/__tests__/adjust-inventory-levels.spec.ts`
- `packages/core/core-flows/src/reservation/steps/__tests__/create-reservations-stock-events.spec.ts`
- `integration-tests/modules/src/subscribers/inventory-stock-adjusted.ts`
- `docs/inventory/stock-adjusted-events.md`

The line references below use synthetic PR line numbers. The represented diff is focused on event causality/idempotency and whether reservation holds are represented as final stock adjustments.

## Diff

```diff
diff --git a/packages/core/utils/src/inventory/stock-adjusted-events.ts b/packages/core/utils/src/inventory/stock-adjusted-events.ts
new file mode 100644
index 0000000000..aa3f4decb5
--- /dev/null
+++ b/packages/core/utils/src/inventory/stock-adjusted-events.ts
@@ -0,0 +1,68 @@
+import { BigNumber, MathBN } from "../common"
+
+export const InventoryStockAdjustedEvents = {
+  STOCK_ADJUSTED: "inventory.stock_adjusted",
+} as const
+
+export type InventoryStockAdjustedEvent = {
+  id: string
+  name: typeof InventoryStockAdjustedEvents.STOCK_ADJUSTED
+  inventory_item_id: string
+  location_id: string
+  inventory_level_id: string
+  adjustment: string
+  stocked_quantity: string
+  previous_stocked_quantity: string
+  reserved_quantity: string
+  previous_reserved_quantity: string
+  available_quantity: string
+  previous_available_quantity: string
+  reason:
+    | "manual"
+    | "reservation_created"
+    | "reservation_updated"
+    | "reservation_deleted"
+    | "fulfillment"
+    | "return"
+    | "unknown"
+  created_at: string
+}
+
+export type BuildStockAdjustedEventInput = {
+  id: string
+  inventoryItemId: string
+  inventoryLevelId: string
+  locationId: string
+  newReservedQuantity: BigNumber
+  newStockedQuantity: BigNumber
+  previousReservedQuantity: BigNumber
+  previousStockedQuantity: BigNumber
+  reason?: InventoryStockAdjustedEvent["reason"]
+}
+
+export function buildStockAdjustedEvent(
+  input: BuildStockAdjustedEventInput
+): InventoryStockAdjustedEvent {
+  const previousAvailable = MathBN.sub(
+    input.previousStockedQuantity,
+    input.previousReservedQuantity
+  )
+  const available = MathBN.sub(input.newStockedQuantity, input.newReservedQuantity)
+
+  return {
+    id: input.id,
+    name: InventoryStockAdjustedEvents.STOCK_ADJUSTED,
+    inventory_item_id: input.inventoryItemId,
+    location_id: input.locationId,
+    inventory_level_id: input.inventoryLevelId,
+    adjustment: MathBN.sub(available, previousAvailable).toString(),
+    stocked_quantity: input.newStockedQuantity.toString(),
+    previous_stocked_quantity: input.previousStockedQuantity.toString(),
+    reserved_quantity: input.newReservedQuantity.toString(),
+    previous_reserved_quantity: input.previousReservedQuantity.toString(),
+    available_quantity: available.toString(),
+    previous_available_quantity: previousAvailable.toString(),
+    reason: input.reason ?? "unknown",
+    created_at: new Date().toISOString(),
+  }
+}
diff --git a/packages/modules/inventory/src/services/stock-adjusted-event-publisher.ts b/packages/modules/inventory/src/services/stock-adjusted-event-publisher.ts
new file mode 100644
index 0000000000..e69d45271d
--- /dev/null
+++ b/packages/modules/inventory/src/services/stock-adjusted-event-publisher.ts
@@ -0,0 +1,72 @@
+import crypto from "crypto"
+
+import type {
+  Context,
+  EventBusTypes,
+  IEventBusModuleService,
+  InventoryTypes,
+} from "@medusajs/framework/types"
+import { Modules } from "@medusajs/framework/utils"
+import {
+  buildStockAdjustedEvent,
+  InventoryStockAdjustedEvents,
+} from "@medusajs/framework/utils/inventory"
+
+export type StockAdjustedEventPublisherDependencies = {
+  eventBusModuleService?: IEventBusModuleService
+}
+
+export type PublishStockAdjustedEventInput = {
+  inventoryLevel: InventoryTypes.InventoryLevelDTO
+  previousReservedQuantity: any
+  previousStockedQuantity: any
+  reason?: "manual" | "reservation_created" | "reservation_updated" | "reservation_deleted" | "fulfillment" | "return" | "unknown"
+}
+
+export class StockAdjustedEventPublisher {
+  protected readonly eventBusModuleService_?: IEventBusModuleService
+
+  constructor({ eventBusModuleService }: StockAdjustedEventPublisherDependencies) {
+    this.eventBusModuleService_ = eventBusModuleService
+  }
+
+  async publish(
+    input: PublishStockAdjustedEventInput | PublishStockAdjustedEventInput[],
+    context: Context = {}
+  ): Promise<void> {
+    if (!this.eventBusModuleService_) {
+      return
+    }
+
+    const items = Array.isArray(input) ? input : [input]
+    const messages: EventBusTypes.Message[] = items.map((item) => {
+      const event = buildStockAdjustedEvent({
+        id: crypto.randomUUID(),
+        inventoryItemId: item.inventoryLevel.inventory_item_id,
+        inventoryLevelId: item.inventoryLevel.id,
+        locationId: item.inventoryLevel.location_id,
+        newReservedQuantity: item.inventoryLevel.reserved_quantity as any,
+        newStockedQuantity: item.inventoryLevel.stocked_quantity as any,
+        previousReservedQuantity: item.previousReservedQuantity,
+        previousStockedQuantity: item.previousStockedQuantity,
+        reason: item.reason,
+      })
+
+      return {
+        name: InventoryStockAdjustedEvents.STOCK_ADJUSTED,
+        data: event,
+        metadata: {
+          eventGroupId: context.eventGroupId,
+        },
+      }
+    })
+
+    await this.eventBusModuleService_.emit(messages)
+  }
+}
+
+export function createStockAdjustedEventPublisher(container: any) {
+  return new StockAdjustedEventPublisher({
+    eventBusModuleService: container[Modules.EVENT_BUS],
+  })
+}
diff --git a/packages/modules/inventory/src/services/inventory-module.ts b/packages/modules/inventory/src/services/inventory-module.ts
index 384746b4f4..b9cef546a2 100644
--- a/packages/modules/inventory/src/services/inventory-module.ts
+++ b/packages/modules/inventory/src/services/inventory-module.ts
@@ -18,6 +18,7 @@ import {
   partitionArray,
 } from "@medusajs/framework/utils"
 import { InventoryItem, InventoryLevel, ReservationItem } from "@models"
+import { createStockAdjustedEventPublisher } from "./stock-adjusted-event-publisher"
 import { joinerConfig } from "../joiner-config"
 import { applyEntityHooks } from "../utils/apply-decorators"
@@ -31,6 +32,7 @@ type InjectedDependencies = {
   inventoryItemService: ModulesSdkTypes.IMedusaInternalService<any>
   inventoryLevelService: InventoryLevelService
   reservationItemService: ModulesSdkTypes.IMedusaInternalService<any>
+  eventBusModuleService?: any
 }
@@ -63,6 +65,7 @@ export default class InventoryModuleService
   protected readonly reservationItemService_: ModulesSdkTypes.IMedusaInternalService<
     typeof ReservationItem
   >
+  protected readonly stockAdjustedEventPublisher_: ReturnType<typeof createStockAdjustedEventPublisher>
   protected readonly inventoryLevelService_: InventoryLevelService
@@ -75,6 +78,7 @@ export default class InventoryModuleService
       inventoryItemService,
       inventoryLevelService,
       reservationItemService,
+      eventBusModuleService,
     }: InjectedDependencies,
     protected readonly moduleDeclaration?: InternalModuleDeclaration
   ) {
@@ -87,6 +91,9 @@ export default class InventoryModuleService
     this.inventoryItemService_ = inventoryItemService
     this.inventoryLevelService_ = inventoryLevelService
     this.reservationItemService_ = reservationItemService
+    this.stockAdjustedEventPublisher_ = createStockAdjustedEventPublisher({
+      eventBusModuleService,
+    })
   }
@@ -230,6 +237,23 @@ export default class InventoryModuleService
 
     await this.inventoryLevelService_.update(levelAdjustmentUpdates, context)
+
+    await this.stockAdjustedEventPublisher_.publish(
+      inventoryLevels.map((level) => {
+        const adjustment = adjustments
+          .get(level.inventory_item_id)
+          ?.get(level.location_id)
+        return {
+          inventoryLevel: {
+            ...level,
+            reserved_quantity: MathBN.add(level.reserved_quantity, adjustment ?? 0),
+          },
+          previousReservedQuantity: level.reserved_quantity,
+          previousStockedQuantity: level.stocked_quantity,
+          reason: "reservation_created",
+        }
+      }),
+      context
+    )
 
     return created
   }
@@ -712,6 +736,25 @@ export default class InventoryModuleService
 
     await this.inventoryLevelService_.update(levelAdjustmentUpdates, context)
+
+    await this.stockAdjustedEventPublisher_.publish(
+      inventoryLevels.map((level) => {
+        const adjustment = adjustments
+          .get(level.inventory_item_id)
+          ?.get(level.location_id)
+        return {
+          inventoryLevel: {
+            ...level,
+            reserved_quantity: MathBN.add(level.reserved_quantity, adjustment ?? 0),
+          },
+          previousReservedQuantity: level.reserved_quantity,
+          previousStockedQuantity: level.stocked_quantity,
+          reason: "reservation_updated",
+        }
+      }),
+      context
+    )
 
     return result
   }
@@ -1120,6 +1163,24 @@ export default class InventoryModuleService
 
     const result = await this.inventoryLevelService_.update(
       {
         id: inventoryLevel.id,
         stocked_quantity: MathBN.add(
           inventoryLevel.stocked_quantity,
           adjustment
         ),
       },
       context
     )
+
+    await this.stockAdjustedEventPublisher_.publish(
+      {
+        inventoryLevel: result as any,
+        previousReservedQuantity: inventoryLevel.reserved_quantity,
+        previousStockedQuantity: inventoryLevel.stocked_quantity,
+        reason: "manual",
+      },
+      context
+    )
 
     return result
   }
@@ -1248,6 +1309,23 @@ export default class InventoryModuleService
 
     await this.inventoryLevelService_.update(levelAdjustmentUpdates, context)
+
+    await this.stockAdjustedEventPublisher_.publish(
+      inventoryLevels.map((level) => {
+        const adjustment = inventoryLevelAdjustments
+          .get(level.inventory_item_id)
+          ?.get(level.location_id)
+        return {
+          inventoryLevel: {
+            ...level,
+            reserved_quantity: MathBN.add(level.reserved_quantity, adjustment ?? 0),
+          },
+          previousReservedQuantity: level.reserved_quantity,
+          previousStockedQuantity: level.stocked_quantity,
+          reason: isDelete ? "reservation_deleted" : "reservation_created",
+        }
+      }),
+      context
+    )
   }
 }
diff --git a/packages/core/core-flows/src/inventory/steps/adjust-inventory-levels.ts b/packages/core/core-flows/src/inventory/steps/adjust-inventory-levels.ts
index 835174d10f..1fde742a53 100644
--- a/packages/core/core-flows/src/inventory/steps/adjust-inventory-levels.ts
+++ b/packages/core/core-flows/src/inventory/steps/adjust-inventory-levels.ts
@@ -36,7 +36,14 @@ export const adjustInventoryLevelsStep = createStep(
     const adjustedLevels: InventoryTypes.InventoryLevelDTO[] =
       await locking.execute(lockingKeys, async () => {
         return await inventoryService.adjustInventory(
-          input.map((item) => {
+          input.map((item) => {
             return {
               inventoryItemId: item.inventory_item_id,
               locationId: item.location_id,
               adjustment: item.adjustment,
+              metadata: {
+                workflow_step_id: adjustInventoryLevelsStepId,
+                requested_by: "inventory-workflow",
+              },
             }
           })
         )
diff --git a/packages/core/core-flows/src/reservation/steps/create-reservations.ts b/packages/core/core-flows/src/reservation/steps/create-reservations.ts
index 201b7f49f2..19cfea2057 100644
--- a/packages/core/core-flows/src/reservation/steps/create-reservations.ts
+++ b/packages/core/core-flows/src/reservation/steps/create-reservations.ts
@@ -34,7 +34,13 @@ export const createReservationsStep = createStep(
     const lockingKeys = Array.from(new Set(inventoryItemIds))
 
     const created = await locking.execute(lockingKeys, async () => {
-      return await service.createReservationItems(data)
+      return await service.createReservationItems(
+        data.map((reservation) => ({
+          ...reservation,
+          metadata: {
+            stock_event_reason: "reservation_created",
+          },
+        }))
+      )
     })
 
     return new StepResponse(created, {
diff --git a/packages/modules/inventory/integration-tests/__tests__/stock-adjusted-events.spec.ts b/packages/modules/inventory/integration-tests/__tests__/stock-adjusted-events.spec.ts
new file mode 100644
index 0000000000..6e97167748
--- /dev/null
+++ b/packages/modules/inventory/integration-tests/__tests__/stock-adjusted-events.spec.ts
@@ -0,0 +1,123 @@
+import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
+import { Modules } from "@medusajs/framework/utils"
+import { InventoryStockAdjustedEvents } from "@medusajs/framework/utils/inventory"
+
+moduleIntegrationTestRunner({
+  moduleName: Modules.INVENTORY,
+  testSuite: ({ service, getContainer }) => {
+    describe("inventory.stock_adjusted events", () => {
+      let emitted: any[]
+
+      beforeEach(async () => {
+        emitted = []
+        const eventBus = getContainer().resolve(Modules.EVENT_BUS)
+        jest.spyOn(eventBus, "emit").mockImplementation(async (messages) => {
+          emitted.push(...(Array.isArray(messages) ? messages : [messages]))
+        })
+
+        await service.createInventoryItems({
+          id: "iitem_1",
+          sku: "SKU-1",
+        })
+        await service.createInventoryLevels({
+          inventory_item_id: "iitem_1",
+          location_id: "sloc_1",
+          stocked_quantity: 10,
+          reserved_quantity: 0,
+        })
+      })
+
+      it("emits stock_adjusted when stocked quantity changes", async () => {
+        await service.adjustInventory("iitem_1", "sloc_1", -2)
+
+        expect(emitted).toHaveLength(1)
+        expect(emitted[0]).toMatchObject({
+          name: InventoryStockAdjustedEvents.STOCK_ADJUSTED,
+          data: {
+            inventory_item_id: "iitem_1",
+            location_id: "sloc_1",
+            adjustment: "-2",
+            stocked_quantity: "8",
+            previous_stocked_quantity: "10",
+            reserved_quantity: "0",
+            previous_reserved_quantity: "0",
+            available_quantity: "8",
+            previous_available_quantity: "10",
+            reason: "manual",
+          },
+          metadata: {},
+        })
+      })
+
+      it("emits stock_adjusted when a reservation is created", async () => {
+        await service.createReservationItems({
+          inventory_item_id: "iitem_1",
+          location_id: "sloc_1",
+          quantity: 2,
+          line_item_id: "line_1",
+        })
+
+        expect(emitted).toHaveLength(1)
+        expect(emitted[0]).toMatchObject({
+          name: InventoryStockAdjustedEvents.STOCK_ADJUSTED,
+          data: {
+            inventory_item_id: "iitem_1",
+            location_id: "sloc_1",
+            adjustment: "-2",
+            stocked_quantity: "10",
+            previous_stocked_quantity: "10",
+            reserved_quantity: "2",
+            previous_reserved_quantity: "0",
+            available_quantity: "8",
+            previous_available_quantity: "10",
+            reason: "reservation_created",
+          },
+        })
+      })
+
+      it("emits stock_adjusted when a reservation is deleted", async () => {
+        const reservation = await service.createReservationItems({
+          inventory_item_id: "iitem_1",
+          location_id: "sloc_1",
+          quantity: 2,
+          line_item_id: "line_1",
+        })
+        emitted = []
+
+        await service.deleteReservationItems(reservation.id)
+
+        expect(emitted[0]).toMatchObject({
+          name: InventoryStockAdjustedEvents.STOCK_ADJUSTED,
+          data: {
+            inventory_item_id: "iitem_1",
+            location_id: "sloc_1",
+            adjustment: "2",
+            stocked_quantity: "10",
+            reserved_quantity: "0",
+            previous_reserved_quantity: "2",
+            available_quantity: "10",
+            previous_available_quantity: "8",
+            reason: "reservation_deleted",
+          },
+        })
+      })
+
+      it("does not include source ids or a deterministic causality id", async () => {
+        await service.createReservationItems({
+          inventory_item_id: "iitem_1",
+          location_id: "sloc_1",
+          quantity: 2,
+          line_item_id: "line_1",
+        })
+
+        const event = emitted[0].data
+        expect(event).not.toHaveProperty("source")
+        expect(event).not.toHaveProperty("causality_id")
+        expect(event).not.toHaveProperty("workflow_id")
+        expect(event).not.toHaveProperty("reservation_id")
+        expect(event).not.toHaveProperty("order_id")
+        expect(event).not.toHaveProperty("idempotency_key")
+      })
+    })
+  },
+})
diff --git a/packages/core/core-flows/src/inventory/steps/__tests__/adjust-inventory-levels.spec.ts b/packages/core/core-flows/src/inventory/steps/__tests__/adjust-inventory-levels.spec.ts
new file mode 100644
index 0000000000..d4039b6320
--- /dev/null
+++ b/packages/core/core-flows/src/inventory/steps/__tests__/adjust-inventory-levels.spec.ts
@@ -0,0 +1,76 @@
+import { adjustInventoryLevelsStep } from "../adjust-inventory-levels"
+
+describe("adjustInventoryLevelsStep stock events", () => {
+  it("passes workflow metadata to adjust inventory calls", async () => {
+    const inventoryService = {
+      adjustInventory: jest.fn(async () => [
+        {
+          id: "ilev_1",
+          inventory_item_id: "iitem_1",
+          location_id: "sloc_1",
+          stocked_quantity: 8,
+          reserved_quantity: 0,
+          available_quantity: 8,
+        },
+      ]),
+    }
+    const locking = {
+      execute: jest.fn(async (_keys, fn) => fn()),
+    }
+
+    await adjustInventoryLevelsStep.invoke(
+      [
+        {
+          inventory_item_id: "iitem_1",
+          location_id: "sloc_1",
+          adjustment: -2,
+        },
+      ],
+      {
+        container: {
+          resolve(name) {
+            if (name === "inventory") {
+              return inventoryService
+            }
+            if (name === "locking") {
+              return locking
+            }
+          },
+        },
+      } as any
+    )
+
+    expect(inventoryService.adjustInventory).toHaveBeenCalledWith([
+      {
+        inventoryItemId: "iitem_1",
+        locationId: "sloc_1",
+        adjustment: -2,
+        metadata: {
+          workflow_step_id: "adjust-inventory-levels-step",
+          requested_by: "inventory-workflow",
+        },
+      },
+    ])
+  })
+
+  it("does not add source ids to stock events", async () => {
+    const event = {
+      id: "evt_1",
+      name: "inventory.stock_adjusted",
+      inventory_item_id: "iitem_1",
+      location_id: "sloc_1",
+      adjustment: "-2",
+      stocked_quantity: "8",
+      previous_stocked_quantity: "10",
+      reserved_quantity: "0",
+      previous_reserved_quantity: "0",
+      available_quantity: "8",
+      previous_available_quantity: "10",
+      reason: "manual",
+    }
+
+    expect(event).not.toHaveProperty("workflow_id")
+    expect(event).not.toHaveProperty("step_id")
+    expect(event).not.toHaveProperty("causality_id")
+  })
+})
diff --git a/packages/core/core-flows/src/reservation/steps/__tests__/create-reservations-stock-events.spec.ts b/packages/core/core-flows/src/reservation/steps/__tests__/create-reservations-stock-events.spec.ts
new file mode 100644
index 0000000000..cbfedb9d90
--- /dev/null
+++ b/packages/core/core-flows/src/reservation/steps/__tests__/create-reservations-stock-events.spec.ts
@@ -0,0 +1,75 @@
+import { createReservationsStep } from "../create-reservations"
+
+describe("createReservationsStep stock events", () => {
+  it("marks reservations so the inventory service emits stock_adjusted", async () => {
+    const inventoryService = {
+      createReservationItems: jest.fn(async (items) =>
+        items.map((item, index) => ({
+          id: `resitem_${index + 1}`,
+          ...item,
+        }))
+      ),
+      deleteReservationItems: jest.fn(),
+    }
+    const locking = {
+      execute: jest.fn(async (_keys, fn) => fn()),
+    }
+
+    await createReservationsStep.invoke(
+      [
+        {
+          inventory_item_id: "iitem_1",
+          location_id: "sloc_1",
+          quantity: 2,
+          line_item_id: "line_1",
+        },
+      ],
+      {
+        container: {
+          resolve(name) {
+            if (name === "inventory") {
+              return inventoryService
+            }
+            if (name === "locking") {
+              return locking
+            }
+          },
+        },
+      } as any
+    )
+
+    expect(inventoryService.createReservationItems).toHaveBeenCalledWith([
+      {
+        inventory_item_id: "iitem_1",
+        location_id: "sloc_1",
+        quantity: 2,
+        line_item_id: "line_1",
+        metadata: {
+          stock_event_reason: "reservation_created",
+        },
+      },
+    ])
+  })
+
+  it("documents reservation-created as a stock adjusted event", () => {
+    const event = {
+      name: "inventory.stock_adjusted",
+      data: {
+        inventory_item_id: "iitem_1",
+        location_id: "sloc_1",
+        adjustment: "-2",
+        stocked_quantity: "10",
+        previous_stocked_quantity: "10",
+        reserved_quantity: "2",
+        previous_reserved_quantity: "0",
+        available_quantity: "8",
+        previous_available_quantity: "10",
+        reason: "reservation_created",
+      },
+    }
+
+    expect(event.name).toBe("inventory.stock_adjusted")
+    expect(event.data.stocked_quantity).toBe(event.data.previous_stocked_quantity)
+    expect(event.data.adjustment).toBe("-2")
+  })
+})
diff --git a/integration-tests/modules/src/subscribers/inventory-stock-adjusted.ts b/integration-tests/modules/src/subscribers/inventory-stock-adjusted.ts
new file mode 100644
index 0000000000..7db9fd45b1
--- /dev/null
+++ b/integration-tests/modules/src/subscribers/inventory-stock-adjusted.ts
@@ -0,0 +1,35 @@
+import type { SubscriberArgs } from "@medusajs/framework"
+import { InventoryStockAdjustedEvents } from "@medusajs/framework/utils/inventory"
+
+export default async function inventoryStockAdjustedSubscriber({
+  event,
+  container,
+}: SubscriberArgs<any>) {
+  const logger = container.resolve("logger")
+  const search = container.resolve("search")
+  const warehouse = container.resolve("warehouse")
+
+  logger.info(
+    `inventory stock changed: ${event.data.inventory_item_id} at ${event.data.location_id}`
+  )
+
+  await search.updateInventoryAvailability({
+    inventoryItemId: event.data.inventory_item_id,
+    locationId: event.data.location_id,
+    availableQuantity: event.data.available_quantity,
+    stockedQuantity: event.data.stocked_quantity,
+  })
+
+  if (event.data.adjustment !== "0") {
+    await warehouse.syncStockAdjustment({
+      inventoryItemId: event.data.inventory_item_id,
+      locationId: event.data.location_id,
+      adjustment: event.data.adjustment,
+      reason: event.data.reason,
+    })
+  }
+}
+
+export const config = {
+  event: InventoryStockAdjustedEvents.STOCK_ADJUSTED,
+}
diff --git a/docs/inventory/stock-adjusted-events.md b/docs/inventory/stock-adjusted-events.md
new file mode 100644
index 0000000000..bd1f1d9f46
--- /dev/null
+++ b/docs/inventory/stock-adjusted-events.md
@@ -0,0 +1,1192 @@
+# Inventory Stock Adjusted Events
+
+Medusa emits `inventory.stock_adjusted` whenever an inventory level's available
+quantity changes.
+
+The event is useful for:
+
+- search indexes,
+- product availability caches,
+- warehouse sync,
+- stock alerting,
+- admin inventory dashboards,
+- forecasting jobs,
+- external commerce channels.
+
+## Event shape
+
++```json
+{
+  "id": "evt_123",
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "inventory_level_id": "ilev_123",
+  "adjustment": "-2",
+  "stocked_quantity": "10",
+  "previous_stocked_quantity": "10",
+  "reserved_quantity": "2",
+  "previous_reserved_quantity": "0",
+  "available_quantity": "8",
+  "previous_available_quantity": "10",
+  "reason": "reservation_created",
+  "created_at": "2026-05-01T00:00:00.000Z"
+}
++```
+
+`adjustment` is the change in available quantity. It can be caused by either a
+stocked quantity change or a reservation quantity change.
+
+## Reasons
+
+| Reason | Meaning |
+| --- | --- |
+| `manual` | Admin or workflow changed stocked quantity |
+| `reservation_created` | Reservation reduced available quantity |
+| `reservation_updated` | Reservation changed available quantity |
+| `reservation_deleted` | Reservation released available quantity |
+| `fulfillment` | Fulfillment reduced stocked quantity |
+| `return` | Return increased stocked quantity |
+| `unknown` | Source was not provided |
+
+All reasons use the same event type so consumers only need one subscriber.
+
+## Manual adjustment
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "adjustment": "-3",
+  "stocked_quantity": "7",
+  "previous_stocked_quantity": "10",
+  "reserved_quantity": "0",
+  "previous_reserved_quantity": "0",
+  "available_quantity": "7",
+  "previous_available_quantity": "10",
+  "reason": "manual"
+}
++```
+
+A manual adjustment changes stocked quantity.
+
+## Reservation created
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "adjustment": "-2",
+  "stocked_quantity": "10",
+  "previous_stocked_quantity": "10",
+  "reserved_quantity": "2",
+  "previous_reserved_quantity": "0",
+  "available_quantity": "8",
+  "previous_available_quantity": "10",
+  "reason": "reservation_created"
+}
++```
+
+A reservation changes available quantity but keeps stocked quantity unchanged.
+It still emits `inventory.stock_adjusted` because most consumers care about
+sellable availability.
+
+## Reservation deleted
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "adjustment": "2",
+  "stocked_quantity": "10",
+  "previous_stocked_quantity": "10",
+  "reserved_quantity": "0",
+  "previous_reserved_quantity": "2",
+  "available_quantity": "10",
+  "previous_available_quantity": "8",
+  "reason": "reservation_deleted"
+}
++```
+
+A deleted reservation releases sellable availability.
+
+## Checkout behavior
+
+Checkout creates reservations before the order is fully fulfilled. The event
+therefore fires while stock is held for an order, not when warehouse stock is
+physically picked or shipped.
+
+Consumers that need sellable availability can use this event directly:
+
++```ts
+export default async function handleStockAdjusted({ event, container }) {
+  const search = container.resolve("search");
+  await search.updateInventoryAvailability({
+    inventoryItemId: event.data.inventory_item_id,
+    locationId: event.data.location_id,
+    availableQuantity: event.data.available_quantity,
+  });
+}
++```
+
+## Warehouse sync
+
+Warehouse integrations can listen to the same event:
+
++```ts
+export default async function handleStockAdjusted({ event, container }) {
+  const warehouse = container.resolve("warehouse");
+  await warehouse.syncStockAdjustment({
+    inventoryItemId: event.data.inventory_item_id,
+    locationId: event.data.location_id,
+    adjustment: event.data.adjustment,
+    reason: event.data.reason,
+  });
+}
++```
+
+The `reason` field lets the warehouse decide how to handle reservations.
+
+## Event metadata
+
+The event bus metadata includes the workflow event group when the event is
+emitted from a workflow:
+
++```json
+{
+  "metadata": {
+    "eventGroupId": "wg_123"
+  }
+}
++```
+
+The event payload itself is intentionally small. It does not include workflow,
+order, fulfillment, reservation, or idempotency identifiers.
+
+## Dedupe
+
+Consumers should dedupe using `id`.
+
++```ts
+if (await seen.has(event.data.id)) {
+  return;
+}
+
+await seen.add(event.data.id);
++```
+
+If a workflow retries and emits a new event id, the consumer should reconcile by
+reading the current inventory level.
+
+## Reconciliation
+
+Consumers can fetch the inventory level:
+
++```ts
+const level = await medusa.admin.inventoryLevel.retrieve(
+  event.data.inventory_level_id,
+);
++```
+
+Use `inventory_level_id`, `inventory_item_id`, and `location_id` to load the
+current state.
+
+## Availability formula
+
+Available quantity is:
+
++```txt
+available_quantity = stocked_quantity - reserved_quantity
++```
+
+Both stocked and reserved changes can move availability.
+
+## Stocked, reserved, and available
+
+Medusa inventory levels track separate quantities:
+
+| Quantity | Meaning |
+| --- | --- |
+| `stocked_quantity` | physical stock on hand at a location |
+| `reserved_quantity` | stock held by carts/orders/reservations |
+| `available_quantity` | sellable availability |
+
+The new event is named after stock, but it reports availability movement.
+
+A consumer can inspect the before/after fields to understand which quantity
+actually moved:
+
++```ts
+const stockedChanged =
+  event.data.stocked_quantity !== event.data.previous_stocked_quantity;
+
+const reservedChanged =
+  event.data.reserved_quantity !== event.data.previous_reserved_quantity;
+
+const availableChanged =
+  event.data.available_quantity !== event.data.previous_available_quantity;
++```
+
+Most subscribers only need `availableChanged`.
+
+## Event timing in checkout
+
+Checkout can reserve inventory before every downstream business outcome is
+known:
+
+1. Cart line items are converted to order line items.
+2. The reservation step creates reservation items.
+3. `reserved_quantity` increases.
+4. `available_quantity` decreases.
+5. `inventory.stock_adjusted` is emitted.
+6. Payment authorization still happens later.
+7. A later compensation can delete the reservation.
+
+This means a stock-adjusted event can represent a temporary hold.
+
+## Checkout reservation example
+
+Initial inventory:
+
+| Field | Value |
+| --- | ---: |
+| `stocked_quantity` | 10 |
+| `reserved_quantity` | 0 |
+| `available_quantity` | 10 |
+
+Checkout reserves two units:
+
+| Field | Value |
+| --- | ---: |
+| `stocked_quantity` | 10 |
+| `reserved_quantity` | 2 |
+| `available_quantity` | 8 |
+
+The event:
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "adjustment": "-2",
+  "stocked_quantity": "10",
+  "previous_stocked_quantity": "10",
+  "reserved_quantity": "2",
+  "previous_reserved_quantity": "0",
+  "available_quantity": "8",
+  "previous_available_quantity": "10",
+  "reason": "reservation_created"
+}
++```
+
+A search index can safely display eight sellable units.
+
+## Payment failure example
+
+If payment authorization fails after the reservation step, compensation deletes
+the reservation:
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "adjustment": "2",
+  "stocked_quantity": "10",
+  "previous_stocked_quantity": "10",
+  "reserved_quantity": "0",
+  "previous_reserved_quantity": "2",
+  "available_quantity": "10",
+  "previous_available_quantity": "8",
+  "reason": "reservation_deleted"
+}
++```
+
+The pair of events describes availability moving down and then back up.
+
+## Fulfillment example
+
+Fulfillment can reduce stocked quantity:
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "adjustment": "-2",
+  "stocked_quantity": "8",
+  "previous_stocked_quantity": "10",
+  "reserved_quantity": "2",
+  "previous_reserved_quantity": "2",
+  "available_quantity": "6",
+  "previous_available_quantity": "8",
+  "reason": "fulfillment"
+}
++```
+
+A warehouse integration can use this event to record stock leaving a location.
+
+## Cancellation example
+
+Order cancellation can release reservations:
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "adjustment": "2",
+  "stocked_quantity": "8",
+  "previous_stocked_quantity": "8",
+  "reserved_quantity": "0",
+  "previous_reserved_quantity": "2",
+  "available_quantity": "8",
+  "previous_available_quantity": "6",
+  "reason": "reservation_deleted"
+}
++```
+
+The same event type works for cancellation because consumers can use the
+`reason` field.
+
+## Return example
+
+A received return can increase stocked quantity:
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "adjustment": "1",
+  "stocked_quantity": "9",
+  "previous_stocked_quantity": "8",
+  "reserved_quantity": "0",
+  "previous_reserved_quantity": "0",
+  "available_quantity": "9",
+  "previous_available_quantity": "8",
+  "reason": "return"
+}
++```
+
+This event represents physical stock coming back.
+
+## Order edit example
+
+An order edit can add a new line item:
+
+1. The edit workflow computes changed line items.
+2. It creates or updates reservations.
+3. Availability changes.
+4. The event emits with `reason: "reservation_created"` or
+   `reason: "reservation_updated"`.
+5. A later order-edit confirmation event can be emitted separately.
+
+Consumers that need order context should load related order/edit data.
+
+## Event payload omissions
+
+The event intentionally omits business source fields:
+
+| Omitted field | Why it might be useful |
+| --- | --- |
+| `order_id` | connect checkout reservation to order |
+| `cart_id` | connect reservation to cart completion |
+| `line_item_id` | connect reservation to line item |
+| `reservation_id` | connect availability movement to reservation |
+| `fulfillment_id` | connect stock movement to shipment |
+| `return_id` | connect stock movement to return receipt |
+| `workflow_id` | connect event to workflow execution |
+| `workflow_step_id` | connect event to workflow step |
+| `event_group_id` | connect event to grouped release |
+| `idempotency_key` | dedupe business action across retries |
+
+Consumers can use the inventory fields and then query current state if they need
+additional context.
+
+## Dedupe examples
+
+### Event-id dedupe
+
++```ts
+async function handle(event) {
+  if (await processed.has(event.data.id)) {
+    return;
+  }
+
+  await processed.add(event.data.id);
+  await sync(event.data);
+}
++```
+
+This prevents processing the same delivered message twice.
+
+### Reconciliation after retry
+
+If a workflow retries and emits a fresh event id, a consumer can reconcile:
+
++```ts
+async function handle(event) {
+  const current = await inventory.retrieveLevel(
+    event.data.inventory_level_id,
+  );
+
+  await availabilityIndex.set({
+    inventoryItemId: event.data.inventory_item_id,
+    locationId: event.data.location_id,
+    availableQuantity: current.available_quantity,
+  });
+}
++```
+
+This is the recommended strategy for consumers that care about final state.
+
+## Consumer decision matrix
+
+| Consumer | Use `adjustment`? | Use current state? | Notes |
+| --- | --- | --- | --- |
+| search index | no | yes | index latest availability |
+| low-stock alert | yes | no | compare threshold crossing |
+| warehouse sync | yes | maybe | inspect reason first |
+| marketplace sync | no | yes | publish latest sellable quantity |
+| ERP stock ledger | yes | yes | reconcile with source system |
+| analytics | yes | no | aggregate availability movements |
+| admin dashboard | no | yes | show current level |
+| forecasting | yes | yes | distinguish reservation pressure |
+
+## Warehouse guard
+
+A warehouse subscriber can ignore reservation reasons:
+
++```ts
+const physicalReasons = new Set(["manual", "fulfillment", "return"]);
+
+if (!physicalReasons.has(event.data.reason)) {
+  return;
+}
+
+await warehouse.syncStockAdjustment({
+  inventoryItemId: event.data.inventory_item_id,
+  locationId: event.data.location_id,
+  adjustment: event.data.adjustment,
+});
++```
+
+The event does not force this behavior, but `reason` makes it possible.
+
+## Search guard
+
+A search subscriber can update availability for every reason:
+
++```ts
+await search.updateInventory({
+  inventoryItemId: event.data.inventory_item_id,
+  locationId: event.data.location_id,
+  availableQuantity: event.data.available_quantity,
+});
++```
+
+Search consumers usually care about sellable quantity, so reservation events are
+useful.
+
+## Marketplace guard
+
+Marketplaces often require current availability instead of event deltas:
+
++```ts
+const level = await medusa.admin.inventoryLevel.retrieve(
+  event.data.inventory_level_id,
+);
+
+await marketplace.publishAvailability({
+  sku: event.data.inventory_item_id,
+  location: event.data.location_id,
+  quantity: level.available_quantity,
+});
++```
+
+Using current state avoids out-of-order delta application.
+
+## ERP guard
+
+ERP systems often maintain an inventory ledger. They can use both the event and
+a state check:
+
++```ts
+await erp.recordInventoryEvent({
+  eventId: event.data.id,
+  item: event.data.inventory_item_id,
+  location: event.data.location_id,
+  reason: event.data.reason,
+  delta: event.data.adjustment,
+});
+
+const current = await inventory.retrieveLevel(event.data.inventory_level_id);
+await erp.reconcileBalance(current);
++```
+
+## Out-of-order delivery
+
+Consider these emitted events:
+
+| Emitted order | Reason | Available |
+| ---: | --- | ---: |
+| 1 | `reservation_created` | 8 |
+| 2 | `reservation_deleted` | 10 |
+| 3 | `manual` | 7 |
+
+If a consumer receives them out of order and applies deltas, it may briefly
+publish the wrong availability. Consumers that publish authoritative inventory
+should use current-state reconciliation.
+
+## Replay behavior
+
+Replaying event bus messages can re-run subscribers:
+
++```ts
+for (const event of replayedEvents) {
+  await subscriber(event);
+}
++```
+
+If the replayed message has the same event id, event-id dedupe works. If a
+workflow re-executes and emits a new event id for the same business action,
+consumers should reconcile with current inventory.
+
+## Compensation behavior
+
+Workflow compensation can emit the opposite availability event:
+
+| Original event | Compensation event |
+| --- | --- |
+| `reservation_created` with `adjustment: "-2"` | `reservation_deleted` with `adjustment: "2"` |
+| `manual` with `adjustment: "-2"` | `manual` with `adjustment: "2"` |
+| `reservation_updated` with `adjustment: "-1"` | `reservation_updated` with `adjustment: "1"` |
+
+Consumers that maintain a movement ledger can store both events.
+
+## Location movement
+
+If a reservation moves from one location to another:
+
+| Location | Previous reserved | New reserved | Adjustment |
+| --- | ---: | ---: | ---: |
+| `sloc_a` | 2 | 0 | 2 |
+| `sloc_b` | 0 | 2 | -2 |
+
+The service emits stock-adjusted events for both impacted levels.
+
+## Multi-item operations
+
+Bulk operations emit one event per inventory level:
+
++```json
+[
+  {
+    "inventory_item_id": "iitem_1",
+    "location_id": "sloc_1",
+    "adjustment": "-1"
+  },
+  {
+    "inventory_item_id": "iitem_2",
+    "location_id": "sloc_1",
+    "adjustment": "-3"
+  }
+]
++```
+
+Subscribers should not assume one event per order.
+
+## Quantity parsing
+
+Quantities are serialized as strings:
+
++```ts
+const adjustment = Number(event.data.adjustment);
+const available = Number(event.data.available_quantity);
++```
+
+Use Medusa's BigNumber helpers in code that must preserve precision.
+
+## Event grouping
+
+When emitted inside a workflow, the event bus metadata can contain an event
+group:
+
++```json
+{
+  "metadata": {
+    "eventGroupId": "wg_123"
+  }
+}
++```
+
+The subscriber receives this metadata from the event bus transport, not inside
+`event.data`.
+
+## Source lookup patterns
+
+Consumers can attempt to infer source from `reason`:
+
++```ts
+switch (event.data.reason) {
+  case "reservation_created":
+    await loadRecentReservations(event.data.inventory_item_id);
+    break;
+  case "fulfillment":
+    await loadRecentFulfillments(event.data.inventory_item_id);
+    break;
+}
++```
+
+This can work for dashboards, but exact reconciliation requires application
+data.
+
+## Suggested subscriber shape
+
+A robust subscriber should:
+
+1. Store the event id.
+2. Branch by `reason`.
+3. Fetch current inventory state.
+4. Avoid applying deltas to authoritative external stock unless the reason is
+   physical.
+5. Record enough audit information to debug later.
+
++```ts
+export default async function stockAdjusted({ event, container }) {
+  const inventory = container.resolve("inventory");
+  const level = await inventory.retrieveLevel(event.data.inventory_level_id);
+
+  await consumer.write({
+    eventId: event.data.id,
+    reason: event.data.reason,
+    level,
+  });
+}
++```
+
+## Anti-patterns
+
+Avoid this for physical warehouses:
+
++```ts
+await warehouse.decrement(
+  event.data.inventory_item_id,
+  Number(event.data.adjustment),
+);
++```
+
+A reservation-created event has a negative adjustment but does not mean stock
+left the warehouse.
+
+Avoid assuming one order equals one stock event:
+
++```ts
+await orderLedger.markProcessed(event.data.id);
++```
+
+One order can create many inventory events across locations and items.
+
+Avoid assuming event id is stable across workflow retry:
+
++```ts
+const key = event.data.id;
++```
+
+The id is unique per emitted message.
+
+## Compatibility
+
+The event can add more fields later:
+
+| Future field | Example |
+| --- | --- |
+| `source_type` | `reservation` |
+| `source_id` | `resitem_123` |
+| `workflow_id` | `complete-cart` |
+| `workflow_run_id` | `wf_run_123` |
+| `step_id` | `reserve-inventory-step` |
+| `idempotency_key` | `reservation:resitem_123:create` |
+| `order_id` | `order_123` |
+| `fulfillment_id` | `ful_123` |
+
+Consumers should ignore unknown fields.
+
+## Event taxonomy considered
+
+The PR keeps a single event type. Alternatives considered:
+
+| Alternative | Why not in this PR |
+| --- | --- |
+| `inventory.availability_changed` | new vocabulary for consumers |
+| `inventory.reservation_created` | requires more subscriber branching |
+| `inventory.stock_on_hand_adjusted` | too narrow for search/cache |
+| `inventory.level_changed` | less actionable than stock-adjusted |
+
+The single event keeps subscriber setup simple.
+
+## Testing scenarios
+
+A complete app test suite should cover:
+
+- manual negative adjustment,
+- manual positive adjustment,
+- reservation create,
+- reservation update quantity increase,
+- reservation update quantity decrease,
+- reservation location move,
+- reservation delete,
+- reservation restore,
+- fulfillment stock decrement,
+- return stock increment,
+- workflow compensation,
+- bulk multi-item operations,
+- event-group metadata,
+- subscriber dedupe.
+
+## Admin UI usage
+
+The admin dashboard can subscribe and update availability:
+
++```ts
+queryClient.setQueryData(["inventory", event.data.inventory_level_id], {
+  stocked_quantity: event.data.stocked_quantity,
+  reserved_quantity: event.data.reserved_quantity,
+  available_quantity: event.data.available_quantity,
+});
++```
+
+This works for both stock and reservations.
+
+## Channel sync usage
+
+Sales channels often want sellable inventory:
+
++```ts
+await channel.updateVariantAvailability({
+  inventoryItemId: event.data.inventory_item_id,
+  locationId: event.data.location_id,
+  quantity: event.data.available_quantity,
+});
++```
+
+Channel sync consumers usually do not need physical movement semantics.
+
+## Stock ledger usage
+
+A stock ledger should preserve reason:
+
++```ts
+await stockLedger.append({
+  inventoryItemId: event.data.inventory_item_id,
+  locationId: event.data.location_id,
+  reason: event.data.reason,
+  availableDelta: event.data.adjustment,
+  stockedBefore: event.data.previous_stocked_quantity,
+  stockedAfter: event.data.stocked_quantity,
+  reservedBefore: event.data.previous_reserved_quantity,
+  reservedAfter: event.data.reserved_quantity,
+});
++```
+
+This lets reports separate reservation pressure from physical movement.
+
+## Alerting usage
+
+A low-stock alert can ignore reason:
+
++```ts
+if (
+  Number(event.data.previous_available_quantity) > 0 &&
+  Number(event.data.available_quantity) === 0
+) {
+  await alerts.outOfStock(event.data.inventory_item_id);
+}
++```
+
+The customer-facing availability dropped to zero regardless of cause.
+
+## Failure case: double decrement
+
+A warehouse integration subscribes to the event:
+
++```ts
+if (Number(event.data.adjustment) < 0) {
+  await warehouse.decrementStock({
+    item: event.data.inventory_item_id,
+    location: event.data.location_id,
+    quantity: Math.abs(Number(event.data.adjustment)),
+  });
+}
++```
+
+Timeline:
+
+| Step | Reason | Adjustment | Warehouse action |
+| ---: | --- | ---: | --- |
+| 1 | `reservation_created` | -2 | decrement 2 |
+| 2 | `fulfillment` | -2 | decrement 2 |
+
+The warehouse sees four units leave even though only two were fulfilled.
+
+## Failure case: cancellation creates stock
+
+A cancellation releases a reservation:
+
++```json
+{
+  "reason": "reservation_deleted",
+  "adjustment": "2",
+  "stocked_quantity": "10",
+  "previous_stocked_quantity": "10"
+}
++```
+
+A naive ERP subscriber can treat the positive adjustment as stock received:
+
++```ts
+if (Number(event.data.adjustment) > 0) {
+  await erp.receiveStock(event.data.inventory_item_id, event.data.adjustment);
+}
++```
+
+The ERP now thinks two new units arrived even though the same ten units were
+already on hand.
+
+## Failure case: replay without business idempotency
+
+A workflow execution creates a reservation and emits:
+
++```json
+{
+  "id": "evt_a",
+  "reason": "reservation_created",
+  "inventory_item_id": "iitem_123",
+  "adjustment": "-2"
+}
++```
+
+The workflow is retried from the reservation step and emits:
+
++```json
+{
+  "id": "evt_b",
+  "reason": "reservation_created",
+  "inventory_item_id": "iitem_123",
+  "adjustment": "-2"
+}
++```
+
+Event-id dedupe cannot tell whether `evt_a` and `evt_b` describe the same
+business reservation.
+
+## Failure case: order edit ambiguity
+
+An order edit can update reservations for multiple reasons:
+
+- customer adds an item,
+- customer removes an item,
+- item moves to another stock location,
+- required quantity changes because the variant inventory kit changes,
+- compensation reverts a failed edit.
+
+The event only says `reservation_updated`, so consumers that need exact order
+edit semantics must infer context from current state or external logs.
+
+## Better source fields example
+
+A richer reservation-created payload could look like:
+
++```json
+{
+  "name": "inventory.reservation_created",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "reservation_id": "resitem_123",
+  "line_item_id": "line_123",
+  "order_id": "order_123",
+  "workflow_id": "complete-cart",
+  "workflow_step_id": "reserve-inventory-step",
+  "event_group_id": "wg_123",
+  "idempotency_key": "reservation:resitem_123:create",
+  "quantity": "2",
+  "available_quantity": "8"
+}
++```
+
+A physical stock adjustment could look like:
+
++```json
+{
+  "name": "inventory.stock_adjusted",
+  "inventory_item_id": "iitem_123",
+  "location_id": "sloc_123",
+  "source_type": "fulfillment",
+  "source_id": "ful_123",
+  "workflow_id": "create-fulfillment",
+  "workflow_step_id": "adjust-inventory-levels-step",
+  "idempotency_key": "fulfillment:ful_123:iitem_123:sloc_123",
+  "stocked_delta": "-2",
+  "stocked_quantity": "8"
+}
++```
+
+## Better event taxonomy example
+
+A split taxonomy could be:
+
+| Event | Meaning | Primary consumers |
+| --- | --- | --- |
+| `inventory.stock_adjusted` | physical stock on hand changed | warehouse, ERP, stock ledger |
+| `inventory.reservation_created` | stock was held | checkout, availability index |
+| `inventory.reservation_updated` | hold quantity/location changed | availability index, order edit |
+| `inventory.reservation_deleted` | hold was released | availability index, cancellation |
+| `inventory.availability_changed` | derived sellable quantity changed | search, channels, admin UI |
+
+This creates more events, but each event has a sharper meaning.
+
+## Single event with quantity type
+
+If Medusa keeps one event, include a field that names what moved:
+
++```json
+{
+  "name": "inventory.quantity_changed",
+  "quantity_type": "reserved",
+  "available_delta": "-2",
+  "stocked_delta": "0",
+  "reserved_delta": "2",
+  "source_type": "reservation",
+  "source_id": "resitem_123"
+}
++```
+
+A warehouse subscriber can ignore `quantity_type: "reserved"`.
+
+## Subscriber branching example
+
++```ts
+switch (event.data.quantity_type) {
+  case "stocked":
+    await warehouse.sync(event.data);
+    break;
+  case "reserved":
+    await availabilityIndex.sync(event.data);
+    break;
+  case "available":
+    await channel.sync(event.data);
+    break;
+}
++```
+
+Without `quantity_type`, subscribers must infer meaning from before/after
+quantity fields.
+
+## Reconciliation table
+
+| Missing field | Consumer workaround | Risk |
+| --- | --- | --- |
+| `reservation_id` | query recent reservations | races with other reservations |
+| `order_id` | infer from line item | line item can be absent |
+| `fulfillment_id` | query recent fulfillments | wrong fulfillment under concurrency |
+| `workflow_step_id` | inspect reason | not enough for compensation |
+| `idempotency_key` | dedupe by event id | fails on business retry |
+| `event_group_id` in payload | read transport metadata | lost when forwarded |
+
+## Forwarded event problem
+
+A subscriber might forward only `event.data` to a third-party queue:
+
++```ts
+await externalQueue.send(event.data);
++```
+
+If `eventGroupId` exists only in transport metadata, the forwarded system loses
+the only grouping clue.
+
+## Backfill problem
+
+A backfill job can synthesize historical events:
+
++```ts
+for (const level of historicalLevels) {
+  await eventBus.emit({
+    name: "inventory.stock_adjusted",
+    data: buildEvent(level),
+  });
+}
++```
+
+Without source and idempotency fields, historical backfills are hard to
+distinguish from live checkout/fulfillment activity.
+
+## Audit problem
+
+An auditor asks why stock changed at 10:31. The event says:
+
++```json
+{
+  "reason": "unknown",
+  "inventory_item_id": "iitem_123",
+  "adjustment": "-2"
+}
++```
+
+The operations team then has to correlate logs, reservations, fulfillments, and
+orders by timestamp. Explicit source metadata would make the event self-auditing.
+
+## Subscriber test checklist
+
+For stock consumers:
+
+- assert reservation-created events do not call the warehouse adjustment API,
+- assert fulfillment events do call the warehouse adjustment API,
+- assert retry with the same idempotency key is ignored,
+- assert replay with the same business source is ignored,
+- assert cancellation release is not treated as receiving stock,
+- assert current-state reconciliation wins over out-of-order deltas.
+
+For availability consumers:
+
+- assert reservation-created lowers sellable quantity,
+- assert reservation-deleted raises sellable quantity,
+- assert manual stock changes update sellable quantity,
+- assert multi-location moves update both locations,
+- assert current state is fetched before publishing to channels.
+
+## Documentation warning example
+
+The docs should make the domain distinction explicit:
+
++```md
+Do not use reservation events as physical warehouse movements.
+Reservation events change sellable availability only. Use
+inventory.stock_adjusted for stock-on-hand movement and
+inventory.reservation_* for holds/releases.
++```
+
+The current docs show the distinction in fields, but the event name and
+warehouse example still make misuse easy.
+
+## Minimal safe consumer
+
+The safest generic consumer treats the event as a cache invalidation hint:
+
++```ts
+export default async function stockChanged({ event, container }) {
+  const inventory = container.resolve("inventory");
+  const level = await inventory.retrieveInventoryLevel(
+    event.data.inventory_item_id,
+    event.data.location_id,
+  );
+
+  await cache.set(event.data.inventory_level_id, {
+    stocked: level.stocked_quantity,
+    reserved: level.reserved_quantity,
+    available: level.available_quantity,
+  });
+}
++```
+
+This avoids deciding whether the event was a physical movement or a reservation
+hold. Consumers that do need to act on the cause should require stronger source
+fields.
+
+## Subscriber examples
+
+### Search index
+
+Search should index sellable quantity:
+
++```ts
+await search.update({
+  id: event.data.inventory_item_id,
+  location_id: event.data.location_id,
+  available_quantity: event.data.available_quantity,
+});
++```
+
+### Low-stock alert
+
+Alerts should compare old and new availability:
+
++```ts
+const wasAbove = Number(event.data.previous_available_quantity) > 5;
+const isBelow = Number(event.data.available_quantity) <= 5;
+
+if (wasAbove && isBelow) {
+  await alerts.lowStock(event.data.inventory_item_id);
+}
++```
+
+### Warehouse adjustment
+
+Warehouses can treat negative adjustments as stock leaving:
+
++```ts
+if (Number(event.data.adjustment) < 0) {
+  await warehouse.decrement(event.data.inventory_item_id, event.data.adjustment);
+}
++```
+
+## Retry guidance
+
+Stock events can be emitted more than once. Consumers should be idempotent and
+should reconcile with the inventory level when unsure.
+
+## Operational scenarios
+
+### Cart completion
+
+When checkout reserves two units:
+
+| Field | Before | After |
+| --- | ---: | ---: |
+| `stocked_quantity` | 10 | 10 |
+| `reserved_quantity` | 0 | 2 |
+| `available_quantity` | 10 | 8 |
+
+The emitted `adjustment` is `-2`.
+
+### Fulfillment
+
+When fulfillment reduces stock by two units:
+
+| Field | Before | After |
+| --- | ---: | ---: |
+| `stocked_quantity` | 10 | 8 |
+| `reserved_quantity` | 2 | 2 |
+| `available_quantity` | 8 | 6 |
+
+The emitted `adjustment` is `-2`.
+
+### Reservation release
+
+When cancellation releases two reserved units:
+
+| Field | Before | After |
+| --- | ---: | ---: |
+| `stocked_quantity` | 10 | 10 |
+| `reserved_quantity` | 2 | 0 |
+| `available_quantity` | 8 | 10 |
+
+The emitted `adjustment` is `2`.
+
+## Reviewer questions
+
+When reviewing inventory events, ask:
+
+- Does the event identify the business cause?
+- Can a consumer dedupe a retried workflow?
+- Can a consumer link the event to an order, fulfillment, reservation, return, or manual adjustment?
+- Is the same event type used for physical stock and availability holds?
+- Will a warehouse integration decrement stock for a checkout reservation?
+- Does the event group metadata survive into the subscriber payload?
+- Is the id random or deterministic for the same business cause?
+- Are docs teaching consumers to treat reservations as stock movement?
+- Would separate event types make downstream code safer?
```

## Intended Flaws

### Flaw 1: Stock-adjusted events lack source and causality metadata

The event has a random `id`, inventory/location fields, quantities, and a loose `reason`, but it does not include a deterministic causality/idempotency key or source identifiers such as workflow id, step id, order id, fulfillment id, reservation id, return id, or event group id in the payload. The publisher only copies `eventGroupId` into event-bus metadata, and tests explicitly assert the event lacks source fields.

Relevant line references:

- `packages/core/utils/src/inventory/stock-adjusted-events.ts:7-29` defines the public event payload without source, causality, or idempotency fields.
- `packages/modules/inventory/src/services/stock-adjusted-event-publisher.ts:31-63` builds each event with `crypto.randomUUID()` and only attaches `eventGroupId` to metadata.
- `packages/modules/inventory/integration-tests/__tests__/stock-adjusted-events.spec.ts:105-119` asserts the event has no source, causality id, workflow id, reservation id, order id, or idempotency key.
- `docs/inventory/stock-adjusted-events.md:155-182` tells consumers to dedupe by random event id and refetch on retries.

Why this is a real flaw:

Inventory events are consumed by systems that need reconciliation, not just notifications. A warehouse sync, search index, channel inventory sync, or low-stock alert needs to know why quantity changed and whether two events represent the same business action. Random event ids dedupe a single delivery but not a retried workflow, a replay, or multiple events emitted by one order edit. Without causality, consumers cannot safely answer "this reservation came from order X", "this adjustment came from fulfillment Y", or "I have already processed this compensation".

Better implementation direction:

Add explicit causal metadata: `source_type`, `source_id`, `workflow_id`, `workflow_step_id`, `event_group_id`, and a deterministic `idempotency_key` derived from the business cause and inventory level. Keep event bus metadata, but put the contract fields in the payload. Subscribers should be able to dedupe and reconcile without knowing Medusa's transport internals.

### Flaw 2: Reservation holds are emitted as `inventory.stock_adjusted` like final stock movement

The PR emits the same `inventory.stock_adjusted` event for reservation create/update/delete paths that only change `reserved_quantity` and sellable availability. Stocked quantity stays unchanged, but the event's `adjustment` is computed from available quantity, so a reservation hold looks like stock physically moved. Docs and subscriber examples encourage warehouse integrations to listen to the same event.

Relevant line references:

- `packages/modules/inventory/src/services/inventory-module.ts:237-259` emits `inventory.stock_adjusted` from reservation creation after increasing `reserved_quantity`.
- `packages/modules/inventory/src/services/inventory-module.ts:736-760` emits `inventory.stock_adjusted` from reservation updates.
- `packages/modules/inventory/src/services/inventory-module.ts:1309-1331` emits `inventory.stock_adjusted` from reservation deletion/restoration.
- `packages/modules/inventory/integration-tests/__tests__/stock-adjusted-events.spec.ts:47-72` asserts reservation creation emits `stock_adjusted` with stocked quantity unchanged.
- `packages/core/core-flows/src/reservation/steps/__tests__/create-reservations-stock-events.spec.ts:47-72` documents reservation-created as a stock-adjusted event.
- `docs/inventory/stock-adjusted-events.md:74-94` documents reservation creation under the stock-adjusted event.
- `docs/inventory/stock-adjusted-events.md:135-149` shows a warehouse subscriber syncing `adjustment` from the same event.

Why this is a real flaw:

Reserved quantity is not the same as physical stock. Checkout reservations hold availability before payment/fulfillment is final. If a warehouse, ERP, or external channel treats `inventory.stock_adjusted` as actual stock movement, it can decrement stock when a cart reserves inventory, then decrement again on fulfillment, or create compensating adjustments when a reservation is canceled. The event name and shape collapse two different business facts: "sellable availability changed" and "stock on hand changed".

Better implementation direction:

Use distinct event types or distinct event families. Emit `inventory.stock_adjusted` only when `stocked_quantity` changes. Emit `inventory.reservation_created`, `inventory.reservation_updated`, `inventory.reservation_deleted`, or `inventory.availability_changed` for reservation holds and releases. If a combined event is kept, include an explicit `quantity_type: "stocked" | "reserved" | "available"` and source metadata, and make docs warn warehouse consumers not to treat reservation events as physical movement.

## Hints

### Flaw 1 Hints

1. If the same workflow retries, what stable key lets a subscriber know it has already processed this business action?
2. Where does Medusa already carry grouped workflow event metadata?
3. Can a downstream system link this event back to an order, fulfillment, reservation, return, or manual adjustment?

### Flaw 2 Hints

1. Which field actually changes when a reservation is created: `stocked_quantity` or `reserved_quantity`?
2. Would a warehouse call a checkout hold a stock adjustment?
3. What should the event name mean to someone who only sees the subscriber payload?

## Expected Answer

A strong review should say that the product-level change is useful because inventory consumers need events, but the implementation creates an unsafe contract. It lacks enough causality to dedupe/reconcile business actions, and it conflates reservation holds with physical stock adjustments.

For flaw 1, the learner should identify that events include random ids and quantity snapshots but no deterministic idempotency key or source identifiers. The impact is duplicate/replayed workflow events and impossible reconciliation for external systems. The fix is explicit causal metadata in the payload.

For flaw 2, the learner should identify that reservation create/update/delete paths emit `inventory.stock_adjusted` despite only changing `reserved_quantity` and availability. The impact is downstream consumers treating checkout holds as final stock movement. The fix is distinct reservation/availability events or an explicit quantity type and source contract.

The best answers should connect both flaws to event API design: the hardest part is not emitting a message; it is naming the business fact precisely enough that consumers can safely act on it months later.

## Expert Debrief

At the product level, a stock event is valuable. Inventory is one of the places where polling and eventual repair jobs are expensive. Search indexes, marketplaces, low-stock alerts, warehouses, and reporting systems all want timely inventory state.

The first contract is causality. A useful event answers not only "what changed?" but "why did it change?" and "is this the same business action I already processed?" A random event id is a delivery artifact, not a business idempotency key. The Medusa workflow/event infrastructure already has concepts such as event groups; inventory events should preserve the relevant cause in the payload.

The second contract is vocabulary. `stocked_quantity`, `reserved_quantity`, and `available_quantity` are deliberately separate. A reservation changes availability, not stock on hand. A fulfillment, return, adjustment, or receiving flow changes stock. If one event name covers both, downstream consumers write ambiguous code.

The failure modes are concrete:

- A warehouse integration decrements physical stock when checkout creates a reservation, then decrements again when fulfillment happens.
- A marketplace sync cannot tell whether two events are a retry of the same order or two independent adjustments.
- A cancellation releases a reservation and appears as positive stock adjustment, inflating an external ERP.
- A search index can update availability correctly, but the same event misleads a stock-ledger consumer.
- A replay job emits fresh random ids, so id-based dedupe does not help.

The reviewer thought process should be: inspect the domain model first. If the code has separate stocked/reserved/available fields, the event model probably needs to preserve that distinction. Then inspect the event as an API boundary. Every event that triggers external work needs source identity and idempotency.

The better design is a small event taxonomy: `inventory.stock_adjusted` for physical stock, reservation-specific events for holds/releases, and optionally `inventory.availability_changed` as a derived event for search/cache consumers. Each event should include source and idempotency metadata.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: missing causality/idempotency/source metadata and reservation holds being emitted as stock-adjusted events. It explains reconciliation/dedupe failures, physical-stock vs availability confusion, and recommends causal payload fields plus distinct reservation/availability/stock event types.
- `partial`: The answer finds one flaw completely and gestures at either generic event metadata or generic inventory naming without tying it to Medusa workflows, event groups, stocked/reserved/available quantities, and reservation lifecycle.
- `miss`: The answer focuses on event bus transport, in-memory tests, formatting, naming nits, or docs wording while missing idempotency/causality and reservation-vs-stock semantics.
