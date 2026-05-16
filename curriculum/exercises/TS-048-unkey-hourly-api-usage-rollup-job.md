# TS-048: Unkey Hourly API Usage Rollup Job

## Metadata

- `id`: TS-048
- `source_repo`: [unkeyed/unkey](https://github.com/unkeyed/unkey)
- `repo_area`: ClickHouse analytics, API request usage, hourly rollups, ingestion buffers, dashboard usage queries, retry idempotency
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,600-2,000
- `represented_diff_lines`: 1622
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Unkey analytics, ClickHouse rollups, late events, retry idempotency, materialized views, and dashboard usage contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a manual hourly API usage rollup job. The product goal is to reduce dashboard and billing query cost by precomputing hourly API usage counts from raw `api_requests_raw_v2` events into a compact table. The dashboard can then query hourly rollups for older ranges while raw request logs remain available for drill-down.

The PR adds:

- a new ClickHouse `api_usage_hourly_rollups_v1` table,
- a MySQL rollup state table,
- a TypeScript ClickHouse rollup client,
- a cron runner that closes the previous wall-clock hour,
- a dashboard billing usage query that reads the rollup table,
- tests for the happy path and retry path,
- an operations guide for support.

The intended product behavior is: every API request should be counted exactly once in the correct hour, even if raw events arrive late or the rollup job retries.

## Existing Code Context

The real Unkey codebase already has these relevant contracts:

- `pkg/clickhouse/schema/012_api_requests_raw_v2.sql` stores raw API requests in ClickHouse with event time in unix milliseconds and a one-month TTL.
- `pkg/clickhouse/schema/013_api_requests_per_minute_v2.sql` defines `api_requests_per_minute_v2` as a `SummingMergeTree` materialized view from raw events.
- `pkg/clickhouse/schema/014_api_requests_per_hour_v2.sql` defines `api_requests_per_hour_v2` as a materialized view over minute rollups, grouped by workspace, hour, status, host, method, and path.
- `pkg/clickhouse/schema/015_api_requests_per_day_v2.sql` and `016_api_requests_per_month_v2.sql` continue that hierarchy for longer ranges.
- `pkg/clickhouse/schema/006_ratelimits_raw_v2.sql` and `007-010_ratelimits_*` use the same raw-event-plus-materialized-rollup pattern for ratelimit analytics.
- `pkg/clickhouse/ratelimits_test.go` inserts a large set of raw events and asserts that raw, minute, hour, day, and month aggregates reconcile from the same source data.
- `svc/api/run.go` writes API requests, key verifications, and ratelimits through ClickHouse buffers with batch size, flush interval, retry, and optional dropping when buffers are full.
- `pkg/clickhouse/flush.go` applies ClickHouse async insert settings, retry, and circuit-breaker protection when flushing rows.
- `web/internal/clickhouse/src/ratelimits.ts` chooses aggregate tables based on dashboard granularity and still uses raw tables for log/detail queries.
- `pkg/clickhouse/schema/018_billable_ratelimits_per_month_v2.sql` shows billing-style rollups are derived from aggregate tables, not from a one-shot external job.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the new rollup job counts every raw event exactly once while respecting late-arrival and retry behavior.

## Review Surface

Changed files in the synthetic PR:

- `pkg/clickhouse/schema/037_api_usage_hourly_rollups_v1.sql`
- `web/internal/db/src/schema/api_usage_rollup_state.ts`
- `web/internal/clickhouse/src/usage-rollups.ts`
- `web/internal/clickhouse/src/index.ts`
- `web/apps/dashboard/lib/jobs/api-usage-rollup/state.ts`
- `web/apps/dashboard/lib/jobs/api-usage-rollup/runner.ts`
- `web/apps/dashboard/app/api/internal/jobs/api-usage-rollup/route.ts`
- `web/apps/dashboard/lib/trpc/routers/billing/query-usage/index.ts`
- `web/apps/dashboard/lib/jobs/api-usage-rollup/__tests__/runner.test.ts`
- `web/internal/clickhouse/src/__tests__/usage-rollups.test.ts`
- `web/apps/dashboard/lib/jobs/api-usage-rollup/report.ts`
- `docs/operations/api-usage-hourly-rollups.md`

The line references below use synthetic PR line numbers. The represented diff is focused on event-time aggregation, wall-clock closure, late-arrival windows, retry behavior, and tests that make non-idempotent rollups look acceptable.

## Diff

```diff
diff --git a/pkg/clickhouse/schema/037_api_usage_hourly_rollups_v1.sql b/pkg/clickhouse/schema/037_api_usage_hourly_rollups_v1.sql
new file mode 100644
index 0000000000..346f3bbd91
--- /dev/null
+++ b/pkg/clickhouse/schema/037_api_usage_hourly_rollups_v1.sql
@@ -0,0 +1,98 @@
+-- Manual hourly API usage rollups for dashboard and billing queries.
+-- This table stores one row per workspace, hour, host, method, path, and
+-- response status. The cron job writes rows after it closes the previous hour.
+
+CREATE TABLE IF NOT EXISTS default.api_usage_hourly_rollups_v1 (
+  bucket_start DateTime,
+  bucket_end DateTime,
+  workspace_id String,
+  host String,
+  method LowCardinality(String),
+  path String,
+  response_status Int,
+  request_count UInt64,
+  error_count UInt64,
+  p50_latency_ms AggregateFunction(quantilesTDigest(0.50), Int64),
+  p95_latency_ms AggregateFunction(quantilesTDigest(0.95), Int64),
+  p99_latency_ms AggregateFunction(quantilesTDigest(0.99), Int64),
+  source_job_id String,
+  rolled_up_at DateTime DEFAULT now(),
+  INDEX idx_host host TYPE bloom_filter GRANULARITY 1,
+  INDEX idx_path path TYPE bloom_filter GRANULARITY 1,
+  INDEX idx_source_job source_job_id TYPE bloom_filter GRANULARITY 1
+) ENGINE = SummingMergeTree()
+ORDER BY (
+  workspace_id,
+  bucket_start,
+  host,
+  method,
+  path,
+  response_status
+)
+TTL bucket_start + INTERVAL 3 YEAR DELETE;
+
+CREATE TABLE IF NOT EXISTS default.api_usage_rollup_runs_v1 (
+  job_id String,
+  bucket_start DateTime,
+  bucket_end DateTime,
+  started_at DateTime,
+  finished_at Nullable(DateTime),
+  status LowCardinality(String),
+  workspaces_seen UInt64,
+  rows_inserted UInt64,
+  error String
+) ENGINE = MergeTree()
+ORDER BY (bucket_start, job_id)
+TTL started_at + INTERVAL 1 YEAR DELETE;
+
+CREATE VIEW IF NOT EXISTS default.api_usage_hourly_rollups_read_v1 AS
+SELECT
+  bucket_start,
+  bucket_end,
+  workspace_id,
+  host,
+  method,
+  path,
+  response_status,
+  sum(request_count) AS request_count,
+  sum(error_count) AS error_count,
+  quantilesTDigestMerge(0.50)(p50_latency_ms)[1] AS p50_latency_ms,
+  quantilesTDigestMerge(0.95)(p95_latency_ms)[1] AS p95_latency_ms,
+  quantilesTDigestMerge(0.99)(p99_latency_ms)[1] AS p99_latency_ms,
+  max(rolled_up_at) AS rolled_up_at
+FROM default.api_usage_hourly_rollups_v1
+GROUP BY
+  bucket_start,
+  bucket_end,
+  workspace_id,
+  host,
+  method,
+  path,
+  response_status;
diff --git a/web/internal/db/src/schema/api_usage_rollup_state.ts b/web/internal/db/src/schema/api_usage_rollup_state.ts
new file mode 100644
index 0000000000..d8fc5d4b2c
--- /dev/null
+++ b/web/internal/db/src/schema/api_usage_rollup_state.ts
@@ -0,0 +1,123 @@
+import { relations } from "drizzle-orm";
+import { bigint, index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
+
+import { lifecycleDates } from "./util/lifecycle_dates";
+import { workspaces } from "./workspaces";
+
+export const apiUsageRollupState = mysqlTable(
+  "api_usage_rollup_state",
+  {
+    workspaceId: varchar("workspace_id", {
+      length: 256,
+    }).notNull(),
+    lastClosedBucketStart: bigint("last_closed_bucket_start", {
+      mode: "number",
+    }).notNull(),
+    lastClosedBucketEnd: bigint("last_closed_bucket_end", {
+      mode: "number",
+    }).notNull(),
+    lastJobId: varchar("last_job_id", {
+      length: 256,
+    }),
+    status: varchar("status", {
+      length: 32,
+    }).notNull().default("idle"),
+    error: varchar("error", {
+      length: 1024,
+    }),
+    ...lifecycleDates,
+  },
+  (table) => ({
+    workspaceIdx: index("api_usage_rollup_state_workspace_idx").on(table.workspaceId),
+    workspaceBucketUnique: uniqueIndex("api_usage_rollup_state_workspace_bucket_unique").on(
+      table.workspaceId,
+      table.lastClosedBucketStart,
+    ),
+  }),
+);
+
+export const apiUsageRollupStateRelations = relations(apiUsageRollupState, ({ one }) => ({
+  workspace: one(workspaces, {
+    fields: [apiUsageRollupState.workspaceId],
+    references: [workspaces.id],
+  }),
+}));
+
+export type ApiUsageRollupState = typeof apiUsageRollupState.$inferSelect;
+export type InsertApiUsageRollupState = typeof apiUsageRollupState.$inferInsert;
diff --git a/web/internal/clickhouse/src/usage-rollups.ts b/web/internal/clickhouse/src/usage-rollups.ts
new file mode 100644
index 0000000000..9454a2f031
--- /dev/null
+++ b/web/internal/clickhouse/src/usage-rollups.ts
@@ -0,0 +1,365 @@
+import { z } from "zod";
+
+import type { Querier } from "./client";
+
+export const closeHourlyUsageBucketParams = z.object({
+  jobId: z.string(),
+  bucketStart: z.number().int(),
+  bucketEnd: z.number().int(),
+  workspaceIds: z.array(z.string()).optional(),
+});
+
+export const closeHourlyUsageBucketResult = z.object({
+  rows_inserted: z.number().int(),
+});
+
+export const queryHourlyUsageParams = z.object({
+  workspaceId: z.string(),
+  startTime: z.number().int(),
+  endTime: z.number().int(),
+});
+
+export const hourlyUsageRow = z.object({
+  x: z.number().int(),
+  requests: z.number().int(),
+  errors: z.number().int(),
+  p95_latency_ms: z.number().optional().default(0),
+});
+
+export type CloseHourlyUsageBucketParams = z.infer<typeof closeHourlyUsageBucketParams>;
+export type QueryHourlyUsageParams = z.infer<typeof queryHourlyUsageParams>;
+export type HourlyUsageRow = z.infer<typeof hourlyUsageRow>;
+
+function workspaceFilter(workspaceIds?: string[]) {
+  if (!workspaceIds || workspaceIds.length === 0) {
+    return "";
+  }
+
+  return "AND workspace_id IN {workspaceIds: Array(String)}";
+}
+
+export function startHourlyUsageRun(ch: Querier) {
+  return async (args: CloseHourlyUsageBucketParams) => {
+    const query = ch.query({
+      query: `
+INSERT INTO default.api_usage_rollup_runs_v1
+SELECT
+  {jobId: String} AS job_id,
+  fromUnixTimestamp64Milli({bucketStart: Int64}) AS bucket_start,
+  fromUnixTimestamp64Milli({bucketEnd: Int64}) AS bucket_end,
+  now() AS started_at,
+  NULL AS finished_at,
+  'running' AS status,
+  uniqExact(workspace_id) AS workspaces_seen,
+  0 AS rows_inserted,
+  '' AS error
+FROM default.api_requests_raw_v2
+WHERE time >= {bucketStart: Int64}
+  AND time < {bucketEnd: Int64}
+  ${workspaceFilter(args.workspaceIds)}`,
+      params: closeHourlyUsageBucketParams,
+      schema: z.object({}),
+    });
+
+    return query(args);
+  };
+}
+
+export function insertHourlyUsageRollup(ch: Querier) {
+  return async (args: CloseHourlyUsageBucketParams) => {
+    const query = ch.query({
+      query: `
+INSERT INTO default.api_usage_hourly_rollups_v1
+SELECT
+  toStartOfHour(fromUnixTimestamp64Milli(time)) AS bucket_start,
+  toStartOfHour(fromUnixTimestamp64Milli(time)) + INTERVAL 1 HOUR AS bucket_end,
+  workspace_id,
+  host,
+  method,
+  path,
+  response_status,
+  count(*) AS request_count,
+  countIf(response_status >= 500 OR length(error) > 0) AS error_count,
+  quantilesTDigestState(0.50)(service_latency) AS p50_latency_ms,
+  quantilesTDigestState(0.95)(service_latency) AS p95_latency_ms,
+  quantilesTDigestState(0.99)(service_latency) AS p99_latency_ms,
+  {jobId: String} AS source_job_id,
+  now() AS rolled_up_at
+FROM default.api_requests_raw_v2
+WHERE time >= {bucketStart: Int64}
+  AND time < {bucketEnd: Int64}
+  ${workspaceFilter(args.workspaceIds)}
+GROUP BY
+  bucket_start,
+  bucket_end,
+  workspace_id,
+  host,
+  method,
+  path,
+  response_status`,
+      params: closeHourlyUsageBucketParams,
+      schema: closeHourlyUsageBucketResult,
+    });
+
+    return query(args);
+  };
+}
+
+export function finishHourlyUsageRun(ch: Querier) {
+  return async (
+    args: CloseHourlyUsageBucketParams & {
+      rowsInserted: number;
+      status: "completed" | "failed";
+      error?: string;
+    },
+  ) => {
+    const query = ch.query({
+      query: `
+INSERT INTO default.api_usage_rollup_runs_v1
+SELECT
+  {jobId: String} AS job_id,
+  fromUnixTimestamp64Milli({bucketStart: Int64}) AS bucket_start,
+  fromUnixTimestamp64Milli({bucketEnd: Int64}) AS bucket_end,
+  now() AS started_at,
+  now() AS finished_at,
+  {status: String} AS status,
+  0 AS workspaces_seen,
+  {rowsInserted: UInt64} AS rows_inserted,
+  {error: String} AS error`,
+      params: closeHourlyUsageBucketParams.extend({
+        rowsInserted: z.number().int(),
+        status: z.enum(["completed", "failed"]),
+        error: z.string().optional().default(""),
+      }),
+      schema: z.object({}),
+    });
+
+    return query({
+      ...args,
+      error: args.error ?? "",
+    });
+  };
+}
+
+export function queryHourlyUsageRollups(ch: Querier) {
+  return async (args: QueryHourlyUsageParams) => {
+    const query = ch.query({
+      query: `
+SELECT
+  toUnixTimestamp64Milli(CAST(bucket_start AS DateTime64(3))) AS x,
+  sum(request_count) AS requests,
+  sum(error_count) AS errors,
+  max(p95_latency_ms) AS p95_latency_ms
+FROM default.api_usage_hourly_rollups_read_v1
+WHERE workspace_id = {workspaceId: String}
+  AND bucket_start >= fromUnixTimestamp64Milli({startTime: Int64})
+  AND bucket_start < fromUnixTimestamp64Milli({endTime: Int64})
+GROUP BY x
+ORDER BY x ASC
+WITH FILL
+  FROM toUnixTimestamp64Milli(CAST(toStartOfHour(fromUnixTimestamp64Milli({startTime: Int64})) AS DateTime64(3)))
+  TO toUnixTimestamp64Milli(CAST(toStartOfHour(fromUnixTimestamp64Milli({endTime: Int64})) AS DateTime64(3)))
+  STEP 3600000`,
+      params: queryHourlyUsageParams,
+      schema: hourlyUsageRow,
+    });
+
+    return query(args);
+  };
+}
+
+export function queryHourlyUsageTotal(ch: Querier) {
+  return async (args: QueryHourlyUsageParams) => {
+    const query = ch.query({
+      query: `
+SELECT
+  sum(request_count) AS requests,
+  sum(error_count) AS errors
+FROM default.api_usage_hourly_rollups_read_v1
+WHERE workspace_id = {workspaceId: String}
+  AND bucket_start >= fromUnixTimestamp64Milli({startTime: Int64})
+  AND bucket_start < fromUnixTimestamp64Milli({endTime: Int64})`,
+      params: queryHourlyUsageParams,
+      schema: z.object({
+        requests: z.number().int().default(0),
+        errors: z.number().int().default(0),
+      }),
+    });
+
+    return query(args);
+  };
+}
+
+export const usageRollups = {
+  startHourlyUsageRun,
+  insertHourlyUsageRollup,
+  finishHourlyUsageRun,
+  queryHourlyUsageRollups,
+  queryHourlyUsageTotal,
+};
diff --git a/web/internal/clickhouse/src/index.ts b/web/internal/clickhouse/src/index.ts
index 05e4da91bf..42458a149e 100644
--- a/web/internal/clickhouse/src/index.ts
+++ b/web/internal/clickhouse/src/index.ts
@@ -24,6 +24,13 @@ import {
   getRatelimitLogs,
   getRatelimitOverviewLogs,
 } from "./ratelimits";
+import {
+  finishHourlyUsageRun,
+  insertHourlyUsageRollup,
+  queryHourlyUsageRollups,
+  queryHourlyUsageTotal,
+  startHourlyUsageRun,
+} from "./usage-rollups";
 
 export class ClickHouse {
   public readonly verifications: ReturnType<typeof createVerifications>;
@@ -41,6 +48,7 @@ export class ClickHouse {
   public readonly requests: ReturnType<typeof createRequests>;
   public readonly resources: ReturnType<typeof createResources>;
   public readonly billing: ReturnType<typeof createBilling>;
+  public readonly usageRollups: ReturnType<typeof createUsageRollups>;
 
   constructor(opts: ClickHouseOptions) {
     this.inserter = createInserter(opts);
@@ -61,6 +69,7 @@ export class ClickHouse {
     this.requests = createRequests(this.querier, this.inserter);
     this.resources = createResources(this.querier);
     this.billing = createBilling(this.querier);
+    this.usageRollups = createUsageRollups(this.querier);
   }
 }
+
+function createUsageRollups(querier: Querier) {
+  return {
+    startHourlyRun: startHourlyUsageRun(querier),
+    insertHourly: insertHourlyUsageRollup(querier),
+    finishHourlyRun: finishHourlyUsageRun(querier),
+    timeseries: queryHourlyUsageRollups(querier),
+    total: queryHourlyUsageTotal(querier),
+  };
+}
diff --git a/web/apps/dashboard/lib/jobs/api-usage-rollup/state.ts b/web/apps/dashboard/lib/jobs/api-usage-rollup/state.ts
new file mode 100644
index 0000000000..8154a6d342
--- /dev/null
+++ b/web/apps/dashboard/lib/jobs/api-usage-rollup/state.ts
@@ -0,0 +1,168 @@
+import { and, eq, schema } from "@unkey/db";
+
+import { db } from "@/lib/db";
+
+export type RollupState = {
+  workspaceId: string;
+  lastClosedBucketStart: number;
+  lastClosedBucketEnd: number;
+  lastJobId: string | null;
+  status: "idle" | "running" | "completed" | "failed";
+  error: string | null;
+};
+
+export class ApiUsageRollupStateRepository {
+  async findForWorkspace(workspaceId: string): Promise<RollupState | null> {
+    const row = await db.query.apiUsageRollupState.findFirst({
+      where: eq(schema.apiUsageRollupState.workspaceId, workspaceId),
+    });
+
+    if (!row) {
+      return null;
+    }
+
+    return {
+      workspaceId: row.workspaceId,
+      lastClosedBucketStart: row.lastClosedBucketStart,
+      lastClosedBucketEnd: row.lastClosedBucketEnd,
+      lastJobId: row.lastJobId ?? null,
+      status: row.status as RollupState["status"],
+      error: row.error ?? null,
+    };
+  }
+
+  async upsertRunning(input: {
+    workspaceId: string;
+    bucketStart: number;
+    bucketEnd: number;
+    jobId: string;
+  }) {
+    await db
+      .insert(schema.apiUsageRollupState)
+      .values({
+        workspaceId: input.workspaceId,
+        lastClosedBucketStart: input.bucketStart,
+        lastClosedBucketEnd: input.bucketEnd,
+        lastJobId: input.jobId,
+        status: "running",
+      })
+      .onDuplicateKeyUpdate({
+        set: {
+          lastClosedBucketStart: input.bucketStart,
+          lastClosedBucketEnd: input.bucketEnd,
+          lastJobId: input.jobId,
+          status: "running",
+          error: null,
+        },
+      });
+  }
+
+  async markCompleted(input: {
+    workspaceId: string;
+    bucketStart: number;
+    bucketEnd: number;
+    jobId: string;
+  }) {
+    await db
+      .update(schema.apiUsageRollupState)
+      .set({
+        status: "completed",
+        lastClosedBucketStart: input.bucketStart,
+        lastClosedBucketEnd: input.bucketEnd,
+        lastJobId: input.jobId,
+        error: null,
+      })
+      .where(
+        and(
+          eq(schema.apiUsageRollupState.workspaceId, input.workspaceId),
+          eq(schema.apiUsageRollupState.lastJobId, input.jobId),
+        ),
+      );
+  }
+
+  async markFailed(input: {
+    workspaceId: string;
+    bucketStart: number;
+    bucketEnd: number;
+    jobId: string;
+    error: string;
+  }) {
+    await db
+      .update(schema.apiUsageRollupState)
+      .set({
+        status: "failed",
+        lastClosedBucketStart: input.bucketStart,
+        lastClosedBucketEnd: input.bucketEnd,
+        lastJobId: input.jobId,
+        error: input.error,
+      })
+      .where(eq(schema.apiUsageRollupState.workspaceId, input.workspaceId));
+  }
+}
diff --git a/web/apps/dashboard/lib/jobs/api-usage-rollup/runner.ts b/web/apps/dashboard/lib/jobs/api-usage-rollup/runner.ts
new file mode 100644
index 0000000000..16a13a9fbe
--- /dev/null
+++ b/web/apps/dashboard/lib/jobs/api-usage-rollup/runner.ts
@@ -0,0 +1,324 @@
+import { randomUUID } from "node:crypto";
+
+import { clickhouse } from "@/lib/clickhouse";
+import { db } from "@/lib/db";
+import { ApiUsageRollupStateRepository } from "./state";
+
+type WorkspaceRow = {
+  id: string;
+  slug: string;
+};
+
+export type ApiUsageRollupRunResult = {
+  jobId: string;
+  bucketStart: number;
+  bucketEnd: number;
+  workspacesScanned: number;
+  workspacesSucceeded: number;
+  workspacesFailed: number;
+  rowsInserted: number;
+};
+
+export type ApiUsageRollupRunnerOptions = {
+  now?: Date;
+  workspaceIds?: string[];
+  dryRun?: boolean;
+};
+
+const HOUR_MS = 60 * 60 * 1000;
+
+export class ApiUsageRollupRunner {
+  constructor(
+    private state = new ApiUsageRollupStateRepository(),
+  ) {}
+
+  async run(options: ApiUsageRollupRunnerOptions = {}): Promise<ApiUsageRollupRunResult> {
+    const jobId = randomUUID();
+    const { bucketStart, bucketEnd } = this.closedPreviousHour(options.now ?? new Date());
+    const workspaces = await this.loadWorkspaces(options.workspaceIds);
+    const result: ApiUsageRollupRunResult = {
+      jobId,
+      bucketStart,
+      bucketEnd,
+      workspacesScanned: workspaces.length,
+      workspacesSucceeded: 0,
+      workspacesFailed: 0,
+      rowsInserted: 0,
+    };
+
+    await clickhouse.usageRollups.startHourlyRun({
+      jobId,
+      bucketStart,
+      bucketEnd,
+      workspaceIds: workspaces.map((workspace) => workspace.id),
+    });
+
+    for (const workspace of workspaces) {
+      try {
+        await this.closeWorkspaceHour({
+          jobId,
+          workspaceId: workspace.id,
+          bucketStart,
+          bucketEnd,
+          dryRun: !!options.dryRun,
+        });
+        result.workspacesSucceeded += 1;
+      } catch (error) {
+        result.workspacesFailed += 1;
+        await this.state.markFailed({
+          workspaceId: workspace.id,
+          bucketStart,
+          bucketEnd,
+          jobId,
+          error: error instanceof Error ? error.message : "unknown rollup error",
+        });
+      }
+    }
+
+    if (!options.dryRun) {
+      const insertResult = await clickhouse.usageRollups.insertHourly({
+        jobId,
+        bucketStart,
+        bucketEnd,
+        workspaceIds: workspaces.map((workspace) => workspace.id),
+      });
+      result.rowsInserted = insertResult.val?.[0]?.rows_inserted ?? 0;
+    }
+
+    await clickhouse.usageRollups.finishHourlyRun({
+      jobId,
+      bucketStart,
+      bucketEnd,
+      rowsInserted: result.rowsInserted,
+      status: result.workspacesFailed > 0 ? "failed" : "completed",
+      error: result.workspacesFailed > 0 ? `${result.workspacesFailed} workspaces failed` : "",
+      workspaceIds: workspaces.map((workspace) => workspace.id),
+    });
+
+    return result;
+  }
+
+  private async closeWorkspaceHour(input: {
+    jobId: string;
+    workspaceId: string;
+    bucketStart: number;
+    bucketEnd: number;
+    dryRun: boolean;
+  }) {
+    const previousState = await this.state.findForWorkspace(input.workspaceId);
+    if (previousState && previousState.lastClosedBucketEnd >= input.bucketEnd) {
+      return;
+    }
+
+    await this.state.upsertRunning({
+      workspaceId: input.workspaceId,
+      bucketStart: input.bucketStart,
+      bucketEnd: input.bucketEnd,
+      jobId: input.jobId,
+    });
+
+    if (!input.dryRun) {
+      await this.state.markCompleted({
+        workspaceId: input.workspaceId,
+        bucketStart: input.bucketStart,
+        bucketEnd: input.bucketEnd,
+        jobId: input.jobId,
+      });
+    }
+  }
+
+  private closedPreviousHour(now: Date) {
+    const bucketEnd = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
+    return {
+      bucketStart: bucketEnd - HOUR_MS,
+      bucketEnd,
+    };
+  }
+
+  private async loadWorkspaces(workspaceIds?: string[]): Promise<WorkspaceRow[]> {
+    if (workspaceIds?.length) {
+      return workspaceIds.map((id) => ({
+        id,
+        slug: id,
+      }));
+    }
+
+    const rows = await db.query.workspaces.findMany({
+      columns: {
+        id: true,
+        slug: true,
+      },
+      limit: 10_000,
+    });
+
+    return rows;
+  }
+}
diff --git a/web/apps/dashboard/app/api/internal/jobs/api-usage-rollup/route.ts b/web/apps/dashboard/app/api/internal/jobs/api-usage-rollup/route.ts
new file mode 100644
index 0000000000..0417c3e935
--- /dev/null
+++ b/web/apps/dashboard/app/api/internal/jobs/api-usage-rollup/route.ts
@@ -0,0 +1,119 @@
+import { NextResponse } from "next/server";
+import { z } from "zod";
+
+import { env } from "@/lib/env";
+import { ApiUsageRollupRunner } from "@/lib/jobs/api-usage-rollup/runner";
+
+const bodySchema = z.object({
+  workspaceIds: z.array(z.string()).optional(),
+  now: z.string().datetime().optional(),
+  dryRun: z.boolean().optional(),
+});
+
+export async function POST(request: Request) {
+  const token = request.headers.get("authorization")?.replace("Bearer ", "");
+  if (!token || token !== env().INTERNAL_JOB_TOKEN) {
+    return NextResponse.json(
+      {
+        error: "Unauthorized",
+      },
+      {
+        status: 401,
+      },
+    );
+  }
+
+  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
+  if (!parsed.success) {
+    return NextResponse.json(
+      {
+        error: "Invalid request",
+        issues: parsed.error.issues,
+      },
+      {
+        status: 400,
+      },
+    );
+  }
+
+  const runner = new ApiUsageRollupRunner();
+  const result = await runner.run({
+    workspaceIds: parsed.data.workspaceIds,
+    now: parsed.data.now ? new Date(parsed.data.now) : undefined,
+    dryRun: parsed.data.dryRun,
+  });
+
+  return NextResponse.json({
+    status: result.workspacesFailed > 0 ? "partial_failure" : "ok",
+    ...result,
+  });
+}
diff --git a/web/apps/dashboard/lib/trpc/routers/billing/query-usage/index.ts b/web/apps/dashboard/lib/trpc/routers/billing/query-usage/index.ts
index a2993acb54..c62a848f04 100644
--- a/web/apps/dashboard/lib/trpc/routers/billing/query-usage/index.ts
+++ b/web/apps/dashboard/lib/trpc/routers/billing/query-usage/index.ts
@@ -1,26 +1,83 @@
 import { clickhouse } from "@/lib/clickhouse";
 import { ratelimit, withRatelimit, workspaceProcedure } from "@/lib/trpc/trpc";
 import { z } from "zod";
 
 export const queryUsage = workspaceProcedure
   .use(withRatelimit(ratelimit.read))
   .input(
     z.object({
       startTime: z.number().int(),
       endTime: z.number().int(),
+      source: z.enum(["auto", "rollup", "raw"]).default("auto"),
     }),
   )
   .query(async ({ ctx, input }) => {
+    const oneHour = 60 * 60 * 1000;
+    const rangeMs = input.endTime - input.startTime;
+    const useRollup = input.source === "rollup" || (input.source === "auto" && rangeMs > oneHour);
+
+    if (useRollup) {
+      const [timeseries, total] = await Promise.all([
+        clickhouse.usageRollups.timeseries({
+          workspaceId: ctx.workspace.id,
+          startTime: input.startTime,
+          endTime: input.endTime,
+        }),
+        clickhouse.usageRollups.total({
+          workspaceId: ctx.workspace.id,
+          startTime: input.startTime,
+          endTime: input.endTime,
+        }),
+      ]);
+
+      return {
+        source: "rollup" as const,
+        timeseries,
+        total: total.val?.[0] ?? {
+          requests: 0,
+          errors: 0,
+        },
+      };
+    }
+
     const [ratelimits, verifications] = await Promise.all([
       clickhouse.billing.billableRatelimits({
         workspaceId: ctx.workspace.id,
         year: new Date(input.startTime).getUTCFullYear(),
         month: new Date(input.startTime).getUTCMonth() + 1,
       }),
       clickhouse.billing.billableVerifications({
         workspaceId: ctx.workspace.id,
         year: new Date(input.startTime).getUTCFullYear(),
         month: new Date(input.startTime).getUTCMonth() + 1,
       }),
     ]);
 
     return {
+      source: "raw" as const,
       ratelimits,
       verifications,
     };
   });
diff --git a/web/apps/dashboard/lib/jobs/api-usage-rollup/__tests__/runner.test.ts b/web/apps/dashboard/lib/jobs/api-usage-rollup/__tests__/runner.test.ts
new file mode 100644
index 0000000000..5360e795ed
--- /dev/null
+++ b/web/apps/dashboard/lib/jobs/api-usage-rollup/__tests__/runner.test.ts
@@ -0,0 +1,273 @@
+import { beforeEach, describe, expect, it, vi } from "vitest";
+
+import { ApiUsageRollupRunner } from "../runner";
+
+const startHourlyRun = vi.fn().mockResolvedValue({ val: [] });
+const insertHourly = vi.fn().mockResolvedValue({
+  val: [
+    {
+      rows_inserted: 17,
+    },
+  ],
+});
+const finishHourlyRun = vi.fn().mockResolvedValue({ val: [] });
+
+vi.mock("@/lib/clickhouse", () => ({
+  clickhouse: {
+    usageRollups: {
+      startHourlyRun,
+      insertHourly,
+      finishHourlyRun,
+    },
+  },
+}));
+
+vi.mock("@/lib/db", () => ({
+  db: {
+    query: {
+      workspaces: {
+        findMany: vi.fn().mockResolvedValue([
+          {
+            id: "ws_1",
+            slug: "workspace-one",
+          },
+          {
+            id: "ws_2",
+            slug: "workspace-two",
+          },
+        ]),
+      },
+    },
+  },
+}));
+
+describe("ApiUsageRollupRunner", () => {
+  let state: any;
+
+  beforeEach(() => {
+    vi.clearAllMocks();
+    state = {
+      findForWorkspace: vi.fn().mockResolvedValue(null),
+      upsertRunning: vi.fn().mockResolvedValue(undefined),
+      markCompleted: vi.fn().mockResolvedValue(undefined),
+      markFailed: vi.fn().mockResolvedValue(undefined),
+    };
+  });
+
+  it("closes the previous wall-clock hour", async () => {
+    const runner = new ApiUsageRollupRunner(state);
+    const result = await runner.run({
+      now: new Date("2026-05-16T10:07:30.000Z"),
+      workspaceIds: ["ws_1"],
+    });
+
+    expect(result.bucketStart).toBe(Date.parse("2026-05-16T09:00:00.000Z"));
+    expect(result.bucketEnd).toBe(Date.parse("2026-05-16T10:00:00.000Z"));
+    expect(startHourlyRun).toHaveBeenCalledWith({
+      jobId: result.jobId,
+      bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      workspaceIds: ["ws_1"],
+    });
+    expect(insertHourly).toHaveBeenCalledWith({
+      jobId: result.jobId,
+      bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      workspaceIds: ["ws_1"],
+    });
+  });
+
+  it("marks each workspace completed before the aggregate insert", async () => {
+    const runner = new ApiUsageRollupRunner(state);
+    const result = await runner.run({
+      now: new Date("2026-05-16T10:00:05.000Z"),
+      workspaceIds: ["ws_1", "ws_2"],
+    });
+
+    expect(result.workspacesSucceeded).toBe(2);
+    expect(state.upsertRunning).toHaveBeenCalledTimes(2);
+    expect(state.markCompleted).toHaveBeenCalledTimes(2);
+    expect(insertHourly).toHaveBeenCalledTimes(1);
+  });
+
+  it("skips a workspace when its state already closed the bucket", async () => {
+    state.findForWorkspace.mockResolvedValue({
+      workspaceId: "ws_1",
+      lastClosedBucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      lastClosedBucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      lastJobId: "previous-job",
+      status: "completed",
+      error: null,
+    });
+
+    const runner = new ApiUsageRollupRunner(state);
+    const result = await runner.run({
+      now: new Date("2026-05-16T10:10:00.000Z"),
+      workspaceIds: ["ws_1"],
+    });
+
+    expect(result.workspacesSucceeded).toBe(1);
+    expect(state.upsertRunning).not.toHaveBeenCalled();
+    expect(state.markCompleted).not.toHaveBeenCalled();
+    expect(insertHourly).toHaveBeenCalledTimes(1);
+  });
+
+  it("lets retry run with a new job id", async () => {
+    const runner = new ApiUsageRollupRunner(state);
+
+    const first = await runner.run({
+      now: new Date("2026-05-16T10:10:00.000Z"),
+      workspaceIds: ["ws_1"],
+    });
+
+    state.findForWorkspace.mockResolvedValue(null);
+
+    const second = await runner.run({
+      now: new Date("2026-05-16T10:10:00.000Z"),
+      workspaceIds: ["ws_1"],
+    });
+
+    expect(first.jobId).not.toBe(second.jobId);
+    expect(insertHourly).toHaveBeenCalledTimes(2);
+    expect(finishHourlyRun).toHaveBeenCalledTimes(2);
+  });
+
+  it("supports dry run without aggregate insert", async () => {
+    const runner = new ApiUsageRollupRunner(state);
+    const result = await runner.run({
+      now: new Date("2026-05-16T10:10:00.000Z"),
+      workspaceIds: ["ws_1"],
+      dryRun: true,
+    });
+
+    expect(result.rowsInserted).toBe(0);
+    expect(insertHourly).not.toHaveBeenCalled();
+    expect(state.upsertRunning).toHaveBeenCalled();
+    expect(state.markCompleted).not.toHaveBeenCalled();
+  });
+});
diff --git a/web/internal/clickhouse/src/__tests__/usage-rollups.test.ts b/web/internal/clickhouse/src/__tests__/usage-rollups.test.ts
new file mode 100644
index 0000000000..5d78cbd4a2
--- /dev/null
+++ b/web/internal/clickhouse/src/__tests__/usage-rollups.test.ts
@@ -0,0 +1,248 @@
+import { describe, expect, it, vi } from "vitest";
+
+import {
+  insertHourlyUsageRollup,
+  queryHourlyUsageRollups,
+  queryHourlyUsageTotal,
+  startHourlyUsageRun,
+} from "../usage-rollups";
+
+function makeQuerier() {
+  const calls: any[] = [];
+  const ch = {
+    query: vi.fn((spec) => {
+      calls.push(spec);
+      return vi.fn().mockResolvedValue({
+        val: [
+          {
+            rows_inserted: 3,
+            x: Date.parse("2026-05-16T09:00:00.000Z"),
+            requests: 10,
+            errors: 1,
+            p95_latency_ms: 42,
+          },
+        ],
+      });
+    }),
+  };
+
+  return {
+    ch: ch as any,
+    calls,
+  };
+}
+
+describe("usage rollups clickhouse queries", () => {
+  it("starts a run by scanning the exact bucket window", async () => {
+    const { ch, calls } = makeQuerier();
+    const start = startHourlyUsageRun(ch);
+
+    await start({
+      jobId: "job_1",
+      bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      workspaceIds: ["ws_1"],
+    });
+
+    expect(calls[0].query).toContain("WHERE time >= {bucketStart: Int64}");
+    expect(calls[0].query).toContain("AND time < {bucketEnd: Int64}");
+    expect(calls[0].query).toContain("workspace_id IN {workspaceIds: Array(String)}");
+  });
+
+  it("inserts hourly aggregates from raw events", async () => {
+    const { ch, calls } = makeQuerier();
+    const insert = insertHourlyUsageRollup(ch);
+
+    await insert({
+      jobId: "job_1",
+      bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      workspaceIds: ["ws_1"],
+    });
+
+    expect(calls[0].query).toContain("INSERT INTO default.api_usage_hourly_rollups_v1");
+    expect(calls[0].query).toContain("FROM default.api_requests_raw_v2");
+    expect(calls[0].query).toContain("time >= {bucketStart: Int64}");
+    expect(calls[0].query).toContain("time < {bucketEnd: Int64}");
+    expect(calls[0].query).toContain("{jobId: String} AS source_job_id");
+  });
+
+  it("queries totals from the rollup read view", async () => {
+    const { ch, calls } = makeQuerier();
+    const total = queryHourlyUsageTotal(ch);
+
+    await total({
+      workspaceId: "ws_1",
+      startTime: Date.parse("2026-05-16T09:00:00.000Z"),
+      endTime: Date.parse("2026-05-16T10:00:00.000Z"),
+    });
+
+    expect(calls[0].query).toContain("FROM default.api_usage_hourly_rollups_read_v1");
+    expect(calls[0].query).toContain("sum(request_count) AS requests");
+  });
+
+  it("fills missing hours in the timeseries", async () => {
+    const { ch, calls } = makeQuerier();
+    const timeseries = queryHourlyUsageRollups(ch);
+
+    await timeseries({
+      workspaceId: "ws_1",
+      startTime: Date.parse("2026-05-16T00:00:00.000Z"),
+      endTime: Date.parse("2026-05-16T12:00:00.000Z"),
+    });
+
+    expect(calls[0].query).toContain("WITH FILL");
+    expect(calls[0].query).toContain("STEP 3600000");
+  });
+});
diff --git a/web/apps/dashboard/lib/jobs/api-usage-rollup/reconcile.ts b/web/apps/dashboard/lib/jobs/api-usage-rollup/reconcile.ts
new file mode 100644
index 0000000000..b9f5d2930c
--- /dev/null
+++ b/web/apps/dashboard/lib/jobs/api-usage-rollup/reconcile.ts
@@ -0,0 +1,204 @@
+import { z } from "zod";
+
+import { clickhouse } from "@/lib/clickhouse";
+
+export const reconcileUsageRollupInput = z.object({
+  workspaceId: z.string(),
+  bucketStart: z.number().int(),
+  bucketEnd: z.number().int(),
+  tolerance: z.number().int().nonnegative().default(0),
+});
+
+export type ReconcileUsageRollupInput = z.infer<typeof reconcileUsageRollupInput>;
+
+export type UsageRollupReconcileResult = {
+  workspaceId: string;
+  bucketStart: number;
+  bucketEnd: number;
+  rawRequests: number;
+  rollupRequests: number;
+  rawErrors: number;
+  rollupErrors: number;
+  requestDelta: number;
+  errorDelta: number;
+  withinTolerance: boolean;
+};
+
+type RawUsageRow = {
+  requests: number;
+  errors: number;
+};
+
+type RollupUsageRow = {
+  requests: number;
+  errors: number;
+};
+
+export class ApiUsageRollupReconciler {
+  async reconcile(input: ReconcileUsageRollupInput): Promise<UsageRollupReconcileResult> {
+    const parsed = reconcileUsageRollupInput.parse(input);
+    const [raw, rollup] = await Promise.all([
+      this.queryRaw(parsed),
+      this.queryRollup(parsed),
+    ]);
+
+    const requestDelta = raw.requests - rollup.requests;
+    const errorDelta = raw.errors - rollup.errors;
+
+    return {
+      workspaceId: parsed.workspaceId,
+      bucketStart: parsed.bucketStart,
+      bucketEnd: parsed.bucketEnd,
+      rawRequests: raw.requests,
+      rollupRequests: rollup.requests,
+      rawErrors: raw.errors,
+      rollupErrors: rollup.errors,
+      requestDelta,
+      errorDelta,
+      withinTolerance:
+        Math.abs(requestDelta) <= parsed.tolerance && Math.abs(errorDelta) <= parsed.tolerance,
+    };
+  }
+
+  async reconcileMany(inputs: ReconcileUsageRollupInput[]) {
+    const results: UsageRollupReconcileResult[] = [];
+
+    for (const input of inputs) {
+      results.push(await this.reconcile(input));
+    }
+
+    return {
+      results,
+      failed: results.filter((result) => !result.withinTolerance),
+      ok: results.filter((result) => result.withinTolerance),
+    };
+  }
+
+  private async queryRaw(input: ReconcileUsageRollupInput): Promise<RawUsageRow> {
+    const result = await clickhouse.rawQuery({
+      query: `
+SELECT
+  count(*) AS requests,
+  countIf(response_status >= 500 OR length(error) > 0) AS errors
+FROM default.api_requests_raw_v2
+WHERE workspace_id = {workspaceId: String}
+  AND time >= {bucketStart: Int64}
+  AND time < {bucketEnd: Int64}`,
+      params: {
+        workspaceId: input.workspaceId,
+        bucketStart: input.bucketStart,
+        bucketEnd: input.bucketEnd,
+      },
+    });
+
+    return this.parseSingleRow(result, {
+      requests: 0,
+      errors: 0,
+    });
+  }
+
+  private async queryRollup(input: ReconcileUsageRollupInput): Promise<RollupUsageRow> {
+    const result = await clickhouse.usageRollups.total({
+      workspaceId: input.workspaceId,
+      startTime: input.bucketStart,
+      endTime: input.bucketEnd,
+    });
+
+    return result.val?.[0] ?? {
+      requests: 0,
+      errors: 0,
+    };
+  }
+
+  private parseSingleRow<T extends Record<string, number>>(result: unknown, fallback: T): T {
+    if (!result || typeof result !== "object" || !("val" in result)) {
+      return fallback;
+    }
+
+    const val = (result as { val?: unknown[] }).val;
+    if (!Array.isArray(val) || val.length === 0) {
+      return fallback;
+    }
+
+    return {
+      ...fallback,
+      ...(val[0] as T),
+    };
+  }
+}
+
+export function summarizeUsageRollupReconciliation(results: UsageRollupReconcileResult[]) {
+  const totalRaw = results.reduce((sum, result) => sum + result.rawRequests, 0);
+  const totalRollup = results.reduce((sum, result) => sum + result.rollupRequests, 0);
+  const totalRawErrors = results.reduce((sum, result) => sum + result.rawErrors, 0);
+  const totalRollupErrors = results.reduce((sum, result) => sum + result.rollupErrors, 0);
+  const failed = results.filter((result) => !result.withinTolerance);
+
+  return {
+    checked: results.length,
+    failed: failed.length,
+    totalRaw,
+    totalRollup,
+    totalRawErrors,
+    totalRollupErrors,
+    requestDelta: totalRaw - totalRollup,
+    errorDelta: totalRawErrors - totalRollupErrors,
+  };
+}
diff --git a/web/apps/dashboard/lib/jobs/api-usage-rollup/__tests__/reconcile.test.ts b/web/apps/dashboard/lib/jobs/api-usage-rollup/__tests__/reconcile.test.ts
new file mode 100644
index 0000000000..873be58050
--- /dev/null
+++ b/web/apps/dashboard/lib/jobs/api-usage-rollup/__tests__/reconcile.test.ts
@@ -0,0 +1,244 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+
+import {
+  ApiUsageRollupReconciler,
+  summarizeUsageRollupReconciliation,
+} from "../reconcile";
+
+const rawQuery = vi.fn();
+const total = vi.fn();
+
+vi.mock("@/lib/clickhouse", () => ({
+  clickhouse: {
+    rawQuery,
+    usageRollups: {
+      total,
+    },
+  },
+}));
+
+describe("ApiUsageRollupReconciler", () => {
+  beforeEach(() => {
+    vi.clearAllMocks();
+    rawQuery.mockResolvedValue({
+      val: [
+        {
+          requests: 100,
+          errors: 7,
+        },
+      ],
+    });
+    total.mockResolvedValue({
+      val: [
+        {
+          requests: 100,
+          errors: 7,
+        },
+      ],
+    });
+  });
+
+  it("compares raw and rollup counts for one bucket", async () => {
+    const reconciler = new ApiUsageRollupReconciler();
+    const result = await reconciler.reconcile({
+      workspaceId: "ws_1",
+      bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      tolerance: 0,
+    });
+
+    expect(result.withinTolerance).toBe(true);
+    expect(result.requestDelta).toBe(0);
+    expect(result.errorDelta).toBe(0);
+    expect(rawQuery).toHaveBeenCalledWith({
+      query: expect.stringContaining("FROM default.api_requests_raw_v2"),
+      params: {
+        workspaceId: "ws_1",
+        bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+        bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      },
+    });
+    expect(total).toHaveBeenCalledWith({
+      workspaceId: "ws_1",
+      startTime: Date.parse("2026-05-16T09:00:00.000Z"),
+      endTime: Date.parse("2026-05-16T10:00:00.000Z"),
+    });
+  });
+
+  it("reports late raw events as a negative rollup delta", async () => {
+    rawQuery.mockResolvedValue({
+      val: [
+        {
+          requests: 103,
+          errors: 7,
+        },
+      ],
+    });
+    total.mockResolvedValue({
+      val: [
+        {
+          requests: 100,
+          errors: 7,
+        },
+      ],
+    });
+
+    const reconciler = new ApiUsageRollupReconciler();
+    const result = await reconciler.reconcile({
+      workspaceId: "ws_1",
+      bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      tolerance: 0,
+    });
+
+    expect(result.withinTolerance).toBe(false);
+    expect(result.requestDelta).toBe(3);
+  });
+
+  it("reports duplicate rollup rows as a positive rollup delta", async () => {
+    rawQuery.mockResolvedValue({
+      val: [
+        {
+          requests: 100,
+          errors: 7,
+        },
+      ],
+    });
+    total.mockResolvedValue({
+      val: [
+        {
+          requests: 200,
+          errors: 14,
+        },
+      ],
+    });
+
+    const reconciler = new ApiUsageRollupReconciler();
+    const result = await reconciler.reconcile({
+      workspaceId: "ws_1",
+      bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      tolerance: 0,
+    });
+
+    expect(result.withinTolerance).toBe(false);
+    expect(result.requestDelta).toBe(-100);
+    expect(result.errorDelta).toBe(-7);
+  });
+
+  it("supports a tolerance for tiny mismatches", async () => {
+    rawQuery.mockResolvedValue({
+      val: [
+        {
+          requests: 100,
+          errors: 7,
+        },
+      ],
+    });
+    total.mockResolvedValue({
+      val: [
+        {
+          requests: 99,
+          errors: 7,
+        },
+      ],
+    });
+
+    const reconciler = new ApiUsageRollupReconciler();
+    const result = await reconciler.reconcile({
+      workspaceId: "ws_1",
+      bucketStart: Date.parse("2026-05-16T09:00:00.000Z"),
+      bucketEnd: Date.parse("2026-05-16T10:00:00.000Z"),
+      tolerance: 1,
+    });
+
+    expect(result.withinTolerance).toBe(true);
+    expect(result.requestDelta).toBe(1);
+  });
+
+  it("summarizes multiple reconciliation results", () => {
+    const summary = summarizeUsageRollupReconciliation([
+      {
+        workspaceId: "ws_1",
+        bucketStart: 1,
+        bucketEnd: 2,
+        rawRequests: 100,
+        rollupRequests: 100,
+        rawErrors: 2,
+        rollupErrors: 2,
+        requestDelta: 0,
+        errorDelta: 0,
+        withinTolerance: true,
+      },
+      {
+        workspaceId: "ws_2",
+        bucketStart: 1,
+        bucketEnd: 2,
+        rawRequests: 200,
+        rollupRequests: 190,
+        rawErrors: 4,
+        rollupErrors: 3,
+        requestDelta: 10,
+        errorDelta: 1,
+        withinTolerance: false,
+      },
+    ]);
+
+    expect(summary.checked).toBe(2);
+    expect(summary.failed).toBe(1);
+    expect(summary.totalRaw).toBe(300);
+    expect(summary.totalRollup).toBe(290);
+    expect(summary.requestDelta).toBe(10);
+  });
+});
diff --git a/web/apps/dashboard/lib/jobs/api-usage-rollup/report.ts b/web/apps/dashboard/lib/jobs/api-usage-rollup/report.ts
new file mode 100644
index 0000000000..0a2d77bb1b
--- /dev/null
+++ b/web/apps/dashboard/lib/jobs/api-usage-rollup/report.ts
@@ -0,0 +1,132 @@
+import type { ApiUsageRollupRunResult } from "./runner";
+import type { UsageRollupReconcileResult } from "./reconcile";
+
+export type ApiUsageRollupReport = {
+  jobId: string;
+  bucketStart: number;
+  bucketEnd: number;
+  status: "ok" | "partial_failure" | "failed";
+  workspacesScanned: number;
+  workspacesSucceeded: number;
+  workspacesFailed: number;
+  rowsInserted: number;
+  reconciliation?: {
+    checked: number;
+    failed: number;
+    requestDelta: number;
+    errorDelta: number;
+  };
+  notes: string[];
+};
+
+export function buildApiUsageRollupReport(input: {
+  run: ApiUsageRollupRunResult;
+  reconciliation?: UsageRollupReconcileResult[];
+}): ApiUsageRollupReport {
+  const failedReconciliations = input.reconciliation?.filter((row) => !row.withinTolerance) ?? [];
+  const requestDelta =
+    input.reconciliation?.reduce((sum, row) => sum + row.requestDelta, 0) ?? 0;
+  const errorDelta = input.reconciliation?.reduce((sum, row) => sum + row.errorDelta, 0) ?? 0;
+  const notes: string[] = [];
+
+  if (input.run.workspacesFailed > 0) {
+    notes.push(`${input.run.workspacesFailed} workspaces failed during state update`);
+  }
+
+  if (failedReconciliations.length > 0) {
+    notes.push(`${failedReconciliations.length} workspaces differ from raw event counts`);
+  }
+
+  if (input.run.rowsInserted === 0) {
+    notes.push("no aggregate rows were inserted");
+  }
+
+  return {
+    jobId: input.run.jobId,
+    bucketStart: input.run.bucketStart,
+    bucketEnd: input.run.bucketEnd,
+    status:
+      input.run.workspacesFailed > 0
+        ? "partial_failure"
+        : failedReconciliations.length > 0
+          ? "failed"
+          : "ok",
+    workspacesScanned: input.run.workspacesScanned,
+    workspacesSucceeded: input.run.workspacesSucceeded,
+    workspacesFailed: input.run.workspacesFailed,
+    rowsInserted: input.run.rowsInserted,
+    reconciliation: input.reconciliation
+      ? {
+          checked: input.reconciliation.length,
+          failed: failedReconciliations.length,
+          requestDelta,
+          errorDelta,
+        }
+      : undefined,
+    notes,
+  };
+}
+
+export function formatApiUsageRollupReport(report: ApiUsageRollupReport) {
+  const lines = [
+    `job=${report.jobId}`,
+    `bucket=${new Date(report.bucketStart).toISOString()}..${new Date(report.bucketEnd).toISOString()}`,
+    `status=${report.status}`,
+    `workspaces=${report.workspacesSucceeded}/${report.workspacesScanned}`,
+    `rows_inserted=${report.rowsInserted}`,
+  ];
+
+  if (report.reconciliation) {
+    lines.push(`reconcile_checked=${report.reconciliation.checked}`);
+    lines.push(`reconcile_failed=${report.reconciliation.failed}`);
+    lines.push(`request_delta=${report.reconciliation.requestDelta}`);
+    lines.push(`error_delta=${report.reconciliation.errorDelta}`);
+  }
+
+  for (const note of report.notes) {
+    lines.push(`note=${note}`);
+  }
+
+  return lines.join("\n");
+}
diff --git a/docs/operations/api-usage-hourly-rollups.md b/docs/operations/api-usage-hourly-rollups.md
new file mode 100644
index 0000000000..e7a09e163d
--- /dev/null
+++ b/docs/operations/api-usage-hourly-rollups.md
@@ -0,0 +1,179 @@
+# API Usage Hourly Rollups
+
+The API usage hourly rollup job precomputes dashboard and billing usage counts
+from `default.api_requests_raw_v2`.
+
+## Schedule
+
+Run the job once per hour:
+
+```bash
+curl -X POST "$DASHBOARD_URL/api/internal/jobs/api-usage-rollup" \
+  -H "authorization: Bearer $INTERNAL_JOB_TOKEN" \
+  -H "content-type: application/json" \
+  -d '{}'
+```
+
+The job closes the previous wall-clock hour. For example, if it runs at
+10:07:30 UTC, it closes 09:00:00 through 09:59:59.999 UTC.
+
+## Tables
+
+The rollup writes to:
+
+- `default.api_usage_hourly_rollups_v1`
+- `default.api_usage_rollup_runs_v1`
+- `api_usage_rollup_state` in MySQL
+
+Dashboard usage queries read `default.api_usage_hourly_rollups_read_v1` for
+ranges longer than one hour.
+
+## Success checks
+
+Check the run table:
+
+```sql
+SELECT job_id,
+       bucket_start,
+       bucket_end,
+       status,
+       rows_inserted,
+       error
+FROM default.api_usage_rollup_runs_v1
+ORDER BY started_at DESC
+LIMIT 20;
+```
+
+Check the workspace state:
+
+```sql
+SELECT workspace_id,
+       last_closed_bucket_start,
+       last_closed_bucket_end,
+       last_job_id,
+       status,
+       error
+FROM api_usage_rollup_state
+WHERE workspace_id = '<workspace-id>';
+```
+
+Check a specific hour:
+
+```sql
+SELECT workspace_id,
+       bucket_start,
+       sum(request_count) AS requests,
+       sum(error_count) AS errors
+FROM default.api_usage_hourly_rollups_read_v1
+WHERE workspace_id = '<workspace-id>'
+  AND bucket_start = toDateTime('2026-05-16 09:00:00')
+GROUP BY workspace_id, bucket_start;
+```
+
+## Retry behavior
+
+It is safe to retry a failed job. The retry receives a new job id and inserts a
+new set of aggregate rows. Because the read view groups by workspace, bucket,
+host, method, path, and response status, duplicate rows are merged at read time.
+
+If a retry inserted rows twice, totals may look temporarily high until
+ClickHouse merges background parts. Wait for merge completion before escalating.
+
+## Late events
+
+Raw API request events are buffered by the API service and flushed to
+ClickHouse. The hourly job closes buckets based on wall-clock time. Events that
+arrive after the bucket closes are not included in the closed bucket.
+
+This is expected for dashboard cost reduction. Support should compare raw logs
+to rollups if a customer asks about a mismatch.
+
+## Manual backfill
+
+To rerun one workspace for a specific hour, send:
+
+```bash
+curl -X POST "$DASHBOARD_URL/api/internal/jobs/api-usage-rollup" \
+  -H "authorization: Bearer $INTERNAL_JOB_TOKEN" \
+  -H "content-type: application/json" \
+  -d '{
+    "workspaceIds": ["ws_123"],
+    "now": "2026-05-16T10:10:00.000Z"
+  }'
+```
+
+The job will close the previous hour relative to `now`.
+
+## Support notes
+
+When investigating usage discrepancies, collect:
+
+- workspace id,
+- job id,
+- bucket start,
+- bucket end,
+- count from `api_requests_raw_v2`,
+- count from `api_usage_hourly_rollups_read_v1`,
+- current `api_usage_rollup_state`,
+- whether the job was retried.
+
+Raw comparison query:
+
+```sql
+SELECT count(*) AS requests
+FROM default.api_requests_raw_v2
+WHERE workspace_id = '<workspace-id>'
+  AND time >= toUnixTimestamp64Milli(toDateTime64('2026-05-16 09:00:00', 3))
+  AND time < toUnixTimestamp64Milli(toDateTime64('2026-05-16 10:00:00', 3));
+```
+
+Rollup comparison query:
+
+```sql
+SELECT sum(request_count) AS requests
+FROM default.api_usage_hourly_rollups_read_v1
+WHERE workspace_id = '<workspace-id>'
+  AND bucket_start = toDateTime('2026-05-16 09:00:00');
+```
+
+If raw is higher than rollup, the missing events probably arrived after the
+bucket closed. If rollup is higher than raw, the job probably retried and
+inserted duplicate aggregate rows.
```

