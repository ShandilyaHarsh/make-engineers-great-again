# TS-043: Langfuse Trace Compaction Job

## Metadata

- `id`: TS-043
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: worker queues, periodic cleaners, ClickHouse trace/observation/score repositories, retention-style background jobs, trace metrics, compaction state
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,500-1,850
- `represented_diff_lines`: 1501
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about background compaction, ClickHouse query shape, cursoring, destructive cleanup, metric materialization, and queue operations without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a trace compaction job for older traces. The goal is to reduce storage and speed up the trace table for projects with large historical datasets.

Today trace rows, observation rows, score rows, and event rows are retained as raw ClickHouse records until retention or explicit deletion removes them. This PR introduces a compacted trace summary table. A periodic worker scans old traces, computes summary metrics, writes a compacted row, deletes raw trace details, and marks the trace as compacted.

The PR adds:

- a `trace-compaction` queue and worker,
- a periodic compaction runner,
- ClickHouse repository helpers for candidate discovery, metric materialization, and raw-detail deletion,
- a Prisma table for compaction progress,
- worker metrics,
- tests for compaction of old traces, retry behavior, and trace table fallback,
- docs for operating trace compaction.

The intended product behavior is: old traces can be compacted without overloading ClickHouse and without losing the metrics that power trace tables, dashboards, and exports.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `worker/src/features/batch-trace-deletion-cleaner/index.ts` processes one project with the most pending trace deletions per iteration and uses `LANGFUSE_DELETE_BATCH_SIZE` instead of sweeping every trace each run.
- `worker/src/features/batch-data-retention-cleaner/index.ts` chunks projects, counts expired ClickHouse rows per table, selects a bounded project set, and deletes with table-specific locks.
- `worker/src/queues/traceDelete.ts` batches trace deletion work, slices to `LANGFUSE_DELETE_BATCH_SIZE`, and marks `pending_deletions` only after deletion succeeds.
- `worker/src/features/traces/processClickhouseTraceDelete.ts` deletes traces, observations, scores, events, and media together. It is a destructive path, not a metric materialization path.
- `packages/shared/src/server/repositories/traces.ts` scopes `DELETE FROM traces` by project, trace ids, and preflight time bounds to avoid broad ClickHouse mutations.
- `packages/shared/src/server/services/traces-ui-table-service.ts` derives trace table metrics from observations and scores: latency, usage, cost, level counts, and score aggregates. If those raw rows disappear before summaries exist, the trace table loses information.
- `worker/src/queues/workerManager.ts` wraps queue processors with timing/depth metrics, so new worker paths should preserve bounded work and observable failure modes.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the compaction worker is bounded and whether it preserves derived trace metrics before destructive cleanup.

## Review Surface

Changed files in the synthetic PR:

- `packages/shared/prisma/migrations/20260516090000_add_trace_compactions/migration.sql`
- `packages/shared/src/server/queues.ts`
- `packages/shared/src/server/repositories/trace-compactions.ts`
- `packages/shared/src/server/repositories/traces.ts`
- `worker/src/features/trace-compaction/traceCompactionRunner.ts`
- `worker/src/features/trace-compaction/traceCompactionProcessor.ts`
- `worker/src/features/trace-compaction/index.ts`
- `worker/src/queues/traceCompaction.ts`
- `worker/src/queues/workerManager.ts`
- `worker/src/__tests__/traceCompaction.test.ts`
- `worker/src/__tests__/traceCompactionProcessor.test.ts`
- `docs/operations/trace-compaction.md`

The line references below use synthetic PR line numbers. The represented diff is focused on background-job query boundaries, cursor/progress state, destructive ClickHouse cleanup, metric materialization ordering, and tests that normalize an unsafe compaction contract.

## Diff

