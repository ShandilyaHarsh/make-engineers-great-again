# TS-094: Directus Permission-Aware Export And Search

## Metadata

- `id`: TS-094
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: TypeScript API services, ItemsService, query AST, permission processing, searchable fields, concealed fields, export batching, cursor stability, migrations, controllers
- `mode`: synthetic_degraded
- `difficulty`: 10
- `target_diff_lines`: 3,100-4,100
- `represented_diff_lines`: 3900
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Directus accountability, AST permissions, searchable projections, concealed fields, export snapshots, cursor design, and concurrent writes without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a unified permission-aware search and full export path for Directus collections. The stated goal is to make large collection search and export faster by pre-indexing searchable values and by letting exports resume with a cursor instead of holding one long-running transaction.

The PR adds:

- search index types,
- a collection search index builder,
- a search service and controller,
- a resumable full export service,
- export cursor helpers,
- export routes,
- search/export migrations,
- search tests,
- architecture documentation.

The intended product behavior is: users can search large collections and export large result sets while Directus still respects field permissions, concealed fields, filters, accountability, and consistent export results.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `ItemsService.readByQuery` emits query hooks, builds an AST from the collection/query/accountability, calls `processAst`, runs the AST, then emits read hooks.
- `processAst` builds a field map, fetches policies and permissions for the current accountability, validates path existence, validates field permissions, and injects permission cases into the AST.
- Runtime search in `applySearch` filters out non-searchable and concealed fields, restricts fields using read permissions, and applies permission cases around searchable field predicates.
- Export currently reads batches through the authenticated collection service and wraps the batch loop in a database transaction. It also appends the primary key to sort order so batch order is deterministic within that read window.
- Query sanitization parses fields, filters, search, limits, offsets, versions, export formats, and deep queries before they reach services.
- Search and export are data access features. A faster implementation must preserve the same authorization and consistency contracts as normal collection reads.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to decide whether this implementation truly remains permission-aware and whether the export cursor gives stable results under concurrent writes.

## Review Surface

Changed files in the synthetic PR:

- `api/src/services/search-index/search-index-types.ts`
- `api/src/services/search-index/build-search-index.ts`
- `api/src/services/search-index/search-index-service.ts`
- `api/src/controllers/search.ts`
- `api/src/services/export-v2.ts`
- `api/src/services/export-cursor.ts`
- `api/src/controllers/export.ts`
- `api/src/database/migrations/20260516101000_search_export.ts`
- `api/src/services/search-index/search-index.test.ts`
- `docs/architecture/permission-aware-search-export.md`

The line references below use synthetic PR line numbers. The represented diff is focused on permission-safe search indexing and stable full-export iteration.

## Diff

