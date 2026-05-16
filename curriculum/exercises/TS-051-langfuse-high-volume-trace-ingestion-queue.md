# TS-051: Langfuse High-Volume Trace Ingestion Queue

## Metadata

- `id`: TS-051
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: public ingestion API, ingestion validation, Redis queue schema, worker ingestion processing, S3 event upload, per-item ingestion responses, server tests
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1799
- `flaw_count`: 2

## PR Description Shown To Learner

This PR adds a high-volume ingestion path for SDKs that send large trace batches.

Today `POST /api/public/ingestion` validates every event and calls `processEventBatch`, which can spend API time uploading event groups to blob storage and enqueueing per-entity ingestion jobs. For customers sending thousands of trace/span/generation events at once, this PR adds `POST /api/public/ingestion/high-volume`. The new endpoint authenticates the request, splits the batch into queue chunks, and lets a worker perform validation and normal ingestion processing later.

The PR claims to improve API latency and absorb bursty SDK traffic without changing the response shape expected by SDKs.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `web/src/pages/api/public/ingestion.ts` authenticates, checks rate limits and suspension, validates the outer body, then calls `processEventBatch`.
- `packages/shared/src/server/ingestion/processEventBatch.ts` validates every event with `createIngestionEventSchema`, checks auth scope per event type, sorts events, uploads grouped events to S3, enqueues ingestion jobs, and returns `207` with per-item successes/errors.
- `aggregateBatchResult` reports invalid events as item-level `400` errors and only returns successes for accepted valid events.
- `packages/shared/src/server/redis/ingestionQueue.ts` shards existing ingestion work by `projectId-eventBodyId`.
- `worker/src/queues/ingestionQueue.ts` assumes its queue payload already has valid ingestion metadata such as `type`, `eventBodyId`, `fileKey`, and `authCheck`.
- The ingestion endpoint is a client contract. SDKs treat successful item responses as durable acceptance.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `web/src/pages/api/public/ingestion/high-volume.ts`
- `packages/shared/src/server/ingestion/highVolumeTypes.ts`
- `packages/shared/src/server/ingestion/processHighVolumeIngestionBatch.ts`
- `packages/shared/src/server/redis/highVolumeIngestionQueue.ts`
- `packages/shared/src/server/queues.ts`
- `packages/shared/src/server/index.ts`
- `worker/src/queues/highVolumeIngestionQueue.ts`
- `worker/src/queues/workerManager.ts`
- `web/src/__tests__/server/high-volume-ingestion-api.servertest.ts`
- `web/src/__tests__/server/high-volume-ingestion-contract.servertest.ts`
- `packages/shared/src/server/ingestion/__tests__/processHighVolumeIngestionBatch.test.ts`
- `worker/src/queues/__tests__/highVolumeIngestionQueue.test.ts`
- `fern/apis/server/definition/ingestion.yml`
- `docs/api-reference/high-volume-ingestion.md`

The line references below use synthetic PR line numbers. This is a deliberately large backend/API review surface because ingestion correctness lives across API contracts, queue shape, worker behavior, and tests.

## Diff

