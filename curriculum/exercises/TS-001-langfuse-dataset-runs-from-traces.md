# TS-001: Langfuse Dataset Runs From Trace IDs

## Metadata

- `id`: TS-001
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: public API, datasets, traces, ClickHouse-backed tracing data, Postgres dataset metadata
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 620
- `flaw_count`: 2

## PR Description Shown To Learner

This PR adds a public API endpoint that lets SDK users create a dataset run from a list of existing trace IDs.

Today users can add one dataset run item at a time through `POST /api/public/dataset-run-items`. That is slow for eval workflows where the user already has a list of trace IDs and wants to create a run in one request. The new endpoint accepts:

- dataset id
- run name and optional description
- trace ids
- optional per-trace metadata
- optional `createdAtByTraceId` map for imported historical eval runs

The endpoint creates or fetches the dataset run, validates trace IDs, writes dataset run item events through the existing ingestion path, and returns the created run item ids.

## Existing Code Context

The real Langfuse codebase already has the following relevant contracts:

- `web/src/pages/api/public/dataset-run-items.ts` creates a single dataset run item and resolves `datasetItem` with `projectId: auth.scope.projectId`.
- `web/src/pages/api/public/dataset-run-items.ts` resolves an observation with `getObservationById({ id, projectId: auth.scope.projectId })`.
- `web/src/features/public-api/server/dataset-runs.ts` creates/fetches a dataset run by `(datasetId, projectId, name)`.
- `packages/shared/prisma/schema.prisma` models `Dataset`, `DatasetItem`, `DatasetRuns`, and `DatasetRunItems` with project ids and composite project-owned keys.
- `packages/shared/src/server/repositories/traces.ts` exposes `getTraceById({ traceId, projectId, ... })`, so trace lookup is expected to be project-scoped.
- `packages/shared/src/server/ingestion/types.ts` treats dataset run item creation as internal ingestion only.

Relevant existing helper signatures visible for this review:

```ts
// web/src/pages/api/public/dataset-run-items.ts
const observation = body.observationId
  ? await getObservationById({
      id: body.observationId,
      projectId: auth.scope.projectId,
    })
  : undefined;
```

```ts
// packages/shared/src/server/repositories/traces.ts
export const getTraceById = async ({
  traceId,
  projectId,
  timestamp,
}: {
  traceId: string;
  projectId: string;
  timestamp?: Date;
}) => {
  return await queryTrace({ traceId, projectId, timestamp });
};
```

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `web/src/features/public-api/types/dataset-runs-from-traces.ts`
- `web/src/features/public-api/server/dataset-runs-from-traces.ts`
- `web/src/pages/api/public/dataset-runs/from-traces.ts`
- `web/src/features/public-api/server/dataset-run-items.ts`
- `web/src/features/public-api/server/dataset-runs.ts`
- `web/src/features/public-api/server/__tests__/dataset-runs-from-traces.test.ts`

The important line references below use synthetic PR line numbers. The full diff shown to the learner is intentionally relevant-only, but the PR is represented as a 620-line change across API types, route code, service code, helper changes, and tests.

## Diff