```diff
diff --git a/packages/shared/prisma/migrations/20260516090000_add_trace_compactions/migration.sql b/packages/shared/prisma/migrations/20260516090000_add_trace_compactions/migration.sql
new file mode 100644
index 0000000000..d74ae86122
--- /dev/null
+++ b/packages/shared/prisma/migrations/20260516090000_add_trace_compactions/migration.sql
@@ -0,0 +1,86 @@
+CREATE TABLE "trace_compactions" (
+  "id" TEXT NOT NULL,
+  "project_id" TEXT NOT NULL,
+  "trace_id" TEXT NOT NULL,
+  "timestamp" TIMESTAMP(3) NOT NULL,
+  "compacted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  "status" TEXT NOT NULL DEFAULT 'pending',
+  "observation_count" INTEGER NOT NULL DEFAULT 0,
+  "score_count" INTEGER NOT NULL DEFAULT 0,
+  "total_cost" DOUBLE PRECISION,
+  "latency_ms" INTEGER,
+  "usage_details" JSONB,
+  "score_summary" JSONB,
+  "error_count" INTEGER NOT NULL DEFAULT 0,
+  "warning_count" INTEGER NOT NULL DEFAULT 0,
+  "last_error" TEXT,
+  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  CONSTRAINT "trace_compactions_pkey" PRIMARY KEY ("id")
+);
+
+CREATE UNIQUE INDEX "trace_compactions_project_id_trace_id_key"
+  ON "trace_compactions"("project_id", "trace_id");
+
+CREATE INDEX "trace_compactions_project_status_timestamp_idx"
+  ON "trace_compactions"("project_id", "status", "timestamp");
+
+ALTER TABLE "trace_compactions"
+  ADD CONSTRAINT "trace_compactions_project_id_fkey"
+  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
+  ON DELETE CASCADE
+  ON UPDATE CASCADE;
diff --git a/packages/shared/src/server/queues.ts b/packages/shared/src/server/queues.ts
index 4df1526d9e..d47c305c57 100644
--- a/packages/shared/src/server/queues.ts
+++ b/packages/shared/src/server/queues.ts
@@ -322,6 +322,7 @@ export enum QueueName {
   TraceUpsert = "trace-upsert", // Ingestion pipeline adds events on each Trace upsert
   TraceDelete = "trace-delete",
+  TraceCompaction = "trace-compaction",
   ProjectDelete = "project-delete",
   EvaluationExecution = "evaluation-execution-queue", // Worker executes Evals
@@ -365,6 +366,7 @@ export enum QueueJobs {
   TraceUpsert = "trace-upsert",
   TraceDelete = "trace-delete",
+  TraceCompaction = "trace-compaction",
   ProjectDelete = "project-delete",
   DatasetRunItemUpsert = "dataset-run-item-upsert",
@@ -402,6 +404,15 @@ export type TQueueJobTypes = {
     payload: TracesQueueEventType | TraceQueueEventType;
     name: QueueJobs.TraceDelete;
   };
+  [QueueName.TraceCompaction]: {
+    timestamp: Date;
+    id: string;
+    name: QueueJobs.TraceCompaction;
+    payload: {
+      projectId?: string;
+      beforeDate?: string;
+    };
+  };
   [QueueName.ScoreDelete]: {
     timestamp: Date;
diff --git a/packages/shared/src/server/repositories/trace-compactions.ts b/packages/shared/src/server/repositories/trace-compactions.ts
new file mode 100644
index 0000000000..cb864fe7bc
--- /dev/null
+++ b/packages/shared/src/server/repositories/trace-compactions.ts
@@ -0,0 +1,353 @@
+import { prisma } from "../../db";
+import {
+  commandClickhouse,
+  convertDateToClickhouseDateTime,
+  logger,
+  queryClickhouse,
+  recordHistogram,
+  recordIncrement,
+} from "../index";
+
+export type TraceCompactionCandidate = {
+  projectId: string;
+  traceId: string;
+  timestamp: string;
+};
+
+export type TraceCompactionSummary = {
+  projectId: string;
+  traceId: string;
+  timestamp: string;
+  observationCount: number;
+  scoreCount: number;
+  totalCost: number | null;
+  latencyMs: number | null;
+  usageDetails: Record<string, number>;
+  scoreSummary: Array<{ name: string; value: number | string | boolean }>;
+  errorCount: number;
+  warningCount: number;
+};
+
+export type FindTraceCompactionCandidatesArgs = {
+  projectId?: string;
+  beforeDate: Date;
+};
+
+export type MaterializeTraceCompactionArgs = {
+  projectId: string;
+  traceId: string;
+  timestamp: string;
+};
+
+export type DeleteCompactedTraceDetailsArgs = {
+  projectId: string;
+  traceId: string;
+};
+
+export async function findTraceCompactionCandidates(
+  args: FindTraceCompactionCandidatesArgs,
+): Promise<TraceCompactionCandidate[]> {
+  const startedAt = Date.now();
+  const projectPredicate = args.projectId
+    ? "AND project_id = {projectId: String}"
+    : "";
+
+  const rows = await queryClickhouse<{
+    project_id: string;
+    trace_id: string;
+    timestamp: string;
+  }>({
+    query: `
+      SELECT
+        project_id,
+        id as trace_id,
+        timestamp
+      FROM traces FINAL
+      WHERE timestamp < {beforeDate: DateTime64(3)}
+        AND is_deleted = 0
+        ${projectPredicate}
+      ORDER BY timestamp ASC
+    `,
+    params: {
+      beforeDate: convertDateToClickhouseDateTime(args.beforeDate),
+      ...(args.projectId ? { projectId: args.projectId } : {}),
+    },
+    tags: {
+      feature: "trace-compaction",
+      operation: "find-candidates",
+    },
+  });
+
+  recordHistogram("langfuse.trace_compaction.find_candidates_ms", Date.now() - startedAt, {
+    unit: "milliseconds",
+  });
+  recordIncrement("langfuse.trace_compaction.candidates_found", rows.length);
+
+  return rows.map((row) => ({
+    projectId: row.project_id,
+    traceId: row.trace_id,
+    timestamp: row.timestamp,
+  }));
+}
+
+export async function materializeTraceCompaction(
+  args: MaterializeTraceCompactionArgs,
+): Promise<TraceCompactionSummary> {
+  const [observationStats, scoreStats] = await Promise.all([
+    queryClickhouse<{
+      observation_count: number;
+      total_cost: number | null;
+      latency_ms: number | null;
+      usage_details: Record<string, number>;
+      error_count: number;
+      warning_count: number;
+    }>({
+      query: `
+        SELECT
+          count(*) as observation_count,
+          sum(total_cost) as total_cost,
+          dateDiff('millisecond', min(start_time), max(end_time)) as latency_ms,
+          sumMap(usage_details) as usage_details,
+          countIf(level = 'ERROR') as error_count,
+          countIf(level = 'WARNING') as warning_count
+        FROM observations FINAL
+        WHERE project_id = {projectId: String}
+          AND trace_id = {traceId: String}
+      `,
+      params: {
+        projectId: args.projectId,
+        traceId: args.traceId,
+      },
+      tags: {
+        feature: "trace-compaction",
+        operation: "materialize-observations",
+      },
+    }),
+    queryClickhouse<{
+      score_count: number;
+      score_summary: Array<{ name: string; value: number | string | boolean }>;
+    }>({
+      query: `
+        SELECT
+          count(*) as score_count,
+          groupArray(tuple(name, coalesce(value, string_value))) as score_summary
+        FROM scores FINAL
+        WHERE project_id = {projectId: String}
+          AND trace_id = {traceId: String}
+      `,
+      params: {
+        projectId: args.projectId,
+        traceId: args.traceId,
+      },
+      tags: {
+        feature: "trace-compaction",
+        operation: "materialize-scores",
+      },
+    }),
+  ]);
+
+  const observations = observationStats[0];
+  const scores = scoreStats[0];
+
+  return {
+    projectId: args.projectId,
+    traceId: args.traceId,
+    timestamp: args.timestamp,
+    observationCount: Number(observations?.observation_count ?? 0),
+    scoreCount: Number(scores?.score_count ?? 0),
+    totalCost: observations?.total_cost ?? null,
+    latencyMs: observations?.latency_ms ?? null,
+    usageDetails: observations?.usage_details ?? {},
+    scoreSummary: scores?.score_summary ?? [],
+    errorCount: Number(observations?.error_count ?? 0),
+    warningCount: Number(observations?.warning_count ?? 0),
+  };
+}
+
+export async function upsertTraceCompactionSummary(
+  summary: TraceCompactionSummary,
+): Promise<void> {
+  await prisma.traceCompaction.upsert({
+    where: {
+      projectId_traceId: {
+        projectId: summary.projectId,
+        traceId: summary.traceId,
+      },
+    },
+    create: {
+      id: `${summary.projectId}:${summary.traceId}`,
+      projectId: summary.projectId,
+      traceId: summary.traceId,
+      timestamp: new Date(summary.timestamp),
+      status: "compacted",
+      observationCount: summary.observationCount,
+      scoreCount: summary.scoreCount,
+      totalCost: summary.totalCost,
+      latencyMs: summary.latencyMs,
+      usageDetails: summary.usageDetails,
+      scoreSummary: summary.scoreSummary,
+      errorCount: summary.errorCount,
+      warningCount: summary.warningCount,
+    },
+    update: {
+      status: "compacted",
+      observationCount: summary.observationCount,
+      scoreCount: summary.scoreCount,
+      totalCost: summary.totalCost,
+      latencyMs: summary.latencyMs,
+      usageDetails: summary.usageDetails,
+      scoreSummary: summary.scoreSummary,
+      errorCount: summary.errorCount,
+      warningCount: summary.warningCount,
+      updatedAt: new Date(),
+    },
+  });
+}
+
+export async function markTraceCompactionFailed(args: {
+  projectId: string;
+  traceId: string;
+  timestamp: string;
+  error: unknown;
+}): Promise<void> {
+  await prisma.traceCompaction.upsert({
+    where: {
+      projectId_traceId: {
+        projectId: args.projectId,
+        traceId: args.traceId,
+      },
+    },
+    create: {
+      id: `${args.projectId}:${args.traceId}`,
+      projectId: args.projectId,
+      traceId: args.traceId,
+      timestamp: new Date(args.timestamp),
+      status: "failed",
+      lastError: String(args.error),
+    },
+    update: {
+      status: "failed",
+      lastError: String(args.error),
+      updatedAt: new Date(),
+    },
+  });
+}
+
+export async function deleteCompactedTraceDetails(
+  args: DeleteCompactedTraceDetailsArgs,
+): Promise<void> {
+  logger.info("Deleting raw details for compacted trace", args);
+
+  await Promise.all([
+    commandClickhouse({
+      query: `
+        DELETE FROM observations
+        WHERE project_id = {projectId: String}
+          AND trace_id = {traceId: String}
+      `,
+      params: args,
+      tags: {
+        feature: "trace-compaction",
+        operation: "delete-observations",
+      },
+    }),
+    commandClickhouse({
+      query: `
+        DELETE FROM scores
+        WHERE project_id = {projectId: String}
+          AND trace_id = {traceId: String}
+      `,
+      params: args,
+      tags: {
+        feature: "trace-compaction",
+        operation: "delete-scores",
+      },
+    }),
+    commandClickhouse({
+      query: `
+        DELETE FROM events_full
+        WHERE project_id = {projectId: String}
+          AND trace_id = {traceId: String}
+      `,
+      params: args,
+      tags: {
+        feature: "trace-compaction",
+        operation: "delete-events-full",
+      },
+    }),
+  ]);
+}
diff --git a/packages/shared/src/server/repositories/traces.ts b/packages/shared/src/server/repositories/traces.ts
index f77d22ba12..c52f85bc31 100644
--- a/packages/shared/src/server/repositories/traces.ts
+++ b/packages/shared/src/server/repositories/traces.ts
@@ -933,6 +933,54 @@ export const deleteTraces = async (projectId: string, traceIds: string[]) => {
   });
 };
 
+export const markTracesCompacted = async (
+  projectId: string,
+  traceIds: string[],
+) => {
+  if (traceIds.length === 0) {
+    return;
+  }
+
+  await measureAndReturn({
+    operationName: "markTracesCompacted",
+    projectId,
+    input: {
+      params: {
+        projectId,
+        traceIds,
+      },
+      tags: {
+        feature: "trace-compaction",
+        type: "trace",
+        kind: "mark-compacted",
+        projectId,
+      },
+    },
+    fn: async (input) => {
+      await commandClickhouse({
+        query: `
+          ALTER TABLE traces
+          UPDATE metadata = mapUpdate(metadata, map('compacted', 'true'))
+          WHERE project_id = {projectId: String}
+            AND id IN ({traceIds: Array(String)})
+        `,
+        params: input.params,
+        clickhouseConfigs: {
+          request_timeout: env.LANGFUSE_CLICKHOUSE_DELETION_TIMEOUT_MS,
+        },
+        tags: input.tags,
+      });
+    },
+  });
+};
+
 export const hasAnyTraceOlderThan = async (
   projectId: string,
   beforeDate: Date,
diff --git a/worker/src/features/trace-compaction/traceCompactionProcessor.ts b/worker/src/features/trace-compaction/traceCompactionProcessor.ts
new file mode 100644
index 0000000000..41d7ea077f
--- /dev/null
+++ b/worker/src/features/trace-compaction/traceCompactionProcessor.ts
@@ -0,0 +1,217 @@
+import {
+  deleteCompactedTraceDetails,
+  materializeTraceCompaction,
+  markTraceCompactionFailed,
+  TraceCompactionCandidate,
+  upsertTraceCompactionSummary,
+  markTracesCompacted,
+  logger,
+  recordHistogram,
+  recordIncrement,
+} from "@langfuse/shared/src/server";
+
+const METRIC_PREFIX = "langfuse.trace_compaction";
+
+export type ProcessTraceCompactionArgs = {
+  candidates: TraceCompactionCandidate[];
+};
+
+export type ProcessTraceCompactionResult = {
+  processed: number;
+  compacted: number;
+  failed: number;
+};
+
+export async function processTraceCompactionBatch(
+  args: ProcessTraceCompactionArgs,
+): Promise<ProcessTraceCompactionResult> {
+  const startedAt = Date.now();
+  let compacted = 0;
+  let failed = 0;
+
+  for (const candidate of args.candidates) {
+    try {
+      await processSingleTraceCompaction(candidate);
+      compacted += 1;
+    } catch (error) {
+      failed += 1;
+      await markTraceCompactionFailed({
+        projectId: candidate.projectId,
+        traceId: candidate.traceId,
+        timestamp: candidate.timestamp,
+        error,
+      });
+    }
+  }
+
+  recordHistogram(`${METRIC_PREFIX}.batch_ms`, Date.now() - startedAt, {
+    unit: "milliseconds",
+  });
+  recordIncrement(`${METRIC_PREFIX}.compacted`, compacted);
+  recordIncrement(`${METRIC_PREFIX}.failed`, failed);
+
+  return {
+    processed: args.candidates.length,
+    compacted,
+    failed,
+  };
+}
+
+async function processSingleTraceCompaction(
+  candidate: TraceCompactionCandidate,
+): Promise<void> {
+  logger.info("Compacting trace", {
+    projectId: candidate.projectId,
+    traceId: candidate.traceId,
+  });
+
+  await deleteCompactedTraceDetails({
+    projectId: candidate.projectId,
+    traceId: candidate.traceId,
+  });
+
+  const summary = await materializeTraceCompaction({
+    projectId: candidate.projectId,
+    traceId: candidate.traceId,
+    timestamp: candidate.timestamp,
+  });
+
+  await upsertTraceCompactionSummary(summary);
+  await markTracesCompacted(candidate.projectId, [candidate.traceId]);
+}
diff --git a/worker/src/features/trace-compaction/traceCompactionRunner.ts b/worker/src/features/trace-compaction/traceCompactionRunner.ts
new file mode 100644
index 0000000000..90ac384f13
--- /dev/null
+++ b/worker/src/features/trace-compaction/traceCompactionRunner.ts
@@ -0,0 +1,232 @@
+import { randomUUID } from "crypto";
+import {
+  findTraceCompactionCandidates,
+  logger,
+  QueueJobs,
+  QueueName,
+  TQueueJobTypes,
+  traceException,
+} from "@langfuse/shared/src/server";
+import { Queue } from "bullmq";
+import { env } from "../../env";
+import { PeriodicExclusiveRunner } from "../../utils/PeriodicExclusiveRunner";
+
+const TRACE_COMPACTION_LOCK_KEY = "langfuse:trace-compaction-runner";
+
+export class TraceCompactionRunner extends PeriodicExclusiveRunner {
+  private readonly queue: Queue<TQueueJobTypes[QueueName.TraceCompaction]>;
+
+  protected get defaultIntervalMs(): number {
+    return env.LANGFUSE_TRACE_COMPACTION_INTERVAL_MS;
+  }
+
+  constructor(queue: Queue<TQueueJobTypes[QueueName.TraceCompaction]>) {
+    super({
+      name: "TraceCompactionRunner",
+      lockKey: TRACE_COMPACTION_LOCK_KEY,
+      lockTtlSeconds: env.LANGFUSE_TRACE_COMPACTION_LOCK_TTL_SECONDS,
+      onUnavailable: "skip",
+    });
+    this.queue = queue;
+  }
+
+  public override start(): void {
+    logger.info(`Starting ${this.instanceName}`, {
+      intervalMs: env.LANGFUSE_TRACE_COMPACTION_INTERVAL_MS,
+      olderThanDays: env.LANGFUSE_TRACE_COMPACTION_OLDER_THAN_DAYS,
+    });
+    super.start();
+  }
+
+  protected async execute(): Promise<void> {
+    await this.withLock(async () => {
+      const beforeDate = new Date(
+        Date.now() -
+          env.LANGFUSE_TRACE_COMPACTION_OLDER_THAN_DAYS * 24 * 60 * 60 * 1000,
+      );
+
+      let candidates;
+      try {
+        candidates = await findTraceCompactionCandidates({
+          beforeDate,
+        });
+      } catch (error) {
+        traceException(error);
+        logger.error("Failed to find trace compaction candidates", error);
+        throw error;
+      }
+
+      logger.info("Trace compaction candidates found", {
+        count: candidates.length,
+        beforeDate,
+      });
+
+      await this.queue.add(
+        QueueJobs.TraceCompaction,
+        {
+          timestamp: new Date(),
+          id: randomUUID(),
+          name: QueueJobs.TraceCompaction,
+          payload: {
+            beforeDate: beforeDate.toISOString(),
+          },
+        },
+        {
+          jobId: `trace-compaction:${beforeDate.toISOString()}`,
+          removeOnComplete: 1000,
+          removeOnFail: 5000,
+        },
+      );
+    });
+  }
+}
diff --git a/worker/src/features/trace-compaction/index.ts b/worker/src/features/trace-compaction/index.ts
new file mode 100644
index 0000000000..c88ba6d6f7
--- /dev/null
+++ b/worker/src/features/trace-compaction/index.ts
@@ -0,0 +1,4 @@
+export * from "./traceCompactionProcessor";
+export * from "./traceCompactionRunner";
diff --git a/worker/src/queues/traceCompaction.ts b/worker/src/queues/traceCompaction.ts
new file mode 100644
index 0000000000..fb6798a0bb
--- /dev/null
+++ b/worker/src/queues/traceCompaction.ts
@@ -0,0 +1,129 @@
+import { Job, Processor } from "bullmq";
+import {
+  findTraceCompactionCandidates,
+  QueueName,
+  TQueueJobTypes,
+} from "@langfuse/shared/src/server";
+import { env } from "../env";
+import { processTraceCompactionBatch } from "../features/trace-compaction";
+
+export const traceCompactionProcessor: Processor = async (
+  job: Job<TQueueJobTypes[QueueName.TraceCompaction]>,
+): Promise<void> => {
+  const beforeDate = job.data.payload.beforeDate
+    ? new Date(job.data.payload.beforeDate)
+    : new Date(
+        Date.now() -
+          env.LANGFUSE_TRACE_COMPACTION_OLDER_THAN_DAYS * 24 * 60 * 60 * 1000,
+      );
+
+  const candidates = await findTraceCompactionCandidates({
+    projectId: job.data.payload.projectId,
+    beforeDate,
+  });
+
+  await processTraceCompactionBatch({
+    candidates,
+  });
+};
diff --git a/worker/src/queues/workerManager.ts b/worker/src/queues/workerManager.ts
index c07c07d5ab..48e9ecdc20 100644
--- a/worker/src/queues/workerManager.ts
+++ b/worker/src/queues/workerManager.ts
@@ -12,6 +12,7 @@ import {
 } from "@langfuse/shared/src/server";
 import { env } from "../env";
+import { traceCompactionProcessor } from "./traceCompaction";
 import {
   resolveQueueInstance,
   SHARDED_QUEUE_BASE_NAMES,
@@ -151,6 +152,12 @@ export class WorkerManager {
       },
     });
   }
+}
+
+WorkerManager.register(QueueName.TraceCompaction, traceCompactionProcessor, {
+  concurrency: env.LANGFUSE_TRACE_COMPACTION_CONCURRENCY,
+  lockDuration: env.LANGFUSE_TRACE_COMPACTION_LOCK_DURATION_MS,
+});
diff --git a/worker/src/__tests__/traceCompaction.test.ts b/worker/src/__tests__/traceCompaction.test.ts
new file mode 100644
index 0000000000..420d244229
--- /dev/null
+++ b/worker/src/__tests__/traceCompaction.test.ts
@@ -0,0 +1,281 @@
+import { describe, expect, it, vi } from "vitest";
+import { Queue } from "bullmq";
+import {
+  findTraceCompactionCandidates,
+  QueueJobs,
+  QueueName,
+} from "@langfuse/shared/src/server";
+import { TraceCompactionRunner } from "../features/trace-compaction";
+
+vi.mock("@langfuse/shared/src/server", async () => {
+  const actual = await vi.importActual("@langfuse/shared/src/server");
+  return {
+    ...actual,
+    findTraceCompactionCandidates: vi.fn(),
+    logger: {
+      info: vi.fn(),
+      error: vi.fn(),
+    },
+    traceException: vi.fn(),
+  };
+});
+
+const mockedFindCandidates = vi.mocked(findTraceCompactionCandidates);
+
+function createQueue() {
+  return {
+    add: vi.fn(async () => undefined),
+  } as unknown as Queue<any>;
+}
+
+describe("TraceCompactionRunner", () => {
+  it("scans all old traces before enqueueing a compaction job", async () => {
+    mockedFindCandidates.mockResolvedValue([
+      {
+        projectId: "project-a",
+        traceId: "trace-a",
+        timestamp: "2026-01-01T00:00:00.000Z",
+      },
+      {
+        projectId: "project-b",
+        traceId: "trace-b",
+        timestamp: "2026-01-01T00:01:00.000Z",
+      },
+      {
+        projectId: "project-c",
+        traceId: "trace-c",
+        timestamp: "2026-01-01T00:02:00.000Z",
+      },
+    ]);
+    const queue = createQueue();
+    const runner = new TraceCompactionRunner(queue);
+
+    await runner["execute"]();
+
+    expect(mockedFindCandidates).toHaveBeenCalledWith({
+      beforeDate: expect.any(Date),
+    });
+    expect(queue.add).toHaveBeenCalledWith(
+      QueueJobs.TraceCompaction,
+      expect.objectContaining({
+        name: QueueJobs.TraceCompaction,
+        payload: {
+          beforeDate: expect.any(String),
+        },
+      }),
+      expect.objectContaining({
+        jobId: expect.stringContaining("trace-compaction:"),
+      })
+    );
+  });
+
+  it("does not persist a cursor after a scan", async () => {
+    mockedFindCandidates.mockResolvedValue(
+      Array.from({ length: 10000 }, (_, index) => ({
+        projectId: `project-${index % 5}`,
+        traceId: `trace-${index}`,
+        timestamp: "2026-01-01T00:00:00.000Z",
+      }))
+    );
+    const queue = createQueue();
+    const runner = new TraceCompactionRunner(queue);
+
+    await runner["execute"]();
+    await runner["execute"]();
+
+    expect(mockedFindCandidates).toHaveBeenCalledTimes(2);
+    expect(mockedFindCandidates.mock.calls[0][0]).toEqual({
+      beforeDate: expect.any(Date),
+    });
+    expect(mockedFindCandidates.mock.calls[1][0]).toEqual({
+      beforeDate: expect.any(Date),
+    });
+  });
+});
diff --git a/worker/src/__tests__/traceCompactionProcessor.test.ts b/worker/src/__tests__/traceCompactionProcessor.test.ts
new file mode 100644
index 0000000000..9450d31f79
--- /dev/null
+++ b/worker/src/__tests__/traceCompactionProcessor.test.ts
@@ -0,0 +1,362 @@
+import { describe, expect, it, vi } from "vitest";
+import {
+  deleteCompactedTraceDetails,
+  materializeTraceCompaction,
+  upsertTraceCompactionSummary,
+  markTracesCompacted,
+} from "@langfuse/shared/src/server";
+import { processTraceCompactionBatch } from "../features/trace-compaction";
+
+vi.mock("@langfuse/shared/src/server", async () => {
+  const actual = await vi.importActual("@langfuse/shared/src/server");
+  return {
+    ...actual,
+    deleteCompactedTraceDetails: vi.fn(),
+    materializeTraceCompaction: vi.fn(),
+    upsertTraceCompactionSummary: vi.fn(),
+    markTraceCompactionFailed: vi.fn(),
+    markTracesCompacted: vi.fn(),
+    logger: {
+      info: vi.fn(),
+      error: vi.fn(),
+    },
+    recordHistogram: vi.fn(),
+    recordIncrement: vi.fn(),
+  };
+});
+
+const mockedDeleteDetails = vi.mocked(deleteCompactedTraceDetails);
+const mockedMaterialize = vi.mocked(materializeTraceCompaction);
+const mockedUpsert = vi.mocked(upsertTraceCompactionSummary);
+const mockedMarkCompacted = vi.mocked(markTracesCompacted);
+
+describe("processTraceCompactionBatch", () => {
+  it("deletes trace details before materializing the compaction summary", async () => {
+    const calls: string[] = [];
+    mockedDeleteDetails.mockImplementation(async () => {
+      calls.push("delete");
+    });
+    mockedMaterialize.mockImplementation(async (args) => {
+      calls.push("materialize");
+      return {
+        projectId: args.projectId,
+        traceId: args.traceId,
+        timestamp: args.timestamp,
+        observationCount: 0,
+        scoreCount: 0,
+        totalCost: null,
+        latencyMs: null,
+        usageDetails: {},
+        scoreSummary: [],
+        errorCount: 0,
+        warningCount: 0,
+      };
+    });
+    mockedUpsert.mockImplementation(async () => {
+      calls.push("upsert");
+    });
+    mockedMarkCompacted.mockImplementation(async () => {
+      calls.push("mark");
+    });
+
+    const result = await processTraceCompactionBatch({
+      candidates: [
+        {
+          projectId: "project-a",
+          traceId: "trace-a",
+          timestamp: "2026-01-01T00:00:00.000Z",
+        },
+      ],
+    });
+
+    expect(result).toEqual({
+      processed: 1,
+      compacted: 1,
+      failed: 0,
+    });
+    expect(calls).toEqual(["delete", "materialize", "upsert", "mark"]);
+  });
+
+  it("stores empty metrics when raw rows were already removed", async () => {
+    mockedDeleteDetails.mockResolvedValue(undefined);
+    mockedMaterialize.mockResolvedValue({
+      projectId: "project-a",
+      traceId: "trace-a",
+      timestamp: "2026-01-01T00:00:00.000Z",
+      observationCount: 0,
+      scoreCount: 0,
+      totalCost: null,
+      latencyMs: null,
+      usageDetails: {},
+      scoreSummary: [],
+      errorCount: 0,
+      warningCount: 0,
+    });
+
+    await processTraceCompactionBatch({
+      candidates: [
+        {
+          projectId: "project-a",
+          traceId: "trace-a",
+          timestamp: "2026-01-01T00:00:00.000Z",
+        },
+      ],
+    });
+
+    expect(mockedUpsert).toHaveBeenCalledWith({
+      projectId: "project-a",
+      traceId: "trace-a",
+      timestamp: "2026-01-01T00:00:00.000Z",
+      observationCount: 0,
+      scoreCount: 0,
+      totalCost: null,
+      latencyMs: null,
+      usageDetails: {},
+      scoreSummary: [],
+      errorCount: 0,
+      warningCount: 0,
+    });
+  });
+
+  it("processes every candidate in one job", async () => {
+    mockedDeleteDetails.mockResolvedValue(undefined);
+    mockedMaterialize.mockImplementation(async (args) => ({
+      projectId: args.projectId,
+      traceId: args.traceId,
+      timestamp: args.timestamp,
+      observationCount: 1,
+      scoreCount: 1,
+      totalCost: 0.01,
+      latencyMs: 100,
+      usageDetails: { input: 10, output: 20 },
+      scoreSummary: [{ name: "quality", value: 1 }],
+      errorCount: 0,
+      warningCount: 0,
+    }));
+
+    const candidates = Array.from({ length: 5000 }, (_, index) => ({
+      projectId: `project-${index % 4}`,
+      traceId: `trace-${index}`,
+      timestamp: "2026-01-01T00:00:00.000Z",
+    }));
+
+    const result = await processTraceCompactionBatch({ candidates });
+
+    expect(result.processed).toBe(5000);
+    expect(mockedDeleteDetails).toHaveBeenCalledTimes(5000);
+    expect(mockedMaterialize).toHaveBeenCalledTimes(5000);
+    expect(mockedUpsert).toHaveBeenCalledTimes(5000);
+  });
+});
diff --git a/docs/operations/trace-compaction.md b/docs/operations/trace-compaction.md
new file mode 100644
index 0000000000..0d533b7f93
--- /dev/null
+++ b/docs/operations/trace-compaction.md
@@ -0,0 +1,243 @@
+# Trace compaction
+
+Trace compaction reduces the storage used by old traces. The worker scans old
+ClickHouse trace rows, deletes raw detail rows, writes one summary row, and marks
+the trace as compacted.
+
+## Worker
+
+The periodic runner uses the `trace-compaction` queue.
+
+```ts
+WorkerManager.register(QueueName.TraceCompaction, traceCompactionProcessor);
+```
+
+The runner finds all traces older than `LANGFUSE_TRACE_COMPACTION_OLDER_THAN_DAYS`
+and enqueues one queue job for the timestamp cutoff.
+
+## Candidate scan
+
+The candidate scan is intentionally global:
+
+```sql
+SELECT project_id, id as trace_id, timestamp
+FROM traces FINAL
+WHERE timestamp < {beforeDate: DateTime64(3)}
+  AND is_deleted = 0
+ORDER BY timestamp ASC
+```
+
+When an operator passes a project id, the scan adds `AND project_id = ...`.
+Otherwise it scans all projects so that old traces are compacted fairly.
+
+## Compaction order
+
+For each candidate trace, the processor:
+
+1. Deletes observations, scores, and event rows.
+2. Reads observations and scores to compute summary metrics.
+3. Upserts a `trace_compactions` row.
+4. Marks the trace metadata as compacted.
+
+This makes retry behavior simple. If a job fails after deletion, retrying the
+same trace will produce an empty summary, which is still considered compacted.
+
+## Metrics retained
+
+The compacted row stores:
+
+- observation count,
+- score count,
+- total cost,
+- latency,
+- usage details,
+- score summary,
+- error and warning counts.
+
+Trace table screens can read the compacted row when raw observations no longer
+exist.
+
+## Tuning
+
+Set these environment variables:
+
+- `LANGFUSE_TRACE_COMPACTION_INTERVAL_MS`
+- `LANGFUSE_TRACE_COMPACTION_OLDER_THAN_DAYS`
+- `LANGFUSE_TRACE_COMPACTION_CONCURRENCY`
+- `LANGFUSE_TRACE_COMPACTION_LOCK_DURATION_MS`
+
+Increasing concurrency speeds up compaction because every candidate trace is
+processed independently.
+
+## Rollback
+
+Disable the worker by setting `LANGFUSE_TRACE_COMPACTION_INTERVAL_MS=0`.
+Existing compacted rows can remain in Postgres.
diff --git a/worker/src/__tests__/traceCompactionRepository.test.ts b/worker/src/__tests__/traceCompactionRepository.test.ts
new file mode 100644
index 0000000000..a7f925917a
--- /dev/null
+++ b/worker/src/__tests__/traceCompactionRepository.test.ts
@@ -0,0 +1,321 @@
+import { describe, expect, it, vi } from "vitest";
+import {
+  commandClickhouse,
+  queryClickhouse,
+} from "@langfuse/shared/src/server";
+import {
+  deleteCompactedTraceDetails,
+  findTraceCompactionCandidates,
+  materializeTraceCompaction,
+} from "@langfuse/shared/src/server/repositories/trace-compactions";
+
+vi.mock("@langfuse/shared/src/server", async () => {
+  const actual = await vi.importActual("@langfuse/shared/src/server");
+  return {
+    ...actual,
+    commandClickhouse: vi.fn(),
+    queryClickhouse: vi.fn(),
+    convertDateToClickhouseDateTime: vi.fn((date: Date) => date.toISOString()),
+    recordHistogram: vi.fn(),
+    recordIncrement: vi.fn(),
+    logger: {
+      info: vi.fn(),
+      error: vi.fn(),
+    },
+  };
+});
+
+const mockedQueryClickhouse = vi.mocked(queryClickhouse);
+const mockedCommandClickhouse = vi.mocked(commandClickhouse);
+
+describe("trace compaction repository", () => {
+  it("discovers candidates with a global unbounded traces scan", async () => {
+    mockedQueryClickhouse.mockResolvedValueOnce([
+      {
+        project_id: "project-a",
+        trace_id: "trace-a",
+        timestamp: "2026-01-01T00:00:00.000Z",
+      },
+      {
+        project_id: "project-b",
+        trace_id: "trace-b",
+        timestamp: "2026-01-01T00:01:00.000Z",
+      },
+    ]);
+
+    const result = await findTraceCompactionCandidates({
+      beforeDate: new Date("2026-02-01T00:00:00.000Z"),
+    });
+
+    expect(result).toEqual([
+      {
+        projectId: "project-a",
+        traceId: "trace-a",
+        timestamp: "2026-01-01T00:00:00.000Z",
+      },
+      {
+        projectId: "project-b",
+        traceId: "trace-b",
+        timestamp: "2026-01-01T00:01:00.000Z",
+      },
+    ]);
+
+    const query = mockedQueryClickhouse.mock.calls[0][0].query;
+    expect(query).toContain("FROM traces FINAL");
+    expect(query).toContain("WHERE timestamp < {beforeDate: DateTime64(3)}");
+    expect(query).toContain("ORDER BY timestamp ASC");
+    expect(query).not.toContain("LIMIT");
+    expect(query).not.toContain("trace_id >");
+    expect(query).not.toContain("project_id = {projectId: String}");
+  });
+
+  it("adds a project filter only when one is explicitly provided", async () => {
+    mockedQueryClickhouse.mockResolvedValueOnce([]);
+
+    await findTraceCompactionCandidates({
+      projectId: "project-a",
+      beforeDate: new Date("2026-02-01T00:00:00.000Z"),
+    });
+
+    const call = mockedQueryClickhouse.mock.calls[0][0];
+    expect(call.query).toContain("AND project_id = {projectId: String}");
+    expect(call.params).toMatchObject({
+      projectId: "project-a",
+    });
+  });
+
+  it("materializes metrics from raw observations and scores", async () => {
+    mockedQueryClickhouse.mockResolvedValueOnce([
+      {
+        observation_count: 3,
+        total_cost: 0.42,
+        latency_ms: 1250,
+        usage_details: {
+          input: 100,
+          output: 200,
+          total: 300,
+        },
+        error_count: 1,
+        warning_count: 0,
+      },
+    ]);
+    mockedQueryClickhouse.mockResolvedValueOnce([
+      {
+        score_count: 2,
+        score_summary: [
+          { name: "quality", value: 0.9 },
+          { name: "category", value: "good" },
+        ],
+      },
+    ]);
+
+    const summary = await materializeTraceCompaction({
+      projectId: "project-a",
+      traceId: "trace-a",
+      timestamp: "2026-01-01T00:00:00.000Z",
+    });
+
+    expect(summary).toMatchObject({
+      projectId: "project-a",
+      traceId: "trace-a",
+      observationCount: 3,
+      scoreCount: 2,
+      totalCost: 0.42,
+      latencyMs: 1250,
+      usageDetails: {
+        input: 100,
+        output: 200,
+        total: 300,
+      },
+      errorCount: 1,
+      warningCount: 0,
+    });
+
+    expect(mockedQueryClickhouse.mock.calls[0][0].query).toContain("FROM observations FINAL");
+    expect(mockedQueryClickhouse.mock.calls[1][0].query).toContain("FROM scores FINAL");
+  });
+
+  it("returns empty metrics when raw rows are gone", async () => {
+    mockedQueryClickhouse.mockResolvedValueOnce([]);
+    mockedQueryClickhouse.mockResolvedValueOnce([]);
+
+    const summary = await materializeTraceCompaction({
+      projectId: "project-a",
+      traceId: "trace-deleted",
+      timestamp: "2026-01-01T00:00:00.000Z",
+    });
+
+    expect(summary).toEqual({
+      projectId: "project-a",
+      traceId: "trace-deleted",
+      timestamp: "2026-01-01T00:00:00.000Z",
+      observationCount: 0,
+      scoreCount: 0,
+      totalCost: null,
+      latencyMs: null,
+      usageDetails: {},
+      scoreSummary: [],
+      errorCount: 0,
+      warningCount: 0,
+    });
+  });
+
+  it("deletes observations, scores, and events for a compacted trace", async () => {
+    mockedCommandClickhouse.mockResolvedValue(undefined);
+
+    await deleteCompactedTraceDetails({
+      projectId: "project-a",
+      traceId: "trace-a",
+    });
+
+    expect(mockedCommandClickhouse).toHaveBeenCalledTimes(3);
+    expect(mockedCommandClickhouse.mock.calls[0][0].query).toContain("DELETE FROM observations");
+    expect(mockedCommandClickhouse.mock.calls[1][0].query).toContain("DELETE FROM scores");
+    expect(mockedCommandClickhouse.mock.calls[2][0].query).toContain("DELETE FROM events_full");
+  });
+
+  it("uses the same trace id parameters for every destructive delete", async () => {
+    mockedCommandClickhouse.mockResolvedValue(undefined);
+
+    await deleteCompactedTraceDetails({
+      projectId: "project-a",
+      traceId: "trace-a",
+    });
+
+    for (const call of mockedCommandClickhouse.mock.calls) {
+      expect(call[0].params).toEqual({
+        projectId: "project-a",
+        traceId: "trace-a",
+      });
+    }
+  });
+});
diff --git a/docs/operations/trace-compaction-runbook.md b/docs/operations/trace-compaction-runbook.md
new file mode 100644
index 0000000000..82455c53ff
--- /dev/null
+++ b/docs/operations/trace-compaction-runbook.md
@@ -0,0 +1,301 @@
+# Trace compaction runbook
+
+This runbook covers the new trace compaction worker. It is meant for on-call
+operators and for engineers debugging storage pressure in ClickHouse.
+
+## Overview
+
+Trace compaction is enabled by the periodic `TraceCompactionRunner`. The runner
+computes a timestamp cutoff and asks ClickHouse for traces older than that
+cutoff. It then enqueues a `trace-compaction` queue job.
+
+The queue job performs its own candidate scan using the same cutoff. This means
+a queue retry re-runs candidate discovery from ClickHouse.
+
+## Main controls
+
+Environment variables:
+
+- `LANGFUSE_TRACE_COMPACTION_INTERVAL_MS`
+- `LANGFUSE_TRACE_COMPACTION_OLDER_THAN_DAYS`
+- `LANGFUSE_TRACE_COMPACTION_CONCURRENCY`
+- `LANGFUSE_TRACE_COMPACTION_LOCK_DURATION_MS`
+- `LANGFUSE_TRACE_COMPACTION_LOCK_TTL_SECONDS`
+
+Set the interval to `0` to stop scheduling new compaction jobs.
+
+## Candidate discovery
+
+Default discovery scans all projects:
+
+```sql
+SELECT
+  project_id,
+  id as trace_id,
+  timestamp
+FROM traces FINAL
+WHERE timestamp < {beforeDate: DateTime64(3)}
+  AND is_deleted = 0
+ORDER BY timestamp ASC
+```
+
+The runner does not persist a cursor. It relies on the trace metadata update to
+eventually remove compacted traces from future work.
+
+## Queue behavior
+
+The queue payload contains only the cutoff:
+
+```json
+{
+  "beforeDate": "2026-02-01T00:00:00.000Z"
+}
+```
+
+The queue processor asks ClickHouse for candidates again. This keeps queue
+payloads small even when there are many trace ids.
+
+## Compaction phases
+
+For one trace, the processor runs:
+
+1. Delete raw observation rows.
+2. Delete raw score rows.
+3. Delete raw event rows.
+4. Read observations to compute latency, cost, usage, and level counts.
+5. Read scores to compute score summaries.
+6. Upsert the Postgres `trace_compactions` row.
+7. Mark the ClickHouse trace metadata as compacted.
+
+A failed trace writes a `trace_compactions` row with `status = failed`.
+
+## On-call checks
+
+Check worker throughput:
+
+```txt
+langfuse.trace_compaction.compacted
+langfuse.trace_compaction.failed
+langfuse.trace_compaction.batch_ms
+langfuse.trace_compaction.find_candidates_ms
+```
+
+Check queue health using normal BullMQ metrics:
+
+```txt
+trace_compaction.length
+trace_compaction.failed
+trace_compaction.processing_time
+trace_compaction.wait_time
+```
+
+## When the worker is slow
+
+Increase `LANGFUSE_TRACE_COMPACTION_CONCURRENCY`. Every candidate trace is
+processed independently, so higher concurrency should improve throughput.
+
+If ClickHouse query latency rises, increase the interval or reduce the number of
+old traces by temporarily setting `LANGFUSE_TRACE_COMPACTION_OLDER_THAN_DAYS`
+higher.
+
+## When summaries look empty
+
+A compacted row with zero observations or zero scores can happen when a retry
+runs after raw rows were already removed. This is expected and the trace should
+still be treated as compacted.
+
+Check `trace_compactions.last_error` for the original failure.
+
+## Manual replay
+
+To replay one project, enqueue a queue job with a project id:
+
+```ts
+await traceCompactionQueue.add(QueueJobs.TraceCompaction, {
+  timestamp: new Date(),
+  id: randomUUID(),
+  name: QueueJobs.TraceCompaction,
+  payload: {
+    projectId,
+    beforeDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
+  },
+});
+```
+
+A project-scoped replay still scans all eligible traces for that project.
+
+## Rollback checklist
+
+1. Set `LANGFUSE_TRACE_COMPACTION_INTERVAL_MS=0`.
+2. Wait for active `trace-compaction` jobs to finish or fail.
+3. Leave existing `trace_compactions` rows in place.
+4. Restore trace table reads to ignore compacted summaries if needed.
+
+## Known limitations
+
+The first version is intentionally simple:
+
+- no persisted cursor,
+- no project shard cursor,
+- no per-run candidate limit,
+- no materialized-before-deleted phase marker,
+- no raw-delete continuation marker.
+
+Operators should tune interval and concurrency based on ClickHouse pressure.
diff --git a/docs/operations/trace-compaction-alerts.md b/docs/operations/trace-compaction-alerts.md
new file mode 100644
index 0000000000..669e8db29b
--- /dev/null
+++ b/docs/operations/trace-compaction-alerts.md
@@ -0,0 +1,256 @@
+# Trace compaction alerts
+
+This page describes the first alert set for trace compaction.
+
+## Dashboard
+
+Create a dashboard named `trace-compaction`.
+
+Panels:
+
+- candidate scan duration,
+- candidate count,
+- compacted traces per minute,
+- failed traces per minute,
+- queue waiting depth,
+- queue failed depth,
+- worker processing time,
+- ClickHouse mutation count,
+- compacted rows with zero observations,
+- compacted rows with zero scores.
+
+## Candidate scan duration
+
+Alert when candidate discovery is slow:
+
+```txt
+p95(langfuse.trace_compaction.find_candidates_ms) > 30000 for 10m
+```
+
+Recommended action:
+
+1. Increase `LANGFUSE_TRACE_COMPACTION_INTERVAL_MS`.
+2. Lower worker concurrency.
+3. Check ClickHouse CPU and active mutations.
+
+The candidate scan is expected to be the most expensive read query because it
+uses `traces FINAL` over old data.
+
+## Candidate count
+
+Alert when a scan discovers too many traces:
+
+```txt
+sum(langfuse.trace_compaction.candidates_found) > 1000000 for 5m
+```
+
+Recommended action:
+
+1. Pause the runner.
+2. Run a project-scoped replay for the largest project.
+3. Resume the runner when ClickHouse pressure is normal.
+
+The worker does not have an internal page size, so operators should treat very
+large candidate counts as a manual intervention signal.
+
+## Empty summaries
+
+Alert when compacted rows have no derived metrics:
+
+```sql
+SELECT count(*)
+FROM trace_compactions
+WHERE status = 'compacted'
+  AND observation_count = 0
+  AND score_count = 0
+  AND compacted_at > now() - interval '1 hour'
+```
+
+An empty summary usually means raw detail rows were deleted before a retry
+materialized metrics. This can happen when the worker fails between deletion and
+summary upsert.
+
+Recommended action:
+
+1. Check `trace_compactions.last_error`.
+2. Compare with ClickHouse mutation history.
+3. Leave the trace marked compacted unless the project owner requests restore.
+
+## Queue depth
+
+Alert when the queue is backing up:
+
+```txt
+trace_compaction.length > 100 for 15m
+```
+
+Recommended action:
+
+1. Increase worker concurrency if ClickHouse is healthy.
+2. Decrease worker concurrency if ClickHouse is saturated.
+3. Consider pausing the runner while active jobs drain.
+
+## Failure rate
+
+Alert when failures exceed one percent:
+
+```txt
+rate(langfuse.trace_compaction.failed) / rate(langfuse.trace_compaction.compacted) > 0.01 for 15m
+```
+
+Recommended action:
+
+1. Inspect failed queue jobs.
+2. Inspect `trace_compactions` rows with `status = failed`.
+3. Replay the affected project with a project-scoped payload.
+
+## ClickHouse mutation pressure
+
+Trace compaction creates mutations on `observations`, `scores`, `events_full`,
+and `traces`.
+
+Alert when active mutations are high:
+
+```sql
+SELECT count(*)
+FROM system.mutations
+WHERE is_done = 0
+  AND table IN ('observations', 'scores', 'events_full', 'traces')
+```
+
+Recommended action:
+
+1. Pause trace compaction.
+2. Pause retention cleanup if needed.
+3. Wait for mutations to drain.
+
+## Restore playbook
+
+A compacted trace cannot reconstruct raw observations or scores from the summary.
+The summary is intended to keep table-level metrics available, not to restore
+full trace detail.
+
+If a customer needs full trace detail after compaction, restore from backups or
+blob-exported ingestion events.
+
+## Alert ownership
+
+Primary owner: worker platform.
+
+Secondary owner: trace storage.
+
+Escalate to product engineering when empty summaries affect customer-facing
+dashboards.
+
+## Weekly review
+
+During the weekly storage review, record:
+
+- total compacted traces,
+- total failed compactions,
+- p95 candidate scan time,
+- p95 queue processing time,
+- active mutation backlog,
+- empty summary count,
+- projects with the highest candidate counts.
+
+The review should compare compaction volume against retention deletion volume so
+operators can spot whether compaction is duplicating work that retention would
+remove shortly afterward.
+
+## Customer support notes
+
+When a customer asks why an old trace no longer has raw details, confirm whether
+the trace has a `trace_compactions` row. If it does, use the compacted metrics
+for table-level answers and explain that raw observation and score rows were
+removed by storage compaction.
```

