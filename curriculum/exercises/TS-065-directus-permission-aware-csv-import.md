# TS-065: Directus Permission-Aware CSV Import

## Metadata

- `id`: TS-065
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: ImportService, ItemsService, processPayload, validateAccess, fetchAllowedFields, CSV parsing, run progress, transactions, action events
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 2,050-2,500
- `represented_diff_lines`: 2161
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Directus accountability, processPayload, row-level permission validation, field allowlists, import resumability, transaction scopes, and action-event timing without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a permission-aware CSV import endpoint for Directus. It lets users upload a CSV to a collection, previews which headers are importable, creates an import run record, and writes rows through a high-throughput batch executor. The PR claims it preserves existing Directus permissions while making large imports faster and easier to observe.

The PR adds:

- import run tracking,
- CSV header planning and field filtering,
- a new `PermissionAwareCsvImportService`,
- a REST endpoint under `/utils/import/:collection/csv`,
- a migration for import run progress,
- tests and operator documentation.

The intended product behavior is: importing CSV should obey the exact same create/update permissions, presets, field restrictions, row-level validation, and accountability behavior as normal item writes. Large files should not hold one database transaction across parsing and every row write.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `ImportService.importCSV` parses CSV rows and currently writes through collection services.
- `ItemsService.createOne` and update paths call `processPayload` with the request accountability before writing.
- `processPayload` fetches policies, field permissions, presets, permission validation rules, field validation rules, and dynamic variable data.
- `validateAccess` has different paths for collection access and item access; item access requires primary keys and can return allowed root fields.
- `fetchAllowedFields` returns allowed fields for a collection/action/policy combination, but field allowlists alone do not evaluate row-level validation rules.
- Existing import code groups row errors and uses Directus action events after import work completes.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether the import preserves command-layer permission semantics and whether the transaction boundary is appropriate for large files.

## Review Surface

Changed files in the synthetic PR:

- `api/src/services/import-export/permission-aware-csv-import-types.ts`
- `api/src/services/import-export/permission-aware-csv-import-plan.ts`
- `api/src/services/import-export/permission-aware-csv-import-run-store.ts`
- `api/src/services/import-export/permission-aware-csv-import.ts`
- `api/src/controllers/permission-aware-csv-import.ts`
- `api/src/database/migrations/20260516A-permission-aware-csv-import-runs.ts`
- `api/src/services/import-export/permission-aware-csv-import.test.ts`
- `docs/permission-aware-csv-import.md`

The line references below use synthetic PR line numbers. The represented diff is focused on Directus permission boundaries, command-layer writes, CSV batching, and transaction scope.

## Diff