```diff
diff --git a/web/src/features/public-api/types/dataset-runs-from-traces.ts b/web/src/features/public-api/types/dataset-runs-from-traces.ts
new file mode 100644
index 000000000..26fc011aa
--- /dev/null
+++ b/web/src/features/public-api/types/dataset-runs-from-traces.ts
@@ -0,0 +1,126 @@
+import { z } from "zod";
+import {
+  jsonSchema,
+  publicApiPaginationZod,
+  stringDateTime,
+} from "@langfuse/shared";
+
+const traceIdSchema = z.string().min(1).max(256);
+
+export const CreateDatasetRunFromTracesV1Body = z
+  .object({
+    datasetId: z.string().min(1),
+    runName: z.string().min(1).max(256),
+    runDescription: z.string().max(2048).nullish(),
+    traceIds: z.array(traceIdSchema).min(1).max(500),
+    metadata: jsonSchema.nullish(),
+    itemMetadataByTraceId: z.record(traceIdSchema, jsonSchema).nullish(),
+    createdAtByTraceId: z.record(traceIdSchema, stringDateTime).nullish(),
+  })
+  .strict();
+
+export const CreateDatasetRunFromTracesV1Response = z
+  .object({
+    datasetId: z.string(),
+    datasetRunId: z.string(),
+    datasetRunName: z.string(),
+    createdCount: z.number(),
+    skippedCount: z.number(),
+    data: z.array(
+      z.object({
+        id: z.string(),
+        traceId: z.string(),
+        datasetItemId: z.string(),
+        createdAt: z.coerce.date(),
+      }),
+    ),
+  })
+  .strict();
+
+export const GetDatasetRunCreationPreviewV1Query = z
+  .object({
+    datasetId: z.string(),
+    runName: z.string(),
+    traceIds: z
+      .string()
+      .transform((value) =>
+        value
+          .split(",")
+          .map((id) => id.trim())
+          .filter(Boolean),
+      ),
+    ...publicApiPaginationZod,
+  })
+  .strict();
+
+export const GetDatasetRunCreationPreviewV1Response = z
+  .object({
+    datasetId: z.string(),
+    runName: z.string(),
+    traceCount: z.number(),
+    alreadyLinkedTraceIds: z.array(z.string()),
+    missingTraceIds: z.array(z.string()),
+  })
+  .strict();
+
+export type CreateDatasetRunFromTracesV1Body = z.infer<
+  typeof CreateDatasetRunFromTracesV1Body
+>;
+
+export type CreateDatasetRunFromTracesV1Response = z.infer<
+  typeof CreateDatasetRunFromTracesV1Response
+>;
+
+export type GetDatasetRunCreationPreviewV1Query = z.infer<
+  typeof GetDatasetRunCreationPreviewV1Query
+>;
+
+export type GetDatasetRunCreationPreviewV1Response = z.infer<
+  typeof GetDatasetRunCreationPreviewV1Response
+>;
+
+export type TraceRunCandidate = {
+  traceId: string;
+  timestamp: Date;
+  name: string | null;
+  userId: string | null;
+  sessionId: string | null;
+};
+
+export type DatasetRunTraceItem = {
+  traceId: string;
+  datasetItemId: string;
+  datasetRunItemId: string;
+  createdAt: Date;
+};
+
+export const MAX_TRACES_PER_RUN_CREATE = 500;
+
+export const normalizeTraceIds = (traceIds: string[]) => {
+  const seen = new Set<string>();
+  const normalized: string[] = [];
+
+  for (const rawTraceId of traceIds) {
+    const traceId = rawTraceId.trim();
+    if (!traceId || seen.has(traceId)) continue;
+    seen.add(traceId);
+    normalized.push(traceId);
+  }
+
+  return normalized;
+};
+
+export const assertTraceLimit = (traceIds: string[]) => {
+  if (traceIds.length > MAX_TRACES_PER_RUN_CREATE) {
+    throw new Error(
+      `Cannot create a dataset run from more than ${MAX_TRACES_PER_RUN_CREATE} traces`,
+    );
+  }
+};
+
+export const getTraceItemMetadata = ({
+  traceId,
+  itemMetadataByTraceId,
+}: {
+  traceId: string;
+  itemMetadataByTraceId?: Record<string, unknown>;
+}) => {
+  const metadata = itemMetadataByTraceId?.[traceId];
+  if (!metadata) return {};
+  if (Array.isArray(metadata)) return { metadata };
+  if (typeof metadata === "object") return metadata as Record<string, unknown>;
+  return { metadata };
+};
+
+export const resolveItemCreatedAt = ({
+  traceId,
+  traceTimestamp,
+  createdAtByTraceId,
+}: {
+  traceId: string;
+  traceTimestamp: Date;
+  createdAtByTraceId?: Record<string, string>;
+}) => {
+  return createdAtByTraceId?.[traceId]
+    ? new Date(createdAtByTraceId[traceId])
+    : traceTimestamp;
+};
diff --git a/web/src/features/public-api/server/dataset-runs-from-traces.ts b/web/src/features/public-api/server/dataset-runs-from-traces.ts
new file mode 100644
index 000000000..985dc2f88
--- /dev/null
+++ b/web/src/features/public-api/server/dataset-runs-from-traces.ts
@@ -0,0 +1,254 @@
+import { prisma } from "@langfuse/shared/src/db";
+import {
+  eventTypes,
+  logger,
+  processEventBatch,
+  getDatasetItemById,
+} from "@langfuse/shared/src/server";
+import { v4 } from "uuid";
+import { createOrFetchDatasetRun } from "@/src/features/public-api/server/dataset-runs";
+import {
+  assertTraceLimit,
+  getTraceItemMetadata,
+  normalizeTraceIds,
+  resolveItemCreatedAt,
+  type CreateDatasetRunFromTracesV1Body,
+  type CreateDatasetRunFromTracesV1Response,
+  type DatasetRunTraceItem,
+  type TraceRunCandidate,
+} from "@/src/features/public-api/types/dataset-runs-from-traces";
+import { LangfuseNotFoundError, type JSONValue } from "@langfuse/shared";
+import { addDatasetRunItemsToEvalQueue } from "@/src/features/evals/server/addDatasetRunItemsToEvalQueue";
+
+type ProjectAuth = {
+  scope: {
+    projectId: string;
+    apiKeyId: string;
+  };
+};
+
+const createDatasetItemForTrace = async ({
+  projectId,
+  datasetId,
+  trace,
+  metadata,
+}: {
+  projectId: string;
+  datasetId: string;
+  trace: TraceRunCandidate;
+  metadata: Record<string, unknown>;
+}) => {
+  const datasetItem = await prisma.datasetItem.create({
+    data: {
+      id: v4(),
+      projectId,
+      datasetId,
+      input: {
+        traceId: trace.traceId,
+        name: trace.name,
+        userId: trace.userId,
+        sessionId: trace.sessionId,
+      },
+      expectedOutput: {},
+      metadata: {
+        ...metadata,
+        source: "trace",
+        sourceTraceTimestamp: trace.timestamp.toISOString(),
+      },
+      sourceTraceId: trace.traceId,
+      status: "ACTIVE",
+    },
+  });
+
+  return datasetItem;
+};
+
+const buildRunItemEvent = ({
+  runItemId,
+  trace,
+  datasetId,
+  datasetItemId,
+  runId,
+  createdAt,
+}: {
+  runItemId: string;
+  trace: TraceRunCandidate;
+  datasetId: string;
+  datasetItemId: string;
+  runId: string;
+  createdAt: Date;
+}) => ({
+  id: runItemId,
+  type: eventTypes.DATASET_RUN_ITEM_CREATE,
+  timestamp: createdAt.toISOString(),
+  body: {
+    id: runItemId,
+    traceId: trace.traceId,
+    observationId: undefined,
+    error: null,
+    createdAt: createdAt.toISOString(),
+    datasetId,
+    runId,
+    datasetItemId,
+  },
+});
+
+const toTraceCandidate = (row: {
+  id: string;
+  timestamp: Date;
+  name: string | null;
+  user_id: string | null;
+  session_id: string | null;
+}): TraceRunCandidate => ({
+  traceId: row.id,
+  timestamp: row.timestamp,
+  name: row.name,
+  userId: row.user_id,
+  sessionId: row.session_id,
+});
+
+export const getTraceCandidatesForDatasetRun = async ({
+  traceIds,
+}: {
+  traceIds: string[];
+}): Promise<TraceRunCandidate[]> => {
+  if (traceIds.length === 0) return [];
+
+  const rows = await prisma.$queryRaw<
+    Array<{
+      id: string;
+      timestamp: Date;
+      name: string | null;
+      user_id: string | null;
+      session_id: string | null;
+    }>
+  >`
+    SELECT
+      id,
+      timestamp,
+      name,
+      user_id,
+      session_id
+    FROM traces
+    WHERE id IN (${traceIds.join(",")})
+    ORDER BY timestamp DESC
+  `;
+
+  return rows.map(toTraceCandidate);
+};
+
+export const getExistingDatasetRunItemTraceIds = async ({
+  datasetId,
+  runId,
+  traceIds,
+}: {
+  datasetId: string;
+  runId: string;
+  traceIds: string[];
+}) => {
+  if (traceIds.length === 0) return new Set<string>();
+
+  const rows = await prisma.$queryRaw<Array<{ trace_id: string }>>`
+    SELECT trace_id
+    FROM dataset_run_items
+    WHERE dataset_id = ${datasetId}
+      AND dataset_run_id = ${runId}
+      AND trace_id IN (${traceIds.join(",")})
+  `;
+
+  return new Set(rows.map((row) => row.trace_id));
+};
+
+export const createDatasetRunFromTraces = async ({
+  body,
+  auth,
+}: {
+  body: CreateDatasetRunFromTracesV1Body;
+  auth: ProjectAuth;
+}): Promise<CreateDatasetRunFromTracesV1Response> => {
+  const projectId = auth.scope.projectId;
+  const traceIds = normalizeTraceIds(body.traceIds);
+  assertTraceLimit(traceIds);
+
+  const dataset = await prisma.dataset.findFirst({
+    where: {
+      id: body.datasetId,
+      projectId,
+    },
+    select: {
+      id: true,
+      projectId: true,
+      name: true,
+    },
+  });
+
+  if (!dataset) {
+    throw new LangfuseNotFoundError("Dataset not found");
+  }
+
+  const run = await createOrFetchDatasetRun({
+    projectId,
+    datasetId: dataset.id,
+    name: body.runName,
+    description: body.runDescription ?? undefined,
+    metadata: (body.metadata ?? {}) as JSONValue,
+    createdAt: new Date(),
+  });
+
+  const traces = await getTraceCandidatesForDatasetRun({
+    traceIds,
+  });
+
+  const traceById = new Map(traces.map((trace) => [trace.traceId, trace]));
+  const missingTraceIds = traceIds.filter((traceId) => !traceById.has(traceId));
+
+  if (missingTraceIds.length > 0) {
+    logger.warn("dataset_run_from_traces_missing_trace_ids", {
+      projectId,
+      datasetId: dataset.id,
+      runId: run.id,
+      missingTraceIds,
+    });
+  }
+
+  const existingTraceIds = await getExistingDatasetRunItemTraceIds({
+    datasetId: dataset.id,
+    runId: run.id,
+    traceIds,
+  });
+
+  const createdItems: DatasetRunTraceItem[] = [];
+  const events = [];
+
+  for (const traceId of traceIds) {
+    const trace = traceById.get(traceId);
+    if (!trace || existingTraceIds.has(traceId)) continue;
+
+    const metadata = getTraceItemMetadata({
+      traceId,
+      itemMetadataByTraceId: body.itemMetadataByTraceId ?? undefined,
+    });
+
+    const datasetItem = await createDatasetItemForTrace({
+      projectId,
+      datasetId: dataset.id,
+      trace,
+      metadata,
+    });
+
+    const createdAt = resolveItemCreatedAt({
+      traceId,
+      traceTimestamp: trace.timestamp,
+      createdAtByTraceId: body.createdAtByTraceId ?? undefined,
+    });
+
+    const runItemId = v4();
+    const event = buildRunItemEvent({
+      runItemId,
+      trace,
+      datasetId: dataset.id,
+      datasetItemId: datasetItem.id,
+      runId: run.id,
+      createdAt,
+    });
+
+    events.push(event);
+    createdItems.push({
+      traceId,
+      datasetItemId: datasetItem.id,
+      datasetRunItemId: runItemId,
+      createdAt,
+    });
+  }
+
+  if (events.length > 0) {
+    const ingestionResult = await processEventBatch(events, auth, {
+      isLangfuseInternal: true,
+    });
+
+    if (ingestionResult.errors.length > 0) {
+      logger.warn("dataset_run_from_traces_ingestion_partial_failure", {
+        projectId,
+        datasetId: dataset.id,
+        runId: run.id,
+        errors: ingestionResult.errors,
+      });
+    }
+
+    if (ingestionResult.successes.length !== events.length) {
+      throw new Error("Failed to create all dataset run items");
+    }
+  }
+
+  await Promise.all(
+    createdItems.map((item) =>
+      addDatasetRunItemsToEvalQueue({
+        projectId,
+        datasetItemId: item.datasetItemId,
+        datasetItemValidFrom: item.createdAt,
+        traceId: item.traceId,
+        observationId: undefined,
+      }),
+    ),
+  );
+
+  return {
+    datasetId: dataset.id,
+    datasetRunId: run.id,
+    datasetRunName: run.name,
+    createdCount: createdItems.length,
+    skippedCount: traceIds.length - createdItems.length,
+    data: createdItems.map((item) => ({
+      id: item.datasetRunItemId,
+      traceId: item.traceId,
+      datasetItemId: item.datasetItemId,
+      createdAt: item.createdAt,
+    })),
+  };
+};
+
+export const previewDatasetRunFromTraces = async ({
+  projectId,
+  datasetId,
+  runName,
+  traceIds,
+}: {
+  projectId: string;
+  datasetId: string;
+  runName: string;
+  traceIds: string[];
+}) => {
+  const normalizedTraceIds = normalizeTraceIds(traceIds);
+  assertTraceLimit(normalizedTraceIds);
+
+  const run = await prisma.datasetRuns.findUnique({
+    where: {
+      datasetId_projectId_name: {
+        datasetId,
+        projectId,
+        name: runName,
+      },
+    },
+    select: {
+      id: true,
+      name: true,
+    },
+  });
+
+  const traces = await getTraceCandidatesForDatasetRun({
+    traceIds: normalizedTraceIds,
+  });
+  const foundTraceIds = new Set(traces.map((trace) => trace.traceId));
+  const missingTraceIds = normalizedTraceIds.filter(
+    (traceId) => !foundTraceIds.has(traceId),
+  );
+
+  const alreadyLinkedTraceIds = run
+    ? Array.from(
+        await getExistingDatasetRunItemTraceIds({
+          datasetId,
+          runId: run.id,
+          traceIds: normalizedTraceIds,
+        }),
+      )
+    : [];
+
+  return {
+    datasetId,
+    runName,
+    traceCount: traces.length,
+    alreadyLinkedTraceIds,
+    missingTraceIds,
+  };
+};
diff --git a/web/src/pages/api/public/dataset-runs/from-traces.ts b/web/src/pages/api/public/dataset-runs/from-traces.ts
new file mode 100644
index 000000000..364992b00
--- /dev/null
+++ b/web/src/pages/api/public/dataset-runs/from-traces.ts
@@ -0,0 +1,108 @@
+import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
+import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
+import {
+  CreateDatasetRunFromTracesV1Body,
+  CreateDatasetRunFromTracesV1Response,
+  GetDatasetRunCreationPreviewV1Query,
+  GetDatasetRunCreationPreviewV1Response,
+} from "@/src/features/public-api/types/dataset-runs-from-traces";
+import {
+  createDatasetRunFromTraces,
+  previewDatasetRunFromTraces,
+} from "@/src/features/public-api/server/dataset-runs-from-traces";
+import { logger } from "@langfuse/shared/src/server";
+
+export default withMiddlewares({
+  POST: createAuthedProjectAPIRoute({
+    name: "Create Dataset Run From Traces",
+    bodySchema: CreateDatasetRunFromTracesV1Body,
+    responseSchema: CreateDatasetRunFromTracesV1Response,
+    rateLimitResource: "datasets",
+    fn: async ({ body, auth }) => {
+      logger.info("dataset_run_from_traces_request", {
+        projectId: auth.scope.projectId,
+        datasetId: body.datasetId,
+        runName: body.runName,
+        traceCount: body.traceIds.length,
+      });
+
+      return await createDatasetRunFromTraces({
+        body,
+        auth,
+      });
+    },
+  }),
+  GET: createAuthedProjectAPIRoute({
+    name: "Preview Dataset Run From Traces",
+    querySchema: GetDatasetRunCreationPreviewV1Query,
+    responseSchema: GetDatasetRunCreationPreviewV1Response,
+    rateLimitResource: "datasets",
+    fn: async ({ query, auth }) => {
+      return await previewDatasetRunFromTraces({
+        projectId: auth.scope.projectId,
+        datasetId: query.datasetId,
+        runName: query.runName,
+        traceIds: query.traceIds,
+      });
+    },
+  }),
+});
diff --git a/web/src/features/public-api/server/dataset-run-items.ts b/web/src/features/public-api/server/dataset-run-items.ts
index 2c84df219..aa86b5422 100644
--- a/web/src/features/public-api/server/dataset-run-items.ts
+++ b/web/src/features/public-api/server/dataset-run-items.ts
@@ -1,6 +1,7 @@
 import { transformDbDatasetRunItemToAPIDatasetRunItemCh } from "@/src/features/public-api/types/datasets";
 import { isPresent } from "@langfuse/shared";
 import {
+  getDatasetRunItemsCh,
   getDatasetRunItemsByDatasetIdCh,
   getDatasetRunItemsCountByDatasetIdCh,
 } from "@langfuse/shared/src/server";
@@ -48,3 +49,58 @@ export const getDatasetRunItemsCountForPublicApi = async ({
     ],
   });
 };
+
+export const getDatasetRunItemsByTraceIdsForPublicApi = async ({
+  props,
+}: {
+  props: {
+    datasetId: string;
+    runId: string;
+    projectId: string;
+    traceIds: string[];
+  };
+}) => {
+  const { datasetId, runId, projectId, traceIds } = props;
+  if (traceIds.length === 0) return [];
+
+  const result = await getDatasetRunItemsCh({
+    projectId,
+    datasetId,
+    filter: [
+      {
+        column: "datasetRunId",
+        operator: "any of",
+        value: [runId],
+        type: "stringOptions" as const,
+      },
+      {
+        column: "traceId",
+        operator: "any of",
+        value: traceIds,
+        type: "stringOptions" as const,
+      },
+    ],
+    orderBy: {
+      column: "createdAt",
+      order: "DESC",
+    },
+    limit: traceIds.length,
+  });
+
+  return result.map(transformDbDatasetRunItemToAPIDatasetRunItemCh);
+};
diff --git a/web/src/features/public-api/server/dataset-runs.ts b/web/src/features/public-api/server/dataset-runs.ts
index 7e9d5dfee..a3100fbb1 100644
--- a/web/src/features/public-api/server/dataset-runs.ts
+++ b/web/src/features/public-api/server/dataset-runs.ts
@@ -1,6 +1,7 @@
 import { type jsonSchema } from "@langfuse/shared";
 import { prisma } from "@langfuse/shared/src/db";
 import { v4 } from "uuid";
+import { logger } from "@langfuse/shared/src/server";
 import type z from "zod";
 
 type Json = z.infer<typeof jsonSchema>;
@@ -73,6 +74,18 @@ export const createOrFetchDatasetRun = async ({
         where: {
           datasetId_projectId_name: {
             datasetId,
             projectId,
             name: name,
           },
         },
       });
 
       if (existingRun) {
+        logger.info("dataset_run_reused", {
+          projectId,
+          datasetId,
+          runId: existingRun.id,
+          runName: existingRun.name,
+        });
         return existingRun;
       }
     } else {
       throw error;
     }
diff --git a/web/src/features/public-api/server/__tests__/dataset-runs-from-traces.test.ts b/web/src/features/public-api/server/__tests__/dataset-runs-from-traces.test.ts
new file mode 100644
index 000000000..15d56b476
--- /dev/null
+++ b/web/src/features/public-api/server/__tests__/dataset-runs-from-traces.test.ts
@@ -0,0 +1,132 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import {
+  createDatasetRunFromTraces,
+  getTraceCandidatesForDatasetRun,
+  previewDatasetRunFromTraces,
+} from "../dataset-runs-from-traces";
+import { prisma } from "@langfuse/shared/src/db";
+
+vi.mock("@langfuse/shared/src/db", () => ({
+  prisma: {
+    dataset: {
+      findFirst: vi.fn(),
+    },
+    datasetRuns: {
+      findUnique: vi.fn(),
+      create: vi.fn(),
+    },
+    datasetItem: {
+      create: vi.fn(),
+    },
+    $queryRaw: vi.fn(),
+  },
+}));
+
+vi.mock("@langfuse/shared/src/server", () => ({
+  eventTypes: {
+    DATASET_RUN_ITEM_CREATE: "dataset-run-item-create",
+  },
+  logger: {
+    info: vi.fn(),
+    warn: vi.fn(),
+  },
+  processEventBatch: vi.fn().mockResolvedValue({
+    successes: [{ id: "run-item-1" }],
+    errors: [],
+  }),
+  getDatasetItemById: vi.fn(),
+}));
+
+vi.mock("@/src/features/public-api/server/dataset-runs", () => ({
+  createOrFetchDatasetRun: vi.fn().mockResolvedValue({
+    id: "run-1",
+    name: "candidate-run",
+  }),
+}));
+
+vi.mock("@/src/features/evals/server/addDatasetRunItemsToEvalQueue", () => ({
+  addDatasetRunItemsToEvalQueue: vi.fn().mockResolvedValue(undefined),
+}));
+
+const auth = {
+  scope: {
+    projectId: "project-a",
+    apiKeyId: "key-a",
+  },
+};
+
+describe("dataset runs from traces", () => {
+  beforeEach(() => {
+    vi.clearAllMocks();
+  });
+
+  it("loads trace candidates by ids", async () => {
+    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
+      {
+        id: "trace-1",
+        timestamp: new Date("2026-05-16T00:00:00.000Z"),
+        name: "Checkout",
+        user_id: "user-1",
+        session_id: "session-1",
+      },
+    ]);
+
+    const traces = await getTraceCandidatesForDatasetRun({
+      traceIds: ["trace-1"],
+    });
+
+    expect(traces).toEqual([
+      {
+        traceId: "trace-1",
+        timestamp: new Date("2026-05-16T00:00:00.000Z"),
+        name: "Checkout",
+        userId: "user-1",
+        sessionId: "session-1",
+      },
+    ]);
+  });
+
+  it("creates dataset run items from trace ids", async () => {
+    vi.mocked(prisma.dataset.findFirst).mockResolvedValueOnce({
+      id: "dataset-1",
+      projectId: "project-a",
+      name: "quality-eval",
+    });
+    vi.mocked(prisma.$queryRaw)
+      .mockResolvedValueOnce([
+        {
+          id: "trace-1",
+          timestamp: new Date("2026-05-16T00:00:00.000Z"),
+          name: "Checkout",
+          user_id: "user-1",
+          session_id: "session-1",
+        },
+      ])
+      .mockResolvedValueOnce([]);
+    vi.mocked(prisma.datasetItem.create).mockResolvedValueOnce({
+      id: "dataset-item-1",
+      projectId: "project-a",
+      datasetId: "dataset-1",
+      validFrom: new Date("2026-05-16T00:00:00.000Z"),
+    });
+
+    const result = await createDatasetRunFromTraces({
+      auth,
+      body: {
+        datasetId: "dataset-1",
+        runName: "candidate-run",
+        traceIds: ["trace-1"],
+        createdAtByTraceId: {
+          "trace-1": "2024-01-01T00:00:00.000Z",
+        },
+      },
+    });
+
+    expect(result.datasetId).toBe("dataset-1");
+    expect(result.createdCount).toBe(1);
+    expect(result.data[0]?.traceId).toBe("trace-1");
+  });
+
+  it("previews trace count for a run", async () => {
+    vi.mocked(prisma.datasetRuns.findUnique).mockResolvedValueOnce(null);
+    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
+      {
+        id: "trace-1",
+        timestamp: new Date("2026-05-16T00:00:00.000Z"),
+        name: "Checkout",
+        user_id: "user-1",
+        session_id: "session-1",
+      },
+    ]);
+
+    const result = await previewDatasetRunFromTraces({
+      projectId: "project-a",
+      datasetId: "dataset-1",
+      runName: "candidate-run",
+      traceIds: ["trace-1", "trace-2"],
+    });
+
+    expect(result.traceCount).toBe(1);
+    expect(result.missingTraceIds).toEqual(["trace-2"]);
+  });
+});
```