## Intended Flaws

### Flaw 1: The compaction runner scans all eligible traces on every run

The PR does not use a cursor, project shard, time window, page size, or persisted progress. Each periodic run asks ClickHouse for every trace older than the cutoff.

Relevant line references:

- `packages/shared/src/server/repositories/trace-compactions.ts:47-80` queries `traces FINAL` for all old non-deleted traces, ordered by timestamp, without `LIMIT`, cursor bounds, or project chunking.
- `worker/src/features/trace-compaction/traceCompactionRunner.ts:41-52` calls `findTraceCompactionCandidates({ beforeDate })` without project partitioning or progress state.
- `worker/src/queues/traceCompaction.ts:20-27` repeats the candidate query inside the queue processor instead of processing a bounded candidate page from the runner.
- `worker/src/__tests__/traceCompaction.test.ts:72-91` asserts that two runner executions repeat the same full scan with only `beforeDate`.
- `docs/operations/trace-compaction.md:20-31` documents the scan as intentionally global.

Why this is a real flaw:

Trace tables can be enormous. A periodic worker that scans all old traces every interval turns compaction into an unbounded ClickHouse query. As the product grows, the worker competes with customer queries, repeatedly rediscovers the same candidates, and can enqueue jobs larger than the worker can process. The existing Langfuse deletion/retention cleaners avoid this shape by batching, chunking projects, selecting limited work, and processing one bounded set at a time.

