# TS-011: Langfuse Trace Status Filter

## Metadata

- `id`: TS-011
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: ClickHouse trace table, legacy Prisma trace table, ingestion mapping, trace domain schema, traces table service, filter definitions, trace router tests
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 748
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about schema evolution, nullable historical data, ClickHouse mutations, staged rollouts, table filters, and migration backfills without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds trace status.

Customers can now filter traces by `SUCCESS`, `WARNING`, or `ERROR`. The status is derived during ingestion from the most severe observation level on the trace, stored on the trace row, and exposed in trace list/detail responses.

The PR adds:

- a `status` column to ClickHouse traces and legacy Postgres traces,
- a migration that backfills existing traces to `SUCCESS`,
- status derivation in ingestion,
- status in trace domain schemas and conversion helpers,
- trace table column/filter mappings,
- status filtering in trace list/count/filter-option endpoints,
- tests for trace status display, filter options, and filtering.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `packages/shared/clickhouse/migrations/unclustered/0001_traces.up.sql` creates the ClickHouse `traces` table. It is a `ReplacingMergeTree` partitioned by `toYYYYMM(timestamp)` and ordered by project/date/id.
- `packages/shared/src/server/services/traces-ui-table-service.ts` is the central trace table query path. `getTracesTable`, `getTracesTableCount`, `getTracesTableMetrics`, and `getTraceIdentifiers` all flow through `getTracesTableGeneric`.
- `packages/shared/src/tableDefinitions/tracesTable.ts` and `packages/shared/src/server/tableMappings/mapTracesTable.ts` define the TypeScript schema for which UI filters map to which ClickHouse columns.
- `packages/shared/src/server/repositories/definitions.ts` defines `traceRecordReadSchema` and `traceRecordInsertSchema`; `traces_converters.ts` maps ClickHouse trace records into `TraceDomain`.
- `worker/src/services/IngestionService/index.ts` merges trace events, writes ClickHouse trace records, and already derives aggregate trace-level facts from observations.
- `packages/shared/prisma/schema.prisma` still contains `LegacyPrismaTrace`, and `worker/src/backgroundMigrations/migrateTracesFromPostgresToClickhouse.ts` shows that historical trace migration is handled in resumable batches.
- `packages/shared/prisma/migrations/20230618125818_remove_status_from_trace/migration.sql` previously removed trace-level `status` and `status_message` from the legacy traces table.
- `packages/shared/prisma/migrations/20241024173000_add_traces_pg_to_ch_background_migration/migration.sql` registers the trace Postgres-to-ClickHouse migration as a background migration instead of doing the data movement inside the schema migration.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/shared/clickhouse/migrations/unclustered/0030_add_trace_status.up.sql`
- `packages/shared/clickhouse/migrations/clustered/0030_add_trace_status.up.sql`
- `packages/shared/prisma/migrations/20260509090000_add_trace_status/migration.sql`
- `packages/shared/prisma/schema.prisma`
- `packages/shared/src/domain/traces.ts`
- `packages/shared/src/server/repositories/definitions.ts`
- `packages/shared/src/server/repositories/traces_converters.ts`
- `packages/shared/src/server/repositories/traces.ts`
- `packages/shared/src/tableDefinitions/tracesTable.ts`
- `packages/shared/src/server/tableMappings/mapTracesTable.ts`
- `packages/shared/src/server/services/traces-ui-table-service.ts`
- `worker/src/services/IngestionService/index.ts`
- `web/src/server/api/routers/traces.ts`
- `web/src/__tests__/server/traces-status.servertest.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on migration safety, compatibility with old rows, and query behavior.

## Diff

