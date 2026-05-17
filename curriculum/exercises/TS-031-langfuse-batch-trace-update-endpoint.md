# TS-031: Langfuse Batch Trace Update Endpoint

## Metadata

- `id`: TS-031
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: public trace API, batch endpoint contracts, ClickHouse trace rows, project-scoped authorization, partial success semantics, API response schemas, server tests
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,200-1,500
- `represented_diff_lines`: 1423
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about batch API design, item-level error contracts, partial success semantics, auth prevalidation, ClickHouse mutation modeling, and retry-safe client behavior without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a public batch endpoint for updating trace metadata and display fields.

Customers often need to patch traces after ingestion. For example, a nightly enrichment job might attach user segments, mark important traces as bookmarked, add tags after classification, or publish a selected set of traces for sharing. Today clients have to issue many single operations or re-ingest trace-like data, which is slow and hard to reconcile.

The new endpoint adds:

- `PATCH /api/public/traces/batch`,
- up to 1,000 trace updates per request,
- updates for name, user, session, metadata, tags, release, version, environment, public, and bookmarked fields,
- dry-run mode,
- partial-success responses for missing or invalid traces,
- audit logging for updated traces,
- OpenAPI documentation,
- server tests for successful updates, missing traces, dry run, and mixed-project batches.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `web/src/pages/api/public/traces/index.ts` exposes `GET`, `POST`, and `DELETE` through `withMiddlewares` and `createAuthedProjectAPIRoute`.
- `web/src/pages/api/public/traces/[traceId].ts` fetches a single trace by calling `getTraceById({ traceId, projectId: auth.scope.projectId })` and returns `LangfuseNotFoundError` when the trace is not in the authorized project.
- `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` verifies API authentication, checks project scope, applies rate limits, parses query/body schemas, and then calls the route handler with `auth.scope.projectId`.
- `web/src/features/public-api/types/traces.ts` owns the public trace API request and response schemas.
- `packages/shared/src/server/repositories/traces.ts` reads traces from ClickHouse by both `traceId` and `projectId`; project scoping is part of the repository call contract.
- `packages/shared/src/server/test-utils/tracing-factory.ts` and `clickhouse-helpers.ts` show the server-test pattern for creating trace rows in ClickHouse.
- The existing trace delete endpoints accept multiple trace ids but do not expose item-level partial success; they call project-scoped processors after route-level auth.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the implementation and API contract are good enough for production.

## Review Surface

Changed files in the synthetic PR:

- `web/src/features/public-api/types/traces.ts`
- `web/src/features/public-api/server/batchTraceUpdates.ts`
- `web/src/pages/api/public/traces/batch.ts`
- `web/src/__tests__/server/traces-batch-update-api.servertest.ts`
- `fern/apis/server/definition/traces.yml`

The line references below use synthetic PR line numbers. The represented diff is focused on batch API contracts, project scoping, commit ordering, retry semantics, and tests.

## Diff