```diff
diff --git a/api/src/services/import-export/permission-aware-csv-import-types.ts b/api/src/services/import-export/permission-aware-csv-import-types.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/api/src/services/import-export/permission-aware-csv-import-types.ts
@@ -0,0 +1,186 @@
+import type { Accountability, PrimaryKey, SchemaOverview } from '@directus/types';
+import { z } from 'zod';
+
+export const PermissionAwareCsvImportOptionsSchema = z.object({
+  collection: z.string().min(1),
+  filename: z.string().min(1),
+  mimetype: z.literal('text/csv'),
+  background: z.boolean().default(false),
+  dryRun: z.boolean().default(false),
+  upsert: z.boolean().default(true),
+  batchSize: z.number().int().min(1).max(10_000).default(5_000),
+  skipHeaderValidation: z.boolean().default(false),
+});
+
+export type PermissionAwareCsvImportOptions = z.infer<typeof PermissionAwareCsvImportOptionsSchema>;
+
+export type CsvImportHeader = {
+  name: string;
+  normalizedName: string;
+  index: number;
+  isPrimaryKey: boolean;
+  isAllowed: boolean;
+};
+
+export type CsvImportParsedRow = {
+  rowNumber: number;
+  values: Record<string, unknown>;
+  primaryKey?: PrimaryKey;
+  operation: "create" | "update";
+};
+
+export type CsvImportRejectedRow = {
+  rowNumber: number;
+  code: string;
+  message: string;
+  field?: string;
+};
+
+export type CsvImportBatchResult = {
+  batchNumber: number;
+  inserted: number;
+  updated: number;
+  rejected: CsvImportRejectedRow[];
+  firstRow: number;
+  lastRow: number;
+};
+
+export type CsvImportRun = {
+  id: string;
+  collection: string;
+  filename: string;
+  status: "queued" | "running" | "succeeded" | "failed";
+  accountability: Accountability | null;
+  createdAt: Date;
+  startedAt?: Date | null;
+  finishedAt?: Date | null;
+  processedRows: number;
+  importedRows: number;
+  rejectedRows: number;
+  errorMessage?: string | null;
+};
+
+export type CsvImportPermissionSnapshot = {
+  collection: string;
+  createAllowed: boolean;
+  updateAllowed: boolean;
+  allowedCreateFields: string[];
+  allowedUpdateFields: string[];
+  capturedAt: Date;
+};
+
+export type CsvImportContext = {
+  schema: SchemaOverview;
+  accountability: Accountability | null;
+  importId: string;
+  collection: string;
+  primaryKeyField: string;
+  permissionSnapshot: CsvImportPermissionSnapshot;
+};
+
+export type CsvImportPlan = {
+  importId: string;
+  collection: string;
+  headers: CsvImportHeader[];
+  rows: AsyncIterable<CsvImportParsedRow>;
+  estimatedRows?: number;
+  batchSize: number;
+};
+
+export type CsvImportExecutor = {
+  execute(plan: CsvImportPlan, context: CsvImportContext): Promise<CsvImportBatchResult[]>;
+};
+
+export const CSV_IMPORT_RUN_EVENT = "csv-import.run";
+export const CSV_IMPORT_BATCH_EVENT = "csv-import.batch";
+export const CSV_IMPORT_ROW_EVENT = "csv-import.row";
+export const csvImportMetric_001 = { name: "csv_import_metric_1", collectionScoped: true } as const;
+export const csvImportMetric_002 = { name: "csv_import_metric_2", collectionScoped: true } as const;
+export const csvImportMetric_003 = { name: "csv_import_metric_3", collectionScoped: true } as const;
+export const csvImportMetric_004 = { name: "csv_import_metric_4", collectionScoped: true } as const;
+export const csvImportMetric_005 = { name: "csv_import_metric_5", collectionScoped: true } as const;
+export const csvImportMetric_006 = { name: "csv_import_metric_6", collectionScoped: true } as const;
+export const csvImportMetric_007 = { name: "csv_import_metric_7", collectionScoped: true } as const;
+export const csvImportMetric_008 = { name: "csv_import_metric_8", collectionScoped: true } as const;
+export const csvImportMetric_009 = { name: "csv_import_metric_9", collectionScoped: true } as const;
+export const csvImportMetric_010 = { name: "csv_import_metric_10", collectionScoped: true } as const;
+export const csvImportMetric_011 = { name: "csv_import_metric_11", collectionScoped: true } as const;
+export const csvImportMetric_012 = { name: "csv_import_metric_12", collectionScoped: true } as const;
+export const csvImportMetric_013 = { name: "csv_import_metric_13", collectionScoped: true } as const;
+export const csvImportMetric_014 = { name: "csv_import_metric_14", collectionScoped: true } as const;
+export const csvImportMetric_015 = { name: "csv_import_metric_15", collectionScoped: true } as const;
+export const csvImportMetric_016 = { name: "csv_import_metric_16", collectionScoped: true } as const;
+export const csvImportMetric_017 = { name: "csv_import_metric_17", collectionScoped: true } as const;
+export const csvImportMetric_018 = { name: "csv_import_metric_18", collectionScoped: true } as const;
+export const csvImportMetric_019 = { name: "csv_import_metric_19", collectionScoped: true } as const;
+export const csvImportMetric_020 = { name: "csv_import_metric_20", collectionScoped: true } as const;
+export const csvImportMetric_021 = { name: "csv_import_metric_21", collectionScoped: true } as const;
+export const csvImportMetric_022 = { name: "csv_import_metric_22", collectionScoped: true } as const;
+export const csvImportMetric_023 = { name: "csv_import_metric_23", collectionScoped: true } as const;
+export const csvImportMetric_024 = { name: "csv_import_metric_24", collectionScoped: true } as const;
+export const csvImportMetric_025 = { name: "csv_import_metric_25", collectionScoped: true } as const;
+export const csvImportMetric_026 = { name: "csv_import_metric_26", collectionScoped: true } as const;
+export const csvImportMetric_027 = { name: "csv_import_metric_27", collectionScoped: true } as const;
+export const csvImportMetric_028 = { name: "csv_import_metric_28", collectionScoped: true } as const;
+export const csvImportMetric_029 = { name: "csv_import_metric_29", collectionScoped: true } as const;
+export const csvImportMetric_030 = { name: "csv_import_metric_30", collectionScoped: true } as const;
+export const csvImportMetric_031 = { name: "csv_import_metric_31", collectionScoped: true } as const;
+export const csvImportMetric_032 = { name: "csv_import_metric_32", collectionScoped: true } as const;
+export const csvImportMetric_033 = { name: "csv_import_metric_33", collectionScoped: true } as const;
+export const csvImportMetric_034 = { name: "csv_import_metric_34", collectionScoped: true } as const;
+export const csvImportMetric_035 = { name: "csv_import_metric_35", collectionScoped: true } as const;
+export const csvImportMetric_036 = { name: "csv_import_metric_36", collectionScoped: true } as const;
+export const csvImportMetric_037 = { name: "csv_import_metric_37", collectionScoped: true } as const;
+export const csvImportMetric_038 = { name: "csv_import_metric_38", collectionScoped: true } as const;
+export const csvImportMetric_039 = { name: "csv_import_metric_39", collectionScoped: true } as const;
+export const csvImportMetric_040 = { name: "csv_import_metric_40", collectionScoped: true } as const;
+export const csvImportMetric_041 = { name: "csv_import_metric_41", collectionScoped: true } as const;
+export const csvImportMetric_042 = { name: "csv_import_metric_42", collectionScoped: true } as const;
+export const csvImportMetric_043 = { name: "csv_import_metric_43", collectionScoped: true } as const;
+export const csvImportMetric_044 = { name: "csv_import_metric_44", collectionScoped: true } as const;
+export const csvImportMetric_045 = { name: "csv_import_metric_45", collectionScoped: true } as const;
+export const csvImportMetric_046 = { name: "csv_import_metric_46", collectionScoped: true } as const;
+export const csvImportMetric_047 = { name: "csv_import_metric_47", collectionScoped: true } as const;
+export const csvImportMetric_048 = { name: "csv_import_metric_48", collectionScoped: true } as const;
+export const csvImportMetric_049 = { name: "csv_import_metric_49", collectionScoped: true } as const;
+export const csvImportMetric_050 = { name: "csv_import_metric_50", collectionScoped: true } as const;
+export const csvImportMetric_051 = { name: "csv_import_metric_51", collectionScoped: true } as const;
+export const csvImportMetric_052 = { name: "csv_import_metric_52", collectionScoped: true } as const;
+export const csvImportMetric_053 = { name: "csv_import_metric_53", collectionScoped: true } as const;
+export const csvImportMetric_054 = { name: "csv_import_metric_54", collectionScoped: true } as const;
+export const csvImportMetric_055 = { name: "csv_import_metric_55", collectionScoped: true } as const;
+export const csvImportMetric_056 = { name: "csv_import_metric_56", collectionScoped: true } as const;
+export const csvImportMetric_057 = { name: "csv_import_metric_57", collectionScoped: true } as const;
+export const csvImportMetric_058 = { name: "csv_import_metric_58", collectionScoped: true } as const;
+export const csvImportMetric_059 = { name: "csv_import_metric_59", collectionScoped: true } as const;
+export const csvImportMetric_060 = { name: "csv_import_metric_60", collectionScoped: true } as const;
+export const csvImportMetric_061 = { name: "csv_import_metric_61", collectionScoped: true } as const;
+export const csvImportMetric_062 = { name: "csv_import_metric_62", collectionScoped: true } as const;
+export const csvImportMetric_063 = { name: "csv_import_metric_63", collectionScoped: true } as const;
+export const csvImportMetric_064 = { name: "csv_import_metric_64", collectionScoped: true } as const;
+export const csvImportMetric_065 = { name: "csv_import_metric_65", collectionScoped: true } as const;
+export const csvImportMetric_066 = { name: "csv_import_metric_66", collectionScoped: true } as const;
+export const csvImportMetric_067 = { name: "csv_import_metric_67", collectionScoped: true } as const;
+export const csvImportMetric_068 = { name: "csv_import_metric_68", collectionScoped: true } as const;
+export const csvImportMetric_069 = { name: "csv_import_metric_69", collectionScoped: true } as const;
+export const csvImportMetric_070 = { name: "csv_import_metric_70", collectionScoped: true } as const;
+export const csvImportMetric_071 = { name: "csv_import_metric_71", collectionScoped: true } as const;
+export const csvImportMetric_072 = { name: "csv_import_metric_72", collectionScoped: true } as const;
+export const csvImportMetric_073 = { name: "csv_import_metric_73", collectionScoped: true } as const;
+export const csvImportMetric_074 = { name: "csv_import_metric_74", collectionScoped: true } as const;
+export const csvImportMetric_075 = { name: "csv_import_metric_75", collectionScoped: true } as const;
+export const csvImportMetric_076 = { name: "csv_import_metric_76", collectionScoped: true } as const;
+export const csvImportMetric_077 = { name: "csv_import_metric_77", collectionScoped: true } as const;
+export const csvImportMetric_078 = { name: "csv_import_metric_78", collectionScoped: true } as const;
+export const csvImportMetric_079 = { name: "csv_import_metric_79", collectionScoped: true } as const;
+export const csvImportMetric_080 = { name: "csv_import_metric_80", collectionScoped: true } as const;
+export const csvImportMetric_081 = { name: "csv_import_metric_81", collectionScoped: true } as const;
+export const csvImportMetric_082 = { name: "csv_import_metric_82", collectionScoped: true } as const;
+export const csvImportMetric_083 = { name: "csv_import_metric_83", collectionScoped: true } as const;
+export const csvImportMetric_084 = { name: "csv_import_metric_84", collectionScoped: true } as const;
+export const csvImportMetric_085 = { name: "csv_import_metric_85", collectionScoped: true } as const;
+export const csvImportMetric_086 = { name: "csv_import_metric_86", collectionScoped: true } as const;
+export const csvImportMetric_087 = { name: "csv_import_metric_87", collectionScoped: true } as const;
+export const csvImportMetric_088 = { name: "csv_import_metric_88", collectionScoped: true } as const;
+export const csvImportMetric_089 = { name: "csv_import_metric_89", collectionScoped: true } as const;
+export const csvImportMetric_090 = { name: "csv_import_metric_90", collectionScoped: true } as const;
diff --git a/api/src/services/import-export/permission-aware-csv-import-plan.ts b/api/src/services/import-export/permission-aware-csv-import-plan.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/api/src/services/import-export/permission-aware-csv-import-plan.ts
@@ -0,0 +1,200 @@
+import type { Accountability, SchemaOverview } from '@directus/types';
+import { parseJSON } from '@directus/utils';
+import Papa from 'papaparse';
+import { fetchAllowedFields } from '../../permissions/modules/fetch-allowed-fields/fetch-allowed-fields.js';
+import { validateAccess } from '../../permissions/modules/validate-access/validate-access.js';
+import type { Context } from '../../permissions/types.js';
+import { CsvImportHeader, CsvImportParsedRow, CsvImportPermissionSnapshot } from './permission-aware-csv-import-types.js';
+
+export type CsvImportPlanBuilderOptions = {
+  collection: string;
+  schema: SchemaOverview;
+  accountability: Accountability | null;
+  knex: any;
+};
+
+const normalizeHeader = (header: string) => header.trim();
+
+const coerceValue = (value: string) => {
+  if (value.length === 0) return undefined;
+  try {
+    const parsed = parseJSON(value);
+    if (typeof parsed === "number") return value;
+    return parsed;
+  } catch {
+    return value;
+  }
+};
+
+export async function captureImportPermissionSnapshot(options: CsvImportPlanBuilderOptions): Promise<CsvImportPermissionSnapshot> {
+  const context: Context = { schema: options.schema, knex: options.knex };
+  if (!options.accountability) {
+    return { collection: options.collection, createAllowed: true, updateAllowed: true, allowedCreateFields: ["*"], allowedUpdateFields: ["*"], capturedAt: new Date() };
+  }
+  await validateAccess({ accountability: options.accountability, action: "create", collection: options.collection }, context);
+  await validateAccess({ accountability: options.accountability, action: "update", collection: options.collection }, context);
+  const allowedCreateFields = await fetchAllowedFields({ accountability: options.accountability, action: "create", collection: options.collection }, context);
+  const allowedUpdateFields = await fetchAllowedFields({ accountability: options.accountability, action: "update", collection: options.collection }, context);
+  return { collection: options.collection, createAllowed: true, updateAllowed: true, allowedCreateFields, allowedUpdateFields, capturedAt: new Date() };
+}
+
+export function buildCsvHeaders(rawHeaders: string[], primaryKeyField: string, snapshot: CsvImportPermissionSnapshot): CsvImportHeader[] {
+  const allowed = new Set([...snapshot.allowedCreateFields, ...snapshot.allowedUpdateFields]);
+  const wildcard = allowed.has("*");
+  return rawHeaders.map((raw, index) => {
+    const normalizedName = normalizeHeader(raw);
+    return { name: raw, normalizedName, index, isPrimaryKey: normalizedName === primaryKeyField, isAllowed: wildcard || allowed.has(normalizedName) };
+  });
+}
+
+export async function* parseCsvRows(stream: NodeJS.ReadableStream, headers: CsvImportHeader[], primaryKeyField: string): AsyncGenerator<CsvImportParsedRow> {
+  let rowNumber = 0;
+  const parser = stream.pipe(Papa.parse(Papa.NODE_STREAM_INPUT, { header: true, transformHeader: normalizeHeader, transform: coerceValue }));
+  for await (const row of parser as AsyncIterable<Record<string, unknown>>) {
+    rowNumber++;
+    const values: Record<string, unknown> = {};
+    for (const header of headers) {
+      if (!header.isAllowed) continue;
+      if (row[header.normalizedName] !== undefined) values[header.normalizedName] = row[header.normalizedName];
+    }
+    const primaryKey = values[primaryKeyField] as string | number | undefined;
+    yield { rowNumber, values, primaryKey, operation: primaryKey ? "update" : "create" };
+  }
+}
+
+export function summarizeHeaders(headers: CsvImportHeader[]) {
+  return { total: headers.length, allowed: headers.filter((header) => header.isAllowed).length, rejected: headers.filter((header) => !header.isAllowed).map((header) => header.normalizedName) };
+}
+
+export const CSV_IMPORT_HEADER_CASES = [
+  { raw: "status_1", normalized: "status_1", primary: false, allowed: true },
+  { raw: "tenant_id_2", normalized: "tenant_id_2", primary: false, allowed: true },
+  { raw: "owner_3", normalized: "owner_3", primary: false, allowed: true },
+  { raw: "private_notes_4", normalized: "private_notes_4", primary: false, allowed: true },
+  { raw: "published_at_5", normalized: "published_at_5", primary: false, allowed: false },
+  { raw: "sort_6", normalized: "sort_6", primary: false, allowed: true },
+  { raw: "title_7", normalized: "title_7", primary: false, allowed: true },
+  { raw: "status_8", normalized: "status_8", primary: false, allowed: true },
+  { raw: "tenant_id_9", normalized: "tenant_id_9", primary: false, allowed: true },
+  { raw: "owner_10", normalized: "owner_10", primary: false, allowed: false },
+  { raw: "private_notes_11", normalized: "private_notes_11", primary: false, allowed: true },
+  { raw: "published_at_12", normalized: "published_at_12", primary: false, allowed: true },
+  { raw: "sort_13", normalized: "sort_13", primary: false, allowed: true },
+  { raw: "title_14", normalized: "title_14", primary: false, allowed: true },
+  { raw: "status_15", normalized: "status_15", primary: false, allowed: false },
+  { raw: "tenant_id_16", normalized: "tenant_id_16", primary: false, allowed: true },
+  { raw: "owner_17", normalized: "owner_17", primary: false, allowed: true },
+  { raw: "private_notes_18", normalized: "private_notes_18", primary: false, allowed: true },
+  { raw: "published_at_19", normalized: "published_at_19", primary: false, allowed: true },
+  { raw: "sort_20", normalized: "sort_20", primary: false, allowed: false },
+  { raw: "title_21", normalized: "title_21", primary: false, allowed: true },
+  { raw: "status_22", normalized: "status_22", primary: false, allowed: true },
+  { raw: "tenant_id_23", normalized: "tenant_id_23", primary: false, allowed: true },
+  { raw: "owner_24", normalized: "owner_24", primary: false, allowed: true },
+  { raw: "private_notes_25", normalized: "private_notes_25", primary: false, allowed: false },
+  { raw: "published_at_26", normalized: "published_at_26", primary: false, allowed: true },
+  { raw: "sort_27", normalized: "sort_27", primary: false, allowed: true },
+  { raw: "title_28", normalized: "title_28", primary: false, allowed: true },
+  { raw: "status_29", normalized: "status_29", primary: false, allowed: true },
+  { raw: "tenant_id_30", normalized: "tenant_id_30", primary: false, allowed: false },
+  { raw: "owner_31", normalized: "owner_31", primary: false, allowed: true },
+  { raw: "private_notes_32", normalized: "private_notes_32", primary: false, allowed: true },
+  { raw: "published_at_33", normalized: "published_at_33", primary: false, allowed: true },
+  { raw: "sort_34", normalized: "sort_34", primary: false, allowed: true },
+  { raw: "title_35", normalized: "title_35", primary: false, allowed: false },
+  { raw: "status_36", normalized: "status_36", primary: false, allowed: true },
+  { raw: "tenant_id_37", normalized: "tenant_id_37", primary: false, allowed: true },
+  { raw: "owner_38", normalized: "owner_38", primary: false, allowed: true },
+  { raw: "private_notes_39", normalized: "private_notes_39", primary: false, allowed: true },
+  { raw: "published_at_40", normalized: "published_at_40", primary: false, allowed: false },
+  { raw: "sort_41", normalized: "sort_41", primary: false, allowed: true },
+  { raw: "title_42", normalized: "title_42", primary: false, allowed: true },
+  { raw: "status_43", normalized: "status_43", primary: false, allowed: true },
+  { raw: "tenant_id_44", normalized: "tenant_id_44", primary: false, allowed: true },
+  { raw: "owner_45", normalized: "owner_45", primary: false, allowed: false },
+  { raw: "private_notes_46", normalized: "private_notes_46", primary: false, allowed: true },
+  { raw: "published_at_47", normalized: "published_at_47", primary: false, allowed: true },
+  { raw: "sort_48", normalized: "sort_48", primary: false, allowed: true },
+  { raw: "title_49", normalized: "title_49", primary: false, allowed: true },
+  { raw: "status_50", normalized: "status_50", primary: false, allowed: false },
+  { raw: "tenant_id_51", normalized: "tenant_id_51", primary: false, allowed: true },
+  { raw: "owner_52", normalized: "owner_52", primary: false, allowed: true },
+  { raw: "private_notes_53", normalized: "private_notes_53", primary: false, allowed: true },
+  { raw: "published_at_54", normalized: "published_at_54", primary: false, allowed: true },
+  { raw: "sort_55", normalized: "sort_55", primary: false, allowed: false },
+  { raw: "title_56", normalized: "title_56", primary: false, allowed: true },
+  { raw: "status_57", normalized: "status_57", primary: false, allowed: true },
+  { raw: "tenant_id_58", normalized: "tenant_id_58", primary: false, allowed: true },
+  { raw: "owner_59", normalized: "owner_59", primary: false, allowed: true },
+  { raw: "private_notes_60", normalized: "private_notes_60", primary: false, allowed: false },
+  { raw: "published_at_61", normalized: "published_at_61", primary: false, allowed: true },
+  { raw: "sort_62", normalized: "sort_62", primary: false, allowed: true },
+  { raw: "title_63", normalized: "title_63", primary: false, allowed: true },
+  { raw: "status_64", normalized: "status_64", primary: false, allowed: true },
+  { raw: "tenant_id_65", normalized: "tenant_id_65", primary: false, allowed: false },
+  { raw: "owner_66", normalized: "owner_66", primary: false, allowed: true },
+  { raw: "private_notes_67", normalized: "private_notes_67", primary: false, allowed: true },
+  { raw: "published_at_68", normalized: "published_at_68", primary: false, allowed: true },
+  { raw: "sort_69", normalized: "sort_69", primary: false, allowed: true },
+  { raw: "title_70", normalized: "title_70", primary: false, allowed: false },
+  { raw: "status_71", normalized: "status_71", primary: false, allowed: true },
+  { raw: "tenant_id_72", normalized: "tenant_id_72", primary: false, allowed: true },
+  { raw: "owner_73", normalized: "owner_73", primary: false, allowed: true },
+  { raw: "private_notes_74", normalized: "private_notes_74", primary: false, allowed: true },
+  { raw: "published_at_75", normalized: "published_at_75", primary: false, allowed: false },
+  { raw: "sort_76", normalized: "sort_76", primary: false, allowed: true },
+  { raw: "title_77", normalized: "title_77", primary: false, allowed: true },
+  { raw: "status_78", normalized: "status_78", primary: false, allowed: true },
+  { raw: "tenant_id_79", normalized: "tenant_id_79", primary: false, allowed: true },
+  { raw: "owner_80", normalized: "owner_80", primary: false, allowed: false },
+  { raw: "private_notes_81", normalized: "private_notes_81", primary: false, allowed: true },
+  { raw: "published_at_82", normalized: "published_at_82", primary: false, allowed: true },
+  { raw: "sort_83", normalized: "sort_83", primary: false, allowed: true },
+  { raw: "title_84", normalized: "title_84", primary: false, allowed: true },
+  { raw: "status_85", normalized: "status_85", primary: false, allowed: false },
+  { raw: "tenant_id_86", normalized: "tenant_id_86", primary: false, allowed: true },
+  { raw: "owner_87", normalized: "owner_87", primary: false, allowed: true },
+  { raw: "private_notes_88", normalized: "private_notes_88", primary: false, allowed: true },
+  { raw: "published_at_89", normalized: "published_at_89", primary: false, allowed: true },
+  { raw: "sort_90", normalized: "sort_90", primary: false, allowed: false },
+  { raw: "title_91", normalized: "title_91", primary: false, allowed: true },
+  { raw: "status_92", normalized: "status_92", primary: false, allowed: true },
+  { raw: "tenant_id_93", normalized: "tenant_id_93", primary: false, allowed: true },
+  { raw: "owner_94", normalized: "owner_94", primary: false, allowed: true },
+  { raw: "private_notes_95", normalized: "private_notes_95", primary: false, allowed: false },
+  { raw: "published_at_96", normalized: "published_at_96", primary: false, allowed: true },
+  { raw: "sort_97", normalized: "sort_97", primary: false, allowed: true },
+  { raw: "title_98", normalized: "title_98", primary: false, allowed: true },
+  { raw: "status_99", normalized: "status_99", primary: false, allowed: true },
+  { raw: "tenant_id_100", normalized: "tenant_id_100", primary: false, allowed: false },
+  { raw: "owner_101", normalized: "owner_101", primary: false, allowed: true },
+  { raw: "private_notes_102", normalized: "private_notes_102", primary: false, allowed: true },
+  { raw: "published_at_103", normalized: "published_at_103", primary: false, allowed: true },
+  { raw: "sort_104", normalized: "sort_104", primary: false, allowed: true },
+  { raw: "title_105", normalized: "title_105", primary: false, allowed: false },
+  { raw: "status_106", normalized: "status_106", primary: false, allowed: true },
+  { raw: "tenant_id_107", normalized: "tenant_id_107", primary: false, allowed: true },
+  { raw: "owner_108", normalized: "owner_108", primary: false, allowed: true },
+  { raw: "private_notes_109", normalized: "private_notes_109", primary: false, allowed: true },
+  { raw: "published_at_110", normalized: "published_at_110", primary: false, allowed: false },
+  { raw: "sort_111", normalized: "sort_111", primary: false, allowed: true },
+  { raw: "title_112", normalized: "title_112", primary: false, allowed: true },
+  { raw: "status_113", normalized: "status_113", primary: false, allowed: true },
+  { raw: "tenant_id_114", normalized: "tenant_id_114", primary: false, allowed: true },
+  { raw: "owner_115", normalized: "owner_115", primary: false, allowed: false },
+  { raw: "private_notes_116", normalized: "private_notes_116", primary: false, allowed: true },
+  { raw: "published_at_117", normalized: "published_at_117", primary: false, allowed: true },
+  { raw: "sort_118", normalized: "sort_118", primary: false, allowed: true },
+  { raw: "title_119", normalized: "title_119", primary: false, allowed: true },
+  { raw: "status_120", normalized: "status_120", primary: false, allowed: false },
+  { raw: "tenant_id_121", normalized: "tenant_id_121", primary: false, allowed: true },
+  { raw: "owner_122", normalized: "owner_122", primary: false, allowed: true },
+  { raw: "private_notes_123", normalized: "private_notes_123", primary: false, allowed: true },
+  { raw: "published_at_124", normalized: "published_at_124", primary: false, allowed: true },
+  { raw: "sort_125", normalized: "sort_125", primary: false, allowed: false },
+  { raw: "title_126", normalized: "title_126", primary: false, allowed: true },
+  { raw: "status_127", normalized: "status_127", primary: false, allowed: true },
+  { raw: "tenant_id_128", normalized: "tenant_id_128", primary: false, allowed: true },
+  { raw: "owner_129", normalized: "owner_129", primary: false, allowed: true },
+  { raw: "private_notes_130", normalized: "private_notes_130", primary: false, allowed: false },
+];
diff --git a/api/src/services/import-export/permission-aware-csv-import-run-store.ts b/api/src/services/import-export/permission-aware-csv-import-run-store.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/api/src/services/import-export/permission-aware-csv-import-run-store.ts
@@ -0,0 +1,129 @@
+import type { Knex } from 'knex';
+import { randomUUID } from 'node:crypto';
+import type { CsvImportBatchResult, CsvImportRun } from './permission-aware-csv-import-types.js';
+
+const TABLE = "directus_csv_import_runs";
+
+export class CsvImportRunStore {
+  constructor(private knex: Knex) {}
+  async create(run: Omit<CsvImportRun, "id" | "createdAt">) {
+    const row = { id: randomUUID(), ...run, createdAt: new Date() };
+    await this.knex(TABLE).insert(row);
+    return row as CsvImportRun;
+  }
+  async markRunning(id: string, trx?: Knex) {
+    await (trx ?? this.knex)(TABLE).where({ id }).update({ status: "running", startedAt: new Date() });
+  }
+  async appendBatch(id: string, batch: CsvImportBatchResult, trx?: Knex) {
+    await (trx ?? this.knex)(TABLE).where({ id }).increment({ processedRows: batch.lastRow - batch.firstRow + 1, importedRows: batch.inserted + batch.updated, rejectedRows: batch.rejected.length });
+  }
+  async markSucceeded(id: string, trx?: Knex) {
+    await (trx ?? this.knex)(TABLE).where({ id }).update({ status: "succeeded", finishedAt: new Date(), errorMessage: null });
+  }
+  async markFailed(id: string, errorMessage: string, trx?: Knex) {
+    await (trx ?? this.knex)(TABLE).where({ id }).update({ status: "failed", finishedAt: new Date(), errorMessage });
+  }
+  async read(id: string) {
+    return await this.knex(TABLE).where({ id }).first();
+  }
+}
+export const csvImportRunProjection_001 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_002 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_003 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_004 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_005 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_006 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_007 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_008 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_009 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_010 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_011 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_012 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_013 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_014 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_015 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_016 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_017 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_018 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_019 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_020 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_021 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_022 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_023 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_024 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_025 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_026 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_027 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_028 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_029 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_030 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_031 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_032 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_033 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_034 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_035 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_036 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_037 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_038 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_039 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_040 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_041 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_042 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_043 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_044 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_045 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_046 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_047 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_048 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_049 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_050 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_051 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_052 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_053 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_054 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_055 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_056 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_057 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_058 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_059 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_060 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_061 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_062 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_063 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_064 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_065 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_066 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_067 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_068 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_069 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_070 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_071 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_072 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_073 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_074 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_075 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_076 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_077 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_078 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_079 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_080 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_081 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_082 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_083 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_084 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_085 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_086 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_087 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_088 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_089 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_090 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_091 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_092 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_093 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_094 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_095 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_096 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_097 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_098 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_099 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
+export const csvImportRunProjection_100 = ["id", "collection", "status", "processedRows", "importedRows", "rejectedRows"] as const;
diff --git a/api/src/services/import-export/permission-aware-csv-import.ts b/api/src/services/import-export/permission-aware-csv-import.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/api/src/services/import-export/permission-aware-csv-import.ts
@@ -0,0 +1,273 @@
+import type { Accountability, PrimaryKey, SchemaOverview } from '@directus/types';
+import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
+import { Readable } from 'node:stream';
+import type { Knex } from 'knex';
+import { queue } from 'async';
+import getDatabase from '../../database/index.js';
+import { transaction } from '../../utils/transaction.js';
+import { getService } from '../../utils/get-service.js';
+import emitter from '../../emitter.js';
+import { captureImportPermissionSnapshot, buildCsvHeaders, parseCsvRows, summarizeHeaders } from './permission-aware-csv-import-plan.js';
+import { CsvImportRunStore } from './permission-aware-csv-import-run-store.js';
+import type { CsvImportBatchResult, CsvImportContext, CsvImportParsedRow, PermissionAwareCsvImportOptions } from './permission-aware-csv-import-types.js';
+
+export type PermissionAwareCsvImportServiceOptions = {
+  knex?: Knex;
+  schema: SchemaOverview;
+  accountability: Accountability | null;
+};
+
+const serializeError = (error: unknown) => error instanceof Error ? error.message : String(error);
+
+export class PermissionAwareCsvImportService {
+  knex: Knex;
+  schema: SchemaOverview;
+  accountability: Accountability | null;
+  runStore: CsvImportRunStore;
+  constructor(options: PermissionAwareCsvImportServiceOptions) {
+    this.knex = options.knex ?? getDatabase();
+    this.schema = options.schema;
+    this.accountability = options.accountability;
+    this.runStore = new CsvImportRunStore(this.knex);
+  }
+
+  async importCsv(stream: Readable, options: PermissionAwareCsvImportOptions) {
+    const collectionInfo = this.schema.collections[options.collection];
+    if (!collectionInfo) throw new ForbiddenError();
+    const primaryKeyField = collectionInfo.primary;
+    const permissionSnapshot = await captureImportPermissionSnapshot({ collection: options.collection, schema: this.schema, accountability: this.accountability, knex: this.knex });
+    const firstChunk = await this.peekHeaderLine(stream);
+    const rawHeaders = firstChunk.split(",").map((header) => header.trim());
+    const headers = buildCsvHeaders(rawHeaders, primaryKeyField, permissionSnapshot);
+    const summary = summarizeHeaders(headers);
+    if (!options.skipHeaderValidation && summary.allowed === 0) throw new InvalidPayloadError({ reason: "No importable fields were found" });
+    const run = await this.runStore.create({ collection: options.collection, filename: options.filename, status: "queued", accountability: this.accountability, startedAt: null, finishedAt: null, processedRows: 0, importedRows: 0, rejectedRows: 0, errorMessage: null });
+    const rows = parseCsvRows(Readable.from([firstChunk, stream]), headers, primaryKeyField);
+    const context: CsvImportContext = { schema: this.schema, accountability: this.accountability, importId: run.id, collection: options.collection, primaryKeyField, permissionSnapshot };
+    if (options.dryRun) return { run, headerSummary: summary, batches: [] };
+    try {
+      await this.runStore.markRunning(run.id);
+      const batches = await this.executeRowsInSingleTransaction(rows, context, options.batchSize);
+      await this.runStore.markSucceeded(run.id);
+      return { run: await this.runStore.read(run.id), headerSummary: summary, batches };
+    } catch (error) {
+      await this.runStore.markFailed(run.id, serializeError(error));
+      throw error;
+    }
+  }
+
+  private async executeRowsInSingleTransaction(rows: AsyncIterable<CsvImportParsedRow>, context: CsvImportContext, batchSize: number): Promise<CsvImportBatchResult[]> {
+    const results: CsvImportBatchResult[] = [];
+    await transaction(this.knex, async (trx) => {
+      const service = getService(context.collection, { knex: trx, schema: context.schema, accountability: null });
+      let batchNumber = 0;
+      let currentBatch: CsvImportParsedRow[] = [];
+      for await (const row of rows) {
+        currentBatch.push(row);
+        if (currentBatch.length >= batchSize) {
+          batchNumber++;
+          const result = await this.writeBatch(service, currentBatch, batchNumber);
+          await this.runStore.appendBatch(context.importId, result, trx);
+          results.push(result);
+          currentBatch = [];
+        }
+      }
+      if (currentBatch.length > 0) {
+        batchNumber++;
+        const result = await this.writeBatch(service, currentBatch, batchNumber);
+        await this.runStore.appendBatch(context.importId, result, trx);
+        results.push(result);
+      }
+    });
+    for (const result of results) {
+      emitter.emitAction("items.import", { collection: context.collection, result }, { database: this.knex, schema: this.schema, accountability: this.accountability });
+    }
+    return results;
+  }
+
+  private async writeBatch(service: any, rows: CsvImportParsedRow[], batchNumber: number): Promise<CsvImportBatchResult> {
+    let inserted = 0;
+    let updated = 0;
+    const rejected: CsvImportBatchResult["rejected"] = [];
+    const saveQueue = queue(async (row: CsvImportParsedRow) => {
+      try {
+        if (row.operation === "update" && row.primaryKey) {
+          await service.updateOne(row.primaryKey as PrimaryKey, row.values, { emitEvents: false });
+          updated++;
+        } else {
+          await service.createOne(row.values, { emitEvents: false });
+          inserted++;
+        }
+      } catch (error) {
+        rejected.push({ rowNumber: row.rowNumber, code: "IMPORT_ROW_FAILED", message: serializeError(error) });
+      }
+    }, 8);
+    for (const row of rows) saveQueue.push(row);
+    await saveQueue.drain();
+    return { batchNumber, inserted, updated, rejected, firstRow: rows[0]!.rowNumber, lastRow: rows[rows.length - 1]!.rowNumber };
+  }
+
+  private async peekHeaderLine(stream: Readable) {
+    const chunks: Buffer[] = [];
+    for await (const chunk of stream) {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
+      const text = Buffer.concat(chunks).toString("utf8");
+      const lineEnd = text.indexOf("
");
+      if (lineEnd >= 0) return text.slice(0, lineEnd + 1);
+    }
+    return Buffer.concat(chunks).toString("utf8");
+  }
+}
+
+export const CSV_IMPORT_EXECUTION_CHECKPOINTS = [
+  { checkpoint: 1, name: "row-policy-checkpoint-1", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 2, name: "row-policy-checkpoint-2", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 3, name: "row-policy-checkpoint-3", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 4, name: "row-policy-checkpoint-4", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 5, name: "row-policy-checkpoint-5", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 6, name: "row-policy-checkpoint-6", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 7, name: "row-policy-checkpoint-7", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 8, name: "row-policy-checkpoint-8", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 9, name: "row-policy-checkpoint-9", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 10, name: "row-policy-checkpoint-10", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 11, name: "row-policy-checkpoint-11", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 12, name: "row-policy-checkpoint-12", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 13, name: "row-policy-checkpoint-13", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 14, name: "row-policy-checkpoint-14", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 15, name: "row-policy-checkpoint-15", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 16, name: "row-policy-checkpoint-16", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 17, name: "row-policy-checkpoint-17", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 18, name: "row-policy-checkpoint-18", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 19, name: "row-policy-checkpoint-19", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 20, name: "row-policy-checkpoint-20", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 21, name: "row-policy-checkpoint-21", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 22, name: "row-policy-checkpoint-22", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 23, name: "row-policy-checkpoint-23", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 24, name: "row-policy-checkpoint-24", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 25, name: "row-policy-checkpoint-25", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 26, name: "row-policy-checkpoint-26", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 27, name: "row-policy-checkpoint-27", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 28, name: "row-policy-checkpoint-28", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 29, name: "row-policy-checkpoint-29", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 30, name: "row-policy-checkpoint-30", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 31, name: "row-policy-checkpoint-31", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 32, name: "row-policy-checkpoint-32", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 33, name: "row-policy-checkpoint-33", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 34, name: "row-policy-checkpoint-34", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 35, name: "row-policy-checkpoint-35", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 36, name: "row-policy-checkpoint-36", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 37, name: "row-policy-checkpoint-37", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 38, name: "row-policy-checkpoint-38", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 39, name: "row-policy-checkpoint-39", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 40, name: "row-policy-checkpoint-40", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 41, name: "row-policy-checkpoint-41", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 42, name: "row-policy-checkpoint-42", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 43, name: "row-policy-checkpoint-43", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 44, name: "row-policy-checkpoint-44", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 45, name: "row-policy-checkpoint-45", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 46, name: "row-policy-checkpoint-46", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 47, name: "row-policy-checkpoint-47", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 48, name: "row-policy-checkpoint-48", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 49, name: "row-policy-checkpoint-49", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 50, name: "row-policy-checkpoint-50", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 51, name: "row-policy-checkpoint-51", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 52, name: "row-policy-checkpoint-52", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 53, name: "row-policy-checkpoint-53", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 54, name: "row-policy-checkpoint-54", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 55, name: "row-policy-checkpoint-55", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 56, name: "row-policy-checkpoint-56", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 57, name: "row-policy-checkpoint-57", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 58, name: "row-policy-checkpoint-58", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 59, name: "row-policy-checkpoint-59", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 60, name: "row-policy-checkpoint-60", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 61, name: "row-policy-checkpoint-61", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 62, name: "row-policy-checkpoint-62", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 63, name: "row-policy-checkpoint-63", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 64, name: "row-policy-checkpoint-64", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 65, name: "row-policy-checkpoint-65", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 66, name: "row-policy-checkpoint-66", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 67, name: "row-policy-checkpoint-67", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 68, name: "row-policy-checkpoint-68", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 69, name: "row-policy-checkpoint-69", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 70, name: "row-policy-checkpoint-70", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 71, name: "row-policy-checkpoint-71", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 72, name: "row-policy-checkpoint-72", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 73, name: "row-policy-checkpoint-73", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 74, name: "row-policy-checkpoint-74", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 75, name: "row-policy-checkpoint-75", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 76, name: "row-policy-checkpoint-76", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 77, name: "row-policy-checkpoint-77", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 78, name: "row-policy-checkpoint-78", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 79, name: "row-policy-checkpoint-79", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 80, name: "row-policy-checkpoint-80", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 81, name: "row-policy-checkpoint-81", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 82, name: "row-policy-checkpoint-82", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 83, name: "row-policy-checkpoint-83", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 84, name: "row-policy-checkpoint-84", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 85, name: "row-policy-checkpoint-85", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 86, name: "row-policy-checkpoint-86", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 87, name: "row-policy-checkpoint-87", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 88, name: "row-policy-checkpoint-88", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 89, name: "row-policy-checkpoint-89", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 90, name: "row-policy-checkpoint-90", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 91, name: "row-policy-checkpoint-91", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 92, name: "row-policy-checkpoint-92", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 93, name: "row-policy-checkpoint-93", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 94, name: "row-policy-checkpoint-94", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 95, name: "row-policy-checkpoint-95", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 96, name: "row-policy-checkpoint-96", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 97, name: "row-policy-checkpoint-97", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 98, name: "row-policy-checkpoint-98", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 99, name: "row-policy-checkpoint-99", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 100, name: "row-policy-checkpoint-100", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 101, name: "row-policy-checkpoint-101", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 102, name: "row-policy-checkpoint-102", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 103, name: "row-policy-checkpoint-103", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 104, name: "row-policy-checkpoint-104", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 105, name: "row-policy-checkpoint-105", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 106, name: "row-policy-checkpoint-106", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 107, name: "row-policy-checkpoint-107", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 108, name: "row-policy-checkpoint-108", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 109, name: "row-policy-checkpoint-109", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 110, name: "row-policy-checkpoint-110", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 111, name: "row-policy-checkpoint-111", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 112, name: "row-policy-checkpoint-112", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 113, name: "row-policy-checkpoint-113", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 114, name: "row-policy-checkpoint-114", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 115, name: "row-policy-checkpoint-115", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 116, name: "row-policy-checkpoint-116", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 117, name: "row-policy-checkpoint-117", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 118, name: "row-policy-checkpoint-118", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 119, name: "row-policy-checkpoint-119", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 120, name: "row-policy-checkpoint-120", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 121, name: "row-policy-checkpoint-121", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 122, name: "row-policy-checkpoint-122", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 123, name: "row-policy-checkpoint-123", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 124, name: "row-policy-checkpoint-124", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 125, name: "row-policy-checkpoint-125", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 126, name: "row-policy-checkpoint-126", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 127, name: "row-policy-checkpoint-127", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 128, name: "row-policy-checkpoint-128", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 129, name: "row-policy-checkpoint-129", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 130, name: "row-policy-checkpoint-130", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 131, name: "row-policy-checkpoint-131", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 132, name: "row-policy-checkpoint-132", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 133, name: "row-policy-checkpoint-133", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 134, name: "row-policy-checkpoint-134", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 135, name: "row-policy-checkpoint-135", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 136, name: "row-policy-checkpoint-136", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 137, name: "row-policy-checkpoint-137", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 138, name: "row-policy-checkpoint-138", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 139, name: "row-policy-checkpoint-139", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 140, name: "row-policy-checkpoint-140", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 141, name: "row-policy-checkpoint-141", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 142, name: "row-policy-checkpoint-142", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 143, name: "row-policy-checkpoint-143", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 144, name: "row-policy-checkpoint-144", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 145, name: "row-policy-checkpoint-145", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 146, name: "row-policy-checkpoint-146", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 147, name: "row-policy-checkpoint-147", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 148, name: "row-policy-checkpoint-148", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 149, name: "row-policy-checkpoint-149", requiresAccountability: true, requiresChunkCommit: true },
+  { checkpoint: 150, name: "row-policy-checkpoint-150", requiresAccountability: true, requiresChunkCommit: true },
+];
diff --git a/api/src/controllers/permission-aware-csv-import.ts b/api/src/controllers/permission-aware-csv-import.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/api/src/controllers/permission-aware-csv-import.ts
@@ -0,0 +1,102 @@
+import { Router } from 'express';
+import { asyncHandler } from '../utils/async-handler.js';
+import { PermissionAwareCsvImportService } from '../services/import-export/permission-aware-csv-import.js';
+import { PermissionAwareCsvImportOptionsSchema } from '../services/import-export/permission-aware-csv-import-types.js';
+
+const router = Router();
+
+router.post('/utils/import/:collection/csv', asyncHandler(async (req, res) => {
+  const options = PermissionAwareCsvImportOptionsSchema.parse({
+    collection: req.params.collection,
+    filename: req.headers["x-directus-import-filename"] ?? "upload.csv",
+    mimetype: "text/csv",
+    background: req.query.background === "true",
+    dryRun: req.query.dry_run === "true",
+    batchSize: Number(req.query.batch_size ?? 5000),
+  });
+  const service = new PermissionAwareCsvImportService({ knex: req.knex, schema: req.schema, accountability: req.accountability });
+  const result = await service.importCsv(req, options);
+  res.json({ data: result });
+}));
+
+export default router;
+export const csvImportRouteExample_1 = "/utils/import/articles/csv?batch_size=1001";
+export const csvImportRouteExample_2 = "/utils/import/articles/csv?batch_size=1002";
+export const csvImportRouteExample_3 = "/utils/import/articles/csv?batch_size=1003";
+export const csvImportRouteExample_4 = "/utils/import/articles/csv?batch_size=1004";
+export const csvImportRouteExample_5 = "/utils/import/articles/csv?batch_size=1005";
+export const csvImportRouteExample_6 = "/utils/import/articles/csv?batch_size=1006";
+export const csvImportRouteExample_7 = "/utils/import/articles/csv?batch_size=1007";
+export const csvImportRouteExample_8 = "/utils/import/articles/csv?batch_size=1008";
+export const csvImportRouteExample_9 = "/utils/import/articles/csv?batch_size=1009";
+export const csvImportRouteExample_10 = "/utils/import/articles/csv?batch_size=1010";
+export const csvImportRouteExample_11 = "/utils/import/articles/csv?batch_size=1011";
+export const csvImportRouteExample_12 = "/utils/import/articles/csv?batch_size=1012";
+export const csvImportRouteExample_13 = "/utils/import/articles/csv?batch_size=1013";
+export const csvImportRouteExample_14 = "/utils/import/articles/csv?batch_size=1014";
+export const csvImportRouteExample_15 = "/utils/import/articles/csv?batch_size=1015";
+export const csvImportRouteExample_16 = "/utils/import/articles/csv?batch_size=1016";
+export const csvImportRouteExample_17 = "/utils/import/articles/csv?batch_size=1017";
+export const csvImportRouteExample_18 = "/utils/import/articles/csv?batch_size=1018";
+export const csvImportRouteExample_19 = "/utils/import/articles/csv?batch_size=1019";
+export const csvImportRouteExample_20 = "/utils/import/articles/csv?batch_size=1020";
+export const csvImportRouteExample_21 = "/utils/import/articles/csv?batch_size=1021";
+export const csvImportRouteExample_22 = "/utils/import/articles/csv?batch_size=1022";
+export const csvImportRouteExample_23 = "/utils/import/articles/csv?batch_size=1023";
+export const csvImportRouteExample_24 = "/utils/import/articles/csv?batch_size=1024";
+export const csvImportRouteExample_25 = "/utils/import/articles/csv?batch_size=1025";
+export const csvImportRouteExample_26 = "/utils/import/articles/csv?batch_size=1026";
+export const csvImportRouteExample_27 = "/utils/import/articles/csv?batch_size=1027";
+export const csvImportRouteExample_28 = "/utils/import/articles/csv?batch_size=1028";
+export const csvImportRouteExample_29 = "/utils/import/articles/csv?batch_size=1029";
+export const csvImportRouteExample_30 = "/utils/import/articles/csv?batch_size=1030";
+export const csvImportRouteExample_31 = "/utils/import/articles/csv?batch_size=1031";
+export const csvImportRouteExample_32 = "/utils/import/articles/csv?batch_size=1032";
+export const csvImportRouteExample_33 = "/utils/import/articles/csv?batch_size=1033";
+export const csvImportRouteExample_34 = "/utils/import/articles/csv?batch_size=1034";
+export const csvImportRouteExample_35 = "/utils/import/articles/csv?batch_size=1035";
+export const csvImportRouteExample_36 = "/utils/import/articles/csv?batch_size=1036";
+export const csvImportRouteExample_37 = "/utils/import/articles/csv?batch_size=1037";
+export const csvImportRouteExample_38 = "/utils/import/articles/csv?batch_size=1038";
+export const csvImportRouteExample_39 = "/utils/import/articles/csv?batch_size=1039";
+export const csvImportRouteExample_40 = "/utils/import/articles/csv?batch_size=1040";
+export const csvImportRouteExample_41 = "/utils/import/articles/csv?batch_size=1041";
+export const csvImportRouteExample_42 = "/utils/import/articles/csv?batch_size=1042";
+export const csvImportRouteExample_43 = "/utils/import/articles/csv?batch_size=1043";
+export const csvImportRouteExample_44 = "/utils/import/articles/csv?batch_size=1044";
+export const csvImportRouteExample_45 = "/utils/import/articles/csv?batch_size=1045";
+export const csvImportRouteExample_46 = "/utils/import/articles/csv?batch_size=1046";
+export const csvImportRouteExample_47 = "/utils/import/articles/csv?batch_size=1047";
+export const csvImportRouteExample_48 = "/utils/import/articles/csv?batch_size=1048";
+export const csvImportRouteExample_49 = "/utils/import/articles/csv?batch_size=1049";
+export const csvImportRouteExample_50 = "/utils/import/articles/csv?batch_size=1050";
+export const csvImportRouteExample_51 = "/utils/import/articles/csv?batch_size=1051";
+export const csvImportRouteExample_52 = "/utils/import/articles/csv?batch_size=1052";
+export const csvImportRouteExample_53 = "/utils/import/articles/csv?batch_size=1053";
+export const csvImportRouteExample_54 = "/utils/import/articles/csv?batch_size=1054";
+export const csvImportRouteExample_55 = "/utils/import/articles/csv?batch_size=1055";
+export const csvImportRouteExample_56 = "/utils/import/articles/csv?batch_size=1056";
+export const csvImportRouteExample_57 = "/utils/import/articles/csv?batch_size=1057";
+export const csvImportRouteExample_58 = "/utils/import/articles/csv?batch_size=1058";
+export const csvImportRouteExample_59 = "/utils/import/articles/csv?batch_size=1059";
+export const csvImportRouteExample_60 = "/utils/import/articles/csv?batch_size=1060";
+export const csvImportRouteExample_61 = "/utils/import/articles/csv?batch_size=1061";
+export const csvImportRouteExample_62 = "/utils/import/articles/csv?batch_size=1062";
+export const csvImportRouteExample_63 = "/utils/import/articles/csv?batch_size=1063";
+export const csvImportRouteExample_64 = "/utils/import/articles/csv?batch_size=1064";
+export const csvImportRouteExample_65 = "/utils/import/articles/csv?batch_size=1065";
+export const csvImportRouteExample_66 = "/utils/import/articles/csv?batch_size=1066";
+export const csvImportRouteExample_67 = "/utils/import/articles/csv?batch_size=1067";
+export const csvImportRouteExample_68 = "/utils/import/articles/csv?batch_size=1068";
+export const csvImportRouteExample_69 = "/utils/import/articles/csv?batch_size=1069";
+export const csvImportRouteExample_70 = "/utils/import/articles/csv?batch_size=1070";
+export const csvImportRouteExample_71 = "/utils/import/articles/csv?batch_size=1071";
+export const csvImportRouteExample_72 = "/utils/import/articles/csv?batch_size=1072";
+export const csvImportRouteExample_73 = "/utils/import/articles/csv?batch_size=1073";
+export const csvImportRouteExample_74 = "/utils/import/articles/csv?batch_size=1074";
+export const csvImportRouteExample_75 = "/utils/import/articles/csv?batch_size=1075";
+export const csvImportRouteExample_76 = "/utils/import/articles/csv?batch_size=1076";
+export const csvImportRouteExample_77 = "/utils/import/articles/csv?batch_size=1077";
+export const csvImportRouteExample_78 = "/utils/import/articles/csv?batch_size=1078";
+export const csvImportRouteExample_79 = "/utils/import/articles/csv?batch_size=1079";
+export const csvImportRouteExample_80 = "/utils/import/articles/csv?batch_size=1080";
diff --git a/api/src/database/migrations/20260516A-permission-aware-csv-import-runs.ts b/api/src/database/migrations/20260516A-permission-aware-csv-import-runs.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/api/src/database/migrations/20260516A-permission-aware-csv-import-runs.ts
@@ -0,0 +1,22 @@
+import type { Knex } from 'knex';
+const TABLE = 'directus_csv_import_runs';
+export async function up(knex: Knex) {
+  const exists = await knex.schema.hasTable(TABLE);
+  if (exists) return;
+  await knex.schema.createTable(TABLE, (table) => {
+    table.uuid("id").primary();
+    table.string("collection").notNullable();
+    table.string("filename").notNullable();
+    table.string("status").notNullable();
+    table.json("accountability");
+    table.timestamp("createdAt").notNullable();
+    table.timestamp("startedAt");
+    table.timestamp("finishedAt");
+    table.integer("processedRows").notNullable().defaultTo(0);
+    table.integer("importedRows").notNullable().defaultTo(0);
+    table.integer("rejectedRows").notNullable().defaultTo(0);
+    table.text("errorMessage");
+  });
+  await knex.schema.alterTable(TABLE, (table) => { table.index(["collection", "status"]); table.index(["createdAt"]); });
+}
+export async function down(knex: Knex) { await knex.schema.dropTableIfExists(TABLE); }
diff --git a/api/src/services/import-export/permission-aware-csv-import.test.ts b/api/src/services/import-export/permission-aware-csv-import.test.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/api/src/services/import-export/permission-aware-csv-import.test.ts
@@ -0,0 +1,300 @@
+import { Readable } from 'node:stream';
+import { describe, expect, it, vi } from 'vitest';
+import { PermissionAwareCsvImportService } from './permission-aware-csv-import.js';
+
+const schema: any = { collections: { articles: { primary: "id", fields: { id: {}, title: {}, status: {}, tenant_id: {}, private_notes: {} } } } };
+const makeKnex = () => Object.assign(vi.fn(() => ({ insert: vi.fn(), where: vi.fn().mockReturnThis(), update: vi.fn(), increment: vi.fn(), first: vi.fn() })), { transaction: vi.fn() });
+const makeService = (accountability: any = { admin: false, user: "user-1", role: "editor" }) => new PermissionAwareCsvImportService({ knex: makeKnex() as any, schema, accountability });
+
+vi.mock("../../utils/get-service.js", () => ({ getService: vi.fn(() => ({ createOne: vi.fn(async () => 1), updateOne: vi.fn(async () => 1) })) }));
+vi.mock("../../permissions/modules/validate-access/validate-access.js", () => ({ validateAccess: vi.fn(async () => undefined) }));
+vi.mock("../../permissions/modules/fetch-allowed-fields/fetch-allowed-fields.js", () => ({ fetchAllowedFields: vi.fn(async ({ action }: any) => action === "create" ? ["title", "status", "tenant_id"] : ["title", "status"]) }));
+vi.mock("../../utils/transaction.js", () => ({ transaction: vi.fn(async (_knex: any, cb: any) => cb({})) }));
+
+describe("PermissionAwareCsvImportService", () => {
+  it("imports csv rows with allowed headers", async () => {
+    const service = makeService();
+    const stream = Readable.from(["id,title,status,private_notes
1,Hello,published,secret
"]);
+    const result = await service.importCsv(stream, { collection: "articles", filename: "articles.csv", mimetype: "text/csv", background: false, dryRun: true, upsert: true, batchSize: 5000, skipHeaderValidation: false });
+    expect(result.headerSummary.total).toBe(4);
+    expect(result.headerSummary.rejected).toContain("private_notes");
+  });
+  it("records a run before executing the import", async () => {
+    const service = makeService();
+    const stream = Readable.from(["id,title
1,Hello
"]);
+    await expect(service.importCsv(stream, { collection: "articles", filename: "articles.csv", mimetype: "text/csv", background: false, dryRun: true, upsert: true, batchSize: 5000, skipHeaderValidation: false })).resolves.toBeDefined();
+  });
+  it("allows admin imports with wildcard fields", async () => {
+    const service = makeService({ admin: true });
+    const stream = Readable.from(["id,title,private_notes
1,Hello,secret
"]);
+    const result = await service.importCsv(stream, { collection: "articles", filename: "articles.csv", mimetype: "text/csv", background: false, dryRun: true, upsert: true, batchSize: 5000, skipHeaderValidation: false });
+    expect(result.headerSummary.total).toBe(3);
+  });
+});
+
+const rowPolicyCases = [
+  { row: 1, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 2, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 3, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 4, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 5, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 6, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 7, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 8, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 9, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 10, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 11, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 12, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 13, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 14, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 15, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 16, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 17, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 18, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 19, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 20, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 21, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 22, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 23, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 24, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 25, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 26, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 27, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 28, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 29, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 30, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 31, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 32, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 33, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 34, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 35, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 36, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 37, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 38, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 39, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 40, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 41, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 42, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 43, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 44, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 45, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 46, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 47, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 48, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 49, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 50, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 51, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 52, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 53, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 54, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 55, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 56, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 57, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 58, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 59, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 60, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 61, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 62, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 63, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 64, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 65, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 66, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 67, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 68, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 69, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 70, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 71, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 72, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 73, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 74, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 75, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 76, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 77, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 78, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 79, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 80, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 81, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 82, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 83, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 84, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 85, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 86, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 87, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 88, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 89, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 90, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 91, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 92, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 93, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 94, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 95, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 96, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 97, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 98, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 99, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 100, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 101, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 102, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 103, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 104, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 105, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 106, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 107, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 108, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 109, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 110, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 111, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 112, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 113, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 114, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 115, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 116, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 117, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 118, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 119, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 120, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 121, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 122, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 123, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 124, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 125, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 126, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 127, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 128, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 129, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 130, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 131, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 132, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 133, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 134, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 135, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 136, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 137, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 138, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 139, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 140, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 141, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 142, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 143, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 144, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 145, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 146, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 147, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 148, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 149, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 150, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 151, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 152, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 153, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 154, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 155, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 156, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 157, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 158, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 159, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 160, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 161, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 162, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 163, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 164, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 165, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 166, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 167, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 168, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 169, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 170, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 171, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 172, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 173, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 174, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 175, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 176, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 177, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 178, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 179, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 180, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 181, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 182, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 183, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 184, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 185, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 186, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 187, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 188, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 189, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 190, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 191, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 192, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 193, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 194, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 195, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 196, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 197, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 198, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 199, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 200, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 201, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 202, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 203, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 204, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 205, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 206, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 207, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 208, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 209, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 210, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 211, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 212, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 213, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 214, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 215, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 216, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 217, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 218, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 219, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 220, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 221, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 222, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 223, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 224, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 225, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 226, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 227, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 228, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 229, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 230, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 231, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 232, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 233, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 234, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 235, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 236, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 237, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 238, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 239, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 240, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 241, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 242, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 243, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 244, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 245, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 246, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 247, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 248, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 249, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 250, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 251, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 252, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 253, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 254, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 255, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 256, tenant_id: "tenant-b", status: "published", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 257, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 258, tenant_id: "tenant-a", status: "draft", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 259, tenant_id: "tenant-b", status: "published", hasPrivateNotes: false, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+  { row: 260, tenant_id: "tenant-c", status: "archived", hasPrivateNotes: true, shouldRequireRowPolicy: true, shouldUseChunkCommit: true },
+];
+
+describe("permission-aware csv row matrix", () => {
+  it.each(rowPolicyCases)("tracks import contract for row $row", (row) => { expect(row.shouldRequireRowPolicy).toBe(true); expect(row.shouldUseChunkCommit).toBe(true); });
+});
diff --git a/docs/permission-aware-csv-import.md b/docs/permission-aware-csv-import.md
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/docs/permission-aware-csv-import.md
@@ -0,0 +1,209 @@
+# Permission-Aware CSV Import
+
+This endpoint imports CSV data into a collection while showing the user a run record, rejected headers, row counts, and completion state.
+
+## Intended Contract
+
+- The import must obey the same permission semantics as normal item create and update calls.
+- Field allowlists are not enough when permission validation rules depend on row values.
+- A row with a primary key is an update and must be checked as an update for that item.
+- A row without a primary key is a create and must receive create presets and validation.
+- Import progress should survive process restarts and should not require rolling back the entire file for one late failure.
+
+## Operator Notes
+
+- Small CSV files can complete synchronously.
+- Large CSV files should be resumable background jobs.
+- Errors should be grouped by field and row range.
+- Action events should be emitted after committed batches, not before rollback boundaries.
+- Partial success must be visible to the user.
+
+## Reviewer Prompts
+
+- Does the write call go through `ItemsService` with the caller accountability?
+- Does the implementation call `processPayload` or equivalent per row?
+- Does it distinguish create from update before checking permissions?
+- Does it validate update access against concrete primary keys?
+- Does it hold a transaction while streaming and parsing the entire file?
+- Can a successful prefix of the import be resumed after row 20,000 fails?
+
+- Scenario 001: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 002: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 003: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 004: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 005: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 006: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 007: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 008: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 009: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 010: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 011: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 012: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 013: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 014: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 015: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 016: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 017: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 018: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 019: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 020: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 021: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 022: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 023: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 024: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 025: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 026: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 027: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 028: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 029: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 030: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 031: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 032: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 033: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 034: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 035: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 036: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 037: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 038: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 039: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 040: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 041: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 042: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 043: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 044: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 045: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 046: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 047: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 048: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 049: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 050: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 051: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 052: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 053: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 054: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 055: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 056: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 057: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 058: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 059: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 060: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 061: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 062: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 063: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 064: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 065: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 066: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 067: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 068: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 069: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 070: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 071: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 072: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 073: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 074: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 075: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 076: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 077: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 078: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 079: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 080: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 081: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 082: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 083: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 084: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 085: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 086: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 087: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 088: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 089: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 090: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 091: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 092: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 093: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 094: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 095: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 096: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 097: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 098: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 099: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 100: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 101: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 102: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 103: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 104: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 105: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 106: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 107: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 108: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 109: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 110: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 111: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 112: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 113: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 114: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 115: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 116: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 117: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 118: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 119: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 120: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 121: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 122: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 123: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 124: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 125: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 126: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 127: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 128: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 129: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 130: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 131: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 132: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 133: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 134: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 135: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 136: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 137: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 138: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 139: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 140: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 141: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 142: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 143: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 144: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 145: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 146: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 147: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 148: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 149: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 150: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 151: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 152: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 153: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 154: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 155: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 156: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 157: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 158: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 159: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 160: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 161: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 162: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 163: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 164: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 165: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 166: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 167: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 168: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 169: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 170: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 171: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 172: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 173: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 174: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 175: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 176: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 177: import row for tenant a with field set public and verify command-layer authorization.
+- Scenario 178: import row for tenant b with field set mixed and verify command-layer authorization.
+- Scenario 179: import row for tenant c with field set restricted and verify command-layer authorization.
+- Scenario 180: import row for tenant a with field set public and verify command-layer authorization.
diff --git a/api/src/services/import-export/permission-aware-csv-import-review-matrix.test.ts b/api/src/services/import-export/permission-aware-csv-import-review-matrix.test.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/api/src/services/import-export/permission-aware-csv-import-review-matrix.test.ts
@@ -0,0 +1,679 @@
+import { describe, expect, it } from 'vitest';
+
+type ImportAuthorizationScenario = {
+  row: number;
+  operation: "create" | "update";
+  tenant: string;
+  fields: string[];
+  shouldRunProcessPayload: boolean;
+  shouldValidateItemAccess: boolean;
+  shouldCommitInOwnBatch: boolean;
+};
+
+const scenarios: ImportAuthorizationScenario[] = [
+  { row: 1, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 2, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 3, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 4, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 5, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 6, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 7, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 8, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 9, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 10, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 11, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 12, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 13, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 14, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 15, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 16, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 17, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 18, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 19, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 20, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 21, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 22, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 23, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 24, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 25, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 26, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 27, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 28, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 29, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 30, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 31, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 32, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 33, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 34, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 35, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 36, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 37, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 38, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 39, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 40, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 41, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 42, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 43, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 44, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 45, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 46, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 47, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 48, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 49, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 50, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 51, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 52, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 53, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 54, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 55, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 56, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 57, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 58, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 59, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 60, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 61, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 62, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 63, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 64, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 65, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 66, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 67, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 68, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 69, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 70, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 71, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 72, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 73, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 74, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 75, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 76, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 77, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 78, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 79, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 80, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 81, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 82, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 83, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 84, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 85, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 86, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 87, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 88, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 89, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 90, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 91, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 92, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 93, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 94, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 95, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 96, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 97, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 98, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 99, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 100, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 101, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 102, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 103, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 104, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 105, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 106, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 107, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 108, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 109, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 110, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 111, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 112, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 113, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 114, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 115, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 116, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 117, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 118, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 119, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 120, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 121, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 122, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 123, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 124, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 125, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 126, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 127, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 128, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 129, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 130, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 131, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 132, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 133, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 134, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 135, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 136, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 137, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 138, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 139, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 140, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 141, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 142, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 143, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 144, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 145, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 146, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 147, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 148, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 149, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 150, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 151, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 152, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 153, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 154, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 155, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 156, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 157, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 158, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 159, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 160, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 161, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 162, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 163, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 164, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 165, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 166, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 167, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 168, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 169, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 170, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 171, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 172, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 173, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 174, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 175, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 176, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 177, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 178, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 179, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 180, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 181, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 182, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 183, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 184, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 185, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 186, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 187, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 188, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 189, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 190, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 191, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 192, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 193, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 194, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 195, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 196, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 197, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 198, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 199, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 200, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 201, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 202, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 203, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 204, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 205, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 206, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 207, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 208, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 209, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 210, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 211, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 212, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 213, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 214, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 215, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 216, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 217, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 218, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 219, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 220, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 221, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 222, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 223, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 224, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 225, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 226, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 227, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 228, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 229, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 230, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 231, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 232, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 233, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 234, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 235, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 236, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 237, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 238, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 239, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 240, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 241, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 242, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 243, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 244, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 245, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 246, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 247, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 248, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 249, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 250, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 251, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 252, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 253, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 254, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 255, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 256, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 257, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 258, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 259, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 260, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 261, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 262, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 263, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 264, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 265, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 266, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 267, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 268, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 269, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 270, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 271, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 272, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 273, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 274, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 275, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 276, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 277, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 278, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 279, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 280, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 281, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 282, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 283, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 284, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 285, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 286, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 287, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 288, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 289, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 290, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 291, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 292, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 293, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 294, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 295, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 296, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 297, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 298, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 299, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 300, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 301, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 302, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 303, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 304, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 305, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 306, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 307, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 308, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 309, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 310, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 311, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 312, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 313, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 314, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 315, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 316, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 317, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 318, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 319, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 320, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 321, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 322, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 323, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 324, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 325, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 326, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 327, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 328, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 329, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 330, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 331, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 332, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 333, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 334, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 335, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 336, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 337, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 338, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 339, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 340, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 341, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 342, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 343, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 344, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 345, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 346, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 347, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 348, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 349, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 350, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 351, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 352, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 353, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 354, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 355, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 356, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 357, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 358, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 359, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 360, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 361, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 362, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 363, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 364, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 365, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 366, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 367, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 368, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 369, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 370, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 371, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 372, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 373, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 374, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 375, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 376, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 377, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 378, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 379, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 380, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 381, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 382, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 383, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 384, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 385, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 386, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 387, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 388, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 389, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 390, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 391, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 392, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 393, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 394, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 395, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 396, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 397, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 398, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 399, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 400, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 401, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 402, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 403, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 404, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 405, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 406, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 407, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 408, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 409, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 410, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 411, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 412, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 413, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 414, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 415, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 416, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 417, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 418, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 419, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 420, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 421, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 422, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 423, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 424, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 425, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 426, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 427, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 428, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 429, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 430, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 431, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 432, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 433, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 434, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 435, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 436, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 437, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 438, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 439, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 440, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 441, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 442, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 443, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 444, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 445, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 446, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 447, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 448, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 449, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 450, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 451, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 452, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 453, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 454, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 455, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 456, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 457, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 458, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 459, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 460, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 461, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 462, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 463, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 464, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 465, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 466, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 467, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 468, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 469, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 470, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 471, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 472, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 473, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 474, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 475, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 476, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 477, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 478, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 479, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 480, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 481, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 482, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 483, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 484, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 485, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 486, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 487, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 488, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 489, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 490, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 491, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 492, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 493, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 494, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 495, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 496, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 497, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 498, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 499, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 500, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 501, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 502, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 503, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 504, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 505, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 506, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 507, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 508, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 509, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 510, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 511, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 512, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 513, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 514, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 515, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 516, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 517, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 518, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 519, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 520, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 521, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 522, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 523, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 524, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 525, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 526, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 527, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 528, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 529, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 530, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 531, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 532, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 533, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 534, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 535, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 536, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 537, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 538, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 539, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 540, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 541, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 542, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 543, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 544, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 545, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 546, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 547, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 548, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 549, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 550, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 551, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 552, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 553, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 554, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 555, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 556, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 557, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 558, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 559, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 560, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 561, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 562, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 563, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 564, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 565, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 566, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 567, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 568, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 569, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 570, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 571, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 572, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 573, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 574, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 575, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 576, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 577, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 578, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 579, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 580, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 581, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 582, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 583, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 584, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 585, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 586, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 587, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 588, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 589, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 590, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 591, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 592, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 593, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 594, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 595, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 596, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 597, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 598, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 599, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 600, operation: "update", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 601, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 602, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 603, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 604, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 605, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 606, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 607, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 608, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 609, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 610, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 611, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 612, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 613, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 614, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 615, operation: "update", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 616, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 617, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 618, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 619, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 620, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 621, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 622, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 623, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 624, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 625, operation: "create", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 626, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 627, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 628, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 629, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 630, operation: "update", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 631, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 632, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 633, operation: "update", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 634, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 635, operation: "create", tenant: "west", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 636, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 637, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 638, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 639, operation: "update", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 640, operation: "create", tenant: "north", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 641, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 642, operation: "update", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 643, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 644, operation: "create", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 645, operation: "update", tenant: "south", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 646, operation: "create", tenant: "east", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 647, operation: "create", tenant: "west", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 648, operation: "update", tenant: "north", fields: ["title", "status"], shouldRunProcessPayload: true, shouldValidateItemAccess: true, shouldCommitInOwnBatch: true },
+  { row: 649, operation: "create", tenant: "south", fields: ["title", "tenant_id"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+  { row: 650, operation: "create", tenant: "east", fields: ["title", "tenant_id", "private_notes"], shouldRunProcessPayload: true, shouldValidateItemAccess: false, shouldCommitInOwnBatch: true },
+];
+
+describe("permission-aware import authorization matrix", () => {
+  it.each(scenarios)("documents expected command contract for row $row", (scenario) => {
+    expect(scenario.shouldRunProcessPayload).toBe(true);
+    expect(scenario.shouldCommitInOwnBatch).toBe(true);
+    if (scenario.operation === "update") expect(scenario.shouldValidateItemAccess).toBe(true);
+  });
+});
+
+export const importReviewQuestions = scenarios.map((scenario) => ({
+  row: scenario.row,
+  asksAboutAccountability: scenario.shouldRunProcessPayload,
+  asksAboutItemAccess: scenario.shouldValidateItemAccess,
+  asksAboutChunkCommit: scenario.shouldCommitInOwnBatch,
+}));
```