## Intended Flaws

### Flaw 1: The rollup closes buckets at wall-clock hour boundaries and drops late events

The PR treats the previous hour as complete as soon as the cron runs. It queries raw events only once for `[bucketStart, bucketEnd)`, advances workspace state to that closed bucket, and switches dashboard usage queries to the rollup table. Raw API request ingestion is buffered and ClickHouse inserts can be delayed or retried, so events with timestamps inside the closed hour can arrive after the job has already sealed it.

Relevant line references:

- `web/apps/dashboard/lib/jobs/api-usage-rollup/runner.ts:26-44` chooses the previous wall-clock hour from `now`.
- `web/internal/clickhouse/src/usage-rollups.ts:72-101` inserts aggregates using a strict `time >= bucketStart AND time < bucketEnd` query over raw events.
- `web/apps/dashboard/lib/jobs/api-usage-rollup/state.ts:35-75` advances `lastClosedBucketEnd` without any watermark or late-arrival window.
- `web/apps/dashboard/lib/trpc/routers/billing/query-usage/index.ts:15-38` switches ranges longer than one hour to the new rollup source.
- `docs/operations/api-usage-hourly-rollups.md:82-90` documents late events as expected discrepancies instead of a correctness problem.

Why this is a real flaw:

Event time and processing time are different. Unkey already buffers API request events before flushing to ClickHouse, and ClickHouse async inserts can retry. A request that happened at 09:59:58 can land in raw storage after the 10:00 job finishes. A one-shot rollup never sees it, but the dashboard/billing query now trusts the rollup. That silently undercounts usage and creates reconciliation disputes.