## Intended Flaws

### Flaw 1: Trace lookup is not project-scoped

- `type`: `tenant_boundary_leak`
- `location`: `web/src/features/public-api/server/dataset-runs-from-traces.ts:92-125`, `:127-146`, `:184-186`
- `learner_prompt`: Does the new bulk run creation endpoint prove that every trace id belongs to the authenticated project before attaching it to a dataset run?

Expected answer:

- Identify: `getTraceCandidatesForDatasetRun` accepts only `traceIds` and queries `FROM traces WHERE id IN (...)` without `project_id = auth.scope.projectId`. The dedupe helper also checks `dataset_run_items` by dataset/run/trace but not project. This lets an authenticated user attach trace ids from another project if they know or guess the id.
- Impact: Cross-project trace references can be written into dataset items and dataset run item events under the attacker's project. That can leak trace names, user ids, session ids, timestamps, and can trigger downstream eval processing against data the project should not own. It also corrupts dataset/run analytics because project-owned datasets now point at foreign tracing data.
- Fix direction: Reuse the existing project-scoped trace repository contract, or add a bulk helper that requires `projectId` and pushes `project_id = ?` into the storage query. Return missing for any trace outside the project. Also scope existing-run-item queries by `projectId` even when dataset/run ids are already expected to imply it, because this is a security boundary.