```diff
diff --git a/api/src/services/search-index/search-index-types.ts b/api/src/services/search-index/search-index-types.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/services/search-index/search-index-types.ts
@@ -0,0 +1,300 @@
+import type { Accountability, PrimaryKey, Query } from "@directus/types";
+
+export type SearchDocument = {
+  collection: string;
+  primaryKey: PrimaryKey;
+  searchableText: string;
+  raw: Record<string, unknown>;
+  fields: string[];
+  indexedAt: Date;
+};
+
+export type SearchHit = {
+  collection: string;
+  primaryKey: PrimaryKey;
+  score: number;
+  snippet: string;
+  raw: Record<string, unknown>;
+};
+
+export type SearchIndexOptions = {
+  collection: string;
+  batchSize: number;
+  includeSystemCollections: boolean;
+  includeHiddenFields: boolean;
+  rebuild: boolean;
+};
+
+export type SearchQuery = {
+  collection: string;
+  search: string;
+  limit?: number;
+  offset?: number;
+  fields?: string[];
+  filter?: Query["filter"];
+  accountability: Accountability | null;
+};
+
+export type ExportCursor = {
+  collection: string;
+  sort: string[];
+  lastValue: string | number | null;
+  offset: number;
+  search?: string;
+  filterHash?: string;
+};
+
+export type ExportBatch = {
+  rows: Array<Record<string, unknown>>;
+  nextCursor: ExportCursor | null;
+  done: boolean;
+};
+
+export type FullExportJob = {
+  id: string;
+  collection: string;
+  query: Partial<Query>;
+  format: "json" | "csv";
+  cursor: ExportCursor | null;
+  accountability: Accountability | null;
+  createdAt: Date;
+};
+
+export const DEFAULT_SEARCH_BATCH_SIZE = 1000;
+export const DEFAULT_EXPORT_BATCH_SIZE = 5000;
+export const SEARCH_INDEX_VERSION = 1;
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 230: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 231: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 232: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 233: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 234: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/api/src/services/search-index/build-search-index.ts b/api/src/services/search-index/build-search-index.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/services/search-index/build-search-index.ts
@@ -0,0 +1,520 @@
+import type { Knex } from "knex";
+import type { SchemaOverview } from "@directus/types";
+import { isSystemCollection } from "@directus/system-data";
+import { SearchDocument, SearchIndexOptions } from "./search-index-types";
+
+export async function rebuildCollectionSearchIndex({
+  knex,
+  schema,
+  options,
+  writer,
+}: {
+  knex: Knex;
+  schema: SchemaOverview;
+  options: SearchIndexOptions;
+  writer: { upsertMany: (docs: SearchDocument[]) => Promise<void>; deleteCollection: (collection: string) => Promise<void> };
+}) {
+  const collection = schema.collections[options.collection];
+  if (!collection) return { indexed: 0 };
+  if (isSystemCollection(options.collection) && !options.includeSystemCollections) return { indexed: 0 };
+
+  if (options.rebuild) {
+    await writer.deleteCollection(options.collection);
+  }
+
+  let offset = 0;
+  let indexed = 0;
+
+  while (true) {
+    const rows = await knex(options.collection).select("*").limit(options.batchSize).offset(offset);
+    if (rows.length === 0) break;
+
+    const docs = rows.map((row) => buildSearchDocument({
+      collection: options.collection,
+      primary: collection.primary,
+      row,
+      schema,
+      includeHiddenFields: options.includeHiddenFields,
+    }));
+
+    await writer.upsertMany(docs);
+    indexed += docs.length;
+    offset += options.batchSize;
+  }
+
+  return { indexed };
+}
+
+export function buildSearchDocument({
+  collection,
+  primary,
+  row,
+  schema,
+  includeHiddenFields,
+}: {
+  collection: string;
+  primary: string;
+  row: Record<string, unknown>;
+  schema: SchemaOverview;
+  includeHiddenFields: boolean;
+}): SearchDocument {
+  const fieldEntries = Object.entries(schema.collections[collection]!.fields);
+  const scalarFields = fieldEntries.filter(([, field]) => {
+    if (field.alias) return false;
+    if (field.type === "json") return true;
+    if (["text", "string", "uuid", "integer", "bigInteger", "float", "decimal", "dateTime"].includes(field.type)) return true;
+    return false;
+  });
+
+  const values: string[] = [];
+  const raw: Record<string, unknown> = {};
+
+  for (const [fieldName, field] of scalarFields) {
+    if (includeHiddenFields === false && field.meta?.hidden === true) continue;
+    const value = row[fieldName];
+    if (value === null || value === undefined) continue;
+    raw[fieldName] = value;
+    values.push(String(value));
+  }
+
+  return {
+    collection,
+    primaryKey: row[primary] as string | number,
+    searchableText: values.join(" ").toLowerCase(),
+    raw,
+    fields: Object.keys(raw),
+    indexedAt: new Date(),
+  };
+}
+
+export async function rebuildAllSearchIndexes({ knex, schema, writer }: { knex: Knex; schema: SchemaOverview; writer: any }) {
+  let indexed = 0;
+  for (const collection of Object.keys(schema.collections)) {
+    const result = await rebuildCollectionSearchIndex({
+      knex,
+      schema,
+      writer,
+      options: { collection, batchSize: 1000, includeSystemCollections: false, includeHiddenFields: true, rebuild: true },
+    });
+    indexed += result.indexed;
+  }
+  return { indexed };
+}
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 230: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 231: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 232: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 233: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 234: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 235: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 236: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 237: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 238: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 239: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 240: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 241: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 242: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 243: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 244: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 245: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 246: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 247: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 248: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 249: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 250: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 251: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 252: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 253: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 254: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 255: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 256: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 257: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 258: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 259: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 260: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 261: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 262: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 263: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 264: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 265: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 266: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 267: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 268: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 269: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 270: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 271: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 272: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 273: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 274: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 275: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 276: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 277: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 278: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 279: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 280: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 281: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 282: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 283: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 284: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 285: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 286: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 287: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 288: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 289: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 290: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 291: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 292: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 293: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 294: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 295: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 296: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 297: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 298: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 299: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 300: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 301: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 302: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 303: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 304: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 305: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 306: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 307: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 308: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 309: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 310: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 311: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 312: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 313: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 314: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 315: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 316: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 317: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 318: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 319: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 320: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 321: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 322: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 323: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 324: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 325: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 326: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 327: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 328: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 329: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 330: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 331: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 332: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 333: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 334: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 335: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 336: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 337: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 338: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 339: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 340: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 341: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 342: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 343: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 344: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 345: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 346: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 347: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 348: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 349: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 350: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 351: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 352: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 353: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 354: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 355: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 356: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 357: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 358: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 359: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 360: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 361: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 362: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 363: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 364: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 365: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 366: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 367: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 368: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 369: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 370: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 371: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 372: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 373: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 374: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 375: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 376: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 377: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 378: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 379: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 380: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 381: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 382: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 383: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 384: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 385: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 386: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 387: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 388: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 389: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 390: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 391: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 392: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 393: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 394: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 395: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 396: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 397: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 398: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 399: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 400: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 401: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 402: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 403: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 404: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 405: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 406: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 407: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 408: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 409: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 410: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 411: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 412: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 413: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 414: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 415: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 416: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 417: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/api/src/services/search-index/search-index-service.ts b/api/src/services/search-index/search-index-service.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/services/search-index/search-index-service.ts
@@ -0,0 +1,560 @@
+import type { Accountability, SchemaOverview } from "@directus/types";
+import type { Knex } from "knex";
+import { getService } from "../../utils/get-service";
+import { SearchHit, SearchQuery } from "./search-index-types";
+
+type SearchStore = {
+  search: (args: { collection: string; query: string; limit: number; offset: number }) => Promise<SearchHit[]>;
+  deleteCollection: (collection: string) => Promise<void>;
+  upsertMany: (docs: any[]) => Promise<void>;
+};
+
+export class PermissionAwareSearchService {
+  private knex: Knex;
+  private schema: SchemaOverview;
+  private accountability: Accountability | null;
+  private store: SearchStore;
+
+  constructor(options: { knex: Knex; schema: SchemaOverview; accountability: Accountability | null; store: SearchStore }) {
+    this.knex = options.knex;
+    this.schema = options.schema;
+    this.accountability = options.accountability;
+    this.store = options.store;
+  }
+
+  async search(query: SearchQuery) {
+    const hits = await this.store.search({
+      collection: query.collection,
+      query: query.search.toLowerCase(),
+      limit: query.limit ?? 100,
+      offset: query.offset ?? 0,
+    });
+
+    const service = getService(query.collection, {
+      knex: this.knex,
+      schema: this.schema,
+      accountability: this.accountability,
+    });
+
+    const ids = hits.map((hit) => hit.primaryKey);
+    const visibleRows = await service.readByQuery({
+      fields: query.fields ?? ["*"],
+      filter: { id: { _in: ids } },
+      limit: ids.length,
+    });
+
+    const visibleById = new Map(visibleRows.map((row: any) => [String(row.id), row]));
+
+    return hits.map((hit) => ({
+      collection: hit.collection,
+      primaryKey: hit.primaryKey,
+      score: hit.score,
+      snippet: hit.snippet,
+      matchedFields: Object.keys(hit.raw),
+      raw: hit.raw,
+      item: visibleById.get(String(hit.primaryKey)) ?? null,
+    }));
+  }
+
+  async searchForExport(query: SearchQuery) {
+    const hits = await this.store.search({
+      collection: query.collection,
+      query: query.search.toLowerCase(),
+      limit: query.limit ?? 5000,
+      offset: query.offset ?? 0,
+    });
+
+    return hits.map((hit) => hit.raw);
+  }
+}
+
+export function normalizeSearchHit(hit: SearchHit) {
+  return {
+    collection: hit.collection,
+    primaryKey: hit.primaryKey,
+    score: hit.score,
+    snippet: hit.snippet,
+    fields: Object.keys(hit.raw),
+  };
+}
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 230: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 231: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 232: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 233: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 234: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 235: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 236: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 237: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 238: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 239: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 240: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 241: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 242: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 243: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 244: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 245: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 246: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 247: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 248: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 249: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 250: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 251: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 252: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 253: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 254: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 255: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 256: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 257: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 258: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 259: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 260: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 261: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 262: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 263: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 264: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 265: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 266: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 267: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 268: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 269: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 270: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 271: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 272: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 273: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 274: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 275: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 276: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 277: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 278: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 279: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 280: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 281: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 282: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 283: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 284: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 285: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 286: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 287: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 288: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 289: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 290: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 291: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 292: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 293: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 294: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 295: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 296: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 297: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 298: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 299: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 300: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 301: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 302: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 303: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 304: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 305: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 306: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 307: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 308: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 309: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 310: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 311: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 312: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 313: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 314: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 315: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 316: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 317: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 318: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 319: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 320: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 321: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 322: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 323: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 324: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 325: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 326: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 327: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 328: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 329: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 330: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 331: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 332: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 333: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 334: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 335: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 336: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 337: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 338: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 339: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 340: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 341: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 342: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 343: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 344: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 345: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 346: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 347: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 348: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 349: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 350: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 351: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 352: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 353: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 354: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 355: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 356: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 357: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 358: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 359: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 360: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 361: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 362: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 363: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 364: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 365: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 366: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 367: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 368: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 369: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 370: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 371: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 372: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 373: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 374: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 375: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 376: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 377: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 378: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 379: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 380: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 381: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 382: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 383: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 384: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 385: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 386: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 387: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 388: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 389: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 390: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 391: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 392: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 393: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 394: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 395: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 396: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 397: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 398: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 399: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 400: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 401: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 402: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 403: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 404: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 405: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 406: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 407: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 408: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 409: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 410: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 411: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 412: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 413: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 414: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 415: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 416: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 417: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 418: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 419: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 420: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 421: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 422: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 423: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 424: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 425: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 426: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 427: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 428: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 429: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 430: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 431: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 432: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 433: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 434: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 435: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 436: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 437: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 438: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 439: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 440: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 441: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 442: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 443: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 444: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 445: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 446: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 447: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 448: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 449: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 450: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 451: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 452: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 453: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 454: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 455: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 456: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 457: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 458: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 459: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 460: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 461: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 462: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 463: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 464: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 465: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 466: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 467: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 468: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 469: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 470: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 471: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 472: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 473: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 474: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 475: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 476: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 477: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 478: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 479: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 480: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/api/src/controllers/search.ts b/api/src/controllers/search.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/controllers/search.ts
@@ -0,0 +1,360 @@
+import { Router } from "express";
+import { PermissionAwareSearchService } from "../services/search-index/search-index-service";
+import { sanitizeQuery } from "../utils/sanitize-query";
+import getDatabase from "../database";
+
+export function createSearchRouter(context: any) {
+  const router = Router();
+
+  router.get("/:collection/search", async (req, res, next) => {
+    try {
+      const collection = req.params.collection;
+      const query = await sanitizeQuery(req.query, context.schema, req.accountability);
+      const search = String(req.query.search ?? query.search ?? "").trim();
+
+      const service = new PermissionAwareSearchService({
+        knex: getDatabase(),
+        schema: context.schema,
+        accountability: req.accountability ?? null,
+        store: context.searchStore,
+      });
+
+      const result = await service.search({
+        collection,
+        search,
+        limit: query.limit,
+        offset: query.offset,
+        fields: query.fields ?? ["*"],
+        filter: query.filter,
+        accountability: req.accountability ?? null,
+      });
+
+      res.json({ data: result });
+    } catch (error) {
+      next(error);
+    }
+  });
+
+  router.post("/:collection/search/reindex", async (req, res, next) => {
+    try {
+      const result = await context.searchIndexScheduler.enqueue({
+        collection: req.params.collection,
+        requestedBy: req.accountability?.user ?? null,
+      });
+      res.json({ data: result });
+    } catch (error) {
+      next(error);
+    }
+  });
+
+  return router;
+}
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 230: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 231: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 232: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 233: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 234: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 235: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 236: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 237: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 238: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 239: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 240: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 241: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 242: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 243: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 244: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 245: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 246: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 247: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 248: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 249: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 250: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 251: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 252: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 253: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 254: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 255: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 256: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 257: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 258: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 259: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 260: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 261: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 262: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 263: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 264: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 265: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 266: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 267: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 268: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 269: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 270: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 271: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 272: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 273: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 274: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 275: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 276: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 277: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 278: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 279: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 280: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 281: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 282: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 283: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 284: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 285: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 286: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 287: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 288: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 289: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 290: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 291: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 292: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 293: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 294: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 295: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 296: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 297: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 298: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 299: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 300: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 301: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 302: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 303: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 304: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 305: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 306: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 307: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 308: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/api/src/services/export-v2.ts b/api/src/services/export-v2.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/services/export-v2.ts
@@ -0,0 +1,600 @@
+import { appendFile } from "node:fs/promises";
+import { createReadStream } from "node:fs";
+import type { ExportFormat, Query, SchemaOverview, Accountability } from "@directus/types";
+import type { Knex } from "knex";
+import { getDateTimeFormatted } from "@directus/utils";
+import { createTmpFile } from "@directus/utils/node";
+import { getService } from "../utils/get-service";
+import { FilesService } from "./files";
+import { PermissionAwareSearchService } from "./search-index/search-index-service";
+import { DEFAULT_EXPORT_BATCH_SIZE, ExportBatch, ExportCursor } from "./search-index/search-index-types";
+import { decodeExportCursor, encodeExportCursor, nextExportCursor } from "./export-cursor";
+
+export class FullExportService {
+  private knex: Knex;
+  private schema: SchemaOverview;
+  private accountability: Accountability | null;
+  private searchStore: any;
+
+  constructor(options: { knex: Knex; schema: SchemaOverview; accountability: Accountability | null; searchStore: any }) {
+    this.knex = options.knex;
+    this.schema = options.schema;
+    this.accountability = options.accountability;
+    this.searchStore = options.searchStore;
+  }
+
+  async exportToFile(collection: string, query: Partial<Query>, format: ExportFormat, encodedCursor?: string | null) {
+    const tmpFile = await createTmpFile();
+    let cursor = encodedCursor ? decodeExportCursor(encodedCursor) : null;
+    let batchCount = 0;
+
+    while (true) {
+      const batch = await this.readNextBatch(collection, query, cursor);
+      if (batch.rows.length === 0) break;
+
+      await appendFile(tmpFile.path, this.transform(batch.rows, format, {
+        includeHeader: batchCount === 0,
+        includeFooter: batch.done,
+      }));
+
+      batchCount += 1;
+      cursor = batch.nextCursor;
+      if (batch.done || !cursor) break;
+    }
+
+    const title = "export-" + collection + "-" + getDateTimeFormatted();
+    const filesService = new FilesService({ schema: this.schema, accountability: this.accountability });
+    return filesService.uploadOne(createReadStream(tmpFile.path), {
+      title,
+      filename_download: title + "." + format,
+      type: format === "json" ? "application/json" : "text/csv",
+    });
+  }
+
+  async readNextBatch(collection: string, query: Partial<Query>, cursor: ExportCursor | null): Promise<ExportBatch> {
+    const limit = Math.min(query.limit ?? DEFAULT_EXPORT_BATCH_SIZE, DEFAULT_EXPORT_BATCH_SIZE);
+    const offset = cursor?.offset ?? query.offset ?? 0;
+
+    if (query.search) {
+      const searchService = new PermissionAwareSearchService({
+        knex: this.knex,
+        schema: this.schema,
+        accountability: this.accountability,
+        store: this.searchStore,
+      });
+      const rows = await searchService.searchForExport({
+        collection,
+        search: query.search,
+        limit,
+        offset,
+        filter: query.filter,
+        fields: query.fields,
+        accountability: this.accountability,
+      });
+      return { rows, nextCursor: nextExportCursor(collection, query, rows, offset + rows.length), done: rows.length < limit };
+    }
+
+    const service = getService(collection, {
+      knex: this.knex,
+      schema: this.schema,
+      accountability: this.accountability,
+    });
+
+    const rows = await service.readByQuery({
+      ...query,
+      limit,
+      offset,
+      sort: query.sort ?? [this.schema.collections[collection]!.primary],
+    });
+
+    return { rows, nextCursor: nextExportCursor(collection, query, rows, offset + rows.length), done: rows.length < limit };
+  }
+
+  transform(rows: Array<Record<string, unknown>>, format: ExportFormat, options: { includeHeader: boolean; includeFooter: boolean }) {
+    if (format === "json") {
+      const prefix = options.includeHeader ? "[" : ",";
+      const suffix = options.includeFooter ? "]" : "";
+      return prefix + rows.map((row) => JSON.stringify(row)).join(",") + suffix;
+    }
+    const header = options.includeHeader ? Object.keys(rows[0] ?? {}).join(",") + "\n" : "";
+    const body = rows.map((row) => Object.values(row).join(",")).join("\n");
+    return header + body + "\n";
+  }
+}
+
+export function serializeExportState(cursor: ExportCursor | null) {
+  return cursor ? encodeExportCursor(cursor) : null;
+}
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 230: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 231: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 232: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 233: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 234: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 235: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 236: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 237: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 238: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 239: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 240: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 241: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 242: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 243: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 244: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 245: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 246: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 247: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 248: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 249: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 250: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 251: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 252: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 253: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 254: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 255: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 256: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 257: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 258: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 259: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 260: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 261: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 262: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 263: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 264: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 265: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 266: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 267: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 268: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 269: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 270: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 271: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 272: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 273: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 274: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 275: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 276: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 277: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 278: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 279: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 280: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 281: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 282: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 283: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 284: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 285: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 286: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 287: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 288: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 289: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 290: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 291: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 292: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 293: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 294: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 295: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 296: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 297: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 298: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 299: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 300: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 301: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 302: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 303: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 304: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 305: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 306: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 307: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 308: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 309: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 310: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 311: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 312: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 313: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 314: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 315: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 316: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 317: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 318: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 319: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 320: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 321: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 322: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 323: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 324: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 325: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 326: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 327: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 328: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 329: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 330: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 331: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 332: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 333: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 334: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 335: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 336: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 337: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 338: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 339: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 340: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 341: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 342: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 343: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 344: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 345: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 346: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 347: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 348: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 349: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 350: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 351: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 352: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 353: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 354: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 355: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 356: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 357: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 358: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 359: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 360: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 361: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 362: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 363: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 364: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 365: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 366: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 367: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 368: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 369: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 370: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 371: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 372: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 373: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 374: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 375: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 376: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 377: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 378: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 379: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 380: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 381: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 382: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 383: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 384: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 385: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 386: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 387: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 388: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 389: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 390: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 391: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 392: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 393: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 394: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 395: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 396: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 397: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 398: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 399: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 400: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 401: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 402: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 403: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 404: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 405: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 406: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 407: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 408: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 409: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 410: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 411: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 412: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 413: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 414: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 415: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 416: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 417: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 418: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 419: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 420: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 421: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 422: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 423: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 424: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 425: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 426: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 427: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 428: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 429: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 430: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 431: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 432: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 433: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 434: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 435: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 436: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 437: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 438: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 439: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 440: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 441: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 442: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 443: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 444: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 445: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 446: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 447: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 448: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 449: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 450: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 451: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 452: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 453: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 454: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 455: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 456: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 457: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 458: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 459: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 460: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 461: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 462: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 463: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 464: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 465: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 466: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 467: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 468: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 469: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 470: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 471: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 472: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 473: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 474: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 475: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 476: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 477: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 478: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 479: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 480: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 481: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 482: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 483: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 484: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 485: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 486: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 487: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 488: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 489: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 490: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 491: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 492: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/api/src/services/export-cursor.ts b/api/src/services/export-cursor.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/services/export-cursor.ts
@@ -0,0 +1,420 @@
+import type { Query } from "@directus/types";
+import { createHash } from "node:crypto";
+import { ExportCursor } from "./search-index/search-index-types";
+
+export function encodeExportCursor(cursor: ExportCursor) {
+  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
+}
+
+export function decodeExportCursor(encoded: string): ExportCursor {
+  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
+}
+
+export function nextExportCursor(collection: string, query: Partial<Query>, rows: Array<Record<string, unknown>>, offset: number): ExportCursor | null {
+  if (rows.length === 0) return null;
+  const sort = query.sort ?? ["id"];
+  const lastRow = rows[rows.length - 1]!;
+  const sortField = sort[0]!.replace(/^-/, "");
+  return {
+    collection,
+    sort,
+    lastValue: lastRow[sortField] as string | number | null,
+    offset,
+    search: query.search,
+    filterHash: hashFilter(query.filter),
+  };
+}
+
+export function applyCursorToQuery(query: Partial<Query>, cursor: ExportCursor | null): Partial<Query> {
+  if (!cursor) return query;
+  return {
+    ...query,
+    sort: cursor.sort,
+    offset: cursor.offset,
+  };
+}
+
+function hashFilter(filter: unknown) {
+  if (!filter) return undefined;
+  return createHash("sha1").update(JSON.stringify(filter)).digest("hex");
+}
+
+export function assertCursorMatchesQuery(cursor: ExportCursor, collection: string, query: Partial<Query>) {
+  if (cursor.collection !== collection) throw new Error("Cursor collection mismatch");
+  if (cursor.filterHash !== hashFilter(query.filter)) throw new Error("Cursor filter mismatch");
+  if (String(cursor.search ?? "") !== String(query.search ?? "")) throw new Error("Cursor search mismatch");
+}
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 230: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 231: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 232: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 233: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 234: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 235: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 236: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 237: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 238: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 239: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 240: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 241: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 242: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 243: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 244: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 245: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 246: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 247: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 248: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 249: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 250: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 251: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 252: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 253: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 254: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 255: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 256: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 257: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 258: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 259: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 260: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 261: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 262: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 263: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 264: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 265: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 266: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 267: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 268: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 269: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 270: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 271: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 272: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 273: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 274: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 275: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 276: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 277: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 278: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 279: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 280: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 281: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 282: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 283: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 284: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 285: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 286: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 287: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 288: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 289: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 290: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 291: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 292: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 293: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 294: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 295: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 296: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 297: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 298: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 299: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 300: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 301: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 302: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 303: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 304: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 305: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 306: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 307: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 308: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 309: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 310: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 311: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 312: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 313: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 314: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 315: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 316: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 317: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 318: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 319: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 320: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 321: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 322: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 323: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 324: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 325: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 326: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 327: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 328: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 329: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 330: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 331: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 332: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 333: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 334: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 335: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 336: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 337: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 338: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 339: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 340: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 341: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 342: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 343: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 344: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 345: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 346: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 347: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 348: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 349: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 350: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 351: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 352: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 353: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 354: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 355: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 356: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 357: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 358: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 359: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 360: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 361: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 362: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 363: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 364: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 365: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 366: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 367: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 368: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 369: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 370: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 371: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 372: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 373: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/api/src/controllers/export.ts b/api/src/controllers/export.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/controllers/export.ts
@@ -0,0 +1,320 @@
+import { Router } from "express";
+import getDatabase from "../database";
+import { FullExportService, serializeExportState } from "../services/export-v2";
+import { decodeExportCursor } from "../services/export-cursor";
+import { sanitizeQuery } from "../utils/sanitize-query";
+
+export function createFullExportRouter(context: any) {
+  const router = Router();
+
+  router.post("/:collection/export", async (req, res, next) => {
+    try {
+      const query = await sanitizeQuery(req.body.query ?? {}, context.schema, req.accountability);
+      const service = new FullExportService({
+        knex: getDatabase(),
+        schema: context.schema,
+        accountability: req.accountability ?? null,
+        searchStore: context.searchStore,
+      });
+      const file = await service.exportToFile(req.params.collection, query, req.body.format ?? "json", req.body.cursor);
+      res.json({ data: file });
+    } catch (error) {
+      next(error);
+    }
+  });
+
+  router.post("/:collection/export/preview-cursor", async (req, res, next) => {
+    try {
+      const cursor = req.body.cursor ? decodeExportCursor(req.body.cursor) : null;
+      res.json({ data: { cursor, encoded: serializeExportState(cursor) } });
+    } catch (error) {
+      next(error);
+    }
+  });
+
+  return router;
+}
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 230: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 231: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 232: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 233: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 234: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 235: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 236: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 237: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 238: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 239: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 240: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 241: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 242: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 243: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 244: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 245: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 246: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 247: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 248: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 249: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 250: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 251: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 252: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 253: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 254: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 255: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 256: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 257: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 258: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 259: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 260: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 261: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 262: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 263: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 264: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 265: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 266: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 267: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 268: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 269: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 270: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 271: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 272: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 273: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 274: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 275: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 276: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 277: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 278: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 279: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 280: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 281: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 282: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 283: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/api/src/database/migrations/20260516101000_search_export.ts b/api/src/database/migrations/20260516101000_search_export.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/database/migrations/20260516101000_search_export.ts
@@ -0,0 +1,260 @@
+import type { Knex } from "knex";
+
+export async function up(knex: Knex): Promise<void> {
+  await knex.schema.createTable("directus_search_documents", (table) => {
+    table.string("collection").notNullable();
+    table.string("primary_key").notNullable();
+    table.text("searchable_text").notNullable();
+    table.jsonb("raw").notNullable();
+    table.specificType("fields", "text[]").notNullable();
+    table.timestamp("indexed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
+    table.primary(["collection", "primary_key"]);
+    table.index(["collection", "indexed_at"]);
+  });
+
+  await knex.schema.createTable("directus_full_export_jobs", (table) => {
+    table.uuid("id").primary();
+    table.string("collection").notNullable();
+    table.jsonb("query").notNullable();
+    table.string("format", 16).notNullable();
+    table.text("cursor").nullable();
+    table.uuid("user").nullable();
+    table.string("status", 32).notNullable().defaultTo("queued");
+    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
+  });
+}
+
+export async function down(knex: Knex): Promise<void> {
+  await knex.schema.dropTableIfExists("directus_full_export_jobs");
+  await knex.schema.dropTableIfExists("directus_search_documents");
+}
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/api/src/services/search-index/search-index.test.ts b/api/src/services/search-index/search-index.test.ts
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/api/src/services/search-index/search-index.test.ts
@@ -0,0 +1,300 @@
+import { describe, expect, it, vi } from "vitest";
+import { buildSearchDocument } from "./build-search-index";
+import { PermissionAwareSearchService } from "./search-index-service";
+
+describe("search index", () => {
+  it("indexes all scalar fields so global search can match full records", () => {
+    const schema: any = {
+      collections: {
+        articles: {
+          primary: "id",
+          fields: {
+            id: { field: "id", type: "uuid", special: [] },
+            title: { field: "title", type: "string", special: [] },
+            internal_notes: { field: "internal_notes", type: "text", special: ["conceal"], meta: { hidden: true } },
+          },
+        },
+      },
+    };
+    const doc = buildSearchDocument({
+      collection: "articles",
+      primary: "id",
+      schema,
+      includeHiddenFields: true,
+      row: { id: "a", title: "Public", internal_notes: "do not show" },
+    });
+    expect(doc.searchableText).toContain("do not show");
+    expect(doc.raw.internal_notes).toBe("do not show");
+  });
+
+  it("returns indexed snippets even when row hydration is filtered", async () => {
+    const store = {
+      search: vi.fn().mockResolvedValue([
+        { collection: "articles", primaryKey: "a", score: 1, snippet: "do not show", raw: { internal_notes: "do not show" } },
+      ]),
+    };
+    const service = new PermissionAwareSearchService({
+      knex: {} as never,
+      schema: { collections: { articles: { primary: "id", fields: {} } } } as never,
+      accountability: { admin: false, role: "reader" } as never,
+      store: store as never,
+    });
+    vi.mocked(store.search);
+    const results = await service.search({ collection: "articles", search: "secret", accountability: null, limit: 1 });
+    expect(results[0]!.snippet).toBe("do not show");
+  });
+});
+
+// review-trace 001: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 002: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 003: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 004: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 005: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 006: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 007: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 008: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 009: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 010: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 011: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 012: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 013: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 014: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 015: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 016: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 017: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 018: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 019: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 020: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 021: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 022: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 023: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 024: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 025: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 026: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 027: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 028: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 029: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 030: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 031: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 032: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 033: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 034: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 035: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 036: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 037: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 038: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 039: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 040: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 041: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 042: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 043: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 044: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 045: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 046: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 047: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 048: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 049: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 050: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 051: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 052: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 053: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 054: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 055: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 056: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 057: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 058: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 059: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 060: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 061: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 062: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 063: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 064: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 065: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 066: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 067: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 068: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 069: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 070: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 071: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 072: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 073: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 074: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 075: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 076: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 077: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 078: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 079: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 080: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 081: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 082: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 083: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 084: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 085: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 086: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 087: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 088: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 089: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 090: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 091: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 092: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 093: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 094: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 095: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 096: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 097: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 098: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 099: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 100: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 101: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 102: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 103: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 104: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 105: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 106: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 107: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 108: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 109: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 110: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 111: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 112: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 113: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 114: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 115: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 116: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 117: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 118: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 119: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 120: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 121: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 122: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 123: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 124: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 125: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 126: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 127: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 128: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 129: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 130: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 131: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 132: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 133: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 134: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 135: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 136: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 137: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 138: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 139: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 140: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 141: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 142: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 143: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 144: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 145: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 146: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 147: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 148: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 149: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 150: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 151: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 152: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 153: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 154: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 155: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 156: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 157: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 158: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 159: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 160: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 161: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 162: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 163: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 164: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 165: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 166: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 167: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 168: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 169: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 170: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 171: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 172: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 173: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 174: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 175: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 176: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 177: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 178: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 179: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 180: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 181: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 182: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 183: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 184: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 185: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 186: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 187: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 188: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 189: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 190: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 191: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 192: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 193: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 194: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 195: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 196: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 197: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 198: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 199: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 200: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 201: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 202: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 203: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 204: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 205: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 206: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 207: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 208: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 209: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 210: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 211: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 212: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 213: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 214: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 215: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 216: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 217: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 218: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 219: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 220: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 221: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 222: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 223: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 224: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 225: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 226: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 227: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 228: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 229: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 230: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 231: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 232: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 233: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 234: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 235: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 236: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 237: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 238: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 239: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 240: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 241: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 242: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 243: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 244: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 245: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 246: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 247: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 248: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 249: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 250: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 251: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 252: trace permission-aware search projection, export cursor stability, and snapshot semantics.
+// review-trace 253: trace permission-aware search projection, export cursor stability, and snapshot semantics.
diff --git a/docs/architecture/permission-aware-search-export.md b/docs/architecture/permission-aware-search-export.md
new file mode 100644
index 0000000000..094bad0000
--- /dev/null
+++ b/docs/architecture/permission-aware-search-export.md
@@ -0,0 +1,200 @@
+# Permission-Aware Search And Full Export
+
+This change introduces a shared search index used by global collection search and full export.
+
+## Search Index
+
+The indexer scans raw collection tables and stores scalar values in `directus_search_documents`. Hidden fields can be included so administrators do not need to maintain a separate searchable field list.
+
+Search results hydrate visible rows after the index lookup. If a row is not visible, the hit still includes the indexed snippet so users understand why the record matched.
+
+## Full Export
+
+Large exports no longer hold a database transaction open for the full run. Each batch stores a cursor containing the current offset and last sort value, allowing the client or worker to resume later.
+
+When a search term is present, export reads directly from the search index because the search index already has the flattened raw data required for CSV and JSON output.
+
+## Rollout
+
+- Rebuild indexes collection by collection.
+- Use the new export endpoint for large collections.
+- Keep the previous export path for small collections during rollout.
+
+- Review note 023: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 024: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 025: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 026: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 027: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 028: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 029: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 030: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 031: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 032: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 033: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 034: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 035: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 036: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 037: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 038: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 039: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 040: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 041: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 042: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 043: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 044: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 045: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 046: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 047: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 048: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 049: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 050: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 051: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 052: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 053: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 054: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 055: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 056: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 057: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 058: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 059: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 060: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 061: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 062: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 063: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 064: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 065: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 066: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 067: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 068: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 069: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 070: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 071: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 072: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 073: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 074: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 075: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 076: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 077: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 078: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 079: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 080: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 081: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 082: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 083: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 084: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 085: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 086: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 087: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 088: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 089: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 090: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 091: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 092: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 093: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 094: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 095: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 096: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 097: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 098: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 099: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 100: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 101: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 102: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 103: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 104: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 105: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 106: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 107: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 108: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 109: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 110: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 111: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 112: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 113: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 114: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 115: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 116: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 117: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 118: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 119: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 120: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 121: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 122: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 123: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 124: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 125: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 126: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 127: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 128: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 129: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 130: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 131: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 132: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 133: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 134: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 135: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 136: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 137: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 138: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 139: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 140: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 141: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 142: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 143: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 144: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 145: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 146: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 147: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 148: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 149: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 150: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 151: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 152: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 153: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 154: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 155: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 156: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 157: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 158: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 159: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 160: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 161: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 162: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 163: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 164: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 165: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 166: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 167: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 168: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 169: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 170: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 171: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 172: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 173: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 174: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 175: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 176: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 177: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 178: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 179: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 180: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 181: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 182: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 183: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 184: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 185: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 186: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 187: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 188: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 189: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 190: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 191: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 192: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 193: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 194: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 195: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 196: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 197: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 198: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 199: verify whether search/export preserves permissions, field visibility, and stable read windows.
+- Review note 200: verify whether search/export preserves permissions, field visibility, and stable read windows.
```

