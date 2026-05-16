# TS-061: Langfuse Dataset Item CSV Import

## Metadata

- `id`: TS-061
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: dataset items repository, CSV parsing, dataset schema validation, tRPC dataset router, import progress tracking, retry/idempotency contracts, audit logging, client import hook
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 1,950-2,400
- `represented_diff_lines`: 1950
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about CSV imports, all-or-nothing validation, partial imports, idempotency keys, retry semantics, dataset schema validation, and Langfuse dataset item versioning without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR moves dataset item CSV import from a mostly client-driven chunked upload flow to a server-side import flow. The goal is to support larger CSV files, centralize schema validation, report progress, and make retries easier for users importing thousands of dataset items.

The PR adds:

- server-side CSV row parsing,
- import run progress tracking,
- dataset item payload builders for mapped CSV columns,
- a tRPC `startCsvImport` mutation,
- a tRPC `retryCsvImport` mutation,
- a React hook that calls the server importer,
- tests for successful imports, validation failures, retries, and progress,
- docs for operational behavior.

The intended product behavior is: a normal CSV import should either import all valid rows or clearly enter an explicit partial-import mode. If an import fails and the user retries the same CSV, Langfuse should not duplicate already imported rows.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `packages/shared/src/server/repositories/dataset-items.ts` exposes `createManyDatasetItems`. It groups items by dataset, validates all items, collects validation errors with original `itemIndex`, and returns before insertion when validation fails and `allowPartialSuccess` is not enabled.
- `createManyDatasetItems` documents all-or-nothing behavior by default, with partial success only when `allowPartialSuccess` is explicitly set.
- `createManyDatasetItems` compiles dataset validators once per dataset rather than per row, because dataset schema validation is a hot path for bulk operations.
- `web/src/features/datasets/server/dataset-router.ts` exposes `createManyDatasetItems` through a protected project procedure and returns validation errors instead of inserting invalid batches.
- `web/src/features/datasets/hooks/useCsvImport.ts` parses the CSV client-side, maps columns to input/expected output/metadata, sends chunked `createManyDatasetItems` requests, and adjusts returned validation-error indexes by the processed count.
- `web/src/features/datasets/lib/csv/helpers.ts` handles client CSV preview/parsing, column mapping, JSON parsing, and schema-object construction.
- `packages/shared/src/server/datasets/schemaValidation.ts` validates existing dataset items in batches and stops after enough errors, showing a pattern of validation before committing a schema-changing operation.
- Dataset items may be versioned, and the repository supports user-provided item IDs for replace/upsert semantics. Idempotency is therefore a domain decision, not only a transport detail.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this import flow preserves import atomicity and retry/idempotency guarantees.

## Review Surface

Changed files in the synthetic PR:

- `web/src/features/datasets/server/csvImport/types.ts`
- `web/src/features/datasets/server/csvImport/parseCsvRows.ts`
- `web/src/features/datasets/server/csvImport/importProgressStore.ts`
- `web/src/features/datasets/server/csvImport/previewCsvImport.ts`
- `web/src/features/datasets/server/csvImport/csvImportProgress.ts`
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts`
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.test.ts`
- `web/src/features/datasets/server/csvImport/previewCsvImport.test.ts`
- `web/src/features/datasets/server/csvImport/csvImportProgress.test.ts`
- `web/src/features/datasets/server/dataset-router.ts`
- `web/src/features/datasets/hooks/useServerCsvImport.ts`
- `web/src/features/datasets/server/csvImport/README.md`

The line references below use synthetic PR line numbers. The represented diff is focused on validation/commit boundaries and retry idempotency.

## Diff

