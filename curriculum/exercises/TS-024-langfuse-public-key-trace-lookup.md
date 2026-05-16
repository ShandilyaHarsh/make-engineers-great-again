# TS-024: Langfuse Public-Key Trace Lookup

## Metadata

- `id`: TS-024
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: public API auth, project API keys, trace lookup, ClickHouse trace reads, public-key bearer access, API tests
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 1020
- `flaw_count`: 2

## PR Description Shown To Learner

This PR lets SDKs look up a trace by ID using the project public key.

Today `GET /api/public/traces/{traceId}` requires Basic auth with the project secret key. That is awkward for browser SDKs and support tools that only have the project public key available. The new flow accepts `Authorization: Bearer pk-lf-...` for single-trace lookup, reuses the existing public API response shape, and adds tests proving public-key trace lookup works.

The change is intended to help client-side SDKs show a trace preview or link validation result without exposing the secret key.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `web/src/features/public-api/server/apiAuth.ts` treats Basic auth as full project/organization API-key auth and Bearer auth as limited public-key auth.
- `web/src/features/public-api/server/createAuthedProjectAPIRoute.ts` defaults public API routes to `allowedAccessLevels: ["project"]`.
- `web/src/pages/api/public/scores/index.ts` is one of the few routes that allows `["project", "scores"]`, so public keys can create scores without the secret key.
- `web/src/pages/api/public/traces/[traceId].ts` currently gets a single trace using `auth.scope.projectId` and `getTraceById`.
- `packages/shared/src/server/repositories/traces.ts` scopes `getTraceById` by `projectId` and can include IO, observations, scores, and metrics depending on requested fields.
- `packages/shared/prisma/schema.prisma` has `Project.deletedAt`, `ApiKey.expiresAt`, and project/org relationships that matter when deciding whether a key should still authorize reads.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `web/src/features/public-api/server/apiAuth.ts`
- `web/src/features/public-api/server/public-key-trace-lookup.ts`
- `web/src/pages/api/public/traces/[traceId].ts`
- `web/src/features/public-api/types/traces.ts`
- `web/src/features/public-api/server/public-key-trace-lookup.test.ts`
- `web/src/__tests__/server/traces-public-key-api.servertest.ts`
- `web/src/__tests__/server/traces-public-key-field-matrix.servertest.ts`
- `web/public/generated/api/openapi.yml`

The line references below use synthetic PR line numbers. The represented diff is intentionally focused on backend/API behavior and is over the 500-line threshold.

## Diff