Hints:

1. Look at the ownership boundary between a dataset and the trace ids supplied by the client.
2. Compare the new helper signature with existing trace/observation lookup helpers that require `projectId`.
3. The dangerous query is the raw trace lookup in `getTraceCandidatesForDatasetRun`; it never mentions `projectId`.

### Flaw 2: The PR lets caller-controlled historical time become creation/ingestion time

- `type`: `contract_mismatch`
- `location`: `web/src/features/public-api/types/dataset-runs-from-traces.ts:113-126`, `web/src/features/public-api/server/dataset-runs-from-traces.ts:64-84`, `:217-225`, `:264-269`
- `learner_prompt`: Is the timestamp contract clear enough to preserve product semantics for dataset run item creation, ordering, metrics, retention, and eval queue processing?

Expected answer:

- Identify: `createdAtByTraceId` is accepted from the public API and flows through `resolveItemCreatedAt` into both the internal ingestion event `timestamp` and body `createdAt`. If absent, the code uses the trace timestamp instead of the server's receipt time. That changes the meaning of dataset run item creation time from "when the item was added to the run" to "some client-provided or trace-observed time."
- Impact: A caller can backdate or future-date dataset run items, which corrupts ordering, pagination, usage metrics, retention windows, background processing assumptions, and any eval behavior that uses creation time or dataset item validity. It also makes incident/debug timelines misleading because the internal event timestamp no longer represents when the system accepted the mutation.
- Fix direction: Use server time for the ingestion event timestamp and dataset run item `createdAt`. If the product needs historical import semantics, add an explicit separate field such as `observedAt`, `sourceTraceTimestamp`, or `importedEventTime`, store it in metadata or a dedicated column, and document how it affects display only. Validate any optional historical timestamp and never let it drive mutation/event creation semantics unless the whole contract is designed around that.