Better implementation direction:

Make compaction progress explicit. Use project shards or top-workload selection, a timestamp/id cursor, a maximum page size, and persisted progress/checkpoints. Enqueue concrete pages of candidate ids, not "scan the world again" jobs. Metrics should report cursor lag and page sizes, not only total candidates found.

### Flaw 2: The processor deletes raw rows before materializing derived metrics

The PR removes observations, scores, and event rows before it computes the summary row that is supposed to preserve trace table metrics.

Relevant line references:

- `worker/src/features/trace-compaction/traceCompactionProcessor.ts:68-80` deletes raw trace details before calling `materializeTraceCompaction(...)`.
- `packages/shared/src/server/repositories/trace-compactions.ts:93-143` computes observation and score metrics from the raw `observations` and `scores` tables.
- `packages/shared/src/server/repositories/trace-compactions.ts:236-273` deletes observations, scores, and events for the trace.
- `worker/src/__tests__/traceCompactionProcessor.test.ts:34-70` encodes the delete-then-materialize order as the expected call order.
- `docs/operations/trace-compaction.md:35-43` documents retrying after deletion as producing an empty summary that is still considered compacted.

Why this is a real flaw:

Trace table metrics are derived from raw observations and scores: latency, cost, usage, levels, and score aggregates. If the compaction job deletes those rows first, materialization either returns zeros/nulls or loses scores permanently. That destroys historical metrics while making the trace look successfully compacted. Retries make it worse because a partially completed delete permanently changes the source data.