```diff
diff --git a/web/src/features/public-api/types/traces.ts b/web/src/features/public-api/types/traces.ts
index 8f51b4a18..cbe8a9901 100644
--- a/web/src/features/public-api/types/traces.ts
+++ b/web/src/features/public-api/types/traces.ts
@@ -157,3 +157,166 @@ export const DeleteTracesV1Response = z
   .object({
     message: z.string(),
   })
   .strict();
+
+/**
+ * PATCH /api/public/traces/batch
+ *
+ * This endpoint intentionally accepts only user-visible trace fields. It does
+ * not let clients patch timestamps, costs, generated metrics, observations,
+ * scores, or project ownership. The write path materializes a new trace row in
+ * ClickHouse for each successful update.
+ */
+const PatchableTraceFields = z
+  .object({
+    name: z.string().min(1).max(1_000).nullable().optional(),
+    userId: z.string().min(1).max(1_000).nullable().optional(),
+    sessionId: z.string().min(1).max(1_000).nullable().optional(),
+    release: z.string().min(1).max(1_000).nullable().optional(),
+    version: z.string().min(1).max(1_000).nullable().optional(),
+    environment: z.string().min(1).max(1_000).nullable().optional(),
+    metadata: z.any().optional(),
+    tags: z.array(z.string().min(1).max(1_000)).max(100).optional(),
+    public: z.boolean().optional(),
+    bookmarked: z.boolean().optional(),
+  })
+  .strict();
+
+const hasPatchableTraceField = (value: z.infer<typeof PatchableTraceFields>) =>
+  Object.prototype.hasOwnProperty.call(value, "name") ||
+  Object.prototype.hasOwnProperty.call(value, "userId") ||
+  Object.prototype.hasOwnProperty.call(value, "sessionId") ||
+  Object.prototype.hasOwnProperty.call(value, "release") ||
+  Object.prototype.hasOwnProperty.call(value, "version") ||
+  Object.prototype.hasOwnProperty.call(value, "environment") ||
+  Object.prototype.hasOwnProperty.call(value, "metadata") ||
+  Object.prototype.hasOwnProperty.call(value, "tags") ||
+  Object.prototype.hasOwnProperty.call(value, "public") ||
+  Object.prototype.hasOwnProperty.call(value, "bookmarked");
+
+export const PatchTraceBatchUpdateItem = PatchableTraceFields.extend({
+  traceId: z.string().min(1).max(1_000),
+  clientReferenceId: z.string().min(1).max(1_000).optional(),
+})
+  .strict()
+  .superRefine((value, ctx) => {
+    if (!hasPatchableTraceField(value)) {
+      ctx.addIssue({
+        code: z.ZodIssueCode.custom,
+        message: "At least one trace field must be provided.",
+        path: ["traceId"],
+      });
+    }
+  });
+
+export const PatchTracesBatchV1Body = z
+  .object({
+    updates: z
+      .array(PatchTraceBatchUpdateItem)
+      .min(1, "At least one trace update is required.")
+      .max(1000, "Cannot update more than 1000 traces in one request."),
+    dryRun: z.boolean().default(false),
+    allowPartialSuccess: z.boolean().default(true),
+  })
+  .strict();
+
+export type PatchTracesBatchV1BodyType = z.infer<
+  typeof PatchTracesBatchV1Body
+>;
+
+export type PatchTraceBatchUpdateItemType = z.infer<
+  typeof PatchTraceBatchUpdateItem
+>;
+
+export const PatchTracesBatchV1Response = z
+  .object({
+    successCount: z.number().int().nonnegative(),
+    errorCount: z.number().int().nonnegative(),
+    updatedTraceIds: z.array(z.string()),
+    failedTraceIds: z.array(z.string()),
+    dryRun: z.boolean(),
+  })
+  .strict();
+
+export type PatchTracesBatchV1ResponseType = z.infer<
+  typeof PatchTracesBatchV1Response
+>;
+
+export const PatchTracesBatchExampleRequest = {
+  updates: [
+    {
+      traceId: "trace-1",
+      clientReferenceId: "row-1",
+      metadata: {
+        segment: "enterprise",
+        enrichedBy: "nightly-job",
+      },
+      tags: ["enterprise", "support-priority"],
+      bookmarked: true,
+    },
+    {
+      traceId: "trace-2",
+      clientReferenceId: "row-2",
+      public: true,
+      release: "web@2026.05.15",
+    },
+  ],
+  allowPartialSuccess: true,
+  dryRun: false,
+} satisfies PatchTracesBatchV1BodyType;
+
+export const PatchTracesBatchExampleResponse = {
+  successCount: 2,
+  errorCount: 0,
+  updatedTraceIds: ["trace-1", "trace-2"],
+  failedTraceIds: [],
+  dryRun: false,
+} satisfies PatchTracesBatchV1ResponseType;
+
+export const PatchTracesBatchPartialExampleResponse = {
+  successCount: 1,
+  errorCount: 1,
+  updatedTraceIds: ["trace-1"],
+  failedTraceIds: ["trace-2"],
+  dryRun: false,
+} satisfies PatchTracesBatchV1ResponseType;
+
+export const patchTraceBatchResponseDescription = [
+  "successCount is the number of trace updates accepted by the server.",
+  "errorCount is the number of trace updates rejected by the server.",
+  "updatedTraceIds contains ids that were accepted in this request.",
+  "failedTraceIds contains ids that were not accepted in this request.",
+  "dryRun echoes the dryRun request flag.",
+].join(" ");
+
+export const patchTraceBatchRequestDescription = [
+  "Batch trace updates are applied independently.",
+  "Each item must include traceId and at least one patchable trace field.",
+  "Missing traces are reported in failedTraceIds when partial success is enabled.",
+  "If allowPartialSuccess is false, any item failure rejects the request.",
+].join(" ");
+
+export const patchTraceBatchPatchableFields = [
+  "name",
+  "userId",
+  "sessionId",
+  "release",
+  "version",
+  "environment",
+  "metadata",
+  "tags",
+  "public",
+  "bookmarked",
+] as const;
+
+export type PatchTraceBatchPatchableField =
+  (typeof patchTraceBatchPatchableFields)[number];
+
+export const PatchTraceBatchFieldDescriptions: Record<
+  PatchTraceBatchPatchableField,
+  string
+> = {
+  name: "Display name shown on trace lists and trace detail pages.",
+  userId: "Application user identifier associated with the trace.",
+  sessionId: "Application session identifier associated with the trace.",
+  release: "Release identifier attached to the trace.",
+  version: "Version identifier attached to the trace.",
+  environment: "Environment label used for filtering and segmentation.",
+  metadata: "Arbitrary JSON metadata object stored on the trace.",
+  tags: "Searchable trace tags.",
+  public: "Whether the trace can be opened through public share views.",
+  bookmarked: "Whether the trace is highlighted in project views.",
+};
diff --git a/web/src/features/public-api/server/batchTraceUpdates.ts b/web/src/features/public-api/server/batchTraceUpdates.ts
new file mode 100644
index 000000000..7e9aa71c1
--- /dev/null
+++ b/web/src/features/public-api/server/batchTraceUpdates.ts
@@ -0,0 +1,371 @@
+import { auditLog } from "@/src/features/audit-logs/auditLog";
+import type {
+  PatchTraceBatchUpdateItemType,
+  PatchTracesBatchV1ResponseType,
+} from "@/src/features/public-api/types/traces";
+import {
+  InvalidRequestError,
+  LangfuseNotFoundError,
+  ForbiddenError,
+} from "@langfuse/shared";
+import {
+  clickhouseClient,
+  getTraceById,
+  logger,
+  queryClickhouse,
+  type TraceRecordInsertType,
+} from "@langfuse/shared/src/server";
+
+type BatchTraceUpdateInput = {
+  projectId: string;
+  orgId: string;
+  apiKeyId: string;
+  updates: PatchTraceBatchUpdateItemType[];
+  dryRun: boolean;
+  allowPartialSuccess: boolean;
+};
+
+type TracePatchRecord = {
+  id: string;
+  projectId: string;
+  timestamp: Date;
+  name: string | null;
+  userId: string | null;
+  sessionId: string | null;
+  release: string | null;
+  version: string | null;
+  environment: string;
+  metadata: unknown;
+  tags: string[];
+  input: string | null;
+  output: string | null;
+  public: boolean;
+  bookmarked: boolean;
+  createdAt: Date;
+  updatedAt: Date;
+};
+
+type BatchTraceUpdateFailure = {
+  traceId: string;
+  reason: "not_found" | "forbidden" | "invalid" | "write_failed";
+  message: string;
+};
+
+type BatchTraceUpdateAccumulator = {
+  updatedTraceIds: string[];
+  failedTraceIds: string[];
+  failures: BatchTraceUpdateFailure[];
+};
+
+const nowAsClickhouseMillis = () => Date.now();
+
+const toClickhouseTimestamp = (date: Date) => date.getTime();
+
+const normalizeMetadata = (metadata: unknown) => {
+  if (metadata === undefined) {
+    return undefined;
+  }
+  if (metadata === null) {
+    return {};
+  }
+  return metadata;
+};
+
+const mergeTracePatch = (
+  existing: TracePatchRecord,
+  patch: PatchTraceBatchUpdateItemType,
+): TraceRecordInsertType => {
+  const metadata =
+    Object.prototype.hasOwnProperty.call(patch, "metadata") &&
+    normalizeMetadata(patch.metadata) !== undefined
+      ? normalizeMetadata(patch.metadata)
+      : existing.metadata;
+
+  return {
+    id: existing.id,
+    project_id: existing.projectId,
+    timestamp: toClickhouseTimestamp(existing.timestamp),
+    name:
+      Object.prototype.hasOwnProperty.call(patch, "name") && patch.name !== undefined
+        ? patch.name
+        : existing.name,
+    user_id:
+      Object.prototype.hasOwnProperty.call(patch, "userId") &&
+      patch.userId !== undefined
+        ? patch.userId
+        : existing.userId,
+    session_id:
+      Object.prototype.hasOwnProperty.call(patch, "sessionId") &&
+      patch.sessionId !== undefined
+        ? patch.sessionId
+        : existing.sessionId,
+    release:
+      Object.prototype.hasOwnProperty.call(patch, "release") &&
+      patch.release !== undefined
+        ? patch.release
+        : existing.release,
+    version:
+      Object.prototype.hasOwnProperty.call(patch, "version") &&
+      patch.version !== undefined
+        ? patch.version
+        : existing.version,
+    environment:
+      Object.prototype.hasOwnProperty.call(patch, "environment") &&
+      patch.environment !== undefined &&
+      patch.environment !== null
+        ? patch.environment
+        : existing.environment,
+    metadata,
+    tags:
+      Object.prototype.hasOwnProperty.call(patch, "tags") &&
+      patch.tags !== undefined
+        ? patch.tags
+        : existing.tags,
+    input: existing.input,
+    output: existing.output,
+    public:
+      Object.prototype.hasOwnProperty.call(patch, "public") &&
+      patch.public !== undefined
+        ? patch.public
+        : existing.public,
+    bookmarked:
+      Object.prototype.hasOwnProperty.call(patch, "bookmarked") &&
+      patch.bookmarked !== undefined
+        ? patch.bookmarked
+        : existing.bookmarked,
+    created_at: toClickhouseTimestamp(existing.createdAt),
+    updated_at: nowAsClickhouseMillis(),
+    event_ts: nowAsClickhouseMillis(),
+    is_deleted: 0,
+  };
+};
+
+const getTraceWithoutProjectScope = async (
+  traceId: string,
+): Promise<TracePatchRecord | null> => {
+  const rows = await queryClickhouse<{
+    id: string;
+    project_id: string;
+    timestamp: string;
+    name: string | null;
+    user_id: string | null;
+    session_id: string | null;
+    release: string | null;
+    version: string | null;
+    environment: string | null;
+    metadata: unknown;
+    tags: string[];
+    input: string | null;
+    output: string | null;
+    public: boolean;
+    bookmarked: boolean;
+    created_at: string;
+    updated_at: string;
+  }>({
+    query: `
+      SELECT
+        id,
+        project_id,
+        timestamp,
+        name,
+        user_id,
+        session_id,
+        release,
+        version,
+        environment,
+        metadata,
+        tags,
+        input,
+        output,
+        public,
+        bookmarked,
+        created_at,
+        updated_at
+      FROM traces
+      WHERE id = {traceId: String}
+        AND is_deleted = 0
+      ORDER BY timestamp DESC
+      LIMIT 1
+    `,
+    params: { traceId },
+    tags: {
+      feature: "public-api",
+      type: "trace",
+      kind: "batch-update-by-id",
+      operation_name: "getTraceForBatchUpdate",
+    },
+    preferredClickhouseService: "ReadOnly",
+  });
+
+  const row = rows[0];
+  if (!row) {
+    return null;
+  }
+
+  return {
+    id: row.id,
+    projectId: row.project_id,
+    timestamp: new Date(row.timestamp),
+    name: row.name,
+    userId: row.user_id,
+    sessionId: row.session_id,
+    release: row.release,
+    version: row.version,
+    environment: row.environment ?? "default",
+    metadata: row.metadata,
+    tags: row.tags ?? [],
+    input: row.input,
+    output: row.output,
+    public: row.public,
+    bookmarked: row.bookmarked,
+    createdAt: new Date(row.created_at),
+    updatedAt: new Date(row.updated_at),
+  };
+};
+
+const writeTracePatch = async (row: TraceRecordInsertType) => {
+  await clickhouseClient().insert({
+    table: "traces",
+    format: "JSONEachRow",
+    values: [row],
+  });
+};
+
+const ensureNoDuplicateTraceIds = (
+  updates: PatchTraceBatchUpdateItemType[],
+) => {
+  const seen = new Set<string>();
+  for (const item of updates) {
+    if (seen.has(item.traceId)) {
+      throw new InvalidRequestError(
+        `Duplicate traceId "${item.traceId}" in batch update request.`,
+      );
+    }
+    seen.add(item.traceId);
+  }
+};
+
+const auditBatchTraceUpdate = async ({
+  projectId,
+  orgId,
+  apiKeyId,
+  traceId,
+  fields,
+  dryRun,
+}: {
+  projectId: string;
+  orgId: string;
+  apiKeyId: string;
+  traceId: string;
+  fields: string[];
+  dryRun: boolean;
+}) => {
+  await auditLog({
+    resourceType: "trace",
+    resourceId: traceId,
+    action: dryRun ? "validate" : "update",
+    projectId,
+    orgId,
+    apiKeyId,
+    after: {
+      source: "public-api-batch-update",
+      fields,
+      dryRun,
+    },
+  });
+};
+
+const getPatchedFields = (item: PatchTraceBatchUpdateItemType) =>
+  [
+    "name",
+    "userId",
+    "sessionId",
+    "release",
+    "version",
+    "environment",
+    "metadata",
+    "tags",
+    "public",
+    "bookmarked",
+  ].filter((field) => Object.prototype.hasOwnProperty.call(item, field));
+
+const recordFailure = (
+  accumulator: BatchTraceUpdateAccumulator,
+  failure: BatchTraceUpdateFailure,
+) => {
+  accumulator.failedTraceIds.push(failure.traceId);
+  accumulator.failures.push(failure);
+};
+
+const shouldThrowForFailure = (
+  allowPartialSuccess: boolean,
+  failure: BatchTraceUpdateFailure,
+) => !allowPartialSuccess || failure.reason === "forbidden";
+
+export const applyBatchTraceUpdates = async ({
+  projectId,
+  orgId,
+  apiKeyId,
+  updates,
+  dryRun,
+  allowPartialSuccess,
+}: BatchTraceUpdateInput): Promise<PatchTracesBatchV1ResponseType> => {
+  ensureNoDuplicateTraceIds(updates);
+
+  const accumulator: BatchTraceUpdateAccumulator = {
+    updatedTraceIds: [],
+    failedTraceIds: [],
+    failures: [],
+  };
+
+  for (const item of updates) {
+    const trace = await getTraceWithoutProjectScope(item.traceId);
+
+    if (!trace) {
+      const failure: BatchTraceUpdateFailure = {
+        traceId: item.traceId,
+        reason: "not_found",
+        message: `Trace ${item.traceId} does not exist.`,
+      };
+
+      recordFailure(accumulator, failure);
+
+      if (shouldThrowForFailure(allowPartialSuccess, failure)) {
+        throw new LangfuseNotFoundError(failure.message);
+      }
+
+      continue;
+    }
+
+    if (trace.projectId !== projectId) {
+      const failure: BatchTraceUpdateFailure = {
+        traceId: item.traceId,
+        reason: "forbidden",
+        message: `Trace ${item.traceId} is not in the authorized project.`,
+      };
+
+      recordFailure(accumulator, failure);
+
+      if (shouldThrowForFailure(allowPartialSuccess, failure)) {
+        throw new ForbiddenError(failure.message);
+      }
+
+      continue;
+    }
+
+    const patchedRow = mergeTracePatch(trace, item);
+    const fields = getPatchedFields(item);
+
+    if (!dryRun) {
+      try {
+        await writeTracePatch(patchedRow);
+      } catch (error) {
+        logger.error("Failed to write trace batch update row", {
+          projectId,
+          traceId: item.traceId,
+          error,
+        });
+
+        const failure: BatchTraceUpdateFailure = {
+          traceId: item.traceId,
+          reason: "write_failed",
+          message: `Failed to update trace ${item.traceId}.`,
+        };
+
+        recordFailure(accumulator, failure);
+
+        if (shouldThrowForFailure(allowPartialSuccess, failure)) {
+          throw error;
+        }
+
+        continue;
+      }
+    }
+
+    await auditBatchTraceUpdate({
+      projectId,
+      orgId,
+      apiKeyId,
+      traceId: item.traceId,
+      fields,
+      dryRun,
+    });
+
+    accumulator.updatedTraceIds.push(item.traceId);
+  }
+
+  logger.info("Processed public trace batch update", {
+    projectId,
+    dryRun,
+    successCount: accumulator.updatedTraceIds.length,
+    errorCount: accumulator.failedTraceIds.length,
+    failedTraceIds: accumulator.failedTraceIds,
+  });
+
+  return {
+    successCount: accumulator.updatedTraceIds.length,
+    errorCount: accumulator.failedTraceIds.length,
+    updatedTraceIds: accumulator.updatedTraceIds,
+    failedTraceIds: accumulator.failedTraceIds,
+    dryRun,
+  };
+};
+
+export const validateBatchTraceUpdateVisibility = async ({
+  projectId,
+  traceIds,
+}: {
+  projectId: string;
+  traceIds: string[];
+}) => {
+  const uniqueTraceIds = Array.from(new Set(traceIds));
+  const visibleTraceIds = new Set<string>();
+
+  await Promise.all(
+    uniqueTraceIds.map(async (traceId) => {
+      const trace = await getTraceById({
+        traceId,
+        projectId,
+        clickhouseFeatureTag: "public-api-batch-update",
+        preferredClickhouseService: "ReadOnly",
+        excludeInputOutput: true,
+        excludeMetadata: true,
+      });
+
+      if (trace) {
+        visibleTraceIds.add(traceId);
+      }
+    }),
+  );
+
+  return visibleTraceIds;
+};
diff --git a/web/src/pages/api/public/traces/batch.ts b/web/src/pages/api/public/traces/batch.ts
new file mode 100644
index 000000000..4ce9bb185
--- /dev/null
+++ b/web/src/pages/api/public/traces/batch.ts
@@ -0,0 +1,100 @@
+import {
+  PatchTracesBatchV1Body,
+  PatchTracesBatchV1Response,
+} from "@/src/features/public-api/types/traces";
+import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
+import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
+import { applyBatchTraceUpdates } from "@/src/features/public-api/server/batchTraceUpdates";
+import { telemetry } from "@/src/features/telemetry";
+
+export default withMiddlewares({
+  PATCH: createAuthedProjectAPIRoute({
+    name: "Batch Update Traces",
+    bodySchema: PatchTracesBatchV1Body,
+    responseSchema: PatchTracesBatchV1Response,
+    rateLimitResource: "public-api",
+    fn: async ({ body, auth }) => {
+      await telemetry();
+
+      const result = await applyBatchTraceUpdates({
+        projectId: auth.scope.projectId,
+        orgId: auth.scope.orgId,
+        apiKeyId: auth.scope.apiKeyId,
+        updates: body.updates,
+        dryRun: body.dryRun,
+        allowPartialSuccess: body.allowPartialSuccess,
+      });
+
+      return result;
+    },
+  }),
+});
diff --git a/web/src/__tests__/server/traces-batch-update-api.servertest.ts b/web/src/__tests__/server/traces-batch-update-api.servertest.ts
new file mode 100644
index 000000000..5d75fb983
--- /dev/null
+++ b/web/src/__tests__/server/traces-batch-update-api.servertest.ts
@@ -0,0 +1,503 @@
+import {
+  createOrgProjectAndApiKey,
+  createTrace,
+  createTracesCh,
+  getTraceById,
+  type TraceRecordInsertType,
+} from "@langfuse/shared/src/server";
+import {
+  makeZodVerifiedAPICall,
+  makeZodVerifiedAPICallSilent,
+} from "@/src/__tests__/test-utils";
+import {
+  PatchTracesBatchV1Response,
+  type PatchTracesBatchV1BodyType,
+} from "@/src/features/public-api/types/traces";
+import { randomUUID } from "crypto";
+import waitForExpect from "wait-for-expect";
+
+type TestProject = {
+  projectId: string;
+  auth: string;
+  orgId: string;
+  apiKeyId: string;
+};
+
+const endpoint = "/api/public/traces/batch";
+
+const createTestProject = async (): Promise<TestProject> => {
+  const { projectId, auth, orgId, apiKeyId } =
+    await createOrgProjectAndApiKey();
+  return { projectId, auth, orgId, apiKeyId };
+};
+
+const createStoredTrace = async (
+  projectId: string,
+  input: Partial<TraceRecordInsertType> = {},
+) => {
+  const trace = createTrace({
+    id: randomUUID(),
+    project_id: projectId,
+    name: "batch-update-fixture",
+    user_id: "user-original",
+    session_id: "session-original",
+    environment: "default",
+    metadata: { original: true },
+    tags: ["before"],
+    public: false,
+    bookmarked: false,
+    release: "web@1",
+    version: "1",
+    ...input,
+  });
+
+  await createTracesCh([trace]);
+  return trace;
+};
+
+const readTrace = async (projectId: string, traceId: string) => {
+  const trace = await getTraceById({
+    traceId,
+    projectId,
+    clickhouseFeatureTag: "trace-batch-update-test",
+    preferredClickhouseService: "ReadOnly",
+  });
+
+  expect(trace).toBeTruthy();
+  return trace!;
+};
+
+const waitForTraceField = async (
+  projectId: string,
+  traceId: string,
+  assertFn: (trace: Awaited<ReturnType<typeof readTrace>>) => void,
+) => {
+  await waitForExpect(async () => {
+    const trace = await readTrace(projectId, traceId);
+    assertFn(trace);
+  });
+};
+
+describe("PATCH /api/public/traces/batch", () => {
+  it("updates multiple traces in one request", async () => {
+    const { projectId, auth } = await createTestProject();
+    const first = await createStoredTrace(projectId, {
+      name: "first-before",
+      metadata: { source: "before" },
+      tags: ["first"],
+    });
+    const second = await createStoredTrace(projectId, {
+      name: "second-before",
+      metadata: { source: "before" },
+      tags: ["second"],
+    });
+
+    const body: PatchTracesBatchV1BodyType = {
+      updates: [
+        {
+          traceId: first.id,
+          clientReferenceId: "first-row",
+          name: "first-after",
+          metadata: {
+            source: "nightly-enrichment",
+            segment: "enterprise",
+          },
+          tags: ["first", "enterprise"],
+          public: true,
+          bookmarked: true,
+        },
+        {
+          traceId: second.id,
+          clientReferenceId: "second-row",
+          name: "second-after",
+          userId: "user-after",
+          sessionId: "session-after",
+          release: "web@2",
+          version: "2",
+          environment: "production",
+        },
+      ],
+      allowPartialSuccess: true,
+      dryRun: false,
+    };
+
+    const response = await makeZodVerifiedAPICall(
+      PatchTracesBatchV1Response,
+      "PATCH",
+      endpoint,
+      body,
+      auth,
+    );
+
+    expect(response.status).toBe(200);
+    expect(response.body).toEqual({
+      successCount: 2,
+      errorCount: 0,
+      updatedTraceIds: [first.id, second.id],
+      failedTraceIds: [],
+      dryRun: false,
+    });
+
+    await waitForTraceField(projectId, first.id, (trace) => {
+      expect(trace.name).toBe("first-after");
+      expect(trace.metadata).toEqual({
+        source: "nightly-enrichment",
+        segment: "enterprise",
+      });
+      expect(trace.tags).toEqual(["first", "enterprise"]);
+      expect(trace.public).toBe(true);
+      expect(trace.bookmarked).toBe(true);
+    });
+
+    await waitForTraceField(projectId, second.id, (trace) => {
+      expect(trace.name).toBe("second-after");
+      expect(trace.userId).toBe("user-after");
+      expect(trace.sessionId).toBe("session-after");
+      expect(trace.release).toBe("web@2");
+      expect(trace.version).toBe("2");
+      expect(trace.environment).toBe("production");
+    });
+  });
+
+  it("supports dry run without mutating traces", async () => {
+    const { projectId, auth } = await createTestProject();
+    const trace = await createStoredTrace(projectId, {
+      name: "dry-run-before",
+      metadata: { state: "before" },
+      bookmarked: false,
+    });
+
+    const body: PatchTracesBatchV1BodyType = {
+      updates: [
+        {
+          traceId: trace.id,
+          name: "dry-run-after",
+          metadata: { state: "after" },
+          bookmarked: true,
+        },
+      ],
+      allowPartialSuccess: true,
+      dryRun: true,
+    };
+
+    const response = await makeZodVerifiedAPICall(
+      PatchTracesBatchV1Response,
+      "PATCH",
+      endpoint,
+      body,
+      auth,
+    );
+
+    expect(response.status).toBe(200);
+    expect(response.body).toEqual({
+      successCount: 1,
+      errorCount: 0,
+      updatedTraceIds: [trace.id],
+      failedTraceIds: [],
+      dryRun: true,
+    });
+
+    const stored = await readTrace(projectId, trace.id);
+    expect(stored.name).toBe("dry-run-before");
+    expect(stored.metadata).toEqual({ state: "before" });
+    expect(stored.bookmarked).toBe(false);
+  });
+
+  it("returns failed ids for missing traces when partial success is enabled", async () => {
+    const { projectId, auth } = await createTestProject();
+    const trace = await createStoredTrace(projectId, {
+      name: "valid-before",
+      metadata: { ok: false },
+    });
+    const missingTraceId = randomUUID();
+
+    const body: PatchTracesBatchV1BodyType = {
+      updates: [
+        {
+          traceId: trace.id,
+          name: "valid-after",
+          metadata: { ok: true },
+        },
+        {
+          traceId: missingTraceId,
+          name: "missing-after",
+          metadata: { ok: true },
+        },
+      ],
+      allowPartialSuccess: true,
+      dryRun: false,
+    };
+
+    const response = await makeZodVerifiedAPICall(
+      PatchTracesBatchV1Response,
+      "PATCH",
+      endpoint,
+      body,
+      auth,
+    );
+
+    expect(response.status).toBe(200);
+    expect(response.body).toEqual({
+      successCount: 1,
+      errorCount: 1,
+      updatedTraceIds: [trace.id],
+      failedTraceIds: [missingTraceId],
+      dryRun: false,
+    });
+
+    await waitForTraceField(projectId, trace.id, (stored) => {
+      expect(stored.name).toBe("valid-after");
+      expect(stored.metadata).toEqual({ ok: true });
+    });
+  });
+
+  it("rejects missing traces when partial success is disabled", async () => {
+    const { auth } = await createTestProject();
+    const missingTraceId = randomUUID();
+
+    const body: PatchTracesBatchV1BodyType = {
+      updates: [
+        {
+          traceId: missingTraceId,
+          name: "missing-after",
+          metadata: { ok: true },
+        },
+      ],
+      allowPartialSuccess: false,
+      dryRun: false,
+    };
+
+    const response = await makeZodVerifiedAPICallSilent(
+      "PATCH",
+      endpoint,
+      body,
+      auth,
+    );
+
+    expect(response.status).toBe(404);
+    expect(await response.json()).toEqual({
+      message: `Trace ${missingTraceId} does not exist.`,
+    });
+  });
+
+  it("keeps already-updated traces when a later item belongs to another project", async () => {
+    const firstProject = await createTestProject();
+    const secondProject = await createTestProject();
+    const authorizedTrace = await createStoredTrace(firstProject.projectId, {
+      name: "authorized-before",
+      metadata: { tenant: "first" },
+    });
+    const foreignTrace = await createStoredTrace(secondProject.projectId, {
+      name: "foreign-before",
+      metadata: { tenant: "second" },
+    });
+
+    const body: PatchTracesBatchV1BodyType = {
+      updates: [
+        {
+          traceId: authorizedTrace.id,
+          name: "authorized-after",
+          metadata: { tenant: "first", enriched: true },
+        },
+        {
+          traceId: foreignTrace.id,
+          name: "foreign-after",
+          metadata: { tenant: "second", enriched: true },
+        },
+      ],
+      allowPartialSuccess: true,
+      dryRun: false,
+    };
+
+    const response = await makeZodVerifiedAPICallSilent(
+      "PATCH",
+      endpoint,
+      body,
+      firstProject.auth,
+    );
+
+    expect(response.status).toBe(403);
+    expect(await response.json()).toEqual({
+      message: `Trace ${foreignTrace.id} is not in the authorized project.`,
+    });
+
+    await waitForTraceField(firstProject.projectId, authorizedTrace.id, (trace) => {
+      expect(trace.name).toBe("authorized-after");
+      expect(trace.metadata).toEqual({
+        tenant: "first",
+        enriched: true,
+      });
+    });
+
+    const foreignAfter = await readTrace(secondProject.projectId, foreignTrace.id);
+    expect(foreignAfter.name).toBe("foreign-before");
+    expect(foreignAfter.metadata).toEqual({ tenant: "second" });
+  });
+
+  it("rejects duplicate trace ids", async () => {
+    const { projectId, auth } = await createTestProject();
+    const trace = await createStoredTrace(projectId, {
+      name: "duplicate-before",
+    });
+
+    const body: PatchTracesBatchV1BodyType = {
+      updates: [
+        {
+          traceId: trace.id,
+          name: "duplicate-one",
+        },
+        {
+          traceId: trace.id,
+          name: "duplicate-two",
+        },
+      ],
+      allowPartialSuccess: true,
+      dryRun: false,
+    };
+
+    const response = await makeZodVerifiedAPICallSilent(
+      "PATCH",
+      endpoint,
+      body,
+      auth,
+    );
+
+    expect(response.status).toBe(400);
+    expect(await response.json()).toEqual({
+      message: `Duplicate traceId "${trace.id}" in batch update request.`,
+    });
+
+    const stored = await readTrace(projectId, trace.id);
+    expect(stored.name).toBe("duplicate-before");
+  });
+
+  it("validates that at least one field is provided per update item", async () => {
+    const { auth } = await createTestProject();
+
+    const response = await makeZodVerifiedAPICallSilent(
+      "PATCH",
+      endpoint,
+      {
+        updates: [{ traceId: randomUUID() }],
+        allowPartialSuccess: true,
+        dryRun: false,
+      },
+      auth,
+    );
+
+    expect(response.status).toBe(400);
+    expect(await response.json()).toEqual({
+      message: expect.stringContaining(
+        "At least one trace field must be provided.",
+      ),
+    });
+  });
+
+  it("rejects more than one thousand trace updates", async () => {
+    const { auth } = await createTestProject();
+
+    const response = await makeZodVerifiedAPICallSilent(
+      "PATCH",
+      endpoint,
+      {
+        updates: Array.from({ length: 1001 }, (_, index) => ({
+          traceId: `trace-${index}`,
+          name: `trace-name-${index}`,
+        })),
+        allowPartialSuccess: true,
+        dryRun: false,
+      },
+      auth,
+    );
+
+    expect(response.status).toBe(400);
+    expect(await response.json()).toEqual({
+      message: expect.stringContaining(
+        "Cannot update more than 1000 traces in one request.",
+      ),
+    });
+  });
+
+  it("allows nullable display fields to clear optional trace metadata", async () => {
+    const { projectId, auth } = await createTestProject();
+    const trace = await createStoredTrace(projectId, {
+      name: "clear-before",
+      user_id: "user-before",
+      session_id: "session-before",
+      release: "release-before",
+      version: "version-before",
+      metadata: { retained: false },
+    });
+
+    const body: PatchTracesBatchV1BodyType = {
+      updates: [
+        {
+          traceId: trace.id,
+          name: null,
+          userId: null,
+          sessionId: null,
+          release: null,
+          version: null,
+          metadata: null,
+        },
+      ],
+      allowPartialSuccess: true,
+      dryRun: false,
+    };
+
+    const response = await makeZodVerifiedAPICall(
+      PatchTracesBatchV1Response,
+      "PATCH",
+      endpoint,
+      body,
+      auth,
+    );
+
+    expect(response.status).toBe(200);
+    expect(response.body.updatedTraceIds).toEqual([trace.id]);
+    expect(response.body.failedTraceIds).toEqual([]);
+
+    await waitForTraceField(projectId, trace.id, (stored) => {
+      expect(stored.name).toBeNull();
+      expect(stored.userId).toBeNull();
+      expect(stored.sessionId).toBeNull();
+      expect(stored.release).toBeNull();
+      expect(stored.version).toBeNull();
+      expect(stored.metadata).toEqual({});
+    });
+  });
+
+  it("preserves omitted fields while patching selected fields", async () => {
+    const { projectId, auth } = await createTestProject();
+    const trace = await createStoredTrace(projectId, {
+      name: "preserve-before",
+      user_id: "user-before",
+      session_id: "session-before",
+      release: "release-before",
+      version: "version-before",
+      environment: "default",
+      metadata: { keep: true },
+      tags: ["keep"],
+      public: false,
+      bookmarked: false,
+    });
+
+    const body: PatchTracesBatchV1BodyType = {
+      updates: [
+        {
+          traceId: trace.id,
+          name: "preserve-after",
+          bookmarked: true,
+        },
+      ],
+      allowPartialSuccess: true,
+      dryRun: false,
+    };
+
+    const response = await makeZodVerifiedAPICall(
+      PatchTracesBatchV1Response,
+      "PATCH",
+      endpoint,
+      body,
+      auth,
+    );
+
+    expect(response.status).toBe(200);
+    expect(response.body).toEqual({
+      successCount: 1,
+      errorCount: 0,
+      updatedTraceIds: [trace.id],
+      failedTraceIds: [],
+      dryRun: false,
+    });
+
+    await waitForTraceField(projectId, trace.id, (stored) => {
+      expect(stored.name).toBe("preserve-after");
+      expect(stored.userId).toBe("user-before");
+      expect(stored.sessionId).toBe("session-before");
+      expect(stored.release).toBe("release-before");
+      expect(stored.version).toBe("version-before");
+      expect(stored.environment).toBe("default");
+      expect(stored.metadata).toEqual({ keep: true });
+      expect(stored.tags).toEqual(["keep"]);
+      expect(stored.public).toBe(false);
+      expect(stored.bookmarked).toBe(true);
+    });
+  });
+});
diff --git a/fern/apis/server/definition/traces.yml b/fern/apis/server/definition/traces.yml
index e3921cb1b..a4d1e622c 100644
--- a/fern/apis/server/definition/traces.yml
+++ b/fern/apis/server/definition/traces.yml
@@ -112,6 +112,226 @@ service:
       response: DeleteTraceResponse
       errors:
         - commons.Error
+  patchBatch:
+    docs: |
+      Update up to one thousand traces in a single request.
+
+      The endpoint is intended for post-ingestion enrichment workflows where a
+      client already knows trace ids and wants to attach display fields, tags,
+      metadata, release labels, version labels, visibility flags, or bookmark
+      state. It uses the same project API keys as the existing traces API.
+
+      By default the endpoint supports partial success. Missing traces are
+      placed into `failedTraceIds` while successful traces are returned in
+      `updatedTraceIds`. Set `allowPartialSuccess` to false when the entire
+      request should fail if any item cannot be updated.
+    method: PATCH
+    path: /traces/batch
+    request: BatchTracePatchRequest
+    response: BatchTracePatchResponse
+    errors:
+      - commons.Error
+
+types:
+  BatchTracePatchRequest:
+    properties:
+      updates:
+        docs: Trace update items. The request may contain between one and one thousand items.
+        type: list<BatchTracePatchItem>
+      allowPartialSuccess:
+        docs: Whether the server should update valid items when other items fail.
+        type: optional<boolean>
+      dryRun:
+        docs: Validate and report the request without writing changes.
+        type: optional<boolean>
+    examples:
+      - name: NightlyEnrichment
+        value:
+          updates:
+            - traceId: trace-1
+              clientReferenceId: enrichment-row-1
+              metadata:
+                segment: enterprise
+                enrichedBy: nightly-job
+              tags:
+                - enterprise
+                - support-priority
+              bookmarked: true
+            - traceId: trace-2
+              clientReferenceId: enrichment-row-2
+              public: true
+              release: web@2026.05.15
+          allowPartialSuccess: true
+          dryRun: false
+  BatchTracePatchItem:
+    properties:
+      traceId:
+        docs: Trace id to update.
+        type: string
+      clientReferenceId:
+        docs: Optional client-side reference value for request logging.
+        type: optional<string>
+      name:
+        docs: Trace display name.
+        type: optional<string>
+      userId:
+        docs: Application user id associated with the trace.
+        type: optional<string>
+      sessionId:
+        docs: Application session id associated with the trace.
+        type: optional<string>
+      release:
+        docs: Release label associated with the trace.
+        type: optional<string>
+      version:
+        docs: Version label associated with the trace.
+        type: optional<string>
+      environment:
+        docs: Environment label associated with the trace.
+        type: optional<string>
+      metadata:
+        docs: Full metadata object to store on the trace.
+        type: unknown
+      tags:
+        docs: Full tag list to store on the trace.
+        type: optional<list<string>>
+      public:
+        docs: Whether public trace sharing is enabled for this trace.
+        type: optional<boolean>
+      bookmarked:
+        docs: Whether the trace is bookmarked.
+        type: optional<boolean>
+  BatchTracePatchResponse:
+    properties:
+      successCount:
+        docs: Number of trace updates accepted.
+        type: integer
+      errorCount:
+        docs: Number of trace updates rejected.
+        type: integer
+      updatedTraceIds:
+        docs: Trace ids accepted by the server.
+        type: list<string>
+      failedTraceIds:
+        docs: Trace ids rejected by the server.
+        type: list<string>
+      dryRun:
+        docs: Whether the request was validated without writing changes.
+        type: boolean
+    examples:
+      - name: AllUpdated
+        value:
+          successCount: 2
+          errorCount: 0
+          updatedTraceIds:
+            - trace-1
+            - trace-2
+          failedTraceIds: []
+          dryRun: false
+      - name: PartialSuccess
+        value:
+          successCount: 1
+          errorCount: 1
+          updatedTraceIds:
+            - trace-1
+          failedTraceIds:
+            - trace-2
+          dryRun: false
+
+  BatchTracePatchField:
+    enum:
+      - name
+      - userId
+      - sessionId
+      - release
+      - version
+      - environment
+      - metadata
+      - tags
+      - public
+      - bookmarked
+
+  BatchTracePatchUsageNotes:
+    properties:
+      summary:
+        type: string
+      updateLimit:
+        type: integer
+      supportsDryRun:
+        type: boolean
+      supportsPartialSuccess:
+        type: boolean
+      patchableFields:
+        type: list<BatchTracePatchField>
+    examples:
+      - name: Default
+        value:
+          summary: Batch patch display and enrichment fields on existing traces.
+          updateLimit: 1000
+          supportsDryRun: true
+          supportsPartialSuccess: true
+          patchableFields:
+            - name
+            - userId
+            - sessionId
+            - release
+            - version
+            - environment
+            - metadata
+            - tags
+            - public
+            - bookmarked
+
+  BatchTracePatchClientExample:
+    properties:
+      language:
+        type: string
+      code:
+        type: string
+    examples:
+      - name: TypeScript
+        value:
+          language: typescript
+          code: |
+            await fetch("https://cloud.langfuse.com/api/public/traces/batch", {
+              method: "PATCH",
+              headers: {
+                "content-type": "application/json",
+                authorization: `Basic ${encodedKeys}`,
+              },
+              body: JSON.stringify({
+                updates: [
+                  {
+                    traceId: "trace-1",
+                    metadata: { segment: "enterprise" },
+                    tags: ["enterprise"],
+                  },
+                  {
+                    traceId: "trace-2",
+                    public: true,
+                  },
+                ],
+              }),
+            });
+
+  BatchTracePatchOperationalGuidance:
+    properties:
+      retryGuidance:
+        type: string
+      consistencyGuidance:
+        type: string
+      authGuidance:
+        type: string
+      validationGuidance:
+        type: string
+    examples:
+      - name: Default
+        value:
+          retryGuidance: Retry failedTraceIds after correcting client-side data or waiting for traces to be available.
+          consistencyGuidance: Updated traces may take a short period to appear in list views because the trace table is backed by ClickHouse.
+          authGuidance: The request is authorized by the project API key used for the public trace API.
+          validationGuidance: Each item must contain traceId and at least one patchable field.
```