Hints:

1. Ask what `createdAt` means for a newly-created dataset run item.
2. Follow `createdAtByTraceId` into `resolveItemCreatedAt`, then into `buildRunItemEvent`.
3. The internal event timestamp is being set to a user-provided or trace-observed time instead of the time the mutation was accepted.

## Final Expert Debrief

### Product-level change

The PR is trying to make eval workflows faster: instead of calling `POST /dataset-run-items` hundreds of times, a user can create a dataset run from existing trace ids in one request. Product-wise this is a reasonable feature. It converts trace history into an eval dataset run.

### Changed contracts

- Public API contract: a new bulk creation endpoint now accepts trace ids and optional per-trace timestamps.
- Authorization contract: trace ids become inputs to a project-owned dataset mutation.
- Data contract: dataset items and dataset run items now get created from trace metadata.
- Ingestion contract: the endpoint emits internal `DATASET_RUN_ITEM_CREATE` events.
- Time contract: the PR implicitly changes dataset run item creation time from server mutation time to trace/client historical time.

### Failure modes

- Cross-tenant trace attachment if a caller supplies trace ids from another project.
- Leaked trace metadata through dataset item input, eval queue, logs, or downstream run views.
- Corrupt dataset run timelines because created times can be backdated or future-dated.
- Pagination, retention, metrics, and background jobs become hard to reason about because event time no longer means mutation time.
- Tests miss the real boundary: they mock only a happy project and never create a foreign-project trace candidate.

