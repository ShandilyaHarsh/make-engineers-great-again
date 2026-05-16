# TS-081: Langfuse Generic Event Processor Abstraction

## Metadata

- `id`: TS-081
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: ingestion event validation, trace/observation queueing, metrics ingestion, ClickHouse writes, queue workers, shared server exports, tests, API docs
- `mode`: synthetic_degraded
- `difficulty`: 9
- `target_diff_lines`: 2500
- `flaw_count`: 2

## PR Description Shown To Learner

This PR introduces a shared `GenericEventProcessor` that handles traces, observations, scores, and new product metrics through one event-processing path.

Today the ingestion path has specialized code: `processEventBatch` validates Langfuse ingestion events, groups trace/observation data by event body, uploads those groups to S3, and enqueues ingestion jobs. OTel ingestion has its own processor. Metrics are being added as a new product event stream. This PR claims the existing code is too duplicated, so it creates a generic event envelope, a generic processor, a generic queue, and a metrics API endpoint.

The PR claims that traces and metrics can share the same event lifecycle: validate, normalize, persist payload, enqueue, and write to ClickHouse.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `processEventBatch` validates each ingestion event with `createIngestionEventSchema`, applies event-type authorization, removes SDK logs, sorts the batch, groups by `eventBodyId`, uploads grouped data to S3, and enqueues ingestion jobs keyed by `projectId-eventBodyId`.
- The ingestion worker assumes queue payloads are already domain-specific commands: event type, event body id, S3 file key, auth scope, and optional forwarding flags.
- The ingestion worker downloads all S3 event files for a trace/observation entity, sets a seen-event cache, then lets `IngestionService.mergeAndWrite` perform domain-specific merge/write behavior.
- OTel ingestion has different propagation headers, observation handling, and direct processor behavior.
- Metrics-style events have different cardinality, aggregation, deduplication, retention, and query patterns than trace events.
- Ingestion is a product boundary, not a generic transport boundary: the public API contract, auth scope, queue semantics, and storage semantics all matter.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/shared/src/server/events/genericEventTypes.ts`
- `packages/shared/src/server/events/genericEventProcessor.ts`
- `packages/shared/src/server/events/genericEventStorage.ts`
- `packages/shared/src/server/events/genericEventClickhouseSchema.ts`
- `packages/shared/src/server/ingestion/processEventBatch.ts`
- `packages/shared/src/server/redis/genericEventQueue.ts`
- `packages/shared/src/server/queues.ts`
- `packages/shared/src/server/index.ts`
- `worker/src/queues/genericEventQueue.ts`
- `worker/src/queues/workerManager.ts`
- `web/src/pages/api/public/metrics.ts`
- `packages/shared/src/server/events/__tests__/genericEventProcessor.test.ts`
- `packages/shared/src/server/events/__tests__/genericEventStorage.test.ts`
- `worker/src/queues/__tests__/genericEventQueue.test.ts`
- `web/src/__tests__/server/metrics-api.servertest.ts`
- `fern/apis/server/definition/metrics.yml`
- `docs/ingestion/generic-event-processor.md`
- `docs/ingestion/metrics-cardinality.md`
- `docs/ingestion/generic-event-rollout.md`

The line references below use synthetic PR line numbers. This is intentionally a large architecture review case: the flaw is not a bad syntax choice, it is a bad abstraction boundary.

## Diff

```diff
diff --git a/packages/shared/src/server/events/genericEventTypes.ts b/packages/shared/src/server/events/genericEventTypes.ts
new file mode 100644
index 0000000000..1ed62f5977
--- /dev/null
+++ b/packages/shared/src/server/events/genericEventTypes.ts
@@ -0,0 +1,338 @@
+import { z } from "zod";
+import { eventTypes } from "../ingestion/types";
+
+export const GenericEventKind = z.enum([
+  "trace",
+  "observation",
+  "score",
+  "dataset-run-item",
+  "metric",
+]);
+
+export type GenericEventKind = z.infer<typeof GenericEventKind>;
+
+export const GenericEventAuthScope = z.object({
+  projectId: z.string(),
+  orgId: z.string().optional(),
+  accessLevel: z.enum(["project", "scores"]).optional(),
+  plan: z.string().optional(),
+});
+
+export type GenericEventAuthScope = z.infer<typeof GenericEventAuthScope>;
+
+export const GenericEventSource = z.enum(["api", "otel", "internal", "metric"]);
+
+export type GenericEventSource = z.infer<typeof GenericEventSource>;
+
+export const GenericEventEnvelope = z.object({
+  id: z.string(),
+  projectId: z.string(),
+  kind: GenericEventKind,
+  source: GenericEventSource,
+  entityId: z.string(),
+  eventType: z.string(),
+  timestamp: z.coerce.date(),
+  receivedAt: z.coerce.date(),
+  authScope: GenericEventAuthScope,
+  body: z.record(z.string(), z.unknown()),
+  attributes: z.record(z.string(), z.unknown()).optional(),
+  tags: z.record(z.string(), z.string()).optional(),
+  retentionDays: z.number().int().positive().optional(),
+  shouldForwardToEventsTable: z.boolean().optional(),
+});
+
+export type GenericEventEnvelope = z.infer<typeof GenericEventEnvelope>;
+
+export const GenericEventBatch = z.object({
+  projectId: z.string(),
+  source: GenericEventSource,
+  authScope: GenericEventAuthScope,
+  events: z.array(GenericEventEnvelope).min(1),
+  options: z
+    .object({
+      delayMs: z.number().int().nonnegative().nullable().optional(),
+      forwardToEventsTable: z.boolean().optional(),
+      retainPayloads: z.boolean().optional(),
+      retentionDays: z.number().int().positive().optional(),
+    })
+    .optional(),
+});
+
+export type GenericEventBatch = z.infer<typeof GenericEventBatch>;
+
+export const GenericEventQueuePayload = z.object({
+  projectId: z.string(),
+  source: GenericEventSource,
+  kind: GenericEventKind,
+  entityId: z.string(),
+  eventIds: z.array(z.string()),
+  fileKey: z.string().optional(),
+  bucketPath: z.string().optional(),
+  authScope: GenericEventAuthScope,
+  options: z
+    .object({
+      delayMs: z.number().int().nonnegative().nullable().optional(),
+      forwardToEventsTable: z.boolean().optional(),
+      retentionDays: z.number().int().positive().optional(),
+    })
+    .optional(),
+});
+
+export type GenericEventQueuePayload = z.infer<typeof GenericEventQueuePayload>;
+
+export const MetricEventInput = z.object({
+  id: z.string().optional(),
+  name: z.string().min(1),
+  timestamp: z.string().datetime().optional(),
+  value: z.number(),
+  unit: z.string().optional(),
+  tags: z.record(z.string(), z.string()).optional(),
+  attributes: z.record(z.string(), z.unknown()).optional(),
+});
+
+export type MetricEventInput = z.infer<typeof MetricEventInput>;
+
+export const LangfuseIngestionEventTypeToGenericKind: Record<
+  string,
+  GenericEventKind
+> = {
+  [eventTypes.TRACE_CREATE]: "trace",
+  [eventTypes.SPAN_CREATE]: "observation",
+  [eventTypes.SPAN_UPDATE]: "observation",
+  [eventTypes.GENERATION_CREATE]: "observation",
+  [eventTypes.GENERATION_UPDATE]: "observation",
+  [eventTypes.EVENT_CREATE]: "observation",
+  [eventTypes.SCORE_CREATE]: "score",
+  [eventTypes.DATASET_RUN_ITEM_CREATE]: "dataset-run-item",
+  [eventTypes.OBSERVATION_CREATE]: "observation",
+  [eventTypes.OBSERVATION_UPDATE]: "observation",
+};
+
+export const metricToGenericEvent = ({
+  projectId,
+  authScope,
+  input,
+}: {
+  projectId: string;
+  authScope: GenericEventAuthScope;
+  input: MetricEventInput;
+}): GenericEventEnvelope => {
+  const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
+  const tags = input.tags ?? {};
+  const tagKey = Object.entries(tags)
+    .sort(([a], [b]) => a.localeCompare(b))
+    .map(([key, value]) => `${key}:${value}`)
+    .join("|");
+  const entityId = `${input.name}:${tagKey || "no-tags"}`;
+
+  return {
+    id: input.id ?? `${entityId}:${timestamp.getTime()}`,
+    projectId,
+    kind: "metric",
+    source: "metric",
+    entityId,
+    eventType: "metric-record",
+    timestamp,
+    receivedAt: new Date(),
+    authScope,
+    body: {
+      name: input.name,
+      value: input.value,
+      unit: input.unit,
+    },
+    attributes: input.attributes,
+    tags,
+    retentionDays: 30,
+    shouldForwardToEventsTable: true,
+  };
+};
diff --git a/packages/shared/src/server/events/genericEventStorage.ts b/packages/shared/src/server/events/genericEventStorage.ts
new file mode 100644
index 0000000000..714f2df5ad
--- /dev/null
+++ b/packages/shared/src/server/events/genericEventStorage.ts
@@ -0,0 +1,282 @@
+import { randomUUID } from "crypto";
+import { env } from "../../env";
+import { getClickhouseEntityType } from "../clickhouse/schemaUtils";
+import { logger } from "../logger";
+import {
+  StorageService,
+  StorageServiceFactory,
+} from "../services/StorageService";
+import {
+  GenericEventEnvelope,
+  GenericEventKind,
+  GenericEventQueuePayload,
+} from "./genericEventTypes";
+
+let storageClient: StorageService | undefined;
+
+const getStorageClient = () => {
+  if (!storageClient) {
+    storageClient = StorageServiceFactory.getInstance({
+      bucketName: env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET,
+      accessKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID,
+      secretAccessKey: env.LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY,
+      endpoint: env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT,
+      region: env.LANGFUSE_S3_EVENT_UPLOAD_REGION,
+      forcePathStyle: env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
+      awsSse: env.LANGFUSE_S3_EVENT_UPLOAD_SSE,
+      awsSseKmsKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_SSE_KMS_KEY_ID,
+    });
+  }
+
+  return storageClient;
+};
+
+export const persistGenericEventGroup = async ({
+  projectId,
+  kind,
+  entityId,
+  events,
+  authScope,
+  retentionDays,
+}: {
+  projectId: string;
+  kind: GenericEventKind;
+  entityId: string;
+  events: GenericEventEnvelope[];
+  authScope: GenericEventEnvelope["authScope"];
+  retentionDays?: number;
+}): Promise<GenericEventQueuePayload> => {
+  const fileKey = randomUUID();
+  const bucketPath = buildGenericEventPath({
+    projectId,
+    kind,
+    entityId,
+    fileKey,
+  });
+
+  const storage = getStorageClient();
+  await storage.uploadJson(bucketPath, events);
+
+  logger.debug("Persisted generic event group", {
+    projectId,
+    kind,
+    entityId,
+    fileKey,
+    eventCount: events.length,
+  });
+
+  return {
+    projectId,
+    source: events[0]?.source ?? "api",
+    kind,
+    entityId,
+    eventIds: events.map((event) => event.id),
+    fileKey,
+    bucketPath,
+    authScope,
+    options: {
+      retentionDays,
+      forwardToEventsTable: events.some(
+        (event) => event.shouldForwardToEventsTable,
+      ),
+    },
+  };
+};
+
+export const buildGenericEventPath = ({
+  projectId,
+  kind,
+  entityId,
+  fileKey,
+}: {
+  projectId: string;
+  kind: GenericEventKind;
+  entityId: string;
+  fileKey: string;
+}) => {
+  const entityType =
+    kind === "metric" ? "metric" : getClickhouseEntityType(kind as never);
+  return `${env.LANGFUSE_S3_EVENT_UPLOAD_PREFIX}${projectId}/${entityType}/${entityId}/${fileKey}.json`;
+};
+
+export const loadGenericEventGroup = async (
+  payload: GenericEventQueuePayload,
+): Promise<GenericEventEnvelope[]> => {
+  if (!payload.bucketPath) {
+    return [];
+  }
+
+  const storage = getStorageClient();
+  const raw = await storage.download(payload.bucketPath);
+  const parsed = JSON.parse(raw);
+  return Array.isArray(parsed) ? parsed : [parsed];
+};
diff --git a/packages/shared/src/server/events/genericEventClickhouseSchema.ts b/packages/shared/src/server/events/genericEventClickhouseSchema.ts
new file mode 100644
index 0000000000..77b99bcafd
--- /dev/null
+++ b/packages/shared/src/server/events/genericEventClickhouseSchema.ts
@@ -0,0 +1,286 @@
+import { z } from "zod";
+import { GenericEventEnvelope, GenericEventKind } from "./genericEventTypes";
+
+export const GenericTraceEventRow = z.object({
+  id: z.string(),
+  project_id: z.string(),
+  entity_id: z.string(),
+  type: z.string(),
+  timestamp: z.number(),
+  body: z.string(),
+  attributes: z.string(),
+});
+
+export type GenericTraceEventRow = z.infer<typeof GenericTraceEventRow>;
+
+export const GenericMetricEventRow = z.object({
+  id: z.string(),
+  project_id: z.string(),
+  metric_name: z.unknown(),
+  metric_value: z.unknown(),
+  unit: z.unknown(),
+  tags: z.string(),
+  timestamp: z.number(),
+  ttl_days: z.number(),
+});
+
+export type GenericMetricEventRow = z.infer<typeof GenericMetricEventRow>;
+
+export const GenericEventTableConfig = z.object({
+  kind: GenericEventKind,
+  tableName: z.string(),
+  ttlColumn: z.string().optional(),
+  partitionBy: z.string(),
+  orderBy: z.array(z.string()),
+  dedupeKey: z.array(z.string()),
+  defaultRetentionDays: z.number(),
+});
+
+export type GenericEventTableConfig = z.infer<typeof GenericEventTableConfig>;
+
+export const GENERIC_EVENT_TABLES: Record<
+  GenericEventKind,
+  GenericEventTableConfig
+> = {
+  trace: {
+    kind: "trace",
+    tableName: "generic_trace_events",
+    ttlColumn: "timestamp",
+    partitionBy: "toYYYYMM(toDateTime(timestamp / 1000))",
+    orderBy: ["project_id", "entity_id", "timestamp", "id"],
+    dedupeKey: ["project_id", "entity_id", "id"],
+    defaultRetentionDays: 365,
+  },
+  observation: {
+    kind: "observation",
+    tableName: "generic_trace_events",
+    ttlColumn: "timestamp",
+    partitionBy: "toYYYYMM(toDateTime(timestamp / 1000))",
+    orderBy: ["project_id", "entity_id", "timestamp", "id"],
+    dedupeKey: ["project_id", "entity_id", "id"],
+    defaultRetentionDays: 365,
+  },
+  score: {
+    kind: "score",
+    tableName: "generic_trace_events",
+    ttlColumn: "timestamp",
+    partitionBy: "toYYYYMM(toDateTime(timestamp / 1000))",
+    orderBy: ["project_id", "entity_id", "timestamp", "id"],
+    dedupeKey: ["project_id", "entity_id", "id"],
+    defaultRetentionDays: 365,
+  },
+  "dataset-run-item": {
+    kind: "dataset-run-item",
+    tableName: "generic_trace_events",
+    ttlColumn: "timestamp",
+    partitionBy: "toYYYYMM(toDateTime(timestamp / 1000))",
+    orderBy: ["project_id", "entity_id", "timestamp", "id"],
+    dedupeKey: ["project_id", "entity_id", "id"],
+    defaultRetentionDays: 365,
+  },
+  metric: {
+    kind: "metric",
+    tableName: "generic_metric_events",
+    ttlColumn: "timestamp",
+    partitionBy: "toYYYYMM(toDateTime(timestamp / 1000))",
+    orderBy: ["project_id", "metric_name", "timestamp", "id"],
+    dedupeKey: ["project_id", "metric_name", "id"],
+    defaultRetentionDays: 30,
+  },
+};
+
+export const getGenericEventTableConfig = (kind: GenericEventKind) => {
+  return GENERIC_EVENT_TABLES[kind];
+};
+
+export const toGenericTraceRow = (
+  event: GenericEventEnvelope,
+): GenericTraceEventRow => {
+  return {
+    id: event.id,
+    project_id: event.projectId,
+    entity_id: event.entityId,
+    type: event.eventType,
+    timestamp: event.timestamp.getTime(),
+    body: JSON.stringify(event.body),
+    attributes: JSON.stringify({
+      ...(event.attributes ?? {}),
+      source: event.source,
+      kind: event.kind,
+      tags: event.tags ?? {},
+    }),
+  };
+};
+
+export const toGenericMetricRow = (
+  event: GenericEventEnvelope,
+): GenericMetricEventRow => {
+  return {
+    id: event.id,
+    project_id: event.projectId,
+    metric_name: event.body.name,
+    metric_value: event.body.value,
+    unit: event.body.unit ?? null,
+    tags: JSON.stringify(event.tags ?? {}),
+    timestamp: event.timestamp.getTime(),
+    ttl_days:
+      event.retentionDays ??
+      getGenericEventTableConfig("metric").defaultRetentionDays,
+  };
+};
+
+export const buildGenericInsertBatch = (events: GenericEventEnvelope[]) => {
+  const traceRows: GenericTraceEventRow[] = [];
+  const metricRows: GenericMetricEventRow[] = [];
+
+  for (const event of events) {
+    if (event.kind === "metric") {
+      metricRows.push(toGenericMetricRow(event));
+    } else {
+      traceRows.push(toGenericTraceRow(event));
+    }
+  }
+
+  return {
+    traceRows,
+    metricRows,
+  };
+};
diff --git a/packages/shared/src/server/events/genericEventProcessor.ts b/packages/shared/src/server/events/genericEventProcessor.ts
new file mode 100644
index 0000000000..8ed4f0ec04
--- /dev/null
+++ b/packages/shared/src/server/events/genericEventProcessor.ts
@@ -0,0 +1,760 @@
+import { randomUUID } from "crypto";
+import { z } from "zod";
+import {
+  InvalidRequestError,
+  UnauthorizedError,
+} from "../../errors";
+import { AuthHeaderValidVerificationResultIngestion } from "../auth/types";
+import { clickhouseClient } from "../clickhouse/client";
+import {
+  getCurrentSpan,
+  recordDistribution,
+  recordIncrement,
+  traceException,
+} from "../instrumentation";
+import { logger } from "../logger";
+import { QueueJobs } from "../queues";
+import { GenericEventQueue } from "../redis/genericEventQueue";
+import { eventTypes, createIngestionEventSchema } from "../ingestion/types";
+import {
+  GenericEventBatch,
+  GenericEventEnvelope,
+  GenericEventKind,
+  LangfuseIngestionEventTypeToGenericKind,
+  MetricEventInput,
+  metricToGenericEvent,
+} from "./genericEventTypes";
+import { persistGenericEventGroup } from "./genericEventStorage";
+
+type GenericEventProcessorResult = {
+  successes: { id: string; status: number }[];
+  errors: {
+    id: string;
+    status: number;
+    message?: string;
+    error?: string;
+  }[];
+};
+
+type ProcessGenericInputOptions = {
+  source?: "api" | "otel" | "internal" | "metric";
+  delayMs?: number | null;
+  isLangfuseInternal?: boolean;
+  forwardToEventsTable?: boolean;
+  retainPayloads?: boolean;
+  retentionDays?: number;
+};
+
+export class GenericEventProcessor {
+  async processIngestionEvents({
+    input,
+    authCheck,
+    options = {},
+  }: {
+    input: unknown[];
+    authCheck: AuthHeaderValidVerificationResultIngestion;
+    options?: ProcessGenericInputOptions;
+  }): Promise<GenericEventProcessorResult> {
+    const currentSpan = getCurrentSpan();
+    currentSpan?.setAttribute("langfuse.generic_event.source", "ingestion");
+    currentSpan?.setAttribute(
+      "langfuse.generic_event.batch_size",
+      input.length,
+    );
+
+    if (!authCheck.scope.projectId) {
+      throw new UnauthorizedError("Missing project ID");
+    }
+
+    const ingestionSchema = createIngestionEventSchema(
+      options.isLangfuseInternal ?? false,
+    );
+    const validationErrors: { id: string; error: unknown }[] = [];
+    const authenticationErrors: { id: string; error: unknown }[] = [];
+    const events: GenericEventEnvelope[] = [];
+
+    for (const event of input) {
+      const parsed = ingestionSchema.safeParse(event);
+      if (!parsed.success) {
+        validationErrors.push({
+          id: inferEventId(event),
+          error: new InvalidRequestError(parsed.error.message),
+        });
+        continue;
+      }
+
+      if (!this.isAuthorized(parsed.data.type, authCheck)) {
+        authenticationErrors.push({
+          id: parsed.data.id,
+          error: new UnauthorizedError("Access Scope Denied"),
+        });
+        continue;
+      }
+
+      if (parsed.data.type === eventTypes.SDK_LOG) {
+        logger.info("SDK Log Event", { event: parsed.data });
+        continue;
+      }
+
+      events.push(
+        this.toGenericEvent({
+          event: parsed.data,
+          authCheck,
+          source: options.source ?? "api",
+          forwardToEventsTable: options.forwardToEventsTable,
+          retentionDays: options.retentionDays,
+        }),
+      );
+    }
+
+    if (events.length === 0) {
+      return aggregateGenericBatchResult(
+        [...validationErrors, ...authenticationErrors],
+        [],
+      );
+    }
+
+    const result = await this.processGenericBatch({
+      projectId: authCheck.scope.projectId,
+      source: options.source ?? "api",
+      authScope: {
+        projectId: authCheck.scope.projectId,
+        orgId: authCheck.scope.orgId,
+        accessLevel: authCheck.scope.accessLevel,
+        plan: authCheck.scope.plan,
+      },
+      events,
+      options,
+    });
+
+    return aggregateGenericBatchResult(
+      [...validationErrors, ...authenticationErrors],
+      result.successes,
+    );
+  }
+
+  async processMetricEvents({
+    input,
+    authCheck,
+  }: {
+    input: MetricEventInput[];
+    authCheck: AuthHeaderValidVerificationResultIngestion;
+  }): Promise<GenericEventProcessorResult> {
+    if (!authCheck.scope.projectId) {
+      throw new UnauthorizedError("Missing project ID");
+    }
+
+    if (authCheck.scope.accessLevel === "scores") {
+      throw new UnauthorizedError("Access Scope Denied");
+    }
+
+    const events = input.map((event) =>
+      metricToGenericEvent({
+        projectId: authCheck.scope.projectId!,
+        authScope: {
+          projectId: authCheck.scope.projectId!,
+          orgId: authCheck.scope.orgId,
+          accessLevel: authCheck.scope.accessLevel,
+          plan: authCheck.scope.plan,
+        },
+        input: event,
+      }),
+    );
+
+    return await this.processGenericBatch({
+      projectId: authCheck.scope.projectId,
+      source: "metric",
+      authScope: {
+        projectId: authCheck.scope.projectId,
+        orgId: authCheck.scope.orgId,
+        accessLevel: authCheck.scope.accessLevel,
+        plan: authCheck.scope.plan,
+      },
+      events,
+      options: {
+        source: "metric",
+        delayMs: 0,
+        forwardToEventsTable: true,
+        retainPayloads: true,
+        retentionDays: 30,
+      },
+    });
+  }
+
+  async processGenericBatch(batch: GenericEventBatch): Promise<{
+    successes: { id: string; status: number }[];
+  }> {
+    const parsed = GenericEventBatch.safeParse(batch);
+    if (!parsed.success) {
+      traceException(parsed.error);
+      throw new InvalidRequestError(parsed.error.message);
+    }
+
+    const projectId = parsed.data.projectId;
+    const options = parsed.data.options ?? {};
+    const queue = GenericEventQueue.getInstance({ shardingKey: projectId });
+
+    if (!queue) {
+      throw new Error("Generic event queue is not available");
+    }
+
+    recordIncrement("langfuse.generic_event.ingested", parsed.data.events.length, {
+      source: parsed.data.source,
+    });
+    recordDistribution(
+      "langfuse.generic_event.batch_size",
+      parsed.data.events.length,
+      { source: parsed.data.source },
+    );
+
+    const grouped = this.groupEvents(parsed.data.events);
+    const successes: { id: string; status: number }[] = [];
+
+    for (const group of grouped) {
+      const queuePayload = await persistGenericEventGroup({
+        projectId,
+        kind: group.kind,
+        entityId: group.entityId,
+        events: group.events,
+        authScope: parsed.data.authScope,
+        retentionDays: options.retentionDays,
+      });
+
+      await queue.add(QueueJobs.GenericEventJob, {
+        id: randomUUID(),
+        timestamp: new Date(),
+        name: QueueJobs.GenericEventJob,
+        payload: {
+          ...queuePayload,
+          options: {
+            ...queuePayload.options,
+            delayMs: options.delayMs ?? null,
+          },
+        },
+      });
+
+      successes.push(
+        ...group.events.map((event) => ({
+          id: event.id,
+          status: 202,
+        })),
+      );
+    }
+
+    return { successes };
+  }
+
+  async writeGenericEvents(events: GenericEventEnvelope[]) {
+    const traceRows = events
+      .filter((event) => event.kind === "trace" || event.kind === "observation")
+      .map((event) => ({
+        id: event.id,
+        project_id: event.projectId,
+        entity_id: event.entityId,
+        type: event.eventType,
+        timestamp: event.timestamp.getTime(),
+        body: JSON.stringify(event.body),
+        attributes: JSON.stringify(event.attributes ?? {}),
+      }));
+
+    const metricRows = events
+      .filter((event) => event.kind === "metric")
+      .map((event) => ({
+        id: event.id,
+        project_id: event.projectId,
+        metric_name: event.body.name,
+        metric_value: event.body.value,
+        unit: event.body.unit ?? null,
+        tags: JSON.stringify(event.tags ?? {}),
+        timestamp: event.timestamp.getTime(),
+        ttl_days: event.retentionDays ?? 30,
+      }));
+
+    if (traceRows.length > 0) {
+      await clickhouseClient.insert({
+        table: "generic_trace_events",
+        values: traceRows,
+        format: "JSONEachRow",
+      });
+    }
+
+    if (metricRows.length > 0) {
+      await clickhouseClient.insert({
+        table: "generic_metric_events",
+        values: metricRows,
+        format: "JSONEachRow",
+      });
+    }
+  }
+
+  private toGenericEvent({
+    event,
+    authCheck,
+    source,
+    forwardToEventsTable,
+    retentionDays,
+  }: {
+    event: z.infer<ReturnType<typeof createIngestionEventSchema>>;
+    authCheck: AuthHeaderValidVerificationResultIngestion;
+    source: "api" | "otel" | "internal" | "metric";
+    forwardToEventsTable?: boolean;
+    retentionDays?: number;
+  }): GenericEventEnvelope {
+    const kind =
+      LangfuseIngestionEventTypeToGenericKind[event.type] ?? "observation";
+    const entityId =
+      typeof event.body === "object" &&
+      event.body &&
+      "id" in event.body &&
+      typeof event.body.id === "string"
+        ? event.body.id
+        : event.id;
+
+    return {
+      id: event.id,
+      projectId: authCheck.scope.projectId!,
+      kind,
+      source,
+      entityId,
+      eventType: event.type,
+      timestamp: new Date(event.timestamp),
+      receivedAt: new Date(),
+      authScope: {
+        projectId: authCheck.scope.projectId!,
+        orgId: authCheck.scope.orgId,
+        accessLevel: authCheck.scope.accessLevel,
+        plan: authCheck.scope.plan,
+      },
+      body: event.body as Record<string, unknown>,
+      attributes: {
+        langfuseEventType: event.type,
+      },
+      retentionDays,
+      shouldForwardToEventsTable:
+        forwardToEventsTable ?? kind === "metric" || kind === "trace",
+    };
+  }
+
+  private groupEvents(events: GenericEventEnvelope[]) {
+    const sorted = [...events].sort((a, b) => {
+      if (a.entityId === b.entityId) {
+        return a.timestamp.getTime() - b.timestamp.getTime();
+      }
+      return a.entityId.localeCompare(b.entityId);
+    });
+
+    const groups = new Map<
+      string,
+      {
+        kind: GenericEventKind;
+        entityId: string;
+        events: GenericEventEnvelope[];
+      }
+    >();
+
+    for (const event of sorted) {
+      const key = `${event.kind}:${event.entityId}`;
+      const existing = groups.get(key);
+      if (existing) {
+        existing.events.push(event);
+      } else {
+        groups.set(key, {
+          kind: event.kind,
+          entityId: event.entityId,
+          events: [event],
+        });
+      }
+    }
+
+    return [...groups.values()];
+  }
+
+  private isAuthorized(
+    eventType: string,
+    authCheck: AuthHeaderValidVerificationResultIngestion,
+  ) {
+    if (authCheck.scope.accessLevel !== "scores") {
+      return true;
+    }
+
+    return eventType === eventTypes.SCORE_CREATE;
+  }
+}
+
+const inferEventId = (event: unknown) => {
+  if (typeof event === "object" && event && "id" in event) {
+    const id = (event as { id?: unknown }).id;
+    return typeof id === "string" ? id : "unknown";
+  }
+
+  return "unknown";
+};
+
+const aggregateGenericBatchResult = (
+  errors: { id: string; error: unknown }[],
+  successes: { id: string; status: number }[],
+) => {
+  return {
+    successes,
+    errors: errors.map(({ id, error }) => ({
+      id,
+      status:
+        error instanceof UnauthorizedError
+          ? 401
+          : error instanceof InvalidRequestError
+            ? 400
+            : 500,
+      message: error instanceof Error ? error.message : "Unknown error",
+      error: error instanceof Error ? error.name : "UnknownError",
+    })),
+  };
+};
diff --git a/packages/shared/src/server/ingestion/processEventBatch.ts b/packages/shared/src/server/ingestion/processEventBatch.ts
index 6937d502d3..31f8220a54 100644
--- a/packages/shared/src/server/ingestion/processEventBatch.ts
+++ b/packages/shared/src/server/ingestion/processEventBatch.ts
@@ -1,36 +1,10 @@
-import { randomUUID } from "crypto";
-import { z } from "zod";
-
-import { env } from "../../env";
 import {
-  InvalidRequestError,
-  LangfuseNotFoundError,
-  UnauthorizedError,
-} from "../../errors";
+  AuthHeaderValidVerificationResultIngestion,
+  GenericEventProcessor,
+} from "../index";
-import { AuthHeaderValidVerificationResultIngestion } from "../auth/types";
-import { getClickhouseEntityType } from "../clickhouse/schemaUtils";
-import {
-  getCurrentSpan,
-  instrumentAsync,
-  recordDistribution,
-  recordIncrement,
-  traceException,
-} from "../instrumentation";
-import { logger } from "../logger";
-import { QueueJobs } from "../queues";
-import { IngestionQueue } from "../redis/ingestionQueue";
-import { redis } from "../redis/redis";
-import {
-  eventTypes,
-  createIngestionEventSchema,
-  IngestionEventType,
-} from "./types";
-import {
-  StorageService,
-  StorageServiceFactory,
-} from "../services/StorageService";
-import { isTraceIdInSample } from "./sampling";
-import {
-  isS3SlowDownError,
-  markProjectS3Slowdown,
-} from "../redis/s3SlowdownTracking";
 
 type ProcessEventBatchOptions = {
   delay?: number | null;
@@ -104,221 +78,18 @@ export const processEventBatch = async (
   }[];
 }> => {
   if (input.length === 0) {
     return { successes: [], errors: [] };
   }
-  const {
-    delay = null,
-    source = "api",
-    isLangfuseInternal = false,
-    forwardToEventsTable,
-  } = options;
-
-  // existing validation, auth, sorting, S3 grouping, queue fan-out removed
-  // by this PR in favor of the generic processor
-
-  return aggregateBatchResult([...validationErrors, ...authenticationErrors], sortedBatch);
+  return await new GenericEventProcessor().processIngestionEvents({
+    input,
+    authCheck,
+    options: {
+      source: options.source ?? "api",
+      delayMs: options.delay ?? null,
+      isLangfuseInternal: options.isLangfuseInternal,
+      forwardToEventsTable: options.forwardToEventsTable,
+      retainPayloads: true,
+    },
+  });
 };