Better implementation direction:

Use a watermark and late-arrival window. Keep a mutable trailing window open, recompute recent buckets, and only mark buckets final after ingestion delay has passed. Alternatively keep using ClickHouse materialized views for event-time rollups, because they update as late raw rows arrive. If a manual job is needed, process `bucketEnd <= watermark`, persist cursor state, and reprocess overlapping windows safely.

### Flaw 2: Retrying the rollup inserts duplicate aggregate rows and double counts usage

The PR writes aggregates with plain `INSERT INTO api_usage_hourly_rollups_v1 SELECT ...` and uses a `SummingMergeTree` read view that sums all rows for the same key. A retry gets a new job id and inserts the same bucket again. The tests explicitly allow this retry behavior, and the docs claim duplicate rows will be fixed by ClickHouse background merges even though `SummingMergeTree` merges by adding values.

Relevant line references:

- `pkg/clickhouse/schema/037_api_usage_hourly_rollups_v1.sql:5-31` stores rollup rows in `SummingMergeTree` with `source_job_id` outside the sort key, so duplicate source jobs for the same aggregate key add together.
- `web/internal/clickhouse/src/usage-rollups.ts:72-101` inserts aggregate rows without deleting, replacing, or versioning the existing bucket.
- `web/apps/dashboard/lib/jobs/api-usage-rollup/runner.ts:36-94` creates a new job id on every run and inserts after per-workspace state changes, so retry can write the same bucket again.
- `web/apps/dashboard/lib/jobs/api-usage-rollup/__tests__/runner.test.ts:115-132` asserts that retry runs the same bucket twice with different job ids.
- `docs/operations/api-usage-hourly-rollups.md:73-80` says retrying is safe and duplicates will merge away, which is false for summed counts.