## Intended Flaws

### Flaw 1: Partial-success response does not explain item failures

- Main locations:
  - `web/src/features/public-api/types/traces.ts:219-229`
  - `web/src/features/public-api/types/traces.ts:252-259`
  - `fern/apis/server/definition/traces.yml:188-206`
  - `web/src/features/public-api/server/batchTraceUpdates.ts:345-352`
- What is wrong: The PR introduces a partial-success batch API, but the response only returns `updatedTraceIds`, `failedTraceIds`, `successCount`, and `errorCount`. It never returns an item-level status, reason, code, retryability, request index, or `clientReferenceId`.
- Why it matters: A client cannot safely decide what to retry. `failedTraceIds` could mean missing trace, foreign-project trace, malformed item, duplicate input, dry-run validation failure, write failure, or a transient ClickHouse error. Retrying all failed ids can loop forever, hide data-quality problems, or accidentally convert permanent authorization mistakes into noisy retry storms.
- Better direction: Return stable per-item results that preserve request order and include `traceId`, `clientReferenceId`, `status`, `code`, `message`, and `retryable`. For example: `{ results: [{ index: 0, traceId, status: "updated" }, { index: 1, traceId, status: "not_found", code: "TRACE_NOT_FOUND", retryable: false }] }`. Keep aggregate counts as derived convenience fields, not the only contract.