```diff
diff --git a/web/src/pages/api/public/ingestion/high-volume.ts b/web/src/pages/api/public/ingestion/high-volume.ts
new file mode 100644
index 0000000000..d3ca6f1fe6
--- /dev/null
+++ b/web/src/pages/api/public/ingestion/high-volume.ts
@@ -0,0 +1,286 @@
+import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
+import { type NextApiRequest, type NextApiResponse } from "next";
+import { z } from "zod";
+import {
+  BaseError,
+  ForbiddenError,
+  logger,
+  MethodNotAllowedError,
+  redis,
+  traceException,
+  UnauthorizedError,
+  contextWithLangfuseProps,
+  getCurrentSpan,
+  QueueJobs,
+  HighVolumeIngestionQueue,
+  recordDistribution,
+  recordIncrement,
+} from "@langfuse/shared/src/server";
+import { prisma } from "@langfuse/shared/src/db";
+import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
+import { RateLimitService } from "@/src/features/public-api/server/RateLimitService";
+import { telemetry } from "@/src/features/telemetry";
+import * as opentelemetry from "@opentelemetry/api";
+import { chunk } from "lodash";
+import { randomUUID } from "crypto";
+
+export const config = {
+  api: {
+    bodyParser: {
+      sizeLimit: "20mb",
+    },
+  },
+};
+
+const HighVolumeIngestionBody = z.object({
+  batch: z.array(z.unknown()).min(1).max(5_000),
+  metadata: z.record(z.string(), z.unknown()).nullish(),
+});
+
+const CHUNK_SIZE = 500;
+
+export default async function handler(
+  req: NextApiRequest,
+  res: NextApiResponse,
+) {
+  try {
+    await runMiddleware(req, res, cors);
+
+    const currentSpan = getCurrentSpan();
+    Object.keys(req.headers).forEach((header) => {
+      if (
+        header.toLowerCase().startsWith("x-langfuse") ||
+        header.toLowerCase().startsWith("x_langfuse")
+      ) {
+        currentSpan?.setAttributes({
+          [`langfuse.header.${header.slice(11).toLowerCase().replaceAll("_", "-")}`]:
+            req.headers[header],
+        });
+      }
+    });
+
+    if (req.method !== "POST") {
+      throw new MethodNotAllowedError();
+    }
+
+    const authCheck = await new ApiAuthService(
+      prisma,
+      redis,
+    ).verifyAuthHeaderAndReturnScope(req.headers.authorization);
+
+    if (!authCheck.validKey) {
+      throw new UnauthorizedError(authCheck.error);
+    }
+
+    if (!authCheck.scope.projectId) {
+      throw new UnauthorizedError(
+        "Missing projectId in scope. Are you using an organization key?",
+      );
+    }
+
+    if (authCheck.scope.isIngestionSuspended) {
+      throw new ForbiddenError(
+        "Ingestion suspended: Usage threshold exceeded. Please upgrade your plan.",
+      );
+    }
+
+    const ctx = contextWithLangfuseProps({
+      headers: req.headers,
+      projectId: authCheck.scope.projectId,
+    });
+
+    return opentelemetry.context.with(ctx, async () => {
+      try {
+        const rateLimitCheck =
+          await RateLimitService.getInstance().rateLimitRequest(
+            authCheck.scope,
+            "ingestion",
+          );
+
+        if (rateLimitCheck?.isRateLimited()) {
+          return rateLimitCheck.sendRestResponseIfLimited(res);
+        }
+      } catch (e) {
+        logger.error("Error while rate limiting high-volume ingestion", e);
+      }
+
+      const parsedBody = HighVolumeIngestionBody.safeParse(req.body);
+
+      if (!parsedBody.success) {
+        logger.info("Invalid high-volume ingestion request data", {
+          error: parsedBody.error,
+        });
+        return res.status(400).json({
+          message: "Invalid request data",
+          errors: parsedBody.error.issues.map((issue) => issue.message),
+        });
+      }
+
+      if (!redis) {
+        throw new Error("Redis not initialized, aborting event processing");
+      }
+
+      await telemetry();
+
+      const requestId = randomUUID();
+      const batch = parsedBody.data.batch;
+      const chunks = chunk(batch, CHUNK_SIZE);
+
+      recordIncrement("langfuse.ingestion.high_volume.request", 1, {
+        projectId: authCheck.scope.projectId,
+      });
+      recordDistribution("langfuse.ingestion.high_volume.batch_size", batch.length, {
+        projectId: authCheck.scope.projectId,
+      });
+      currentSpan?.setAttribute("langfuse.ingestion.high_volume.request_id", requestId);
+      currentSpan?.setAttribute("langfuse.ingestion.high_volume.batch_size", batch.length);
+      currentSpan?.setAttribute("langfuse.ingestion.high_volume.chunk_count", chunks.length);
+
+      const queue = HighVolumeIngestionQueue.getInstance({
+        shardingKey: authCheck.scope.projectId,
+      });
+
+      if (!queue) {
+        throw new Error("High-volume ingestion queue not available");
+      }
+
+      await Promise.all(
+        chunks.map((events, chunkIndex) =>
+          queue.add(QueueJobs.HighVolumeIngestionJob, {
+            id: randomUUID(),
+            timestamp: new Date(),
+            name: QueueJobs.HighVolumeIngestionJob as const,
+            payload: {
+              requestId,
+              chunkIndex,
+              totalChunks: chunks.length,
+              batch: events,
+              metadata: parsedBody.data.metadata ?? null,
+              authCheck: authCheck as {
+                validKey: true;
+                scope: {
+                  projectId: string;
+                  accessLevel: "project" | "scores";
+                  orgId?: string;
+                };
+              },
+              headers: {
+                sdkName:
+                  typeof req.headers["x-langfuse-sdk-name"] === "string"
+                    ? req.headers["x-langfuse-sdk-name"]
+                    : undefined,
+                sdkVersion:
+                  typeof req.headers["x-langfuse-sdk-version"] === "string"
+                    ? req.headers["x-langfuse-sdk-version"]
+                    : undefined,
+              },
+            },
+          }),
+        ),
+      );
+
+      logger.info("Queued high-volume ingestion batch", {
+        projectId: authCheck.scope.projectId,
+        requestId,
+        events: batch.length,
+        chunks: chunks.length,
+      });
+
+      return res.status(207).json({
+        requestId,
+        successes: batch.map((event, index) => ({
+          id:
+            typeof event === "object" && event !== null && "id" in event
+              ? String((event as { id?: unknown }).id ?? index)
+              : String(index),
+          status: 202,
+        })),
+        errors: [],
+      });
+    });
+  } catch (error: unknown) {
+    if (!(error instanceof UnauthorizedError)) {
+      logger.error("error_handling_high_volume_ingestion_event", error);
+      traceException(error);
+    }
+
+    if (error instanceof BaseError) {
+      return res.status(error.httpCode).json({
+        error: error.name,
+        message: error.message,
+      });
+    }
+
+    if (error instanceof z.ZodError) {
+      return res.status(400).json({
+        message: "Invalid request data",
+        error: error.issues,
+      });
+    }
+
+    const errorMessage =
+      error instanceof Error ? error.message : "An unknown error occurred";
+    return res.status(500).json({
+      message: "Invalid request data",
+      errors: [errorMessage],
+    });
+  }
+}
diff --git a/packages/shared/src/server/ingestion/highVolumeTypes.ts b/packages/shared/src/server/ingestion/highVolumeTypes.ts
new file mode 100644
index 0000000000..f71a08334f
--- /dev/null
+++ b/packages/shared/src/server/ingestion/highVolumeTypes.ts
@@ -0,0 +1,182 @@
+import { z } from "zod";
+
+export const HighVolumeIngestionHeaders = z.object({
+  sdkName: z.string().optional(),
+  sdkVersion: z.string().optional(),
+});
+
+export const HighVolumeIngestionJobPayload = z.object({
+  requestId: z.string(),
+  chunkIndex: z.number().int().nonnegative(),
+  totalChunks: z.number().int().positive(),
+  batch: z.array(z.unknown()).min(1).max(500),
+  metadata: z.record(z.string(), z.unknown()).nullish(),
+  authCheck: z.object({
+    validKey: z.literal(true),
+    scope: z.object({
+      projectId: z.string(),
+      accessLevel: z.enum(["project", "scores"]),
+      orgId: z.string().optional(),
+    }),
+  }),
+  headers: HighVolumeIngestionHeaders.optional(),
+});
+
+export type HighVolumeIngestionJobPayload = z.infer<
+  typeof HighVolumeIngestionJobPayload
+>;
+
+export const HighVolumeIngestionResponse = z.object({
+  requestId: z.string(),
+  successes: z.array(
+    z.object({
+      id: z.string(),
+      status: z.number(),
+    }),
+  ),
+  errors: z.array(
+    z.object({
+      id: z.string(),
+      status: z.number(),
+      message: z.string().optional(),
+      error: z.string().optional(),
+    }),
+  ),
+});
+
+export type HighVolumeIngestionResponse = z.infer<
+  typeof HighVolumeIngestionResponse
+>;
+
+export const HighVolumeIngestionWorkerResult = z.object({
+  requestId: z.string(),
+  chunkIndex: z.number(),
+  accepted: z.number(),
+  rejected: z.number(),
+  errors: z.array(
+    z.object({
+      id: z.string(),
+      message: z.string(),
+    }),
+  ),
+});
+
+export type HighVolumeIngestionWorkerResult = z.infer<
+  typeof HighVolumeIngestionWorkerResult
+>;
diff --git a/packages/shared/src/server/ingestion/processHighVolumeIngestionBatch.ts b/packages/shared/src/server/ingestion/processHighVolumeIngestionBatch.ts
new file mode 100644
index 0000000000..85af7c451a
--- /dev/null
+++ b/packages/shared/src/server/ingestion/processHighVolumeIngestionBatch.ts
@@ -0,0 +1,288 @@
+import { z } from "zod";
+import {
+  createIngestionEventSchema,
+  eventTypes,
+  type IngestionEventType,
+} from "./types";
+import { processEventBatch } from "./processEventBatch";
+import { HighVolumeIngestionJobPayload } from "./highVolumeTypes";
+import {
+  AuthHeaderValidVerificationResultIngestion,
+  InvalidRequestError,
+  logger,
+  recordDistribution,
+  recordIncrement,
+  traceException,
+} from "../index";
+
+export const processHighVolumeIngestionBatch = async (
+  payload: HighVolumeIngestionJobPayload,
+) => {
+  const ingestionSchema = createIngestionEventSchema();
+  const validationErrors: Array<{ id: string; message: string }> = [];
+  const validEvents: IngestionEventType[] = [];
+
+  for (const event of payload.batch) {
+    const parsed = ingestionSchema.safeParse(event);
+    if (!parsed.success) {
+      validationErrors.push({
+        id: inferEventId(event),
+        message: parsed.error.message,
+      });
+      continue;
+    }
+
+    if (parsed.data.type === eventTypes.SDK_LOG) {
+      logger.info("SDK Log Event", { event: parsed.data });
+      continue;
+    }
+
+    validEvents.push(parsed.data);
+  }
+
+  recordIncrement("langfuse.ingestion.high_volume.chunk", 1, {
+    projectId: payload.authCheck.scope.projectId,
+  });
+  recordDistribution(
+    "langfuse.ingestion.high_volume.chunk_size",
+    payload.batch.length,
+    { projectId: payload.authCheck.scope.projectId },
+  );
+
+  if (validationErrors.length > 0) {
+    logger.warn("Invalid events in high-volume ingestion chunk", {
+      projectId: payload.authCheck.scope.projectId,
+      requestId: payload.requestId,
+      chunkIndex: payload.chunkIndex,
+      invalidCount: validationErrors.length,
+      examples: validationErrors.slice(0, 10),
+    });
+    traceException(
+      new InvalidRequestError(
+        `Invalid events in high-volume ingestion chunk: ${validationErrors.length}`,
+      ),
+    );
+    throw new Error(
+      `Invalid high-volume ingestion chunk ${payload.requestId}:${payload.chunkIndex}`,
+    );
+  }
+
+  if (validEvents.length === 0) {
+    logger.info("High-volume ingestion chunk had no processable events", {
+      projectId: payload.authCheck.scope.projectId,
+      requestId: payload.requestId,
+      chunkIndex: payload.chunkIndex,
+    });
+    return {
+      requestId: payload.requestId,
+      chunkIndex: payload.chunkIndex,
+      accepted: 0,
+      rejected: validationErrors.length,
+      errors: validationErrors,
+    };
+  }
+
+  const result = await processEventBatch(
+    validEvents,
+    payload.authCheck as AuthHeaderValidVerificationResultIngestion,
+    {
+      source: "api",
+      delay: 0,
+    },
+  );
+
+  if (result.errors.length > 0) {
+    logger.warn("High-volume ingestion chunk produced processing errors", {
+      projectId: payload.authCheck.scope.projectId,
+      requestId: payload.requestId,
+      chunkIndex: payload.chunkIndex,
+      errors: result.errors,
+    });
+  }
+
+  return {
+    requestId: payload.requestId,
+    chunkIndex: payload.chunkIndex,
+    accepted: result.successes.length,
+    rejected: result.errors.length,
+    errors: result.errors.map((error) => ({
+      id: error.id,
+      message: error.error ?? error.message ?? "Unknown error",
+    })),
+  };
+};
+
+function inferEventId(event: unknown) {
+  if (typeof event === "object" && event !== null && "id" in event) {
+    const id = (event as { id?: unknown }).id;
+    return typeof id === "string" ? id : "unknown";
+  }
+
+  return "unknown";
+}
diff --git a/packages/shared/src/server/redis/highVolumeIngestionQueue.ts b/packages/shared/src/server/redis/highVolumeIngestionQueue.ts
new file mode 100644
index 0000000000..92247fa49d
--- /dev/null
+++ b/packages/shared/src/server/redis/highVolumeIngestionQueue.ts
@@ -0,0 +1,164 @@
+import { Queue } from "bullmq";
+import { QueueName, TQueueJobTypes } from "../queues";
+import {
+  createNewRedisInstance,
+  redisQueueRetryOptions,
+  getQueuePrefix,
+} from "./redis";
+import { logger } from "../logger";
+import { getShardIndex } from "./sharding";
+import { env } from "../../env";
+
+export class HighVolumeIngestionQueue {
+  private static instances: Map<
+    number,
+    Queue<TQueueJobTypes[QueueName.HighVolumeIngestionQueue]> | null
+  > = new Map();
+
+  public static getShardNames() {
+    return Array.from(
+      { length: env.LANGFUSE_INGESTION_QUEUE_SHARD_COUNT },
+      (_, i) =>
+        `${QueueName.HighVolumeIngestionQueue}${i > 0 ? `-${i}` : ""}`,
+    );
+  }
+
+  static getShardIndexFromShardName(shardName: string | undefined) {
+    if (!shardName) return null;
+    const shardIndex =
+      shardName === QueueName.HighVolumeIngestionQueue
+        ? 0
+        : parseInt(
+            shardName.replace(`${QueueName.HighVolumeIngestionQueue}-`, ""),
+            10,
+          );
+
+    if (isNaN(shardIndex)) return null;
+    return shardIndex;
+  }
+
+  public static getInstance({
+    shardingKey,
+    shardName,
+  }: {
+    shardingKey?: string;
+    shardName?: string;
+  }): Queue<TQueueJobTypes[QueueName.HighVolumeIngestionQueue]> | null {
+    const shardIndex =
+      HighVolumeIngestionQueue.getShardIndexFromShardName(shardName) ??
+      (env.REDIS_CLUSTER_ENABLED === "true" && shardingKey
+        ? getShardIndex(shardingKey, env.LANGFUSE_INGESTION_QUEUE_SHARD_COUNT)
+        : 0);
+
+    if (HighVolumeIngestionQueue.instances.has(shardIndex)) {
+      return HighVolumeIngestionQueue.instances.get(shardIndex) || null;
+    }
+
+    const newRedis = createNewRedisInstance({
+      enableOfflineQueue: false,
+      ...redisQueueRetryOptions,
+    });
+
+    const name = `${QueueName.HighVolumeIngestionQueue}${shardIndex > 0 ? `-${shardIndex}` : ""}`;
+    const queueInstance = newRedis
+      ? new Queue<TQueueJobTypes[QueueName.HighVolumeIngestionQueue]>(name, {
+          connection: newRedis,
+          prefix: getQueuePrefix(name),
+          defaultJobOptions: {
+            removeOnComplete: true,
+            removeOnFail: 100_000,
+            attempts: 6,
+            backoff: {
+              type: "exponential",
+              delay: 5000,
+            },
+          },
+        })
+      : null;
+
+    queueInstance?.on("error", (err) => {
+      logger.error(`HighVolumeIngestionQueue shard ${shardIndex} error`, err);
+    });
+
+    HighVolumeIngestionQueue.instances.set(shardIndex, queueInstance);
+    return queueInstance;
+  }
+}
diff --git a/packages/shared/src/server/queues.ts b/packages/shared/src/server/queues.ts
index 9f492cf6fd..451affb839 100644
--- a/packages/shared/src/server/queues.ts
+++ b/packages/shared/src/server/queues.ts
@@ -331,6 +331,7 @@ export enum QueueName {
   OtelIngestionQueue = "otel-ingestion-queue",
   OtelIngestionSecondaryQueue = "secondary-otel-ingestion-queue",
   IngestionQueue = "ingestion-queue", // Process single events with S3-merge
+  HighVolumeIngestionQueue = "high-volume-ingestion-queue",
   IngestionSecondaryQueue = "secondary-ingestion-queue",
   TraceUpsert = "trace-upsert",
   TraceDelete = "trace-delete",
@@ -370,6 +371,7 @@ export enum QueueJobs {
   OtelIngestionJob = "otel-ingestion-job",
   IngestionJob = "ingestion-job",
+  HighVolumeIngestionJob = "high-volume-ingestion-job",
   ExperimentCreateJob = "experiment-create",
   PostHogIntegrationProcessingJob = "posthog-integration-processing-job",
   MixpanelIntegrationProcessingJob = "mixpanel-integration-processing-job",
@@ -472,6 +474,18 @@ export type TQueueJobTypes = {
     };
     name: QueueJobs.IngestionJob;
   };
+  [QueueName.HighVolumeIngestionQueue]: {
+    id: string;
+    timestamp: Date;
+    name: QueueJobs.HighVolumeIngestionJob;
+    payload: {
+      requestId: string;
+      chunkIndex: number;
+      totalChunks: number;
+      batch: unknown[];
+      metadata?: Record<string, unknown> | null;
+      authCheck: unknown;
+      headers?: Record<string, string | undefined>;
+    };
+  };
   [QueueName.IngestionSecondaryQueue]: {
     id: string;
     timestamp: Date;
diff --git a/packages/shared/src/server/index.ts b/packages/shared/src/server/index.ts
index 0a4680f1d3..900deba0f0 100644
--- a/packages/shared/src/server/index.ts
+++ b/packages/shared/src/server/index.ts
@@ -51,6 +51,8 @@ export * from "./ingestion/processEventBatch";
 export * from "../server/ingestion/validateAndInflateScore";
 export * from "./ingestion/extractToolsBackend";
+export * from "./ingestion/highVolumeTypes";
+export * from "./ingestion/processHighVolumeIngestionBatch";
 export * from "../server/ingestion/sampling";
 export * from "./otel/attributes";
 export * from "./otel/OtelIngestionProcessor";
@@ -72,6 +74,7 @@ export * from "./redis/batchActionQueue";
 export * from "./redis/batchExport";
 export * from "./redis/cloudUsageMeteringQueue";
 export * from "./redis/ingestionQueue";
+export * from "./redis/highVolumeIngestionQueue";
 export * from "./redis/otelIngestionQueue";
 export * from "./redis/eventPropagationQueue";
 export * from "./redis/cloudUsageMeteringQueue";
diff --git a/worker/src/queues/highVolumeIngestionQueue.ts b/worker/src/queues/highVolumeIngestionQueue.ts
new file mode 100644
index 0000000000..553c06d9f5
--- /dev/null
+++ b/worker/src/queues/highVolumeIngestionQueue.ts
@@ -0,0 +1,226 @@
+import { Job, Processor } from "bullmq";
+import {
+  HighVolumeIngestionJobPayload,
+  logger,
+  processHighVolumeIngestionBatch,
+  QueueName,
+  recordHistogram,
+  recordIncrement,
+  TQueueJobTypes,
+  traceException,
+} from "@langfuse/shared/src/server";
+
+export const highVolumeIngestionQueueProcessor: Processor = async (
+  job: Job<TQueueJobTypes[QueueName.HighVolumeIngestionQueue]>,
+) => {
+  const startedAt = Date.now();
+  const parsedPayload = HighVolumeIngestionJobPayload.safeParse(
+    job.data.payload,
+  );
+
+  if (!parsedPayload.success) {
+    logger.error("Invalid high-volume ingestion queue payload", {
+      jobId: job.id,
+      error: parsedPayload.error,
+    });
+    throw new Error("Invalid high-volume ingestion queue payload");
+  }
+
+  const payload = parsedPayload.data;
+
+  try {
+    logger.debug("Processing high-volume ingestion chunk", {
+      projectId: payload.authCheck.scope.projectId,
+      requestId: payload.requestId,
+      chunkIndex: payload.chunkIndex,
+      totalChunks: payload.totalChunks,
+      events: payload.batch.length,
+    });
+
+    const result = await processHighVolumeIngestionBatch(payload);
+
+    recordIncrement("langfuse.ingestion.high_volume.worker.chunk_processed", 1, {
+      projectId: payload.authCheck.scope.projectId,
+    });
+    recordHistogram(
+      "langfuse.ingestion.high_volume.worker.processing_ms",
+      Date.now() - startedAt,
+      { projectId: payload.authCheck.scope.projectId },
+    );
+
+    logger.info("Processed high-volume ingestion chunk", {
+      projectId: payload.authCheck.scope.projectId,
+      requestId: payload.requestId,
+      chunkIndex: payload.chunkIndex,
+      accepted: result.accepted,
+      rejected: result.rejected,
+    });
+  } catch (error) {
+    logger.error("Failed high-volume ingestion chunk", {
+      projectId: payload.authCheck.scope.projectId,
+      requestId: payload.requestId,
+      chunkIndex: payload.chunkIndex,
+      error,
+    });
+    recordIncrement("langfuse.ingestion.high_volume.worker.chunk_failed", 1, {
+      projectId: payload.authCheck.scope.projectId,
+    });
+    traceException(error);
+    throw error;
+  }
+};
diff --git a/worker/src/queues/workerManager.ts b/worker/src/queues/workerManager.ts
index c845fd2e15..6d236cf3a3 100644
--- a/worker/src/queues/workerManager.ts
+++ b/worker/src/queues/workerManager.ts
@@ -9,6 +9,7 @@ import {
   IngestionQueue,
   QueueName,
   SecondaryIngestionQueue,
+  HighVolumeIngestionQueue,
 } from "@langfuse/shared/src/server";
 import { ingestionQueueProcessorBuilder } from "./ingestionQueue";
+import { highVolumeIngestionQueueProcessor } from "./highVolumeIngestionQueue";
 import { otelIngestionQueueProcessorBuilder } from "./otelIngestionQueue";
 
 export class WorkerManager {
@@ -71,6 +72,17 @@ export class WorkerManager {
       },
     );
 
+    this.registerShardedQueue(
+      QueueName.HighVolumeIngestionQueue,
+      HighVolumeIngestionQueue.getShardNames(),
+      highVolumeIngestionQueueProcessor,
+      {
+        concurrency: env.LANGFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY,
+        lockDuration: 120_000,
+        stalledInterval: 30_000,
+      },
+    );
+
     this.registerShardedQueue(
       QueueName.IngestionSecondaryQueue,
       SecondaryIngestionQueue.getShardNames(),
diff --git a/web/src/__tests__/server/high-volume-ingestion-api.servertest.ts b/web/src/__tests__/server/high-volume-ingestion-api.servertest.ts
new file mode 100644
index 0000000000..445ae8ec18
--- /dev/null
+++ b/web/src/__tests__/server/high-volume-ingestion-api.servertest.ts
@@ -0,0 +1,282 @@
+import { randomUUID } from "crypto";
+import { makeAPICall } from "@/src/__tests__/test-utils";
+import {
+  createOrgProjectAndApiKey,
+  HighVolumeIngestionQueue,
+  QueueJobs,
+} from "@langfuse/shared/src/server";
+
+let projectId: string;
+let auth: string;
+
+const postHighVolumeIngestion = (body: unknown) =>
+  makeAPICall("POST", "/api/public/ingestion/high-volume", body, auth);
+
+describe("/api/public/ingestion/high-volume API Endpoint", () => {
+  beforeEach(async () => {
+    const fixture = await createOrgProjectAndApiKey();
+    projectId = fixture.projectId;
+    auth = fixture.auth;
+  });
+
+  it("queues a high-volume trace batch and returns per-event accepted statuses", async () => {
+    const traceId = randomUUID();
+    const batch = Array.from({ length: 1_200 }, (_, index) => ({
+      id: randomUUID(),
+      type: "trace-create",
+      timestamp: new Date().toISOString(),
+      body: {
+        id: `${traceId}-${index}`,
+        name: `trace-${index}`,
+        timestamp: new Date().toISOString(),
+      },
+    }));
+
+    const response = await postHighVolumeIngestion({ batch });
+
+    expect(response.status).toBe(207);
+    expect(response.body.requestId).toBeDefined();
+    expect(response.body.successes).toHaveLength(1_200);
+    expect(response.body.errors).toEqual([]);
+  });
+
+  it("accepts mixed trace and observation events", async () => {
+    const traceId = randomUUID();
+    const batch = [
+      {
+        id: randomUUID(),
+        type: "trace-create",
+        timestamp: new Date().toISOString(),
+        body: {
+          id: traceId,
+          timestamp: new Date().toISOString(),
+        },
+      },
+      {
+        id: randomUUID(),
+        type: "span-create",
+        timestamp: new Date().toISOString(),
+        body: {
+          id: randomUUID(),
+          traceId,
+          startTime: new Date().toISOString(),
+        },
+      },
+    ];
+
+    const response = await postHighVolumeIngestion({ batch });
+
+    expect(response.status).toBe(207);
+    expect(response.body.successes).toHaveLength(2);
+  });
+
+  it("accepts invalid event shapes so the worker can reject them asynchronously", async () => {
+    const response = await postHighVolumeIngestion({
+      batch: [
+        {
+          id: "bad-event",
+          type: "trace-create",
+          timestamp: "not-a-date",
+          body: {
+            id: randomUUID(),
+          },
+        },
+      ],
+    });
+
+    expect(response.status).toBe(207);
+    expect(response.body.successes).toEqual([{ id: "bad-event", status: 202 }]);
+    expect(response.body.errors).toEqual([]);
+  });
+
+  it("splits queue jobs by chunk size", async () => {
+    const batch = Array.from({ length: 501 }, () => ({
+      id: randomUUID(),
+      type: "trace-create",
+      timestamp: new Date().toISOString(),
+      body: {
+        id: randomUUID(),
+        timestamp: new Date().toISOString(),
+      },
+    }));
+    const addSpy = vi
+      .spyOn(HighVolumeIngestionQueue.getInstance({ shardingKey: projectId })!, "add")
+      .mockResolvedValue({} as never);
+
+    const response = await postHighVolumeIngestion({ batch });
+
+    expect(response.status).toBe(207);
+    expect(addSpy).toHaveBeenCalledTimes(2);
+    expect(addSpy.mock.calls[0][0]).toBe(QueueJobs.HighVolumeIngestionJob);
+  });
+});
diff --git a/web/src/__tests__/server/high-volume-ingestion-contract.servertest.ts b/web/src/__tests__/server/high-volume-ingestion-contract.servertest.ts
new file mode 100644
index 0000000000..6201fd8b88
--- /dev/null
+++ b/web/src/__tests__/server/high-volume-ingestion-contract.servertest.ts
@@ -0,0 +1,292 @@
+import { randomUUID } from "crypto";
+import { makeAPICall } from "@/src/__tests__/test-utils";
+import {
+  createOrgProjectAndApiKey,
+  HighVolumeIngestionQueue,
+  QueueJobs,
+} from "@langfuse/shared/src/server";
+
+type QueuedJob = {
+  name: QueueJobs;
+  data: {
+    id: string;
+    timestamp: Date;
+    name: QueueJobs;
+    payload: {
+      requestId: string;
+      chunkIndex: number;
+      totalChunks: number;
+      batch: unknown[];
+      metadata: Record<string, unknown> | null;
+      authCheck: unknown;
+      headers?: {
+        sdkName?: string;
+        sdkVersion?: string;
+      };
+    };
+  };
+};
+
+let projectId: string;
+let auth: string;
+let queuedJobs: QueuedJob[];
+
+const postHighVolumeIngestion = (
+  body: unknown,
+  headers?: Record<string, string>,
+) =>
+  makeAPICall(
+    "POST",
+    "/api/public/ingestion/high-volume",
+    body,
+    auth,
+    headers,
+  );
+
+describe("/api/public/ingestion/high-volume contract", () => {
+  beforeEach(async () => {
+    queuedJobs = [];
+    const fixture = await createOrgProjectAndApiKey();
+    projectId = fixture.projectId;
+    auth = fixture.auth;
+
+    vi.spyOn(
+      HighVolumeIngestionQueue.getInstance({ shardingKey: projectId })!,
+      "add",
+    ).mockImplementation(async (name, data) => {
+      queuedJobs.push({ name, data } as QueuedJob);
+      return {} as never;
+    });
+  });
+
+  afterEach(() => {
+    vi.restoreAllMocks();
+  });
+
+  it("keeps the standard ingestion response envelope", async () => {
+    const response = await postHighVolumeIngestion({
+      batch: [traceCreateEvent()],
+      metadata: {
+        source: "sdk",
+        batchId: "batch-1",
+      },
+    });
+
+    expect(response.status).toBe(207);
+    expect(response.body).toEqual({
+      requestId: expect.any(String),
+      successes: [
+        {
+          id: expect.any(String),
+          status: 202,
+        },
+      ],
+      errors: [],
+    });
+  });
+
+  it("returns accepted statuses for a batch that contains invalid events", async () => {
+    const valid = traceCreateEvent({ id: "valid-trace-event" });
+    const invalid = {
+      id: "invalid-trace-event",
+      type: "trace-create",
+      timestamp: "not-a-date",
+      body: {
+        id: randomUUID(),
+        timestamp: "also-not-a-date",
+      },
+    };
+
+    const response = await postHighVolumeIngestion({
+      batch: [valid, invalid],
+    });
+
+    expect(response.status).toBe(207);
+    expect(response.body.successes).toEqual([
+      {
+        id: "valid-trace-event",
+        status: 202,
+      },
+      {
+        id: "invalid-trace-event",
+        status: 202,
+      },
+    ]);
+    expect(response.body.errors).toEqual([]);
+  });
+
+  it("queues raw events before knowing whether they match the ingestion schema", async () => {
+    const invalid = {
+      id: "bad-generation",
+      type: "generation-create",
+      timestamp: "2024-01-01T00:00:00.000Z",
+      body: {
+        id: randomUUID(),
+        traceId: randomUUID(),
+        usage: "wrong-shape",
+      },
+    };
+
+    const response = await postHighVolumeIngestion({
+      batch: [invalid],
+    });
+
+    expect(response.status).toBe(207);
+    expect(queuedJobs).toHaveLength(1);
+    expect(queuedJobs[0].data.payload.batch).toEqual([invalid]);
+  });
+
+  it("splits a large request into high-volume chunks without per-event validation", async () => {
+    const batch = [
+      ...Array.from({ length: 499 }, (_, index) =>
+        traceCreateEvent({ id: `valid-${index}` }),
+      ),
+      {
+        id: "bad-event",
+        type: "span-create",
+        timestamp: "not-a-date",
+        body: {
+          id: randomUUID(),
+          traceId: randomUUID(),
+        },
+      },
+      traceCreateEvent({ id: "valid-after-bad-event" }),
+    ];
+
+    const response = await postHighVolumeIngestion({ batch });
+
+    expect(response.status).toBe(207);
+    expect(response.body.errors).toEqual([]);
+    expect(queuedJobs).toHaveLength(2);
+    expect(queuedJobs[0].data.payload.batch).toHaveLength(500);
+    expect(queuedJobs[1].data.payload.batch).toHaveLength(1);
+  });
+
+  it("records SDK metadata on the queue payload but not in the response contract", async () => {
+    const response = await postHighVolumeIngestion(
+      {
+        batch: [traceCreateEvent()],
+      },
+      {
+        "x-langfuse-sdk-name": "langfuse-js",
+        "x-langfuse-sdk-version": "3.0.0",
+      },
+    );
+
+    expect(response.status).toBe(207);
+    expect(response.body.successes).toHaveLength(1);
+    expect(response.body.errors).toEqual([]);
+    expect(queuedJobs[0].data.payload.headers).toEqual({
+      sdkName: "langfuse-js",
+      sdkVersion: "3.0.0",
+    });
+  });
+
+  it("preserves metadata on every queued chunk", async () => {
+    const metadata = {
+      release: "2024.12.01",
+      environment: "production",
+      batchId: randomUUID(),
+    };
+    const batch = Array.from({ length: 1_001 }, (_, index) =>
+      traceCreateEvent({ id: `event-${index}` }),
+    );
+
+    const response = await postHighVolumeIngestion({
+      batch,
+      metadata,
+    });
+
+    expect(response.status).toBe(207);
+    expect(queuedJobs).toHaveLength(3);
+    expect(queuedJobs.map((job) => job.data.payload.metadata)).toEqual([
+      metadata,
+      metadata,
+      metadata,
+    ]);
+  });
+
+  it("uses the authenticated project as the queue shard key", async () => {
+    const getInstanceSpy = vi.spyOn(HighVolumeIngestionQueue, "getInstance");
+
+    const response = await postHighVolumeIngestion({
+      batch: [traceCreateEvent()],
+    });
+
+    expect(response.status).toBe(207);
+    expect(getInstanceSpy).toHaveBeenCalledWith({
+      shardingKey: projectId,
+    });
+  });
+
+  it("rejects only invalid envelopes synchronously", async () => {
+    const missingBatch = await postHighVolumeIngestion({
+      metadata: {
+        source: "sdk",
+      },
+    });
+
+    const emptyBatch = await postHighVolumeIngestion({
+      batch: [],
+    });
+
+    expect(missingBatch.status).toBe(400);
+    expect(emptyBatch.status).toBe(400);
+    expect(queuedJobs).toEqual([]);
+  });
+
+  it("keeps queue request identity stable across chunks", async () => {
+    const batch = Array.from({ length: 1_200 }, (_, index) =>
+      traceCreateEvent({ id: `trace-${index}` }),
+    );
+
+    const response = await postHighVolumeIngestion({ batch });
+
+    expect(response.status).toBe(207);
+    expect(new Set(queuedJobs.map((job) => job.data.payload.requestId)).size).toBe(
+      1,
+    );
+    expect(queuedJobs.map((job) => job.data.payload.chunkIndex)).toEqual([
+      0,
+      1,
+      2,
+    ]);
+    expect(queuedJobs.map((job) => job.data.payload.totalChunks)).toEqual([
+      3,
+      3,
+      3,
+    ]);
+  });
+
+  it("falls back to positional response ids for events without ids", async () => {
+    const response = await postHighVolumeIngestion({
+      batch: [
+        {
+          type: "trace-create",
+          timestamp: new Date().toISOString(),
+          body: {
+            id: randomUUID(),
+            timestamp: new Date().toISOString(),
+          },
+        },
+      ],
+    });
+
+    expect(response.status).toBe(207);
+    expect(response.body.successes).toEqual([
+      {
+        id: "0",
+        status: 202,
+      },
+    ]);
+    expect(response.body.errors).toEqual([]);
+  });
+
+  function traceCreateEvent(overrides: Partial<Record<string, unknown>> = {}) {
+    return {
+      id: randomUUID(),
+      type: "trace-create",
+      timestamp: new Date().toISOString(),
+      body: {
+        id: randomUUID(),
+        name: "high-volume-contract-test",
+        timestamp: new Date().toISOString(),
+      },
+      ...overrides,
+    };
+  }
+});
diff --git a/packages/shared/src/server/ingestion/__tests__/processHighVolumeIngestionBatch.test.ts b/packages/shared/src/server/ingestion/__tests__/processHighVolumeIngestionBatch.test.ts
new file mode 100644
index 0000000000..f52b4f4b62
--- /dev/null
+++ b/packages/shared/src/server/ingestion/__tests__/processHighVolumeIngestionBatch.test.ts
@@ -0,0 +1,286 @@
+import { randomUUID } from "crypto";
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import { processHighVolumeIngestionBatch } from "../processHighVolumeIngestionBatch";
+import type { HighVolumeIngestionJobPayload } from "../highVolumeTypes";
+import { processEventBatch } from "../processEventBatch";
+import { logger, traceException } from "../../index";
+
+vi.mock("../processEventBatch", () => ({
+  processEventBatch: vi.fn(),
+}));
+
+vi.mock("../../index", async (importOriginal) => {
+  const actual = await importOriginal<typeof import("../../index")>();
+  return {
+    ...actual,
+    logger: {
+      info: vi.fn(),
+      warn: vi.fn(),
+      error: vi.fn(),
+      debug: vi.fn(),
+    },
+    traceException: vi.fn(),
+    recordIncrement: vi.fn(),
+    recordDistribution: vi.fn(),
+  };
+});
+
+describe("processHighVolumeIngestionBatch", () => {
+  beforeEach(() => {
+    vi.mocked(processEventBatch).mockResolvedValue({
+      successes: [
+        {
+          id: "trace-event-1",
+          status: 201,
+        },
+      ],
+      errors: [],
+    });
+    vi.clearAllMocks();
+  });
+
+  it("delegates validated trace events to the normal ingestion pipeline", async () => {
+    const payload = buildPayload({
+      batch: [
+        traceCreateEvent({
+          id: "trace-event-1",
+        }),
+      ],
+    });
+
+    const result = await processHighVolumeIngestionBatch(payload);
+
+    expect(processEventBatch).toHaveBeenCalledTimes(1);
+    expect(processEventBatch).toHaveBeenCalledWith(
+      [
+        expect.objectContaining({
+          id: "trace-event-1",
+          type: "trace-create",
+        }),
+      ],
+      payload.authCheck,
+      {
+        source: "api",
+        delay: 0,
+      },
+    );
+    expect(result).toEqual({
+      requestId: payload.requestId,
+      chunkIndex: 0,
+      accepted: 1,
+      rejected: 0,
+      errors: [],
+    });
+  });
+
+  it("throws if any event in the already queued chunk is invalid", async () => {
+    const payload = buildPayload({
+      batch: [
+        traceCreateEvent({
+          id: "good-event-before-invalid-one",
+        }),
+        {
+          id: "invalid-event",
+          type: "trace-create",
+          timestamp: "not-a-date",
+          body: {
+            id: randomUUID(),
+            timestamp: "also-not-a-date",
+          },
+        },
+        traceCreateEvent({
+          id: "good-event-after-invalid-one",
+        }),
+      ],
+    });
+
+    await expect(processHighVolumeIngestionBatch(payload)).rejects.toThrow(
+      `Invalid high-volume ingestion chunk ${payload.requestId}:0`,
+    );
+
+    expect(processEventBatch).not.toHaveBeenCalled();
+    expect(logger.warn).toHaveBeenCalledWith(
+      "Invalid events in high-volume ingestion chunk",
+      expect.objectContaining({
+        projectId: payload.authCheck.scope.projectId,
+        requestId: payload.requestId,
+        chunkIndex: 0,
+        invalidCount: 1,
+      }),
+    );
+    expect(traceException).toHaveBeenCalled();
+  });
+
+  it("filters sdk-log events in the worker instead of the API request", async () => {
+    const payload = buildPayload({
+      batch: [
+        {
+          id: "sdk-log-event",
+          type: "sdk-log",
+          timestamp: new Date().toISOString(),
+          body: {
+            log: "failed to flush",
+          },
+        },
+        traceCreateEvent({
+          id: "trace-event-1",
+        }),
+      ],
+    });
+
+    await processHighVolumeIngestionBatch(payload);
+
+    expect(logger.info).toHaveBeenCalledWith("SDK Log Event", {
+      event: expect.objectContaining({
+        id: "sdk-log-event",
+        type: "sdk-log",
+      }),
+    });
+    expect(processEventBatch).toHaveBeenCalledWith(
+      [
+        expect.objectContaining({
+          id: "trace-event-1",
+        }),
+      ],
+      payload.authCheck,
+      {
+        source: "api",
+        delay: 0,
+      },
+    );
+  });
+
+  it("maps downstream processing errors into worker result errors", async () => {
+    vi.mocked(processEventBatch).mockResolvedValueOnce({
+      successes: [],
+      errors: [
+        {
+          id: "trace-event-1",
+          status: 400,
+          message: "event body is invalid",
+          error: "invalid_request",
+        },
+      ],
+    });
+    const payload = buildPayload({
+      batch: [
+        traceCreateEvent({
+          id: "trace-event-1",
+        }),
+      ],
+    });
+
+    const result = await processHighVolumeIngestionBatch(payload);
+
+    expect(result).toEqual({
+      requestId: payload.requestId,
+      chunkIndex: 0,
+      accepted: 0,
+      rejected: 1,
+      errors: [
+        {
+          id: "trace-event-1",
+          message: "invalid_request",
+        },
+      ],
+    });
+    expect(logger.warn).toHaveBeenCalledWith(
+      "High-volume ingestion chunk produced processing errors",
+      expect.objectContaining({
+        requestId: payload.requestId,
+        errors: expect.any(Array),
+      }),
+    );
+  });
+
+  it("returns zero accepted events when a chunk only contains sdk logs", async () => {
+    const payload = buildPayload({
+      batch: [
+        {
+          id: "sdk-log-event",
+          type: "sdk-log",
+          timestamp: new Date().toISOString(),
+          body: {
+            log: "debug payload",
+          },
+        },
+      ],
+    });
+
+    const result = await processHighVolumeIngestionBatch(payload);
+
+    expect(processEventBatch).not.toHaveBeenCalled();
+    expect(result).toEqual({
+      requestId: payload.requestId,
+      chunkIndex: 0,
+      accepted: 0,
+      rejected: 0,
+      errors: [],
+    });
+  });
+
+  it("does not preserve per-item rejection details for the original HTTP caller", async () => {
+    const payload = buildPayload({
+      batch: [
+        {
+          id: "bad-event",
+          type: "generation-create",
+          timestamp: "not-a-date",
+          body: {
+            id: randomUUID(),
+            traceId: randomUUID(),
+          },
+        },
+      ],
+    });
+
+    await expect(processHighVolumeIngestionBatch(payload)).rejects.toThrow(
+      "Invalid high-volume ingestion chunk",
+    );
+
+    expect(logger.warn).toHaveBeenCalledWith(
+      "Invalid events in high-volume ingestion chunk",
+      expect.objectContaining({
+        examples: [
+          expect.objectContaining({
+            id: "bad-event",
+            message: expect.any(String),
+          }),
+        ],
+      }),
+    );
+  });
+
+  it("passes score-only credentials through to processEventBatch", async () => {
+    const payload = buildPayload({
+      authCheck: {
+        validKey: true,
+        scope: {
+          projectId: randomUUID(),
+          accessLevel: "scores",
+        },
+      },
+      batch: [
+        {
+          id: "score-event-1",
+          type: "score-create",
+          timestamp: new Date().toISOString(),
+          body: {
+            traceId: randomUUID(),
+            name: "quality",
+            value: 1,
+          },
+        },
+      ],
+    });
+
+    await processHighVolumeIngestionBatch(payload);
+
+    expect(processEventBatch).toHaveBeenCalledWith(
+      [
+        expect.objectContaining({
+          type: "score-create",
+        }),
+      ],
+      payload.authCheck,
+      {
+        source: "api",
+        delay: 0,
+      },
+    );
+  });
+
+  function buildPayload(
+    overrides: Partial<HighVolumeIngestionJobPayload> = {},
+  ): HighVolumeIngestionJobPayload {
+    return {
+      requestId: randomUUID(),
+      chunkIndex: 0,
+      totalChunks: 1,
+      batch: [
+        traceCreateEvent({
+          id: "trace-event-1",
+        }),
+      ],
+      metadata: null,
+      authCheck: {
+        validKey: true,
+        scope: {
+          projectId: randomUUID(),
+          accessLevel: "project",
+        },
+      },
+      headers: {
+        sdkName: "langfuse-js",
+        sdkVersion: "3.0.0",
+      },
+      ...overrides,
+    };
+  }
+
+  function traceCreateEvent(overrides: Partial<Record<string, unknown>> = {}) {
+    return {
+      id: randomUUID(),
+      type: "trace-create",
+      timestamp: new Date().toISOString(),
+      body: {
+        id: randomUUID(),
+        name: "worker-test-trace",
+        timestamp: new Date().toISOString(),
+      },
+      ...overrides,
+    };
+  }
+});
diff --git a/worker/src/queues/__tests__/highVolumeIngestionQueue.test.ts b/worker/src/queues/__tests__/highVolumeIngestionQueue.test.ts
new file mode 100644
index 0000000000..85d5c99f56
--- /dev/null
+++ b/worker/src/queues/__tests__/highVolumeIngestionQueue.test.ts
@@ -0,0 +1,244 @@
+import { describe, expect, it, vi } from "vitest";
+import { randomUUID } from "crypto";
+import { highVolumeIngestionQueueProcessor } from "../highVolumeIngestionQueue";
+
+vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
+  const actual = await importOriginal<typeof import("@langfuse/shared/src/server")>();
+  return {
+    ...actual,
+    processEventBatch: vi.fn().mockResolvedValue({
+      successes: [{ id: "event-1", status: 201 }],
+      errors: [],
+    }),
+    traceException: vi.fn(),
+    logger: {
+      debug: vi.fn(),
+      info: vi.fn(),
+      warn: vi.fn(),
+      error: vi.fn(),
+    },
+    recordIncrement: vi.fn(),
+    recordHistogram: vi.fn(),
+  };
+});
+
+describe("highVolumeIngestionQueueProcessor", () => {
+  it("processes valid high-volume chunks", async () => {
+    const job = buildJob({
+      batch: [
+        {
+          id: "event-1",
+          type: "trace-create",
+          timestamp: new Date().toISOString(),
+          body: {
+            id: randomUUID(),
+            timestamp: new Date().toISOString(),
+          },
+        },
+      ],
+    });
+
+    await expect(highVolumeIngestionQueueProcessor(job as never)).resolves.toBeUndefined();
+  });
+
+  it("throws when a queued event is invalid", async () => {
+    const job = buildJob({
+      batch: [
+        {
+          id: "event-1",
+          type: "trace-create",
+          timestamp: "invalid-date",
+          body: {
+            id: randomUUID(),
+          },
+        },
+      ],
+    });
+
+    await expect(highVolumeIngestionQueueProcessor(job as never)).rejects.toThrow(
+      "Invalid high-volume ingestion chunk",
+    );
+  });
+
+  it("throws when the queued payload shape is invalid", async () => {
+    const job = {
+      id: "job-1",
+      data: {
+        payload: {
+          requestId: randomUUID(),
+          batch: [],
+        },
+      },
+    };
+
+    await expect(highVolumeIngestionQueueProcessor(job as never)).rejects.toThrow(
+      "Invalid high-volume ingestion queue payload",
+    );
+  });
+
+  function buildJob({ batch }: { batch: unknown[] }) {
+    return {
+      id: "job-1",
+      data: {
+        id: randomUUID(),
+        timestamp: new Date(),
+        name: "high-volume-ingestion-job",
+        payload: {
+          requestId: randomUUID(),
+          chunkIndex: 0,
+          totalChunks: 1,
+          batch,
+          metadata: null,
+          authCheck: {
+            validKey: true,
+            scope: {
+              projectId: randomUUID(),
+              accessLevel: "project",
+            },
+          },
+          headers: {
+            sdkName: "langfuse-js",
+            sdkVersion: "3.0.0",
+          },
+        },
+      },
+    };
+  }
+});
diff --git a/docs/api-reference/high-volume-ingestion.md b/docs/api-reference/high-volume-ingestion.md
new file mode 100644
index 0000000000..5d8a8a1a7b
--- /dev/null
+++ b/docs/api-reference/high-volume-ingestion.md
@@ -0,0 +1,184 @@
+# High-Volume Ingestion
+
+The high-volume ingestion endpoint accepts large SDK batches and enqueues them
+for asynchronous processing.
+
+```http
+POST /api/public/ingestion/high-volume
+Authorization: Basic <public-key:secret-key>
+Content-Type: application/json
+```
+
+## Request Body
+
+```json
+{
+  "batch": [
+    {
+      "id": "event-id",
+      "type": "trace-create",
+      "timestamp": "2024-03-01T12:00:00.000Z",
+      "body": {
+        "id": "trace-id",
+        "name": "checkout",
+        "timestamp": "2024-03-01T12:00:00.000Z"
+      }
+    }
+  ],
+  "metadata": {
+    "source": "sdk",
+    "batchId": "batch-id"
+  }
+}
+```
+
+The endpoint accepts up to 5,000 events per request. Events are split into
+worker chunks of up to 500 items.
+
+## Response Body
+
+The response uses the same shape as the standard ingestion endpoint.
+
+```json
+{
+  "requestId": "0d8240bc-04ab-41b9-98a9-8df6844f3f38",
+  "successes": [
+    {
+      "id": "event-id",
+      "status": 202
+    }
+  ],
+  "errors": []
+}
+```
+
+A `202` item status means the item has been accepted for high-volume ingestion
+processing. Storage in the traces table, observations table, scores table, or
+dataset-run tables happens asynchronously.
+
+## Error Handling
+
+Invalid envelopes are rejected synchronously. For example, requests without a
+`batch` array, empty batches, and batches larger than 5,000 items return `400`.
+
+Invalid individual events are handled asynchronously by the worker. The API
+response is emitted after the queue write succeeds.
+
+```json
+{
+  "requestId": "4ed7264c-413c-4d71-bf31-a52dcb21bb71",
+  "successes": [
+    {
+      "id": "bad-event",
+      "status": 202
+    }
+  ],
+  "errors": []
+}
+```
+
+The worker validates queued events with the normal ingestion schema. If a chunk
+contains invalid events, the worker rejects the chunk and retries it according to
+the queue retry policy.
+
+## Retry Behavior
+
+The endpoint is safe for SDK retry when the original HTTP request times out
+before receiving a response. SDKs should retry the full batch.
+
+If the response contains `successes`, SDKs should not retry those events because
+the events have already been accepted for processing.
+
+The queue retries failed chunks with exponential backoff. Chunks are retried up
+to six times before they are retained for operational inspection.
+
+## Ordering
+
+High-volume ingestion does not guarantee cross-request ordering. The endpoint
+preserves the order of items inside each queued chunk, but different chunks can
+be processed by different workers.
+
+SDKs should send causally related trace and observation events in the same batch
+when possible. The ingestion worker merges observations by trace ID and writes
+the final shape into the normal storage pipeline.
+
+## Authentication
+
+The endpoint accepts the same project ingestion credentials as
+`POST /api/public/ingestion`.
+
+Organization-level keys are rejected. Suspended projects are rejected before the
+batch is queued.
+
+## Rate Limits
+
+High-volume ingestion uses the normal project ingestion rate limit. The rate
+limit is checked before chunking and queue writes.
+
+A rate-limited request returns the same status code and response shape as the
+standard ingestion endpoint.
+
+## Observability
+
+The endpoint records:
+
+- `langfuse.ingestion.high_volume.request`
+- `langfuse.ingestion.high_volume.batch_size`
+- `langfuse.ingestion.high_volume.chunk`
+- `langfuse.ingestion.high_volume.chunk_size`
+- `langfuse.ingestion.high_volume.worker.chunk_processed`
+- `langfuse.ingestion.high_volume.worker.chunk_failed`
+- `langfuse.ingestion.high_volume.worker.processing_ms`
+
+Every queued job includes a `requestId`, `chunkIndex`, and `totalChunks`.
+
+## Example SDK Behavior
+
+```ts
+import { Langfuse } from "langfuse";
+
+const langfuse = new Langfuse({
+  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
+  secretKey: process.env.LANGFUSE_SECRET_KEY,
+  baseUrl: process.env.LANGFUSE_BASE_URL,
+  ingestionEndpoint: "/api/public/ingestion/high-volume",
+});
+
+await langfuse.batch([
+  {
+    id: "event-1",
+    type: "trace-create",
+    timestamp: new Date().toISOString(),
+    body: {
+      id: "trace-1",
+      name: "checkout",
+      timestamp: new Date().toISOString()
+    }
+  }
+]);
+```
+
+## Operational Notes
+
+High-volume ingestion is intended for trusted SDK traffic that can temporarily
+exceed the latency budget of the standard endpoint.
+
+Use the standard ingestion endpoint when the caller needs synchronous per-item
+validation failures.
+
+High-volume ingestion should not be used for one-off administrative imports,
+data repair jobs, or manual migration scripts. Those jobs should use a dedicated
+backfill worker with explicit progress tracking.
+
+## Compatibility
+
+The endpoint is additive. Existing SDKs keep using `POST /api/public/ingestion`
+until they opt into the new path.
+
+SDKs that opt in must understand that `202` means queued. It does not mean the
+event has already been written to analytical storage.
+
+## Known Limitations
+
+The initial release does not expose a public request-status endpoint. Operational
+staff can inspect queue failures and worker logs by `requestId`.
+
+If customers need durable post-acceptance status, add a request-status endpoint
+before making this the default SDK ingestion path.
diff --git a/fern/apis/server/definition/ingestion.yml b/fern/apis/server/definition/ingestion.yml
index 3e7862450a..74f09eece2 100644
--- a/fern/apis/server/definition/ingestion.yml
+++ b/fern/apis/server/definition/ingestion.yml
@@ -31,6 +31,44 @@ endpoints:
       response:
         type: IngestionResponse
 
+  highVolume:
+    docs: |
+      Accept a high-volume ingestion batch and enqueue processing asynchronously.
+      The response uses the same per-item shape as the standard ingestion endpoint,
+      but items are marked as accepted once the queue write succeeds.
+    method: POST
+    path: /public/ingestion/high-volume
+    auth: true
+    request:
+      name: HighVolumeIngestionRequest
+      body:
+        properties:
+          batch:
+            type: list<unknown>
+            docs: Up to 5,000 ingestion events.
+          metadata:
+            type: optional<map<string, unknown>>
+    response:
+      type: IngestionResponse
+
 types:
   IngestionResponse:
     properties:
       successes:
         type: list<IngestionSuccess>
       errors:
         type: list<IngestionError>
```