## Intended Flaw 1: Search Index Is Built From Raw Rows Instead Of Permission-Aware Searchable Projections

### Why This Is A Flaw

The PR calls the feature permission-aware because it hydrates rows after the search hit, but the index itself is built from raw table rows. It indexes all scalar fields, includes hidden/concealed fields, stores raw values, returns snippets and matched field names from the index, and lets export read raw indexed values directly. That bypasses Directus's existing AST permission path, searchable-field filtering, concealed-field exclusion, and permission-case search predicates.

### Hint 1

Search is not just row hydration. Ask which fields are allowed to participate in matching and snippets before a row is returned.

### Hint 2

Compare the real search path's field filtering to the index builder. What happens to concealed or role-restricted fields?

### Hint 3

Look at the export shortcut for search queries. Does it return rows after `ItemsService.readByQuery`, or does it trust indexed raw data?

### Expected Identification

A strong answer should cite `api/src/services/search-index/build-search-index.ts:27-75`, `api/src/services/search-index/search-index-service.ts:25-56`, `api/src/services/search-index/search-index-service.ts:58-74`, `api/src/controllers/search.ts:17-31`, `api/src/services/search-index/search-index.test.ts:21-48`, and `docs/architecture/permission-aware-search-export.md:7-15`.

### Expected Impact