```diff
diff --git a/web/src/features/public-api/server/apiAuth.ts b/web/src/features/public-api/server/apiAuth.ts
index f4477f33e1..a1302142b8 100644
--- a/web/src/features/public-api/server/apiAuth.ts
+++ b/web/src/features/public-api/server/apiAuth.ts
@@ -188,15 +188,19 @@ export class ApiAuthService {
           // Bearer auth, limited scope, only needs public key
           if (authHeader.startsWith("Bearer ")) {
             const publicKey = authHeader.replace("Bearer ", "");
 
-            const dbKey = await this.findDbKeyOrThrow(publicKey);
+            const dbKey = await this.findDbKeyOrThrow(publicKey, {
+              requireProject: true,
+            });
 
             if (dbKey.scope === "ORGANIZATION") {
               throw new Error(
                 "Unauthorized: Cannot use organization key with bearer auth",
               );
             }
 
+            // The route decides whether this public-key bearer scope can read
+            // traces. We keep the auth scope value as "scores" for backwards
+            // compatibility with public score creation.
             const { orgId, cloudConfig, cloudFreeTierUsageThresholdState } =
               this.extractOrgIdAndCloudConfig(dbKey);
 
             addUserToSpan(
@@ -280,16 +284,27 @@ export class ApiAuthService {
     return { username, password };
   }
 
-  private async findDbKeyOrThrow(publicKey: string) {
+  private async findDbKeyOrThrow(
+    publicKey: string,
+    opts?: {
+      requireProject?: boolean;
+    },
+  ) {
     const dbKey = await this.prisma.apiKey.findUnique({
       where: { publicKey },
       include: {
-        project: { include: { organization: true } },
+        project: {
+          include: {
+            organization: true,
+          },
+        },
         organization: true,
       },
     });
     if (!dbKey) {
       logger.info("No api key found for public key:", publicKey);
       throw new Error("Invalid public key");
     }
+    if (opts?.requireProject && !dbKey.projectId) {
+      throw new Error("Project public key is required");
+    }
     return dbKey;
   }
diff --git a/web/src/features/public-api/server/public-key-trace-lookup.ts b/web/src/features/public-api/server/public-key-trace-lookup.ts
new file mode 100644
index 0000000000..40a9a26e1a
--- /dev/null
+++ b/web/src/features/public-api/server/public-key-trace-lookup.ts
@@ -0,0 +1,184 @@
+import {
+  TRACE_FIELD_GROUPS,
+  type TraceFieldGroup,
+} from "@/src/features/public-api/types/traces";
+import { env } from "@/src/env.mjs";
+import {
+  logger,
+  type AuthHeaderValidVerificationResult,
+} from "@langfuse/shared/src/server";
+import { type ApiAccessLevel } from "@langfuse/shared";
+
+type TraceLookupAuth = AuthHeaderValidVerificationResult & {
+  scope: {
+    projectId: string;
+    accessLevel: Exclude<ApiAccessLevel, "organization">;
+    apiKeyId: string;
+    publicKey: string;
+  };
+};
+
+type TraceFieldDecision = {
+  requestedFields: readonly TraceFieldGroup[];
+  includeIO: boolean;
+  includeObservations: boolean;
+  includeScores: boolean;
+  includeMetrics: boolean;
+  excludeMetadata: boolean;
+  publicKeyLookup: boolean;
+};
+
+export function resolveTraceLookupFields(params: {
+  auth: TraceLookupAuth;
+  requestedFields: TraceFieldGroup[] | null;
+}): TraceFieldDecision {
+  const publicKeyLookup = params.auth.scope.accessLevel === "scores";
+
+  let effectiveFields: readonly TraceFieldGroup[] =
+    params.requestedFields ?? TRACE_FIELD_GROUPS;
+
+  if (
+    !params.requestedFields &&
+    env.LANGFUSE_API_TRACEBYID_DEFAULT_FIELDS
+  ) {
+    const parsed = env.LANGFUSE_API_TRACEBYID_DEFAULT_FIELDS.split(",")
+      .map((f) => f.trim())
+      .filter((f): f is TraceFieldGroup =>
+        TRACE_FIELD_GROUPS.includes(f as TraceFieldGroup),
+      );
+    if (parsed.length > 0) {
+      effectiveFields = parsed;
+    }
+  }
+
+  // Keep field behavior identical for public-key trace lookup and secret-key
+  // trace lookup so SDKs can reuse the existing response parser.
+  if (publicKeyLookup && params.requestedFields?.length) {
+    effectiveFields = params.requestedFields;
+  }
+
+  logger.debug("Resolved trace lookup fields", {
+    apiKeyId: params.auth.scope.apiKeyId,
+    publicKeyLookup,
+    fields: effectiveFields,
+  });
+
+  return {
+    requestedFields: effectiveFields,
+    includeIO: effectiveFields.includes("io"),
+    includeObservations: effectiveFields.includes("observations"),
+    includeScores: effectiveFields.includes("scores"),
+    includeMetrics: effectiveFields.includes("metrics"),
+    excludeMetadata: !effectiveFields.includes("io"),
+    publicKeyLookup,
+  };
+}
+
+export function getTraceLookupAuditMetadata(params: {
+  auth: TraceLookupAuth;
+  traceId: string;
+  fields: readonly TraceFieldGroup[];
+}) {
+  return {
+    projectId: params.auth.scope.projectId,
+    traceId: params.traceId,
+    apiKeyId: params.auth.scope.apiKeyId,
+    publicKey: params.auth.scope.publicKey,
+    accessLevel: params.auth.scope.accessLevel,
+    requestedFields: params.fields.join(","),
+  };
+}
+
+export function shouldRedactTraceLookupError(params: {
+  auth: TraceLookupAuth;
+  error: unknown;
+}) {
+  if (params.auth.scope.accessLevel !== "scores") {
+    return false;
+  }
+
+  const message = params.error instanceof Error ? params.error.message : "";
+  return message.includes("not found") || message.includes("authorized");
+}
+
+export function getTraceLookupNotFoundMessage(params: {
+  traceId: string;
+  publicKeyLookup: boolean;
+}) {
+  if (params.publicKeyLookup) {
+    return `Trace ${params.traceId} not found`;
+  }
+  return `Trace ${params.traceId} not found within authorized project`;
+}
diff --git a/web/src/pages/api/public/traces/[traceId].ts b/web/src/pages/api/public/traces/[traceId].ts
index 61482c2216..62f5f201eb 100644
--- a/web/src/pages/api/public/traces/[traceId].ts
+++ b/web/src/pages/api/public/traces/[traceId].ts
@@ -11,10 +11,13 @@ import {
   TRACE_FIELD_GROUPS,
   type TraceFieldGroup,
 } from "@/src/features/public-api/types/traces";
-import { env } from "@/src/env.mjs";
 import {
   filterAndValidateDbLegacyTraceScoreList,
   LangfuseNotFoundError,
 } from "@langfuse/shared";
+import {
+  getTraceLookupAuditMetadata,
+  getTraceLookupNotFoundMessage,
+  resolveTraceLookupFields,
+} from "@/src/features/public-api/server/public-key-trace-lookup";
 import { prisma } from "@langfuse/shared/src/db";
 import {
   getObservationsForTrace,
@@ -34,38 +37,26 @@ export default withMiddlewares(
       name: "Get Single Trace",
       querySchema: GetTraceV1Query,
       responseSchema: GetTraceV1Response,
+      allowedAccessLevels: ["project", "scores"],
       fn: async ({ query, auth }) => {
         const { traceId } = query;
 
-        let effectiveFields: readonly TraceFieldGroup[] =
-          query.fields ?? TRACE_FIELD_GROUPS;
-        if (!query.fields && env.LANGFUSE_API_TRACEBYID_DEFAULT_FIELDS) {
-          const parsed = env.LANGFUSE_API_TRACEBYID_DEFAULT_FIELDS.split(",")
-            .map((f) => f.trim())
-            .filter((f): f is TraceFieldGroup =>
-              TRACE_FIELD_GROUPS.includes(f as TraceFieldGroup),
-            );
-          if (parsed.length > 0) {
-            effectiveFields = parsed;
-          }
-        }
-        const requestedFields = effectiveFields;
-        const includeIO = requestedFields.includes("io");
-        const includeObservations = requestedFields.includes("observations");
-        const includeScores = requestedFields.includes("scores");
-        const includeMetrics = requestedFields.includes("metrics");
+        const fieldDecision = resolveTraceLookupFields({
+          auth,
+          requestedFields: query.fields,
+        });
 
         const trace = await getTraceById({
           traceId,
           projectId: auth.scope.projectId,
           clickhouseFeatureTag: "tracing-public-api",
           preferredClickhouseService: "ReadOnly",
-          excludeInputOutput: !includeIO,
-          excludeMetadata: !includeIO,
+          excludeInputOutput: !fieldDecision.includeIO,
+          excludeMetadata: fieldDecision.excludeMetadata,
         });
 
         if (!trace) {
           throw new LangfuseNotFoundError(
-            `Trace ${traceId} not found within authorized project`,
+            getTraceLookupNotFoundMessage({
+              traceId,
+              publicKeyLookup: fieldDecision.publicKeyLookup,
+            }),
           );
         }
 
@@ -73,14 +64,14 @@ export default withMiddlewares(
           includeObservations || includeMetrics
             ? getObservationsForTrace({
                 traceId,
                 projectId: auth.scope.projectId,
                 timestamp: trace?.timestamp,
-                includeIO: includeObservations,
+                includeIO: fieldDecision.includeObservations,
                 preferredClickhouseService: "ReadOnly",
               })
             : Promise.resolve([]),
-          includeScores
+          fieldDecision.includeScores
             ? getScoresForTraces({
                 projectId: auth.scope.projectId,
                 traceIds: [traceId],
                 timestamp: trace?.timestamp,
                 preferredClickhouseService: "ReadOnly",
@@ -89,6 +80,15 @@ export default withMiddlewares(
             : Promise.resolve([]),
         ]);
 
+        await auditLog({
+          resourceType: "trace",
+          resourceId: traceId,
+          action: "read",
+          projectId: auth.scope.projectId,
+          apiKeyId: auth.scope.apiKeyId,
+          orgId: auth.scope.orgId,
+          metadata: getTraceLookupAuditMetadata({
+            auth,
+            traceId,
+            fields: fieldDecision.requestedFields,
+          }),
+        });
+
         const uniqueModels: string[] = Array.from(
           new Set(
             observations
@@ -142,19 +142,21 @@ export default withMiddlewares(
           return {
             ...o,
             inputPrice,
             outputPrice,
             totalPrice,
           };
         });
 
         const outObservations = observationsView.map(
           transformDbToApiObservation,
         );
@@ -166,23 +168,23 @@ export default withMiddlewares(
           ...trace,
           externalId: null,
-          metadata: includeIO ? trace.metadata : {},
-          scores: includeScores ? validatedScores : [],
-          latency: includeMetrics
+          metadata: fieldDecision.includeIO ? trace.metadata : {},
+          scores: fieldDecision.includeScores ? validatedScores : [],
+          latency: fieldDecision.includeMetrics
             ? latencyMs !== undefined
               ? latencyMs / 1000
               : 0
             : -1,
-          observations: includeObservations ? outObservations : [],
+          observations: fieldDecision.includeObservations ? outObservations : [],
           htmlPath: `/project/${auth.scope.projectId}/traces/${traceId}`,
-          totalCost: includeMetrics
+          totalCost: fieldDecision.includeMetrics
             ? outObservations
                 .reduce(
                   (acc, obs) =>
                     acc.add(obs.calculatedTotalCost ?? new Decimal(0)),
                   new Decimal(0),
                 )
diff --git a/web/src/features/public-api/types/traces.ts b/web/src/features/public-api/types/traces.ts
index b0164c77f8..0537d1df7a 100644
--- a/web/src/features/public-api/types/traces.ts
+++ b/web/src/features/public-api/types/traces.ts
@@ -109,7 +109,11 @@ export const GetTracesV1Response = z
 
 // GET /api/public/traces/{traceId}
 export const GetTraceV1Query = z.object({
   traceId: z.string(),
+  publicKey: z
+    .string()
+    .startsWith("pk-lf-")
+    .optional()
+    .describe("Deprecated. Prefer Authorization: Bearer <public key>."),
   fields: z
     .string()
     .nullish()
diff --git a/web/public/generated/api/openapi.yml b/web/public/generated/api/openapi.yml
index 90ccb72cb1..62d55f322f 100644
--- a/web/public/generated/api/openapi.yml
+++ b/web/public/generated/api/openapi.yml
@@ -5708,12 +5708,34 @@ paths:
       description: Get a trace by ID.
       operationId: trace_get
       parameters:
         - name: traceId
           in: path
           required: true
           schema:
             type: string
+        - name: fields
+          in: query
+          required: false
+          schema:
+            type: string
+          description: Comma-separated field groups to return. Supported values are core, io, scores, observations, and metrics.
+        - name: publicKey
+          in: query
+          required: false
+          deprecated: true
+          schema:
+            type: string
+          description: Deprecated public-key lookup parameter. Prefer Authorization Bearer with the project public key.
       security:
-        - BasicAuth: []
+        - BasicAuth: []
+        - PublicKeyBearerAuth: []
+      x-langfuse-auth:
+        basicAuth:
+          description: Project secret key auth. Full trace response is available.
+        publicKeyBearerAuth:
+          description: Project public key auth. Intended for SDK trace previews.
+          example: Authorization: Bearer pk-lf-...
       responses:
         "200":
           description: Trace response.
           content:
             application/json:
diff --git a/web/src/features/public-api/server/public-key-trace-lookup.test.ts b/web/src/features/public-api/server/public-key-trace-lookup.test.ts
new file mode 100644
index 0000000000..7e4fdc9d0e
--- /dev/null
+++ b/web/src/features/public-api/server/public-key-trace-lookup.test.ts
@@ -0,0 +1,286 @@
+import {
+  getTraceLookupAuditMetadata,
+  getTraceLookupNotFoundMessage,
+  resolveTraceLookupFields,
+  shouldRedactTraceLookupError,
+} from "./public-key-trace-lookup";
+
+const baseAuth = {
+  validKey: true as const,
+  scope: {
+    projectId: "project-1",
+    orgId: "org-1",
+    plan: "cloud:hobby" as const,
+    rateLimitOverrides: [],
+    apiKeyId: "key-1",
+    publicKey: "pk-lf-public",
+    isIngestionSuspended: false,
+  },
+};
+
+describe("public key trace lookup field resolver", () => {
+  it("uses all field groups for secret-key trace lookup when no fields are requested", () => {
+    const result = resolveTraceLookupFields({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "project",
+        },
+      },
+      requestedFields: null,
+    });
+
+    expect(result.publicKeyLookup).toBe(false);
+    expect(result.requestedFields).toEqual([
+      "core",
+      "io",
+      "scores",
+      "observations",
+      "metrics",
+    ]);
+    expect(result.includeIO).toBe(true);
+    expect(result.includeObservations).toBe(true);
+    expect(result.includeScores).toBe(true);
+    expect(result.includeMetrics).toBe(true);
+    expect(result.excludeMetadata).toBe(false);
+  });
+
+  it("uses all field groups for public-key trace lookup when no fields are requested", () => {
+    const result = resolveTraceLookupFields({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      requestedFields: null,
+    });
+
+    expect(result.publicKeyLookup).toBe(true);
+    expect(result.requestedFields).toEqual([
+      "core",
+      "io",
+      "scores",
+      "observations",
+      "metrics",
+    ]);
+    expect(result.includeIO).toBe(true);
+    expect(result.includeObservations).toBe(true);
+    expect(result.includeScores).toBe(true);
+    expect(result.includeMetrics).toBe(true);
+    expect(result.excludeMetadata).toBe(false);
+  });
+
+  it("allows public-key trace lookup to request core only", () => {
+    const result = resolveTraceLookupFields({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      requestedFields: ["core"],
+    });
+
+    expect(result.publicKeyLookup).toBe(true);
+    expect(result.requestedFields).toEqual(["core"]);
+    expect(result.includeIO).toBe(false);
+    expect(result.includeObservations).toBe(false);
+    expect(result.includeScores).toBe(false);
+    expect(result.includeMetrics).toBe(false);
+    expect(result.excludeMetadata).toBe(true);
+  });
+
+  it("allows public-key trace lookup to request IO", () => {
+    const result = resolveTraceLookupFields({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      requestedFields: ["core", "io"],
+    });
+
+    expect(result.publicKeyLookup).toBe(true);
+    expect(result.requestedFields).toEqual(["core", "io"]);
+    expect(result.includeIO).toBe(true);
+    expect(result.includeObservations).toBe(false);
+    expect(result.includeScores).toBe(false);
+    expect(result.includeMetrics).toBe(false);
+    expect(result.excludeMetadata).toBe(false);
+  });
+
+  it("allows public-key trace lookup to request observations", () => {
+    const result = resolveTraceLookupFields({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      requestedFields: ["core", "observations"],
+    });
+
+    expect(result.publicKeyLookup).toBe(true);
+    expect(result.requestedFields).toEqual(["core", "observations"]);
+    expect(result.includeIO).toBe(false);
+    expect(result.includeObservations).toBe(true);
+    expect(result.includeScores).toBe(false);
+    expect(result.includeMetrics).toBe(false);
+    expect(result.excludeMetadata).toBe(true);
+  });
+
+  it("allows public-key trace lookup to request scores", () => {
+    const result = resolveTraceLookupFields({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      requestedFields: ["core", "scores"],
+    });
+
+    expect(result.publicKeyLookup).toBe(true);
+    expect(result.requestedFields).toEqual(["core", "scores"]);
+    expect(result.includeIO).toBe(false);
+    expect(result.includeObservations).toBe(false);
+    expect(result.includeScores).toBe(true);
+    expect(result.includeMetrics).toBe(false);
+    expect(result.excludeMetadata).toBe(true);
+  });
+
+  it("allows public-key trace lookup to request metrics", () => {
+    const result = resolveTraceLookupFields({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      requestedFields: ["core", "metrics"],
+    });
+
+    expect(result.publicKeyLookup).toBe(true);
+    expect(result.requestedFields).toEqual(["core", "metrics"]);
+    expect(result.includeIO).toBe(false);
+    expect(result.includeObservations).toBe(false);
+    expect(result.includeScores).toBe(false);
+    expect(result.includeMetrics).toBe(true);
+    expect(result.excludeMetadata).toBe(true);
+  });
+
+  it("allows public-key trace lookup to request every field group", () => {
+    const result = resolveTraceLookupFields({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      requestedFields: ["core", "io", "observations", "scores", "metrics"],
+    });
+
+    expect(result.publicKeyLookup).toBe(true);
+    expect(result.requestedFields).toEqual([
+      "core",
+      "io",
+      "observations",
+      "scores",
+      "metrics",
+    ]);
+    expect(result.includeIO).toBe(true);
+    expect(result.includeObservations).toBe(true);
+    expect(result.includeScores).toBe(true);
+    expect(result.includeMetrics).toBe(true);
+    expect(result.excludeMetadata).toBe(false);
+  });
+});
+
+describe("public key trace lookup audit helpers", () => {
+  it("records public-key trace lookup metadata", () => {
+    const metadata = getTraceLookupAuditMetadata({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      traceId: "trace-1",
+      fields: ["core", "io"],
+    });
+
+    expect(metadata).toEqual({
+      projectId: "project-1",
+      traceId: "trace-1",
+      apiKeyId: "key-1",
+      publicKey: "pk-lf-public",
+      accessLevel: "scores",
+      requestedFields: "core,io",
+    });
+  });
+
+  it("records secret-key trace lookup metadata", () => {
+    const metadata = getTraceLookupAuditMetadata({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "project",
+          publicKey: "pk-lf-secret-pair",
+        },
+      },
+      traceId: "trace-2",
+      fields: ["core", "scores"],
+    });
+
+    expect(metadata).toEqual({
+      projectId: "project-1",
+      traceId: "trace-2",
+      apiKeyId: "key-1",
+      publicKey: "pk-lf-secret-pair",
+      accessLevel: "project",
+      requestedFields: "core,scores",
+    });
+  });
+});
+
+describe("public key trace lookup error helpers", () => {
+  it("redacts not-found errors for public-key lookups", () => {
+    const shouldRedact = shouldRedactTraceLookupError({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "scores",
+        },
+      },
+      error: new Error("Trace trace-1 not found within authorized project"),
+    });
+
+    expect(shouldRedact).toBe(true);
+  });
+
+  it("does not redact not-found errors for secret-key lookups", () => {
+    const shouldRedact = shouldRedactTraceLookupError({
+      auth: {
+        ...baseAuth,
+        scope: {
+          ...baseAuth.scope,
+          accessLevel: "project",
+        },
+      },
+      error: new Error("Trace trace-1 not found within authorized project"),
+    });
+
+    expect(shouldRedact).toBe(false);
+  });
+
+  it("uses a generic not-found message for public-key lookup", () => {
+    expect(
+      getTraceLookupNotFoundMessage({
+        traceId: "trace-1",
+        publicKeyLookup: true,
+      }),
+    ).toBe("Trace trace-1 not found");
+  });
+
+  it("uses the scoped not-found message for secret-key lookup", () => {
+    expect(
+      getTraceLookupNotFoundMessage({
+        traceId: "trace-1",
+        publicKeyLookup: false,
+      }),
+    ).toBe("Trace trace-1 not found within authorized project");
+  });
+});
diff --git a/web/src/__tests__/server/traces-public-key-field-matrix.servertest.ts b/web/src/__tests__/server/traces-public-key-field-matrix.servertest.ts
new file mode 100644
index 0000000000..9b63f74a1b
--- /dev/null
+++ b/web/src/__tests__/server/traces-public-key-field-matrix.servertest.ts
@@ -0,0 +1,178 @@
+import { randomUUID } from "crypto";
+import { prisma } from "@langfuse/shared/src/db";
+import { createAndAddApiKeysToDb } from "@langfuse/shared/src/server/auth/apiKeys";
+import { makeAPICall } from "@/src/__tests__/test-utils";
+import {
+  createScore,
+  createTrace,
+  flushClickhouse,
+} from "@/src/__tests__/server/test-utils";
+
+describe("public key trace lookup field matrix", () => {
+  const orgId = randomUUID();
+  const projectId = randomUUID();
+  const traceId = `trace-${randomUUID()}`;
+  let publicKey: string;
+
+  beforeAll(async () => {
+    await prisma.organization.create({
+      data: {
+        id: orgId,
+        name: "trace field matrix org",
+      },
+    });
+
+    await prisma.project.create({
+      data: {
+        id: projectId,
+        orgId,
+        name: "trace field matrix project",
+      },
+    });
+
+    const key = await createAndAddApiKeysToDb({
+      prisma,
+      entityId: projectId,
+      scope: "PROJECT",
+      note: "field matrix key",
+    });
+
+    publicKey = key.publicKey;
+
+    await createTrace({
+      id: traceId,
+      project_id: projectId,
+      name: "agent run",
+      user_id: "user-field-matrix",
+      input: JSON.stringify({
+        question: "What is the customer's refund status?",
+      }),
+      output: JSON.stringify({
+        answer: "Refund still pending review",
+      }),
+      metadata: JSON.stringify({
+        supportQueue: "vip",
+      }),
+      timestamp: new Date().toISOString(),
+    });
+
+    await createScore({
+      id: `score-${randomUUID()}`,
+      trace_id: traceId,
+      project_id: projectId,
+      name: "quality",
+      value: 0.8,
+      timestamp: new Date().toISOString(),
+    });
+
+    await flushClickhouse();
+  });
+
+  afterAll(async () => {
+    await prisma.apiKey.deleteMany({ where: { projectId } });
+    await prisma.project.deleteMany({ where: { id: projectId } });
+    await prisma.organization.deleteMany({ where: { id: orgId } });
+  });
+
+  async function callTrace(fields?: string) {
+    const suffix = fields ? `?fields=${fields}` : "";
+    return await makeAPICall(
+      "GET",
+      `/api/public/traces/${traceId}${suffix}`,
+      undefined,
+      {
+        Authorization: `Bearer ${publicKey}`,
+      },
+    );
+  }
+
+  it("returns default field groups with public key auth", async () => {
+    const response = await callTrace();
+
+    expect(response.status).toBe(200);
+    expect(response.body.id).toBe(traceId);
+    expect(response.body.input).toEqual({
+      question: "What is the customer's refund status?",
+    });
+    expect(response.body.output).toEqual({
+      answer: "Refund still pending review",
+    });
+    expect(response.body.metadata).toEqual({
+      supportQueue: "vip",
+    });
+    expect(response.body.scores).toHaveLength(1);
+  });
+
+  it("returns core-only fields with public key auth", async () => {
+    const response = await callTrace("core");
+
+    expect(response.status).toBe(200);
+    expect(response.body.id).toBe(traceId);
+    expect(response.body.input).toEqual("");
+    expect(response.body.output).toEqual("");
+    expect(response.body.metadata).toEqual({});
+    expect(response.body.scores).toEqual([]);
+    expect(response.body.observations).toEqual([]);
+  });
+
+  it("returns io fields with public key auth", async () => {
+    const response = await callTrace("core,io");
+
+    expect(response.status).toBe(200);
+    expect(response.body.input).toEqual({
+      question: "What is the customer's refund status?",
+    });
+    expect(response.body.output).toEqual({
+      answer: "Refund still pending review",
+    });
+  });
+
+  it("returns score fields with public key auth", async () => {
+    const response = await callTrace("core,scores");
+
+    expect(response.status).toBe(200);
+    expect(response.body.id).toBe(traceId);
+    expect(response.body.scores).toHaveLength(1);
+    expect(response.body.scores[0].name).toBe("quality");
+  });
+
+  it("returns metric fields with public key auth", async () => {
+    const response = await callTrace("core,metrics");
+
+    expect(response.status).toBe(200);
+    expect(response.body.id).toBe(traceId);
+    expect(response.body.latency).toBeGreaterThanOrEqual(0);
+    expect(response.body.totalCost).toBeGreaterThanOrEqual(0);
+  });
+});
diff --git a/web/src/__tests__/server/traces-public-key-api.servertest.ts b/web/src/__tests__/server/traces-public-key-api.servertest.ts
new file mode 100644
index 0000000000..8c27fd76ac
--- /dev/null
+++ b/web/src/__tests__/server/traces-public-key-api.servertest.ts
@@ -0,0 +1,372 @@
+import { randomUUID } from "crypto";
+import { prisma } from "@langfuse/shared/src/db";
+import { createAndAddApiKeysToDb } from "@langfuse/shared/src/server/auth/apiKeys";
+import { makeAPICall } from "@/src/__tests__/test-utils";
+import {
+  createTrace,
+  createObservation,
+  flushClickhouse,
+} from "@/src/__tests__/server/test-utils";
+
+describe("public key trace lookup", () => {
+  const orgId = randomUUID();
+  const projectId = randomUUID();
+  let publicKey: string;
+  let secretKey: string;
+  let traceId: string;
+
+  beforeEach(async () => {
+    await prisma.organization.create({
+      data: {
+        id: orgId,
+        name: "trace lookup org",
+      },
+    });
+
+    await prisma.project.create({
+      data: {
+        id: projectId,
+        orgId,
+        name: "trace lookup project",
+      },
+    });
+
+    const key = await createAndAddApiKeysToDb({
+      prisma,
+      entityId: projectId,
+      scope: "PROJECT",
+      note: "browser sdk key",
+    });
+
+    publicKey = key.publicKey;
+    secretKey = key.secretKey;
+    traceId = `trace-${randomUUID()}`;
+
+    await createTrace({
+      id: traceId,
+      project_id: projectId,
+      name: "checkout started",
+      user_id: "user-123",
+      input: JSON.stringify({
+        email: "customer@example.com",
+        cartId: "cart_123",
+      }),
+      output: JSON.stringify({
+        status: "requires_payment_method",
+      }),
+      metadata: JSON.stringify({
+        plan: "enterprise",
+        supportTicketId: "SUP-123",
+      }),
+      timestamp: new Date().toISOString(),
+    });
+
+    await createObservation({
+      id: `obs-${randomUUID()}`,
+      trace_id: traceId,
+      project_id: projectId,
+      type: "SPAN",
+      name: "payment provider call",
+      input: JSON.stringify({ provider: "stripe" }),
+      output: JSON.stringify({ status: "requires_action" }),
+      start_time: new Date().toISOString(),
+      end_time: new Date().toISOString(),
+    });
+
+    await flushClickhouse();
+  });
+
+  afterEach(async () => {
+    await prisma.apiKey.deleteMany({ where: { projectId } });
+    await prisma.project.deleteMany({ where: { id: projectId } });
+    await prisma.organization.deleteMany({ where: { id: orgId } });
+  });
+
+  it("returns a trace with a project public key bearer token", async () => {
+    const response = await makeAPICall(
+      "GET",
+      `/api/public/traces/${traceId}?fields=core`,
+      undefined,
+      {
+        Authorization: `Bearer ${publicKey}`,
+      },
+    );
+
+    expect(response.status).toBe(200);
+    expect(response.body.id).toBe(traceId);
+    expect(response.body.projectId).toBe(projectId);
+    expect(response.body.name).toBe("checkout started");
+    expect(response.body.htmlPath).toBe(
+      `/project/${projectId}/traces/${traceId}`,
+    );
+  });
+
+  it("returns selected trace field groups with a project public key", async () => {
+    const response = await makeAPICall(
+      "GET",
+      `/api/public/traces/${traceId}?fields=core,io,observations,metrics`,
+      undefined,
+      {
+        Authorization: `Bearer ${publicKey}`,
+      },
+    );
+
+    expect(response.status).toBe(200);
+    expect(response.body.input).toEqual({
+      email: "customer@example.com",
+      cartId: "cart_123",
+    });
+    expect(response.body.output).toEqual({
+      status: "requires_payment_method",
+    });
+    expect(response.body.metadata).toEqual({
+      plan: "enterprise",
+      supportTicketId: "SUP-123",
+    });
+    expect(response.body.observations).toHaveLength(1);
+    expect(response.body.latency).toBeGreaterThanOrEqual(0);
+  });
+
+  it("keeps secret-key lookup compatible", async () => {
+    const basic = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
+    const response = await makeAPICall(
+      "GET",
+      `/api/public/traces/${traceId}?fields=core,io,scores,observations,metrics`,
+      undefined,
+      {
+        Authorization: `Basic ${basic}`,
+      },
+    );
+
+    expect(response.status).toBe(200);
+    expect(response.body.id).toBe(traceId);
+    expect(response.body.input).toEqual({
+      email: "customer@example.com",
+      cartId: "cart_123",
+    });
+  });
+
+  it("does not allow organization public keys with bearer auth", async () => {
+    const orgKey = await createAndAddApiKeysToDb({
+      prisma,
+      entityId: orgId,
+      scope: "ORGANIZATION",
+      note: "org key",
+    });
+
+    const response = await makeAPICall(
+      "GET",
+      `/api/public/traces/${traceId}?fields=core`,
+      undefined,
+      {
+        Authorization: `Bearer ${orgKey.publicKey}`,
+      },
+    );
+
+    expect(response.status).toBe(401);
+  });
+});
```