## Intended Flaws

### Flaw 1: Validation Moved Behind The Queue Boundary

- `type`: `backpressure_gap`
- `location`: `web/src/pages/api/public/ingestion/high-volume.ts:102-181`, `packages/shared/src/server/ingestion/processHighVolumeIngestionBatch.ts:18-65`, `worker/src/queues/highVolumeIngestionQueue.ts:14-44`
- `learner_prompt`: Which validation and authorization work moved from ingress to asynchronous processing, and why is that dangerous for a high-volume ingestion system?

Expected answer:

- `identify`: The high-volume endpoint only validates that `batch` is an array of unknown values and then enqueues raw events. Per-event schema validation, event-type authorization, timestamp/id/body validation, and SDK-log filtering happen later in the worker. Invalid events therefore enter Redis, consume queue slots, and can poison entire chunks when the worker throws.
- `impact`: A malformed SDK or abusive client can fill the high-volume queue with work that never had a chance to succeed. Because chunks can contain hundreds of events, one invalid event can make a whole chunk retry repeatedly. This burns Redis memory, worker concurrency, logs, retries, S3/ClickHouse pipeline capacity, and delays valid customer data behind garbage. The queue boundary becomes a backpressure bypass instead of a durable processing boundary.
- `fix_direction`: Keep cheap, deterministic validation at ingress. Parse every event with `createIngestionEventSchema`, enforce auth scope per event type, reject or omit invalid items before enqueue, and only enqueue normalized valid events. If the API needs lower latency, split validation into streaming/chunked validation at the edge, not delayed validation after durable acceptance.