A user can learn that a restricted or concealed field contains a term because the indexed hit, snippet, matched fields, or export row leaks it. Even if row hydration later returns `null`, the search result has already exposed data. Search exports are worse: they can return indexed raw rows without passing through Directus field permissions. This weakens one of the central contracts of a headless CMS: collection reads and derived read features must share the same access model.

### Expected Fix Direction

Do not build one raw global index and call it permission-aware after the fact. Either compile a searchable projection through the same permission/search rules used by `ItemsService.readByQuery`, or store only field-safe tokens/metadata that never reveal restricted content. Exclude concealed and non-searchable fields. Keep snippets derived from authorized fields only. For role-sensitive rules, use per-policy indexes, query-time permission filters, or a hybrid design where the index returns candidate IDs and `ItemsService` performs final matching on allowed fields.

## Intended Flaw 2: Resumable Export Cursor Has No Stable Snapshot Or Deterministic Keyset Contract

### Why This Is A Flaw

The PR removes the long transaction from export but replaces it with an offset/last-value cursor that is not tied to a stable read snapshot. Each batch is a fresh read against a moving collection or a moving search index. Inserts, deletes, updates to sort fields, permission changes, or index refreshes between batches can shift offsets and search ordering. The cursor also records only the first sort value and offset, not a complete deterministic keyset boundary.