```diff
diff --git a/web/src/features/datasets/server/csvImport/types.ts b/web/src/features/datasets/server/csvImport/types.ts
new file mode 100644
index 0000000000..3edc1b99b5
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/types.ts
@@ -0,0 +1,214 @@
+import { z } from "zod";
+import type { RouterInputs } from "@/src/utils/api";
+
+export const csvColumnMappingSchema = z.object({
+  inputColumns: z.array(z.string()),
+  expectedOutputColumns: z.array(z.string()),
+  metadataColumns: z.array(z.string()),
+  inputSchemaMapping: z.record(z.string(), z.array(z.string())).optional(),
+  expectedOutputSchemaMapping: z.record(z.string(), z.array(z.string())).optional(),
+  wrapSingleColumn: z.boolean().default(false),
+});
+
+export const startCsvImportSchema = z.object({
+  projectId: z.string(),
+  datasetId: z.string(),
+  csvText: z.string(),
+  fileName: z.string().optional(),
+  mapping: csvColumnMappingSchema,
+  batchSize: z.number().int().min(1).max(500).default(100),
+});
+
+export const retryCsvImportSchema = startCsvImportSchema.extend({
+  previousImportId: z.string().optional(),
+});
+
+export type CsvColumnMapping = z.infer<typeof csvColumnMappingSchema>;
+export type StartCsvImportInput = z.infer<typeof startCsvImportSchema>;
+export type RetryCsvImportInput = z.infer<typeof retryCsvImportSchema>;
+
+export type CsvImportRow = {
+  rowIndex: number;
+  csvLineNumber: number;
+  values: Record<string, string>;
+};
+
+export type CsvImportRunStatus =
+  | "queued"
+  | "processing"
+  | "complete"
+  | "failed"
+  | "partial";
+
+export type CsvImportRun = {
+  id: string;
+  projectId: string;
+  datasetId: string;
+  fileName: string | null;
+  status: CsvImportRunStatus;
+  totalRows: number;
+  processedRows: number;
+  importedRows: number;
+  failedRows: number;
+  startedAt: Date;
+  finishedAt: Date | null;
+  error: string | null;
+};
+
+export type CsvImportValidationIssue = {
+  rowIndex: number;
+  csvLineNumber: number;
+  field: "input" | "expectedOutput" | "metadata" | "row";
+  message: string;
+  path?: string;
+};
+
+export type CsvImportFailure = {
+  success: false;
+  importId: string;
+  status: "failed" | "partial";
+  processedRows: number;
+  importedRows: number;
+  failedRows: number;
+  validationErrors: CsvImportValidationIssue[];
+  retryFromRow: number;
+};
+
+export type CsvImportSuccess = {
+  success: true;
+  importId: string;
+  status: "complete";
+  processedRows: number;
+  importedRows: number;
+  failedRows: number;
+};
+
+export type CsvImportResult = CsvImportSuccess | CsvImportFailure;
+
+export type DatasetItemImportPayload =
+  RouterInputs["datasets"]["createManyDatasetItems"]["items"][number] & {
+    importId: string;
+    rowIndex: number;
+    csvLineNumber: number;
+  };
+
+export type BuildDatasetItemPayloadOptions = {
+  projectId: string;
+  datasetId: string;
+  importId: string;
+  row: CsvImportRow;
+  mapping: CsvColumnMapping;
+};
+
+export function createEmptyRun(params: {
+  id: string;
+  projectId: string;
+  datasetId: string;
+  fileName?: string | null;
+}): CsvImportRun {
+  return {
+    id: params.id,
+    projectId: params.projectId,
+    datasetId: params.datasetId,
+    fileName: params.fileName ?? null,
+    status: "queued",
+    totalRows: 0,
+    processedRows: 0,
+    importedRows: 0,
+    failedRows: 0,
+    startedAt: new Date(),
+    finishedAt: null,
+    error: null,
+  };
+}
+
+export function toCsvImportIssue(params: {
+  row: CsvImportRow;
+  field: CsvImportValidationIssue["field"];
+  message: string;
+  path?: string;
+}): CsvImportValidationIssue {
+  return {
+    rowIndex: params.row.rowIndex,
+    csvLineNumber: params.row.csvLineNumber,
+    field: params.field,
+    message: params.message,
+    path: params.path,
+  };
+}
diff --git a/web/src/features/datasets/server/csvImport/parseCsvRows.ts b/web/src/features/datasets/server/csvImport/parseCsvRows.ts
new file mode 100644
index 0000000000..a613764fea
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/parseCsvRows.ts
@@ -0,0 +1,244 @@
+import { parse } from "csv-parse/sync";
+import { Prisma } from "@langfuse/shared/src/db";
+import type {
+  CsvColumnMapping,
+  CsvImportRow,
+  DatasetItemImportPayload,
+  BuildDatasetItemPayloadOptions,
+} from "./types";
+import { toCsvImportIssue } from "./types";
+
+function parseValue(value: string): Prisma.JsonValue {
+  try {
+    return JSON.parse(value);
+  } catch {
+    if (value === "" || value.toLowerCase() === "null") return null;
+    if (value.toLowerCase() === "true") return true;
+    if (value.toLowerCase() === "false") return false;
+    if (!isNaN(Number(value))) return Number(value);
+    return value;
+  }
+}
+
+function parseColumns(
+  columnNames: string[],
+  row: CsvImportRow,
+  options?: { wrapSingleColumn?: boolean },
+): Prisma.JsonValue {
+  if (columnNames.length === 0) return null;
+
+  if (columnNames.length === 1) {
+    const column = columnNames[0]!;
+    const parsed = parseValue(row.values[column] ?? "");
+    return options?.wrapSingleColumn ? { [column]: parsed } : parsed;
+  }
+
+  return Object.fromEntries(
+    columnNames.map((column) => [column, parseValue(row.values[column] ?? "")]),
+  );
+}
+
+function buildSchemaObject(
+  mapping: Record<string, string[]> | undefined,
+  row: CsvImportRow,
+): Prisma.JsonValue {
+  if (!mapping || Object.keys(mapping).length === 0) return null;
+
+  return Object.fromEntries(
+    Object.entries(mapping).map(([schemaKey, csvColumns]) => {
+      if (csvColumns.length === 1) {
+        return [schemaKey, parseValue(row.values[csvColumns[0]!] ?? "")];
+      }
+
+      return [
+        schemaKey,
+        Object.fromEntries(
+          csvColumns.map((column) => [
+            column,
+            parseValue(row.values[column] ?? ""),
+          ]),
+        ),
+      ];
+    }),
+  );
+}
+
+function assertColumnsExist(headers: string[], mapping: CsvColumnMapping) {
+  const headerSet = new Set(headers);
+  const requiredColumns = [
+    ...mapping.inputColumns,
+    ...mapping.expectedOutputColumns,
+    ...mapping.metadataColumns,
+    ...Object.values(mapping.inputSchemaMapping ?? {}).flat(),
+    ...Object.values(mapping.expectedOutputSchemaMapping ?? {}).flat(),
+  ];
+  const missingColumns = requiredColumns.filter((column) => !headerSet.has(column));
+  if (missingColumns.length > 0) {
+    throw new Error(`Missing columns: ${missingColumns.join(", ")}`);
+  }
+}
+
+export function parseCsvRows(csvText: string, mapping: CsvColumnMapping): CsvImportRow[] {
+  const records = parse(csvText, {
+    bom: true,
+    columns: true,
+    skip_empty_lines: true,
+    trim: true,
+  }) as Record<string, string>[];
+
+  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
+  assertColumnsExist(headers, mapping);
+
+  return records.map((values, index) => ({
+    rowIndex: index,
+    csvLineNumber: index + 2,
+    values,
+  }));
+}
+
+export function buildDatasetItemPayload(
+  options: BuildDatasetItemPayloadOptions,
+): DatasetItemImportPayload {
+  const { row, mapping, datasetId, importId } = options;
+  const input =
+    mapping.inputSchemaMapping && Object.keys(mapping.inputSchemaMapping).length > 0
+      ? buildSchemaObject(mapping.inputSchemaMapping, row)
+      : parseColumns(mapping.inputColumns, row, {
+          wrapSingleColumn: mapping.wrapSingleColumn,
+        });
+  const expectedOutput =
+    mapping.expectedOutputSchemaMapping &&
+    Object.keys(mapping.expectedOutputSchemaMapping).length > 0
+      ? buildSchemaObject(mapping.expectedOutputSchemaMapping, row)
+      : parseColumns(mapping.expectedOutputColumns, row, {
+          wrapSingleColumn: mapping.wrapSingleColumn,
+        });
+  const metadata = parseColumns(mapping.metadataColumns, row, {
+    wrapSingleColumn: mapping.wrapSingleColumn,
+  });
+
+  return {
+    datasetId,
+    input: JSON.stringify(input),
+    expectedOutput: JSON.stringify(expectedOutput),
+    metadata: JSON.stringify({
+      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
+        ? metadata
+        : { value: metadata }),
+      csvImport: {
+        importId,
+        rowIndex: row.rowIndex,
+        csvLineNumber: row.csvLineNumber,
+      },
+    }),
+    importId,
+    rowIndex: row.rowIndex,
+    csvLineNumber: row.csvLineNumber,
+  };
+}
+
+export function validateRowShape(row: CsvImportRow, mapping: CsvColumnMapping) {
+  try {
+    buildDatasetItemPayload({
+      projectId: "shape-check",
+      datasetId: "shape-check",
+      importId: "shape-check",
+      row,
+      mapping,
+    });
+    return null;
+  } catch (error) {
+    return toCsvImportIssue({
+      row,
+      field: "row",
+      message: error instanceof Error ? error.message : "Failed to parse row",
+    });
+  }
+}
diff --git a/web/src/features/datasets/server/csvImport/importProgressStore.ts b/web/src/features/datasets/server/csvImport/importProgressStore.ts
new file mode 100644
index 0000000000..687b066b53
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/importProgressStore.ts
@@ -0,0 +1,232 @@
+import type { CsvImportRun } from "./types";
+
+type ImportedRowRecord = {
+  importId: string;
+  rowIndex: number;
+  datasetItemId: string | null;
+  createdAt: Date;
+};
+
+const runs = new Map<string, CsvImportRun>();
+const importedRows = new Map<string, ImportedRowRecord>();
+
+function rowKey(importId: string, rowIndex: number) {
+  return `${importId}:${rowIndex}`;
+}
+
+export function createImportRun(run: CsvImportRun) {
+  runs.set(run.id, {
+    ...run,
+    status: "processing",
+  });
+  return runs.get(run.id)!;
+}
+
+export function getImportRun(importId: string) {
+  return runs.get(importId) ?? null;
+}
+
+export function updateImportRun(
+  importId: string,
+  update: Partial<Omit<CsvImportRun, "id" | "projectId" | "datasetId">>,
+) {
+  const run = runs.get(importId);
+  if (!run) return null;
+  const next = {
+    ...run,
+    ...update,
+  };
+  runs.set(importId, next);
+  return next;
+}
+
+export function markRowsImported(params: {
+  importId: string;
+  rows: Array<{
+    rowIndex: number;
+    datasetItemId?: string | null;
+  }>;
+}) {
+  for (const row of params.rows) {
+    importedRows.set(rowKey(params.importId, row.rowIndex), {
+      importId: params.importId,
+      rowIndex: row.rowIndex,
+      datasetItemId: row.datasetItemId ?? null,
+      createdAt: new Date(),
+    });
+  }
+}
+
+export function wasRowImported(importId: string, rowIndex: number) {
+  return importedRows.has(rowKey(importId, rowIndex));
+}
+
+export function getImportedRows(importId: string) {
+  return Array.from(importedRows.values())
+    .filter((row) => row.importId === importId)
+    .sort((a, b) => a.rowIndex - b.rowIndex);
+}
+
+export function resetImportProgressForTests() {
+  runs.clear();
+  importedRows.clear();
+}
diff --git a/web/src/features/datasets/server/csvImport/previewCsvImport.ts b/web/src/features/datasets/server/csvImport/previewCsvImport.ts
new file mode 100644
index 0000000000..39ba60d1a5
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/previewCsvImport.ts
@@ -0,0 +1,268 @@
+import {
+  buildDatasetItemPayload,
+  parseCsvRows,
+  validateRowShape,
+} from "./parseCsvRows";
+import type {
+  CsvImportValidationIssue,
+  DatasetItemImportPayload,
+  StartCsvImportInput,
+} from "./types";
+
+export type CsvImportPreviewRow = {
+  rowIndex: number;
+  csvLineNumber: number;
+  input: unknown;
+  expectedOutput: unknown;
+  metadata: unknown;
+};
+
+export type CsvImportPreviewWarning = {
+  code:
+    | "empty_input"
+    | "empty_expected_output"
+    | "large_metadata"
+    | "duplicate_row_index"
+    | "missing_metadata";
+  rowIndex: number;
+  csvLineNumber: number;
+  message: string;
+};
+
+export type CsvImportPreview = {
+  totalRows: number;
+  previewRows: CsvImportPreviewRow[];
+  validationErrors: CsvImportValidationIssue[];
+  warnings: CsvImportPreviewWarning[];
+};
+
+function safeJsonParse(value: string | undefined) {
+  if (value === undefined) return undefined;
+  try {
+    return JSON.parse(value);
+  } catch {
+    return value;
+  }
+}
+
+function toPreviewRow(item: DatasetItemImportPayload): CsvImportPreviewRow {
+  return {
+    rowIndex: item.rowIndex,
+    csvLineNumber: item.csvLineNumber,
+    input: safeJsonParse(item.input ?? undefined),
+    expectedOutput: safeJsonParse(item.expectedOutput ?? undefined),
+    metadata: safeJsonParse(item.metadata ?? undefined),
+  };
+}
+
+function buildWarnings(item: DatasetItemImportPayload): CsvImportPreviewWarning[] {
+  const warnings: CsvImportPreviewWarning[] = [];
+  const input = safeJsonParse(item.input ?? undefined);
+  const expectedOutput = safeJsonParse(item.expectedOutput ?? undefined);
+  const metadata = safeJsonParse(item.metadata ?? undefined);
+
+  if (input === null || input === undefined || input === "") {
+    warnings.push({
+      code: "empty_input",
+      rowIndex: item.rowIndex,
+      csvLineNumber: item.csvLineNumber,
+      message: "Input is empty for this row.",
+    });
+  }
+
+  if (
+    expectedOutput === null ||
+    expectedOutput === undefined ||
+    expectedOutput === ""
+  ) {
+    warnings.push({
+      code: "empty_expected_output",
+      rowIndex: item.rowIndex,
+      csvLineNumber: item.csvLineNumber,
+      message: "Expected output is empty for this row.",
+    });
+  }
+
+  if (metadata === null || metadata === undefined) {
+    warnings.push({
+      code: "missing_metadata",
+      rowIndex: item.rowIndex,
+      csvLineNumber: item.csvLineNumber,
+      message: "Metadata is empty for this row.",
+    });
+  }
+
+  if (
+    typeof metadata === "object" &&
+    metadata !== null &&
+    JSON.stringify(metadata).length > 4_000
+  ) {
+    warnings.push({
+      code: "large_metadata",
+      rowIndex: item.rowIndex,
+      csvLineNumber: item.csvLineNumber,
+      message: "Metadata is larger than 4KB and may make the dataset table harder to scan.",
+    });
+  }
+
+  return warnings;
+}
+
+export function previewCsvImport(input: StartCsvImportInput): CsvImportPreview {
+  const rows = parseCsvRows(input.csvText, input.mapping);
+  const validationErrors = rows
+    .map((row) => validateRowShape(row, input.mapping))
+    .filter((issue): issue is CsvImportValidationIssue => Boolean(issue));
+  const payloads = rows.slice(0, 25).map((row) =>
+    buildDatasetItemPayload({
+      projectId: input.projectId,
+      datasetId: input.datasetId,
+      importId: "preview",
+      row,
+      mapping: input.mapping,
+    }),
+  );
+
+  const seenRowIndexes = new Set<number>();
+  const duplicateWarnings: CsvImportPreviewWarning[] = [];
+  for (const row of rows) {
+    if (seenRowIndexes.has(row.rowIndex)) {
+      duplicateWarnings.push({
+        code: "duplicate_row_index",
+        rowIndex: row.rowIndex,
+        csvLineNumber: row.csvLineNumber,
+        message: "Duplicate row index detected in parsed CSV.",
+      });
+    }
+    seenRowIndexes.add(row.rowIndex);
+  }
+
+  return {
+    totalRows: rows.length,
+    previewRows: payloads.map(toPreviewRow),
+    validationErrors,
+    warnings: [...payloads.flatMap(buildWarnings), ...duplicateWarnings],
+  };
+}
diff --git a/web/src/features/datasets/server/csvImport/csvImportProgress.ts b/web/src/features/datasets/server/csvImport/csvImportProgress.ts
new file mode 100644
index 0000000000..f15de673a4
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/csvImportProgress.ts
@@ -0,0 +1,190 @@
+import { getImportedRows, getImportRun } from "./importProgressStore";
+import type { CsvImportRunStatus } from "./types";
+
+export type CsvImportProgressSnapshot = {
+  importId: string;
+  status: CsvImportRunStatus | "missing";
+  processedRows: number;
+  importedRows: number;
+  failedRows: number;
+  totalRows: number;
+  percentComplete: number;
+  importedRowIndexes: number[];
+  canRetry: boolean;
+  message: string;
+};
+
+function percent(processedRows: number, totalRows: number) {
+  if (totalRows <= 0) return 0;
+  return Math.min(100, Math.round((processedRows / totalRows) * 100));
+}
+
+function messageForStatus(status: CsvImportProgressSnapshot["status"]) {
+  switch (status) {
+    case "queued":
+      return "CSV import is queued.";
+    case "processing":
+      return "CSV import is processing.";
+    case "complete":
+      return "CSV import completed.";
+    case "partial":
+      return "CSV import partially completed.";
+    case "failed":
+      return "CSV import failed.";
+    case "missing":
+      return "CSV import not found.";
+  }
+}
+
+export function getCsvImportProgress(importId: string): CsvImportProgressSnapshot {
+  const run = getImportRun(importId);
+  if (!run) {
+    return {
+      importId,
+      status: "missing",
+      processedRows: 0,
+      importedRows: 0,
+      failedRows: 0,
+      totalRows: 0,
+      percentComplete: 0,
+      importedRowIndexes: [],
+      canRetry: false,
+      message: messageForStatus("missing"),
+    };
+  }
+
+  const importedRows = getImportedRows(importId);
+  return {
+    importId,
+    status: run.status,
+    processedRows: run.processedRows,
+    importedRows: run.importedRows,
+    failedRows: run.failedRows,
+    totalRows: run.totalRows,
+    percentComplete: percent(run.processedRows, run.totalRows),
+    importedRowIndexes: importedRows.map((row) => row.rowIndex),
+    canRetry: run.status === "partial" || run.status === "failed",
+    message: messageForStatus(run.status),
+  };
+}
+
+export function summarizeCsvImportProgress(snapshot: CsvImportProgressSnapshot) {
+  if (snapshot.status === "missing") {
+    return "Import not found.";
+  }
+
+  if (snapshot.status === "complete") {
+    return `Imported ${snapshot.importedRows} of ${snapshot.totalRows} rows.`;
+  }
+
+  if (snapshot.status === "partial") {
+    return `Imported ${snapshot.importedRows} rows before failing. Retry is available.`;
+  }
+
+  if (snapshot.status === "failed") {
+    return `Import failed after ${snapshot.processedRows} processed rows.`;
+  }
+
+  return `${snapshot.processedRows} of ${snapshot.totalRows} rows processed.`;
+}
diff --git a/web/src/features/datasets/server/csvImport/previewCsvImport.test.ts b/web/src/features/datasets/server/csvImport/previewCsvImport.test.ts
new file mode 100644
index 0000000000..41255ac882
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/previewCsvImport.test.ts
@@ -0,0 +1,346 @@
+import { describe, expect, it } from "vitest";
+import { previewCsvImport } from "./previewCsvImport";
+
+function input(csvText: string) {
+  return {
+    projectId: "project-1",
+    datasetId: "dataset-1",
+    csvText,
+    mapping: {
+      inputColumns: ["input"],
+      expectedOutputColumns: ["expected"],
+      metadataColumns: ["metadata"],
+      wrapSingleColumn: false,
+    },
+    batchSize: 100,
+  };
+}
+
+describe("previewCsvImport", () => {
+  it("returns preview rows for a small csv", () => {
+    const result = previewCsvImport(
+      input(["input,expected,metadata", "hello,world,{}", "foo,bar,{}"].join("\n")),
+    );
+
+    expect(result.totalRows).toBe(2);
+    expect(result.previewRows).toEqual([
+      {
+        rowIndex: 0,
+        csvLineNumber: 2,
+        input: "hello",
+        expectedOutput: "world",
+        metadata: {
+          csvImport: {
+            importId: "preview",
+            rowIndex: 0,
+            csvLineNumber: 2,
+          },
+        },
+      },
+      {
+        rowIndex: 1,
+        csvLineNumber: 3,
+        input: "foo",
+        expectedOutput: "bar",
+        metadata: {
+          csvImport: {
+            importId: "preview",
+            rowIndex: 1,
+            csvLineNumber: 3,
+          },
+        },
+      },
+    ]);
+  });
+
+  it("returns warnings for empty input and expected output", () => {
+    const result = previewCsvImport(
+      input(["input,expected,metadata", ",,{}"].join("\n")),
+    );
+
+    expect(result.warnings).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          code: "empty_input",
+          rowIndex: 0,
+        }),
+        expect.objectContaining({
+          code: "empty_expected_output",
+          rowIndex: 0,
+        }),
+      ]),
+    );
+  });
+
+  it("supports schema mapping in preview", () => {
+    const result = previewCsvImport({
+      projectId: "project-1",
+      datasetId: "dataset-1",
+      csvText: ["question,answer,meta", "What is 2+2?,4,{}"].join("\n"),
+      mapping: {
+        inputColumns: [],
+        expectedOutputColumns: [],
+        metadataColumns: ["meta"],
+        inputSchemaMapping: {
+          question: ["question"],
+        },
+        expectedOutputSchemaMapping: {
+          answer: ["answer"],
+        },
+        wrapSingleColumn: false,
+      },
+      batchSize: 100,
+    });
+
+    expect(result.previewRows[0]).toEqual(
+      expect.objectContaining({
+        input: {
+          question: "What is 2+2?",
+        },
+        expectedOutput: {
+          answer: 4,
+        },
+      }),
+    );
+  });
+
+  it("limits preview rows to the first 25 rows", () => {
+    const rows = ["input,expected,metadata"];
+    for (let i = 0; i < 40; i++) {
+      rows.push(`input-${i},expected-${i},{}`);
+    }
+
+    const result = previewCsvImport(input(rows.join("\n")));
+
+    expect(result.totalRows).toBe(40);
+    expect(result.previewRows).toHaveLength(25);
+    expect(result.previewRows[24]?.rowIndex).toBe(24);
+  });
+
+  it("throws when required columns are missing", () => {
+    expect(() =>
+      previewCsvImport(
+        input(["input,metadata", "hello,{}"].join("\n")),
+      ),
+    ).toThrow("Missing columns: expected");
+  });
+});
diff --git a/web/src/features/datasets/server/csvImport/csvImportProgress.test.ts b/web/src/features/datasets/server/csvImport/csvImportProgress.test.ts
new file mode 100644
index 0000000000..e81ce8b29b
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/csvImportProgress.test.ts
@@ -0,0 +1,220 @@
+import { beforeEach, describe, expect, it } from "vitest";
+import { createEmptyRun } from "./types";
+import {
+  createImportRun,
+  markRowsImported,
+  resetImportProgressForTests,
+  updateImportRun,
+} from "./importProgressStore";
+import {
+  getCsvImportProgress,
+  summarizeCsvImportProgress,
+} from "./csvImportProgress";
+
+describe("csv import progress", () => {
+  beforeEach(() => {
+    resetImportProgressForTests();
+  });
+
+  it("returns missing snapshot for unknown import", () => {
+    expect(getCsvImportProgress("missing")).toEqual({
+      importId: "missing",
+      status: "missing",
+      processedRows: 0,
+      importedRows: 0,
+      failedRows: 0,
+      totalRows: 0,
+      percentComplete: 0,
+      importedRowIndexes: [],
+      canRetry: false,
+      message: "CSV import not found.",
+    });
+  });
+
+  it("returns progress for a processing run", () => {
+    createImportRun(
+      createEmptyRun({
+        id: "import-1",
+        projectId: "project-1",
+        datasetId: "dataset-1",
+      }),
+    );
+    updateImportRun("import-1", {
+      totalRows: 10,
+      processedRows: 4,
+      importedRows: 4,
+    });
+    markRowsImported({
+      importId: "import-1",
+      rows: [
+        { rowIndex: 0, datasetItemId: "item-1" },
+        { rowIndex: 1, datasetItemId: "item-2" },
+        { rowIndex: 2, datasetItemId: "item-3" },
+        { rowIndex: 3, datasetItemId: "item-4" },
+      ],
+    });
+
+    expect(getCsvImportProgress("import-1")).toEqual({
+      importId: "import-1",
+      status: "processing",
+      processedRows: 4,
+      importedRows: 4,
+      failedRows: 0,
+      totalRows: 10,
+      percentComplete: 40,
+      importedRowIndexes: [0, 1, 2, 3],
+      canRetry: false,
+      message: "CSV import is processing.",
+    });
+  });
+
+  it("marks partial imports as retryable", () => {
+    createImportRun(
+      createEmptyRun({
+        id: "import-2",
+        projectId: "project-1",
+        datasetId: "dataset-1",
+      }),
+    );
+    updateImportRun("import-2", {
+      status: "partial",
+      totalRows: 10,
+      processedRows: 5,
+      importedRows: 5,
+      failedRows: 1,
+    });
+
+    const snapshot = getCsvImportProgress("import-2");
+    expect(snapshot.canRetry).toBe(true);
+    expect(summarizeCsvImportProgress(snapshot)).toBe(
+      "Imported 5 rows before failing. Retry is available.",
+    );
+  });
+
+  it("summarizes complete imports", () => {
+    createImportRun(
+      createEmptyRun({
+        id: "import-3",
+        projectId: "project-1",
+        datasetId: "dataset-1",
+      }),
+    );
+    updateImportRun("import-3", {
+      status: "complete",
+      totalRows: 3,
+      processedRows: 3,
+      importedRows: 3,
+    });
+
+    expect(summarizeCsvImportProgress(getCsvImportProgress("import-3"))).toBe(
+      "Imported 3 of 3 rows.",
+    );
+  });
+});
diff --git a/web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts b/web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts
new file mode 100644
index 0000000000..cabf9dfc29
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts
@@ -0,0 +1,370 @@
+import { v4 } from "uuid";
+import {
+  createManyDatasetItems,
+  type CreateManyValidationError,
+} from "@langfuse/shared/src/server";
+import type { Session } from "next-auth";
+import { auditLog } from "@/src/features/audit-logs/auditLog";
+import {
+  buildDatasetItemPayload,
+  parseCsvRows,
+  validateRowShape,
+} from "./parseCsvRows";
+import {
+  createImportRun,
+  markRowsImported,
+  updateImportRun,
+  wasRowImported,
+} from "./importProgressStore";
+import {
+  createEmptyRun,
+  type CsvImportResult,
+  type CsvImportValidationIssue,
+  type DatasetItemImportPayload,
+  type StartCsvImportInput,
+} from "./types";
+
+function toValidationIssues(
+  errors: CreateManyValidationError[],
+  batchItems: DatasetItemImportPayload[],
+): CsvImportValidationIssue[] {
+  return errors.map((error) => {
+    const item = batchItems[error.itemIndex];
+    return {
+      rowIndex: item?.rowIndex ?? error.itemIndex,
+      csvLineNumber: item?.csvLineNumber ?? error.itemIndex + 2,
+      field: error.field,
+      message: error.errors.map((e) => e.message).join(", "),
+      path: error.errors.map((e) => e.path).filter(Boolean).join("."),
+    };
+  });
+}
+
+function chunkRows<T>(items: T[], size: number) {
+  const chunks: T[][] = [];
+  for (let i = 0; i < items.length; i += size) {
+    chunks.push(items.slice(i, i + size));
+  }
+  return chunks;
+}
+
+export async function importDatasetItemsFromCsv({
+  input,
+  session,
+}: {
+  input: StartCsvImportInput;
+  session: Session;
+}): Promise<CsvImportResult> {
+  const importId = v4();
+  const run = createImportRun(
+    createEmptyRun({
+      id: importId,
+      projectId: input.projectId,
+      datasetId: input.datasetId,
+      fileName: input.fileName,
+    }),
+  );
+
+  let rows;
+  try {
+    rows = parseCsvRows(input.csvText, input.mapping);
+  } catch (error) {
+    updateImportRun(importId, {
+      status: "failed",
+      finishedAt: new Date(),
+      error: error instanceof Error ? error.message : "Failed to parse CSV",
+    });
+    return {
+      success: false,
+      importId,
+      status: "failed",
+      processedRows: 0,
+      importedRows: 0,
+      failedRows: 1,
+      retryFromRow: 0,
+      validationErrors: [
+        {
+          rowIndex: 0,
+          csvLineNumber: 1,
+          field: "row",
+          message: error instanceof Error ? error.message : "Failed to parse CSV",
+        },
+      ],
+    };
+  }
+
+  updateImportRun(importId, {
+    totalRows: rows.length,
+    processedRows: 0,
+    importedRows: 0,
+    failedRows: 0,
+  });
+
+  const shapeErrors = rows
+    .map((row) => validateRowShape(row, input.mapping))
+    .filter((issue): issue is CsvImportValidationIssue => Boolean(issue));
+
+  if (shapeErrors.length > 0) {
+    updateImportRun(importId, {
+      status: "failed",
+      failedRows: shapeErrors.length,
+      finishedAt: new Date(),
+      error: "CSV row parsing failed",
+    });
+    return {
+      success: false,
+      importId,
+      status: "failed",
+      processedRows: 0,
+      importedRows: 0,
+      failedRows: shapeErrors.length,
+      retryFromRow: shapeErrors[0]?.rowIndex ?? 0,
+      validationErrors: shapeErrors,
+    };
+  }
+
+  const allPayloads = rows.map((row) =>
+    buildDatasetItemPayload({
+      projectId: input.projectId,
+      datasetId: input.datasetId,
+      importId,
+      row,
+      mapping: input.mapping,
+    }),
+  );
+  const batches = chunkRows(allPayloads, input.batchSize);
+  const validationErrors: CsvImportValidationIssue[] = [];
+  let processedRows = 0;
+  let importedRows = 0;
+
+  for (const batch of batches) {
+    const rowsToImport = batch.filter((item) => !wasRowImported(importId, item.rowIndex));
+    if (rowsToImport.length === 0) {
+      processedRows += batch.length;
+      continue;
+    }
+
+    const result = await createManyDatasetItems({
+      projectId: input.projectId,
+      items: rowsToImport.map((item) => ({
+        datasetId: item.datasetId,
+        input: item.input,
+        expectedOutput: item.expectedOutput,
+        metadata: item.metadata,
+      })),
+      normalizeOpts: { sanitizeControlChars: true },
+      validateOpts: { normalizeUndefinedToNull: true },
+    });
+
+    if (!result.success) {
+      const issues = toValidationIssues(result.validationErrors, rowsToImport);
+      validationErrors.push(...issues);
+      updateImportRun(importId, {
+        status: importedRows > 0 ? "partial" : "failed",
+        processedRows,
+        importedRows,
+        failedRows: validationErrors.length,
+        finishedAt: new Date(),
+        error: "Dataset item validation failed",
+      });
+      return {
+        success: false,
+        importId,
+        status: importedRows > 0 ? "partial" : "failed",
+        processedRows,
+        importedRows,
+        failedRows: validationErrors.length,
+        retryFromRow: issues[0]?.rowIndex ?? processedRows,
+        validationErrors,
+      };
+    }
+
+    markRowsImported({
+      importId,
+      rows: result.datasetItems.map((item, index) => ({
+        rowIndex: rowsToImport[index]!.rowIndex,
+        datasetItemId: item.id,
+      })),
+    });
+
+    await Promise.all(
+      result.datasetItems.map((item) =>
+        auditLog({
+          session,
+          resourceType: "datasetItem",
+          resourceId: item.id,
+          action: "create",
+          after: item,
+        }),
+      ),
+    );
+
+    importedRows += result.datasetItems.length;
+    processedRows += batch.length;
+    updateImportRun(importId, {
+      processedRows,
+      importedRows,
+      failedRows: validationErrors.length,
+    });
+  }
+
+  updateImportRun(run.id, {
+    status: "complete",
+    processedRows: rows.length,
+    importedRows,
+    failedRows: 0,
+    finishedAt: new Date(),
+  });
+
+  return {
+    success: true,
+    importId,
+    status: "complete",
+    processedRows: rows.length,
+    importedRows,
+    failedRows: 0,
+  };
+}
diff --git a/web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.test.ts b/web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.test.ts
new file mode 100644
index 0000000000..b920a45e49
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.test.ts
@@ -0,0 +1,446 @@
+import { beforeEach, describe, expect, it, vi } from "vitest";
+import { importDatasetItemsFromCsv } from "./importDatasetItemsFromCsv";
+import {
+  getImportedRows,
+  resetImportProgressForTests,
+} from "./importProgressStore";
+
+const createManyDatasetItems = vi.fn();
+const auditLog = vi.fn();
+
+vi.mock("@langfuse/shared/src/server", async () => {
+  return {
+    createManyDatasetItems: (...args: unknown[]) => createManyDatasetItems(...args),
+  };
+});
+
+vi.mock("@/src/features/audit-logs/auditLog", () => ({
+  auditLog: (...args: unknown[]) => auditLog(...args),
+}));
+
+const session = {
+  user: {
+    id: "user-1",
+    name: "User",
+    email: "user@example.com",
+  },
+  expires: "2099-01-01",
+} as never;
+
+function baseInput(csvText: string) {
+  return {
+    projectId: "project-1",
+    datasetId: "dataset-1",
+    csvText,
+    fileName: "items.csv",
+    batchSize: 2,
+    mapping: {
+      inputColumns: ["input"],
+      expectedOutputColumns: ["expected"],
+      metadataColumns: ["metadata"],
+      wrapSingleColumn: false,
+    },
+  };
+}
+
+describe("importDatasetItemsFromCsv", () => {
+  beforeEach(() => {
+    createManyDatasetItems.mockReset();
+    auditLog.mockReset();
+    resetImportProgressForTests();
+  });
+
+  it("imports all rows in batches", async () => {
+    createManyDatasetItems
+      .mockResolvedValueOnce({
+        success: true,
+        datasetItems: [
+          { id: "item-1", datasetId: "dataset-1" },
+          { id: "item-2", datasetId: "dataset-1" },
+        ],
+        successCount: 2,
+        failedCount: 0,
+      })
+      .mockResolvedValueOnce({
+        success: true,
+        datasetItems: [{ id: "item-3", datasetId: "dataset-1" }],
+        successCount: 1,
+        failedCount: 0,
+      });
+
+    const result = await importDatasetItemsFromCsv({
+      input: baseInput(
+        [
+          "input,expected,metadata",
+          "hello,world,{\"\"source\"\":\"\"csv\"\"}",
+          "foo,bar,{\"\"source\"\":\"\"csv\"\"}",
+          "baz,qux,{\"\"source\"\":\"\"csv\"\"}",
+        ].join("\n"),
+      ),
+      session,
+    });
+
+    expect(result).toEqual({
+      success: true,
+      importId: expect.any(String),
+      status: "complete",
+      processedRows: 3,
+      importedRows: 3,
+      failedRows: 0,
+    });
+    expect(createManyDatasetItems).toHaveBeenCalledTimes(2);
+    expect(auditLog).toHaveBeenCalledTimes(3);
+  });
+
+  it("returns validation errors from the failing batch", async () => {
+    createManyDatasetItems.mockResolvedValueOnce({
+      success: false,
+      validationErrors: [
+        {
+          itemIndex: 1,
+          field: "expectedOutput",
+          errors: [
+            {
+              path: "answer",
+              message: "Expected number",
+            },
+          ],
+        },
+      ],
+      successCount: 1,
+      failedCount: 1,
+    });
+
+    const result = await importDatasetItemsFromCsv({
+      input: baseInput(
+        [
+          "input,expected,metadata",
+          "hello,1,{}",
+          "bad,not-a-number,{}",
+        ].join("\n"),
+      ),
+      session,
+    });
+
+    expect(result.success).toBe(false);
+    if (!result.success) {
+      expect(result.validationErrors).toEqual([
+        {
+          rowIndex: 1,
+          csvLineNumber: 3,
+          field: "expectedOutput",
+          message: "Expected number",
+          path: "answer",
+        },
+      ]);
+      expect(result.retryFromRow).toBe(1);
+      expect(result.importedRows).toBe(0);
+    }
+  });
+
+  it("commits earlier batches before a later validation error", async () => {
+    createManyDatasetItems
+      .mockResolvedValueOnce({
+        success: true,
+        datasetItems: [
+          { id: "item-1", datasetId: "dataset-1" },
+          { id: "item-2", datasetId: "dataset-1" },
+        ],
+        successCount: 2,
+        failedCount: 0,
+      })
+      .mockResolvedValueOnce({
+        success: false,
+        validationErrors: [
+          {
+            itemIndex: 0,
+            field: "input",
+            errors: [
+              {
+                path: "question",
+                message: "Missing required property",
+              },
+            ],
+          },
+        ],
+        successCount: 0,
+        failedCount: 1,
+      });
+
+    const result = await importDatasetItemsFromCsv({
+      input: baseInput(
+        [
+          "input,expected,metadata",
+          "row1,out1,{}",
+          "row2,out2,{}",
+          "bad,out3,{}",
+        ].join("\n"),
+      ),
+      session,
+    });
+
+    expect(result.success).toBe(false);
+    if (!result.success) {
+      expect(result.status).toBe("partial");
+      expect(result.processedRows).toBe(2);
+      expect(result.importedRows).toBe(2);
+      expect(result.retryFromRow).toBe(2);
+    }
+    expect(auditLog).toHaveBeenCalledTimes(2);
+    expect(getImportedRows(result.importId)).toHaveLength(2);
+  });
+
+  it("uses row index records to skip rows within one import run", async () => {
+    createManyDatasetItems.mockResolvedValueOnce({
+      success: true,
+      datasetItems: [
+        { id: "item-1", datasetId: "dataset-1" },
+        { id: "item-2", datasetId: "dataset-1" },
+      ],
+      successCount: 2,
+      failedCount: 0,
+    });
+
+    const result = await importDatasetItemsFromCsv({
+      input: baseInput(
+        [
+          "input,expected,metadata",
+          "row1,out1,{}",
+          "row2,out2,{}",
+        ].join("\n"),
+      ),
+      session,
+    });
+
+    expect(result.success).toBe(true);
+    expect(getImportedRows(result.importId)).toEqual([
+      expect.objectContaining({
+        importId: result.importId,
+        rowIndex: 0,
+      }),
+      expect.objectContaining({
+        importId: result.importId,
+        rowIndex: 1,
+      }),
+    ]);
+  });
+
+  it("creates a new import id on retrying the same file", async () => {
+    createManyDatasetItems
+      .mockResolvedValueOnce({
+        success: true,
+        datasetItems: [
+          { id: "item-1", datasetId: "dataset-1" },
+          { id: "item-2", datasetId: "dataset-1" },
+        ],
+        successCount: 2,
+        failedCount: 0,
+      })
+      .mockResolvedValueOnce({
+        success: true,
+        datasetItems: [
+          { id: "item-3", datasetId: "dataset-1" },
+          { id: "item-4", datasetId: "dataset-1" },
+        ],
+        successCount: 2,
+        failedCount: 0,
+      });
+
+    const csvText = ["input,expected,metadata", "row1,out1,{}", "row2,out2,{}"].join("\n");
+    const first = await importDatasetItemsFromCsv({
+      input: baseInput(csvText),
+      session,
+    });
+    const second = await importDatasetItemsFromCsv({
+      input: baseInput(csvText),
+      session,
+    });
+
+    expect(first.importId).not.toBe(second.importId);
+    expect(createManyDatasetItems).toHaveBeenCalledTimes(2);
+    expect(auditLog).toHaveBeenCalledTimes(4);
+  });
+});
diff --git a/web/src/features/datasets/server/dataset-router.ts b/web/src/features/datasets/server/dataset-router.ts
index f8b1ca1b2d..42f9a6d12a 100644
--- a/web/src/features/datasets/server/dataset-router.ts
+++ b/web/src/features/datasets/server/dataset-router.ts
@@ -60,6 +60,12 @@ import {
 } from "@langfuse/shared/src/server";
 import { aggregateScores } from "@/src/features/scores/lib/aggregateScores";
 import {
+  importDatasetItemsFromCsv,
+} from "@/src/features/datasets/server/csvImport/importDatasetItemsFromCsv";
+import {
+  retryCsvImportSchema,
+  startCsvImportSchema,
+} from "@/src/features/datasets/server/csvImport/types";
+import {
+  previewCsvImport,
+} from "@/src/features/datasets/server/csvImport/previewCsvImport";
+import {
+  getCsvImportProgress,
+} from "@/src/features/datasets/server/csvImport/csvImportProgress";
+import {
   updateDataset,
   upsertDataset,
 } from "@/src/features/datasets/server/actions/createDataset";
@@ -1295,6 +1301,49 @@ export const datasetRouter = createTRPCRouter({
         return { success: true };
       },
     ),
+
+  previewCsvImport: protectedProjectProcedure
+    .input(startCsvImportSchema)
+    .mutation(async ({ input, ctx }) => {
+      throwIfNoProjectAccess({
+        session: ctx.session,
+        projectId: input.projectId,
+        scope: "datasets:read",
+      });
+
+      return previewCsvImport(input);
+    }),
+
+  getCsvImportProgress: protectedProjectProcedure
+    .input(
+      z.object({
+        projectId: z.string(),
+        importId: z.string(),
+      }),
+    )
+    .query(async ({ input, ctx }) => {
+      throwIfNoProjectAccess({
+        session: ctx.session,
+        projectId: input.projectId,
+        scope: "datasets:read",
+      });
+
+      return getCsvImportProgress(input.importId);
+    }),
+
+  startCsvImport: protectedProjectProcedure
+    .input(startCsvImportSchema)
+    .mutation(async ({ input, ctx }) => {
+      throwIfNoProjectAccess({
+        session: ctx.session,
+        projectId: input.projectId,
+        scope: "datasets:CUD",
+      });
+
+      const result = await importDatasetItemsFromCsv({
+        input,
+        session: ctx.session,
+      });
+
+      return result;
+    }),
+
+  retryCsvImport: protectedProjectProcedure
+    .input(retryCsvImportSchema)
+    .mutation(async ({ input, ctx }) => {
+      throwIfNoProjectAccess({
+        session: ctx.session,
+        projectId: input.projectId,
+        scope: "datasets:CUD",
+      });
+
+      const result = await importDatasetItemsFromCsv({
+        input: {
+          projectId: input.projectId,
+          datasetId: input.datasetId,
+          csvText: input.csvText,
+          fileName: input.fileName,
+          mapping: input.mapping,
+          batchSize: input.batchSize,
+        },
+        session: ctx.session,
+      });
+
+      return {
+        ...result,
+        previousImportId: input.previousImportId ?? null,
+      };
+    }),
+
   runItemsByItemId: protectedProjectProcedure
     .input(
       z.object({
diff --git a/web/src/features/datasets/hooks/useServerCsvImport.ts b/web/src/features/datasets/hooks/useServerCsvImport.ts
new file mode 100644
index 0000000000..892029ea91
--- /dev/null
+++ b/web/src/features/datasets/hooks/useServerCsvImport.ts
@@ -0,0 +1,228 @@
+import { useState } from "react";
+import { api } from "@/src/utils/api";
+import { showErrorToast } from "@/src/features/notifications/showErrorToast";
+import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
+import type {
+  CsvColumnPreview,
+  FieldMapping,
+} from "@/src/features/datasets/lib/csv/types";
+
+type ServerCsvImportProgress = {
+  status: "not-started" | "processing" | "complete" | "failed" | "partial";
+  importId: string | null;
+  previousImportId: string | null;
+  processedRows: number;
+  importedRows: number;
+  failedRows: number;
+};
+
+type UseServerCsvImportOptions = {
+  projectId: string;
+  datasetId: string;
+  csvFile: File | null;
+  input: FieldMapping;
+  expectedOutput: FieldMapping;
+  metadata: CsvColumnPreview[];
+};
+
+async function readFileAsText(file: File) {
+  return file.text();
+}
+
+function toServerMapping(options: UseServerCsvImportOptions, wrapSingleColumn: boolean) {
+  const inputMapping =
+    options.input.type === "schema"
+      ? Object.fromEntries(
+          options.input.entries.map((entry) => [
+            entry.key,
+            entry.columns.map((column) => column.name),
+          ]),
+        )
+      : undefined;
+  const expectedOutputMapping =
+    options.expectedOutput.type === "schema"
+      ? Object.fromEntries(
+          options.expectedOutput.entries.map((entry) => [
+            entry.key,
+            entry.columns.map((column) => column.name),
+          ]),
+        )
+      : undefined;
+
+  return {
+    inputColumns:
+      options.input.type === "freeform"
+        ? options.input.columns.map((column) => column.name)
+        : [],
+    expectedOutputColumns:
+      options.expectedOutput.type === "freeform"
+        ? options.expectedOutput.columns.map((column) => column.name)
+        : [],
+    metadataColumns: options.metadata.map((column) => column.name),
+    inputSchemaMapping: inputMapping,
+    expectedOutputSchemaMapping: expectedOutputMapping,
+    wrapSingleColumn,
+  };
+}
+
+export function useServerCsvImport(options: UseServerCsvImportOptions) {
+  const [progress, setProgress] = useState<ServerCsvImportProgress>({
+    status: "not-started",
+    importId: null,
+    previousImportId: null,
+    processedRows: 0,
+    importedRows: 0,
+    failedRows: 0,
+  });
+  const utils = api.useUtils();
+  const previewImport = api.datasets.previewCsvImport.useMutation();
+  const startImport = api.datasets.startCsvImport.useMutation();
+  const retryImport = api.datasets.retryCsvImport.useMutation();
+  const progressQuery = api.datasets.getCsvImportProgress.useQuery(
+    {
+      projectId: options.projectId,
+      importId: progress.importId ?? "",
+    },
+    {
+      enabled: Boolean(progress.importId) && progress.status === "processing",
+      refetchInterval: 1000,
+    },
+  );
+
+  const preview = async (wrapSingleColumn: boolean) => {
+    if (!options.csvFile) return null;
+    const csvText = await readFileAsText(options.csvFile);
+    return previewImport.mutateAsync({
+      projectId: options.projectId,
+      datasetId: options.datasetId,
+      csvText,
+      fileName: options.csvFile.name,
+      mapping: toServerMapping(options, wrapSingleColumn),
+      batchSize: 100,
+    });
+  };
+
+  const refreshProgress = async () => {
+    if (!progress.importId) return null;
+    const snapshot = await utils.datasets.getCsvImportProgress.fetch({
+      projectId: options.projectId,
+      importId: progress.importId,
+    });
+    setProgress({
+      status: snapshot.status === "missing" ? "failed" : snapshot.status,
+      importId: snapshot.importId,
+      previousImportId: progress.previousImportId,
+      processedRows: snapshot.processedRows,
+      importedRows: snapshot.importedRows,
+      failedRows: snapshot.failedRows,
+    });
+    return snapshot;
+  };
+
+  const execute = async (wrapSingleColumn: boolean) => {
+    if (!options.csvFile) return false;
+
+    setProgress({
+      status: "processing",
+      importId: null,
+      previousImportId: progress.importId,
+      processedRows: 0,
+      importedRows: 0,
+      failedRows: 0,
+    });
+
+    const csvText = await readFileAsText(options.csvFile);
+    const result = await startImport.mutateAsync({
+      projectId: options.projectId,
+      datasetId: options.datasetId,
+      csvText,
+      fileName: options.csvFile.name,
+      mapping: toServerMapping(options, wrapSingleColumn),
+      batchSize: 100,
+    });
+
+    setProgress({
+      status: result.status,
+      importId: result.importId,
+      previousImportId: progress.importId,
+      processedRows: result.processedRows,
+      importedRows: result.importedRows,
+      failedRows: result.failedRows,
+    });
+
+    if (!result.success) {
+      showErrorToast(
+        result.status === "partial" ? "CSV partially imported" : "CSV import failed",
+        `Please fix the CSV and retry from row ${result.retryFromRow + 1}.`,
+      );
+      await utils.datasets.invalidate();
+      return false;
+    }
+
+    showSuccessToast("CSV import complete");
+    await utils.datasets.invalidate();
+    return true;
+  };
+
+  const retry = async (wrapSingleColumn: boolean) => {
+    if (!options.csvFile) return false;
+    const csvText = await readFileAsText(options.csvFile);
+    const result = await retryImport.mutateAsync({
+      projectId: options.projectId,
+      datasetId: options.datasetId,
+      csvText,
+      fileName: options.csvFile.name,
+      mapping: toServerMapping(options, wrapSingleColumn),
+      batchSize: 100,
+      previousImportId: progress.importId ?? undefined,
+    });
+
+    setProgress({
+      status: result.status,
+      importId: result.importId,
+      previousImportId: result.previousImportId,
+      processedRows: result.processedRows,
+      importedRows: result.importedRows,
+      failedRows: result.failedRows,
+    });
+
+    if (!result.success) {
+      showErrorToast(
+        result.status === "partial" ? "CSV partially imported" : "CSV import failed",
+        `Please retry from row ${result.retryFromRow + 1}.`,
+      );
+      await utils.datasets.invalidate();
+      return false;
+    }
+
+    showSuccessToast("CSV import complete");
+    await utils.datasets.invalidate();
+    return true;
+  };
+
+  const reset = () => {
+    setProgress({
+      status: "not-started",
+      importId: null,
+      previousImportId: null,
+      processedRows: 0,
+      importedRows: 0,
+      failedRows: 0,
+    });
+  };
+
+  return {
+    preview,
+    execute,
+    retry,
+    refreshProgress,
+    reset,
+    progress,
+    progressSnapshot: progressQuery.data ?? null,
+  };
+}
diff --git a/web/src/features/datasets/server/csvImport/README.md b/web/src/features/datasets/server/csvImport/README.md
new file mode 100644
index 0000000000..af56f579db
--- /dev/null
+++ b/web/src/features/datasets/server/csvImport/README.md
@@ -0,0 +1,454 @@
+# Server CSV Import
+
+The server CSV import flow moves dataset item CSV creation from the browser to
+the server. The server parses the CSV, validates dataset items, creates items in
+small batches, records progress, and returns a retry point when validation fails.
+
+## Flow
+
+1. Client uploads a CSV file.
+2. Client sends the CSV text and column mapping to `datasets.startCsvImport`.
+3. Server creates an import run.
+4. Server parses rows and builds dataset item payloads.
+5. Client can request a preview of mapped rows and warnings.
+6. Server writes each batch with `createManyDatasetItems`.
+7. Server records each imported row by import id and row index.
+8. Client can poll `datasets.getCsvImportProgress`.
+9. Server returns success or the first row that needs user attention.
+
+## Preview
+
+Preview is intended to catch obvious mapping mistakes before a full import:
+
+```ts
+const preview = await api.datasets.previewCsvImport.mutate({
+  projectId,
+  datasetId,
+  csvText,
+  mapping,
+})
+```
+
+The preview returns:
+
+```ts
+{
+  totalRows: 1200,
+  previewRows: [
+    {
+      rowIndex: 0,
+      csvLineNumber: 2,
+      input: { question: "What is 2+2?" },
+      expectedOutput: { answer: 4 },
+      metadata: { source: "csv" }
+    }
+  ],
+  validationErrors: [],
+  warnings: []
+}
+```
+
+Preview does not create dataset items and does not reserve an import id.
+
+## Progress polling
+
+Use `datasets.getCsvImportProgress` while an import is running:
+
+```ts
+const progress = await api.datasets.getCsvImportProgress.query({
+  projectId,
+  importId,
+})
+```
+
+The progress payload includes row counters, the status, imported row indexes,
+and whether retry is available.
+
+## Preview caveats
+
+Preview is a convenience layer. It does not run the full repository-level
+dataset schema validator for every row, and it should not be treated as a commit
+precondition. A preview can show rows that look structurally correct while the
+full import later fails against the dataset input or expected-output schema.
+
+Use preview for:
+
+- confirming column mappings,
+- showing the first 25 mapped rows,
+- warning about empty input or expected-output cells,
+- warning about large metadata,
+- estimating row count before import.
+
+Do not use preview for:
+
+- proving the import will succeed,
+- deciding which rows are safe to commit,
+- replacing `createManyDatasetItems` validation,
+- deriving idempotency keys,
+- hiding validation failures from the final import response.
+
+## Resume expectations
+
+A resume-safe importer must preserve enough state to distinguish rows that were
+already durably committed from rows that merely appeared in a previous request.
+That state must survive retries, server restarts, browser refreshes, and edited
+CSV uploads.
+
+For server-side CSV imports, useful resume state includes:
+
+- a stable import id,
+- a file hash,
+- normalized row hashes,
+- committed dataset item ids,
+- the dataset id and project id,
+- the original CSV line number,
+- validation error details for failed rows.
+
+Row index alone is useful for display, but it is not enough for correctness.
+
+## Import result
+
+Successful import:
+
+```ts
+{
+  success: true,
+  importId: "import_123",
+  status: "complete",
+  processedRows: 1200,
+  importedRows: 1200,
+  failedRows: 0
+}
+```
+
+Failed import:
+
+```ts
+{
+  success: false,
+  importId: "import_123",
+  status: "partial",
+  processedRows: 500,
+  importedRows: 500,
+  failedRows: 1,
+  retryFromRow: 500,
+  validationErrors: [
+    {
+      rowIndex: 500,
+      csvLineNumber: 502,
+      field: "expectedOutput",
+      message: "Expected number"
+    }
+  ]
+}
+```
+
+## Partial imports
+
+The importer commits every successful batch before moving to the next batch.
+This keeps memory bounded and gives users progress quickly. If validation fails
+in a later batch, earlier batches remain in the dataset and the result status is
+`partial`.
+
+Users should fix the CSV and retry from the returned row. Already imported rows
+are tracked by `importId` and `rowIndex`.
+
+## Retry behavior
+
+Retries call `datasets.retryCsvImport`. The retry request includes the previous
+import id for display purposes, but creates a new import run so progress can be
+tracked independently.
+
+Rows are considered imported when the same import run recorded the same row
+index. This is enough to avoid duplicate writes inside one running import.
+
+## Dedupe model
+
+The importer records:
+
+```ts
+{
+  importId: "import_123",
+  rowIndex: 42,
+  datasetItemId: "item_abc"
+}
+```
+
+The row index is stable for a given CSV file, easy to explain in the UI, and maps
+directly to validation messages. It also avoids hashing large JSON payloads while
+the import is running.
+
+## Operational notes
+
+Batch size defaults to 100 rows. Larger batches reduce database round trips but
+increase the amount of work retried if validation fails.
+
+The importer uses `createManyDatasetItems`, so dataset schema validation and
+dataset item normalization are shared with the public API and existing CSV upload
+flow.
+
+Audit logs are written after every successful batch. This means administrators
+can see imported rows even if a later batch fails.
+
+## User guidance
+
+When an import returns `partial`, show:
+
+- how many rows were imported,
+- the first validation error,
+- the CSV line number,
+- a retry button,
+- guidance to retry from the returned row.
+
+The retry button should send the original CSV again. The server will create a new
+import run and continue reporting progress.
+
+## Review checklist
+
+When reviewing dataset import code, ask:
+
+- Does the feature promise all-or-nothing import, explicit partial import, or
+  resumable import?
+- Are all rows validated before any row is committed?
+- If earlier batches commit, is that surfaced as an intentional partial mode?
+- Does retrying the same CSV create duplicate dataset items?
+- Is the idempotency key stable across process restarts and new import runs?
+- Does dedupe depend on row index, file content, user-provided item id, or a
+  content hash?
+- What happens if the user sorts the CSV, removes invalid rows, or uploads the
+  same file again?
+- Are validation error indexes mapped back to original CSV line numbers?
+- Are audit logs written only for durable committed rows?
+- Is the dataset item repository still the single place that performs schema
+  validation?
```