Hints:

1. Look at the words "partial success" and ask what a client needs to do after receiving the response.
2. Compare `failedTraceIds` with the different failure paths inside the server helper.
3. Imagine a batch worker receiving `{ failedTraceIds: ["abc"] }`. Can it know whether to retry, fix input, stop, or escalate?

### Flaw 2: The endpoint commits earlier updates before validating authorization for the whole batch

- Main locations:
  - `web/src/features/public-api/server/batchTraceUpdates.ts:263-341`
  - `web/src/features/public-api/server/batchTraceUpdates.ts:134-188`
  - `web/src/__tests__/server/traces-batch-update-api.servertest.ts:262-321`
- What is wrong: `applyBatchTraceUpdates` processes items sequentially. It writes each authorized trace as soon as that item is reached. If a later item belongs to another project, the helper throws `ForbiddenError` after earlier changes have already been committed. The test explicitly locks in that behavior by expecting the first trace to stay updated after the request returns `403`.
- Why it matters: A request that fails authorization can still mutate production data. Clients will see a failed request and may retry it, while the server has already applied a prefix of the batch. That makes the API neither atomic nor clearly partial: authorization is treated as fatal, but writes already happened. This breaks client reasoning, audit expectations, and incident recovery.
- Better direction: Validate the entire batch before writing. Fetch all referenced traces scoped to `auth.scope.projectId`, classify every item, and either fail without writes when batch-level authorization is violated or return item-level forbidden/not-found results under an explicit partial-success contract. If atomic semantics are required, validate first and write inside a single logical commit path. If partial semantics are required, never throw a batch-level `403` after writing earlier items; represent unauthorized items in the result while ensuring no cross-project data is mutated or leaked.