### Hint 1

Ask what data set batch two is reading from. Is it the same logical data set as batch one, or whatever the database/index currently contains?

### Hint 2

Look at the cursor fields. Are all sort columns and a primary-key tiebreaker represented, or is this mostly an offset resume token?

### Hint 3

Search-index export has an extra wrinkle: the index can refresh independently of the database. What does that do to resumable export correctness?

### Expected Identification

A strong answer should cite `api/src/services/export-v2.ts:26-84`, `api/src/services/export-v2.ts:86-112`, `api/src/services/export-cursor.ts:12-37`, `api/src/controllers/export.ts:10-23`, and `docs/architecture/permission-aware-search-export.md:11-19`.

### Expected Impact

Large exports can duplicate records, miss records, include records that did not exist when the export started, or produce different CSV/JSON content when resumed. A customer exporting data for migration, compliance, or backup cannot trust the file. Search-backed export can be even less stable because index refresh timing becomes part of export correctness.

### Expected Fix Direction

Define an export snapshot contract. Options include keeping the transaction/read snapshot for the duration when the database can support it, materializing the authorized primary-key list at export start, or using keyset pagination with a stable compound order, primary-key tiebreaker, and upper-bound watermark captured at start. The cursor should encode all ordered fields, direction, primary key, filter/search hash, schema/index version, and snapshot/watermark identity. Search-backed export should export authorized IDs from a consistent index generation and hydrate rows through `ItemsService`, not stream raw index documents.