## Intended Flaws

### Flaw 1: Public ingestion key is promoted into a trace-read credential

- `type`: `permission_bypass`
- `location`: `web/src/pages/api/public/traces/[traceId].ts:37-50`, `web/src/features/public-api/server/public-key-trace-lookup.ts:24-64`, `web/src/__tests__/server/traces-public-key-api.servertest.ts:86-138`
- `learner_prompt`: Is Bearer public-key auth an appropriate credential for reading trace data, especially IO and observations?

Expected answer:

- Identify: The route now sets `allowedAccessLevels: ["project", "scores"]`, which means Bearer public-key auth can call `GET /api/public/traces/{traceId}`. In Langfuse, the Bearer public-key path is the narrow public-key path used for limited operations like score creation; it is not a proof that the caller may read trace contents. The helper then keeps the same field behavior for public-key lookup, including `io`, `observations`, `scores`, and `metrics`.
- Impact: Any browser-exposed project public key can retrieve trace data by ID. Trace IDs are often copied into URLs, logs, support tickets, browser telemetry, or customer bug reports. With `fields=io,observations`, this can expose prompts, user inputs, model outputs, metadata, costs, and internal observation details to anyone who has the public key and a trace ID. A write/ingestion credential has become a read credential.
- Fix direction: Do not reuse the public ingestion/scoring key for trace reads. Require Basic auth with the secret key, or introduce a dedicated read-scoped token/capability with explicit customer opt-in and server-side policy. If a browser preview is needed, return a minimal signed preview token from the backend, not a permanent project public key capability. Public-key reads should never include IO or observations by default.