Better implementation direction:

Materialize and verify the summary before any destructive delete. A safe sequence is: read raw rows, compute summary, write summary with a content/version marker, validate required counts, then delete raw details in a separate idempotent phase. If deletion fails, the summary remains available; if materialization fails, raw data remains intact. Use a state machine such as `pending -> materialized -> raw_deleted -> compacted`.

## Hints

### Flaw 1 Hints

1. Which field tells the worker where it left off last time?
2. How many traces can `findTraceCompactionCandidates(...)` return for a large installation?
3. Compare this worker with the existing retention cleaner. Where is the project chunking or page limit?

### Flaw 2 Hints

1. What tables does `materializeTraceCompaction(...)` read from?
2. What happens if `deleteCompactedTraceDetails(...)` succeeds and the next query tries to compute score and observation metrics?
3. Is the job state able to distinguish "summary written" from "raw rows deleted"?

## Expected Answer

A strong review should say that the product-level change is trace compaction for old data, but the implementation turns a maintenance job into an unbounded scan and makes the destructive phase happen before the preserving phase.

For flaw 1, the learner should identify that candidate discovery scans every eligible trace every run and again in the queue processor. The impact is unbounded ClickHouse load, repeated rediscovery, oversized jobs, and poor multi-tenant fairness. The fix is cursor/windowed compaction with project sharding, page limits, and persisted progress.