Hints:

1. Follow the `for (const item of updates)` loop and mark the first line where a write can happen.
2. Follow the loop after at least one trace mutation succeeds. What happens if authorization fails on a later item?
3. Compare the HTTP status contract with the per-item mutation timeline. Can the caller know which changes are durable?

## Expert Debrief

### Product-Level Change

The product change is useful: Langfuse customers want to enrich traces after ingestion without issuing one request per trace. A good batch trace update endpoint would reduce API overhead and make enrichment jobs easier to operate.

The review question is not whether batch updates are useful. The question is whether the API makes failure understandable and whether the mutation boundary is safe.

### Changed Contracts

This PR changes several contracts:

- Public API contract: `PATCH /api/public/traces/batch` becomes a new customer-facing endpoint.
- Response contract: clients are expected to interpret partial success from id arrays and counts.
- Authorization contract: project API keys should only affect traces in their authorized project.
- Mutation contract: trace updates are represented by inserting newer ClickHouse rows.
- Retry contract: enrichment jobs will likely retry failed or ambiguous items.
- Audit contract: each accepted item is audited as a trace update.

The response contract and mutation contract are where the PR is weak. Batch endpoints need a sharper contract than single-item endpoints because clients must reconcile many independent outcomes.

### Failure Modes

Important failure modes reviewers should predict:

- Some traces are missing because ingestion is delayed.
- Some ids are from another project because a customer mixed export files or copied an environment variable.
- Some patch items are permanently invalid.
- ClickHouse accepts some writes and rejects or times out on others.
- A client receives a network failure after the server has partially written.
- A client retries a failed batch and applies the same logical update twice.
- An operator sees `403` and assumes nothing changed.
- A worker receives only `failedTraceIds` and cannot tell which failures are retryable.

These are everyday engineering failures, not edge-case trivia.

### Reviewer Thought Process

A strong reviewer should ask:

- What can the client infer from each response shape?
- Is this endpoint atomic, partial, or best-effort?
- Are authorization failures item-level results or request-level failures?
- Does any write happen before every fatal condition is known?
- Does the test suite encode a dangerous behavior as expected?
- Does the API preserve enough information to let clients reconcile results?

The key move is noticing that "partial success" is a product and protocol decision, not just an array called `failedTraceIds`.

### Better Implementation Direction

A safer design would look like this:

1. Parse and normalize every item.
2. Reject duplicate trace ids before any read or write.
3. Fetch visible traces by `(projectId, traceId[])`, never by trace id alone.
4. Classify every item into `updated`, `not_found`, `invalid`, `forbidden`, or `write_failed`.
5. Decide the contract:
   - Atomic mode: if any item is not updateable, return an error before writes.
   - Partial mode: return per-item results and write only updateable items.