diff --git a/packages/shared/src/server/redis/genericEventQueue.ts b/packages/shared/src/server/redis/genericEventQueue.ts
new file mode 100644
index 0000000000..892b1467e0
--- /dev/null
+++ b/packages/shared/src/server/redis/genericEventQueue.ts
@@ -0,0 +1,188 @@
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
+export class GenericEventQueue {
+  private static instances: Map<
+    number,
+    Queue<TQueueJobTypes[QueueName.GenericEventQueue]> | null
+  > = new Map();
+
+  public static getShardNames() {
+    return Array.from(
+      { length: env.LANGFUSE_INGESTION_QUEUE_SHARD_COUNT },
+      (_, i) => `${QueueName.GenericEventQueue}${i > 0 ? `-${i}` : ""}`,
+    );
+  }
+
+  static getShardIndexFromShardName(shardName: string | undefined) {
+    if (!shardName) return null;
+    const shardIndex =
+      shardName === QueueName.GenericEventQueue
+        ? 0
+        : parseInt(
+            shardName.replace(`${QueueName.GenericEventQueue}-`, ""),
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
+  }): Queue<TQueueJobTypes[QueueName.GenericEventQueue]> | null {
+    const shardIndex =
+      GenericEventQueue.getShardIndexFromShardName(shardName) ??
+      (env.REDIS_CLUSTER_ENABLED === "true" && shardingKey
+        ? getShardIndex(shardingKey, env.LANGFUSE_INGESTION_QUEUE_SHARD_COUNT)
+        : 0);
+
+    if (GenericEventQueue.instances.has(shardIndex)) {
+      return GenericEventQueue.instances.get(shardIndex) || null;
+    }
+
+    const newRedis = createNewRedisInstance({
+      enableOfflineQueue: false,
+      ...redisQueueRetryOptions,
+    });
+
+    const name = `${QueueName.GenericEventQueue}${shardIndex > 0 ? `-${shardIndex}` : ""}`;
+    const queueInstance = newRedis
+      ? new Queue<TQueueJobTypes[QueueName.GenericEventQueue]>(name, {
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
+      logger.error(`GenericEventQueue shard ${shardIndex} error`, err);
+    });
+
+    GenericEventQueue.instances.set(shardIndex, queueInstance);
+    return queueInstance;
+  }
+}
diff --git a/packages/shared/src/server/queues.ts b/packages/shared/src/server/queues.ts
index 9f492cf6fd..96a72d6bdd 100644
--- a/packages/shared/src/server/queues.ts
+++ b/packages/shared/src/server/queues.ts
@@ -331,6 +331,7 @@ export enum QueueName {
   OtelIngestionQueue = "otel-ingestion-queue",
   OtelIngestionSecondaryQueue = "secondary-otel-ingestion-queue",
   IngestionQueue = "ingestion-queue",
+  GenericEventQueue = "generic-event-queue",
   IngestionSecondaryQueue = "secondary-ingestion-queue",
   TraceUpsert = "trace-upsert",
   TraceDelete = "trace-delete",
@@ -370,6 +371,7 @@ export enum QueueJobs {
   OtelIngestionJob = "otel-ingestion-job",
   IngestionJob = "ingestion-job",
+  GenericEventJob = "generic-event-job",
   ExperimentCreateJob = "experiment-create",
   PostHogIntegrationProcessingJob = "posthog-integration-processing-job",
   MixpanelIntegrationProcessingJob = "mixpanel-integration-processing-job",
@@ -472,6 +474,20 @@ export type TQueueJobTypes = {
     };
     name: QueueJobs.IngestionJob;
   };
+  [QueueName.GenericEventQueue]: {
+    id: string;
+    timestamp: Date;
+    name: QueueJobs.GenericEventJob;
+    payload: {
+      projectId: string;
+      source: "api" | "otel" | "internal" | "metric";
+      kind: "trace" | "observation" | "score" | "dataset-run-item" | "metric";
+      entityId: string;
+      eventIds: string[];
+      fileKey?: string;
+      bucketPath?: string;
+      authScope: { projectId: string; orgId?: string; accessLevel?: string };
+    };
+  };
   [QueueName.IngestionSecondaryQueue]: {
     id: string;
     timestamp: Date;
diff --git a/packages/shared/src/server/index.ts b/packages/shared/src/server/index.ts
index 0a4680f1d3..4fd83eb009 100644
--- a/packages/shared/src/server/index.ts
+++ b/packages/shared/src/server/index.ts
@@ -49,6 +49,9 @@ export * from "./ingestion/types";
 export * from "./ingestion/processEventBatch";
 export * from "../server/ingestion/validateAndInflateScore";
 export * from "./ingestion/extractToolsBackend";
+export * from "./events/genericEventTypes";
+export * from "./events/genericEventProcessor";
+export * from "./events/genericEventStorage";
 export * from "../server/ingestion/sampling";
 export * from "./otel/attributes";
 export * from "./otel/OtelIngestionProcessor";
@@ -72,6 +75,7 @@ export * from "./redis/batchActionQueue";
 export * from "./redis/batchExport";
 export * from "./redis/cloudUsageMeteringQueue";
 export * from "./redis/ingestionQueue";
+export * from "./redis/genericEventQueue";
 export * from "./redis/otelIngestionQueue";
 export * from "./redis/eventPropagationQueue";
 export * from "./redis/cloudUsageMeteringQueue";
diff --git a/worker/src/queues/genericEventQueue.ts b/worker/src/queues/genericEventQueue.ts
new file mode 100644
index 0000000000..1decc322a4
--- /dev/null
+++ b/worker/src/queues/genericEventQueue.ts
@@ -0,0 +1,352 @@
+import { Job, Processor } from "bullmq";
+import {
+  GenericEventProcessor,
+  GenericEventQueuePayload,
+  loadGenericEventGroup,
+  logger,
+  QueueName,
+  recordHistogram,
+  recordIncrement,
+  TQueueJobTypes,
+  traceException,
+} from "@langfuse/shared/src/server";
+
+export const genericEventQueueProcessor: Processor = async (
+  job: Job<TQueueJobTypes[QueueName.GenericEventQueue]>,
+) => {
+  const startedAt = Date.now();
+  const parsedPayload = GenericEventQueuePayload.safeParse(job.data.payload);
+
+  if (!parsedPayload.success) {
+    logger.error("Invalid generic event queue payload", {
+      jobId: job.id,
+      error: parsedPayload.error,
+    });
+    throw new Error("Invalid generic event queue payload");
+  }
+
+  const payload = parsedPayload.data;
+
+  try {
+    logger.debug("Processing generic event group", {
+      projectId: payload.projectId,
+      kind: payload.kind,
+      entityId: payload.entityId,
+      eventCount: payload.eventIds.length,
+    });
+
+    const events = await loadGenericEventGroup(payload);
+    if (events.length === 0) {
+      logger.warn("Generic event group is empty", {
+        projectId: payload.projectId,
+        kind: payload.kind,
+        entityId: payload.entityId,
+        fileKey: payload.fileKey,
+      });
+      return;
+    }
+
+    await new GenericEventProcessor().writeGenericEvents(events);
+
+    recordIncrement("langfuse.generic_event.worker.processed", events.length, {
+      kind: payload.kind,
+      source: payload.source,
+    });
+    recordHistogram(
+      "langfuse.generic_event.worker.processing_ms",
+      Date.now() - startedAt,
+      {
+        kind: payload.kind,
+        source: payload.source,
+      },
+    );
+
+    logger.info("Processed generic event group", {
+      projectId: payload.projectId,
+      kind: payload.kind,
+      entityId: payload.entityId,
+      eventCount: events.length,
+    });
+  } catch (error) {
+    logger.error("Failed generic event group", {
+      projectId: payload.projectId,
+      kind: payload.kind,
+      entityId: payload.entityId,
+      error,
+    });
+    recordIncrement("langfuse.generic_event.worker.failed", 1, {
+      kind: payload.kind,
+      source: payload.source,
+    });
+    traceException(error);
+    throw error;
+  }
+};
diff --git a/worker/src/queues/workerManager.ts b/worker/src/queues/workerManager.ts
index c845fd2e15..9b7af17843 100644
--- a/worker/src/queues/workerManager.ts
+++ b/worker/src/queues/workerManager.ts
@@ -9,6 +9,7 @@ import {
   IngestionQueue,
   QueueName,
   SecondaryIngestionQueue,
+  GenericEventQueue,
 } from "@langfuse/shared/src/server";
 import { ingestionQueueProcessorBuilder } from "./ingestionQueue";
+import { genericEventQueueProcessor } from "./genericEventQueue";
 import { otelIngestionQueueProcessorBuilder } from "./otelIngestionQueue";
 
 export class WorkerManager {
@@ -71,6 +72,17 @@ export class WorkerManager {
       },
     );
 
+    this.registerShardedQueue(
+      QueueName.GenericEventQueue,
+      GenericEventQueue.getShardNames(),
+      genericEventQueueProcessor,
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
diff --git a/web/src/pages/api/public/metrics.ts b/web/src/pages/api/public/metrics.ts
new file mode 100644
index 0000000000..6480574d34
--- /dev/null
+++ b/web/src/pages/api/public/metrics.ts
@@ -0,0 +1,318 @@
+import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
+import { type NextApiRequest, type NextApiResponse } from "next";
+import { z } from "zod";
+import {
+  BaseError,
+  ForbiddenError,
+  GenericEventProcessor,
+  logger,
+  MethodNotAllowedError,
+  redis,
+  traceException,
+  UnauthorizedError,
+} from "@langfuse/shared/src/server";
+import { prisma } from "@langfuse/shared/src/db";
+import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
+import { RateLimitService } from "@/src/features/public-api/server/RateLimitService";
+import { MetricEventInput } from "@langfuse/shared/src/server";
+
+export const config = {
+  api: {
+    bodyParser: {
+      sizeLimit: "5mb",
+    },
+  },
+};
+
+const MetricsBody = z.object({
+  batch: z.array(MetricEventInput).min(1).max(10_000),
+});
+
+export default async function handler(
+  req: NextApiRequest,
+  res: NextApiResponse,
+) {
+  try {
+    await runMiddleware(req, res, cors);
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
+    try {
+      const rateLimitCheck =
+        await RateLimitService.getInstance().rateLimitRequest(
+          authCheck.scope,
+          "ingestion",
+        );
+
+      if (rateLimitCheck?.isRateLimited()) {
+        return rateLimitCheck.sendRestResponseIfLimited(res);
+      }
+    } catch (e) {
+      logger.error("Error while rate limiting metric ingestion", e);
+    }
+
+    const parsedBody = MetricsBody.safeParse(req.body);
+    if (!parsedBody.success) {
+      return res.status(400).json({
+        message: "Invalid request data",
+        errors: parsedBody.error.issues.map((issue) => issue.message),
+      });
+    }
+
+    const result = await new GenericEventProcessor().processMetricEvents({
+      input: parsedBody.data.batch,
+      authCheck,
+    });
+
+    return res.status(207).json(result);
+  } catch (error: unknown) {
+    if (!(error instanceof UnauthorizedError)) {
+      logger.error("error_handling_metric_ingestion_event", error);
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
diff --git a/packages/shared/src/server/events/__tests__/genericEventProcessor.test.ts b/packages/shared/src/server/events/__tests__/genericEventProcessor.test.ts
new file mode 100644
index 0000000000..e1e7b78463
--- /dev/null
+++ b/packages/shared/src/server/events/__tests__/genericEventProcessor.test.ts
@@ -0,0 +1,574 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import { randomUUID } from "crypto";
+import {
+  GenericEventProcessor,
+  GenericEventQueue,
+  QueueJobs,
+} from "../../index";
+
+vi.mock("../genericEventStorage", () => ({
+  persistGenericEventGroup: vi.fn(async ({ projectId, kind, entityId, events, authScope }) => ({
+    projectId,
+    source: events[0]?.source ?? "api",
+    kind,
+    entityId,
+    eventIds: events.map((event) => event.id),
+    fileKey: randomUUID(),
+    bucketPath: `events/${projectId}/${kind}/${entityId}.json`,
+    authScope,
+  })),
+}));
+
+describe("GenericEventProcessor", () => {
+  const add = vi.fn();
+
+  beforeEach(() => {
+    vi.clearAllMocks();
+    vi.spyOn(GenericEventQueue, "getInstance").mockReturnValue({
+      add,
+    } as never);
+  });
+
+  it("normalizes trace ingestion events into generic queue groups", async () => {
+    const authCheck = auth();
+    const result = await new GenericEventProcessor().processIngestionEvents({
+      input: [
+        traceCreate({
+          id: "event-trace-1",
+          traceId: "trace-1",
+          timestamp: "2024-01-01T00:00:00.000Z",
+        }),
+        spanCreate({
+          id: "event-span-1",
+          traceId: "trace-1",
+          spanId: "span-1",
+          timestamp: "2024-01-01T00:00:01.000Z",
+        }),
+      ],
+      authCheck,
+    });
+
+    expect(result.errors).toEqual([]);
+    expect(result.successes).toEqual([
+      { id: "event-span-1", status: 202 },
+      { id: "event-trace-1", status: 202 },
+    ]);
+    expect(add).toHaveBeenCalledWith(
+      QueueJobs.GenericEventJob,
+      expect.objectContaining({
+        payload: expect.objectContaining({
+          projectId: authCheck.scope.projectId,
+          entityId: "span-1",
+          kind: "observation",
+        }),
+      }),
+    );
+  });
+
+  it("accepts metric events through the same processor", async () => {
+    const authCheck = auth();
+    const result = await new GenericEventProcessor().processMetricEvents({
+      input: [
+        {
+          id: "metric-1",
+          name: "sdk.flush.duration",
+          value: 123,
+          unit: "ms",
+          timestamp: "2024-01-01T00:00:00.000Z",
+          tags: {
+            sdk: "js",
+            version: "3.0.0",
+          },
+        },
+      ],
+      authCheck,
+    });
+
+    expect(result.errors).toEqual([]);
+    expect(result.successes).toEqual([{ id: "metric-1", status: 202 }]);
+    expect(add).toHaveBeenCalledWith(
+      QueueJobs.GenericEventJob,
+      expect.objectContaining({
+        payload: expect.objectContaining({
+          kind: "metric",
+          source: "metric",
+          entityId: "sdk.flush.duration:sdk:js|version:3.0.0",
+        }),
+      }),
+    );
+  });
+
+  it("sorts and groups every event kind by entity id and timestamp", async () => {
+    const authCheck = auth();
+    await new GenericEventProcessor().processGenericBatch({
+      projectId: authCheck.scope.projectId,
+      source: "api",
+      authScope: {
+        projectId: authCheck.scope.projectId,
+      },
+      events: [
+        genericMetric({
+          id: "metric-later",
+          entityId: "checkout.latency:route:/submit",
+          timestamp: new Date("2024-01-01T00:00:02.000Z"),
+        }),
+        genericMetric({
+          id: "metric-earlier",
+          entityId: "checkout.latency:route:/submit",
+          timestamp: new Date("2024-01-01T00:00:01.000Z"),
+        }),
+        genericTrace({
+          id: "trace-event",
+          entityId: "trace-1",
+          timestamp: new Date("2024-01-01T00:00:03.000Z"),
+        }),
+      ],
+    });
+
+    expect(add).toHaveBeenCalledTimes(2);
+    expect(add.mock.calls[0][1].payload.kind).toBe("metric");
+    expect(add.mock.calls[1][1].payload.kind).toBe("trace");
+  });
+
+  it("returns validation errors for invalid ingestion events", async () => {
+    const result = await new GenericEventProcessor().processIngestionEvents({
+      input: [
+        {
+          id: "bad-event",
+          type: "trace-create",
+          timestamp: "not-a-date",
+          body: {
+            id: "trace-1",
+          },
+        },
+      ],
+      authCheck: auth(),
+    });
+
+    expect(result.successes).toEqual([]);
+    expect(result.errors).toEqual([
+      expect.objectContaining({
+        id: "bad-event",
+        status: 400,
+      }),
+    ]);
+  });
+
+  it("rejects score-only credentials for metric ingestion", async () => {
+    await expect(
+      new GenericEventProcessor().processMetricEvents({
+        input: [
+          {
+            id: "metric-1",
+            name: "sdk.flush.duration",
+            value: 1,
+          },
+        ],
+        authCheck: auth({
+          accessLevel: "scores",
+        }),
+      }),
+    ).rejects.toThrow("Access Scope Denied");
+  });
+
+  it("uses one retention option for all events in a generic batch", async () => {
+    const authCheck = auth();
+    await new GenericEventProcessor().processGenericBatch({
+      projectId: authCheck.scope.projectId,
+      source: "api",
+      authScope: {
+        projectId: authCheck.scope.projectId,
+      },
+      events: [
+        genericTrace({
+          id: "trace-event",
+          entityId: "trace-1",
+          retentionDays: 365,
+        }),
+        genericMetric({
+          id: "metric-event",
+          entityId: "sdk.flush.duration:version:3.0.0",
+          retentionDays: 30,
+        }),
+      ],
+      options: {
+        retentionDays: 30,
+      },
+    });
+
+    expect(add).toHaveBeenCalledTimes(2);
+    expect(add.mock.calls[0][1].payload.options.retentionDays).toBe(30);
+    expect(add.mock.calls[1][1].payload.options.retentionDays).toBe(30);
+  });
+
+  function auth(overrides: Record<string, unknown> = {}) {
+    return {
+      validKey: true,
+      scope: {
+        projectId: randomUUID(),
+        accessLevel: "project",
+        orgId: randomUUID(),
+        plan: "pro",
+        ...overrides,
+      },
+    } as never;
+  }
+
+  function traceCreate({
+    id,
+    traceId,
+    timestamp,
+  }: {
+    id: string;
+    traceId: string;
+    timestamp: string;
+  }) {
+    return {
+      id,
+      type: "trace-create",
+      timestamp,
+      body: {
+        id: traceId,
+        timestamp,
+        name: "checkout",
+      },
+    };
+  }
+
+  function spanCreate({
+    id,
+    traceId,
+    spanId,
+    timestamp,
+  }: {
+    id: string;
+    traceId: string;
+    spanId: string;
+    timestamp: string;
+  }) {
+    return {
+      id,
+      type: "span-create",
+      timestamp,
+      body: {
+        id: spanId,
+        traceId,
+        startTime: timestamp,
+      },
+    };
+  }
+
+  function genericTrace(overrides: Partial<Record<string, unknown>>) {
+    return {
+      id: randomUUID(),
+      projectId: randomUUID(),
+      kind: "trace",
+      source: "api",
+      entityId: randomUUID(),
+      eventType: "trace-create",
+      timestamp: new Date(),
+      receivedAt: new Date(),
+      authScope: {
+        projectId: randomUUID(),
+      },
+      body: {
+        id: randomUUID(),
+      },
+      ...overrides,
+    } as never;
+  }
+
+  function genericMetric(overrides: Partial<Record<string, unknown>>) {
+    return {
+      id: randomUUID(),
+      projectId: randomUUID(),
+      kind: "metric",
+      source: "metric",
+      entityId: "metric-name:no-tags",
+      eventType: "metric-record",
+      timestamp: new Date(),
+      receivedAt: new Date(),
+      authScope: {
+        projectId: randomUUID(),
+      },
+      body: {
+        name: "metric-name",
+        value: 1,
+      },
+      tags: {},
+      ...overrides,
+    } as never;
+  }
+});
diff --git a/packages/shared/src/server/events/__tests__/genericEventStorage.test.ts b/packages/shared/src/server/events/__tests__/genericEventStorage.test.ts
new file mode 100644
index 0000000000..2fc20958e2
--- /dev/null
+++ b/packages/shared/src/server/events/__tests__/genericEventStorage.test.ts
@@ -0,0 +1,332 @@
+import { describe, expect, it } from "vitest";
+import { randomUUID } from "crypto";
+import {
+  buildGenericEventPath,
+  buildGenericInsertBatch,
+  getGenericEventTableConfig,
+  metricToGenericEvent,
+} from "../../index";
+
+describe("generic event storage helpers", () => {
+  it("builds one path scheme for every event kind", () => {
+    expect(
+      buildGenericEventPath({
+        projectId: "project-1",
+        kind: "trace",
+        entityId: "trace-1",
+        fileKey: "file-1",
+      }),
+    ).toContain("project-1");
+
+    expect(
+      buildGenericEventPath({
+        projectId: "project-1",
+        kind: "metric",
+        entityId: "sdk.flush.duration:no-tags",
+        fileKey: "file-1",
+      }),
+    ).toContain("metric");
+  });
+
+  it("uses a shared trace table for trace, observation, score, and dataset run events", () => {
+    expect(getGenericEventTableConfig("trace").tableName).toBe(
+      "generic_trace_events",
+    );
+    expect(getGenericEventTableConfig("observation").tableName).toBe(
+      "generic_trace_events",
+    );
+    expect(getGenericEventTableConfig("score").tableName).toBe(
+      "generic_trace_events",
+    );
+    expect(getGenericEventTableConfig("dataset-run-item").tableName).toBe(
+      "generic_trace_events",
+    );
+  });
+
+  it("uses a generic metric table with the same id-based dedupe shape", () => {
+    const config = getGenericEventTableConfig("metric");
+
+    expect(config.tableName).toBe("generic_metric_events");
+    expect(config.dedupeKey).toEqual(["project_id", "metric_name", "id"]);
+    expect(config.orderBy).toEqual([
+      "project_id",
+      "metric_name",
+      "timestamp",
+      "id",
+    ]);
+  });
+
+  it("converts mixed domains into generic insert batches", () => {
+    const batch = buildGenericInsertBatch([
+      genericTrace({
+        id: "trace-event",
+        entityId: "trace-1",
+      }),
+      metricToGenericEvent({
+        projectId: "project-1",
+        authScope: {
+          projectId: "project-1",
+        },
+        input: {
+          id: "metric-event",
+          name: "sdk.flush.duration",
+          value: 100,
+          unit: "ms",
+          tags: {
+            sdk: "js",
+          },
+        },
+      }),
+    ]);
+
+    expect(batch.traceRows).toEqual([
+      expect.objectContaining({
+        id: "trace-event",
+        entity_id: "trace-1",
+      }),
+    ]);
+    expect(batch.metricRows).toEqual([
+      expect.objectContaining({
+        id: "metric-event",
+        metric_name: "sdk.flush.duration",
+        metric_value: 100,
+      }),
+    ]);
+  });
+
+  it("derives metric entity ids from metric names and tags", () => {
+    const event = metricToGenericEvent({
+      projectId: "project-1",
+      authScope: {
+        projectId: "project-1",
+      },
+      input: {
+        name: "api.request.duration",
+        value: 125,
+        tags: {
+          method: "POST",
+          route: "/api/public/ingestion",
+        },
+      },
+    });
+
+    expect(event.entityId).toBe(
+      "api.request.duration:method:POST|route:/api/public/ingestion",
+    );
+  });
+
+  it("treats user ids as part of the generic metric entity id", () => {
+    const event = metricToGenericEvent({
+      projectId: "project-1",
+      authScope: {
+        projectId: "project-1",
+      },
+      input: {
+        name: "checkout.duration",
+        value: 900,
+        tags: {
+          user_id: randomUUID(),
+          route: "/checkout",
+        },
+      },
+    });
+
+    expect(event.entityId).toContain("checkout.duration");
+    expect(event.entityId).toContain("user_id:");
+  });
+
+  it("applies metric retention to metric rows", () => {
+    const event = metricToGenericEvent({
+      projectId: "project-1",
+      authScope: {
+        projectId: "project-1",
+      },
+      input: {
+        id: "metric-1",
+        name: "sdk.flush.duration",
+        value: 100,
+      },
+    });
+
+    const batch = buildGenericInsertBatch([event]);
+
+    expect(batch.metricRows[0].ttl_days).toBe(30);
+  });
+
+  function genericTrace(overrides: Partial<Record<string, unknown>>) {
+    return {
+      id: randomUUID(),
+      projectId: "project-1",
+      kind: "trace",
+      source: "api",
+      entityId: randomUUID(),
+      eventType: "trace-create",
+      timestamp: new Date(),
+      receivedAt: new Date(),
+      authScope: {
+        projectId: "project-1",
+      },
+      body: {
+        id: randomUUID(),
+        name: "storage-test",
+      },
+      ...overrides,
+    } as never;
+  }
+});
diff --git a/worker/src/queues/__tests__/genericEventQueue.test.ts b/worker/src/queues/__tests__/genericEventQueue.test.ts
new file mode 100644
index 0000000000..672cc2a577
--- /dev/null
+++ b/worker/src/queues/__tests__/genericEventQueue.test.ts
@@ -0,0 +1,266 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import { randomUUID } from "crypto";
+import { genericEventQueueProcessor } from "../genericEventQueue";
+
+const writeGenericEvents = vi.fn();
+const loadGenericEventGroup = vi.fn();
+
+vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
+  const actual = await importOriginal<typeof import("@langfuse/shared/src/server")>();
+  return {
+    ...actual,
+    GenericEventProcessor: vi.fn(() => ({
+      writeGenericEvents,
+    })),
+    loadGenericEventGroup,
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
+describe("genericEventQueueProcessor", () => {
+  beforeEach(() => {
+    vi.clearAllMocks();
+    loadGenericEventGroup.mockResolvedValue([
+      {
+        id: "event-1",
+        projectId: "project-1",
+        kind: "metric",
+        source: "metric",
+        entityId: "sdk.flush.duration:no-tags",
+        eventType: "metric-record",
+        timestamp: new Date(),
+        receivedAt: new Date(),
+        authScope: {
+          projectId: "project-1",
+        },
+        body: {
+          name: "sdk.flush.duration",
+          value: 1,
+        },
+      },
+    ]);
+  });
+
+  it("loads and writes a generic event payload", async () => {
+    await expect(genericEventQueueProcessor(buildJob())).resolves.toBeUndefined();
+
+    expect(loadGenericEventGroup).toHaveBeenCalledWith(
+      expect.objectContaining({
+        projectId: "project-1",
+        kind: "metric",
+      }),
+    );
+    expect(writeGenericEvents).toHaveBeenCalledWith([
+      expect.objectContaining({
+        kind: "metric",
+      }),
+    ]);
+  });
+
+  it("returns without writing when storage returns no events", async () => {
+    loadGenericEventGroup.mockResolvedValueOnce([]);
+
+    await expect(genericEventQueueProcessor(buildJob())).resolves.toBeUndefined();
+
+    expect(writeGenericEvents).not.toHaveBeenCalled();
+  });
+
+  it("throws when queue payload is invalid", async () => {
+    await expect(
+      genericEventQueueProcessor({
+        id: "job-1",
+        data: {
+          payload: {
+            projectId: "project-1",
+          },
+        },
+      } as never),
+    ).rejects.toThrow("Invalid generic event queue payload");
+  });
+
+  it("retries write failures through BullMQ", async () => {
+    writeGenericEvents.mockRejectedValueOnce(new Error("clickhouse down"));
+
+    await expect(genericEventQueueProcessor(buildJob())).rejects.toThrow(
+      "clickhouse down",
+    );
+  });
+
+  function buildJob() {
+    return {
+      id: "job-1",
+      data: {
+        id: randomUUID(),
+        timestamp: new Date(),
+        name: "generic-event-job",
+        payload: {
+          projectId: "project-1",
+          source: "metric",
+          kind: "metric",
+          entityId: "sdk.flush.duration:no-tags",
+          eventIds: ["event-1"],
+          fileKey: randomUUID(),
+          bucketPath: "events/project-1/metric/sdk.flush.duration/file.json",
+          authScope: {
+            projectId: "project-1",
+            accessLevel: "project",
+          },
+        },
+      },
+    } as never;
+  }
+});
diff --git a/web/src/__tests__/server/metrics-api.servertest.ts b/web/src/__tests__/server/metrics-api.servertest.ts
new file mode 100644
index 0000000000..b5c7e3517e
--- /dev/null
+++ b/web/src/__tests__/server/metrics-api.servertest.ts
@@ -0,0 +1,322 @@
+import { randomUUID } from "crypto";
+import { makeAPICall } from "@/src/__tests__/test-utils";
+import {
+  createOrgProjectAndApiKey,
+  GenericEventQueue,
+  QueueJobs,
+} from "@langfuse/shared/src/server";
+
+let projectId: string;
+let auth: string;
+let addSpy: ReturnType<typeof vi.spyOn>;
+
+const postMetrics = (body: unknown) =>
+  makeAPICall("POST", "/api/public/metrics", body, auth);
+
+describe("/api/public/metrics", () => {
+  beforeEach(async () => {
+    const fixture = await createOrgProjectAndApiKey();
+    projectId = fixture.projectId;
+    auth = fixture.auth;
+    addSpy = vi
+      .spyOn(GenericEventQueue.getInstance({ shardingKey: projectId })!, "add")
+      .mockResolvedValue({} as never);
+  });
+
+  afterEach(() => {
+    vi.restoreAllMocks();
+  });
+
+  it("accepts a metric batch", async () => {
+    const response = await postMetrics({
+      batch: [
+        {
+          id: "metric-1",
+          name: "sdk.flush.duration",
+          value: 123,
+          unit: "ms",
+          timestamp: "2024-01-01T00:00:00.000Z",
+          tags: {
+            sdk: "js",
+          },
+        },
+      ],
+    });
+
+    expect(response.status).toBe(207);
+    expect(response.body.errors).toEqual([]);
+    expect(response.body.successes).toEqual([
+      {
+        id: "metric-1",
+        status: 202,
+      },
+    ]);
+    expect(addSpy).toHaveBeenCalledWith(
+      QueueJobs.GenericEventJob,
+      expect.objectContaining({
+        payload: expect.objectContaining({
+          kind: "metric",
+          source: "metric",
+        }),
+      }),
+    );
+  });
+
+  it("accepts high-cardinality metric tags", async () => {
+    const batch = Array.from({ length: 1_000 }, (_, index) => ({
+      id: `metric-${index}`,
+      name: "api.request.duration",
+      value: index,
+      tags: {
+        route: "/api/public/ingestion",
+        user_id: randomUUID(),
+      },
+    }));
+
+    const response = await postMetrics({ batch });
+
+    expect(response.status).toBe(207);
+    expect(response.body.errors).toEqual([]);
+    expect(response.body.successes).toHaveLength(1_000);
+  });
+
+  it("rejects invalid metric envelopes", async () => {
+    const response = await postMetrics({
+      batch: [
+        {
+          id: "metric-1",
+          name: "sdk.flush.duration",
+          value: "not-a-number",
+        },
+      ],
+    });
+
+    expect(response.status).toBe(400);
+  });
+
+  it("uses ingestion rate limits", async () => {
+    const response = await postMetrics({
+      batch: [
+        {
+          id: "metric-1",
+          name: "sdk.flush.duration",
+          value: 123,
+        },
+      ],
+    });
+
+    expect(response.status).toBe(207);
+  });
+});
diff --git a/fern/apis/server/definition/metrics.yml b/fern/apis/server/definition/metrics.yml
new file mode 100644
index 0000000000..7320ec707e
--- /dev/null
+++ b/fern/apis/server/definition/metrics.yml
@@ -0,0 +1,224 @@
+types:
+  MetricEvent:
+    properties:
+      id:
+        type: optional<string>
+        docs: Optional event id. If omitted, Langfuse derives one from the metric name, tags, and timestamp.
+      name:
+        type: string
+      timestamp:
+        type: optional<string>
+      value:
+        type: double
+      unit:
+        type: optional<string>
+      tags:
+        type: optional<map<string, string>>
+      attributes:
+        type: optional<map<string, unknown>>
+
+  MetricsRequest:
+    properties:
+      batch:
+        type: list<MetricEvent>
+
+  MetricsResponse:
+    properties:
+      successes:
+        type: list<IngestionSuccess>
+      errors:
+        type: list<IngestionError>
+
+endpoints:
+  create:
+    docs: |
+      Ingest product and SDK metrics through the generic event pipeline.
+      Metrics share the same durable queue and response semantics as trace ingestion.
+    method: POST
+    path: /public/metrics
+    auth: true
+    request:
+      name: MetricsRequest
+      body:
+        type: MetricsRequest
+    response:
+      type: MetricsResponse
diff --git a/docs/ingestion/generic-event-processor.md b/docs/ingestion/generic-event-processor.md
new file mode 100644
index 0000000000..27bbf028b4
--- /dev/null
+++ b/docs/ingestion/generic-event-processor.md
@@ -0,0 +1,304 @@
+# Generic Event Processor
+
+The generic event processor unifies Langfuse ingestion, OTel-derived events, and
+product metrics behind one durable event lifecycle.
+
+The shared lifecycle is:
+
+1. Validate the input event.
+2. Normalize into `GenericEventEnvelope`.
+3. Group by event kind and entity ID.
+4. Store the group in S3.
+5. Enqueue a generic event job.
+6. Load the group in a worker.
+7. Write rows to ClickHouse.
+
+## Why This Exists
+
+The old ingestion code had multiple paths:
+
+- public ingestion API
+- OTel ingestion
+- trace/observation merge and write
+- score ingestion
+- future metrics ingestion
+
+Those paths all accept events, store payloads, enqueue background work, and write
+to ClickHouse. The generic event processor lets those paths share one queue and
+one worker.
+
+## Event Kinds
+
+Generic events support these kinds:
+
+- `trace`
+- `observation`
+- `score`
+- `dataset-run-item`
+- `metric`
+
+Every kind has an `entityId`. For traces this is the trace ID. For observations
+this is the observation ID. For metrics this is the metric name plus sorted tag
+key/value pairs.
+
+## Retention
+
+The processor accepts `retentionDays` at the batch level. If omitted, each event
+uses the default retention for its kind.
+
+Metrics currently use 30 days. Trace data uses the project retention policy.
+
+## Ordering
+
+The processor sorts every group by timestamp before it persists the group. This
+keeps create/update events deterministic and makes metric writes stable.
+
+## Metrics
+
+Metrics are ingested through:
+
+```http
+POST /api/public/metrics
+```
+
+The API returns the standard ingestion response shape:
+
+```json
+{
+  "successes": [
+    {
+      "id": "metric-1",
+      "status": 202
+    }
+  ],
+  "errors": []
+}
+```
+
+Metrics are written into `generic_metric_events`.
+
+## Trace Ingestion
+
+The public ingestion endpoint delegates to `GenericEventProcessor` and keeps its
+existing response shape. The generic processor validates Langfuse ingestion
+events and applies score-only authorization before enqueueing.
+
+## Worker
+
+The worker is intentionally small. It loads the generic event group from S3 and
+calls `GenericEventProcessor.writeGenericEvents`.
+
+## Operational Notes
+
+The generic queue uses the same shard count and concurrency settings as the
+existing ingestion queue. Metrics and traces therefore share worker capacity.
+
+Retries use the standard queue retry policy. Permanent write failures should be
+handled by the same dead-letter inspection process as ingestion failures.
diff --git a/docs/ingestion/metrics-cardinality.md b/docs/ingestion/metrics-cardinality.md
new file mode 100644
index 0000000000..32a1de0742
--- /dev/null
+++ b/docs/ingestion/metrics-cardinality.md
@@ -0,0 +1,332 @@
+# Metrics Cardinality
+
+Metrics ingestion uses the generic event processor. The processor derives the
+metric entity ID from:
+
+- metric name
+- sorted tag names
+- sorted tag values
+
+For example:
+
+```json
+{
+  "name": "api.request.duration",
+  "value": 120,
+  "tags": {
+    "route": "/api/public/ingestion",
+    "method": "POST"
+  }
+}
+```
+
+becomes:
+
+```text
+api.request.duration:method:POST|route:/api/public/ingestion
+```
+
+## High-Cardinality Tags
+
+The generic processor accepts arbitrary string tags. It does not block tags such
+as:
+
+- user IDs
+- session IDs
+- request IDs
+- trace IDs
+- random UUIDs
+
+High-cardinality tags create separate generic event groups. Each group creates a
+separate stored payload and queue job.
+
+## Retention
+
+Metrics default to 30 days of retention. The generic batch option can override
+the retention for all events in the batch.
+
+When traces and metrics are processed together, the batch-level retention wins.
+
+## Aggregation
+
+The first metrics implementation stores metric events as raw generic metric rows.
+Aggregation is left to query time.
+
+The generic event table uses:
+
+```text
+project_id, metric_name, timestamp, id
+```
+
+as its ordering key.
+
+The dedupe key is:
+
+```text
+project_id, metric_name, id
+```
+
+## Recommended Client Behavior
+
+Clients should keep tag cardinality low. Prefer stable dimensions such as:
+
+- route template
+- SDK name
+- SDK version
+- environment
+- host region
+
+Avoid tags whose values are unique for every request.
+
+## Operational Behavior
+
+Metrics and traces use the same generic queue. A sudden increase in metric
+cardinality can increase:
+
+- queue job count
+- S3 object count
+- worker processing time
+- ClickHouse insert count
+- dead-letter volume
+
+Because the queue is shared, metrics volume can affect trace ingestion latency.
+
+## Future Work
+
+Future iterations may add:
+
+- tag allowlists
+- tag deny lists
+- rollup windows
+- server-side aggregation
+- metric-specific sampling
+- query-aware retention
+
+Until then, metrics should be treated like generic events.
diff --git a/docs/ingestion/generic-event-rollout.md b/docs/ingestion/generic-event-rollout.md
new file mode 100644
index 0000000000..c44814e04a
--- /dev/null
+++ b/docs/ingestion/generic-event-rollout.md
@@ -0,0 +1,244 @@
+# Generic Event Processor Rollout
+
+The generic event processor is additive for one release. During the rollout,
+public ingestion and metrics ingestion both use the generic queue, but the old
+ingestion queue remains available for rollback.
+
+## Feature Flags
+
+The rollout uses these flags:
+
+- `LANGFUSE_USE_GENERIC_EVENT_PROCESSOR`
+- `LANGFUSE_GENERIC_EVENTS_FOR_METRICS`
+- `LANGFUSE_GENERIC_EVENTS_FOR_TRACES`
+
+When `LANGFUSE_USE_GENERIC_EVENT_PROCESSOR` is disabled, new metrics ingestion
+is disabled and trace ingestion uses the existing path.
+
+## Deployment Order
+
+1. Deploy the worker with the generic event queue registered.
+2. Deploy shared server exports.
+3. Deploy the metrics API endpoint.
+4. Enable metrics ingestion for internal projects.
+5. Enable generic trace ingestion for 1 percent of projects.
+6. Increase rollout based on queue latency and ClickHouse insert error rate.
+
+## Rollback
+
+Disable `LANGFUSE_USE_GENERIC_EVENT_PROCESSOR`.
+
+Queued generic jobs can continue draining because the worker remains registered.
+If generic queue failures increase, pause the generic queue and replay from S3
+after fixing the processor.
+
+## Monitoring
+
+Watch:
+
+- `langfuse.generic_event.ingested`
+- `langfuse.generic_event.batch_size`
+- `langfuse.generic_event.worker.processed`
+- `langfuse.generic_event.worker.failed`
+- ingestion queue latency
+- metric queue latency
+- ClickHouse insert failures
+- S3 object count
+
+## Data Validation
+
+Compare old and generic ingestion for:
+
+- trace count
+- observation count
+- score count
+- metric count
+- queue retry rate
+- dead-letter count
+- ClickHouse row count
+
+## Known Risks
+
+Metrics and traces share the same queue capacity. A metric cardinality spike can
+increase trace ingestion latency.
+
+The generic processor writes trace-like events into generic trace rows. Some
+downstream jobs may need to read both old and generic tables during rollout.
+
+Retention is configured in the generic event batch. Projects with custom trace
+retention should verify that generic trace rows expire at the expected time.
+
+## Support Runbook
+
+When a customer reports missing traces after rollout:
+
+1. Check whether the project is enabled for generic trace ingestion.
+2. Search the generic event queue by project ID.
+3. Search S3 under the generic event prefix.
+4. Compare generic trace rows with legacy trace rows.
+5. Disable the project flag if generic trace rows are missing.
+
+When a customer reports metric cardinality problems:
+
+1. Identify the metric name.
+2. Count unique tag sets.
+3. Check queue job volume for that metric.
+4. Ask the customer to remove request-level tags.
+5. Consider disabling metrics ingestion for the project.
+
+## Compatibility Notes
+
+The generic processor keeps the public ingestion response shape. SDKs still see
+item-level successes and errors.
+
+The generic queue job is not wire-compatible with the existing ingestion queue.
+Generic jobs use `kind`, `entityId`, and `bucketPath`. Existing ingestion jobs
+use ingestion event type, event body ID, and optional file key semantics.
+
+Workers should stay backward compatible until the old ingestion queue is empty.
+Do not remove the existing ingestion worker in the same release.
+
+## Cleanup Plan
+
+After full rollout:
+
+1. Stop producing old ingestion jobs.
+2. Wait for the old ingestion queue to drain.
+3. Archive old S3 event prefixes after retention expires.
+4. Remove old ingestion worker registration.
+5. Delete old ingestion queue metrics.
+
+Cleanup should not happen until trace counts, observation counts, and score
+counts match between old and generic ingestion for a full retention window.
+
+## Rollout Guardrails
+
+Stop rollout automatically when any of these occur:
+
+- generic queue latency exceeds old ingestion queue latency by 25 percent
+- generic worker failure rate exceeds 0.1 percent
+- ClickHouse insert errors increase for trace or metric tables
+- S3 slowdown flags increase for enabled projects
+- trace counts differ from old ingestion by more than 0.5 percent
+- observation counts differ from old ingestion by more than 0.5 percent
+- metric cardinality exceeds configured project limits
+
+Rollout should resume only after the owning processor team signs off on the
+specific domain that regressed. Trace regressions should not be waived by the
+metrics team, and metrics regressions should not be waived by the trace team.
+
+## Ownership
+
+The generic processor is owned by the ingestion platform team. Domain teams own
+their event contracts:
+
+- traces and observations: tracing team
+- metrics: metrics team
+- scores: evaluation team
+- dataset run items: datasets team
+
+Changes to generic event shape require approval from every affected owner.
+
+## Open Questions
+
+Before making generic ingestion the default, answer:
+
+- How are metric rollups computed?
+- Which tags are allowed by default?
+- How are trace updates merged?
+- Which tables power existing trace queries?
+- How are score-only credentials enforced?
+- Which retention policy wins for mixed batches?
+
+## Verification Matrix
+
+Validate rollout separately for:
+
+- API ingestion traces
+- OTel traces
+- scores
+- dataset run items
+- low-cardinality metrics
+- high-cardinality metrics
+
+Each row should have a baseline count, generic count, retry count, and owner
+approval before rollout advances.
+
+Do not use aggregate totals alone. Domain-level mismatches can cancel each
+other out and hide data loss.
+
+Keep rollback flags available until every queue created before rollout has
+expired or drained.
+
+Document the final owner for each generic table before cleanup.
+
+Record that ownership in the runbook.
+
```

## Intended Flaws

### Flaw 1: The Generic Abstraction Erases Event Semantics

- `type`: `abstraction_misfit`
- `location`: `packages/shared/src/server/events/genericEventTypes.ts:8-112`, `packages/shared/src/server/events/genericEventProcessor.ts:109-202`, `packages/shared/src/server/events/genericEventProcessor.ts:252-329`, `docs/ingestion/generic-event-processor.md:39-55`
- `learner_prompt`: What domain-specific event semantics are lost when traces, observations, scores, dataset-run items, and metrics are forced through the same envelope, grouping, retention, and queue path?

Expected answer:

- `identify`: The abstraction treats traces and metrics as the same kind of durable event: each has an `entityId`, timestamp ordering, S3 payload group, generic queue job, batch-level retention, and generic ClickHouse write. That erases important differences. Trace/observation ingestion needs entity-level merge semantics, S3 list behavior, duplicate-update handling, eventBodyId grouping, project retention, and specialized worker behavior. Metrics need aggregation/windowing/cardinality controls, tag handling, dedupe/rollup semantics, and often different retention/query shapes. A shared timestamp sort and batch-level retention are not a shared domain model.
- `impact`: The system can store the wrong data shape while looking clean architecturally. Metrics can explode cardinality or be retained with the wrong policy. Trace updates can lose merge semantics or be written as raw generic rows instead of going through `IngestionService.mergeAndWrite`. Queue capacity and retry behavior for metrics can interfere with trace ingestion. Future engineers will add conditionals to the generic processor until it becomes a fragile abstraction that hides every important product distinction.
- `fix_direction`: Do not create a single processor for unrelated event domains. Keep separate trace/observation, OTel, score, dataset, and metrics processors with explicit domain contracts. Share small primitives where the semantics truly match, such as S3 upload helpers, queue sharding helpers, metric recording helpers, or response aggregation. The top-level processors should remain domain-specific.

Hints:

1. Ask whether "event" means the same thing for trace updates and product metrics.
2. Compare grouping, retention, cardinality, and write behavior across traces and metrics.
3. The docs say every kind has one `entityId` and batch-level retention; the real ingestion path has more specific invariants.

### Flaw 2: One Processor Owns Validation, Authorization, Queueing, Storage, And Product Writes

- `type`: `ownership_boundary_violation`
- `location`: `packages/shared/src/server/events/genericEventProcessor.ts:35-250`, `packages/shared/src/server/events/genericEventProcessor.ts:204-250`, `packages/shared/src/server/ingestion/processEventBatch.ts:78-95`, `worker/src/queues/genericEventQueue.ts:31-51`
- `learner_prompt`: Which architectural boundaries does `GenericEventProcessor` cross, and why will that make future ingestion changes harder?

Expected answer:

- `identify`: `GenericEventProcessor` becomes the owner of public ingestion validation, score authorization, metric validation, grouping, S3 persistence, queue enqueueing, ClickHouse table selection, metric retention, trace row writes, and worker write behavior. `processEventBatch` becomes a thin wrapper, and the worker calls back into the same processor for storage. A single class now owns API contract decisions, queue command shape, product validation, and storage implementation.
- `impact`: This makes the system harder to change safely. A metrics change can accidentally alter trace ingestion. A trace storage change can affect metrics. API validation and worker storage become coupled, so rollout and migration strategies get riskier. Tests will mostly verify the generic happy path instead of the domain contracts that users care about. The abstraction invites broad edits in a high-traffic ingestion subsystem.
- `fix_direction`: Split the layers. API handlers validate public contracts and auth. Domain processors translate validated inputs into domain commands. Queue payloads should be durable, domain-specific commands. Workers should call domain services that own storage semantics. Shared code should be primitives and interfaces, not a god processor.

Hints:

1. List everything the new class does before deciding if the abstraction is healthy.
2. Look at what happened to `processEventBatch` and what the worker now calls.
3. The same file parses public API data, chooses queue grouping, uploads payloads, and writes ClickHouse tables.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must explain the lost domain semantics, not merely say "generic abstraction bad." The key evidence is shared grouping, retention, queueing, and ClickHouse writes for traces and metrics despite their different cardinality, merge, and query contracts.

For flaw 2, a correct answer must identify ownership collapse across layers. Answers that only complain about file size are incomplete unless they explain which contracts are being coupled.

### Product-Level Change

The PR tries to reduce duplication while adding product metrics ingestion. That instinct is understandable. Large ingestion systems often have repeated code around validation, S3 upload, queues, metrics, and worker boilerplate. But the right abstraction depends on which invariants are genuinely shared.

### Changed Contracts

- Public API contract: `/api/public/metrics` is introduced and standard ingestion delegates to the generic processor.
- Event contract: traces, observations, scores, dataset run items, and metrics now share one `GenericEventEnvelope`.
- Queue contract: domain-specific ingestion jobs are replaced or bypassed by generic event jobs.
- Storage contract: the generic processor chooses ClickHouse tables and row shapes.
- Retention contract: retention becomes a batch/generic-event option rather than domain-owned policy.
- Ownership contract: validation, auth, queueing, persistence, and product writes move into one shared processor.

### Failure Modes

Metrics with high-cardinality tags can create a huge number of generic event groups and consume the same queue capacity as trace ingestion. Trace update events can skip the merge behavior that makes the existing ingestion service safe. Retention can be applied incorrectly because the generic batch has one option while domains need different policy. Future fixes will add branches to the generic processor, increasing the blast radius of every ingestion change.

### Reviewer Thought Process

A strong reviewer asks what is truly duplicated. S3 upload mechanics are shared. Queue sharding helpers are shared. Metrics instrumentation helpers are shared. But trace merge semantics, metric aggregation semantics, score auth, OTel propagation, and retention are not the same domain. The reviewer should resist the appeal of a tidy noun when the business behavior underneath is not tidy.

The second move is to draw the layer boundaries. API validation, queue command creation, storage writes, and product domain rules should not all live in one class. The diff is large because the abstraction has swallowed the system.

### Better Implementation Direction

Keep the useful primitives:

- a shared S3 event payload helper,
- a shared queue sharding helper,
- shared result aggregation,
- shared metrics/logging utilities,
- common test fixtures.

But keep processors separate:

- `TraceIngestionProcessor` owns trace/observation merge and S3 fan-out.
- `MetricIngestionProcessor` owns metric cardinality, aggregation, dedupe, and retention.
- `ScoreIngestionProcessor` owns score auth and score-specific validation.
- Workers consume domain-specific queue commands and call domain services.

## Why This Case Exists

AI-generated refactors often make code look more senior by introducing a broad abstraction. This exercise trains the reviewer to ask whether the abstraction preserves the system's important differences. Great engineers do not just remove duplication. They protect the domain model.