Hints:

1. Ask what a public key is allowed to do before this PR, not only whether it is scoped to a project.
2. Search for the route configuration that decides which access levels can call the trace endpoint.
3. The dangerous combination is `allowedAccessLevels: ["project", "scores"]` plus field handling that still permits `io` and `observations`.

### Flaw 2: Public-key lookup does not validate key, project, and org active state before read access

- `type`: `rollout_risk`
- `location`: `web/src/features/public-api/server/apiAuth.ts:188-239`, `web/src/features/public-api/server/apiAuth.ts:284-313`
- `learner_prompt`: If public-key auth is now allowed to read traces, does the key lookup prove the key and its project are still valid for a high-sensitivity read?

Expected answer:

- Identify: The modified Bearer path only requires that a project-scoped key exists. `findDbKeyOrThrow` fetches by `publicKey` and checks `projectId`, but it does not reject expired API keys, soft-deleted projects, suspended/blocked organizations, or missing active project relations before returning a read-capable scope. This was less dangerous when Bearer public keys only supported narrow write-like operations; it becomes high-impact when the same lookup authorizes trace reads.
- Impact: A deleted project, stale cached key, expired key, or blocked organization can continue reading trace data if the public key is still present or cached. That breaks customer expectations around deletion, suspension, retention, and incident response. It also makes rollback harder because public keys are embedded in clients and can be copied widely.
- Fix direction: Treat any trace-read credential as high sensitivity. The auth lookup should check key expiry, project `deletedAt`, organization existence/status, and any product suspension state before returning a read scope. Cache entries must include active-state versioning or be invalidated on project deletion, org blocking, and key expiry. Better yet, avoid public-key trace reads and issue short-lived server-generated preview tokens.