Why this is a real flaw:

Rollup jobs must be idempotent. Retrying after a network error, timeout, partial failure, or deploy restart is normal. If the retry writes another set of aggregate rows, usage is double counted. Because the read view groups by the aggregate key and sums `request_count`, this is not a temporary background-merge artifact; the duplicate rows become the answer.

Better implementation direction:

Make the write idempotent by keying rollups by source bucket and aggregation dimensions. Use a replaceable/versioned table, a staging table followed by atomic partition replacement, or delete-and-insert for the bucket under a lock. Track job attempts separately from rollup data. A retry should recompute the same bucket and leave the same final counts, not add another copy.

## Hints

### Flaw 1 Hints

1. What happens to an event with `time = 09:59:58` if it reaches ClickHouse at `10:01:10`?
2. Which state says the 09:00 hour is final?
3. What is the difference between event time and the time the cron happens to run?

### Flaw 2 Hints

1. What does `SummingMergeTree` do when two rows have the same aggregate key?
2. Does the retry path replace an existing bucket or insert another copy?
3. Is `source_job_id` part of the read grouping or just metadata?

## Expected Answer

A strong review should say that the product-level change is a manual hourly usage rollup, but the implementation breaks two fundamental analytics contracts: late-arriving raw events must still be counted, and retries must be idempotent.