```diff
diff --git a/packages/shared/clickhouse/migrations/unclustered/0030_add_trace_status.up.sql b/packages/shared/clickhouse/migrations/unclustered/0030_add_trace_status.up.sql
new file mode 100644
index 0000000000..75d5296a22
--- /dev/null
+++ b/packages/shared/clickhouse/migrations/unclustered/0030_add_trace_status.up.sql
@@ -0,0 +1,37 @@
+ALTER TABLE traces
+  ADD COLUMN IF NOT EXISTS status Nullable(String) AFTER environment;
+
+ALTER TABLE traces
+  ADD INDEX IF NOT EXISTS idx_trace_status status TYPE set(16) GRANULARITY 4;
+
+ALTER TABLE traces
+  UPDATE status = 'SUCCESS'
+  WHERE status IS NULL
+  SETTINGS mutations_sync = 2;
+
+ALTER TABLE traces
+  MATERIALIZE INDEX IF EXISTS idx_trace_status
+  SETTINGS mutations_sync = 2;
diff --git a/packages/shared/clickhouse/migrations/clustered/0030_add_trace_status.up.sql b/packages/shared/clickhouse/migrations/clustered/0030_add_trace_status.up.sql
new file mode 100644
index 0000000000..ac84072351
--- /dev/null
+++ b/packages/shared/clickhouse/migrations/clustered/0030_add_trace_status.up.sql
@@ -0,0 +1,43 @@
+ALTER TABLE traces ON CLUSTER default
+  ADD COLUMN IF NOT EXISTS status Nullable(String) AFTER environment
+  SETTINGS alter_sync = 2;
+
+ALTER TABLE traces ON CLUSTER default
+  ADD INDEX IF NOT EXISTS idx_trace_status status TYPE set(16) GRANULARITY 4
+  SETTINGS alter_sync = 2;
+
+ALTER TABLE traces ON CLUSTER default
+  UPDATE status = 'SUCCESS'
+  WHERE status IS NULL
+  SETTINGS mutations_sync = 2;
+
+ALTER TABLE traces ON CLUSTER default
+  MATERIALIZE INDEX IF EXISTS idx_trace_status
+  SETTINGS mutations_sync = 2;
diff --git a/packages/shared/prisma/migrations/20260509090000_add_trace_status/migration.sql b/packages/shared/prisma/migrations/20260509090000_add_trace_status/migration.sql
new file mode 100644
index 0000000000..26125592c8
--- /dev/null
+++ b/packages/shared/prisma/migrations/20260509090000_add_trace_status/migration.sql
@@ -0,0 +1,45 @@
+BEGIN;
+
+ALTER TABLE "traces"
+  ADD COLUMN IF NOT EXISTS "status" TEXT;
+
+UPDATE "traces"
+SET "status" = 'SUCCESS'
+WHERE "status" IS NULL;
+
+ALTER TABLE "traces"
+  ALTER COLUMN "status" SET NOT NULL;
+
+ALTER TABLE "traces"
+  ALTER COLUMN "status" SET DEFAULT 'SUCCESS';
+
+CREATE INDEX IF NOT EXISTS "traces_project_id_status_timestamp_idx"
+  ON "traces" ("project_id", "status", "timestamp" DESC);
+
+COMMIT;
diff --git a/packages/shared/prisma/schema.prisma b/packages/shared/prisma/schema.prisma
index cb84e83b9e..a496076d22 100644
--- a/packages/shared/prisma/schema.prisma
+++ b/packages/shared/prisma/schema.prisma
@@ -329,6 +329,7 @@ model LegacyPrismaTrace {
   project    Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
   public     Boolean  @default(false)
   bookmarked Boolean  @default(false)
+  status     String   @default("SUCCESS")
   tags       String[] @default([])
   input      Json?
   output     Json?
@@ -343,6 +344,7 @@ model LegacyPrismaTrace {
   @@index([name])
   @@index([userId])
   @@index([id, userId])
+  @@index([projectId, status, timestamp(sort: Desc)])
   @@index(timestamp)
   @@index(createdAt)
   @@index([tags(ops: ArrayOps)], type: Gin)
diff --git a/packages/shared/src/domain/traces.ts b/packages/shared/src/domain/traces.ts
index 701903e59d..cba49558bd 100644
--- a/packages/shared/src/domain/traces.ts
+++ b/packages/shared/src/domain/traces.ts
@@ -6,6 +6,12 @@ export const MetadataDomain = z.record(
 
 export type MetadataDomain = z.infer<typeof MetadataDomain>;
 
+export const TraceStatus = z.enum(["SUCCESS", "WARNING", "ERROR"]);
+
+export type TraceStatus = z.infer<typeof TraceStatus>;
+
 // to be used across the application in frontend and backend.
 export const TraceDomain = z.object({
   id: z.string(),
@@ -15,6 +21,7 @@ export const TraceDomain = z.object({
   tags: z.array(z.string()),
   bookmarked: z.boolean(),
   public: z.boolean(),
+  status: TraceStatus,
   release: z.string().nullable(),
   version: z.string().nullable(),
   input: jsonSchema.nullable(),
diff --git a/packages/shared/src/server/repositories/definitions.ts b/packages/shared/src/server/repositories/definitions.ts
index eabfc8aa70..2ac86b9201 100644
--- a/packages/shared/src/server/repositories/definitions.ts
+++ b/packages/shared/src/server/repositories/definitions.ts
@@ -119,6 +119,7 @@ export const traceRecordBaseSchema = z.object({
   project_id: z.string(),
   environment: z.string().default("default"),
   public: z.boolean(),
+  status: z.enum(["SUCCESS", "WARNING", "ERROR"]),
   bookmarked: z.boolean(),
   tags: z.array(z.string()),
   input: z.string().nullish(),
diff --git a/packages/shared/src/server/repositories/traces_converters.ts b/packages/shared/src/server/repositories/traces_converters.ts
index 74df44453b..21be6f6174 100644
--- a/packages/shared/src/server/repositories/traces_converters.ts
+++ b/packages/shared/src/server/repositories/traces_converters.ts
@@ -19,6 +19,7 @@ export const convertTraceDomainToClickhouse = (
     project_id: trace.projectId,
     public: trace.public,
     bookmarked: trace.bookmarked,
+    status: trace.status,
     tags: trace.tags,
     input: trace.input as string,
     output: trace.output as string,
@@ -47,6 +48,7 @@ export const convertClickhouseToDomain = (
     tags: record.tags,
     bookmarked: record.bookmarked,
     release: record.release ?? null,
+    status: record.status,
     version: record.version ?? null,
     userId: record.user_id ?? null,
     sessionId: record.session_id ?? null,
diff --git a/packages/shared/src/server/repositories/traces.ts b/packages/shared/src/server/repositories/traces.ts
index 91fd158433..66d3c248cc 100644
--- a/packages/shared/src/server/repositories/traces.ts
+++ b/packages/shared/src/server/repositories/traces.ts
@@ -533,6 +533,7 @@ export const getTraceById = async ({
           project_id,
           environment,
           public as public,
+          status as status,
           bookmarked as bookmarked,
           tags,
           ${inputColumn} as input,
@@ -607,6 +608,72 @@ export const getTraceById = async ({
   return res.shift();
 };
 
+export const getTracesGroupedByStatus = async (
+  projectId: string,
+  tableDefinitions: UiColumnMappings = tracesTableUiColumnDefinitions,
+  timestampFilter?: FilterState,
+) => {
+  const chFilter = timestampFilter
+    ? createFilterFromFilterState(timestampFilter, tableDefinitions)
+    : undefined;
+
+  const timestampFilterRes = chFilter
+    ? new FilterList(chFilter).apply()
+    : undefined;
+
+  return measureAndReturn({
+    operationName: "getTracesGroupedByStatus",
+    projectId,
+    input: {
+      params: {
+        projectId,
+        ...(timestampFilterRes ? timestampFilterRes.params : {}),
+      },
+      tags: {
+        feature: "tracing",
+        type: "trace",
+        kind: "analytic",
+        projectId,
+        operation_name: "getTracesGroupedByStatus",
+      },
+    },
+    fn: async (input) => {
+      const query = `
+        SELECT
+          status as status,
+          count(*) as count
+        FROM traces t
+        WHERE t.project_id = {projectId: String}
+        AND t.status IN ('SUCCESS', 'WARNING', 'ERROR')
+        ${timestampFilterRes?.query ? `AND ${timestampFilterRes.query}` : ""}
+        GROUP BY status
+        ORDER BY count desc
+      `;
+
+      const rows = await queryClickhouse<{
+        status: "SUCCESS" | "WARNING" | "ERROR";
+        count: string;
+      }>({
+        query,
+        params: input.params,
+        tags: input.tags,
+        preferredClickhouseService: "ReadOnly",
+      });
+
+      const present = new Set(rows.map((row) => row.status));
+      return [
+        ...rows,
+        ...(["SUCCESS", "WARNING", "ERROR"] as const)
+          .filter((status) => !present.has(status))
+          .map((status) => ({
+            status,
+            count: "0",
+          })),
+      ];
+    },
+  });
+};
diff --git a/packages/shared/src/tableDefinitions/tracesTable.ts b/packages/shared/src/tableDefinitions/tracesTable.ts
diff --git a/packages/shared/src/tableDefinitions/tracesTable.ts b/packages/shared/src/tableDefinitions/tracesTable.ts
index 5d4d1dc901..7287b309ad 100644
--- a/packages/shared/src/tableDefinitions/tracesTable.ts
+++ b/packages/shared/src/tableDefinitions/tracesTable.ts
@@ -28,6 +28,16 @@ export const tracesOnlyCols: ColumnDefinition[] = [
     internal: 't."environment"',
     options: [], // to be filled in at runtime
   },
+  {
+    name: "Status",
+    id: "status",
+    type: "stringOptions",
+    internal: 't."status"',
+    options: [
+      { value: "SUCCESS" },
+      { value: "WARNING" },
+      { value: "ERROR" },
+    ],
+  },
   {
     name: "Timestamp",
     id: "timestamp",
@@ -197,6 +207,7 @@ export type TraceOptions = {
   traceName?: Array<SingleValueOption>;
   traceTags?: Array<SingleValueOption>;
   environment?: Array<SingleValueOption>;
+  status?: Array<SingleValueOption>;
 };
 export type DatasetOptions = {
   datasetId: Array<SingleValueOption>;
@@ -229,6 +240,9 @@ export function tracesTableColsWithOptions(
     if (col.id === "environment") {
       return formatColumnOptions(col, options?.environment ?? []);
     }
+    if (col.id === "status") {
+      return formatColumnOptions(col, options?.status ?? []);
+    }
     if (col.id === "score_categories") {
       return formatColumnOptions(col, options?.score_categories ?? []);
     }
diff --git a/packages/shared/src/server/tableMappings/mapTracesTable.ts b/packages/shared/src/server/tableMappings/mapTracesTable.ts
index f39a2ffef8..0c52a884a7 100644
--- a/packages/shared/src/server/tableMappings/mapTracesTable.ts
+++ b/packages/shared/src/server/tableMappings/mapTracesTable.ts
@@ -68,6 +68,13 @@ export const tracesTableUiColumnDefinitions: UiColumnMappings = [
     clickhouseSelect: "environment",
     queryPrefix: "t",
   },
+  {
+    uiTableName: "Status",
+    uiTableId: "status",
+    clickhouseTableName: "traces",
+    clickhouseSelect: "status",
+    queryPrefix: "t",
+  },
   {
     uiTableName: "Tags",
     uiTableId: "tags",
diff --git a/packages/shared/src/server/services/traces-ui-table-service.ts b/packages/shared/src/server/services/traces-ui-table-service.ts
index 2dcda41118..270acdc4ba 100644
--- a/packages/shared/src/server/services/traces-ui-table-service.ts
+++ b/packages/shared/src/server/services/traces-ui-table-service.ts
@@ -8,6 +8,7 @@ import {
   StringFilter,
   StringOptionsFilter,
   DateTimeFilter,
+  type Filter,
 } from "../queries/clickhouse-sql/clickhouse-filter";
 import {
   getProjectIdDefaultFilter,
@@ -27,6 +28,14 @@ import { ClickHouseClientConfigOptions } from "@clickhouse/client";
 import { shouldSkipObservationsFinal } from "../queries/clickhouse-sql/query-options";
 
+const DEFAULT_TRACE_STATUS_FILTER = ["SUCCESS", "WARNING", "ERROR"];
+
+function hasTraceStatusFilter(filters: Filter[]) {
+  return filters.some(
+    (filter) => filter.clickhouseTable === "traces" && filter.field === "status",
+  );
+}
+
 export type TracesTableReturnType = Pick<
   TraceRecordReadType,
   | "project_id"
@@ -43,6 +52,7 @@ export type TracesTableReturnType = Pick<
   | "environment"
   | "tags"
   | "public"
+  | "status"
 >;
 
 export type TracesTableUiReturnType = Pick<
@@ -60,6 +70,7 @@ export type TracesTableUiReturnType = Pick<
   | "environment"
   | "sessionId"
   | "public"
+  | "status"
 >;
 
 export type TracesMetricsUiReturnType = {
@@ -99,6 +110,7 @@ export const convertToUiTableRows = (
     environment: row.environment ?? null,
     sessionId: row.session_id ?? null,
     public: row.public,
+    status: row.status,
   };
 };
@@ -227,6 +239,18 @@ async function getTracesTableGeneric(props: FetchTracesTableProps) {
       tracesTableCols,
     ),
   );
+
+  if (!hasTraceStatusFilter(tracesFilter)) {
+    tracesFilter.push(
+      new StringOptionsFilter({
+        clickhouseTable: "traces",
+        field: "status",
+        operator: "any of",
+        values: DEFAULT_TRACE_STATUS_FILTER,
+      }),
+    );
+  }
 
   const traceIdFilter = tracesFilter.find(
     (f) => f.clickhouseTable === "traces" && f.field === "id",
@@ -309,6 +333,7 @@ async function getTracesTableGeneric(props: FetchTracesTableProps) {
             t.environment as environment,
             t.session_id as session_id,
             t.public as public`;
