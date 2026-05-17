# TS-091: Langfuse Multi-Region Trace Ingestion And Replication

## Metadata

- `id`: TS-091
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: public ingestion API, region routing, event identity, ingestion queues, S3 event storage, replication workers, trace read model, public trace API, rollout docs, multi-region tests
- `mode`: synthetic_degraded
- `difficulty`: 10
- `target_diff_lines`: 3000
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about multi-region tradeoffs, ordering, consistency, and rollout without reducing credit.

## PR Description Shown To Learner

This PR adds multi-region trace ingestion to Langfuse.

Today public ingestion accepts events in one deployment region, uploads grouped trace/observation payloads to S3, enqueues ingestion work by `projectId-eventBodyId`, and lets workers merge/write trace state into ClickHouse. This PR introduces a region-aware ingestion router so SDKs can write to the closest region. It also adds replication jobs that copy accepted trace events to a project's home region and updates the trace read API to read from both local and replicated stores.

The PR claims to improve ingestion latency for global customers while preserving existing trace IDs, SDK response semantics, and the public trace read API.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `processEventBatch` validates each event, checks event-type authorization, sorts events, groups by `eventBodyId`, uploads one S3 object per grouped entity, and enqueues ingestion jobs using the sharding key `projectId-eventBodyId`.
- The ingestion worker downloads event files for the entity and calls `IngestionService.mergeAndWrite`, which owns trace/observation merge semantics and writes the final product state.
- The worker uses a Redis recently-processed key built from `projectId`, event type, event body ID, and file key to avoid fast duplicate processing.
- S3 file paths are scoped by project, ClickHouse entity type, event body ID, and file key.
- Trace reads such as `getTraceById` query ClickHouse for one project and trace ID, ordering by the newest event timestamp to pick the current trace view.
- Public trace reads fetch trace, observations, scores, and cost/latency data from separate queries that assume a coherent trace timestamp and project-scoped read model.
- Secondary ingestion queues exist for S3 slowdown routing, but they are not a cross-region consistency mechanism.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/shared/src/server/regions/ingestionRegionTypes.ts`
- `packages/shared/src/server/regions/regionRouter.ts`
- `packages/shared/src/server/regions/regionalEventIdentity.ts`
- `packages/shared/src/server/regions/processRegionalEventBatch.ts`
- `packages/shared/src/server/regions/regionalTraceReadModel.ts`
- `packages/shared/src/server/regions/regionalReplicationWatermarks.ts`
- `packages/shared/src/server/redis/regionalIngestionQueue.ts`
- `packages/shared/src/server/redis/traceReplicationQueue.ts`
- `packages/shared/src/server/queues.ts`
- `packages/shared/src/server/index.ts`
- `web/src/pages/api/public/ingestion.ts`
- `web/src/pages/api/public/traces/[traceId].ts`
- `worker/src/queues/regionalIngestionQueue.ts`
- `worker/src/queues/traceReplicationQueue.ts`
- `worker/src/queues/workerManager.ts`
- `web/src/__tests__/server/regional-ingestion-api.servertest.ts`
- `packages/shared/src/server/regions/__tests__/regionalEventIdentity.test.ts`
- `worker/src/queues/__tests__/traceReplicationQueue.test.ts`
- `packages/shared/src/server/regions/__tests__/regionalTraceReadModel.test.ts`
- `docs/ingestion/multi-region-ingestion.md`
- `docs/ingestion/regional-consistency-contract.md`
- `docs/ingestion/multi-region-deletions.md`
- `docs/ingestion/multi-region-rollout.md`

The line references below use synthetic PR line numbers. This is the first capstone case: the learner must review a product-level distributed-systems change, not just a local bug.

## Diff

```diff
diff --git a/packages/shared/src/server/regions/ingestionRegionTypes.ts b/packages/shared/src/server/regions/ingestionRegionTypes.ts
new file mode 100644
index 0000000000..650e97c225
--- /dev/null
+++ b/packages/shared/src/server/regions/ingestionRegionTypes.ts
@@ -0,0 +1,284 @@
+import { z } from "zod";
+
+export const IngestionRegion = z.enum(["us", "eu", "ap"]);
+export type IngestionRegion = z.infer<typeof IngestionRegion>;
+
+export const RegionPreference = z.enum([
+  "nearest",
+  "home",
+  "header",
+  "project-default",
+]);
+export type RegionPreference = z.infer<typeof RegionPreference>;
+
+export const RegionRoutingDecision = z.object({
+  projectId: z.string(),
+  homeRegion: IngestionRegion,
+  writeRegion: IngestionRegion,
+  readRegion: IngestionRegion,
+  preference: RegionPreference,
+  reason: z.string(),
+  replicateToHome: z.boolean(),
+});
+export type RegionRoutingDecision = z.infer<typeof RegionRoutingDecision>;
+
+export const RegionalEventEnvelope = z.object({
+  regionalEventId: z.string(),
+  originalEventId: z.string(),
+  projectId: z.string(),
+  traceId: z.string(),
+  eventBodyId: z.string(),
+  eventType: z.string(),
+  sourceRegion: IngestionRegion,
+  targetRegion: IngestionRegion,
+  receivedAt: z.coerce.date(),
+  regionSequence: z.number().int().nonnegative(),
+  payloadFileKey: z.string(),
+  payloadBucketPath: z.string(),
+  payloadHash: z.string().optional(),
+});
+export type RegionalEventEnvelope = z.infer<typeof RegionalEventEnvelope>;
+
+export const RegionalIngestionJobPayload = z.object({
+  decision: RegionRoutingDecision,
+  events: z.array(RegionalEventEnvelope).min(1),
+  authCheck: z.object({
+    validKey: z.literal(true),
+    scope: z.object({
+      projectId: z.string(),
+      accessLevel: z.enum(["project", "scores"]),
+      orgId: z.string().optional(),
+    }),
+  }),
+});
+export type RegionalIngestionJobPayload = z.infer<
+  typeof RegionalIngestionJobPayload
+>;
+
+export const TraceReplicationJobPayload = z.object({
+  projectId: z.string(),
+  traceId: z.string(),
+  sourceRegion: IngestionRegion,
+  targetRegion: IngestionRegion,
+  regionalEventIds: z.array(z.string()),
+  payloadFileKeys: z.array(z.string()),
+  requestedAt: z.coerce.date(),
+  reason: z.enum(["home-replication", "manual-replay", "read-repair"]),
+});
+export type TraceReplicationJobPayload = z.infer<
+  typeof TraceReplicationJobPayload
+>;
+
+export const RegionTraceReadOptions = z.object({
+  projectId: z.string(),
+  traceId: z.string(),
+  preferredRegion: IngestionRegion.optional(),
+  includeReplicated: z.boolean().default(true),
+  requireConsistentRead: z.boolean().default(false),
+  fromTimestamp: z.coerce.date().optional(),
+});
+export type RegionTraceReadOptions = z.infer<typeof RegionTraceReadOptions>;
+
+export const RegionTraceReplicaState = z.object({
+  projectId: z.string(),
+  traceId: z.string(),
+  region: IngestionRegion,
+  replicatedFrom: IngestionRegion.optional(),
+  lastRegionalEventId: z.string().optional(),
+  lastRegionSequence: z.number().optional(),
+  replicaWatermark: z.coerce.date().optional(),
+  updatedAt: z.coerce.date(),
+});
+export type RegionTraceReplicaState = z.infer<
+  typeof RegionTraceReplicaState
+>;
diff --git a/packages/shared/src/server/regions/regionalEventIdentity.ts b/packages/shared/src/server/regions/regionalEventIdentity.ts
new file mode 100644
index 0000000000..4decc1fddf
--- /dev/null
+++ b/packages/shared/src/server/regions/regionalEventIdentity.ts
@@ -0,0 +1,252 @@
+import { createHash, randomUUID } from "crypto";
+import {
+  IngestionRegion,
+  RegionalEventEnvelope,
+} from "./ingestionRegionTypes";
+
+export const createRegionalEventIdentity = ({
+  projectId,
+  traceId,
+  eventBodyId,
+  eventType,
+  originalEventId,
+  sourceRegion,
+  targetRegion,
+  payloadFileKey,
+  payloadBucketPath,
+  body,
+  index,
+}: {
+  projectId: string;
+  traceId: string;
+  eventBodyId: string;
+  eventType: string;
+  originalEventId: string;
+  sourceRegion: IngestionRegion;
+  targetRegion: IngestionRegion;
+  payloadFileKey: string;
+  payloadBucketPath: string;
+  body: unknown;
+  index: number;
+}): RegionalEventEnvelope => {
+  const receivedAt = new Date();
+  const regionSequence = Date.now() + index;
+  const regionalEventId = `${sourceRegion}-${regionSequence}-${randomUUID()}`;
+
+  return {
+    regionalEventId,
+    originalEventId,
+    projectId,
+    traceId,
+    eventBodyId,
+    eventType,
+    sourceRegion,
+    targetRegion,
+    receivedAt,
+    regionSequence,
+    payloadFileKey,
+    payloadBucketPath,
+    payloadHash: hashPayload(body),
+  };
+};
+
+export const createReplicationDedupeKey = ({
+  projectId,
+  targetRegion,
+  regionalEventId,
+}: {
+  projectId: string;
+  targetRegion: IngestionRegion;
+  regionalEventId: string;
+}) => {
+  return `langfuse:regional-replication:${projectId}:${targetRegion}:${regionalEventId}`;
+};
+
+export const createRegionalSeenKey = ({
+  projectId,
+  sourceRegion,
+  eventBodyId,
+  regionalEventId,
+}: {
+  projectId: string;
+  sourceRegion: IngestionRegion;
+  eventBodyId: string;
+  regionalEventId: string;
+}) => {
+  return `langfuse:regional-seen:${projectId}:${sourceRegion}:${eventBodyId}:${regionalEventId}`;
+};
+
+export const createTraceReplicaStateKey = ({
+  projectId,
+  traceId,
+  region,
+}: {
+  projectId: string;
+  traceId: string;
+  region: IngestionRegion;
+}) => {
+  return `langfuse:trace-replica-state:${projectId}:${traceId}:${region}`;
+};
+
+const hashPayload = (body: unknown) => {
+  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
+};
diff --git a/packages/shared/src/server/regions/regionRouter.ts b/packages/shared/src/server/regions/regionRouter.ts
new file mode 100644
index 0000000000..898c31ab62
--- /dev/null
+++ b/packages/shared/src/server/regions/regionRouter.ts
@@ -0,0 +1,378 @@
+import { z } from "zod";
+import { prisma } from "@langfuse/shared/src/db";
+import { logger } from "../logger";
+import {
+  IngestionRegion,
+  RegionRoutingDecision,
+} from "./ingestionRegionTypes";
+
+const RegionHeader = z
+  .string()
+  .trim()
+  .toLowerCase()
+  .pipe(IngestionRegion)
+  .optional();
+
+export type ResolveRegionInput = {
+  projectId: string;
+  headers: Record<string, string | string[] | undefined>;
+  clientIp?: string | null;
+};
+
+export class RegionRouter {
+  async resolve(input: ResolveRegionInput): Promise<RegionRoutingDecision> {
+    const project = await prisma.project.findUnique({
+      where: { id: input.projectId },
+      select: {
+        id: true,
+        cloudConfig: true,
+      },
+    });
+
+    const homeRegion = this.getHomeRegion(project?.cloudConfig);
+    const headerRegion = RegionHeader.safeParse(
+      firstHeader(input.headers["x-langfuse-region"]),
+    );
+    const nearestRegion = this.getNearestRegion(input.clientIp);
+
+    if (headerRegion.success && headerRegion.data) {
+      return {
+        projectId: input.projectId,
+        homeRegion,
+        writeRegion: headerRegion.data,
+        readRegion: headerRegion.data,
+        preference: "header",
+        reason: "x-langfuse-region header",
+        replicateToHome: headerRegion.data !== homeRegion,
+      };
+    }
+
+    if (nearestRegion) {
+      return {
+        projectId: input.projectId,
+        homeRegion,
+        writeRegion: nearestRegion,
+        readRegion: nearestRegion,
+        preference: "nearest",
+        reason: "geo lookup",
+        replicateToHome: nearestRegion !== homeRegion,
+      };
+    }
+
+    return {
+      projectId: input.projectId,
+      homeRegion,
+      writeRegion: homeRegion,
+      readRegion: homeRegion,
+      preference: "project-default",
+      reason: "project home region",
+      replicateToHome: false,
+    };
+  }
+
+  getHomeRegion(cloudConfig: unknown): IngestionRegion {
+    if (
+      cloudConfig &&
+      typeof cloudConfig === "object" &&
+      "homeRegion" in cloudConfig
+    ) {
+      const parsed = IngestionRegion.safeParse(
+        (cloudConfig as { homeRegion?: unknown }).homeRegion,
+      );
+      if (parsed.success) return parsed.data;
+    }
+
+    return "us";
+  }
+
+  getNearestRegion(clientIp?: string | null): IngestionRegion | null {
+    if (!clientIp) return null;
+    if (clientIp.startsWith("2.")) return "eu";
+    if (clientIp.startsWith("14.")) return "ap";
+    if (clientIp.startsWith("27.")) return "ap";
+    return "us";
+  }
+
+  logDecision(decision: RegionRoutingDecision) {
+    logger.debug("Resolved ingestion region", {
+      projectId: decision.projectId,
+      homeRegion: decision.homeRegion,
+      writeRegion: decision.writeRegion,
+      preference: decision.preference,
+      replicateToHome: decision.replicateToHome,
+    });
+  }
+}
+
+const firstHeader = (value: string | string[] | undefined) => {
+  return Array.isArray(value) ? value[0] : value;
+};
diff --git a/packages/shared/src/server/redis/regionalIngestionQueue.ts b/packages/shared/src/server/redis/regionalIngestionQueue.ts
new file mode 100644
index 0000000000..1f3d7db744
--- /dev/null
+++ b/packages/shared/src/server/redis/regionalIngestionQueue.ts
@@ -0,0 +1,284 @@
+import { Queue } from "bullmq";
+import { QueueName, TQueueJobTypes } from "../queues";
+import {
+  createNewRedisInstance,
+  getQueuePrefix,
+  redisQueueRetryOptions,
+} from "./redis";
+import { logger } from "../logger";
+import { getShardIndex } from "./sharding";
+import { env } from "../../env";
+import { IngestionRegion } from "../regions/ingestionRegionTypes";
+
+export class RegionalIngestionQueue {
+  private static instances = new Map<
+    string,
+    Queue<TQueueJobTypes[QueueName.RegionalIngestionQueue]> | null
+  >();
+
+  public static getShardNames(region: IngestionRegion) {
+    return Array.from(
+      { length: env.LANGFUSE_INGESTION_QUEUE_SHARD_COUNT },
+      (_, i) =>
+        `${QueueName.RegionalIngestionQueue}-${region}${i > 0 ? `-${i}` : ""}`,
+    );
+  }
+
+  public static getInstance({
+    region,
+    shardingKey,
+    shardName,
+  }: {
+    region: IngestionRegion;
+    shardingKey?: string;
+    shardName?: string;
+  }): Queue<TQueueJobTypes[QueueName.RegionalIngestionQueue]> | null {
+    const shardIndex =
+      getShardIndexFromRegionalShardName(region, shardName) ??
+      (env.REDIS_CLUSTER_ENABLED === "true" && shardingKey
+        ? getShardIndex(shardingKey, env.LANGFUSE_INGESTION_QUEUE_SHARD_COUNT)
+        : 0);
+
+    const queueKey = `${region}:${shardIndex}`;
+    if (RegionalIngestionQueue.instances.has(queueKey)) {
+      return RegionalIngestionQueue.instances.get(queueKey) || null;
+    }
+
+    const connection = createNewRedisInstance({
+      enableOfflineQueue: false,
+      ...redisQueueRetryOptions,
+    });
+
+    const name = `${QueueName.RegionalIngestionQueue}-${region}${shardIndex > 0 ? `-${shardIndex}` : ""}`;
+    const queue = connection
+      ? new Queue<TQueueJobTypes[QueueName.RegionalIngestionQueue]>(name, {
+          connection,
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
+    queue?.on("error", (err) => {
+      logger.error(`RegionalIngestionQueue ${queueKey} error`, err);
+    });
+
+    RegionalIngestionQueue.instances.set(queueKey, queue);
+    return queue;
+  }
+}
+
+function getShardIndexFromRegionalShardName(
+  region: IngestionRegion,
+  shardName: string | undefined,
+) {
+  if (!shardName) return null;
+  const prefix = `${QueueName.RegionalIngestionQueue}-${region}`;
+  if (shardName === prefix) return 0;
+  if (!shardName.startsWith(`${prefix}-`)) return null;
+  const shardIndex = parseInt(shardName.replace(`${prefix}-`, ""), 10);
+  return Number.isNaN(shardIndex) ? null : shardIndex;
+}
diff --git a/packages/shared/src/server/redis/traceReplicationQueue.ts b/packages/shared/src/server/redis/traceReplicationQueue.ts
new file mode 100644
index 0000000000..ce5e532310
--- /dev/null
+++ b/packages/shared/src/server/redis/traceReplicationQueue.ts
@@ -0,0 +1,256 @@
+import { Queue } from "bullmq";
+import { QueueName, TQueueJobTypes } from "../queues";
+import {
+  createNewRedisInstance,
+  getQueuePrefix,
+  redisQueueRetryOptions,
+} from "./redis";
+import { logger } from "../logger";
+import { getShardIndex } from "./sharding";
+import { env } from "../../env";
+import { IngestionRegion } from "../regions/ingestionRegionTypes";
+
+export class TraceReplicationQueue {
+  private static instances = new Map<
+    number,
+    Queue<TQueueJobTypes[QueueName.TraceReplicationQueue]> | null
+  >();
+
+  public static getShardNames() {
+    return Array.from(
+      { length: env.LANGFUSE_INGESTION_QUEUE_SHARD_COUNT },
+      (_, i) =>
+        `${QueueName.TraceReplicationQueue}${i > 0 ? `-${i}` : ""}`,
+    );
+  }
+
+  public static getInstance({
+    shardingKey,
+    shardName,
+  }: {
+    shardingKey?: string;
+    shardName?: string;
+  } = {}): Queue<TQueueJobTypes[QueueName.TraceReplicationQueue]> | null {
+    const shardIndex =
+      getShardIndexFromShardName(shardName) ??
+      (env.REDIS_CLUSTER_ENABLED === "true" && shardingKey
+        ? getShardIndex(shardingKey, env.LANGFUSE_INGESTION_QUEUE_SHARD_COUNT)
+        : 0);
+
+    if (TraceReplicationQueue.instances.has(shardIndex)) {
+      return TraceReplicationQueue.instances.get(shardIndex) || null;
+    }
+
+    const connection = createNewRedisInstance({
+      enableOfflineQueue: false,
+      ...redisQueueRetryOptions,
+    });
+
+    const name = `${QueueName.TraceReplicationQueue}${shardIndex > 0 ? `-${shardIndex}` : ""}`;
+    const queue = connection
+      ? new Queue<TQueueJobTypes[QueueName.TraceReplicationQueue]>(name, {
+          connection,
+          prefix: getQueuePrefix(name),
+          defaultJobOptions: {
+            removeOnComplete: true,
+            removeOnFail: 250_000,
+            attempts: 10,
+            backoff: {
+              type: "exponential",
+              delay: 10_000,
+            },
+          },
+        })
+      : null;
+
+    queue?.on("error", (err) => {
+      logger.error(`TraceReplicationQueue shard ${shardIndex} error`, err);
+    });
+
+    TraceReplicationQueue.instances.set(shardIndex, queue);
+    return queue;
+  }
+}
+
+function getShardIndexFromShardName(shardName: string | undefined) {
+  if (!shardName) return null;
+  const shardIndex =
+    shardName === QueueName.TraceReplicationQueue
+      ? 0
+      : parseInt(
+          shardName.replace(`${QueueName.TraceReplicationQueue}-`, ""),
+          10,
+        );
+  return Number.isNaN(shardIndex) ? null : shardIndex;
+}
+
+export const replicationShardKey = ({
+  projectId,
+  traceId,
+  targetRegion,
+}: {
+  projectId: string;
+  traceId: string;
+  targetRegion: IngestionRegion;
+}) => `${projectId}-${traceId}-${targetRegion}`;
diff --git a/packages/shared/src/server/regions/processRegionalEventBatch.ts b/packages/shared/src/server/regions/processRegionalEventBatch.ts
new file mode 100644
index 0000000000..cfca995c19
--- /dev/null
+++ b/packages/shared/src/server/regions/processRegionalEventBatch.ts
@@ -0,0 +1,640 @@
+import { randomUUID } from "crypto";
+import { z } from "zod";
+import { env } from "../../env";
+import {
+  InvalidRequestError,
+  UnauthorizedError,
+} from "../../errors";
+import { AuthHeaderValidVerificationResultIngestion } from "../auth/types";
+import { getClickhouseEntityType } from "../clickhouse/schemaUtils";
+import {
+  getCurrentSpan,
+  instrumentAsync,
+  recordDistribution,
+  recordIncrement,
+} from "../instrumentation";
+import { logger } from "../logger";
+import { QueueJobs } from "../queues";
+import { RegionalIngestionQueue } from "../redis/regionalIngestionQueue";
+import {
+  replicationShardKey,
+  TraceReplicationQueue,
+} from "../redis/traceReplicationQueue";
+import {
+  StorageService,
+  StorageServiceFactory,
+} from "../services/StorageService";
+import {
+  createIngestionEventSchema,
+  eventTypes,
+  IngestionEventType,
+} from "../ingestion/types";
+import { isTraceIdInSample } from "../ingestion/sampling";
+import {
+  IngestionRegion,
+  RegionRoutingDecision,
+} from "./ingestionRegionTypes";
+import { createRegionalEventIdentity } from "./regionalEventIdentity";
+
+let storageByRegion = new Map<IngestionRegion, StorageService>();
+
+const getRegionalStorageClient = (region: IngestionRegion) => {
+  const existing = storageByRegion.get(region);
+  if (existing) return existing;
+
+  const storage = StorageServiceFactory.getInstance({
+    bucketName: getBucketForRegion(region),
+    accessKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID,
+    secretAccessKey: env.LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY,
+    endpoint: getEndpointForRegion(region),
+    region,
+    forcePathStyle: env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
+    awsSse: env.LANGFUSE_S3_EVENT_UPLOAD_SSE,
+    awsSseKmsKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_SSE_KMS_KEY_ID,
+  });
+  storageByRegion.set(region, storage);
+  return storage;
+};
+
+export const processRegionalEventBatch = async ({
+  input,
+  authCheck,
+  decision,
+  delay = null,
+}: {
+  input: unknown[];
+  authCheck: AuthHeaderValidVerificationResultIngestion;
+  decision: RegionRoutingDecision;
+  delay?: number | null;
+}): Promise<{
+  successes: { id: string; status: number; region: IngestionRegion }[];
+  errors: { id: string; status: number; message?: string; error?: string }[];
+}> => {
+  if (input.length === 0) {
+    return { successes: [], errors: [] };
+  }
+
+  const span = getCurrentSpan();
+  span?.setAttribute("langfuse.ingestion.region.write", decision.writeRegion);
+  span?.setAttribute("langfuse.ingestion.region.home", decision.homeRegion);
+  recordIncrement("langfuse.regional_ingestion.event", input.length, {
+    writeRegion: decision.writeRegion,
+  });
+
+  if (!authCheck.scope.projectId) {
+    throw new UnauthorizedError("Missing project ID");
+  }
+
+  const validationErrors: { id: string; error: unknown }[] = [];
+  const authenticationErrors: { id: string; error: unknown }[] = [];
+  const ingestionSchema = createIngestionEventSchema(false);
+  const batch: z.infer<typeof ingestionSchema>[] = input
+    .flatMap((event) => {
+      const parsed = ingestionSchema.safeParse(event);
+      if (!parsed.success) {
+        validationErrors.push({
+          id: inferEventId(event),
+          error: new InvalidRequestError(parsed.error.message),
+        });
+        return [];
+      }
+
+      if (!isAuthorized(parsed.data, authCheck)) {
+        authenticationErrors.push({
+          id: parsed.data.id,
+          error: new UnauthorizedError("Access Scope Denied"),
+        });
+        return [];
+      }
+
+      if (parsed.data.type === eventTypes.SDK_LOG) {
+        logger.info("SDK Log Event", { event: parsed.data });
+        return [];
+      }
+
+      return [parsed.data];
+    })
+    .sort((a, b) => {
+      const aTs = new Date(a.timestamp).getTime();
+      const bTs = new Date(b.timestamp).getTime();
+      return aTs - bTs;
+    });
+
+  const grouped = groupByEntity(batch);
+  const regionalEnvelopes: Record<string, ReturnType<typeof createRegionalEventIdentity>[]> = {};
+  let uploadErrored = false;
+
+  await instrumentAsync({ name: "regional-s3-upload-events" }, async () => {
+    const results = await Promise.allSettled(
+      Object.values(grouped).map(async (group) => {
+        const fileKey = `${decision.writeRegion}-${randomUUID()}`;
+        const entityType = getClickhouseEntityType(group.type);
+        const bucketPath = `${env.LANGFUSE_S3_EVENT_UPLOAD_PREFIX}${authCheck.scope.projectId}/${decision.writeRegion}/${entityType}/${group.eventBodyId}/${fileKey}.json`;
+
+        await getRegionalStorageClient(decision.writeRegion).uploadJson(
+          bucketPath,
+          group.data,
+        );
+
+        regionalEnvelopes[group.eventBodyId] = group.data.map((event, index) =>
+          createRegionalEventIdentity({
+            projectId: authCheck.scope.projectId!,
+            traceId: inferTraceId(event),
+            eventBodyId: group.eventBodyId,
+            eventType: group.type,
+            originalEventId: event.id,
+            sourceRegion: decision.writeRegion,
+            targetRegion: decision.homeRegion,
+            payloadFileKey: fileKey,
+            payloadBucketPath: bucketPath,
+            body: event.body,
+            index,
+          }),
+        );
+      }),
+    );
+
+    for (const result of results) {
+      if (result.status === "rejected") {
+        uploadErrored = true;
+        logger.error("Failed to upload regional event group", {
+          error: result.reason,
+          writeRegion: decision.writeRegion,
+        });
+      }
+    }
+  });
+
+  if (uploadErrored) {
+    throw new Error("Failed to upload regional ingestion events");
+  }
+
+  await Promise.all(
+    Object.values(grouped).map(async (group) => {
+      const envelopes = regionalEnvelopes[group.eventBodyId] ?? [];
+      const shardingKey = `${authCheck.scope.projectId}-${decision.writeRegion}-${group.eventBodyId}`;
+      const queue = RegionalIngestionQueue.getInstance({
+        region: decision.writeRegion,
+        shardingKey,
+      });
+
+      const { isSampled } = isTraceIdInSample({
+        projectId: authCheck.scope.projectId,
+        event: group.data[0],
+      });
+      if (!isSampled) {
+        recordIncrement("langfuse.regional_ingestion.sampling", group.data.length, {
+          decision: "out",
+          writeRegion: decision.writeRegion,
+        });
+        return;
+      }
+
+      if (!queue) {
+        throw new Error("Failed to instantiate regional ingestion queue");
+      }
+
+      await queue.add(
+        QueueJobs.RegionalIngestionJob,
+        {
+          id: randomUUID(),
+          timestamp: new Date(),
+          name: QueueJobs.RegionalIngestionJob as const,
+          payload: {
+            decision,
+            events: envelopes,
+            authCheck: authCheck as {
+              validKey: true;
+              scope: {
+                projectId: string;
+                accessLevel: "project" | "scores";
+              };
+            },
+          },
+        },
+        { delay: getDelay(delay) },
+      );
+
+      if (decision.replicateToHome) {
+        const replicationQueue = TraceReplicationQueue.getInstance({
+          shardingKey: replicationShardKey({
+            projectId: authCheck.scope.projectId!,
+            traceId: inferTraceId(group.data[0]),
+            targetRegion: decision.homeRegion,
+          }),
+        });
+
+        await replicationQueue?.add(QueueJobs.TraceReplicationJob, {
+          id: randomUUID(),
+          timestamp: new Date(),
+          name: QueueJobs.TraceReplicationJob as const,
+          payload: {
+            projectId: authCheck.scope.projectId!,
+            traceId: inferTraceId(group.data[0]),
+            sourceRegion: decision.writeRegion,
+            targetRegion: decision.homeRegion,
+            regionalEventIds: envelopes.map((event) => event.regionalEventId),
+            payloadFileKeys: envelopes.map((event) => event.payloadFileKey),
+            requestedAt: new Date(),
+            reason: "home-replication",
+          },
+        });
+      }
+    }),
+  );
+
+  recordDistribution("langfuse.regional_ingestion.batch_size", batch.length, {
+    writeRegion: decision.writeRegion,
+    homeRegion: decision.homeRegion,
+  });
+
+  return {
+    successes: batch.map((event) => ({
+      id: event.id,
+      status: 202,
+      region: decision.writeRegion,
+    })),
+    errors: [...validationErrors, ...authenticationErrors].map(({ id, error }) => ({
+      id,
+      status: error instanceof UnauthorizedError ? 401 : 400,
+      message: error instanceof Error ? error.message : "Unknown error",
+      error: error instanceof Error ? error.name : "UnknownError",
+    })),
+  };
+};
+
+const groupByEntity = (batch: IngestionEventType[]) => {
+  return batch.reduce(
+    (
+      acc: Record<
+        string,
+        { data: IngestionEventType[]; eventBodyId: string; type: string }
+      >,
+      event,
+    ) => {
+      if (!event.body?.id) return acc;
+      const entityType = getClickhouseEntityType(event.type);
+      const key = `${entityType}-${event.body.id}`;
+      if (!acc[key]) {
+        acc[key] = { data: [], eventBodyId: event.body.id, type: event.type };
+      }
+      acc[key].data.push(event);
+      return acc;
+    },
+    {},
+  );
+};
+
+const inferTraceId = (event: IngestionEventType) => {
+  if (event.type === eventTypes.TRACE_CREATE) return event.body.id;
+  if ("traceId" in event.body && typeof event.body.traceId === "string") {
+    return event.body.traceId;
+  }
+  return event.body.id;
+};
+
+const inferEventId = (event: unknown) => {
+  if (typeof event === "object" && event && "id" in event) {
+    const id = (event as { id?: unknown }).id;
+    return typeof id === "string" ? id : "unknown";
+  }
+  return "unknown";
+};
+
+const isAuthorized = (
+  event: IngestionEventType,
+  authScope: AuthHeaderValidVerificationResultIngestion,
+) => {
+  if (authScope.scope.accessLevel !== "scores") return true;
+  return event.type === eventTypes.SCORE_CREATE;
+};
+
+const getDelay = (delay: number | null) => delay ?? 0;
+
+const getBucketForRegion = (region: IngestionRegion) => {
+  if (region === "eu") return env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET_EU;
+  if (region === "ap") return env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET_AP;
+  return env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET;
+};
+
+const getEndpointForRegion = (region: IngestionRegion) => {
+  if (region === "eu") return env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT_EU;
+  if (region === "ap") return env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT_AP;
+  return env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT;
+};
diff --git a/packages/shared/src/server/regions/regionalTraceReadModel.ts b/packages/shared/src/server/regions/regionalTraceReadModel.ts
new file mode 100644
index 0000000000..6b64b0e0d4
--- /dev/null
+++ b/packages/shared/src/server/regions/regionalTraceReadModel.ts
@@ -0,0 +1,552 @@
+import {
+  getObservationsForTrace,
+  getScoresForTraces,
+  getTraceById,
+} from "../repositories";
+import { logger } from "../logger";
+import {
+  IngestionRegion,
+  RegionTraceReadOptions,
+} from "./ingestionRegionTypes";
+import { RegionRouter } from "./regionRouter";
+
+export type RegionAwareTrace = {
+  trace: Awaited<ReturnType<typeof getTraceById>> | null;
+  observations: Awaited<ReturnType<typeof getObservationsForTrace>>;
+  scores: Awaited<ReturnType<typeof getScoresForTraces>>;
+  sourceRegion: IngestionRegion | "mixed" | null;
+  replicaLagMs: number | null;
+  consistency: "local" | "replicated" | "mixed" | "not-found";
+};
+
+export const getRegionAwareTrace = async (
+  input: RegionTraceReadOptions,
+): Promise<RegionAwareTrace> => {
+  const parsed = RegionTraceReadOptions.parse(input);
+  const router = new RegionRouter();
+  const homeRegion = router.getHomeRegion(await getProjectCloudConfig(parsed.projectId));
+  const preferredRegion = parsed.preferredRegion ?? homeRegion;
+  const candidateRegions = parsed.includeReplicated
+    ? uniqueRegions([preferredRegion, homeRegion, "us", "eu", "ap"])
+    : [preferredRegion];
+
+  const candidates = await Promise.all(
+    candidateRegions.map(async (region) => {
+      const trace = await getTraceById({
+        traceId: parsed.traceId,
+        projectId: parsed.projectId,
+        fromTimestamp: parsed.fromTimestamp,
+        clickhouseFeatureTag: `trace-read-${region}`,
+        preferredClickhouseService:
+          region === preferredRegion ? "ReadOnly" : "ReadOnly",
+      });
+
+      if (!trace) {
+        return {
+          region,
+          trace: null,
+          observations: [],
+          scores: [],
+        };
+      }
+
+      const [observations, scores] = await Promise.all([
+        getObservationsForTrace({
+          traceId: parsed.traceId,
+          projectId: parsed.projectId,
+          timestamp: trace.timestamp,
+          preferredClickhouseService: "ReadOnly",
+        }),
+        getScoresForTraces({
+          projectId: parsed.projectId,
+          traceIds: [parsed.traceId],
+          timestamp: trace.timestamp,
+          preferredClickhouseService: "ReadOnly",
+        }),
+      ]);
+
+      return {
+        region,
+        trace,
+        observations,
+        scores,
+      };
+    }),
+  );
+
+  const found = candidates.filter((candidate) => candidate.trace);
+  if (found.length === 0) {
+    return {
+      trace: null,
+      observations: [],
+      scores: [],
+      sourceRegion: null,
+      replicaLagMs: null,
+      consistency: "not-found",
+    };
+  }
+
+  const local = found.find((candidate) => candidate.region === preferredRegion);
+  const newest = [...found].sort((a, b) => {
+    const aUpdated = a.trace?.updatedAt?.getTime?.() ?? 0;
+    const bUpdated = b.trace?.updatedAt?.getTime?.() ?? 0;
+    return bUpdated - aUpdated;
+  })[0];
+
+  const selected = local ?? newest;
+  const mergedObservations = mergeObservations(found.flatMap((c) => c.observations));
+  const mergedScores = mergeScores(found.flatMap((c) => c.scores));
+  const isMixed =
+    found.length > 1 &&
+    (mergedObservations.length !== selected.observations.length ||
+      mergedScores.length !== selected.scores.length);
+
+  if (parsed.requireConsistentRead && isMixed) {
+    logger.warn("Consistent trace read requested but mixed regional data used", {
+      projectId: parsed.projectId,
+      traceId: parsed.traceId,
+      regions: found.map((candidate) => candidate.region),
+    });
+  }
+
+  return {
+    trace: selected.trace,
+    observations: mergedObservations,
+    scores: mergedScores,
+    sourceRegion: isMixed ? "mixed" : selected.region,
+    replicaLagMs: newest?.trace?.updatedAt && selected.trace?.updatedAt
+      ? newest.trace.updatedAt.getTime() - selected.trace.updatedAt.getTime()
+      : null,
+    consistency: isMixed
+      ? "mixed"
+      : selected.region === preferredRegion
+        ? "local"
+        : "replicated",
+  };
+};
+
+const uniqueRegions = (regions: IngestionRegion[]) =>
+  Array.from(new Set(regions));
+
+const mergeObservations = <
+  T extends { id: string; updatedAt?: Date | null; startTime?: Date | null },
+>(
+  observations: T[],
+) => {
+  const byId = new Map<string, T>();
+  for (const observation of observations) {
+    const existing = byId.get(observation.id);
+    if (!existing) {
+      byId.set(observation.id, observation);
+      continue;
+    }
+    const existingTime = existing.updatedAt?.getTime?.() ?? 0;
+    const nextTime = observation.updatedAt?.getTime?.() ?? 0;
+    if (nextTime >= existingTime) {
+      byId.set(observation.id, observation);
+    }
+  }
+  return [...byId.values()].sort((a, b) => {
+    return (a.startTime?.getTime?.() ?? 0) - (b.startTime?.getTime?.() ?? 0);
+  });
+};
+
+const mergeScores = <T extends { id: string; updatedAt?: Date | null }>(
+  scores: T[],
+) => {
+  const byId = new Map<string, T>();
+  for (const score of scores) {
+    const existing = byId.get(score.id);
+    if (!existing) {
+      byId.set(score.id, score);
+      continue;
+    }
+    const existingTime = existing.updatedAt?.getTime?.() ?? 0;
+    const nextTime = score.updatedAt?.getTime?.() ?? 0;
+    if (nextTime >= existingTime) {
+      byId.set(score.id, score);
+    }
+  }
+  return [...byId.values()];
+};
+
+const getProjectCloudConfig = async (_projectId: string) => {
+  return {
+    homeRegion: "us",
+  };
+};
diff --git a/packages/shared/src/server/regions/regionalReplicationWatermarks.ts b/packages/shared/src/server/regions/regionalReplicationWatermarks.ts
new file mode 100644
index 0000000000..02f6ee11bd
--- /dev/null
+++ b/packages/shared/src/server/regions/regionalReplicationWatermarks.ts
@@ -0,0 +1,332 @@
+import { clickhouseClient } from "../clickhouse/client";
+import { logger } from "../logger";
+import {
+  IngestionRegion,
+  RegionTraceReplicaState,
+} from "./ingestionRegionTypes";
+
+export type UpsertReplicationWatermarkInput = {
+  projectId: string;
+  traceId: string;
+  sourceRegion: IngestionRegion;
+  targetRegion: IngestionRegion;
+  regionalEventIds: string[];
+  replicatedAt: Date;
+  lastRegionSequence?: number | null;
+};
+
+export type ReadReplicationWatermarksInput = {
+  projectId: string;
+  traceId: string;
+  regions: IngestionRegion[];
+};
+
+export const upsertReplicationWatermark = async (
+  input: UpsertReplicationWatermarkInput,
+) => {
+  await clickhouseClient().insert({
+    table: "regional_replication_watermarks",
+    values: [
+      {
+        project_id: input.projectId,
+        trace_id: input.traceId,
+        source_region: input.sourceRegion,
+        target_region: input.targetRegion,
+        regional_event_ids: input.regionalEventIds,
+        last_region_sequence: input.lastRegionSequence ?? null,
+        replicated_at: input.replicatedAt.getTime(),
+        updated_at: new Date().getTime(),
+      },
+    ],
+    format: "JSONEachRow",
+  });
+};
+
+export const readReplicationWatermarks = async (
+  input: ReadReplicationWatermarksInput,
+): Promise<RegionTraceReplicaState[]> => {
+  const rows = await clickhouseClient().query({
+    query: `
+      SELECT
+        project_id,
+        trace_id,
+        target_region as region,
+        source_region as replicated_from,
+        arrayElement(regional_event_ids, length(regional_event_ids)) as last_regional_event_id,
+        last_region_sequence,
+        replicated_at,
+        updated_at
+      FROM regional_replication_watermarks
+      WHERE project_id = {projectId: String}
+      AND trace_id = {traceId: String}
+      AND target_region IN ({regions: Array(String)})
+      ORDER BY replicated_at DESC
+      LIMIT 1 BY target_region
+    `,
+    query_params: {
+      projectId: input.projectId,
+      traceId: input.traceId,
+      regions: input.regions,
+    },
+    format: "JSONEachRow",
+  });
+
+  const json = await rows.json<
+    Array<{
+      project_id: string;
+      trace_id: string;
+      region: IngestionRegion;
+      replicated_from?: IngestionRegion;
+      last_regional_event_id?: string;
+      last_region_sequence?: number;
+      replicated_at?: number;
+      updated_at: number;
+    }>
+  >();
+
+  return json.map((row) => ({
+    projectId: row.project_id,
+    traceId: row.trace_id,
+    region: row.region,
+    replicatedFrom: row.replicated_from,
+    lastRegionalEventId: row.last_regional_event_id,
+    lastRegionSequence: row.last_region_sequence,
+    replicaWatermark: row.replicated_at
+      ? new Date(row.replicated_at)
+      : undefined,
+    updatedAt: new Date(row.updated_at),
+  }));
+};
+
+export const chooseReadableRegions = async ({
+  projectId,
+  traceId,
+  preferredRegion,
+  candidateRegions,
+  requireConsistentRead,
+}: {
+  projectId: string;
+  traceId: string;
+  preferredRegion: IngestionRegion;
+  candidateRegions: IngestionRegion[];
+  requireConsistentRead: boolean;
+}) => {
+  const watermarks = await readReplicationWatermarks({
+    projectId,
+    traceId,
+    regions: candidateRegions,
+  });
+
+  if (!requireConsistentRead) {
+    return {
+      regions: candidateRegions,
+      watermarks,
+      reason: "best-effort",
+    };
+  }
+
+  const preferred = watermarks.find((w) => w.region === preferredRegion);
+  if (!preferred) {
+    logger.warn("No preferred-region watermark for consistent read", {
+      projectId,
+      traceId,
+      preferredRegion,
+    });
+    return {
+      regions: candidateRegions,
+      watermarks,
+      reason: "missing-preferred-watermark",
+    };
+  }
+
+  const preferredSequence = preferred.lastRegionSequence ?? 0;
+  const safeRegions = watermarks
+    .filter((watermark) => {
+      return (watermark.lastRegionSequence ?? 0) >= preferredSequence;
+    })
+    .map((watermark) => watermark.region);
+
+  return {
+    regions: safeRegions.length > 0 ? safeRegions : candidateRegions,
+    watermarks,
+    reason: safeRegions.length > 0 ? "watermark-filtered" : "fallback-all",
+  };
+};
diff --git a/packages/shared/src/server/queues.ts b/packages/shared/src/server/queues.ts
index 9f492cf6fd..0dfd814f43 100644
--- a/packages/shared/src/server/queues.ts
+++ b/packages/shared/src/server/queues.ts
@@ -331,6 +331,8 @@ export enum QueueName {
   OtelIngestionQueue = "otel-ingestion-queue",
   OtelIngestionSecondaryQueue = "secondary-otel-ingestion-queue",
   IngestionQueue = "ingestion-queue",
+  RegionalIngestionQueue = "regional-ingestion-queue",
+  TraceReplicationQueue = "trace-replication-queue",
   IngestionSecondaryQueue = "secondary-ingestion-queue",
   TraceUpsert = "trace-upsert",
   TraceDelete = "trace-delete",
@@ -370,6 +372,8 @@ export enum QueueJobs {
   OtelIngestionJob = "otel-ingestion-job",
   IngestionJob = "ingestion-job",
+  RegionalIngestionJob = "regional-ingestion-job",
+  TraceReplicationJob = "trace-replication-job",
   ExperimentCreateJob = "experiment-create",
   PostHogIntegrationProcessingJob = "posthog-integration-processing-job",
   MixpanelIntegrationProcessingJob = "mixpanel-integration-processing-job",
@@ -472,6 +476,28 @@ export type TQueueJobTypes = {
     };
     name: QueueJobs.IngestionJob;
   };
+  [QueueName.RegionalIngestionQueue]: {
+    id: string;
+    timestamp: Date;
+    name: QueueJobs.RegionalIngestionJob;
+    payload: import("./regions/ingestionRegionTypes").RegionalIngestionJobPayload;
+  };
+  [QueueName.TraceReplicationQueue]: {
+    id: string;
+    timestamp: Date;
+    name: QueueJobs.TraceReplicationJob;
+    payload: import("./regions/ingestionRegionTypes").TraceReplicationJobPayload;
+  };
   [QueueName.IngestionSecondaryQueue]: {
     id: string;
     timestamp: Date;
diff --git a/packages/shared/src/server/index.ts b/packages/shared/src/server/index.ts
index 0a4680f1d3..8803fa3c0a 100644
--- a/packages/shared/src/server/index.ts
+++ b/packages/shared/src/server/index.ts
@@ -51,6 +51,13 @@ export * from "./ingestion/processEventBatch";
 export * from "../server/ingestion/validateAndInflateScore";
 export * from "./ingestion/extractToolsBackend";
+export * from "./regions/ingestionRegionTypes";
+export * from "./regions/regionRouter";
+export * from "./regions/regionalEventIdentity";
+export * from "./regions/processRegionalEventBatch";
+export * from "./regions/regionalTraceReadModel";
 export * from "../server/ingestion/sampling";
 export * from "./otel/attributes";
 export * from "./otel/OtelIngestionProcessor";
@@ -72,6 +79,8 @@ export * from "./redis/batchActionQueue";
 export * from "./redis/batchExport";
 export * from "./redis/cloudUsageMeteringQueue";
 export * from "./redis/ingestionQueue";
+export * from "./redis/regionalIngestionQueue";
+export * from "./redis/traceReplicationQueue";
 export * from "./redis/otelIngestionQueue";
 export * from "./redis/eventPropagationQueue";
 export * from "./redis/cloudUsageMeteringQueue";
diff --git a/web/src/pages/api/public/ingestion.ts b/web/src/pages/api/public/ingestion.ts
index a30c0f1f34..bb90e8151a 100644
--- a/web/src/pages/api/public/ingestion.ts
+++ b/web/src/pages/api/public/ingestion.ts
@@ -8,6 +8,8 @@ import {
   processEventBatch,
+  processRegionalEventBatch,
+  RegionRouter,
   traceException,
 } from "@langfuse/shared/src/server";
@@ -73,6 +75,12 @@ export default async function handler(
       throw new UnauthorizedError(authCheck.error);
     }
 
+    const regionRouter = new RegionRouter();
+    const regionDecision = await regionRouter.resolve({
+      projectId: authCheck.scope.projectId,
+      headers: req.headers,
+      clientIp: req.headers["x-forwarded-for"]?.toString().split(",")[0],
+    });
+    regionRouter.logDecision(regionDecision);
+
     const parsedBody = IngestionBody.safeParse(req.body);
 
     if (!parsedBody.success) {
@@ -92,10 +100,20 @@ export default async function handler(
       await telemetry();
 
+      if (env.LANGFUSE_ENABLE_MULTI_REGION_INGESTION === "true") {
+        const result = await processRegionalEventBatch({
+          input: parsedBody.data.batch,
+          authCheck,
+          decision: regionDecision,
+        });
+        return res.status(207).json(result);
+      }
+
       const result = await processEventBatch(
         parsedBody.data.batch,
         authCheck,
       );
 
       return res.status(207).json(result);
diff --git a/web/src/pages/api/public/traces/[traceId].ts b/web/src/pages/api/public/traces/[traceId].ts
index 81495beff1..dfae0d105d 100644
--- a/web/src/pages/api/public/traces/[traceId].ts
+++ b/web/src/pages/api/public/traces/[traceId].ts
@@ -20,6 +20,8 @@ import {
   getScoresForTraces,
   getTraceById,
+  getRegionAwareTrace,
+  IngestionRegion,
   traceException,
   traceDeletionProcessor,
 } from "@langfuse/shared/src/server";
@@ -55,7 +57,28 @@ export default withMiddlewares(
         const includeScores = requestedFields.includes("scores");
         const includeMetrics = requestedFields.includes("metrics");
 
-        const trace = await getTraceById({
+        const preferredRegion =
+          typeof query.region === "string"
+            ? IngestionRegion.parse(query.region)
+            : undefined;
+
+        const regionAware =
+          env.LANGFUSE_ENABLE_MULTI_REGION_TRACE_READS === "true"
+            ? await getRegionAwareTrace({
+                traceId,
+                projectId: auth.scope.projectId,
+                preferredRegion,
+                includeReplicated: true,
+                requireConsistentRead:
+                  query.consistency === "strong" ||
+                  req.headers["x-langfuse-consistency"] === "strong",
+              })
+            : null;
+
+        const trace = regionAware?.trace ?? (await getTraceById({
           traceId,
           projectId: auth.scope.projectId,
           clickhouseFeatureTag: "tracing-public-api",
@@ -64,7 +87,7 @@ export default withMiddlewares(
           excludeInputOutput: !includeIO,
           excludeMetadata: !includeIO,
-        });
+        }));
 
         if (!trace) {
           throw new LangfuseNotFoundError(
@@ -75,7 +98,11 @@ export default withMiddlewares(
 
         const [observations, scores] = await Promise.all([
           includeObservations || includeMetrics
-            ? getObservationsForTrace({
+            ? regionAware?.observations?.length
+              ? Promise.resolve(regionAware.observations)
+              : getObservationsForTrace({
                 traceId,
                 projectId: auth.scope.projectId,
                 timestamp: trace?.timestamp,
@@ -84,7 +111,10 @@ export default withMiddlewares(
               })
             : Promise.resolve([]),
           includeScores
-            ? getScoresForTraces({
+            ? regionAware?.scores?.length
+              ? Promise.resolve(regionAware.scores)
+              : getScoresForTraces({
                 projectId: auth.scope.projectId,
                 traceIds: [traceId],
                 timestamp: trace?.timestamp,
@@ -174,6 +204,11 @@ export default withMiddlewares(
           observations: includeObservations ? outObservations : [],
           htmlPath: `/project/${auth.scope.projectId}/traces/${traceId}`,
+          region: regionAware?.sourceRegion ?? preferredRegion ?? "default",
+          consistency: regionAware?.consistency ?? "single-region",
+          replicaLagMs: regionAware?.replicaLagMs ?? null,
           totalCost: includeMetrics
             ? outObservations
                 .reduce(
diff --git a/worker/src/queues/regionalIngestionQueue.ts b/worker/src/queues/regionalIngestionQueue.ts
new file mode 100644
index 0000000000..600d77da21
--- /dev/null
+++ b/worker/src/queues/regionalIngestionQueue.ts
@@ -0,0 +1,472 @@
+import { Job, Processor } from "bullmq";
+import {
+  clickhouseClient,
+  getClickhouseEntityType,
+  getCurrentSpan,
+  getS3EventStorageClient,
+  logger,
+  QueueName,
+  recordDistribution,
+  recordHistogram,
+  recordIncrement,
+  redis,
+  TQueueJobTypes,
+  traceException,
+  RegionalIngestionJobPayload,
+} from "@langfuse/shared/src/server";
+import { prisma } from "@langfuse/shared/src/db";
+import { ClickhouseWriter, TableName } from "../services/ClickhouseWriter";
+import { IngestionService } from "../services/IngestionService";
+import { env } from "../env";
+import { randomUUID } from "crypto";
+
+export const regionalIngestionQueueProcessor: Processor = async (
+  job: Job<TQueueJobTypes[QueueName.RegionalIngestionQueue]>,
+) => {
+  const startedAt = Date.now();
+  const parsed = RegionalIngestionJobPayload.safeParse(job.data.payload);
+  if (!parsed.success) {
+    logger.error("Invalid regional ingestion queue payload", {
+      jobId: job.id,
+      error: parsed.error,
+    });
+    throw new Error("Invalid regional ingestion queue payload");
+  }
+
+  const payload = parsed.data;
+  const decision = payload.decision;
+  const span = getCurrentSpan();
+  span?.setAttribute("langfuse.ingestion.region.write", decision.writeRegion);
+  span?.setAttribute("langfuse.ingestion.region.home", decision.homeRegion);
+
+  try {
+    const clickhouseWriter = ClickhouseWriter.getInstance();
+    const eventsByBodyId = groupRegionalEvents(payload.events);
+
+    for (const group of Object.values(eventsByBodyId)) {
+      const first = group[0];
+      const clickhouseEntityType = getClickhouseEntityType(first.eventType);
+      const s3Client = getS3EventStorageClient(
+        getBucketForRegion(first.sourceRegion),
+      );
+
+      const eventFiles = group.map((event) => ({
+        file: event.payloadBucketPath,
+        createdAt: event.receivedAt,
+        regionalEventId: event.regionalEventId,
+      }));
+
+      const rawEvents: unknown[] = [];
+      for (const file of eventFiles) {
+        const raw = await s3Client.download(file.file);
+        const parsedFile = JSON.parse(raw);
+        rawEvents.push(...(Array.isArray(parsedFile) ? parsedFile : [parsedFile]));
+      }
+
+      for (const eventFile of eventFiles) {
+        clickhouseWriter.addToQueue(TableName.BlobStorageFileLog, {
+          id: randomUUID(),
+          project_id: payload.authCheck.scope.projectId,
+          entity_type: clickhouseEntityType,
+          entity_id: first.eventBodyId,
+          event_id: eventFile.regionalEventId,
+          bucket_name: getBucketForRegion(first.sourceRegion),
+          bucket_path: eventFile.file,
+          created_at: new Date().getTime(),
+          updated_at: new Date().getTime(),
+          event_ts: new Date().getTime(),
+          is_deleted: 0,
+        });
+      }
+
+      if (redis) {
+        await Promise.all(
+          eventFiles.map((eventFile) =>
+            redis.set(
+              `langfuse:ingestion:recently-processed:${payload.authCheck.scope.projectId}:${first.sourceRegion}:${first.eventType}:${first.eventBodyId}:${eventFile.regionalEventId}`,
+              "1",
+              "EX",
+              60 * 5,
+            ),
+          ),
+        );
+      }
+
+      if (!redis) throw new Error("Redis not available");
+      if (!prisma) throw new Error("Prisma not available");
+
+      const firstS3WriteTime =
+        eventFiles
+          .map((file) => file.createdAt)
+          .sort()
+          .shift() ?? new Date();
+
+      await new IngestionService(
+        redis,
+        prisma,
+        clickhouseWriter,
+        clickhouseClient(),
+      ).mergeAndWrite(
+        clickhouseEntityType,
+        payload.authCheck.scope.projectId,
+        first.eventBodyId,
+        firstS3WriteTime,
+        rawEvents as never,
+        true,
+      );
+    }
+
+    recordIncrement("langfuse.regional_ingestion.worker.processed", 1, {
+      writeRegion: decision.writeRegion,
+      homeRegion: decision.homeRegion,
+    });
+    recordHistogram(
+      "langfuse.regional_ingestion.worker.processing_ms",
+      Date.now() - startedAt,
+      { writeRegion: decision.writeRegion },
+    );
+  } catch (error) {
+    logger.error("Failed regional ingestion job", {
+      projectId: payload.authCheck.scope.projectId,
+      writeRegion: decision.writeRegion,
+      homeRegion: decision.homeRegion,
+      error,
+    });
+    recordIncrement("langfuse.regional_ingestion.worker.failed", 1, {
+      writeRegion: decision.writeRegion,
+    });
+    traceException(error);
+    throw error;
+  }
+};
+
+const groupRegionalEvents = (
+  events: import("@langfuse/shared/src/server").RegionalEventEnvelope[],
+) => {
+  return events.reduce(
+    (acc: Record<string, typeof events>, event) => {
+      const key = `${event.eventType}:${event.eventBodyId}`;
+      if (!acc[key]) acc[key] = [];
+      acc[key].push(event);
+      return acc;
+    },
+    {},
+  );
+};
+
+const getBucketForRegion = (region: string) => {
+  if (region === "eu") return env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET_EU;
+  if (region === "ap") return env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET_AP;
+  return env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET;
+};
diff --git a/worker/src/queues/traceReplicationQueue.ts b/worker/src/queues/traceReplicationQueue.ts
new file mode 100644
index 0000000000..1c4ea7f8c4
--- /dev/null
+++ b/worker/src/queues/traceReplicationQueue.ts
@@ -0,0 +1,492 @@
+import { Job, Processor } from "bullmq";
+import {
+  clickhouseClient,
+  createReplicationDedupeKey,
+  getTraceById,
+  getObservationsForTrace,
+  getScoresForTraces,
+  logger,
+  QueueName,
+  redis,
+  TQueueJobTypes,
+  TraceReplicationJobPayload,
+  traceException,
+  recordHistogram,
+  recordIncrement,
+} from "@langfuse/shared/src/server";
+import { prisma } from "@langfuse/shared/src/db";
+import { ClickhouseWriter } from "../services/ClickhouseWriter";
+import { env } from "../env";
+
+export const traceReplicationQueueProcessor: Processor = async (
+  job: Job<TQueueJobTypes[QueueName.TraceReplicationQueue]>,
+) => {
+  const startedAt = Date.now();
+  const parsed = TraceReplicationJobPayload.safeParse(job.data.payload);
+  if (!parsed.success) {
+    logger.error("Invalid trace replication payload", {
+      jobId: job.id,
+      error: parsed.error,
+    });
+    throw new Error("Invalid trace replication payload");
+  }
+
+  const payload = parsed.data;
+
+  try {
+    if (!redis) throw new Error("Redis not available");
+    if (!prisma) throw new Error("Prisma not available");
+
+    const dedupeKeys = payload.regionalEventIds.map((regionalEventId) =>
+      createReplicationDedupeKey({
+        projectId: payload.projectId,
+        targetRegion: payload.targetRegion,
+        regionalEventId,
+      }),
+    );
+    const alreadyReplicated = await Promise.all(
+      dedupeKeys.map((key) => redis.exists(key)),
+    );
+    if (alreadyReplicated.every(Boolean)) {
+      logger.debug("Skipping already replicated trace events", {
+        projectId: payload.projectId,
+        traceId: payload.traceId,
+        targetRegion: payload.targetRegion,
+      });
+      return;
+    }
+
+    const trace = await getTraceById({
+      traceId: payload.traceId,
+      projectId: payload.projectId,
+      clickhouseFeatureTag: `trace-replication-${payload.sourceRegion}`,
+      preferredClickhouseService: "ReadOnly",
+    });
+    if (!trace) {
+      logger.warn("Trace missing during replication", {
+        projectId: payload.projectId,
+        traceId: payload.traceId,
+        sourceRegion: payload.sourceRegion,
+      });
+      return;
+    }
+
+    const [observations, scores] = await Promise.all([
+      getObservationsForTrace({
+        traceId: payload.traceId,
+        projectId: payload.projectId,
+        timestamp: trace.timestamp,
+        preferredClickhouseService: "ReadOnly",
+      }),
+      getScoresForTraces({
+        projectId: payload.projectId,
+        traceIds: [payload.traceId],
+        timestamp: trace.timestamp,
+        preferredClickhouseService: "ReadOnly",
+      }),
+    ]);
+
+    const writer = ClickhouseWriter.getInstance();
+    writer.addToQueue("replicated_traces" as never, {
+      ...trace,
+      project_id: payload.projectId,
+      source_region: payload.sourceRegion,
+      target_region: payload.targetRegion,
+      regional_event_ids: payload.regionalEventIds,
+      replicated_at: new Date().getTime(),
+    } as never);
+
+    for (const observation of observations) {
+      writer.addToQueue("replicated_observations" as never, {
+        ...observation,
+        project_id: payload.projectId,
+        source_region: payload.sourceRegion,
+        target_region: payload.targetRegion,
+        replicated_at: new Date().getTime(),
+      } as never);
+    }
+
+    for (const score of scores) {
+      writer.addToQueue("replicated_scores" as never, {
+        ...score,
+        project_id: payload.projectId,
+        source_region: payload.sourceRegion,
+        target_region: payload.targetRegion,
+        replicated_at: new Date().getTime(),
+      } as never);
+    }
+
+    await clickhouseClient().insert({
+      table: "regional_replication_watermarks",
+      values: [
+        {
+          project_id: payload.projectId,
+          trace_id: payload.traceId,
+          source_region: payload.sourceRegion,
+          target_region: payload.targetRegion,
+          regional_event_ids: payload.regionalEventIds,
+          payload_file_keys: payload.payloadFileKeys,
+          replicated_at: new Date().getTime(),
+        },
+      ],
+      format: "JSONEachRow",
+    });
+
+    await Promise.all(
+      dedupeKeys.map((key) =>
+        redis.set(key, "1", "EX", env.LANGFUSE_REPLICATION_DEDUPE_TTL_SECONDS),
+      ),
+    );
+
+    recordIncrement("langfuse.trace_replication.processed", 1, {
+      sourceRegion: payload.sourceRegion,
+      targetRegion: payload.targetRegion,
+    });
+    recordHistogram(
+      "langfuse.trace_replication.processing_ms",
+      Date.now() - startedAt,
+      {
+        sourceRegion: payload.sourceRegion,
+        targetRegion: payload.targetRegion,
+      },
+    );
+  } catch (error) {
+    logger.error("Trace replication failed", {
+      projectId: payload.projectId,
+      traceId: payload.traceId,
+      sourceRegion: payload.sourceRegion,
+      targetRegion: payload.targetRegion,
+      error,
+    });
+    recordIncrement("langfuse.trace_replication.failed", 1, {
+      sourceRegion: payload.sourceRegion,
+      targetRegion: payload.targetRegion,
+    });
+    traceException(error);
+    throw error;
+  }
+};
diff --git a/worker/src/queues/workerManager.ts b/worker/src/queues/workerManager.ts
index c845fd2e15..f532bc7e15 100644
--- a/worker/src/queues/workerManager.ts
+++ b/worker/src/queues/workerManager.ts
@@ -9,6 +9,8 @@ import {
   IngestionQueue,
   QueueName,
   SecondaryIngestionQueue,
+  RegionalIngestionQueue,
+  TraceReplicationQueue,
 } from "@langfuse/shared/src/server";
 import { ingestionQueueProcessorBuilder } from "./ingestionQueue";
+import { regionalIngestionQueueProcessor } from "./regionalIngestionQueue";
+import { traceReplicationQueueProcessor } from "./traceReplicationQueue";
 import { otelIngestionQueueProcessorBuilder } from "./otelIngestionQueue";
 
 export class WorkerManager {
@@ -71,6 +73,33 @@ export class WorkerManager {
       },
     );
 
+    for (const region of ["us", "eu", "ap"] as const) {
+      this.registerShardedQueue(
+        QueueName.RegionalIngestionQueue,
+        RegionalIngestionQueue.getShardNames(region),
+        regionalIngestionQueueProcessor,
+        {
+          concurrency: env.LANGFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY,
+          lockDuration: 120_000,
+          stalledInterval: 30_000,
+        },
+      );
+    }
+
+    this.registerShardedQueue(
+      QueueName.TraceReplicationQueue,
+      TraceReplicationQueue.getShardNames(),
+      traceReplicationQueueProcessor,
+      {
+        concurrency: env.LANGFUSE_TRACE_REPLICATION_CONCURRENCY,
+        lockDuration: 240_000,
+        stalledInterval: 60_000,
+      },
+    );
+
     this.registerShardedQueue(
       QueueName.IngestionSecondaryQueue,
       SecondaryIngestionQueue.getShardNames(),
diff --git a/web/src/__tests__/server/regional-ingestion-api.servertest.ts b/web/src/__tests__/server/regional-ingestion-api.servertest.ts
new file mode 100644
index 0000000000..e25ab0187f
--- /dev/null
+++ b/web/src/__tests__/server/regional-ingestion-api.servertest.ts
@@ -0,0 +1,408 @@
+import { randomUUID } from "crypto";
+import { makeAPICall } from "@/src/__tests__/test-utils";
+import {
+  createOrgProjectAndApiKey,
+  RegionalIngestionQueue,
+  TraceReplicationQueue,
+  QueueJobs,
+} from "@langfuse/shared/src/server";
+
+let projectId: string;
+let auth: string;
+let regionalAdd: ReturnType<typeof vi.fn>;
+let replicationAdd: ReturnType<typeof vi.fn>;
+
+const postIngestion = (body: unknown, headers?: Record<string, string>) =>
+  makeAPICall("POST", "/api/public/ingestion", body, auth, headers);
+
+describe("regional public ingestion", () => {
+  beforeEach(async () => {
+    const fixture = await createOrgProjectAndApiKey();
+    projectId = fixture.projectId;
+    auth = fixture.auth;
+    regionalAdd = vi.fn().mockResolvedValue({});
+    replicationAdd = vi.fn().mockResolvedValue({});
+    vi.spyOn(RegionalIngestionQueue, "getInstance").mockReturnValue({
+      add: regionalAdd,
+    } as never);
+    vi.spyOn(TraceReplicationQueue, "getInstance").mockReturnValue({
+      add: replicationAdd,
+    } as never);
+  });
+
+  afterEach(() => {
+    vi.restoreAllMocks();
+  });
+
+  it("routes an EU header write to the EU regional queue", async () => {
+    const traceId = randomUUID();
+    const response = await postIngestion(
+      {
+        batch: [
+          {
+            id: "trace-event-1",
+            type: "trace-create",
+            timestamp: new Date().toISOString(),
+            body: {
+              id: traceId,
+              timestamp: new Date().toISOString(),
+              name: "regional-checkout",
+            },
+          },
+        ],
+      },
+      {
+        "x-langfuse-region": "eu",
+      },
+    );
+
+    expect(response.status).toBe(207);
+    expect(response.body.successes).toEqual([
+      {
+        id: "trace-event-1",
+        status: 202,
+        region: "eu",
+      },
+    ]);
+    expect(regionalAdd).toHaveBeenCalledWith(
+      QueueJobs.RegionalIngestionJob,
+      expect.objectContaining({
+        payload: expect.objectContaining({
+          decision: expect.objectContaining({
+            writeRegion: "eu",
+            replicateToHome: true,
+          }),
+        }),
+      }),
+      expect.any(Object),
+    );
+  });
+
+  it("creates replication jobs when write region differs from home region", async () => {
+    const traceId = randomUUID();
+    await postIngestion(
+      {
+        batch: [
+          traceCreate({
+            id: "trace-event-1",
+            traceId,
+          }),
+          spanCreate({
+            id: "span-event-1",
+            traceId,
+            spanId: "span-1",
+          }),
+        ],
+      },
+      {
+        "x-langfuse-region": "ap",
+      },
+    );
+
+    expect(replicationAdd).toHaveBeenCalledWith(
+      QueueJobs.TraceReplicationJob,
+      expect.objectContaining({
+        payload: expect.objectContaining({
+          projectId,
+          traceId,
+          sourceRegion: "ap",
+          targetRegion: "us",
+          reason: "home-replication",
+        }),
+      }),
+    );
+  });
+
+  it("accepts the same original event through two regions", async () => {
+    const traceId = randomUUID();
+    const event = traceCreate({
+      id: "client-event-id",
+      traceId,
+    });
+
+    const eu = await postIngestion(
+      { batch: [event] },
+      { "x-langfuse-region": "eu" },
+    );
+    const ap = await postIngestion(
+      { batch: [event] },
+      { "x-langfuse-region": "ap" },
+    );
+
+    expect(eu.status).toBe(207);
+    expect(ap.status).toBe(207);
+    expect(eu.body.successes[0].id).toBe("client-event-id");
+    expect(ap.body.successes[0].id).toBe("client-event-id");
+    expect(replicationAdd).toHaveBeenCalledTimes(2);
+  });
+
+  it("uses nearest region from forwarded ip when no region header is sent", async () => {
+    const response = await postIngestion(
+      {
+        batch: [
+          traceCreate({
+            id: "trace-event-1",
+            traceId: randomUUID(),
+          }),
+        ],
+      },
+      {
+        "x-forwarded-for": "14.1.2.3",
+      },
+    );
+
+    expect(response.status).toBe(207);
+    expect(response.body.successes[0].region).toBe("ap");
+  });
+
+  function traceCreate({ id, traceId }: { id: string; traceId: string }) {
+    return {
+      id,
+      type: "trace-create",
+      timestamp: new Date().toISOString(),
+      body: {
+        id: traceId,
+        timestamp: new Date().toISOString(),
+        name: "regional-test",
+      },
+    };
+  }
+
+  function spanCreate({
+    id,
+    traceId,
+    spanId,
+  }: {
+    id: string;
+    traceId: string;
+    spanId: string;
+  }) {
+    return {
+      id,
+      type: "span-create",
+      timestamp: new Date().toISOString(),
+      body: {
+        id: spanId,
+        traceId,
+        startTime: new Date().toISOString(),
+      },
+    };
+  }
+});
diff --git a/packages/shared/src/server/regions/__tests__/regionalEventIdentity.test.ts b/packages/shared/src/server/regions/__tests__/regionalEventIdentity.test.ts
new file mode 100644
index 0000000000..e92ef2a1f1
--- /dev/null
+++ b/packages/shared/src/server/regions/__tests__/regionalEventIdentity.test.ts
@@ -0,0 +1,344 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import {
+  createRegionalEventIdentity,
+  createRegionalSeenKey,
+  createReplicationDedupeKey,
+  createTraceReplicaStateKey,
+} from "../regionalEventIdentity";
+
+describe("regionalEventIdentity", () => {
+  beforeEach(() => {
+    vi.useFakeTimers();
+    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
+  });
+
+  afterEach(() => {
+    vi.useRealTimers();
+  });
+
+  it("creates a regional event id for an accepted SDK event", () => {
+    const event = createRegionalEventIdentity({
+      projectId: "project-1",
+      traceId: "trace-1",
+      eventBodyId: "trace-1",
+      eventType: "trace-create",
+      originalEventId: "client-event-1",
+      sourceRegion: "eu",
+      targetRegion: "us",
+      payloadFileKey: "file-1",
+      payloadBucketPath: "events/project-1/eu/trace/trace-1/file-1.json",
+      body: {
+        id: "trace-1",
+        name: "checkout",
+      },
+      index: 0,
+    });
+
+    expect(event.regionalEventId).toContain("eu-1704067200000-");
+    expect(event.originalEventId).toBe("client-event-1");
+    expect(event.regionSequence).toBe(1704067200000);
+  });
+
+  it("creates a different regional id for the same original event in another region", () => {
+    const eu = createRegionalEventIdentity({
+      projectId: "project-1",
+      traceId: "trace-1",
+      eventBodyId: "trace-1",
+      eventType: "trace-create",
+      originalEventId: "client-event-1",
+      sourceRegion: "eu",
+      targetRegion: "us",
+      payloadFileKey: "file-eu",
+      payloadBucketPath: "events/project-1/eu/trace/trace-1/file-eu.json",
+      body: {
+        id: "trace-1",
+      },
+      index: 0,
+    });
+
+    const ap = createRegionalEventIdentity({
+      projectId: "project-1",
+      traceId: "trace-1",
+      eventBodyId: "trace-1",
+      eventType: "trace-create",
+      originalEventId: "client-event-1",
+      sourceRegion: "ap",
+      targetRegion: "us",
+      payloadFileKey: "file-ap",
+      payloadBucketPath: "events/project-1/ap/trace/trace-1/file-ap.json",
+      body: {
+        id: "trace-1",
+      },
+      index: 0,
+    });
+
+    expect(eu.originalEventId).toBe(ap.originalEventId);
+    expect(eu.regionalEventId).not.toBe(ap.regionalEventId);
+  });
+
+  it("dedupes replication by regional delivery id", () => {
+    expect(
+      createReplicationDedupeKey({
+        projectId: "project-1",
+        targetRegion: "us",
+        regionalEventId: "eu-1704067200000-a",
+      }),
+    ).toBe(
+      "langfuse:regional-replication:project-1:us:eu-1704067200000-a",
+    );
+  });
+
+  it("does not include original event id in the replication dedupe key", () => {
+    const first = createReplicationDedupeKey({
+      projectId: "project-1",
+      targetRegion: "us",
+      regionalEventId: "eu-1704067200000-a",
+    });
+    const second = createReplicationDedupeKey({
+      projectId: "project-1",
+      targetRegion: "us",
+      regionalEventId: "ap-1704067200000-b",
+    });
+
+    expect(first).not.toBe(second);
+  });
+
+  it("scopes recently-seen regional keys by source region", () => {
+    expect(
+      createRegionalSeenKey({
+        projectId: "project-1",
+        sourceRegion: "eu",
+        eventBodyId: "trace-1",
+        regionalEventId: "eu-1704067200000-a",
+      }),
+    ).toBe(
+      "langfuse:regional-seen:project-1:eu:trace-1:eu-1704067200000-a",
+    );
+  });
+
+  it("creates a trace replica state key per region", () => {
+    expect(
+      createTraceReplicaStateKey({
+        projectId: "project-1",
+        traceId: "trace-1",
+        region: "eu",
+      }),
+    ).toBe("langfuse:trace-replica-state:project-1:trace-1:eu");
+  });
+});
diff --git a/worker/src/queues/__tests__/traceReplicationQueue.test.ts b/worker/src/queues/__tests__/traceReplicationQueue.test.ts
new file mode 100644
index 0000000000..880a257a3f
--- /dev/null
+++ b/worker/src/queues/__tests__/traceReplicationQueue.test.ts
@@ -0,0 +1,372 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import { randomUUID } from "crypto";
+import { traceReplicationQueueProcessor } from "../traceReplicationQueue";
+
+vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
+  const actual = await importOriginal<typeof import("@langfuse/shared/src/server")>();
+  return {
+    ...actual,
+    redis: {
+      exists: vi.fn().mockResolvedValue(0),
+      set: vi.fn().mockResolvedValue("OK"),
+    },
+    getTraceById: vi.fn().mockResolvedValue({
+      id: "trace-1",
+      projectId: "project-1",
+      timestamp: new Date("2024-01-01T00:00:00.000Z"),
+      updatedAt: new Date("2024-01-01T00:00:03.000Z"),
+      name: "checkout",
+    }),
+    getObservationsForTrace: vi.fn().mockResolvedValue([
+      {
+        id: "span-1",
+        traceId: "trace-1",
+        startTime: new Date("2024-01-01T00:00:01.000Z"),
+        updatedAt: new Date("2024-01-01T00:00:02.000Z"),
+      },
+    ]),
+    getScoresForTraces: vi.fn().mockResolvedValue([]),
+    clickhouseClient: vi.fn(() => ({
+      insert: vi.fn().mockResolvedValue({}),
+    })),
+    logger: {
+      debug: vi.fn(),
+      info: vi.fn(),
+      warn: vi.fn(),
+      error: vi.fn(),
+    },
+    recordIncrement: vi.fn(),
+    recordHistogram: vi.fn(),
+    traceException: vi.fn(),
+  };
+});
+
+vi.mock("../../services/ClickhouseWriter", () => ({
+  ClickhouseWriter: {
+    getInstance: vi.fn(() => ({
+      addToQueue: vi.fn(),
+    })),
+  },
+}));
+
+describe("traceReplicationQueueProcessor", () => {
+  beforeEach(() => {
+    vi.clearAllMocks();
+  });
+
+  it("replicates trace, observations, scores, and watermark", async () => {
+    await expect(traceReplicationQueueProcessor(buildJob())).resolves.toBeUndefined();
+  });
+
+  it("skips if every regional event id was already replicated", async () => {
+    const server = await import("@langfuse/shared/src/server");
+    vi.mocked(server.redis!.exists).mockResolvedValue(1 as never);
+
+    await expect(traceReplicationQueueProcessor(buildJob())).resolves.toBeUndefined();
+    expect(server.getTraceById).not.toHaveBeenCalled();
+  });
+
+  it("does not dedupe the same original event if it has different regional ids", async () => {
+    const first = buildJob({
+      regionalEventIds: ["eu-1710000000000-a"],
+      sourceRegion: "eu",
+    });
+    const second = buildJob({
+      regionalEventIds: ["ap-1710000000000-b"],
+      sourceRegion: "ap",
+    });
+
+    await traceReplicationQueueProcessor(first);
+    await traceReplicationQueueProcessor(second);
+
+    const server = await import("@langfuse/shared/src/server");
+    expect(server.getTraceById).toHaveBeenCalledTimes(2);
+  });
+
+  it("returns without failing when source trace is missing", async () => {
+    const server = await import("@langfuse/shared/src/server");
+    vi.mocked(server.getTraceById).mockResolvedValueOnce(null as never);
+
+    await expect(traceReplicationQueueProcessor(buildJob())).resolves.toBeUndefined();
+  });
+
+  function buildJob(overrides: Record<string, unknown> = {}) {
+    return {
+      id: "job-1",
+      data: {
+        id: randomUUID(),
+        timestamp: new Date(),
+        name: "trace-replication-job",
+        payload: {
+          projectId: "project-1",
+          traceId: "trace-1",
+          sourceRegion: "eu",
+          targetRegion: "us",
+          regionalEventIds: ["eu-1710000000000-a"],
+          payloadFileKeys: ["eu-file-1"],
+          requestedAt: new Date(),
+          reason: "home-replication",
+          ...overrides,
+        },
+      },
+    } as never;
+  }
+});
diff --git a/packages/shared/src/server/regions/__tests__/regionalTraceReadModel.test.ts b/packages/shared/src/server/regions/__tests__/regionalTraceReadModel.test.ts
new file mode 100644
index 0000000000..ae7b613ff6
--- /dev/null
+++ b/packages/shared/src/server/regions/__tests__/regionalTraceReadModel.test.ts
@@ -0,0 +1,440 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import { getRegionAwareTrace } from "../regionalTraceReadModel";
+
+vi.mock("../../repositories", () => ({
+  getTraceById: vi.fn(),
+  getObservationsForTrace: vi.fn(),
+  getScoresForTraces: vi.fn(),
+}));
+
+describe("regionalTraceReadModel", () => {
+  beforeEach(async () => {
+    vi.clearAllMocks();
+    const repositories = await import("../../repositories");
+    vi.mocked(repositories.getTraceById).mockImplementation(
+      async ({ clickhouseFeatureTag }) => {
+        if (String(clickhouseFeatureTag).includes("eu")) {
+          return trace({
+            updatedAt: new Date("2024-01-01T00:00:04.000Z"),
+            name: "eu-local",
+          }) as never;
+        }
+        if (String(clickhouseFeatureTag).includes("us")) {
+          return trace({
+            updatedAt: new Date("2024-01-01T00:00:02.000Z"),
+            name: "us-replica",
+          }) as never;
+        }
+        return null as never;
+      },
+    );
+    vi.mocked(repositories.getObservationsForTrace).mockImplementation(
+      async ({ preferredClickhouseService }) => {
+        return [
+          observation({
+            id: "span-1",
+            updatedAt: new Date("2024-01-01T00:00:01.000Z"),
+          }),
+        ] as never;
+      },
+    );
+    vi.mocked(repositories.getScoresForTraces).mockResolvedValue([] as never);
+  });
+
+  it("returns local trace data when local region has a trace", async () => {
+    const result = await getRegionAwareTrace({
+      projectId: "project-1",
+      traceId: "trace-1",
+      preferredRegion: "eu",
+      includeReplicated: true,
+      requireConsistentRead: false,
+    });
+
+    expect(result.trace?.name).toBe("eu-local");
+    expect(result.sourceRegion).toBe("eu");
+    expect(result.consistency).toBe("local");
+  });
+
+  it("mixes local trace with replicated observations if they are newer", async () => {
+    const repositories = await import("../../repositories");
+    vi.mocked(repositories.getObservationsForTrace).mockImplementationOnce(
+      async () =>
+        [
+          observation({
+            id: "span-1",
+            updatedAt: new Date("2024-01-01T00:00:01.000Z"),
+          }),
+        ] as never,
+    );
+    vi.mocked(repositories.getObservationsForTrace).mockImplementationOnce(
+      async () =>
+        [
+          observation({
+            id: "span-1",
+            updatedAt: new Date("2024-01-01T00:00:05.000Z"),
+          }),
+          observation({
+            id: "span-2",
+            updatedAt: new Date("2024-01-01T00:00:03.000Z"),
+          }),
+        ] as never,
+    );
+
+    const result = await getRegionAwareTrace({
+      projectId: "project-1",
+      traceId: "trace-1",
+      preferredRegion: "eu",
+      includeReplicated: true,
+      requireConsistentRead: true,
+    });
+
+    expect(result.trace?.name).toBe("eu-local");
+    expect(result.observations.map((o) => o.id)).toEqual(["span-1", "span-2"]);
+    expect(result.consistency).toBe("mixed");
+  });
+
+  it("falls back to replicated region when preferred region has no trace", async () => {
+    const repositories = await import("../../repositories");
+    vi.mocked(repositories.getTraceById).mockImplementation(
+      async ({ clickhouseFeatureTag }) => {
+        if (String(clickhouseFeatureTag).includes("us")) {
+          return trace({
+            updatedAt: new Date("2024-01-01T00:00:02.000Z"),
+            name: "home-replica",
+          }) as never;
+        }
+        return null as never;
+      },
+    );
+
+    const result = await getRegionAwareTrace({
+      projectId: "project-1",
+      traceId: "trace-1",
+      preferredRegion: "ap",
+      includeReplicated: true,
+      requireConsistentRead: false,
+    });
+
+    expect(result.trace?.name).toBe("home-replica");
+    expect(result.consistency).toBe("replicated");
+  });
+
+  it("returns not-found only when no region has the trace", async () => {
+    const repositories = await import("../../repositories");
+    vi.mocked(repositories.getTraceById).mockResolvedValue(null as never);
+
+    const result = await getRegionAwareTrace({
+      projectId: "project-1",
+      traceId: "trace-1",
+      preferredRegion: "eu",
+      includeReplicated: true,
+      requireConsistentRead: false,
+    });
+
+    expect(result.consistency).toBe("not-found");
+    expect(result.trace).toBeNull();
+  });
+
+  function trace(overrides: Record<string, unknown> = {}) {
+    return {
+      id: "trace-1",
+      projectId: "project-1",
+      timestamp: new Date("2024-01-01T00:00:00.000Z"),
+      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
+      name: "trace",
+      ...overrides,
+    };
+  }
+
+  function observation(overrides: Record<string, unknown> = {}) {
+    return {
+      id: "span-1",
+      traceId: "trace-1",
+      startTime: new Date("2024-01-01T00:00:01.000Z"),
+      updatedAt: new Date("2024-01-01T00:00:01.000Z"),
+      ...overrides,
+    };
+  }
+});
diff --git a/docs/ingestion/multi-region-ingestion.md b/docs/ingestion/multi-region-ingestion.md
new file mode 100644
index 0000000000..21c4cd84ee
--- /dev/null
+++ b/docs/ingestion/multi-region-ingestion.md
@@ -0,0 +1,520 @@
+# Multi-Region Ingestion
+
+Multi-region ingestion allows SDKs to write traces to the closest Langfuse
+region. The first supported regions are:
+
+- `us`
+- `eu`
+- `ap`
+
+## Request Routing
+
+The public ingestion endpoint resolves a write region from:
+
+1. `x-langfuse-region`
+2. geo lookup from `x-forwarded-for`
+3. project home region
+
+If the write region differs from the home region, Langfuse accepts the batch in
+the write region and schedules replication to the home region.
+
+## Response Contract
+
+The endpoint keeps the existing `207` response shape:
+
+```json
+{
+  "successes": [
+    {
+      "id": "event-id",
+      "status": 202,
+      "region": "eu"
+    }
+  ],
+  "errors": []
+}
+```
+
+`202` means the event was accepted into the regional ingestion queue.
+
+## Event Identity
+
+Every accepted event gets a regional event ID. The ID includes:
+
+- source region
+- local region sequence
+- random UUID
+
+Example:
+
+```text
+eu-1710000000000-2f6f6f8d-6ff7-4db7-b8d7-54be5b3b34b7
+```
+
+The original SDK event ID is preserved for API responses and debugging.
+
+## Replication
+
+Replication jobs copy traces, observations, and scores from the source region to
+the home region. A job contains:
+
+- project ID
+- trace ID
+- source region
+- target region
+- regional event IDs
+- payload file keys
+
+The replication worker checks Redis dedupe keys before copying. The dedupe key
+uses the target region and regional event ID.
+
+## Reads
+
+The trace read API can read local and replicated data. If multiple regions have
+data for the trace, the read model prefers the local trace row and merges
+observations and scores by ID.
+
+The response includes:
+
+- `region`
+- `consistency`
+- `replicaLagMs`
+
+`consistency` can be:
+
+- `local`
+- `replicated`
+- `mixed`
+- `not-found`
+
+## Consistent Reads
+
+Clients can request strong consistency with:
+
+```http
+x-langfuse-consistency: strong
+```
+
+The first release logs a warning when strong consistency is requested but mixed
+regional data is returned. This keeps reads available during rollout.
+
+## Operational Notes
+
+Each write region has a regional ingestion queue. Replication has a separate
+queue. Region writes use regional S3 buckets, but home-region reads can fall back
+to replicated ClickHouse tables.
+
+The existing single-region ingestion path remains available behind the
+`LANGFUSE_ENABLE_MULTI_REGION_INGESTION` flag.
+
+## Failure Examples
+
+If the `eu` region is healthy but home-region replication is delayed, EU writes
+will still return `202`. Reads from the EU region should show the local trace.
+Reads from the home region may show a replicated trace later.
+
+If the same SDK retries through a different edge region, the request is accepted
+again and receives a new regional event ID. The original event ID is preserved in
+logs.
+
+## Customer Guidance
+
+SDKs should send `x-langfuse-region` only when they intentionally pin traffic to
+a region. Otherwise the edge router chooses the nearest region.
+
+Customers who require home-region read-after-write consistency should set their
+SDK to the home region until strict read semantics are implemented.
diff --git a/docs/ingestion/regional-consistency-contract.md b/docs/ingestion/regional-consistency-contract.md
new file mode 100644
index 0000000000..6d3f6846c9
--- /dev/null
+++ b/docs/ingestion/regional-consistency-contract.md
@@ -0,0 +1,416 @@
+# Regional Consistency Contract
+
+Multi-region ingestion changes the meaning of accepted writes and trace reads.
+This document describes the first implementation's product contract.
+
+## Write Contract
+
+A successful regional ingestion response means:
+
+- the request was authenticated
+- each successful event passed ingestion schema validation
+- the event payload was written to the regional bucket
+- the regional ingestion job was enqueued
+
+A successful regional ingestion response does not mean:
+
+- the event has replicated to the project home region
+- every read region can see the event
+- the event has been merged into the final trace view
+
+## Event Identity
+
+The API response uses the original SDK event ID. Internally the system uses a
+regional event ID for queueing and replication.
+
+The regional event ID is unique per accepted delivery. It is not intended to be
+a semantic event identity.
+
+## Ordering
+
+Within one accepted batch, events are sorted by their event timestamp.
+
+Across regions, the first release uses region-local receive time and regional
+event IDs. There is no global ordering service.
+
+## Read Contract
+
+The trace read API supports four consistency labels:
+
+- `local`
+- `replicated`
+- `mixed`
+- `not-found`
+
+`local` means the selected trace row came from the requested region.
+
+`replicated` means the selected trace row came from another readable region.
+
+`mixed` means the response contains trace components from more than one region.
+
+`not-found` means no readable region returned the trace.
+
+## Strong Consistency Header
+
+Clients may request:
+
+```http
+x-langfuse-consistency: strong
+```
+
+In the first implementation, this is advisory. If the read model produces a
+mixed result, the API logs a warning and still returns the mixed result.
+
+## Replica Watermarks
+
+Replication workers write watermarks after copying a trace. Watermarks include:
+
+- project ID
+- trace ID
+- source region
+- target region
+- last regional event ID
+- last region-local sequence
+- replicated timestamp
+
+Watermarks are used for support debugging and future routing decisions. They do
+not currently prevent mixed reads.
+
+## Examples
+
+### Local Write, Local Read
+
+A customer writes to EU and reads from EU. If the regional worker has processed
+the event, the API returns `local`.
+
+### Regional Write, Home Read
+
+A customer writes to EU and reads from US. If replication has completed, the API
+returns `replicated`. If replication has not completed, it may return
+`not-found`.
+
+### Mixed Read
+
+A customer writes trace create to EU, then a span update is retried through AP.
+If EU has the trace and AP has the newer span, the read model can return the EU
+trace row with the AP span. The API returns `mixed`.
+
+## Limitations
+
+The first implementation does not provide read-your-write across regions.
+
+The first implementation does not provide a single authoritative trace version.
+
+The first implementation does not reject mixed reads when strong consistency is
+requested.
+
+The first implementation does not dedupe original SDK event IDs across regions.
+
+## Future Contract
+
+A future version should define one of:
+
+- home-region authoritative reads
+- per-trace leader region
+- globally sequenced trace versions
+- bounded-staleness read replicas with watermarks
+- explicit pending status for lagging reads
+
+Until then, customers that require strict read-after-write should pin writes and
+reads to their project home region.
diff --git a/docs/ingestion/multi-region-deletions.md b/docs/ingestion/multi-region-deletions.md
new file mode 100644
index 0000000000..91c74f54cf
--- /dev/null
+++ b/docs/ingestion/multi-region-deletions.md
@@ -0,0 +1,356 @@
+# Multi-Region Deletions
+
+Trace deletion already has two sides:
+
+- delete rows from ClickHouse/Postgres-backed read stores
+- remove or mark ingestion payload files for retention and audit workflows
+
+Multi-region ingestion adds regional copies of both.
+
+## Deletion Contract
+
+A delete request is accepted in the project home region. The home region creates
+a deletion command for every known write region and replica region.
+
+The first implementation does not add a new deletion queue. It relies on the
+existing trace deletion processor for the home region and on replication
+watermarks to discover regional copies.
+
+## Known Regional Copies
+
+Known copies are discovered from:
+
+- regional replication watermarks
+- replicated trace rows
+- blob storage file log rows
+- regional ingestion event prefixes
+
+A missing watermark does not prove that a regional copy does not exist.
+
+## Lagging Replication
+
+A trace can be deleted while replication is still delayed. In that case:
+
+1. the home-region trace is deleted
+2. the lagging replication job may still copy older rows
+3. the read model may see a replicated row after the delete
+4. deletion must be replayed for that region
+
+## Read Behavior After Delete
+
+The public trace read API should not resurrect deleted traces from lagging
+replicas.
+
+The first implementation depends on the existing read filters and does not add a
+region-wide tombstone. This means replicated rows can still appear if they arrive
+after the home delete has completed.
+
+## Tombstones
+
+A future implementation should write a project-scoped trace tombstone with:
+
+- project ID
+- trace ID
+- deletion timestamp
+- deleting actor
+- delete request ID
+- affected regions
+
+Every regional read should check the tombstone before returning local or
+replicated rows.
+
+## Replay
+
+Manual replay should be possible for:
+
+- deletion commands
+- replication commands
+- regional ingestion commands
+
+Replay should preserve ordering:
+
+```text
+trace event sequence < deletion sequence < post-delete replay rejection
+```
+
+The first implementation has no global sequence, so replay order is operational
+rather than contractual.
+
+## Support Runbook
+
+When a deleted trace reappears:
+
+1. Check the home-region delete audit log.
+2. Check regional replication watermarks.
+3. Check whether a replication job completed after the delete timestamp.
+4. Re-run trace deletion for the affected region.
+5. Disable multi-region reads for the project if the trace still appears.
+
+## Rollout Gate
+
+Before enabling multi-region ingestion by default, verify:
+
+- deleting a trace in the home region hides it from every region
+- delayed replication cannot resurrect a deleted trace
+- manual replication replay respects tombstones
+- blob storage cleanup includes regional prefixes
+- public trace reads return not found for deleted traces even when replicas lag
+
+## Open Question
+
+The current PR does not define whether deletion is globally ordered with
+ingestion. That decision must be made before regional writes become the default.
+
+## Deletion Test Matrix
+
+Test each case with:
+
+- write region `us`, home region `us`
+- write region `eu`, home region `us`
+- write region `ap`, home region `us`
+- replication delayed before delete
+- replication delayed after delete
+- manual replay before delete
+- manual replay after delete
+
+For every case, verify:
+
+- public API read by trace ID
+- trace table read
+- observations table read
+- scores table read
+- events table read
+- blob storage file log read
+- regional prefix cleanup
+- audit log output
+- support runbook result
+
+## Delete Ordering Examples
+
+Example A:
+
+1. EU accepts trace create.
+2. EU regional worker writes trace.
+3. Home region deletes trace before replication.
+4. Replication job later copies EU trace to home.
+
+Expected future behavior: the replication worker sees a tombstone and drops the
+copy.
+
+Current behavior: the PR does not show that check.
+
+Example B:
+
+1. AP accepts span update.
+2. Home region deletes trace.
+3. AP regional worker processes span update.
+4. Multi-region read merges local delete state with AP observation.
+
+Expected future behavior: read returns not found.
+
+Current behavior: the read model can still merge region data if a query returns
+rows.
+
+Example C:
+
+1. EU accepts trace create.
+2. EU accepts trace update.
+3. Home region deletes trace.
+4. Support replays EU trace create.
+
+Expected future behavior: replay is rejected or recorded as ignored because the
+delete sequence is newer.
+
+Current behavior: replay has no global sequence to compare.
+
+## Owner Checklist
+
+Before default rollout, owners should sign off on:
+
+- ingestion replay semantics
+- trace deletion semantics
+- observation deletion semantics
+- score deletion semantics
+- media deletion semantics
+- dataset run item deletion semantics
+- audit log semantics
+- customer support runbook
+- data retention behavior
+- regional disaster recovery behavior
+
+## Data Repair Notes
+
+If a regional replay creates duplicate rows, repair should use a stable event
+identity. The current PR only has regional event IDs, so repair has to infer
+duplicates from original event ID, payload hash, trace ID, observation ID, and
+timestamps.
+
+That inference is not safe enough for automatic repair. Payloads can be equal
+for legitimate repeated spans, and timestamps can be equal for batched SDK
+events.
+
+A future repair command should accept:
+
+- project ID
+- trace ID
+- stable event ID
+- operation type
+- intended sequence
+- source region
+- target region
+- repair reason
+
+## Backfill Notes
+
+Backfilling old traces into a new home region must not reuse regional delivery
+IDs as source-of-truth identifiers.
+
+Backfill should write a separate backfill operation ID and preserve the original
+event identity. Reads should be able to distinguish live ingestion, replication,
+manual replay, and historical backfill.
+
+## Dashboard Notes
+
+Dashboards should not aggregate local and replicated rows unless the query layer
+knows which rows are authoritative.
+
+Required dashboard dimensions:
+
+- source region
+- read region
+- home region
+- consistency label
+- replication lag bucket
+- event source
+- replay reason
+
+Without these dimensions, rollout metrics can look healthy while individual
+customers see duplicate or stale traces.
+
+## Alert Notes
+
+Alert on:
+
+- mixed reads for strong-consistency requests
+- duplicate original event IDs across regions
+- replication jobs older than the read SLO
+- deletes followed by replicated inserts
+- home-region reads returning not found after regional success
+- regional queue drain time above SLO
+
+## Documentation Notes
+
+Customer-facing docs must say whether regional ingestion is eventually
+consistent, read-your-write, or home-region authoritative. Avoid saying
+"strong consistency" until the API can actually enforce it.
+
+## SDK Notes
+
+SDK retry logic should reuse the same semantic event identity across regions.
+Changing edge regions must not turn one customer action into two trace updates.
+
+## API Notes
+
+If a strong read cannot be served, return an explicit error or pending state
+instead of a mixed successful trace.
+
+## Audit Notes
+
+Audit logs should include write region, read region, source region, and target
+region for every accepted event and trace read.
+
+## Cost Notes
+
+Replication doubles storage and insert volume for non-home writes.
+
+Budget alerts should be region-aware before rollout.
+
+Tag every replicated insert with a replication reason.
+
+Keep region tags on dead-letter jobs.
+
+Expose region lag in support tooling.
+
+Document all region flags.
diff --git a/docs/ingestion/multi-region-rollout.md b/docs/ingestion/multi-region-rollout.md
new file mode 100644
index 0000000000..d60d51cdaf
--- /dev/null
+++ b/docs/ingestion/multi-region-rollout.md
@@ -0,0 +1,388 @@
+# Multi-Region Ingestion Rollout
+
+## Goals
+
+- reduce ingestion latency for customers far from the home region
+- preserve existing public ingestion response shape
+- preserve trace IDs in public reads
+- avoid blocking regional writes on home-region replication
+
+## Flags
+
+- `LANGFUSE_ENABLE_MULTI_REGION_INGESTION`
+- `LANGFUSE_ENABLE_MULTI_REGION_TRACE_READS`
+- `LANGFUSE_TRACE_REPLICATION_CONCURRENCY`
+
+## Deployment Order
+
+1. Deploy queues and workers in every region.
+2. Deploy replication worker in the home region.
+3. Deploy trace read API with multi-region reads disabled.
+4. Enable regional writes for internal projects.
+5. Enable trace reads with replicated fallback for internal projects.
+6. Enable regional writes for 1 percent of projects.
+7. Increase rollout by write region.
+
+## Metrics
+
+Watch:
+
+- regional ingestion accepted count by region
+- regional ingestion worker failures by region
+- trace replication failures by source and target region
+- replication lag by project and trace
+- mixed consistency read count
+- strong consistency warning count
+- duplicate original event ID count
+- out-of-order region sequence count
+
+## Rollback
+
+Disable `LANGFUSE_ENABLE_MULTI_REGION_INGESTION`.
+
+This stops new regional writes. Existing regional ingestion and replication jobs
+continue draining.
+
+Disable `LANGFUSE_ENABLE_MULTI_REGION_TRACE_READS` to return to the existing
+single-region read path.
+
+## Data Validation
+
+For every rollout project, compare:
+
+- accepted SDK event count
+- regional event count
+- home-region replicated event count
+- trace count
+- observation count
+- score count
+- public trace read success count
+
+Compare by project, trace ID, original event ID, and region.
+
+## Manual Replays
+
+Replication jobs can be replayed by trace ID. Manual replays use reason
+`manual-replay` and write the same replicated tables as automatic replication.
+
+## Open Questions
+
+- Should event identity be generated by the SDK, edge, or home region?
+- What is the read-after-write contract for a trace written outside its home region?
+- How long may a mixed read be shown in the public API?
+- Should strong consistency return 409/202 instead of mixed data?
+- How do deletions interact with lagging replicated rows?
+- What is the home-region disaster recovery story?
+
+## Release Gate
+
+Do not enable this by default until:
+
+- duplicate original event IDs are measurable
+- read consistency behavior is documented for customers
+- replication lag has an SLO
+- deletion semantics are tested across regions
+- dashboards distinguish local, replicated, and mixed reads
```

## Intended Flaws

### Flaw 1: Regional Event Identity Has No Global Ordering Or Dedup Contract

- `type`: `event_contract_flaw`
- `location`: `packages/shared/src/server/regions/regionalEventIdentity.ts:14-44`, `packages/shared/src/server/regions/processRegionalEventBatch.ts:122-177`, `worker/src/queues/traceReplicationQueue.ts:28-44`, `web/src/__tests__/server/regional-ingestion-api.servertest.ts:86-116`
- `learner_prompt`: Does the new regional event identity preserve the ingestion contract when the same SDK event is accepted through multiple regions or replayed after replication lag?

Expected answer:

- `identify`: The PR creates a fresh `regionalEventId` using `sourceRegion`, local `Date.now() + index`, and `randomUUID()`. Replication dedupe is keyed by `regionalEventId`, not by a globally stable client event identity, trace version, payload hash, or project-scoped sequence. The same original SDK event can be accepted through `eu` and `ap`, get two different regional IDs, pass dedupe twice, and be replicated twice. Ordering is also local to each region's clock, so cross-region updates to the same trace have no stable total order.
- `impact`: Retries through different edge regions can duplicate trace creates, span updates, scores, or dataset-run links. Cross-region updates can be applied in different orders in local and home stores, creating inconsistent trace trees, stale observation updates, duplicate cost/usage rows, and misleading public API responses. The bug will appear only under real-world retries, edge failover, clock skew, or delayed replication, which is exactly when multi-region systems must be most predictable.
- `fix_direction`: Define a global event identity and ordering contract before adding regions. Options include SDK-provided stable event IDs plus project-scoped idempotency, home-region sequenced trace versions, region-independent content hashes with operation type, or per-trace monotonic sequence numbers assigned by a single authority. Replication dedupe must use that stable identity, not the generated regional delivery ID. Reads and merges must use the same sequence/version contract.

Hints:

1. Follow the same original SDK event through two write regions.
2. Compare `originalEventId` with the key used for replication dedupe.
3. `Date.now()` in one region plus a UUID is a delivery ID, not a global event order.

### Flaw 2: Trace Reads Mix Local And Replicated Stores Without A Consistency Model

- `type`: `consistency_gap`
- `location`: `packages/shared/src/server/regions/regionalTraceReadModel.ts:30-119`, `web/src/pages/api/public/traces/[traceId].ts:57-112`, `packages/shared/src/server/regions/__tests__/regionalTraceReadModel.test.ts:52-86`, `docs/ingestion/multi-region-ingestion.md:60-82`
- `learner_prompt`: What consistency contract does the public trace read API now expose when local and replicated data disagree?

Expected answer:

- `identify`: The read model queries multiple regions, chooses a local trace row if available, then merges observations and scores from all found regions by ID. If a strong read is requested and the result is mixed, it only logs a warning and still returns mixed data. The public API exposes `consistency: "mixed"` but still returns a normal trace response with local trace fields, possibly replicated observations, and scores from another region. There is no documented read-your-write, home-region, bounded-staleness, or replica-watermark contract.
- `impact`: Users can see impossible traces: trace metadata from EU, observations from US replication, scores from AP, and latency/cost computed over a mix that never existed in any region. A support engineer may debug a trace that changes shape between reads. Strong-consistency callers get a successful response that violates the requested consistency. Dashboards, evals, exports, and deletion flows can make product decisions from partial data.
- `fix_direction`: Choose and document a read model. For example, route trace reads to the trace's authoritative home region, or serve local reads only up to a replica watermark, or return an explicit pending/lagged status when consistency cannot be satisfied. If merging replicas is required, merge by the same global sequence contract from flaw 1 and expose bounded staleness. Strong consistency should block, redirect, or fail explicitly rather than returning mixed data.

Hints:

1. Follow a read when replicas disagree about where the trace lives. Which response contract should a client be able to trust?
2. Find the behavior when `requireConsistentRead` is true and the data is mixed.
3. Compare the trace read contract with the consistency metadata added by the PR. Is metadata enough if the payload combines multiple sources?

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the missing global event identity/order contract. Answers that only say "UUIDs are random" are incomplete unless they connect that to cross-region retries, dedupe, replication, and trace merge ordering.

For flaw 2, a correct answer must identify the public read consistency problem. Answers that only say "replication may lag" are incomplete unless they explain how the API mixes local and replicated trace components and returns them as one coherent trace.

### Product-Level Change

The PR tries to reduce ingestion latency for global customers by accepting trace events close to the SDK and replicating them home later. That is a real product goal. But multi-region ingestion changes the system's deepest contracts: what does it mean for an event to be accepted, what order are trace updates applied in, which region owns the truth, and what does a trace read promise?

### Changed Contracts

- Event contract: accepted events now have regional delivery IDs in addition to original SDK IDs.
- Ordering contract: trace updates can arrive from multiple regional clocks.
- Queue contract: ingestion work is split into regional queues plus home-region replication.
- Storage contract: S3 paths and ClickHouse writes are region-aware.
- Read contract: public trace reads can combine local and replicated data.
- Consistency contract: strong reads are accepted but can return mixed data.
- Operational contract: replication lag and dedupe become customer-visible correctness concerns.

### Failure Modes

A mobile SDK sends a trace create to EU, times out, then retries through AP. Both regions accept the same original event. Each assigns a different regional event ID, so replication dedupe treats them as different events. The home region can now see duplicate trace updates or apply observation updates out of order.

A customer reads the trace immediately from EU. The trace row is local, one observation is local, another observation has already replicated from US, and scores are only visible from AP. The API returns `200` with a trace object that never existed as a coherent state.

### Reviewer Thought Process

A strong reviewer starts with the distributed state machine: SDK event accepted, regional durable write, regional merge, replication requested, home merge, read served. Then they ask which identifier follows the event across every transition and which sequence resolves conflicts.

The second move is to define the read model before reading code details. In multi-region systems, "read from both and merge" is not a neutral implementation detail. It is a product contract about staleness, authority, and correctness.

### Better Implementation Direction

Do not ship multi-region ingestion until the contracts are explicit:

- Define stable event identity across retries and regions.
- Define per-trace or per-project ordering/version semantics.
- Deduplicate replication by stable event identity, not regional delivery ID.
- Pick an authoritative write/read region or expose bounded-staleness replicas with watermarks.
- Make strong reads block, redirect, or fail explicitly when the consistency contract cannot be met.
- Add adversarial tests for cross-region retry, clock skew, delayed replication, deletion during lag, and mixed observation/score reads.

## Why This Case Exists

Multi-region PRs are where plausible AI-generated code is most dangerous. The code can have queues, S3, tests, metrics, and rollout docs while still missing the actual distributed-systems contract. This exercise trains the reviewer to find the identity, ordering, and consistency model before trusting the implementation details.