6. Include request index and `clientReferenceId` in each result.
7. Include `retryable` for operational failures and `false` for permanent validation/auth failures.
8. Make tests assert that a batch-level failure leaves no committed prefix, or that partial success is returned entirely through the response body.

## Correctness Verdict Rubric

For each flaw, the verifier should mark the learner correct if their answer captures the core issue, even if they use different wording.

### Flaw 1 Rubric

Correct answers should mention:

- The response has only aggregate counts and id arrays.
- Partial success needs item-level reasons/statuses.
- Clients cannot safely retry or reconcile failures.
- A better fix is an item-level result contract with status/code/message/retryability and request correlation.

Partially correct answers may mention only "bad error handling" or "not enough error details" without tying it to retries and batch API semantics.

Incorrect answers focus only on naming, formatting, or the existence of counts.

### Flaw 2 Rubric

Correct answers should mention:

- The loop writes successful earlier items before validating all trace ids and project ownership.
- A later foreign-project item can return `403` after earlier mutations have committed.
- This makes the request semantics inconsistent and unsafe for retries/auditing.
- A better fix is prevalidation before writes, or an explicit item-level partial contract that never throws fatal auth after committing earlier items.

Partially correct answers may mention only "missing transaction" or "partial writes" without identifying the authorization/fatal-error boundary.

Incorrect answers focus only on the unscoped read as a standalone issue without explaining the committed-prefix failure.

## Golden Answer Summary

The PR adds a valuable batch trace update endpoint, but it ships two serious design flaws. First, the partial-success response is not actionable: `failedTraceIds` gives clients no item-level reason, status, request index, or retryability, so enrichment jobs cannot safely reconcile or retry failures. Second, the implementation mutates traces as it walks the batch and can later throw `403` for a foreign-project trace, leaving earlier updates committed even though the request failed. The fix is to make the batch semantics explicit: prevalidate all items and project ownership before writes for atomic behavior, or return stable item-level results for partial behavior and never mix fatal batch errors with already-committed prefix writes.