### Reviewer thought process

A strong reviewer should first ask: "This PR turns trace ids into dataset run items. Which system owns traces, which system owns datasets, and what proves they are in the same project?" That points directly to the trace lookup helper. The helper's missing `projectId` parameter is more important than any local style issue because the product feature is crossing a security-sensitive domain boundary.

The second question is: "Which timestamps are product facts and which are operational facts?" Trace timestamp is when the original LLM call happened. Dataset run item creation time is when the run was assembled. Internal event timestamp is when the system accepted a mutation. Those three can be related, but they are not interchangeable. The degraded PR collapses them into one caller-controlled value.

### Better implementation direction

- Add a bulk trace lookup helper shaped like `getTraceCandidatesForDatasetRun({ projectId, traceIds })`.
- Query only traces owned by `projectId`, ideally through the existing trace repository instead of a raw SQL shortcut.
- Treat traces not found in the project as missing, not as a partial authorization success.
- Scope all dataset run item reads by `projectId`.
- Use `new Date()` once as server-side accepted time for the mutation and ingestion event.
- Store trace timestamp as `sourceTraceTimestamp` or `observedAt`, and keep it separate from `createdAt`.
- Add tests for a foreign-project trace id and a backdated `createdAtByTraceId` payload.

## Correctness Verdict Rubric

The learner is correct on flaw 1 if they mention all three:

- trace lookup lacks project scoping,
- this can cross a tenant/project boundary,
- the fix is project-scoped trace validation before writing dataset items/events.

The learner is correct on flaw 2 if they mention all three:

- client/trace time is being used as creation/event time,
- this corrupts ordering/metrics/retention/debugging or eval processing,
- the fix is server mutation time plus a separate source/observed timestamp if needed.

## Why This Case Exists

This is an early exercise because the diff looks useful and mostly reasonable. The bugs are not syntax bugs. They are the two review instincts that matter constantly in large AI-generated PRs:

- When one domain references another domain by id, prove ownership at the boundary.
- When a PR introduces timestamps, force every timestamp to have one clear meaning.