Hints:

1. Compare the old `processEventBatch` first phase with the new API handler before it calls `queue.add`.
2. Ask what shape the worker queue is now allowed to contain.
3. The worker throws after finding invalid events, but the API has already committed the chunk to Redis.

### Flaw 2: Invalid Events Are Acknowledged As Successful Accepted Items

- `type`: `contract_mismatch`
- `location`: `web/src/pages/api/public/ingestion/high-volume.ts:183-197`, `web/src/__tests__/server/high-volume-ingestion-api.servertest.ts:51-67`, `fern/apis/server/definition/ingestion.yml:34-41`
- `learner_prompt`: Does the response preserve the ingestion API's per-item success/error contract?

Expected answer:

- `identify`: The endpoint returns `207` with `successes` for every submitted item as soon as queue writes succeed. It does this even for events that are obviously invalid, and the test explicitly expects an invalid event to return `{ status: 202 }` with no errors. The docs claim the same per-item response shape as standard ingestion, but the semantics changed from "valid item accepted" to "raw array entry queued."
- `impact`: SDKs and customers will drop data they believe was accepted. A client sending one invalid event gets a success response, the worker later rejects the event, and there is no request status API or rejected-item response for the client to recover. This creates silent data loss and makes debugging ingestion failures much harder because the failure is decoupled from the request that caused it.
- `fix_direction`: Preserve per-item 207 semantics. Return item-level `400/401` errors for rejected events in the original response. For async accepted events, use a distinct status such as `202` only for validated events, and include a durable ingestion request ID if later processing status can be queried. Documentation must distinguish "accepted for processing" from "stored in ClickHouse."