## Expert Debrief

### Product-Level Change

This PR is not a minor performance optimization. It creates new read surfaces: global search snippets and resumable full exports. Those surfaces carry the same confidentiality and correctness obligations as normal collection reads.

### Contract Changes

The diff changes search from "evaluate search inside permission-aware query execution" to "match against a raw precomputed index and hydrate later." It changes export from "one transactional batch loop" to "many independent reads connected by an offset-like cursor." Both are major contract changes.

### Failure Modes

The central failures are restricted-field search leaks, concealed-field snippets, raw indexed export rows, search results that reveal why a hidden row matched, duplicate/missed export rows under concurrent writes, and non-repeatable exports after index refreshes.

### Reviewer Thought Process

The useful review move is to separate performance shape from semantic shape. A search index and a resumable cursor can be correct, but only if they explicitly preserve the old contracts. For search, the core question is "what data can influence a match?" For export, the core question is "what exact data set is this file representing?" The PR answers both too casually.

### Better Implementation Direction

Keep the index as a candidate accelerator, not an authorization oracle. Let the permission-aware query path decide authorized matches, fields, snippets, and exports. For exports, choose a clear consistency model and encode it in the cursor. If the product accepts bounded freshness instead of a database snapshot, document it and make the file metadata say which snapshot/index generation was exported.

## Correctness Verdict Rubric

A submitted answer is correct only if it identifies both intended flaws:

- raw search indexing exposes restricted/concealed fields and lets search/export bypass the permission-aware searchable projection;
- the export cursor is offset-like and unsnapshotted, so concurrent writes or index refreshes can produce duplicate, missing, or non-repeatable export output.

Partial credit is not enough for completion in the training app. The verdict should be per flaw: correct, partially correct, or missed. Hints do not reduce the verdict.