For flaw 2, the learner should identify that observations and scores are deleted before the summary is computed. The impact is lost latency/cost/usage/score metrics and empty summaries after partial failure or retry. The fix is materialize first, verify, then delete raw details with a resumable state machine.

The best answers should connect the flaws to the existing Langfuse patterns: bounded cleaners, delete preflight windows, and trace table metrics derived from observations/scores.

## Expert Debrief

At the product level, compaction is a storage optimization. The risk is that it looks like a background implementation detail, but it changes data lifecycle contracts. You are deciding when raw data can disappear and which derived facts must remain true afterward.

The first contract is workload boundedness. Existing Langfuse cleaners already show a mature pattern: choose limited work, chunk projects, use locks, and avoid broad ClickHouse mutations. This PR ignores that and does a global `traces FINAL` scan every interval. That is the kind of job that works in a dev database and becomes a production incident after adoption.

The second contract is preservation before destruction. Trace table metrics come from observations and scores. The PR deletes those sources, then tries to compute the summary. Even if the code "succeeds", it can write a compacted row with zero observations, no scores, no cost, and no latency. That is data loss disguised as compaction.

The failure modes are concrete:

- The runner repeatedly scans millions of old traces because there is no cursor.
- A queue job contains all candidates instead of a bounded page.
- Customer trace table metrics disappear after compaction.
- A retry after a partial delete writes an empty summary and marks the trace compacted.
- Operators cannot tell whether a trace is materialized, raw-deleted, or fully compacted.

The reviewer thought process should be: first, ask "what is the maximum work this background job can do?" If there is no bound, the design is not production-grade. Second, ask "what data is needed to produce the derived contract, and when is it deleted?" Preservation must happen before cleanup, and cleanup should be resumable.

The better implementation is a state machine. Discover candidates in bounded pages per project/time range, materialize summaries from raw rows, verify row counts and versions, then delete raw details. Persist cursor and phase state so retries resume instead of redoing or corrupting work.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: unbounded all-trace scanning and delete-before-materialize ordering. It explains ClickHouse load, repeated candidate discovery, metric loss, and retry data loss, and suggests cursor/windowed pages plus a materialize-then-delete state machine.
- `partial`: The answer finds one flaw completely and mentions either scan size or metric loss without tying it to the exact worker/repository ordering.
- `miss`: The answer focuses on queue naming, SQL style, or missing small error handling while missing bounded work and preservation-before-destruction.