Hints:

1. Look at how `aggregateBatchResult` reports validation failures in the standard endpoint.
2. Find what the new route returns for an event with `timestamp: "not-a-date"`.
3. A queue write is not the same product contract as an accepted ingestion event.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that raw event validation moved from the API boundary to the worker and explain why this makes invalid traffic durable queued work. Answers that only say "the worker can fail" are incomplete without the queue/backpressure angle.

For flaw 2, a correct answer must identify that the public response now marks invalid events as accepted successes. Answers that only ask for "better logging" miss the client data-loss contract.

### Product-Level Change

The PR tries to add a burst-friendly ingestion endpoint. That is a reasonable product goal: high-volume SDKs should not wait on all downstream S3 and queue fan-out work. But ingestion endpoints are not only performance surfaces. They are also acceptance contracts for customer telemetry.

### Changed Contracts

- API contract: `POST /api/public/ingestion/high-volume` reuses the standard ingestion response shape.
- Validation contract: per-event schema and auth checks move from request time to worker time.
- Queue contract: raw untrusted user payloads become durable queue payloads.
- Retry contract: invalid chunks can be retried by BullMQ even though they are permanent bad input.
- Client contract: SDKs infer accepted data from `successes`.

### Failure Modes

The obvious failure mode is a malformed SDK version sending thousands of invalid events. The new endpoint accepts them, chunks them, and queues them. Workers repeatedly reject the chunks. Valid customers now wait behind invalid jobs.