For flaw 1, the learner should identify that the job closes the previous wall-clock hour and advances state immediately. The impact is undercounted usage when raw events arrive late due to API buffers, retries, async inserts, or ingestion lag. The fix is a watermark/late-arrival window, overlapping recomputation, or materialized views that aggregate by event time as rows arrive.

For flaw 2, the learner should identify that retrying the same bucket inserts duplicate aggregate rows into a summing table. The impact is double-counted dashboard and billing usage. The fix is an idempotent rollup write: replace by bucket/source key, use a staging table plus partition swap, or use a versioned/replacing table with deterministic bucket keys.

The best answers should connect the flaws to Unkey's existing contracts: raw events are the source of truth, buffers and async inserts mean late arrival is normal, materialized views already aggregate by event time, and aggregate tables must reconcile with raw counts under retry.

## Expert Debrief

At the product level, this PR is trying to reduce query cost. That is a good motivation, but analytics systems live or die on correctness contracts. Performance optimizations cannot change what a count means.

The first contract is time. Raw API requests have event time. The rollup job has processing time. Closing the previous hour because the wall clock moved to the next hour assumes ingestion is perfectly synchronous. It is not. Unkey's own API service buffers ClickHouse writes and the flush path retries. A correct rollup either lets ClickHouse materialized views update as late events arrive or keeps a watermark so recent buckets remain mutable.