+            t.status as status`;
           break;
         case "identifiers":
           sqlSelect = `
diff --git a/worker/src/services/IngestionService/index.ts b/worker/src/services/IngestionService/index.ts
index f221cbf521..f82454a66b 100644
--- a/worker/src/services/IngestionService/index.ts
+++ b/worker/src/services/IngestionService/index.ts
@@ -86,6 +86,7 @@ const immutableEntityKeys: {
     "id",
     "timestamp",
     "project_id",
+    "status",
     "created_at",
     "event_ts",
   ],
@@ -583,6 +584,33 @@ export class IngestionService {
     );
     if (traceEventList.length === 0) return;
 
+    const status = this.deriveTraceStatusFromEvents(traceEventList);
+
     const timeSortedEvents =
       IngestionService.toTimeSortedEventList(traceEventList);
 
@@ -655,6 +683,7 @@ export class IngestionService {
     finalTraceRecord.created_at =
       clickhouseTraceRecord?.created_at ?? createdAtTimestamp.getTime();
+    finalTraceRecord.status = clickhouseTraceRecord?.status ?? status;
     finalTraceRecord.input = finalIO.input ?? clickhouseTraceRecord?.input;
     finalTraceRecord.output = finalIO.output ?? clickhouseTraceRecord?.output;
 
@@ -918,6 +947,30 @@ export class IngestionService {
     });
   }
 