Hints:

1. The route change changes the risk level of the Bearer key lookup.
2. Look at what `findDbKeyOrThrow` checks after fetching `project` and `organization`.
3. It checks that `projectId` exists, but not that the project/key/org is still active for a read.

## Final Expert Debrief

### Product-level change

The PR is trying to make browser SDKs and support flows more convenient by allowing trace lookup with only the project public key. The user value is understandable: browser code should not carry a secret key.

### Changed contracts

- Auth contract: Bearer public-key auth changes from limited public operations to trace-read access.
- Data confidentiality contract: trace IO, observations, scores, metrics, metadata, and costs become reachable through a browser-distributed credential.
- API contract: `GET /api/public/traces/{traceId}` now has two credential classes with the same response shape.
- Lifecycle contract: key/project/org active-state checks now protect read access, not only narrow write paths.

### Failure modes

- A public key embedded in a frontend bundle can read trace IO if the trace ID leaks.
- Support tooling or browser logs containing trace IDs become enough to fetch sensitive traces.
- A soft-deleted project can still return traces because the public-key lookup only checks `projectId`.
- A blocked org or expired key may still read if the key exists or is cached.
- Tests pass because they assert the new happy path and organization-key rejection, but not sensitivity boundaries, deleted projects, expired keys, or field restrictions.