## Intended Flaws

### Flaw 1: Import checks permissions once, then writes with sudo semantics

The PR captures a collection-level permission snapshot and filters headers once, but `executeRowsInSingleTransaction` creates the item service with `accountability: null`. Each row is then written with `createOne` or `updateOne` through that unauthenticated service. That bypasses Directus per-row `processPayload`, presets, dynamic variable validation, item-level update checks, and field permissions that differ between create and update.

### Flaw 1 Hints

1. Find where the service validates access and where the actual `createOne` or `updateOne` calls happen.
2. Ask whether an allowed field list can enforce rules like `tenant_id = $CURRENT_USER.tenant_id`.
3. Check what accountability is passed to `getService` for the row writes.

### Flaw 2: The whole CSV import runs inside one giant transaction

The executor streams all rows through `transaction(this.knex, async (trx) => { ... })`, keeps the transaction open while iterating the whole CSV, writes every batch inside that transaction, and only commits after the final row. For a large import this creates long-held locks, huge rollback surfaces, and no durable resumability despite the run-store progress API.

### Flaw 2 Hints

1. Trace the lifetime of `trx` in `executeRowsInSingleTransaction`. When does it open and close relative to parsing rows?
2. Ask what happens when row 40,000 fails after 39,999 rows were accepted.
3. Compare run progress updates with transaction commit boundaries. Are they durable before the whole file commits?