+  private deriveTraceStatusFromEvents(traceEventList: TraceEventType[]) {
+    const levels = traceEventList.flatMap((trace) => {
+      const body = trace.body as {
+        observations?: Array<{ level?: string | null }>;
+      };
+      return body.observations?.map((observation) => observation.level) ?? [];
+    });
+
+    if (levels.some((level) => level === "ERROR")) {
+      return "ERROR" as const;
+    }
+
+    if (levels.some((level) => level === "WARNING")) {
+      return "WARNING" as const;
+    }
+
+    return "SUCCESS" as const;
+  }
+
   private async mergeTraceRecords(params: {
     traceRecords: TraceRecordInsertType[];
     clickhouseTraceRecord?: TraceRecordInsertType | null;
@@ -1489,6 +1542,7 @@ export class IngestionService {
           eventData.traceId,
         timestamp: this.getMillisecondTimestamp(
           trace.body.timestamp ?? trace.timestamp,
         ),
+        status: "SUCCESS",
         name: trace.body.name,
         user_id: trace.body.userId,
         metadata: trace.body.metadata
diff --git a/web/src/server/api/routers/traces.ts b/web/src/server/api/routers/traces.ts
index 328898761f..523bc95c2d 100644
--- a/web/src/server/api/routers/traces.ts
+++ b/web/src/server/api/routers/traces.ts
@@ -34,6 +34,7 @@ import {
   getTracesGroupedByName,
   getTracesGroupedByTags,
   getTracesGroupedByUsers,
+  getTracesGroupedByStatus,
   getObservationsForTrace,
   getTraceById,
 } from "@langfuse/shared/src/server";
@@ -68,6 +68,7 @@ const TraceFilterOptions = z.object({
   page: z.number().min(0).default(0),
   limit: z.number().min(1).max(100).default(50),
   filter: z.array(singleFilter).nullable(),
+  status: z.array(z.enum(["SUCCESS", "WARNING", "ERROR"])).optional(),
   orderBy: orderBy,
   searchQuery: z.string().nullable(),
   searchType: z.array(z.enum(["id", "userId", "name"])).optional(),
@@ -131,6 +132,17 @@ export const traceRouter = createTRPCRouter({
       if (hasNoMatches) {
         return { traces: [] };
       }
+
+      const statusFilters =
+        input.status?.map((status) => ({
+          type: "stringOptions" as const,
+          column: "status",
+          operator: "any of" as const,
+          value: [status],
+        })) ?? [];
 
       const traces = await getTracesTable({
         projectId: ctx.session.projectId,
-        filter: filterState,
+        filter: [...filterState, ...statusFilters],
         searchQuery: input.searchQuery ?? undefined,
         searchType: input.searchType ?? ["id"],
         orderBy: normalizeOrderByForTable({
@@ -161,10 +173,21 @@ export const traceRouter = createTRPCRouter({
       if (hasNoMatches) {
         return { totalCount: 0 };
       }
+
+      const statusFilters =
+        input.status?.map((status) => ({
+          type: "stringOptions" as const,
+          column: "status",
+          operator: "any of" as const,
+          value: [status],
+        })) ?? [];
 
       const count = await getTracesTableCount({
         projectId: ctx.session.projectId,
-        filter: filterState,
+        filter: [...filterState, ...statusFilters],
         searchType: input.searchType,
         searchQuery: input.searchQuery ?? undefined,
         limit: 1,
@@ -284,13 +307,20 @@ export const traceRouter = createTRPCRouter({
           0,
         ),
       ]);
+      const statusOptions = await getTracesGroupedByStatus(
+        input.projectId,
+        tracesTableUiColumnDefinitions,
+        timestampFilter ?? [],
+      );
 
       return {
         name: traceNames.map((n) => ({ value: n.name, count: n.count })),
         scores_avg: numericScoreNames.map((s) => s.name),
+        status: statusOptions.map((row) => ({
+          value: row.status,
+          count: row.count,
+        })),
         score_categories: categoricalScoreNames,
         tags: tags,
         users: userIds.map((u) => ({
diff --git a/web/src/__tests__/server/traces-status.servertest.ts b/web/src/__tests__/server/traces-status.servertest.ts
new file mode 100644
index 0000000000..6f780ee4b8
--- /dev/null
+++ b/web/src/__tests__/server/traces-status.servertest.ts
@@ -0,0 +1,233 @@
+import { describe, expect, it } from "vitest";
+import {
+  createTrace,
+  createProject,
+  getTestCaller,
+  insertTraceIntoClickhouse,
+} from "./test-utils";
+
+describe("trace status filters", () => {
+  it("returns status in trace list rows", async () => {
+    const project = await createProject();
+    const caller = await getTestCaller({ projectId: project.id });
+
+    await insertTraceIntoClickhouse({
+      projectId: project.id,
+      id: "trace-success",
+      name: "checkout success",
+      status: "SUCCESS",
+      timestamp: new Date("2026-05-01T10:00:00.000Z"),
+    });
+
+    const result = await caller.traces.all({
+      projectId: project.id,
+      page: 0,
+      limit: 50,
+      filter: [
+        {
+          type: "datetime",
+          column: "timestamp",
+          operator: ">=",
+          value: new Date("2026-05-01T00:00:00.000Z"),
+        },
+      ],
+      orderBy: {
+        column: "timestamp",
+        order: "DESC",
+      },
+      searchQuery: null,
+      searchType: ["id"],
+    });
+
+    expect(result.traces).toHaveLength(1);
+    expect(result.traces[0]).toMatchObject({
+      id: "trace-success",
+      status: "SUCCESS",
+    });
+  });
+
+  it("filters traces by ERROR status", async () => {
+    const project = await createProject();
+    const caller = await getTestCaller({ projectId: project.id });
+
+    await insertTraceIntoClickhouse({
+      projectId: project.id,
+      id: "trace-error",
+      name: "failed checkout",
+      status: "ERROR",
+      timestamp: new Date("2026-05-01T10:00:00.000Z"),
+    });
+    await insertTraceIntoClickhouse({
+      projectId: project.id,
+      id: "trace-success",
+      name: "successful checkout",
+      status: "SUCCESS",
+      timestamp: new Date("2026-05-01T10:01:00.000Z"),
+    });
+
+    const result = await caller.traces.all({
+      projectId: project.id,
+      page: 0,
+      limit: 50,
+      status: ["ERROR"],
+      filter: [
+        {
+          type: "datetime",
+          column: "timestamp",
+          operator: ">=",
+          value: new Date("2026-05-01T00:00:00.000Z"),
+        },
+      ],
+      orderBy: {
+        column: "timestamp",
+        order: "DESC",
+      },
+      searchQuery: null,
+      searchType: ["id"],
+    });
+
+    expect(result.traces.map((trace) => trace.id)).toEqual(["trace-error"]);
+  });
+
+  it("counts traces by status filter", async () => {
+    const project = await createProject();
+    const caller = await getTestCaller({ projectId: project.id });
+
+    await insertTraceIntoClickhouse({
+      projectId: project.id,
+      id: "trace-warning",
+      name: "slow checkout",
+      status: "WARNING",
+      timestamp: new Date("2026-05-01T10:00:00.000Z"),
+    });
+    await insertTraceIntoClickhouse({
+      projectId: project.id,
+      id: "trace-success",
+      name: "checkout success",
+      status: "SUCCESS",
+      timestamp: new Date("2026-05-01T10:01:00.000Z"),
+    });
+
+    const result = await caller.traces.countAll({
+      projectId: project.id,
+      page: 0,
+      limit: 50,
+      status: ["WARNING"],
+      filter: [
+        {
+          type: "datetime",
+          column: "timestamp",
+          operator: ">=",
+          value: new Date("2026-05-01T00:00:00.000Z"),
+        },
+      ],
+      orderBy: {
+        column: "timestamp",
+        order: "DESC",
+      },
+      searchQuery: null,
+      searchType: ["id"],
+    });
+
+    expect(result.totalCount).toBe(1);
+  });
+
+  it("returns status options", async () => {
+    const project = await createProject();
+    const caller = await getTestCaller({ projectId: project.id });
+
+    await insertTraceIntoClickhouse({
+      projectId: project.id,
+      id: "trace-success-option",
+      name: "checkout success",
+      status: "SUCCESS",
+      timestamp: new Date("2026-05-01T10:00:00.000Z"),
+    });
+    await insertTraceIntoClickhouse({
+      projectId: project.id,
+      id: "trace-error-option",
+      name: "checkout error",
+      status: "ERROR",
+      timestamp: new Date("2026-05-01T10:01:00.000Z"),
+    });
+
+    const result = await caller.traces.filterOptions({
+      projectId: project.id,
+      timestampFilter: [
+        {
+          type: "datetime",
+          column: "timestamp",
+          operator: ">=",
+          value: new Date("2026-05-01T00:00:00.000Z"),
+        },
+      ],
+    });
+
+    expect(result.status).toEqual([
+      { value: "SUCCESS", count: "1" },
+      { value: "ERROR", count: "1" },
+      { value: "WARNING", count: "0" },
+    ]);
+  });
+
+  it("returns status from trace detail", async () => {
+    const project = await createProject();
+    const caller = await getTestCaller({ projectId: project.id });
+
+    await insertTraceIntoClickhouse({
+      projectId: project.id,
+      id: "trace-detail-warning",
+      name: "slow checkout detail",
+      status: "WARNING",
+      timestamp: new Date("2026-05-01T10:00:00.000Z"),
+    });
+
+    const result = await caller.traces.byId({
+      projectId: project.id,
+      traceId: "trace-detail-warning",
+      timestamp: new Date("2026-05-01T10:00:00.000Z"),
+      fromTimestamp: null,
+    });
+
+    expect(result).toMatchObject({
+      id: "trace-detail-warning",
+      status: "WARNING",
+    });
+  });
+
+  it("derives status from new ingestion events", async () => {
+    const project = await createProject();
+
+    await createTrace({
+      projectId: project.id,
+      traceId: "trace-derived-error",
+      observations: [
+        {
+          id: "obs-1",
+          level: "DEFAULT",
+        },
+        {
+          id: "obs-2",
+          level: "ERROR",
+        },
+      ],
+    });
+
+    const caller = await getTestCaller({ projectId: project.id });
+    const result = await caller.traces.all({
+      projectId: project.id,
+      page: 0,
+      limit: 50,
+      status: ["ERROR"],
+      filter: [
+        {
+          type: "datetime",
+          column: "timestamp",
+          operator: ">=",
+          value: new Date("2026-05-01T00:00:00.000Z"),
+        },
+      ],
+      orderBy: {
+        column: "timestamp",
+        order: "DESC",
+      },
+      searchQuery: null,
+      searchType: ["id"],
+    });
+
+    expect(result.traces.map((trace) => trace.id)).toContain(
+      "trace-derived-error",
+    );
+  });
+});
```

## Intended Flaws

### Flaw 1: Nullable Historical Status Is Treated As A Non-Null Contract

- `type`: `rollout_risk`
- `location`: `packages/shared/clickhouse/migrations/unclustered/0030_add_trace_status.up.sql:1-3`, `packages/shared/src/server/repositories/definitions.ts:119-126`, `packages/shared/src/server/repositories/traces.ts:608-672`, `packages/shared/src/server/services/traces-ui-table-service.ts:28-39`, `packages/shared/src/server/services/traces-ui-table-service.ts:239-252`, `packages/shared/src/server/services/traces-ui-table-service.ts:333-336`, `web/src/__tests__/server/traces-status.servertest.ts:7-206`
- `learner_prompt`: What happens to old trace rows while the new status column is null or the backfill has not finished?

Expected answer:

- `identify`: The ClickHouse migration adds `status Nullable(String)`, but the TypeScript schema makes `status` a required enum and the trace table query injects a default `status IN ('SUCCESS', 'WARNING', 'ERROR')` filter whenever the user has not selected a status. Existing rows with `status = NULL` do not match that predicate. The tests only insert rows with explicit statuses, so they never exercise historical null rows.
- `impact`: During and after rollout, old traces can disappear from default trace lists, counts, identifier queries, and table actions. Count and list can disagree with exports or direct by-id reads. Projects with mostly historical data may look empty after deploy. Because trace status is a filterable table contract, this can silently break investigations, eval setup, batch actions, and support workflows that rely on finding old traces.
- `fix_direction`: Treat status as a versioned, nullable rollout field. Read paths should coalesce missing status to a documented default, for example `coalesce(t.status, 'SUCCESS')`, or avoid adding a default status predicate at all. Domain schemas should accept `null` until the backfill is complete, and tests must include pre-migration rows with null status for list, count, filter options, and by-id paths.

Hints:

1. Follow the column from the migration into the TypeScript schema and then into the default trace table filters.
2. SQL `IN (...)` does not match `NULL`.
3. The tests create only new-style rows. They never prove compatibility with old traces.

### Flaw 2: The Backfill Runs As A Blocking Schema Migration

- `type`: `unsafe_migration`
- `location`: `packages/shared/clickhouse/migrations/unclustered/0030_add_trace_status.up.sql:5-13`, `packages/shared/clickhouse/migrations/clustered/0030_add_trace_status.up.sql:9-18`, `packages/shared/prisma/migrations/20260509090000_add_trace_status/migration.sql:1-17`, `packages/shared/prisma/schema.prisma:329-346`
- `learner_prompt`: Is this backfill safe for a production traces table with millions or billions of rows?

Expected answer:

- `identify`: The migrations backfill the entire traces table inline. The Postgres migration wraps `ALTER TABLE`, full-table `UPDATE`, `SET NOT NULL`, default change, and index creation in one transaction. The ClickHouse migration runs a table-wide `ALTER UPDATE` and index materialization with synchronous mutation settings. That puts a large data rewrite on the deployment path.
- `impact`: Deploys can block, time out, hold locks, saturate ClickHouse mutations, delay writes, or fail halfway across clustered environments. In self-hosted deployments, a schema migration that scans or rewrites all trace rows can take far longer than the app rollout budget. If it fails after application code has been deployed, the app assumes a non-null status while storage still contains nulls or a half-finished mutation.
- `fix_direction`: Split schema change from data backfill. Add the nullable column and compatible read code first. Derive status for new writes. Register a resumable background migration that backfills by project/time partition or primary-key window with progress state, bounded batch sizes, observability, and retry. Only after the backfill is complete should a later migration add stricter defaults, materialized indexes, or non-null assumptions.

Hints:

1. Compare this migration to the existing trace Postgres-to-ClickHouse background migration pattern.
2. Look for full-table `UPDATE` or synchronous ClickHouse mutation work in the migration files.
3. A schema migration should not be responsible for rewriting the whole traces corpus.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the compatibility break between a nullable storage rollout and non-null read/query assumptions. Answers that only say "status can be null" are incomplete unless they explain that the default table filter excludes old rows.

For flaw 2, a correct answer must identify the migration/backfill risk. Answers that only mention "migration might be slow" are incomplete unless they explain why full-table backfill belongs in a staged background migration rather than the schema migration.

### Product-Level Change

The PR tries to make traces easier to triage by adding a trace-level status. That is valuable: users want to quickly find failed traces or warning traces without opening every trace detail page. The feature affects ingestion, storage, list queries, filter options, counts, and table actions.

### Changed Contracts

- Storage contract: ClickHouse and legacy Postgres trace rows gain `status`.
- Ingestion contract: new trace writes are expected to derive status from observation levels.
- Domain contract: `TraceDomain` now exposes status.
- Table contract: trace lists, counts, metrics, identifiers, and filters can use status.
- Migration contract: historical traces must remain visible while status is introduced.

### Failure Modes

The app deploys before the ClickHouse mutation finishes. A project has two years of traces with `status = NULL`. The trace table service adds `status IN ('SUCCESS', 'WARNING', 'ERROR')` to every query. The project appears to have no traces in the default view, even though by-id lookup or export paths may still find them.

The Postgres migration reaches the full-table update on a large self-hosted instance. The migration transaction runs for minutes or hours, blocks other schema work, and may be killed by deployment timeouts. The app can then run with code that assumes `status` exists and is non-null while the storage rollout is only partially complete.

### Reviewer Thought Process

A strong reviewer starts by asking whether the column is new for all rows or only for new rows. Any field added to an append-heavy historical table has three phases: missing, partially backfilled, and fully populated. The review should inspect whether the code works in all three phases.

The second move is to separate schema rollout from data rewrite. Adding a nullable column is usually cheap. Rewriting every historical row is operational work and needs batching, checkpoints, and metrics. Langfuse already has background migration patterns, so a reviewer should look for reuse of that pattern.

### Better Implementation Direction

- Add `status` as nullable in storage.
- Derive status for new writes only after the column exists.
- Keep read paths compatible with null historical rows by using `coalesce` or nullable domain types.
- Avoid default filters that exclude null status.
- Backfill in a resumable background migration with bounded batches and progress state.
- Add tests for null historical rows across list, count, by-id, metrics, identifiers, and filter options.
- Add a later cleanup migration only after backfill completion is observable.

## Why This Case Exists

This case teaches one of the most important large-PR review habits: every schema change has a deployment timeline. Good reviewers do not only ask whether the final state is correct; they ask whether the system works while the old and new worlds coexist.