### Reviewer thought process

A strong reviewer starts by classifying the credential, not by reading the handler body. A `pk-lf-...` key is public by design. Once a public credential can read private trace data, project scoping is not enough. The right question is: "Who can realistically possess this credential, and what can they combine it with?"

Then the reviewer follows the route config. The entire capability expansion is one line: `allowedAccessLevels: ["project", "scores"]`. That line must be reviewed like an authorization change, not like a harmless SDK convenience.

Finally, the reviewer inspects lifecycle checks. Read access should honor deletion, key expiry, org blocking, and cache invalidation. The helper fetches project/org data but only checks that a project id exists. That is a classic sign that the code has data available but has not turned it into a policy.

### Better implementation direction

- Keep `GET /api/public/traces/{traceId}` secret-key only by default.
- Add a dedicated trace-read API key capability if the product truly needs this.
- Make trace-read keys explicit, revocable, and auditable, with field restrictions.
- For browser previews, use short-lived signed tokens generated by a trusted backend.
- Restrict browser-readable preview data to minimal core fields.
- Validate key expiry, project deletion, org status, and suspension before any read.
- Invalidate cached auth scopes on key deletion, project deletion, org blocking, and capability changes.
- Add negative tests for public key plus `fields=io`, deleted project, expired key, blocked org, and leaked trace ID.

## Correctness Verdict Rubric

The learner is correct on flaw 1 if they mention all three:

- the trace route now accepts Bearer public-key/scores access,
- a public or ingestion-style key should not be able to read trace data,
- the fix is secret-key auth, a dedicated read capability, or a short-lived scoped preview token with field restrictions.

The learner is correct on flaw 2 if they mention all three:

- the public-key lookup checks existence/projectId but not active key/project/org state,
- this becomes dangerous because the lookup now authorizes trace reads,
- the fix is explicit active-state validation and cache invalidation, or avoiding public-key reads entirely.

## Why This Case Exists

This case trains a core review instinct: authorization bugs often hide in one-line "allow this access level too" changes. The code still has project scoping, tests still pass, and the feature sounds useful. The deeper question is whether the credential class is appropriate for the data being returned.