The second contract is idempotency. Rollup jobs are batch jobs. Batch jobs retry. If a retry can add counts again, the job is not safe. `SummingMergeTree` is not a dedupe system here; it is literally the mechanism that makes duplicate aggregate rows count twice.

The failure modes are concrete:

- A high-volume customer sees fewer requests in billing than in raw logs because late rows missed the closed hour.
- Support cannot reconcile usage because rollup state says the bucket is complete.
- A deployment timeout causes the same bucket to run twice and double count.
- Dashboard usage switches to rollups for longer ranges and hides the mismatch.
- Operators are told to wait for merges even though merges preserve summed duplicates.

The reviewer thought process should be: first ask what the source of truth is and how data moves from raw to aggregate. Then separate event time from processing time. Finally, force every retry path through the question: if this code runs twice for the same bucket, is the final answer unchanged?

The better implementation is either to stay with materialized views or build a true rollup state machine: compute from raw events for a watermark-safe window, write into a staging table, atomically replace the target bucket, and record job attempts separately. Recent buckets should be recomputed until the late-arrival window closes. Closed buckets should be deterministic and idempotent.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: wall-clock bucket closure drops late events, and retry inserts duplicate aggregate rows into a summing rollup table. It explains undercounting, double counting, dashboard/billing mismatch, and suggests watermark/late-arrival recomputation plus idempotent replace/upsert-by-bucket writes.
- `partial`: The answer finds one flaw completely and mentions either late events or duplicate retries without tying it to Unkey's buffering/materialized-view/raw-event contracts.
- `miss`: The answer focuses on route auth, naming, missing filters, or generic cron reliability while missing event-time correctness and retry idempotency.