## Expected Answer

### Flaw 1 Expected Answer

A strong answer should identify that the PR performs collection-level checks in `captureImportPermissionSnapshot`, but the real writes in `permission-aware-csv-import.ts` use `getService(... accountability: null)` and then call `service.createOne` or `service.updateOne`. The header filter is only a broad union of create/update allowed fields. It does not run row-level permission validation, presets, field validation, dynamic variables, or primary-key item access checks for updates.

Production impact: a user can import rows that normal Directus item writes would reject. Examples include setting fields that are allowed on create but not update, updating items outside the user's tenant, bypassing presets for ownership fields, or writing rows that fail permission validation rules. The endpoint looks permission-aware in the UI because it rejects some headers, while still becoming an authorization bypass at the command layer.

Better implementation: do not replace Directus command semantics with a header snapshot. Each row must go through the same service path with the caller accountability, or through a shared import command that explicitly calls `processPayload` for create rows and `validateAccess` with primary keys plus `processPayload` for update rows. The importer should distinguish create/update before permission checks, apply presets, validate row-level rules, and report row-specific forbidden errors.

### Flaw 2 Expected Answer

A strong answer should identify the giant transaction in `executeRowsInSingleTransaction`: it opens one transaction around the async row iterator, all batch writes, and run progress updates. That means the database transaction is held for the whole file, not one durable batch. The run-store increments are also inside the same transaction, so they are not useful for resumability if the transaction rolls back.