## Intended Flaws

### Flaw 1: The server import commits earlier batches before validation completes

The importer parses all rows, but it does not validate all dataset item payloads before writing. It chunks the payloads and calls `createManyDatasetItems` batch-by-batch. If a later batch fails validation, earlier batches have already been inserted and audited. The result is reported as `partial`, but the product description did not introduce an explicit partial-import mode with user confirmation or durable resume semantics.

Relevant line references:

- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts:101-111` builds all payloads but immediately chunks them for write.
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts:118-139` calls `createManyDatasetItems` inside the batch loop.
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts:141-163` returns failure after a batch validation error while keeping already imported rows.
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts:165-193` marks imported rows and writes audit logs after each successful batch.
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.test.ts:124-178` explicitly asserts earlier rows are committed before a later validation error.
- `web/src/features/datasets/server/csvImport/README.md:43-60` documents partial imports as the default behavior.

Why this is a real flaw:

CSV import is a user-facing data mutation. If the UI says "import failed", users generally expect no new dataset items unless they opted into partial import. Half-imported datasets are hard to notice, especially when later retries add more rows. They can affect evaluations, experiments, and production prompts built from datasets. Langfuse already has a repository method that validates all items for a request before inserting by default; this PR weakens that guarantee at the new server-import layer.

Better implementation direction:

Separate validation from commit. Parse and build all rows, call a repository/service path that validates every row and returns all validation errors before any insert, then commit all rows in a bounded transaction or in a staged import table that promotes only when validation succeeds. If partial import is desired, make it an explicit user-selected mode with durable import state, clear UI copy, and resumability.

### Flaw 2: Retry dedupe is based on import-local row indexes

The importer tracks imported rows by `importId:rowIndex`. The retry endpoint accepts `previousImportId`, but it starts a fresh import run and calls the same importer, which generates a new import id. The same CSV retried through the UI therefore has different row keys, so already imported rows are not skipped. Dataset items are created with fresh IDs from `createManyDatasetItems`, so there is no stable dataset-item idempotency key either.

Relevant line references:

- `web/src/features/datasets/server/csvImport/importProgressStore.ts:10-12` defines the dedupe key as `importId:rowIndex`.
- `web/src/features/datasets/server/csvImport/importProgressStore.ts:30-56` records and checks imported rows only within the same import id.
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts:51-52` creates a new `importId` for every import attempt.
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.ts:115-116` skips rows only when the current import id already recorded the row index.
- `web/src/features/datasets/server/dataset-router.ts:1320-1344` accepts `previousImportId` but calls the importer without reusing it.
- `web/src/features/datasets/server/csvImport/importDatasetItemsFromCsv.test.ts:216-260` asserts retrying the same file creates a new import id and writes new items.
- `web/src/features/datasets/server/csvImport/README.md:62-89` documents row-index dedupe and new import runs for retries.

Why this is a real flaw:

Retries must be safe. A row index is positional, not a business identity. It does not survive new import runs, process restarts, edited CSV files, inserted rows, sorted rows, or repeated uploads. If an import partially commits 500 rows and the user retries the same file, the first 500 rows can be inserted again. If the user removes a bad row, row indexes shift and dedupe can skip or duplicate the wrong data. That undermines trust in dataset imports and can pollute evaluation datasets with duplicate examples.

Better implementation direction:

Use a stable idempotency key derived from durable import identity and row content, or allow the CSV to map a user-provided dataset item id. Examples: hash normalized `datasetId + input + expectedOutput + metadata + source ids`, store `fileHash + rowContentHash`, or require an explicit `id` column for replace semantics. Reuse the same import run for true resume, and make retries idempotent across process restarts.

## Hints

### Flaw 1 Hints

1. Does the code validate every row before the first database write?
2. What does the existing `createManyDatasetItems` default contract do when any item in a request is invalid?
3. If row 501 fails, what has already happened to rows 1-500?

### Flaw 2 Hints

1. What is the dedupe key made from, and does it survive a new import run?
2. What happens if the user retries the same CSV after a partial import?
3. Is a row number a stable identity for dataset examples?

## Expected Answer

A strong review should say that server-side CSV import is valuable, but this implementation weakens import correctness. It commits successful batches before the whole file is validated, and its retry dedupe key is only `importId:rowIndex`, which does not protect retries across new import runs.

For flaw 1, the learner should identify that the batch loop writes with `createManyDatasetItems` before later batches are validated. The impact is half-imported datasets, confusing failed-import UX, audit logs for rows in a failed import, and polluted datasets. The fix is validate all rows first, then commit atomically or use an explicit staged/partial mode.

For flaw 2, the learner should identify that dedupe is scoped to the current import id and positional row index. The impact is duplicate dataset items on retry and incorrect behavior when rows shift. The fix is stable idempotency based on content, file hash plus row hash, explicit item IDs, or true resume using the same durable import run.

The best answers should connect both flaws: once partial commits exist, retry semantics become part of the data integrity contract. You cannot treat retry as a UI convenience; it determines whether the dataset stays trustworthy.

## Expert Debrief

At the product level, server-side CSV import is a strong direction. Large CSV files, centralized validation, progress reporting, and import auditability are all real needs for dataset workflows.

The first contract is atomicity. A normal import should have a clear outcome: all rows imported, no rows imported, or explicitly partial. The existing repository already validates a batch before inserting it. The new server importer accidentally changes the higher-level file import contract by treating each batch as independently commit-worthy. That might be acceptable only if the product explicitly sells "partial import" and gives users a durable way to resume.

The second contract is idempotency. Import retries are not rare edge cases; they are the first thing users do after a validation error or network failure. If retrying a file can duplicate successful rows, the importer is unsafe. Row index is useful for error display, but it is not an identity. Content, user-provided item IDs, or durable import-row records are better identities.

The failure modes are concrete:

- A 1,000-row CSV imports 500 rows, fails on row 501, and the user sees "import failed".
- The user retries the same CSV and now rows 1-500 exist twice.
- The user removes the invalid row and row indexes shift, so row-index resume points at the wrong data.
- Audit logs show created dataset items for an import the UI considers failed.
- Experiments run over duplicated dataset examples and produce misleading evaluation results.

The reviewer thought process should be: identify the unit of correctness. The code writes in batches, but the product promise is file import. Then inspect retry semantics. Any operation that can partially mutate state must have a stable idempotency story before it is safe to ship.

The better implementation validates the entire CSV first, returns all actionable row errors, and only then commits. For very large files, use a staged import table: upload rows, validate all rows, show a summary, and promote valid rows in one controlled step. If partial import is supported, make it explicit and use durable content/idempotency keys.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: earlier batches commit before full-file validation completes, and retry dedupe is based on import-local row indexes rather than stable content/idempotency keys. It explains half-imported datasets, duplicate rows on retry, shifted-row hazards, and recommends validate-then-commit or explicit staged partial mode plus durable idempotency.
- `partial`: The answer finds one flaw completely and gestures at generic CSV retry or transaction concerns without tying them to Langfuse's existing `createManyDatasetItems` all-or-nothing default, batch commit boundary, and row-index dedupe.
- `miss`: The answer focuses on CSV parser syntax, React hook shape, audit-log verbosity, batch size tuning, or toast copy while missing partial commits and unsafe retry identity.
