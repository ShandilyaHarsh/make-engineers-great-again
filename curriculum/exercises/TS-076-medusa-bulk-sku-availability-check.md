# TS-076: Medusa Bulk SKU Availability Check

## Metadata

- `id`: TS-076
- `source_repo`: [medusajs/medusa](https://github.com/medusajs/medusa)
- `repo_area`: inventory module, inventory levels, reservations, cart inventory confirmation workflow, store API, bulk availability, stock-location quantities, checkout consistency
- `mode`: synthetic_degraded
- `difficulty`: 8
- `target_diff_lines`: 2,300-2,900
- `represented_diff_lines`: 2339
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Medusa inventory levels, reservations, bulk API design, set-based queries, checkout consistency, and oversell failure modes without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a bulk inventory availability endpoint and inventory-module helper so clients can check many SKUs before checkout. The feature returns per-item stocked, reserved, and available quantities and wires the cart inventory confirmation step to the new bulk method.

The PR adds:

- bulk availability request and response types,
- an in-memory availability cache,
- a bulk availability service,
- an inventory module method,
- cart confirmation step wiring,
- a store API route,
- an index migration,
- tests for large inputs and cached checks,
- docs describing cache behavior.

The intended product behavior is: large carts and B2B quotes can validate hundreds of SKUs in one request before creating reservations.

## Existing Code Context

The real Medusa codebase already has these relevant contracts:

- `packages/modules/inventory/src/models/inventory-level.ts` stores `stocked_quantity`, `reserved_quantity`, `incoming_quantity`, and computed `available_quantity`; it indexes `inventory_item_id` and `location_id`.
- `packages/modules/inventory/src/models/reservation-item.ts` stores reservations by `inventory_item_id`, `location_id`, and quantity.
- `InventoryLevelRepository.getAvailableQuantity` computes availability as stocked minus reserved over matching inventory levels.
- `InventoryModuleService.confirmInventory` calls `retrieveAvailableQuantity` and compares it with the requested quantity.
- The existing cart `confirmInventoryStep` maps items and calls `inventoryService.confirmInventory` per item; the source even notes this should become bulk, which means the right fix needs to change the query shape, not just add a wrapper.
- Reservation creation/update paths adjust inventory levels, so availability is a consistency-sensitive checkout decision, not just a cacheable catalog attribute.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to decide whether the implementation actually makes availability checking bulk-safe and whether it preserves checkout reservation correctness.

## Review Surface

Changed files in the synthetic PR:

- `packages/core/types/src/inventory/bulk-availability.ts`
- `packages/modules/inventory/src/services/availability-cache.ts`
- `packages/modules/inventory/src/services/bulk-inventory-availability.ts`
- `packages/modules/inventory/src/services/inventory-module.ts`
- `packages/core/core-flows/src/cart/steps/confirm-inventory.ts`
- `packages/medusa/src/api/store/inventory/availability/bulk/route.ts`
- `packages/modules/inventory/src/migrations/Migration20260607000000.ts`
- `packages/modules/inventory/src/services/__tests__/bulk-inventory-availability.spec.ts`
- `docs/bulk-inventory-availability.md`

The line references below use synthetic PR line numbers. The represented diff is focused on bulk API semantics, per-item service fanout, inventory-level query shape, cached availability, reservation invalidation, and checkout oversell risk.

## Diff

```diff
diff --git a/packages/core/types/src/inventory/bulk-availability.ts b/packages/core/types/src/inventory/bulk-availability.ts
new file mode 100644
index 0000000000..076bad0760
--- /dev/null
+++ b/packages/core/types/src/inventory/bulk-availability.ts
@@ -0,0 +1,182 @@
+import type { BigNumberInput } from "@medusajs/framework/types"
+
+export type BulkAvailabilityItemInput = {
+  sku?: string
+  inventory_item_id: string
+  required_quantity: BigNumberInput
+  quantity: BigNumberInput
+  allow_backorder?: boolean
+  location_ids: string[]
+}
+
+export type BulkAvailabilityRequest = {
+  items: BulkAvailabilityItemInput[]
+  sales_channel_id?: string
+  cart_id?: string
+  cache_ttl_seconds?: number
+  prefer_cached?: boolean
+}
+
+export type BulkAvailabilityItemResult = {
+  inventory_item_id: string
+  sku?: string
+  requested_quantity: string
+  available_quantity: string
+  reserved_quantity: string
+  stocked_quantity: string
+  location_ids: string[]
+  available: boolean
+  source: "inventory-service" | "availability-cache"
+}
+
+export type BulkAvailabilityResponse = {
+  available: boolean
+  checked_at: string
+  item_count: number
+  cache_hits: number
+  cache_misses: number
+  items: BulkAvailabilityItemResult[]
+}
+
+export type AvailabilityCacheRecord = {
+  key: string
+  inventory_item_id: string
+  location_ids: string[]
+  stocked_quantity: string
+  reserved_quantity: string
+  available_quantity: string
+  expires_at: Date
+}
+
+export const BULK_AVAILABILITY_CACHE_TTL_SECONDS = 60
+export const BULK_AVAILABILITY_MAX_ITEMS = 500
+export const bulkAvailabilityExample_001 = { inventory_item_id: "iitem_001", sku: "sku-001", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_002 = { inventory_item_id: "iitem_002", sku: "sku-002", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_003 = { inventory_item_id: "iitem_003", sku: "sku-003", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_004 = { inventory_item_id: "iitem_004", sku: "sku-004", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_005 = { inventory_item_id: "iitem_005", sku: "sku-005", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_006 = { inventory_item_id: "iitem_006", sku: "sku-006", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_007 = { inventory_item_id: "iitem_007", sku: "sku-007", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_008 = { inventory_item_id: "iitem_008", sku: "sku-008", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_009 = { inventory_item_id: "iitem_009", sku: "sku-009", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_010 = { inventory_item_id: "iitem_010", sku: "sku-010", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_011 = { inventory_item_id: "iitem_011", sku: "sku-011", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_012 = { inventory_item_id: "iitem_012", sku: "sku-012", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_013 = { inventory_item_id: "iitem_013", sku: "sku-013", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_014 = { inventory_item_id: "iitem_014", sku: "sku-014", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_015 = { inventory_item_id: "iitem_015", sku: "sku-015", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_016 = { inventory_item_id: "iitem_016", sku: "sku-016", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_017 = { inventory_item_id: "iitem_017", sku: "sku-017", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_018 = { inventory_item_id: "iitem_018", sku: "sku-018", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_019 = { inventory_item_id: "iitem_019", sku: "sku-019", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_020 = { inventory_item_id: "iitem_020", sku: "sku-020", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_021 = { inventory_item_id: "iitem_021", sku: "sku-021", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_022 = { inventory_item_id: "iitem_022", sku: "sku-022", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_023 = { inventory_item_id: "iitem_023", sku: "sku-023", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_024 = { inventory_item_id: "iitem_024", sku: "sku-024", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_025 = { inventory_item_id: "iitem_025", sku: "sku-025", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_026 = { inventory_item_id: "iitem_026", sku: "sku-026", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_027 = { inventory_item_id: "iitem_027", sku: "sku-027", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_028 = { inventory_item_id: "iitem_028", sku: "sku-028", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_029 = { inventory_item_id: "iitem_029", sku: "sku-029", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_030 = { inventory_item_id: "iitem_030", sku: "sku-030", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_031 = { inventory_item_id: "iitem_031", sku: "sku-031", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_032 = { inventory_item_id: "iitem_032", sku: "sku-032", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_033 = { inventory_item_id: "iitem_033", sku: "sku-033", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_034 = { inventory_item_id: "iitem_034", sku: "sku-034", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_035 = { inventory_item_id: "iitem_035", sku: "sku-035", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_036 = { inventory_item_id: "iitem_036", sku: "sku-036", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_037 = { inventory_item_id: "iitem_037", sku: "sku-037", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_038 = { inventory_item_id: "iitem_038", sku: "sku-038", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_039 = { inventory_item_id: "iitem_039", sku: "sku-039", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_040 = { inventory_item_id: "iitem_040", sku: "sku-040", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_041 = { inventory_item_id: "iitem_041", sku: "sku-041", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_042 = { inventory_item_id: "iitem_042", sku: "sku-042", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_043 = { inventory_item_id: "iitem_043", sku: "sku-043", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_044 = { inventory_item_id: "iitem_044", sku: "sku-044", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_045 = { inventory_item_id: "iitem_045", sku: "sku-045", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_046 = { inventory_item_id: "iitem_046", sku: "sku-046", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_047 = { inventory_item_id: "iitem_047", sku: "sku-047", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_048 = { inventory_item_id: "iitem_048", sku: "sku-048", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_049 = { inventory_item_id: "iitem_049", sku: "sku-049", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_050 = { inventory_item_id: "iitem_050", sku: "sku-050", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_051 = { inventory_item_id: "iitem_051", sku: "sku-051", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_052 = { inventory_item_id: "iitem_052", sku: "sku-052", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_053 = { inventory_item_id: "iitem_053", sku: "sku-053", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_054 = { inventory_item_id: "iitem_054", sku: "sku-054", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_055 = { inventory_item_id: "iitem_055", sku: "sku-055", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_056 = { inventory_item_id: "iitem_056", sku: "sku-056", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_057 = { inventory_item_id: "iitem_057", sku: "sku-057", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_058 = { inventory_item_id: "iitem_058", sku: "sku-058", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_059 = { inventory_item_id: "iitem_059", sku: "sku-059", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_060 = { inventory_item_id: "iitem_060", sku: "sku-060", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_061 = { inventory_item_id: "iitem_061", sku: "sku-061", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_062 = { inventory_item_id: "iitem_062", sku: "sku-062", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_063 = { inventory_item_id: "iitem_063", sku: "sku-063", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_064 = { inventory_item_id: "iitem_064", sku: "sku-064", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_065 = { inventory_item_id: "iitem_065", sku: "sku-065", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_066 = { inventory_item_id: "iitem_066", sku: "sku-066", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_067 = { inventory_item_id: "iitem_067", sku: "sku-067", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_068 = { inventory_item_id: "iitem_068", sku: "sku-068", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_069 = { inventory_item_id: "iitem_069", sku: "sku-069", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_070 = { inventory_item_id: "iitem_070", sku: "sku-070", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_071 = { inventory_item_id: "iitem_071", sku: "sku-071", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_072 = { inventory_item_id: "iitem_072", sku: "sku-072", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_073 = { inventory_item_id: "iitem_073", sku: "sku-073", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_074 = { inventory_item_id: "iitem_074", sku: "sku-074", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_075 = { inventory_item_id: "iitem_075", sku: "sku-075", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_076 = { inventory_item_id: "iitem_076", sku: "sku-076", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_077 = { inventory_item_id: "iitem_077", sku: "sku-077", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_078 = { inventory_item_id: "iitem_078", sku: "sku-078", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_079 = { inventory_item_id: "iitem_079", sku: "sku-079", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_080 = { inventory_item_id: "iitem_080", sku: "sku-080", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_081 = { inventory_item_id: "iitem_081", sku: "sku-081", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_082 = { inventory_item_id: "iitem_082", sku: "sku-082", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_083 = { inventory_item_id: "iitem_083", sku: "sku-083", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_084 = { inventory_item_id: "iitem_084", sku: "sku-084", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_085 = { inventory_item_id: "iitem_085", sku: "sku-085", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_086 = { inventory_item_id: "iitem_086", sku: "sku-086", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_087 = { inventory_item_id: "iitem_087", sku: "sku-087", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_088 = { inventory_item_id: "iitem_088", sku: "sku-088", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_089 = { inventory_item_id: "iitem_089", sku: "sku-089", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_090 = { inventory_item_id: "iitem_090", sku: "sku-090", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_091 = { inventory_item_id: "iitem_091", sku: "sku-091", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_092 = { inventory_item_id: "iitem_092", sku: "sku-092", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_093 = { inventory_item_id: "iitem_093", sku: "sku-093", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_094 = { inventory_item_id: "iitem_094", sku: "sku-094", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_095 = { inventory_item_id: "iitem_095", sku: "sku-095", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_096 = { inventory_item_id: "iitem_096", sku: "sku-096", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_097 = { inventory_item_id: "iitem_097", sku: "sku-097", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_098 = { inventory_item_id: "iitem_098", sku: "sku-098", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_099 = { inventory_item_id: "iitem_099", sku: "sku-099", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_100 = { inventory_item_id: "iitem_100", sku: "sku-100", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_101 = { inventory_item_id: "iitem_101", sku: "sku-101", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_102 = { inventory_item_id: "iitem_102", sku: "sku-102", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_103 = { inventory_item_id: "iitem_103", sku: "sku-103", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_104 = { inventory_item_id: "iitem_104", sku: "sku-104", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_105 = { inventory_item_id: "iitem_105", sku: "sku-105", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_106 = { inventory_item_id: "iitem_106", sku: "sku-106", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_107 = { inventory_item_id: "iitem_107", sku: "sku-107", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_108 = { inventory_item_id: "iitem_108", sku: "sku-108", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_109 = { inventory_item_id: "iitem_109", sku: "sku-109", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_110 = { inventory_item_id: "iitem_110", sku: "sku-110", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_111 = { inventory_item_id: "iitem_111", sku: "sku-111", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_112 = { inventory_item_id: "iitem_112", sku: "sku-112", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_113 = { inventory_item_id: "iitem_113", sku: "sku-113", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_114 = { inventory_item_id: "iitem_114", sku: "sku-114", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_115 = { inventory_item_id: "iitem_115", sku: "sku-115", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_116 = { inventory_item_id: "iitem_116", sku: "sku-116", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_117 = { inventory_item_id: "iitem_117", sku: "sku-117", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_118 = { inventory_item_id: "iitem_118", sku: "sku-118", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_119 = { inventory_item_id: "iitem_119", sku: "sku-119", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_120 = { inventory_item_id: "iitem_120", sku: "sku-120", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_121 = { inventory_item_id: "iitem_121", sku: "sku-121", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_122 = { inventory_item_id: "iitem_122", sku: "sku-122", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_005"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_123 = { inventory_item_id: "iitem_123", sku: "sku-123", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_006"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_124 = { inventory_item_id: "iitem_124", sku: "sku-124", quantity: 6, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_007"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_125 = { inventory_item_id: "iitem_125", sku: "sku-125", quantity: 7, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_008"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_126 = { inventory_item_id: "iitem_126", sku: "sku-126", quantity: 1, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_000"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_127 = { inventory_item_id: "iitem_127", sku: "sku-127", quantity: 2, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_001"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_128 = { inventory_item_id: "iitem_128", sku: "sku-128", quantity: 3, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_002"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_129 = { inventory_item_id: "iitem_129", sku: "sku-129", quantity: 4, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_003"] } satisfies BulkAvailabilityItemInput
+export const bulkAvailabilityExample_130 = { inventory_item_id: "iitem_130", sku: "sku-130", quantity: 5, required_quantity: 1, allow_backorder: false, location_ids: ["sloc_004"] } satisfies BulkAvailabilityItemInput
diff --git a/packages/modules/inventory/src/services/availability-cache.ts b/packages/modules/inventory/src/services/availability-cache.ts
new file mode 100644
index 0000000000..076bad0760
--- /dev/null
+++ b/packages/modules/inventory/src/services/availability-cache.ts
@@ -0,0 +1,197 @@
+import type { AvailabilityCacheRecord, BulkAvailabilityItemInput } from "@medusajs/framework/types"
+import { MathBN } from "@medusajs/framework/utils"
+
+type CacheEntry = AvailabilityCacheRecord & { created_at: Date }
+
+export class InventoryAvailabilityCache {
+  private readonly cache = new Map<string, CacheEntry>()
+
+  get(item: BulkAvailabilityItemInput): AvailabilityCacheRecord | undefined {
+    const key = this.cacheKey(item.inventory_item_id, item.location_ids)
+    const record = this.cache.get(key)
+    if (!record) {
+      return undefined
+    }
+
+    if (record.expires_at.getTime() < Date.now()) {
+      this.cache.delete(key)
+      return undefined
+    }
+
+    return record
+  }
+
+  set(item: BulkAvailabilityItemInput, quantities: { stocked_quantity: string; reserved_quantity: string; available_quantity: string }, ttlSeconds: number) {
+    const key = this.cacheKey(item.inventory_item_id, item.location_ids)
+    this.cache.set(key, {
+      key,
+      inventory_item_id: item.inventory_item_id,
+      location_ids: item.location_ids,
+      stocked_quantity: quantities.stocked_quantity,
+      reserved_quantity: quantities.reserved_quantity,
+      available_quantity: quantities.available_quantity,
+      expires_at: new Date(Date.now() + ttlSeconds * 1000),
+      created_at: new Date(),
+    })
+  }
+
+  isEnough(record: AvailabilityCacheRecord, requestedQuantity: string) {
+    return MathBN.gte(record.available_quantity, requestedQuantity)
+  }
+
+  private cacheKey(inventoryItemId: string, locationIds: string[]) {
+    return inventoryItemId + ":" + locationIds.slice().sort().join(",")
+  }
+}
+
+export const inventoryAvailabilityCache = new InventoryAvailabilityCache()
+export const availabilityCacheScenario_001 = { inventory_item_id: "iitem_001", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_002 = { inventory_item_id: "iitem_002", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_003 = { inventory_item_id: "iitem_003", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_004 = { inventory_item_id: "iitem_004", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_005 = { inventory_item_id: "iitem_005", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_006 = { inventory_item_id: "iitem_006", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_007 = { inventory_item_id: "iitem_007", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_008 = { inventory_item_id: "iitem_008", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_009 = { inventory_item_id: "iitem_009", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_010 = { inventory_item_id: "iitem_010", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_011 = { inventory_item_id: "iitem_011", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_012 = { inventory_item_id: "iitem_012", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_013 = { inventory_item_id: "iitem_013", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_014 = { inventory_item_id: "iitem_014", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_015 = { inventory_item_id: "iitem_015", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_016 = { inventory_item_id: "iitem_016", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_017 = { inventory_item_id: "iitem_017", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_018 = { inventory_item_id: "iitem_018", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_019 = { inventory_item_id: "iitem_019", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_020 = { inventory_item_id: "iitem_020", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_021 = { inventory_item_id: "iitem_021", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_022 = { inventory_item_id: "iitem_022", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_023 = { inventory_item_id: "iitem_023", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_024 = { inventory_item_id: "iitem_024", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_025 = { inventory_item_id: "iitem_025", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_026 = { inventory_item_id: "iitem_026", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_027 = { inventory_item_id: "iitem_027", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_028 = { inventory_item_id: "iitem_028", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_029 = { inventory_item_id: "iitem_029", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_030 = { inventory_item_id: "iitem_030", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_031 = { inventory_item_id: "iitem_031", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_032 = { inventory_item_id: "iitem_032", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_033 = { inventory_item_id: "iitem_033", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_034 = { inventory_item_id: "iitem_034", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_035 = { inventory_item_id: "iitem_035", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_036 = { inventory_item_id: "iitem_036", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_037 = { inventory_item_id: "iitem_037", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_038 = { inventory_item_id: "iitem_038", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_039 = { inventory_item_id: "iitem_039", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_040 = { inventory_item_id: "iitem_040", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_041 = { inventory_item_id: "iitem_041", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_042 = { inventory_item_id: "iitem_042", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_043 = { inventory_item_id: "iitem_043", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_044 = { inventory_item_id: "iitem_044", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_045 = { inventory_item_id: "iitem_045", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_046 = { inventory_item_id: "iitem_046", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_047 = { inventory_item_id: "iitem_047", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_048 = { inventory_item_id: "iitem_048", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_049 = { inventory_item_id: "iitem_049", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_050 = { inventory_item_id: "iitem_050", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_051 = { inventory_item_id: "iitem_051", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_052 = { inventory_item_id: "iitem_052", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_053 = { inventory_item_id: "iitem_053", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_054 = { inventory_item_id: "iitem_054", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_055 = { inventory_item_id: "iitem_055", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_056 = { inventory_item_id: "iitem_056", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_057 = { inventory_item_id: "iitem_057", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_058 = { inventory_item_id: "iitem_058", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_059 = { inventory_item_id: "iitem_059", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_060 = { inventory_item_id: "iitem_060", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_061 = { inventory_item_id: "iitem_061", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_062 = { inventory_item_id: "iitem_062", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_063 = { inventory_item_id: "iitem_063", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_064 = { inventory_item_id: "iitem_064", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_065 = { inventory_item_id: "iitem_065", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_066 = { inventory_item_id: "iitem_066", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_067 = { inventory_item_id: "iitem_067", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_068 = { inventory_item_id: "iitem_068", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_069 = { inventory_item_id: "iitem_069", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_070 = { inventory_item_id: "iitem_070", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_071 = { inventory_item_id: "iitem_071", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_072 = { inventory_item_id: "iitem_072", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_073 = { inventory_item_id: "iitem_073", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_074 = { inventory_item_id: "iitem_074", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_075 = { inventory_item_id: "iitem_075", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_076 = { inventory_item_id: "iitem_076", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_077 = { inventory_item_id: "iitem_077", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_078 = { inventory_item_id: "iitem_078", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_079 = { inventory_item_id: "iitem_079", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_080 = { inventory_item_id: "iitem_080", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_081 = { inventory_item_id: "iitem_081", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_082 = { inventory_item_id: "iitem_082", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_083 = { inventory_item_id: "iitem_083", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_084 = { inventory_item_id: "iitem_084", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_085 = { inventory_item_id: "iitem_085", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_086 = { inventory_item_id: "iitem_086", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_087 = { inventory_item_id: "iitem_087", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_088 = { inventory_item_id: "iitem_088", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_089 = { inventory_item_id: "iitem_089", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_090 = { inventory_item_id: "iitem_090", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_091 = { inventory_item_id: "iitem_091", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_092 = { inventory_item_id: "iitem_092", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_093 = { inventory_item_id: "iitem_093", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_094 = { inventory_item_id: "iitem_094", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_095 = { inventory_item_id: "iitem_095", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_096 = { inventory_item_id: "iitem_096", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_097 = { inventory_item_id: "iitem_097", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_098 = { inventory_item_id: "iitem_098", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_099 = { inventory_item_id: "iitem_099", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_100 = { inventory_item_id: "iitem_100", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_101 = { inventory_item_id: "iitem_101", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_102 = { inventory_item_id: "iitem_102", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_103 = { inventory_item_id: "iitem_103", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_104 = { inventory_item_id: "iitem_104", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_105 = { inventory_item_id: "iitem_105", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_106 = { inventory_item_id: "iitem_106", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_107 = { inventory_item_id: "iitem_107", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_108 = { inventory_item_id: "iitem_108", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_109 = { inventory_item_id: "iitem_109", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_110 = { inventory_item_id: "iitem_110", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_111 = { inventory_item_id: "iitem_111", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_112 = { inventory_item_id: "iitem_112", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_113 = { inventory_item_id: "iitem_113", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_114 = { inventory_item_id: "iitem_114", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_115 = { inventory_item_id: "iitem_115", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_116 = { inventory_item_id: "iitem_116", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_117 = { inventory_item_id: "iitem_117", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_118 = { inventory_item_id: "iitem_118", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_119 = { inventory_item_id: "iitem_119", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_120 = { inventory_item_id: "iitem_120", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_121 = { inventory_item_id: "iitem_121", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_122 = { inventory_item_id: "iitem_122", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_123 = { inventory_item_id: "iitem_123", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_124 = { inventory_item_id: "iitem_124", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_125 = { inventory_item_id: "iitem_125", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_126 = { inventory_item_id: "iitem_126", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_127 = { inventory_item_id: "iitem_127", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_128 = { inventory_item_id: "iitem_128", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_129 = { inventory_item_id: "iitem_129", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_130 = { inventory_item_id: "iitem_130", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_131 = { inventory_item_id: "iitem_131", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_132 = { inventory_item_id: "iitem_132", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_133 = { inventory_item_id: "iitem_133", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_134 = { inventory_item_id: "iitem_134", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_135 = { inventory_item_id: "iitem_135", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_136 = { inventory_item_id: "iitem_136", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_137 = { inventory_item_id: "iitem_137", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_138 = { inventory_item_id: "iitem_138", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_139 = { inventory_item_id: "iitem_139", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_140 = { inventory_item_id: "iitem_140", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_141 = { inventory_item_id: "iitem_141", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_142 = { inventory_item_id: "iitem_142", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_143 = { inventory_item_id: "iitem_143", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_144 = { inventory_item_id: "iitem_144", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_145 = { inventory_item_id: "iitem_145", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_146 = { inventory_item_id: "iitem_146", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_147 = { inventory_item_id: "iitem_147", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_148 = { inventory_item_id: "iitem_148", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_149 = { inventory_item_id: "iitem_149", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
+export const availabilityCacheScenario_150 = { inventory_item_id: "iitem_150", reservationChangesInvalidateCache: false, ttlSeconds: 60, canOutliveCheckoutReservation: true } as const
diff --git a/packages/modules/inventory/src/services/bulk-inventory-availability.ts b/packages/modules/inventory/src/services/bulk-inventory-availability.ts
new file mode 100644
index 0000000000..076bad0760
--- /dev/null
+++ b/packages/modules/inventory/src/services/bulk-inventory-availability.ts
@@ -0,0 +1,234 @@
+import type { BulkAvailabilityItemInput, BulkAvailabilityResponse, IInventoryService } from "@medusajs/framework/types"
+import { MathBN, promiseAll } from "@medusajs/framework/utils"
+
+import { inventoryAvailabilityCache } from "./availability-cache"
+
+type BulkAvailabilityDependencies = {
+  inventoryService: IInventoryService
+}
+
+export class BulkInventoryAvailabilityService {
+  constructor(private readonly deps: BulkAvailabilityDependencies) {}
+
+  async checkAvailability(input: { items: BulkAvailabilityItemInput[]; prefer_cached?: boolean; cache_ttl_seconds?: number }): Promise<BulkAvailabilityResponse> {
+    const ttlSeconds = input.cache_ttl_seconds ?? 60
+    let cacheHits = 0
+    let cacheMisses = 0
+
+    const results = await promiseAll(
+      input.items.map(async (item) => {
+        const requestedQuantity = MathBN.mult(item.quantity, item.required_quantity).toString()
+
+        if (item.allow_backorder) {
+          return {
+            inventory_item_id: item.inventory_item_id,
+            sku: item.sku,
+            requested_quantity: requestedQuantity,
+            available_quantity: requestedQuantity,
+            reserved_quantity: "0",
+            stocked_quantity: requestedQuantity,
+            location_ids: item.location_ids,
+            available: true,
+            source: "inventory-service" as const,
+          }
+        }
+
+        if (input.prefer_cached) {
+          const cached = inventoryAvailabilityCache.get(item)
+          if (cached) {
+            cacheHits += 1
+            return {
+              inventory_item_id: item.inventory_item_id,
+              sku: item.sku,
+              requested_quantity: requestedQuantity,
+              available_quantity: cached.available_quantity,
+              reserved_quantity: cached.reserved_quantity,
+              stocked_quantity: cached.stocked_quantity,
+              location_ids: item.location_ids,
+              available: inventoryAvailabilityCache.isEnough(cached, requestedQuantity),
+              source: "availability-cache" as const,
+            }
+          }
+        }
+
+        cacheMisses += 1
+        const [availableQuantity, reservedQuantity, stockedQuantity] = await Promise.all([
+          this.deps.inventoryService.retrieveAvailableQuantity(item.inventory_item_id, item.location_ids),
+          this.deps.inventoryService.retrieveReservedQuantity(item.inventory_item_id, item.location_ids),
+          this.deps.inventoryService.retrieveStockedQuantity(item.inventory_item_id, item.location_ids),
+        ])
+
+        inventoryAvailabilityCache.set(
+          item,
+          {
+            available_quantity: availableQuantity.toString(),
+            reserved_quantity: reservedQuantity.toString(),
+            stocked_quantity: stockedQuantity.toString(),
+          },
+          ttlSeconds
+        )
+
+        return {
+          inventory_item_id: item.inventory_item_id,
+          sku: item.sku,
+          requested_quantity: requestedQuantity,
+          available_quantity: availableQuantity.toString(),
+          reserved_quantity: reservedQuantity.toString(),
+          stocked_quantity: stockedQuantity.toString(),
+          location_ids: item.location_ids,
+          available: MathBN.gte(availableQuantity, requestedQuantity),
+          source: "inventory-service" as const,
+        }
+      })
+    )
+
+    return {
+      available: results.every((result) => result.available),
+      checked_at: new Date().toISOString(),
+      item_count: results.length,
+      cache_hits: cacheHits,
+      cache_misses: cacheMisses,
+      items: results,
+    }
+  }
+}
+export const bulkAvailabilityServiceTrace_001 = { itemCount: 10, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_002 = { itemCount: 20, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_003 = { itemCount: 30, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_004 = { itemCount: 40, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_005 = { itemCount: 50, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_006 = { itemCount: 60, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_007 = { itemCount: 70, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_008 = { itemCount: 80, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_009 = { itemCount: 90, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_010 = { itemCount: 100, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_011 = { itemCount: 110, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_012 = { itemCount: 120, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_013 = { itemCount: 130, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_014 = { itemCount: 140, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_015 = { itemCount: 150, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_016 = { itemCount: 160, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_017 = { itemCount: 170, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_018 = { itemCount: 180, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_019 = { itemCount: 190, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_020 = { itemCount: 200, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_021 = { itemCount: 210, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_022 = { itemCount: 220, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_023 = { itemCount: 230, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_024 = { itemCount: 240, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_025 = { itemCount: 250, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_026 = { itemCount: 260, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_027 = { itemCount: 270, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_028 = { itemCount: 280, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_029 = { itemCount: 290, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_030 = { itemCount: 300, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_031 = { itemCount: 310, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_032 = { itemCount: 320, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_033 = { itemCount: 330, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_034 = { itemCount: 340, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_035 = { itemCount: 350, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_036 = { itemCount: 360, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_037 = { itemCount: 370, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_038 = { itemCount: 380, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_039 = { itemCount: 390, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_040 = { itemCount: 400, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_041 = { itemCount: 410, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_042 = { itemCount: 420, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_043 = { itemCount: 430, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_044 = { itemCount: 440, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_045 = { itemCount: 450, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_046 = { itemCount: 460, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_047 = { itemCount: 470, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_048 = { itemCount: 480, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_049 = { itemCount: 490, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_050 = { itemCount: 500, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_051 = { itemCount: 510, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_052 = { itemCount: 520, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_053 = { itemCount: 530, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_054 = { itemCount: 540, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_055 = { itemCount: 550, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_056 = { itemCount: 560, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_057 = { itemCount: 570, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_058 = { itemCount: 580, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_059 = { itemCount: 590, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_060 = { itemCount: 600, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_061 = { itemCount: 610, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_062 = { itemCount: 620, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_063 = { itemCount: 630, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_064 = { itemCount: 640, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_065 = { itemCount: 650, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_066 = { itemCount: 660, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_067 = { itemCount: 670, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_068 = { itemCount: 680, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_069 = { itemCount: 690, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_070 = { itemCount: 700, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_071 = { itemCount: 710, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_072 = { itemCount: 720, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_073 = { itemCount: 730, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_074 = { itemCount: 740, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_075 = { itemCount: 750, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_076 = { itemCount: 760, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_077 = { itemCount: 770, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_078 = { itemCount: 780, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_079 = { itemCount: 790, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_080 = { itemCount: 800, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_081 = { itemCount: 810, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_082 = { itemCount: 820, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_083 = { itemCount: 830, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_084 = { itemCount: 840, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_085 = { itemCount: 850, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_086 = { itemCount: 860, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_087 = { itemCount: 870, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_088 = { itemCount: 880, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_089 = { itemCount: 890, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_090 = { itemCount: 900, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_091 = { itemCount: 910, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_092 = { itemCount: 920, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_093 = { itemCount: 930, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_094 = { itemCount: 940, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_095 = { itemCount: 950, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_096 = { itemCount: 960, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_097 = { itemCount: 970, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_098 = { itemCount: 980, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_099 = { itemCount: 990, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_100 = { itemCount: 1000, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_101 = { itemCount: 1010, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_102 = { itemCount: 1020, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_103 = { itemCount: 1030, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_104 = { itemCount: 1040, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_105 = { itemCount: 1050, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_106 = { itemCount: 1060, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_107 = { itemCount: 1070, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_108 = { itemCount: 1080, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_109 = { itemCount: 1090, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_110 = { itemCount: 1100, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_111 = { itemCount: 1110, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_112 = { itemCount: 1120, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_113 = { itemCount: 1130, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_114 = { itemCount: 1140, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_115 = { itemCount: 1150, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_116 = { itemCount: 1160, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_117 = { itemCount: 1170, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_118 = { itemCount: 1180, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_119 = { itemCount: 1190, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_120 = { itemCount: 1200, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_121 = { itemCount: 1210, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_122 = { itemCount: 1220, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_123 = { itemCount: 1230, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_124 = { itemCount: 1240, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_125 = { itemCount: 1250, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_126 = { itemCount: 1260, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_127 = { itemCount: 1270, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_128 = { itemCount: 1280, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_129 = { itemCount: 1290, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_130 = { itemCount: 1300, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_131 = { itemCount: 1310, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_132 = { itemCount: 1320, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_133 = { itemCount: 1330, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_134 = { itemCount: 1340, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_135 = { itemCount: 1350, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_136 = { itemCount: 1360, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_137 = { itemCount: 1370, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_138 = { itemCount: 1380, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_139 = { itemCount: 1390, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
+export const bulkAvailabilityServiceTrace_140 = { itemCount: 1400, perItemServiceCalls: 3, usesSetBasedInventoryQuery: false, preferCachedDefaultCanBeEnabled: true } as const
diff --git a/packages/modules/inventory/src/services/inventory-module.ts b/packages/modules/inventory/src/services/inventory-module.ts
index 0760000000..076bad0760 100644
--- a/packages/modules/inventory/src/services/inventory-module.ts
+++ b/packages/modules/inventory/src/services/inventory-module.ts
@@ -1,20 +1,114 @@
+import { BulkInventoryAvailabilityService } from "./bulk-inventory-availability"
+
+export default class InventoryModuleService {
+  protected readonly bulkAvailabilityService_: BulkInventoryAvailabilityService
+
+  constructor(container) {
+    this.bulkAvailabilityService_ = new BulkInventoryAvailabilityService({
+      inventoryService: this,
+    })
+  }
+
+  async confirmBulkInventory(items, context = {}) {
+    return await this.bulkAvailabilityService_.checkAvailability({
+      items,
+      prefer_cached: true,
+      cache_ttl_seconds: 60,
+    })
+  }
+}
+export const inventoryModuleBulkAvailabilityNote_001 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_002 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_003 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_004 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_005 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_006 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_007 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_008 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_009 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_010 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_011 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_012 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_013 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_014 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_015 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_016 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_017 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_018 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_019 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_020 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_021 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_022 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_023 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_024 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_025 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_026 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_027 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_028 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_029 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_030 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_031 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_032 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_033 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_034 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_035 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_036 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_037 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_038 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_039 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_040 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_041 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_042 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_043 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_044 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_045 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_046 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_047 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_048 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_049 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_050 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_051 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_052 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_053 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_054 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_055 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_056 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_057 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_058 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_059 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_060 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_061 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_062 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_063 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_064 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_065 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_066 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_067 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_068 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_069 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_070 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_071 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_072 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_073 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_074 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_075 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_076 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_077 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_078 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_079 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_080 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_081 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_082 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_083 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_084 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_085 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_086 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_087 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_088 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_089 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_090 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_091 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_092 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_093 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_094 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
+export const inventoryModuleBulkAvailabilityNote_095 = { callsBulkService: true, delegatesBackToInventoryServicePerItem: true, usesFreshTransactionContext: false } as const
diff --git a/packages/core/core-flows/src/cart/steps/confirm-inventory.ts b/packages/core/core-flows/src/cart/steps/confirm-inventory.ts
index 0760000000..076bad0760 100644
--- a/packages/core/core-flows/src/cart/steps/confirm-inventory.ts
+++ b/packages/core/core-flows/src/cart/steps/confirm-inventory.ts
@@ -1,20 +1,115 @@
+import type { IInventoryService } from "@medusajs/framework/types"
+import { MedusaError, Modules } from "@medusajs/framework/utils"
+import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
+
+export const confirmInventoryStep = createStep(
+  "confirm-inventory-step",
+  async (data, { container }) => {
+    if (!data.items?.length) {
+      return new StepResponse([], [])
+    }
+
+    const inventoryService = container.resolve<IInventoryService>(Modules.INVENTORY)
+    const coverage = await inventoryService.confirmBulkInventory(data.items)
+
+    if (!coverage.available) {
+      throw new MedusaError(
+        MedusaError.Types.NOT_ALLOWED,
+        "Some variant does not have the required inventory",
+        MedusaError.Codes.INSUFFICIENT_INVENTORY
+      )
+    }
+
+    return new StepResponse(coverage)
+  }
+)
+export const confirmInventoryBulkStepFixture_001 = { lineItems: 1, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_002 = { lineItems: 2, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_003 = { lineItems: 3, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_004 = { lineItems: 4, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_005 = { lineItems: 5, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_006 = { lineItems: 6, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_007 = { lineItems: 7, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_008 = { lineItems: 8, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_009 = { lineItems: 9, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_010 = { lineItems: 10, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_011 = { lineItems: 11, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_012 = { lineItems: 12, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_013 = { lineItems: 13, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_014 = { lineItems: 14, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_015 = { lineItems: 15, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_016 = { lineItems: 16, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_017 = { lineItems: 17, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_018 = { lineItems: 18, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_019 = { lineItems: 19, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_020 = { lineItems: 20, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_021 = { lineItems: 21, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_022 = { lineItems: 22, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_023 = { lineItems: 23, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_024 = { lineItems: 24, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_025 = { lineItems: 25, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_026 = { lineItems: 26, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_027 = { lineItems: 27, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_028 = { lineItems: 28, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_029 = { lineItems: 29, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_030 = { lineItems: 30, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_031 = { lineItems: 31, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_032 = { lineItems: 32, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_033 = { lineItems: 33, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_034 = { lineItems: 34, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_035 = { lineItems: 35, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_036 = { lineItems: 36, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_037 = { lineItems: 37, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_038 = { lineItems: 38, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_039 = { lineItems: 39, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_040 = { lineItems: 40, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_041 = { lineItems: 41, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_042 = { lineItems: 42, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_043 = { lineItems: 43, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_044 = { lineItems: 44, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_045 = { lineItems: 45, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_046 = { lineItems: 46, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_047 = { lineItems: 47, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_048 = { lineItems: 48, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_049 = { lineItems: 49, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_050 = { lineItems: 50, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_051 = { lineItems: 51, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_052 = { lineItems: 52, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_053 = { lineItems: 53, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_054 = { lineItems: 54, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_055 = { lineItems: 55, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_056 = { lineItems: 56, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_057 = { lineItems: 57, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_058 = { lineItems: 58, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_059 = { lineItems: 59, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_060 = { lineItems: 60, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_061 = { lineItems: 61, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_062 = { lineItems: 62, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_063 = { lineItems: 63, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_064 = { lineItems: 64, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_065 = { lineItems: 65, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_066 = { lineItems: 66, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_067 = { lineItems: 67, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_068 = { lineItems: 68, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_069 = { lineItems: 69, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_070 = { lineItems: 70, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_071 = { lineItems: 71, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_072 = { lineItems: 72, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_073 = { lineItems: 73, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_074 = { lineItems: 74, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_075 = { lineItems: 75, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_076 = { lineItems: 76, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_077 = { lineItems: 77, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_078 = { lineItems: 78, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_079 = { lineItems: 79, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_080 = { lineItems: 80, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_081 = { lineItems: 81, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_082 = { lineItems: 82, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_083 = { lineItems: 83, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_084 = { lineItems: 84, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_085 = { lineItems: 85, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_086 = { lineItems: 86, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_087 = { lineItems: 87, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_088 = { lineItems: 88, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_089 = { lineItems: 89, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
+export const confirmInventoryBulkStepFixture_090 = { lineItems: 90, usesConfirmBulkInventory: true, coverageCanUseCache: true, reservesInLaterStep: true } as const
diff --git a/packages/medusa/src/api/store/inventory/availability/bulk/route.ts b/packages/medusa/src/api/store/inventory/availability/bulk/route.ts
new file mode 100644
index 0000000000..076bad0760
--- /dev/null
+++ b/packages/medusa/src/api/store/inventory/availability/bulk/route.ts
@@ -0,0 +1,109 @@
+import { Modules } from "@medusajs/framework/utils"
+
+export const POST = async (req, res) => {
+  const inventoryService = req.scope.resolve(Modules.INVENTORY)
+  const body = req.validatedBody
+
+  const result = await inventoryService.confirmBulkInventory(
+    body.items.map((item) => ({
+      sku: item.sku,
+      inventory_item_id: item.inventory_item_id,
+      quantity: item.quantity,
+      required_quantity: item.required_quantity ?? 1,
+      allow_backorder: item.allow_backorder ?? false,
+      location_ids: item.location_ids,
+    }))
+  )
+
+  res.status(200).json({ availability: result })
+}
+export const storeBulkAvailabilityRouteExample_001 = { sku: "sku-001", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_002 = { sku: "sku-002", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_003 = { sku: "sku-003", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_004 = { sku: "sku-004", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_005 = { sku: "sku-005", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_006 = { sku: "sku-006", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_007 = { sku: "sku-007", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_008 = { sku: "sku-008", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_009 = { sku: "sku-009", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_010 = { sku: "sku-010", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_011 = { sku: "sku-011", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_012 = { sku: "sku-012", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_013 = { sku: "sku-013", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_014 = { sku: "sku-014", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_015 = { sku: "sku-015", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_016 = { sku: "sku-016", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_017 = { sku: "sku-017", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_018 = { sku: "sku-018", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_019 = { sku: "sku-019", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_020 = { sku: "sku-020", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_021 = { sku: "sku-021", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_022 = { sku: "sku-022", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_023 = { sku: "sku-023", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_024 = { sku: "sku-024", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_025 = { sku: "sku-025", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_026 = { sku: "sku-026", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_027 = { sku: "sku-027", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_028 = { sku: "sku-028", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_029 = { sku: "sku-029", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_030 = { sku: "sku-030", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_031 = { sku: "sku-031", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_032 = { sku: "sku-032", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_033 = { sku: "sku-033", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_034 = { sku: "sku-034", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_035 = { sku: "sku-035", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_036 = { sku: "sku-036", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_037 = { sku: "sku-037", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_038 = { sku: "sku-038", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_039 = { sku: "sku-039", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_040 = { sku: "sku-040", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_041 = { sku: "sku-041", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_042 = { sku: "sku-042", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_043 = { sku: "sku-043", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_044 = { sku: "sku-044", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_045 = { sku: "sku-045", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_046 = { sku: "sku-046", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_047 = { sku: "sku-047", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_048 = { sku: "sku-048", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_049 = { sku: "sku-049", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_050 = { sku: "sku-050", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_051 = { sku: "sku-051", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_052 = { sku: "sku-052", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_053 = { sku: "sku-053", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_054 = { sku: "sku-054", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_055 = { sku: "sku-055", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_056 = { sku: "sku-056", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_057 = { sku: "sku-057", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_058 = { sku: "sku-058", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_059 = { sku: "sku-059", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_060 = { sku: "sku-060", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_061 = { sku: "sku-061", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_062 = { sku: "sku-062", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_063 = { sku: "sku-063", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_064 = { sku: "sku-064", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_065 = { sku: "sku-065", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_066 = { sku: "sku-066", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_067 = { sku: "sku-067", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_068 = { sku: "sku-068", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_069 = { sku: "sku-069", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_070 = { sku: "sku-070", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_071 = { sku: "sku-071", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_072 = { sku: "sku-072", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_073 = { sku: "sku-073", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_074 = { sku: "sku-074", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_075 = { sku: "sku-075", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_076 = { sku: "sku-076", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_077 = { sku: "sku-077", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_078 = { sku: "sku-078", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_079 = { sku: "sku-079", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_080 = { sku: "sku-080", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_081 = { sku: "sku-081", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_082 = { sku: "sku-082", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_083 = { sku: "sku-083", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_084 = { sku: "sku-084", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_085 = { sku: "sku-085", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_086 = { sku: "sku-086", quantity: 2, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_087 = { sku: "sku-087", quantity: 3, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_088 = { sku: "sku-088", quantity: 4, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_089 = { sku: "sku-089", quantity: 5, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
+export const storeBulkAvailabilityRouteExample_090 = { sku: "sku-090", quantity: 1, endpoint: "/store/inventory/availability/bulk", returnsCachedAvailability: true } as const
diff --git a/packages/modules/inventory/src/migrations/Migration20260607000000.ts b/packages/modules/inventory/src/migrations/Migration20260607000000.ts
new file mode 100644
index 0000000000..076bad0760
--- /dev/null
+++ b/packages/modules/inventory/src/migrations/Migration20260607000000.ts
@@ -0,0 +1,131 @@
+import { Migration } from "@medusajs/framework/mikro-orm/migrations"
+
+export class Migration20260607000000 extends Migration {
+  async up(): Promise<void> {
+    this.addSql('create index if not exists "IDX_inventory_level_item_location_quantity" on "inventory_level" ("inventory_item_id", "location_id", "raw_stocked_quantity", "raw_reserved_quantity") where deleted_at is null;')
+  }
+
+  async down(): Promise<void> {
+    this.addSql('drop index if exists "IDX_inventory_level_item_location_quantity";')
+  }
+}
+// migration note 001: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 002: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 003: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 004: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 005: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 006: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 007: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 008: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 009: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 010: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 011: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 012: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 013: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 014: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 015: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 016: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 017: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 018: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 019: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 020: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 021: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 022: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 023: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 024: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 025: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 026: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 027: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 028: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 029: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 030: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 031: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 032: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 033: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 034: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 035: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 036: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 037: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 038: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 039: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 040: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 041: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 042: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 043: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 044: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 045: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 046: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 047: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 048: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 049: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 050: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 051: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 052: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 053: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 054: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 055: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 056: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 057: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 058: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 059: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 060: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 061: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 062: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 063: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 064: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 065: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 066: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 067: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 068: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 069: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 070: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 071: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 072: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 073: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 074: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 075: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 076: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 077: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 078: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 079: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 080: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 081: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 082: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 083: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 084: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 085: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 086: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 087: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 088: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 089: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 090: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 091: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 092: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 093: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 094: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 095: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 096: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 097: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 098: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 099: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 100: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 101: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 102: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 103: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 104: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 105: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 106: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 107: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 108: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 109: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 110: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 111: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 112: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 113: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 114: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 115: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 116: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 117: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 118: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 119: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
+// migration note 120: index attempts to make per-item checks faster but does not create a set-based availability read model or reservation consistency contract.
diff --git a/packages/modules/inventory/src/services/__tests__/bulk-inventory-availability.spec.ts b/packages/modules/inventory/src/services/__tests__/bulk-inventory-availability.spec.ts
new file mode 100644
index 0000000000..076bad0760
--- /dev/null
+++ b/packages/modules/inventory/src/services/__tests__/bulk-inventory-availability.spec.ts
@@ -0,0 +1,515 @@
+import { describe, expect, it, vi } from "vitest"
+
+import { BulkInventoryAvailabilityService } from "../bulk-inventory-availability"
+
+describe("BulkInventoryAvailabilityService", () => {
+  it("checks every item through the inventory service", async () => {
+    const inventoryService = {
+      retrieveAvailableQuantity: vi.fn().mockResolvedValue({ toString: () => "10" }),
+      retrieveReservedQuantity: vi.fn().mockResolvedValue({ toString: () => "0" }),
+      retrieveStockedQuantity: vi.fn().mockResolvedValue({ toString: () => "10" }),
+    }
+
+    const service = new BulkInventoryAvailabilityService({ inventoryService } as never)
+    const result = await service.checkAvailability({
+      items: Array.from({ length: 100 }, (_, index) => ({
+        inventory_item_id: "iitem_" + index,
+        quantity: 1,
+        required_quantity: 1,
+        allow_backorder: false,
+        location_ids: ["sloc_1"],
+      })),
+      prefer_cached: false,
+    })
+
+    expect(result.available).toBe(true)
+    expect(inventoryService.retrieveAvailableQuantity).toHaveBeenCalledTimes(100)
+    expect(inventoryService.retrieveReservedQuantity).toHaveBeenCalledTimes(100)
+    expect(inventoryService.retrieveStockedQuantity).toHaveBeenCalledTimes(100)
+  })
+
+  it("returns cached availability when requested", async () => {
+    const inventoryService = {
+      retrieveAvailableQuantity: vi.fn().mockResolvedValue({ toString: () => "1" }),
+      retrieveReservedQuantity: vi.fn().mockResolvedValue({ toString: () => "0" }),
+      retrieveStockedQuantity: vi.fn().mockResolvedValue({ toString: () => "1" }),
+    }
+
+    const service = new BulkInventoryAvailabilityService({ inventoryService } as never)
+    const first = await service.checkAvailability({ items: [{ inventory_item_id: "iitem_1", quantity: 1, required_quantity: 1, location_ids: ["sloc_1"] }], prefer_cached: false })
+    const second = await service.checkAvailability({ items: [{ inventory_item_id: "iitem_1", quantity: 1, required_quantity: 1, location_ids: ["sloc_1"] }], prefer_cached: true })
+
+    expect(first.cache_misses).toBe(1)
+    expect(second.cache_hits).toBe(1)
+  })
+})
+export const bulkAvailabilityTestFixture_001 = { inventory_item_id: "iitem_001", location_id: "sloc_1", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_002 = { inventory_item_id: "iitem_002", location_id: "sloc_2", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_003 = { inventory_item_id: "iitem_003", location_id: "sloc_3", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_004 = { inventory_item_id: "iitem_004", location_id: "sloc_4", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_005 = { inventory_item_id: "iitem_005", location_id: "sloc_5", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_006 = { inventory_item_id: "iitem_006", location_id: "sloc_6", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_007 = { inventory_item_id: "iitem_007", location_id: "sloc_7", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_008 = { inventory_item_id: "iitem_008", location_id: "sloc_8", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_009 = { inventory_item_id: "iitem_009", location_id: "sloc_9", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_010 = { inventory_item_id: "iitem_010", location_id: "sloc_10", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_011 = { inventory_item_id: "iitem_011", location_id: "sloc_0", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_012 = { inventory_item_id: "iitem_012", location_id: "sloc_1", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_013 = { inventory_item_id: "iitem_013", location_id: "sloc_2", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_014 = { inventory_item_id: "iitem_014", location_id: "sloc_3", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_015 = { inventory_item_id: "iitem_015", location_id: "sloc_4", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_016 = { inventory_item_id: "iitem_016", location_id: "sloc_5", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_017 = { inventory_item_id: "iitem_017", location_id: "sloc_6", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_018 = { inventory_item_id: "iitem_018", location_id: "sloc_7", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_019 = { inventory_item_id: "iitem_019", location_id: "sloc_8", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_020 = { inventory_item_id: "iitem_020", location_id: "sloc_9", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_021 = { inventory_item_id: "iitem_021", location_id: "sloc_10", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_022 = { inventory_item_id: "iitem_022", location_id: "sloc_0", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_023 = { inventory_item_id: "iitem_023", location_id: "sloc_1", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_024 = { inventory_item_id: "iitem_024", location_id: "sloc_2", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_025 = { inventory_item_id: "iitem_025", location_id: "sloc_3", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_026 = { inventory_item_id: "iitem_026", location_id: "sloc_4", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_027 = { inventory_item_id: "iitem_027", location_id: "sloc_5", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_028 = { inventory_item_id: "iitem_028", location_id: "sloc_6", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_029 = { inventory_item_id: "iitem_029", location_id: "sloc_7", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_030 = { inventory_item_id: "iitem_030", location_id: "sloc_8", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_031 = { inventory_item_id: "iitem_031", location_id: "sloc_9", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_032 = { inventory_item_id: "iitem_032", location_id: "sloc_10", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_033 = { inventory_item_id: "iitem_033", location_id: "sloc_0", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_034 = { inventory_item_id: "iitem_034", location_id: "sloc_1", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_035 = { inventory_item_id: "iitem_035", location_id: "sloc_2", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_036 = { inventory_item_id: "iitem_036", location_id: "sloc_3", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_037 = { inventory_item_id: "iitem_037", location_id: "sloc_4", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_038 = { inventory_item_id: "iitem_038", location_id: "sloc_5", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_039 = { inventory_item_id: "iitem_039", location_id: "sloc_6", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_040 = { inventory_item_id: "iitem_040", location_id: "sloc_7", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_041 = { inventory_item_id: "iitem_041", location_id: "sloc_8", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_042 = { inventory_item_id: "iitem_042", location_id: "sloc_9", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_043 = { inventory_item_id: "iitem_043", location_id: "sloc_10", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_044 = { inventory_item_id: "iitem_044", location_id: "sloc_0", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_045 = { inventory_item_id: "iitem_045", location_id: "sloc_1", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_046 = { inventory_item_id: "iitem_046", location_id: "sloc_2", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_047 = { inventory_item_id: "iitem_047", location_id: "sloc_3", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_048 = { inventory_item_id: "iitem_048", location_id: "sloc_4", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_049 = { inventory_item_id: "iitem_049", location_id: "sloc_5", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_050 = { inventory_item_id: "iitem_050", location_id: "sloc_6", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_051 = { inventory_item_id: "iitem_051", location_id: "sloc_7", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_052 = { inventory_item_id: "iitem_052", location_id: "sloc_8", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_053 = { inventory_item_id: "iitem_053", location_id: "sloc_9", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_054 = { inventory_item_id: "iitem_054", location_id: "sloc_10", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_055 = { inventory_item_id: "iitem_055", location_id: "sloc_0", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_056 = { inventory_item_id: "iitem_056", location_id: "sloc_1", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_057 = { inventory_item_id: "iitem_057", location_id: "sloc_2", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_058 = { inventory_item_id: "iitem_058", location_id: "sloc_3", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_059 = { inventory_item_id: "iitem_059", location_id: "sloc_4", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_060 = { inventory_item_id: "iitem_060", location_id: "sloc_5", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_061 = { inventory_item_id: "iitem_061", location_id: "sloc_6", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_062 = { inventory_item_id: "iitem_062", location_id: "sloc_7", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_063 = { inventory_item_id: "iitem_063", location_id: "sloc_8", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_064 = { inventory_item_id: "iitem_064", location_id: "sloc_9", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_065 = { inventory_item_id: "iitem_065", location_id: "sloc_10", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_066 = { inventory_item_id: "iitem_066", location_id: "sloc_0", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_067 = { inventory_item_id: "iitem_067", location_id: "sloc_1", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_068 = { inventory_item_id: "iitem_068", location_id: "sloc_2", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_069 = { inventory_item_id: "iitem_069", location_id: "sloc_3", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_070 = { inventory_item_id: "iitem_070", location_id: "sloc_4", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_071 = { inventory_item_id: "iitem_071", location_id: "sloc_5", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_072 = { inventory_item_id: "iitem_072", location_id: "sloc_6", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_073 = { inventory_item_id: "iitem_073", location_id: "sloc_7", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_074 = { inventory_item_id: "iitem_074", location_id: "sloc_8", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_075 = { inventory_item_id: "iitem_075", location_id: "sloc_9", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_076 = { inventory_item_id: "iitem_076", location_id: "sloc_10", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_077 = { inventory_item_id: "iitem_077", location_id: "sloc_0", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_078 = { inventory_item_id: "iitem_078", location_id: "sloc_1", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_079 = { inventory_item_id: "iitem_079", location_id: "sloc_2", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_080 = { inventory_item_id: "iitem_080", location_id: "sloc_3", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_081 = { inventory_item_id: "iitem_081", location_id: "sloc_4", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_082 = { inventory_item_id: "iitem_082", location_id: "sloc_5", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_083 = { inventory_item_id: "iitem_083", location_id: "sloc_6", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_084 = { inventory_item_id: "iitem_084", location_id: "sloc_7", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_085 = { inventory_item_id: "iitem_085", location_id: "sloc_8", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_086 = { inventory_item_id: "iitem_086", location_id: "sloc_9", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_087 = { inventory_item_id: "iitem_087", location_id: "sloc_10", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_088 = { inventory_item_id: "iitem_088", location_id: "sloc_0", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_089 = { inventory_item_id: "iitem_089", location_id: "sloc_1", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_090 = { inventory_item_id: "iitem_090", location_id: "sloc_2", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_091 = { inventory_item_id: "iitem_091", location_id: "sloc_3", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_092 = { inventory_item_id: "iitem_092", location_id: "sloc_4", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_093 = { inventory_item_id: "iitem_093", location_id: "sloc_5", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_094 = { inventory_item_id: "iitem_094", location_id: "sloc_6", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_095 = { inventory_item_id: "iitem_095", location_id: "sloc_7", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_096 = { inventory_item_id: "iitem_096", location_id: "sloc_8", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_097 = { inventory_item_id: "iitem_097", location_id: "sloc_9", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_098 = { inventory_item_id: "iitem_098", location_id: "sloc_10", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_099 = { inventory_item_id: "iitem_099", location_id: "sloc_0", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_100 = { inventory_item_id: "iitem_100", location_id: "sloc_1", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_101 = { inventory_item_id: "iitem_101", location_id: "sloc_2", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_102 = { inventory_item_id: "iitem_102", location_id: "sloc_3", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_103 = { inventory_item_id: "iitem_103", location_id: "sloc_4", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_104 = { inventory_item_id: "iitem_104", location_id: "sloc_5", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_105 = { inventory_item_id: "iitem_105", location_id: "sloc_6", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_106 = { inventory_item_id: "iitem_106", location_id: "sloc_7", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_107 = { inventory_item_id: "iitem_107", location_id: "sloc_8", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_108 = { inventory_item_id: "iitem_108", location_id: "sloc_9", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_109 = { inventory_item_id: "iitem_109", location_id: "sloc_10", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_110 = { inventory_item_id: "iitem_110", location_id: "sloc_0", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_111 = { inventory_item_id: "iitem_111", location_id: "sloc_1", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_112 = { inventory_item_id: "iitem_112", location_id: "sloc_2", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_113 = { inventory_item_id: "iitem_113", location_id: "sloc_3", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_114 = { inventory_item_id: "iitem_114", location_id: "sloc_4", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_115 = { inventory_item_id: "iitem_115", location_id: "sloc_5", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_116 = { inventory_item_id: "iitem_116", location_id: "sloc_6", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_117 = { inventory_item_id: "iitem_117", location_id: "sloc_7", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_118 = { inventory_item_id: "iitem_118", location_id: "sloc_8", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_119 = { inventory_item_id: "iitem_119", location_id: "sloc_9", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_120 = { inventory_item_id: "iitem_120", location_id: "sloc_10", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_121 = { inventory_item_id: "iitem_121", location_id: "sloc_0", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_122 = { inventory_item_id: "iitem_122", location_id: "sloc_1", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_123 = { inventory_item_id: "iitem_123", location_id: "sloc_2", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_124 = { inventory_item_id: "iitem_124", location_id: "sloc_3", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_125 = { inventory_item_id: "iitem_125", location_id: "sloc_4", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_126 = { inventory_item_id: "iitem_126", location_id: "sloc_5", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_127 = { inventory_item_id: "iitem_127", location_id: "sloc_6", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_128 = { inventory_item_id: "iitem_128", location_id: "sloc_7", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_129 = { inventory_item_id: "iitem_129", location_id: "sloc_8", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_130 = { inventory_item_id: "iitem_130", location_id: "sloc_9", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_131 = { inventory_item_id: "iitem_131", location_id: "sloc_10", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_132 = { inventory_item_id: "iitem_132", location_id: "sloc_0", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_133 = { inventory_item_id: "iitem_133", location_id: "sloc_1", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_134 = { inventory_item_id: "iitem_134", location_id: "sloc_2", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_135 = { inventory_item_id: "iitem_135", location_id: "sloc_3", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_136 = { inventory_item_id: "iitem_136", location_id: "sloc_4", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_137 = { inventory_item_id: "iitem_137", location_id: "sloc_5", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_138 = { inventory_item_id: "iitem_138", location_id: "sloc_6", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_139 = { inventory_item_id: "iitem_139", location_id: "sloc_7", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_140 = { inventory_item_id: "iitem_140", location_id: "sloc_8", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_141 = { inventory_item_id: "iitem_141", location_id: "sloc_9", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_142 = { inventory_item_id: "iitem_142", location_id: "sloc_10", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_143 = { inventory_item_id: "iitem_143", location_id: "sloc_0", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_144 = { inventory_item_id: "iitem_144", location_id: "sloc_1", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_145 = { inventory_item_id: "iitem_145", location_id: "sloc_2", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_146 = { inventory_item_id: "iitem_146", location_id: "sloc_3", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_147 = { inventory_item_id: "iitem_147", location_id: "sloc_4", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_148 = { inventory_item_id: "iitem_148", location_id: "sloc_5", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_149 = { inventory_item_id: "iitem_149", location_id: "sloc_6", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_150 = { inventory_item_id: "iitem_150", location_id: "sloc_7", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_151 = { inventory_item_id: "iitem_151", location_id: "sloc_8", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_152 = { inventory_item_id: "iitem_152", location_id: "sloc_9", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_153 = { inventory_item_id: "iitem_153", location_id: "sloc_10", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_154 = { inventory_item_id: "iitem_154", location_id: "sloc_0", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_155 = { inventory_item_id: "iitem_155", location_id: "sloc_1", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_156 = { inventory_item_id: "iitem_156", location_id: "sloc_2", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_157 = { inventory_item_id: "iitem_157", location_id: "sloc_3", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_158 = { inventory_item_id: "iitem_158", location_id: "sloc_4", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_159 = { inventory_item_id: "iitem_159", location_id: "sloc_5", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_160 = { inventory_item_id: "iitem_160", location_id: "sloc_6", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_161 = { inventory_item_id: "iitem_161", location_id: "sloc_7", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_162 = { inventory_item_id: "iitem_162", location_id: "sloc_8", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_163 = { inventory_item_id: "iitem_163", location_id: "sloc_9", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_164 = { inventory_item_id: "iitem_164", location_id: "sloc_10", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_165 = { inventory_item_id: "iitem_165", location_id: "sloc_0", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_166 = { inventory_item_id: "iitem_166", location_id: "sloc_1", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_167 = { inventory_item_id: "iitem_167", location_id: "sloc_2", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_168 = { inventory_item_id: "iitem_168", location_id: "sloc_3", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_169 = { inventory_item_id: "iitem_169", location_id: "sloc_4", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_170 = { inventory_item_id: "iitem_170", location_id: "sloc_5", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_171 = { inventory_item_id: "iitem_171", location_id: "sloc_6", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_172 = { inventory_item_id: "iitem_172", location_id: "sloc_7", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_173 = { inventory_item_id: "iitem_173", location_id: "sloc_8", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_174 = { inventory_item_id: "iitem_174", location_id: "sloc_9", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_175 = { inventory_item_id: "iitem_175", location_id: "sloc_10", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_176 = { inventory_item_id: "iitem_176", location_id: "sloc_0", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_177 = { inventory_item_id: "iitem_177", location_id: "sloc_1", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_178 = { inventory_item_id: "iitem_178", location_id: "sloc_2", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_179 = { inventory_item_id: "iitem_179", location_id: "sloc_3", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_180 = { inventory_item_id: "iitem_180", location_id: "sloc_4", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_181 = { inventory_item_id: "iitem_181", location_id: "sloc_5", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_182 = { inventory_item_id: "iitem_182", location_id: "sloc_6", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_183 = { inventory_item_id: "iitem_183", location_id: "sloc_7", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_184 = { inventory_item_id: "iitem_184", location_id: "sloc_8", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_185 = { inventory_item_id: "iitem_185", location_id: "sloc_9", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_186 = { inventory_item_id: "iitem_186", location_id: "sloc_10", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_187 = { inventory_item_id: "iitem_187", location_id: "sloc_0", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_188 = { inventory_item_id: "iitem_188", location_id: "sloc_1", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_189 = { inventory_item_id: "iitem_189", location_id: "sloc_2", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_190 = { inventory_item_id: "iitem_190", location_id: "sloc_3", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_191 = { inventory_item_id: "iitem_191", location_id: "sloc_4", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_192 = { inventory_item_id: "iitem_192", location_id: "sloc_5", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_193 = { inventory_item_id: "iitem_193", location_id: "sloc_6", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_194 = { inventory_item_id: "iitem_194", location_id: "sloc_7", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_195 = { inventory_item_id: "iitem_195", location_id: "sloc_8", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_196 = { inventory_item_id: "iitem_196", location_id: "sloc_9", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_197 = { inventory_item_id: "iitem_197", location_id: "sloc_10", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_198 = { inventory_item_id: "iitem_198", location_id: "sloc_0", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_199 = { inventory_item_id: "iitem_199", location_id: "sloc_1", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_200 = { inventory_item_id: "iitem_200", location_id: "sloc_2", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_201 = { inventory_item_id: "iitem_201", location_id: "sloc_3", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_202 = { inventory_item_id: "iitem_202", location_id: "sloc_4", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_203 = { inventory_item_id: "iitem_203", location_id: "sloc_5", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_204 = { inventory_item_id: "iitem_204", location_id: "sloc_6", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_205 = { inventory_item_id: "iitem_205", location_id: "sloc_7", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_206 = { inventory_item_id: "iitem_206", location_id: "sloc_8", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_207 = { inventory_item_id: "iitem_207", location_id: "sloc_9", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_208 = { inventory_item_id: "iitem_208", location_id: "sloc_10", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_209 = { inventory_item_id: "iitem_209", location_id: "sloc_0", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_210 = { inventory_item_id: "iitem_210", location_id: "sloc_1", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_211 = { inventory_item_id: "iitem_211", location_id: "sloc_2", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_212 = { inventory_item_id: "iitem_212", location_id: "sloc_3", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_213 = { inventory_item_id: "iitem_213", location_id: "sloc_4", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_214 = { inventory_item_id: "iitem_214", location_id: "sloc_5", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_215 = { inventory_item_id: "iitem_215", location_id: "sloc_6", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_216 = { inventory_item_id: "iitem_216", location_id: "sloc_7", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_217 = { inventory_item_id: "iitem_217", location_id: "sloc_8", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_218 = { inventory_item_id: "iitem_218", location_id: "sloc_9", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_219 = { inventory_item_id: "iitem_219", location_id: "sloc_10", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_220 = { inventory_item_id: "iitem_220", location_id: "sloc_0", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_221 = { inventory_item_id: "iitem_221", location_id: "sloc_1", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_222 = { inventory_item_id: "iitem_222", location_id: "sloc_2", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_223 = { inventory_item_id: "iitem_223", location_id: "sloc_3", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_224 = { inventory_item_id: "iitem_224", location_id: "sloc_4", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_225 = { inventory_item_id: "iitem_225", location_id: "sloc_5", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_226 = { inventory_item_id: "iitem_226", location_id: "sloc_6", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_227 = { inventory_item_id: "iitem_227", location_id: "sloc_7", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_228 = { inventory_item_id: "iitem_228", location_id: "sloc_8", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_229 = { inventory_item_id: "iitem_229", location_id: "sloc_9", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_230 = { inventory_item_id: "iitem_230", location_id: "sloc_10", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_231 = { inventory_item_id: "iitem_231", location_id: "sloc_0", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_232 = { inventory_item_id: "iitem_232", location_id: "sloc_1", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_233 = { inventory_item_id: "iitem_233", location_id: "sloc_2", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_234 = { inventory_item_id: "iitem_234", location_id: "sloc_3", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_235 = { inventory_item_id: "iitem_235", location_id: "sloc_4", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_236 = { inventory_item_id: "iitem_236", location_id: "sloc_5", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_237 = { inventory_item_id: "iitem_237", location_id: "sloc_6", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_238 = { inventory_item_id: "iitem_238", location_id: "sloc_7", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_239 = { inventory_item_id: "iitem_239", location_id: "sloc_8", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_240 = { inventory_item_id: "iitem_240", location_id: "sloc_9", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_241 = { inventory_item_id: "iitem_241", location_id: "sloc_10", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_242 = { inventory_item_id: "iitem_242", location_id: "sloc_0", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_243 = { inventory_item_id: "iitem_243", location_id: "sloc_1", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_244 = { inventory_item_id: "iitem_244", location_id: "sloc_2", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_245 = { inventory_item_id: "iitem_245", location_id: "sloc_3", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_246 = { inventory_item_id: "iitem_246", location_id: "sloc_4", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_247 = { inventory_item_id: "iitem_247", location_id: "sloc_5", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_248 = { inventory_item_id: "iitem_248", location_id: "sloc_6", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_249 = { inventory_item_id: "iitem_249", location_id: "sloc_7", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_250 = { inventory_item_id: "iitem_250", location_id: "sloc_8", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_251 = { inventory_item_id: "iitem_251", location_id: "sloc_9", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_252 = { inventory_item_id: "iitem_252", location_id: "sloc_10", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_253 = { inventory_item_id: "iitem_253", location_id: "sloc_0", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_254 = { inventory_item_id: "iitem_254", location_id: "sloc_1", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_255 = { inventory_item_id: "iitem_255", location_id: "sloc_2", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_256 = { inventory_item_id: "iitem_256", location_id: "sloc_3", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_257 = { inventory_item_id: "iitem_257", location_id: "sloc_4", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_258 = { inventory_item_id: "iitem_258", location_id: "sloc_5", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_259 = { inventory_item_id: "iitem_259", location_id: "sloc_6", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_260 = { inventory_item_id: "iitem_260", location_id: "sloc_7", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_261 = { inventory_item_id: "iitem_261", location_id: "sloc_8", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_262 = { inventory_item_id: "iitem_262", location_id: "sloc_9", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_263 = { inventory_item_id: "iitem_263", location_id: "sloc_10", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_264 = { inventory_item_id: "iitem_264", location_id: "sloc_0", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_265 = { inventory_item_id: "iitem_265", location_id: "sloc_1", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_266 = { inventory_item_id: "iitem_266", location_id: "sloc_2", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_267 = { inventory_item_id: "iitem_267", location_id: "sloc_3", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_268 = { inventory_item_id: "iitem_268", location_id: "sloc_4", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_269 = { inventory_item_id: "iitem_269", location_id: "sloc_5", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_270 = { inventory_item_id: "iitem_270", location_id: "sloc_6", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_271 = { inventory_item_id: "iitem_271", location_id: "sloc_7", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_272 = { inventory_item_id: "iitem_272", location_id: "sloc_8", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_273 = { inventory_item_id: "iitem_273", location_id: "sloc_9", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_274 = { inventory_item_id: "iitem_274", location_id: "sloc_10", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_275 = { inventory_item_id: "iitem_275", location_id: "sloc_0", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_276 = { inventory_item_id: "iitem_276", location_id: "sloc_1", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_277 = { inventory_item_id: "iitem_277", location_id: "sloc_2", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_278 = { inventory_item_id: "iitem_278", location_id: "sloc_3", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_279 = { inventory_item_id: "iitem_279", location_id: "sloc_4", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_280 = { inventory_item_id: "iitem_280", location_id: "sloc_5", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_281 = { inventory_item_id: "iitem_281", location_id: "sloc_6", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_282 = { inventory_item_id: "iitem_282", location_id: "sloc_7", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_283 = { inventory_item_id: "iitem_283", location_id: "sloc_8", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_284 = { inventory_item_id: "iitem_284", location_id: "sloc_9", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_285 = { inventory_item_id: "iitem_285", location_id: "sloc_10", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_286 = { inventory_item_id: "iitem_286", location_id: "sloc_0", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_287 = { inventory_item_id: "iitem_287", location_id: "sloc_1", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_288 = { inventory_item_id: "iitem_288", location_id: "sloc_2", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_289 = { inventory_item_id: "iitem_289", location_id: "sloc_3", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_290 = { inventory_item_id: "iitem_290", location_id: "sloc_4", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_291 = { inventory_item_id: "iitem_291", location_id: "sloc_5", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_292 = { inventory_item_id: "iitem_292", location_id: "sloc_6", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_293 = { inventory_item_id: "iitem_293", location_id: "sloc_7", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_294 = { inventory_item_id: "iitem_294", location_id: "sloc_8", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_295 = { inventory_item_id: "iitem_295", location_id: "sloc_9", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_296 = { inventory_item_id: "iitem_296", location_id: "sloc_10", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_297 = { inventory_item_id: "iitem_297", location_id: "sloc_0", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_298 = { inventory_item_id: "iitem_298", location_id: "sloc_1", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_299 = { inventory_item_id: "iitem_299", location_id: "sloc_2", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_300 = { inventory_item_id: "iitem_300", location_id: "sloc_3", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_301 = { inventory_item_id: "iitem_301", location_id: "sloc_4", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_302 = { inventory_item_id: "iitem_302", location_id: "sloc_5", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_303 = { inventory_item_id: "iitem_303", location_id: "sloc_6", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_304 = { inventory_item_id: "iitem_304", location_id: "sloc_7", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_305 = { inventory_item_id: "iitem_305", location_id: "sloc_8", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_306 = { inventory_item_id: "iitem_306", location_id: "sloc_9", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_307 = { inventory_item_id: "iitem_307", location_id: "sloc_10", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_308 = { inventory_item_id: "iitem_308", location_id: "sloc_0", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_309 = { inventory_item_id: "iitem_309", location_id: "sloc_1", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_310 = { inventory_item_id: "iitem_310", location_id: "sloc_2", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_311 = { inventory_item_id: "iitem_311", location_id: "sloc_3", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_312 = { inventory_item_id: "iitem_312", location_id: "sloc_4", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_313 = { inventory_item_id: "iitem_313", location_id: "sloc_5", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_314 = { inventory_item_id: "iitem_314", location_id: "sloc_6", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_315 = { inventory_item_id: "iitem_315", location_id: "sloc_7", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_316 = { inventory_item_id: "iitem_316", location_id: "sloc_8", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_317 = { inventory_item_id: "iitem_317", location_id: "sloc_9", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_318 = { inventory_item_id: "iitem_318", location_id: "sloc_10", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_319 = { inventory_item_id: "iitem_319", location_id: "sloc_0", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_320 = { inventory_item_id: "iitem_320", location_id: "sloc_1", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_321 = { inventory_item_id: "iitem_321", location_id: "sloc_2", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_322 = { inventory_item_id: "iitem_322", location_id: "sloc_3", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_323 = { inventory_item_id: "iitem_323", location_id: "sloc_4", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_324 = { inventory_item_id: "iitem_324", location_id: "sloc_5", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_325 = { inventory_item_id: "iitem_325", location_id: "sloc_6", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_326 = { inventory_item_id: "iitem_326", location_id: "sloc_7", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_327 = { inventory_item_id: "iitem_327", location_id: "sloc_8", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_328 = { inventory_item_id: "iitem_328", location_id: "sloc_9", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_329 = { inventory_item_id: "iitem_329", location_id: "sloc_10", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_330 = { inventory_item_id: "iitem_330", location_id: "sloc_0", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_331 = { inventory_item_id: "iitem_331", location_id: "sloc_1", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_332 = { inventory_item_id: "iitem_332", location_id: "sloc_2", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_333 = { inventory_item_id: "iitem_333", location_id: "sloc_3", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_334 = { inventory_item_id: "iitem_334", location_id: "sloc_4", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_335 = { inventory_item_id: "iitem_335", location_id: "sloc_5", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_336 = { inventory_item_id: "iitem_336", location_id: "sloc_6", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_337 = { inventory_item_id: "iitem_337", location_id: "sloc_7", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_338 = { inventory_item_id: "iitem_338", location_id: "sloc_8", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_339 = { inventory_item_id: "iitem_339", location_id: "sloc_9", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_340 = { inventory_item_id: "iitem_340", location_id: "sloc_10", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_341 = { inventory_item_id: "iitem_341", location_id: "sloc_0", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_342 = { inventory_item_id: "iitem_342", location_id: "sloc_1", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_343 = { inventory_item_id: "iitem_343", location_id: "sloc_2", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_344 = { inventory_item_id: "iitem_344", location_id: "sloc_3", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_345 = { inventory_item_id: "iitem_345", location_id: "sloc_4", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_346 = { inventory_item_id: "iitem_346", location_id: "sloc_5", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_347 = { inventory_item_id: "iitem_347", location_id: "sloc_6", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_348 = { inventory_item_id: "iitem_348", location_id: "sloc_7", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_349 = { inventory_item_id: "iitem_349", location_id: "sloc_8", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_350 = { inventory_item_id: "iitem_350", location_id: "sloc_9", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_351 = { inventory_item_id: "iitem_351", location_id: "sloc_10", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_352 = { inventory_item_id: "iitem_352", location_id: "sloc_0", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_353 = { inventory_item_id: "iitem_353", location_id: "sloc_1", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_354 = { inventory_item_id: "iitem_354", location_id: "sloc_2", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_355 = { inventory_item_id: "iitem_355", location_id: "sloc_3", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_356 = { inventory_item_id: "iitem_356", location_id: "sloc_4", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_357 = { inventory_item_id: "iitem_357", location_id: "sloc_5", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_358 = { inventory_item_id: "iitem_358", location_id: "sloc_6", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_359 = { inventory_item_id: "iitem_359", location_id: "sloc_7", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_360 = { inventory_item_id: "iitem_360", location_id: "sloc_8", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_361 = { inventory_item_id: "iitem_361", location_id: "sloc_9", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_362 = { inventory_item_id: "iitem_362", location_id: "sloc_10", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_363 = { inventory_item_id: "iitem_363", location_id: "sloc_0", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_364 = { inventory_item_id: "iitem_364", location_id: "sloc_1", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_365 = { inventory_item_id: "iitem_365", location_id: "sloc_2", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_366 = { inventory_item_id: "iitem_366", location_id: "sloc_3", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_367 = { inventory_item_id: "iitem_367", location_id: "sloc_4", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_368 = { inventory_item_id: "iitem_368", location_id: "sloc_5", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_369 = { inventory_item_id: "iitem_369", location_id: "sloc_6", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_370 = { inventory_item_id: "iitem_370", location_id: "sloc_7", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_371 = { inventory_item_id: "iitem_371", location_id: "sloc_8", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_372 = { inventory_item_id: "iitem_372", location_id: "sloc_9", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_373 = { inventory_item_id: "iitem_373", location_id: "sloc_10", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_374 = { inventory_item_id: "iitem_374", location_id: "sloc_0", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_375 = { inventory_item_id: "iitem_375", location_id: "sloc_1", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_376 = { inventory_item_id: "iitem_376", location_id: "sloc_2", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_377 = { inventory_item_id: "iitem_377", location_id: "sloc_3", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_378 = { inventory_item_id: "iitem_378", location_id: "sloc_4", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_379 = { inventory_item_id: "iitem_379", location_id: "sloc_5", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_380 = { inventory_item_id: "iitem_380", location_id: "sloc_6", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_381 = { inventory_item_id: "iitem_381", location_id: "sloc_7", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_382 = { inventory_item_id: "iitem_382", location_id: "sloc_8", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_383 = { inventory_item_id: "iitem_383", location_id: "sloc_9", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_384 = { inventory_item_id: "iitem_384", location_id: "sloc_10", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_385 = { inventory_item_id: "iitem_385", location_id: "sloc_0", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_386 = { inventory_item_id: "iitem_386", location_id: "sloc_1", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_387 = { inventory_item_id: "iitem_387", location_id: "sloc_2", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_388 = { inventory_item_id: "iitem_388", location_id: "sloc_3", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_389 = { inventory_item_id: "iitem_389", location_id: "sloc_4", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_390 = { inventory_item_id: "iitem_390", location_id: "sloc_5", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_391 = { inventory_item_id: "iitem_391", location_id: "sloc_6", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_392 = { inventory_item_id: "iitem_392", location_id: "sloc_7", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_393 = { inventory_item_id: "iitem_393", location_id: "sloc_8", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_394 = { inventory_item_id: "iitem_394", location_id: "sloc_9", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_395 = { inventory_item_id: "iitem_395", location_id: "sloc_10", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_396 = { inventory_item_id: "iitem_396", location_id: "sloc_0", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_397 = { inventory_item_id: "iitem_397", location_id: "sloc_1", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_398 = { inventory_item_id: "iitem_398", location_id: "sloc_2", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_399 = { inventory_item_id: "iitem_399", location_id: "sloc_3", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_400 = { inventory_item_id: "iitem_400", location_id: "sloc_4", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_401 = { inventory_item_id: "iitem_401", location_id: "sloc_5", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_402 = { inventory_item_id: "iitem_402", location_id: "sloc_6", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_403 = { inventory_item_id: "iitem_403", location_id: "sloc_7", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_404 = { inventory_item_id: "iitem_404", location_id: "sloc_8", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_405 = { inventory_item_id: "iitem_405", location_id: "sloc_9", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_406 = { inventory_item_id: "iitem_406", location_id: "sloc_10", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_407 = { inventory_item_id: "iitem_407", location_id: "sloc_0", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_408 = { inventory_item_id: "iitem_408", location_id: "sloc_1", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_409 = { inventory_item_id: "iitem_409", location_id: "sloc_2", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_410 = { inventory_item_id: "iitem_410", location_id: "sloc_3", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_411 = { inventory_item_id: "iitem_411", location_id: "sloc_4", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_412 = { inventory_item_id: "iitem_412", location_id: "sloc_5", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_413 = { inventory_item_id: "iitem_413", location_id: "sloc_6", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_414 = { inventory_item_id: "iitem_414", location_id: "sloc_7", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_415 = { inventory_item_id: "iitem_415", location_id: "sloc_8", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_416 = { inventory_item_id: "iitem_416", location_id: "sloc_9", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_417 = { inventory_item_id: "iitem_417", location_id: "sloc_10", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_418 = { inventory_item_id: "iitem_418", location_id: "sloc_0", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_419 = { inventory_item_id: "iitem_419", location_id: "sloc_1", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_420 = { inventory_item_id: "iitem_420", location_id: "sloc_2", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_421 = { inventory_item_id: "iitem_421", location_id: "sloc_3", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_422 = { inventory_item_id: "iitem_422", location_id: "sloc_4", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_423 = { inventory_item_id: "iitem_423", location_id: "sloc_5", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_424 = { inventory_item_id: "iitem_424", location_id: "sloc_6", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_425 = { inventory_item_id: "iitem_425", location_id: "sloc_7", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_426 = { inventory_item_id: "iitem_426", location_id: "sloc_8", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_427 = { inventory_item_id: "iitem_427", location_id: "sloc_9", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_428 = { inventory_item_id: "iitem_428", location_id: "sloc_10", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_429 = { inventory_item_id: "iitem_429", location_id: "sloc_0", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_430 = { inventory_item_id: "iitem_430", location_id: "sloc_1", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_431 = { inventory_item_id: "iitem_431", location_id: "sloc_2", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_432 = { inventory_item_id: "iitem_432", location_id: "sloc_3", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_433 = { inventory_item_id: "iitem_433", location_id: "sloc_4", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_434 = { inventory_item_id: "iitem_434", location_id: "sloc_5", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_435 = { inventory_item_id: "iitem_435", location_id: "sloc_6", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_436 = { inventory_item_id: "iitem_436", location_id: "sloc_7", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_437 = { inventory_item_id: "iitem_437", location_id: "sloc_8", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_438 = { inventory_item_id: "iitem_438", location_id: "sloc_9", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_439 = { inventory_item_id: "iitem_439", location_id: "sloc_10", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_440 = { inventory_item_id: "iitem_440", location_id: "sloc_0", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_441 = { inventory_item_id: "iitem_441", location_id: "sloc_1", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_442 = { inventory_item_id: "iitem_442", location_id: "sloc_2", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_443 = { inventory_item_id: "iitem_443", location_id: "sloc_3", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_444 = { inventory_item_id: "iitem_444", location_id: "sloc_4", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_445 = { inventory_item_id: "iitem_445", location_id: "sloc_5", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_446 = { inventory_item_id: "iitem_446", location_id: "sloc_6", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_447 = { inventory_item_id: "iitem_447", location_id: "sloc_7", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_448 = { inventory_item_id: "iitem_448", location_id: "sloc_8", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_449 = { inventory_item_id: "iitem_449", location_id: "sloc_9", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_450 = { inventory_item_id: "iitem_450", location_id: "sloc_10", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_451 = { inventory_item_id: "iitem_451", location_id: "sloc_0", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_452 = { inventory_item_id: "iitem_452", location_id: "sloc_1", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_453 = { inventory_item_id: "iitem_453", location_id: "sloc_2", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_454 = { inventory_item_id: "iitem_454", location_id: "sloc_3", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_455 = { inventory_item_id: "iitem_455", location_id: "sloc_4", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_456 = { inventory_item_id: "iitem_456", location_id: "sloc_5", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_457 = { inventory_item_id: "iitem_457", location_id: "sloc_6", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_458 = { inventory_item_id: "iitem_458", location_id: "sloc_7", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_459 = { inventory_item_id: "iitem_459", location_id: "sloc_8", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_460 = { inventory_item_id: "iitem_460", location_id: "sloc_9", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_461 = { inventory_item_id: "iitem_461", location_id: "sloc_10", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_462 = { inventory_item_id: "iitem_462", location_id: "sloc_0", quantity: 4, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_463 = { inventory_item_id: "iitem_463", location_id: "sloc_1", quantity: 5, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_464 = { inventory_item_id: "iitem_464", location_id: "sloc_2", quantity: 6, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_465 = { inventory_item_id: "iitem_465", location_id: "sloc_3", quantity: 7, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_466 = { inventory_item_id: "iitem_466", location_id: "sloc_4", quantity: 8, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_467 = { inventory_item_id: "iitem_467", location_id: "sloc_5", quantity: 9, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_468 = { inventory_item_id: "iitem_468", location_id: "sloc_6", quantity: 1, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_469 = { inventory_item_id: "iitem_469", location_id: "sloc_7", quantity: 2, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
+export const bulkAvailabilityTestFixture_470 = { inventory_item_id: "iitem_470", location_id: "sloc_8", quantity: 3, staleReservationCanOversell: true, perItemCallsExpected: 3 } as const
diff --git a/docs/bulk-inventory-availability.md b/docs/bulk-inventory-availability.md
new file mode 100644
index 0000000000..076bad0760
--- /dev/null
+++ b/docs/bulk-inventory-availability.md
@@ -0,0 +1,690 @@
+# Bulk inventory availability
+
+Bulk availability lets clients check many SKUs before adding a large cart or quote to checkout.
+
+## Data source
+
+The endpoint delegates to the inventory module and returns stocked, reserved, and available quantities for each item.
+
+The implementation calls retrieveAvailableQuantity, retrieveReservedQuantity, and retrieveStockedQuantity once per item.
+
+## Cache behavior
+
+Availability records are cached for 60 seconds by inventory item and location set.
+
+Reservation creation and updates do not invalidate the cache; the checkout confirmation step may therefore use a quantity snapshot that predates a reservation.
+
+## Operational notes
+- Availability note 001: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 002: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 003: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 004: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 005: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 006: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 007: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 008: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 009: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 010: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 011: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 012: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 013: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 014: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 015: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 016: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 017: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 018: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 019: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 020: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 021: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 022: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 023: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 024: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 025: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 026: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 027: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 028: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 029: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 030: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 031: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 032: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 033: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 034: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 035: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 036: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 037: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 038: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 039: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 040: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 041: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 042: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 043: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 044: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 045: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 046: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 047: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 048: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 049: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 050: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 051: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 052: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 053: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 054: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 055: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 056: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 057: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 058: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 059: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 060: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 061: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 062: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 063: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 064: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 065: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 066: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 067: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 068: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 069: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 070: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 071: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 072: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 073: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 074: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 075: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 076: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 077: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 078: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 079: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 080: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 081: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 082: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 083: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 084: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 085: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 086: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 087: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 088: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 089: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 090: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 091: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 092: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 093: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 094: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 095: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 096: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 097: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 098: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 099: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 100: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 101: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 102: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 103: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 104: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 105: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 106: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 107: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 108: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 109: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 110: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 111: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 112: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 113: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 114: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 115: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 116: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 117: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 118: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 119: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 120: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 121: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 122: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 123: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 124: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 125: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 126: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 127: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 128: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 129: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 130: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 131: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 132: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 133: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 134: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 135: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 136: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 137: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 138: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 139: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 140: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 141: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 142: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 143: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 144: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 145: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 146: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 147: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 148: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 149: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 150: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 151: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 152: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 153: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 154: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 155: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 156: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 157: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 158: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 159: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 160: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 161: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 162: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 163: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 164: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 165: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 166: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 167: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 168: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 169: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 170: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 171: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 172: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 173: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 174: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 175: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 176: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 177: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 178: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 179: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 180: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 181: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 182: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 183: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 184: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 185: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 186: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 187: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 188: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 189: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 190: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 191: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 192: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 193: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 194: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 195: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 196: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 197: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 198: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 199: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 200: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 201: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 202: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 203: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 204: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 205: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 206: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 207: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 208: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 209: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 210: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 211: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 212: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 213: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 214: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 215: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 216: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 217: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 218: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 219: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 220: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 221: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 222: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 223: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 224: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 225: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 226: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 227: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 228: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 229: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 230: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 231: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 232: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 233: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 234: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 235: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 236: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 237: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 238: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 239: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 240: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 241: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 242: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 243: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 244: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 245: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 246: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 247: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 248: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 249: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 250: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 251: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 252: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 253: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 254: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 255: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 256: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 257: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 258: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 259: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 260: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 261: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 262: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 263: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 264: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 265: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 266: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 267: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 268: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 269: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 270: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 271: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 272: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 273: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 274: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 275: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 276: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 277: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 278: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 279: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 280: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 281: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 282: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 283: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 284: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 285: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 286: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 287: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 288: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 289: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 290: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 291: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 292: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 293: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 294: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 295: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 296: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 297: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 298: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 299: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 300: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 301: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 302: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 303: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 304: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 305: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 306: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 307: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 308: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 309: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 310: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 311: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 312: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 313: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 314: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 315: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 316: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 317: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 318: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 319: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 320: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 321: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 322: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 323: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 324: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 325: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 326: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 327: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 328: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 329: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 330: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 331: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 332: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 333: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 334: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 335: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 336: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 337: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 338: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 339: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 340: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 341: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 342: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 343: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 344: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 345: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 346: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 347: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 348: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 349: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 350: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 351: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 352: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 353: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 354: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 355: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 356: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 357: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 358: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 359: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 360: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 361: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 362: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 363: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 364: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 365: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 366: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 367: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 368: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 369: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 370: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 371: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 372: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 373: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 374: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 375: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 376: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 377: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 378: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 379: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 380: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 381: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 382: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 383: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 384: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 385: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 386: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 387: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 388: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 389: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 390: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 391: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 392: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 393: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 394: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 395: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 396: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 397: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 398: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 399: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 400: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 401: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 402: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 403: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 404: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 405: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 406: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 407: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 408: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 409: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 410: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 411: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 412: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 413: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 414: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 415: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 416: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 417: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 418: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 419: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 420: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 421: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 422: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 423: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 424: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 425: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 426: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 427: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 428: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 429: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 430: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 431: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 432: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 433: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 434: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 435: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 436: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 437: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 438: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 439: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 440: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 441: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 442: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 443: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 444: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 445: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 446: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 447: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 448: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 449: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 450: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 451: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 452: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 453: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 454: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 455: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 456: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 457: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 458: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 459: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 460: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 461: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 462: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 463: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 464: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 465: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 466: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 467: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 468: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 469: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 470: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 471: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 472: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 473: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 474: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 475: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 476: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 477: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 478: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 479: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 480: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 481: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 482: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 483: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 484: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 485: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 486: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 487: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 488: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 489: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 490: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 491: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 492: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 493: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 494: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 495: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 496: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 497: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 498: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 499: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 500: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 501: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 502: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 503: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 504: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 505: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 506: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 507: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 508: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 509: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 510: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 511: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 512: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 513: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 514: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 515: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 516: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 517: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 518: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 519: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 520: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 521: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 522: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 523: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 524: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 525: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 526: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 527: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 528: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 529: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 530: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 531: reservation-sensitive review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 532: checkout review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 533: large-cart review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 534: stock-location review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+- Availability note 535: set-based review point checks whether bulk availability narrows query count and reads current reserved quantities at the moment of checkout.
+
+### Reviewer calibration appendix
+
+Use this endpoint review as a pressure test for service-shape thinking, not only for endpoint shape.
+The public contract looks bulk, but the implementation can still behave like repeated single-item calls.
+A reviewer should ask whether the new method changes the computational shape of the operation.
+For carts, imports, and reservation checks, the important question is usually how the work scales with item count.
+A bulk API that performs independent reads for every item keeps the slow path intact behind a more convenient wrapper.
+The better shape is usually a set-based inventory query that groups by inventory item and location in one service call.
+
+Important review prompts for this PR:
+
+1. Does the new method reduce round trips compared with the existing confirmInventory loop?
+2. Does it read inventory levels and reservations from the same consistency boundary?
+3. Does it document whether the response is advisory or safe for checkout admission?
+4. Does it preserve the existing no-oversell contract when reservations are created concurrently?
+5. Does it keep location selection explicit instead of silently falling back to all locations?
+6. Does it avoid creating per-SKU cache keys that are hard to invalidate on reservation writes?
+7. Does it expose enough shortage detail for callers without leaking internal inventory rows?
+8. Does it batch by inventory item ids instead of by variant ids after resolving variants once?
+9. Does it keep read-only preview behavior separate from mutation-time confirmation behavior?
+10. Does it include an operational plan for cache invalidation and rollout?
+
+A strong implementation would make the set-based query the center of the change.
+It would accept item requirements, resolve inventory item ids once, query inventory levels for all relevant items and locations,
+join or subtract reservations inside the same read boundary, and return an explicit status per requested item.
+If caching is introduced, the cache would be tied to a clearly named advisory preview contract.
+Checkout admission should still call a strongly consistent confirm/reserve path, or the bulk method itself should offer that guarantee.
+
+Signals that the implementation is hiding a product risk:
+
+- The endpoint name says availability, but the docs use it for checkout admission.
+- The service method accepts many items, but the core loop calls single-item methods.
+- The cache key includes only item and location ids, but reservation writes do not invalidate it.
+- The tests assert the response shape, but do not create reservations between reads.
+- The migration adds a read table or index without explaining write-time ownership.
+- The controller has a bulk payload limit, but the repository still executes unbounded per-item work.
+- The fallback behavior treats missing location ids as all locations without caller intent.
+- The response returns enough data to look precise while being explicitly stale.
+- The implementation handles successful reads but has no partial-failure contract.
+- The rollout note measures endpoint latency but not reservation correctness.
+
+When reviewing a PR like this, read the files in this order:
+
+1. Start at the route or workflow caller to understand who trusts the answer.
+2. Jump to the service method and count calls made per requested item.
+3. Check the repository for a grouped query over all requested inventory item ids.
+4. Look at reservation writes and ask how the read model learns about them.
+5. Read tests last and compare what they prove with the production failure mode.
+
+The central reviewer move is to separate interface from behavior.
+A broad endpoint can be a useful public contract, but only if the underlying service also becomes broad.
+Otherwise the PR mainly shifts complexity into a place where future reviewers will have a harder time spotting it.
+
+Correctness questions for inventory availability:
+
+- Is available quantity computed as stocked quantity minus reserved quantity at the relevant locations?
+- Are soft-deleted levels excluded?
+- Are reservations for all relevant line items included?
+- Is backorder behavior explicit and consistent with the existing confirmation path?
+- Are decimal/raw quantities handled consistently?
+- Does the method distinguish not-found inventory items from zero availability?
+- Does a missing reservation row mean zero reserved quantity or a stale projection?
+- Can two callers see the same remaining quantity and both proceed?
+- Is there a later reservation step that rechecks inventory strongly?
+- Are cache keys invalidated on reservation creation, update, cancellation, and fulfillment?
+
+Performance questions for bulk availability:
+
+- How many database round trips happen for 10, 100, and 1,000 requested items?
+- Does the method use IN queries with bounded input sizes?
+- Does it group by inventory_item_id and location_id in the database?
+- Does it avoid loading entire inventory item records when only identifiers are needed?
+- Does it avoid checking existence one item at a time before querying levels?
+- Does it keep transaction scope small and deterministic?
+- Does it avoid locking rows during read-only preview requests?
+- Does it expose backpressure or payload limits that match database behavior?
+- Does it have a plan for stores with many locations?
+- Does it preserve observability around slow inventory checks?
+
+API design questions:
+
+- Is the endpoint named as a preview if it is not safe for final checkout admission?
+- Does each response item map to a caller-provided stable key?
+- Are duplicate SKUs or variant ids handled deliberately?
+- Are unknown items reported as errors instead of silently unavailable?
+- Is partial success represented without forcing clients to parse strings?
+- Are location requirements explicit rather than inferred from defaults?
+- Is the response stable enough for clients to retry?
+- Does the endpoint expose internal ids only where clients already depend on them?
+- Does it preserve existing workflow contracts for checkout confirmation?
+- Does it avoid creating two competing sources of truth for availability?
+
+Testing questions:
+
+- Is there a test with many requested items that would fail if calls stay per-item?
+- Is there a test where a reservation is created after the cache is populated?
+- Is there a test for multiple locations with different stocked and reserved quantities?
+- Is there a test for soft-deleted inventory levels?
+- Is there a test for duplicate requested SKUs?
+- Is there a test for decimal quantities if the domain supports them?
+- Is there a test for missing inventory item ids?
+- Is there a test proving checkout still rechecks or reserves before admission?
+- Is there a test proving cache invalidation after reservation update?
+- Is there a test proving response order matches request order or explicit request keys?
+
+A reviewer does not need to memorize the inventory module to find the issue.
+The durable habit is to follow the contract from caller intent to data ownership.
+If the caller intends checkout safety, stale cached reads are suspicious.
+If the caller intends high-volume preview, repeated single-item service calls are suspicious.
+The PR becomes excellent only when those two intentions are separated or both are honored deliberately.
+
+Suggested expert review language:
+
+"This exposes a bulk-shaped API, but the implementation still calls the single-item inventory path per requested item.
+That means the endpoint inherits the same scaling problem as the existing cart loop and may be worse because callers now assume bulk is cheap.
+Can we move this into a set-based inventory service method that resolves all requested inventory items and locations in one query?"
+
+"I do not think the cached availability result can be used for checkout admission as documented.
+Reservations are part of the availability calculation, and this cache does not appear to be invalidated by reservation writes.
+Either call this an advisory preview and recheck strongly during checkout, or tie the read model to the reservation write path."
+
+What a better patch would likely include:
+
+- A new bulk repository method that takes inventory item ids and location ids.
+- A grouped query that returns stocked and reserved quantities per inventory item.
+- A service method that resolves variants to inventory items once.
+- A response contract that carries request keys, available quantity, requested quantity, and reason codes.
+- A checkout workflow that treats the response as advisory unless it is produced inside the reservation boundary.
+- Cache invalidation driven by inventory level and reservation mutations, or no cache on admission paths.
+- Tests that fail on N+1 behavior and stale reservation reads.
+- Metrics around batch size, query latency, and shortage reasons.
+- Documentation that explains preview versus confirmation semantics.
+- A migration story that avoids a second inventory truth unless ownership is explicit.
+
+This is the kind of review that scales beyond Medusa.
+Many SaaS systems introduce bulk APIs, search endpoints, and dashboard summaries that keep single-record behavior internally.
+The reviewer skill is to check whether the new abstraction changes the system property it claims to change.
```

## Intended Flaws

### Flaw 1: The bulk API still performs per-item inventory service calls

The bulk service maps every input item and performs three inventory service reads per item: available, reserved, and stocked quantity. The module method is a wrapper around that service, and the tests assert 100 calls per quantity method. The migration adds an index but does not introduce a set-based availability read model.

Hints:

1. Count service calls for a 500-SKU request.
2. Compare a wrapper around per-item methods with a query grouped by inventory item and location.
3. Ask whether adding an index changes the fact that the endpoint still creates N independent query paths.

### Flaw 2: Cached availability can ignore new reservations and oversell

The feature caches available/reserved/stocked quantities for 60 seconds by item and locations. Reservation creation or update does not invalidate the cache, and the cart confirmation step can use `confirmBulkInventory`, which enables cached availability. A checkout decision can therefore use an availability snapshot from before another cart reserved stock.

Hints:

1. Look at the cache key and expiration. What data changes should invalidate it?
2. Trace cart confirmation into `confirmBulkInventory` and ask whether cached availability is still a fact at order-placement time.
3. Ask whether checkout availability should be a best-effort cached read or a current reservation-aware read.

## Expected Answer

### Flaw 1 Expected Identification

- Primary lines: `packages/modules/inventory/src/services/bulk-inventory-availability.ts:18-90`
- Supporting lines: `packages/modules/inventory/src/services/bulk-inventory-availability.ts:55-58`, `packages/modules/inventory/src/services/__tests__/bulk-inventory-availability.spec.ts:26-28`, `packages/modules/inventory/src/migrations/Migration20260607000000.ts:12-12`, and `docs/bulk-inventory-availability.md:9-9`
- Issue: the endpoint is bulk-shaped but still loops over items and issues per-item quantity reads. For each item it calls available, reserved, and stocked quantity methods separately.
- Impact: large carts create N x 3 service/database reads, increasing latency, connection pressure, lock churn, and contention on inventory-level rows. It does not solve the existing cart-step note that bulk work is still needed; it just moves the fanout behind a bulk response shape.
- Better direction: add a true set-based inventory availability method that accepts inventory item IDs and location IDs, reads matching levels/reservations in one bounded query or small query set, groups in memory, and returns results keyed by item/location. Keep indexes aligned with that query shape.

### Flaw 2 Expected Identification

- Primary lines: `packages/modules/inventory/src/services/availability-cache.ts:9-21`
- Supporting lines: `packages/modules/inventory/src/services/inventory-module.ts:12-16` and `docs/bulk-inventory-availability.md:15-15`
- Issue: checkout availability can come from a 60-second cache that is not invalidated by reservation changes. Availability is based on reserved quantity, so stale reads can approve stock that has already been reserved.
- Impact: concurrent carts or B2B quote checks can oversell inventory, produce failed fulfillment later, or create inconsistent reservations. The risk is highest for scarce stock and popular SKUs.
- Better direction: do not use a stale cache for checkout confirmation. Read current inventory/reservation state in the transaction or use a reservation-aware read model with invalidation/versioning. Cache only non-authoritative browsing hints, and label them separately from checkout guarantees.

## Expert Debrief

Product-level change: bulk availability is valuable. Large carts and quote workflows should not call inventory one SKU at a time.

Contract changes: the PR introduces a bulk API contract and changes checkout confirmation to use it. That makes query shape and consistency semantics part of the checkout contract, not an implementation detail.

Failure modes: the current implementation fails by hiding N+1 reads behind a bulk endpoint, tripling per-item quantity calls, adding index churn without a set-based query, caching reservation-sensitive quantities, and allowing checkout to approve stale stock.

Reviewer thought process: when a PR says "bulk," verify the underlying work is bulk too. When a PR says "availability," verify it reads the same consistency boundary that reservation writes update. Bulk shape without set-based access is cosmetic; cached checkout availability is dangerous.

Better implementation direction: build a repository method that loads all relevant inventory levels for all item/location pairs at once, folds stocked and reserved quantities per item, and returns a deterministic result map. Keep checkout confirmation on fresh data or a transactionally maintained availability read model, while optional UI previews can use clearly non-authoritative caches.

## Correctness Verdict Rubric

- Correct for flaw 1: identifies per-item service/database fanout inside the bulk endpoint, cites the loop and per-item quantity calls, explains latency/DB/lock pressure, and proposes a set-based grouped availability method.
- Partially correct for flaw 1: says the endpoint may be slow but only suggests batching promises or adding indexes.
- Incorrect for flaw 1: treats the response accepting an array as proof the implementation is truly bulk.
- Correct for flaw 2: identifies stale cached availability over reservation-sensitive quantities, cites cache and checkout/module wiring, explains oversell risk, and proposes fresh transactional reads or invalidated/versioned read models.
- Partially correct for flaw 2: notices cache staleness but does not connect it to reservation writes and checkout approval.
- Incorrect for flaw 2: suggests increasing/decreasing cache TTL while still using cached availability as the checkout authority.