Production impact: large imports can hold locks for a long time, inflate rollback work, block concurrent writes, and lose all accepted rows on a late failure. A background import that times out or crashes leaves the user with a failed run and no durable checkpoint even though the UI suggests batch progress.

Better implementation: use chunked atomic batches with resumability. Parse rows outside a long DB transaction, process a bounded batch, open a transaction for that batch only, write rows through permission-aware commands, commit, then persist a checkpoint and emit events for the committed batch. On failure, record the failed batch and allow retry from the last committed row.

## Expert Debrief

### Product-Level Change

The product-level change is a high-throughput import workflow. That sounds operational, but it changes one of the most sensitive surfaces in Directus: who can write which fields and which rows. A reviewer should treat bulk import as many normal item commands, not as a privileged data pipe with a friendly CSV parser.

### Changed Contracts

- Field allowlists become a preflight hint, not the authorization decision.
- Row writes must preserve Directus accountability, presets, validation rules, and item-level update checks.
- Import run progress promises resumability, so progress updates must align with commit boundaries.
- Action events should represent committed rows, not rows that might still roll back.
- Large import transaction scope becomes a product reliability contract, not an implementation detail.

### Failure Modes To Think Through

- A user imports rows for another tenant by supplying `tenant_id` in CSV.
- A user updates a restricted row by including its primary key.
- A field allowed during create but not update is changed during an upsert row.
- A validation rule with `$CURRENT_USER` is skipped because only headers were checked.
- Row 40,000 fails and rolls back 39,999 valid writes.
- A long import blocks concurrent writers on the same table.

### Reviewer Thought Process

The review move is to follow the accountability object. In Directus, permission correctness is rarely just one boolean check; it is a path through `validateAccess`, `processPayload`, policies, presets, and dynamic variables. Then follow the transaction boundary. If progress says batch but the database says one giant transaction, the product is making a promise the implementation cannot keep.

### Better Implementation Direction

Build an import executor that treats each row as a normal command. It can still be fast by grouping rows into bounded chunks, but every row needs create/update classification, permission validation, preset application, and normal item service writes with the caller accountability. Commit each chunk independently, store checkpoints outside the chunk transaction, and make retries idempotent around collection, import id, row number, and primary key.

## Correctness Verdict Rubric

- `correct`: The answer identifies both the sudo/one-time permission-check bypass and the giant transaction/resumability flaw, explains production impact, and suggests row-level command authorization plus chunked commits.
- `partial`: The answer identifies one intended flaw clearly, or mentions permissions and transactions but misses accountability null, row-level validation, or checkpoint durability.
- `incorrect`: The answer focuses on parser edge cases, CSV escaping, naming, or test coverage without naming the authorization bypass and transaction boundary problems.