The quieter failure mode is worse: clients see `207` with every item in `successes`, then the worker drops or retries invalid events later. The customer has no synchronous error, no rejected item IDs, and no way to resend only the bad rows.

### Reviewer Thought Process

A strong reviewer starts by drawing the ingestion state machine: received, validated, authorized, durably accepted, processed, written. Then they ask which state the API response represents. In the old path, `successes` meant the event passed validation and was accepted for ingestion. In the new path, `successes` means the raw item was put in Redis.

The reviewer should also inspect what crosses the queue boundary. Queues are for durable valid commands, not for deferring cheap deterministic rejection of bad input.

### Better Implementation Direction

Keep the high-volume feature, but make the boundary honest:

- Validate and authorize every event before enqueue.
- Return item-level errors for invalid/rejected events.
- Enqueue only normalized valid events, grouped by entity/sharding key.
- Use deterministic chunk/request IDs and metrics for rejected count vs accepted count.
- If downstream processing is async, expose a separate request-status API for post-acceptance processing failures.
- Avoid retrying permanent validation failures in workers.

## Why This Case Exists

AI-generated ingestion code often improves happy-path latency by moving work "later." This exercise trains the reviewer to ask whether that moved work is expensive downstream processing or cheap contract validation. Great engineers protect queues from bad input and protect clients from false acceptance.
