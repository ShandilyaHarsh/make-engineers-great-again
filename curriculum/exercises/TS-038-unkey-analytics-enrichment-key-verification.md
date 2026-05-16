# TS-038: Unkey Analytics Enrichment Key Verification

## Metadata

- `id`: TS-038
- `source_repo`: [unkeyed/unkey](https://github.com/unkeyed/unkey)
- `repo_area`: key verification, data-plane purity, ClickHouse analytics, control-plane writes, auth decision contracts, request latency, dashboard enrichment, verification tests
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,350-1,700
- `represented_diff_lines`: 1652
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Unkey verification semantics, data-plane versus control-plane boundaries, analytics durability, fail-open and fail-closed policy, ClickHouse telemetry, and API response contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds analytics enrichment to key verification responses.

Customers often use the verification endpoint in debugging tools and internal gateways, and they want more context than just valid or invalid. This change adds a TypeScript verification proxy that calls the existing `/v2/keys.verifyKey` backend, enriches successful responses with recent analytics, records a richer verification event, updates `lastUsedAt`, and returns an optional `analytics` object with risk score, recent request counts, and tags used by the dashboard.

The PR adds:

- `POST /api/v2/keys/verify` in the web app,
- shared TypeScript schemas for verification input and enriched output,
- an analytics enrichment service that reads ClickHouse and writes summary rows,
- database schema for enrichment summaries,
- request tests for valid keys, invalid keys, slow analytics, and analytics outages,
- documentation for the enriched verification response.

The intended product behavior is: callers get richer diagnostics while the core key verification decision remains fast, available, and faithful to the backend verifier.

## Existing Code Context

The real Unkey codebase already has these relevant contracts:

- `svc/api/routes/v2_keys_verify_key/handler.go` implements `POST /v2/keys.verifyKey`. It authenticates the root key, loads the target key, validates workspace ownership, deleted API state, root permissions, optional credits, rate limits, IP whitelist, and requested permissions before building the response.
- The real handler builds `keyData` from `key.ToOpenAPIStatus()` and `key.Status == keys.StatusValid`, then calls `emit()` after response data has been derived.
- `internal/services/keys/verifier.go` keeps verification telemetry as a `batch.BatchProcessor[schema.KeyVerification]`. `KeyVerifier.log()` buffers a ClickHouse verification row with request id, workspace id, outcome, key id, identity id, tags, region, credits, and latency.
- `internal/services/keys/service.go` defaults verification telemetry to a noop batch processor when none is configured, which keeps verification independent from analytics availability.
- `web/internal/clickhouse/src/verifications.ts` is a read/query layer for verification logs and timeseries. Dashboard analytics are derived from ClickHouse tables such as `default.key_verifications_raw_v2`.
- `web/internal/db/src/schema/audit_logs.ts` has a generic `clickhouse_outbox` table for durable asynchronous export. Its comments describe a worker-drained outbox rather than synchronous ClickHouse writes inside request handlers.
- `web/internal/db/src/schema/keys.ts` has `lastUsedAt`, but the hot data-plane path should avoid coupling every verification to dashboard/control-plane writes unless that write is part of the actual security decision.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether analytics enrichment preserves the data-plane contract of key verification.

## Review Surface

Changed files in the synthetic PR:

- `web/internal/key-verification/types.ts`
- `web/internal/key-verification/backend.ts`
- `web/internal/key-verification/analytics-enrichment.ts`
- `web/internal/key-verification/verify-with-analytics.ts`
- `web/apps/dashboard/app/api/v2/keys/verify/route.ts`
- `web/internal/db/src/schema/verification_analytics.ts`
- `web/internal/key-verification/analytics-enrichment.test.ts`
- `web/internal/key-verification/index.ts`
- `docs/api/key-verification-analytics.md`

The line references below use synthetic PR line numbers. The represented diff is focused on data-plane purity, analytics side effects, latency coupling, explicit security policy, and tests that encode the wrong availability contract.

## Diff

```diff
diff --git a/web/internal/key-verification/types.ts b/web/internal/key-verification/types.ts
new file mode 100644
index 000000000..9ef028a16
--- /dev/null
+++ b/web/internal/key-verification/types.ts
@@ -0,0 +1,122 @@
+import { z } from "zod";
+
+export const verificationRatelimitSchema = z.object({
+  name: z.string().min(1),
+  limit: z.number().int().positive().optional(),
+  duration: z.number().int().positive().optional(),
+  cost: z.number().int().positive().optional(),
+});
+
+export const verifyKeyRequestSchema = z.object({
+  key: z.string().min(1),
+  apiId: z.string().optional(),
+  migrationId: z.string().optional(),
+  permissions: z.string().optional(),
+  tags: z.array(z.string()).optional(),
+  credits: z
+    .object({
+      cost: z.number().int().nonnegative(),
+    })
+    .optional(),
+  ratelimits: z.array(verificationRatelimitSchema).optional(),
+  analytics: z
+    .object({
+      include: z.boolean().default(true),
+      persistSummary: z.boolean().default(true),
+      includeRecentRequests: z.boolean().default(true),
+      includeRiskScore: z.boolean().default(true),
+      failClosed: z.boolean().default(false),
+    })
+    .optional(),
+});
+
+export type VerifyKeyRequest = z.infer<typeof verifyKeyRequestSchema>;
+
+export const backendVerifyResponseSchema = z.object({
+  meta: z.object({
+    requestId: z.string(),
+  }),
+  data: z.object({
+    code: z.string(),
+    valid: z.boolean(),
+    enabled: z.boolean().optional(),
+    name: z.string().nullable().optional(),
+    keyId: z.string().optional(),
+    permissions: z.array(z.string()).optional(),
+    roles: z.array(z.string()).optional(),
+    credits: z.number().nullable().optional(),
+    expires: z.number().optional(),
+    identity: z
+      .object({
+        id: z.string(),
+        externalId: z.string().nullable().optional(),
+        meta: z.record(z.unknown()).nullable().optional(),
+        ratelimits: z.array(z.unknown()).nullable().optional(),
+      })
+      .nullable()
+      .optional(),
+    meta: z.record(z.unknown()).nullable().optional(),
+    ratelimits: z.array(z.unknown()).nullable().optional(),
+  }),
+});
+
+export type BackendVerifyResponse = z.infer<typeof backendVerifyResponseSchema>;
+
+export const verificationAnalyticsSummarySchema = z.object({
+  keyId: z.string(),
+  workspaceId: z.string(),
+  requestId: z.string(),
+  recentValid: z.number().int().nonnegative(),
+  recentInvalid: z.number().int().nonnegative(),
+  recentRateLimited: z.number().int().nonnegative(),
+  p95LatencyMs: z.number().nonnegative(),
+  riskScore: z.number().min(0).max(100),
+  riskReason: z.string(),
+  lastSeenAt: z.number().int().nonnegative(),
+  tags: z.array(z.string()),
+  sampledRequests: z.array(
+    z.object({
+      requestId: z.string(),
+      time: z.number().int(),
+      outcome: z.string(),
+      region: z.string(),
+      tags: z.array(z.string()),
+    }),
+  ),
+});
+
+export type VerificationAnalyticsSummary = z.infer<typeof verificationAnalyticsSummarySchema>;
+
+export type VerificationDecisionSource = "backend" | "analytics" | "analytics_error";
+
+export const enrichedVerifyResponseSchema = backendVerifyResponseSchema.extend({
+  data: backendVerifyResponseSchema.shape.data.extend({
+    decisionSource: z.custom<VerificationDecisionSource>(),
+    analytics: verificationAnalyticsSummarySchema.nullable(),
+  }),
+});
+
+export type EnrichedVerifyResponse = z.infer<typeof enrichedVerifyResponseSchema>;
+
+export type VerificationBackendClient = {
+  verify(input: VerifyKeyRequest, headers: Headers): Promise<BackendVerifyResponse>;
+};
+
+export type AnalyticsEnrichmentInput = {
+  request: VerifyKeyRequest;
+  backendResponse: BackendVerifyResponse;
+  requestId: string;
+  workspaceId: string;
+  region: string;
+  now: number;
+};
+
+export type AnalyticsEnrichmentResult = {
+  summary: VerificationAnalyticsSummary;
+  decision: {
+    valid: boolean;
+    code: string;
+    source: VerificationDecisionSource;
+    reason: string;
+  };
+};
diff --git a/web/internal/key-verification/backend.ts b/web/internal/key-verification/backend.ts
new file mode 100644
index 000000000..722747f1f
--- /dev/null
+++ b/web/internal/key-verification/backend.ts
@@ -0,0 +1,180 @@
+import { backendVerifyResponseSchema, VerifyKeyRequest, VerificationBackendClient } from "./types";
+
+export type BackendClientOptions = {
+  baseUrl: string;
+  fetchImpl?: typeof fetch;
+  timeoutMs?: number;
+};
+
+export class HttpVerificationBackendClient implements VerificationBackendClient {
+  private readonly baseUrl: string;
+  private readonly fetchImpl: typeof fetch;
+  private readonly timeoutMs: number;
+
+  constructor(options: BackendClientOptions) {
+    this.baseUrl = options.baseUrl.replace(/\/$/, "");
+    this.fetchImpl = options.fetchImpl ?? fetch;
+    this.timeoutMs = options.timeoutMs ?? 2_000;
+  }
+
+  async verify(input: VerifyKeyRequest, headers: Headers) {
+    const controller = new AbortController();
+    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
+
+    try {
+      const response = await this.fetchImpl(`${this.baseUrl}/v2/keys.verifyKey`, {
+        method: "POST",
+        signal: controller.signal,
+        headers: this.forwardHeaders(headers),
+        body: JSON.stringify({
+          key: input.key,
+          apiId: input.apiId,
+          migrationId: input.migrationId,
+          permissions: input.permissions,
+          tags: input.tags,
+          credits: input.credits,
+          ratelimits: input.ratelimits,
+        }),
+      });
+
+      const json = await response.json();
+      const parsed = backendVerifyResponseSchema.safeParse(json);
+      if (!parsed.success) {
+        throw new Error(`invalid backend verification response: ${parsed.error.message}`);
+      }
+
+      return parsed.data;
+    } finally {
+      clearTimeout(timeout);
+    }
+  }
+
+  private forwardHeaders(headers: Headers): Headers {
+    const forwarded = new Headers();
+    const authorization = headers.get("authorization");
+    const rootKey = headers.get("x-unkey-root-key");
+    const requestId = headers.get("x-request-id");
+    const traceparent = headers.get("traceparent");
+    const baggage = headers.get("baggage");
+
+    if (authorization) {
+      forwarded.set("authorization", authorization);
+    }
+    if (rootKey) {
+      forwarded.set("x-unkey-root-key", rootKey);
+    }
+    if (requestId) {
+      forwarded.set("x-request-id", requestId);
+    }
+    if (traceparent) {
+      forwarded.set("traceparent", traceparent);
+    }
+    if (baggage) {
+      forwarded.set("baggage", baggage);
+    }
+
+    forwarded.set("content-type", "application/json");
+    forwarded.set("user-agent", "unkey-web-verification-proxy");
+    return forwarded;
+  }
+}
+
+export function inferWorkspaceIdFromBackendResponse(response: {
+  data: { keyId?: string; meta?: Record<string, unknown> | null };
+}) {
+  const workspaceId = response.data.meta?.workspaceId;
+  if (typeof workspaceId === "string" && workspaceId.length > 0) {
+    return workspaceId;
+  }
+  return "unknown";
+}
+
+export function sanitizeVerifyRequestForLogs(input: VerifyKeyRequest) {
+  return {
+    apiId: input.apiId,
+    migrationId: input.migrationId,
+    permissions: input.permissions,
+    tags: input.tags ?? [],
+    credits: input.credits,
+    ratelimits: input.ratelimits ?? [],
+    analytics: input.analytics ?? null,
+    keyPreview: previewKey(input.key),
+  };
+}
+
+function previewKey(key: string) {
+  if (key.length <= 8) {
+    return "********";
+  }
+  return `${key.slice(0, 4)}...${key.slice(-4)}`;
+}
+
+export type RetryableBackendError = {
+  name: "RetryableBackendError";
+  message: string;
+  cause: unknown;
+};
+
+export function isAbortError(error: unknown) {
+  return error instanceof DOMException && error.name === "AbortError";
+}
+
+export function normalizeBackendError(error: unknown): RetryableBackendError {
+  if (error instanceof Error) {
+    return {
+      name: "RetryableBackendError",
+      message: error.message,
+      cause: error,
+    };
+  }
+
+  return {
+    name: "RetryableBackendError",
+    message: "unknown backend verification error",
+    cause: error,
+  };
+}
+
+export function buildBackendUnavailableResponse(requestId: string) {
+  return {
+    meta: {
+      requestId,
+    },
+    data: {
+      code: "BACKEND_UNAVAILABLE",
+      valid: false,
+      enabled: undefined,
+      name: null,
+      keyId: undefined,
+      permissions: [],
+      roles: [],
+      credits: null,
+      expires: 0,
+      identity: null,
+      meta: null,
+      ratelimits: [],
+    },
+  };
+}
+
+export function copyBackendResponse(response: Awaited<ReturnType<VerificationBackendClient["verify"]>>) {
+  return {
+    meta: {
+      requestId: response.meta.requestId,
+    },
+    data: {
+      code: response.data.code,
+      valid: response.data.valid,
+      enabled: response.data.enabled,
+      name: response.data.name ?? null,
+      keyId: response.data.keyId,
+      permissions: response.data.permissions ?? [],
+      roles: response.data.roles ?? [],
+      credits: response.data.credits ?? null,
+      expires: response.data.expires ?? 0,
+      identity: response.data.identity ?? null,
+      meta: response.data.meta ?? null,
+      ratelimits: response.data.ratelimits ?? [],
+    },
+  };
+}
diff --git a/web/internal/key-verification/analytics-enrichment.ts b/web/internal/key-verification/analytics-enrichment.ts
new file mode 100644
index 000000000..7fd410190
--- /dev/null
+++ b/web/internal/key-verification/analytics-enrichment.ts
@@ -0,0 +1,342 @@
+import { and, db, desc, eq, gt, inArray, schema, sql } from "@/lib/db";
+import { clickhouse } from "@unkey/clickhouse";
+import { newId } from "@unkey/id";
+import {
+  AnalyticsEnrichmentInput,
+  AnalyticsEnrichmentResult,
+  VerificationAnalyticsSummary,
+} from "./types";
+
+export type AnalyticsEnrichmentOptions = {
+  lookbackMs?: number;
+  sampleLimit?: number;
+  persistSummary?: boolean;
+  includeRecentRequests?: boolean;
+  includeRiskScore?: boolean;
+};
+
+const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000;
+const DEFAULT_SAMPLE_LIMIT = 20;
+
+export async function enrichVerificationAnalytics(
+  input: AnalyticsEnrichmentInput,
+  options: AnalyticsEnrichmentOptions = {},
+): Promise<AnalyticsEnrichmentResult> {
+  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
+  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
+  const includeRecentRequests = options.includeRecentRequests ?? true;
+  const includeRiskScore = options.includeRiskScore ?? true;
+  const persistSummary = options.persistSummary ?? input.request.analytics?.persistSummary ?? true;
+
+  const keyId = input.backendResponse.data.keyId;
+  if (!keyId) {
+    return {
+      summary: emptySummary(input, "missing key id"),
+      decision: {
+        valid: input.backendResponse.data.valid,
+        code: input.backendResponse.data.code,
+        source: "backend",
+        reason: "backend did not return a key id",
+      },
+    };
+  }
+
+  const since = input.now - lookbackMs;
+  const [recentTotals, recentRequests, existingSummary, keyRows] = await Promise.all([
+    loadRecentVerificationTotals(input.workspaceId, keyId, since, input.now),
+    includeRecentRequests
+      ? loadRecentRequests(input.workspaceId, keyId, since, input.now, sampleLimit)
+      : Promise.resolve([]),
+    loadExistingSummary(input.workspaceId, keyId),
+    loadControlPlaneKeyRows(input.workspaceId, keyId),
+  ]);
+
+  const risk = includeRiskScore
+    ? calculateRiskScore({
+        backendValid: input.backendResponse.data.valid,
+        totals: recentTotals,
+        existingSummary,
+        keyRows,
+        tags: input.request.tags ?? [],
+      })
+    : { score: 0, reason: "risk scoring disabled" };
+
+  const summary: VerificationAnalyticsSummary = {
+    keyId,
+    workspaceId: input.workspaceId,
+    requestId: input.requestId,
+    recentValid: recentTotals.valid,
+    recentInvalid: recentTotals.invalid,
+    recentRateLimited: recentTotals.rateLimited,
+    p95LatencyMs: recentTotals.p95LatencyMs,
+    riskScore: risk.score,
+    riskReason: risk.reason,
+    lastSeenAt: input.now,
+    tags: normalizeTags(input.request.tags ?? []),
+    sampledRequests: recentRequests,
+  };
+
+  if (persistSummary) {
+    await persistEnrichmentState(input, summary);
+  }
+
+  return {
+    summary,
+    decision: {
+      valid: risk.score < 90 && input.backendResponse.data.valid,
+      code: risk.score >= 90 ? "ANALYTICS_RISK_BLOCKED" : input.backendResponse.data.code,
+      source: risk.score >= 90 ? "analytics" : "backend",
+      reason: risk.reason,
+    },
+  };
+}
+
+async function loadRecentVerificationTotals(
+  workspaceId: string,
+  keyId: string,
+  startTime: number,
+  endTime: number,
+) {
+  const rows = await clickhouse.query({
+    query: `
+      SELECT
+        countIf(outcome = 'VALID') as valid,
+        countIf(outcome IN ('INVALID', 'DISABLED', 'EXPIRED')) as invalid,
+        countIf(outcome IN ('RATE_LIMITED', 'USAGE_EXCEEDED')) as rate_limited,
+        quantile(0.95)(latency) as p95_latency_ms
+      FROM default.key_verifications_raw_v2
+      PREWHERE workspace_id = {workspaceId:String}
+        AND key_id = {keyId:String}
+        AND time BETWEEN {startTime:UInt64} AND {endTime:UInt64}
+    `,
+    params: {
+      workspaceId,
+      keyId,
+      startTime,
+      endTime,
+    },
+    schema: {
+      valid: "number",
+      invalid: "number",
+      rate_limited: "number",
+      p95_latency_ms: "number",
+    },
+  });
+
+  const row = rows.val?.[0];
+  return {
+    valid: Number(row?.valid ?? 0),
+    invalid: Number(row?.invalid ?? 0),
+    rateLimited: Number(row?.rate_limited ?? 0),
+    p95LatencyMs: Number(row?.p95_latency_ms ?? 0),
+  };
+}
+
+async function loadRecentRequests(
+  workspaceId: string,
+  keyId: string,
+  startTime: number,
+  endTime: number,
+  limit: number,
+) {
+  const rows = await clickhouse.query({
+    query: `
+      SELECT request_id, time, outcome, region, tags
+      FROM default.key_verifications_raw_v2
+      PREWHERE workspace_id = {workspaceId:String}
+        AND key_id = {keyId:String}
+        AND time BETWEEN {startTime:UInt64} AND {endTime:UInt64}
+      ORDER BY time DESC
+      LIMIT {limit:Int}
+    `,
+    params: {
+      workspaceId,
+      keyId,
+      startTime,
+      endTime,
+      limit,
+    },
+    schema: {
+      request_id: "string",
+      time: "number",
+      outcome: "string",
+      region: "string",
+      tags: "string[]",
+    },
+  });
+
+  return (rows.val ?? []).map((row) => ({
+    requestId: row.request_id,
+    time: Number(row.time),
+    outcome: String(row.outcome),
+    region: String(row.region),
+    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
+  }));
+}
+
+async function loadExistingSummary(workspaceId: string, keyId: string) {
+  const rows = await db
+    .select()
+    .from(schema.verificationAnalyticsSummaries)
+    .where(
+      and(
+        eq(schema.verificationAnalyticsSummaries.workspaceId, workspaceId),
+        eq(schema.verificationAnalyticsSummaries.keyId, keyId),
+      ),
+    )
+    .orderBy(desc(schema.verificationAnalyticsSummaries.updatedAt))
+    .limit(1);
+
+  return rows[0] ?? null;
+}
+
+async function loadControlPlaneKeyRows(workspaceId: string, keyId: string) {
+  return db
+    .select({
+      keyId: schema.keys.id,
+      enabled: schema.keys.enabled,
+      lastUsedAt: schema.keys.lastUsedAt,
+      identityId: schema.keys.identityId,
+      workspaceId: schema.keys.workspaceId,
+    })
+    .from(schema.keys)
+    .where(and(eq(schema.keys.workspaceId, workspaceId), eq(schema.keys.id, keyId)))
+    .limit(1);
+}
+
+async function persistEnrichmentState(
+  input: AnalyticsEnrichmentInput,
+  summary: VerificationAnalyticsSummary,
+) {
+  const summaryId = newId("verification_summary");
+  const eventId = newId("event");
+  const keyId = summary.keyId;
+  const tagRows = summary.tags.map((tag) => ({
+    id: newId("verification_tag"),
+    workspaceId: input.workspaceId,
+    keyId,
+    tag,
+    lastSeenAt: input.now,
+  }));
+
+  await db.transaction(async (tx) => {
+    await tx
+      .insert(schema.verificationAnalyticsSummaries)
+      .values({
+        id: summaryId,
+        workspaceId: input.workspaceId,
+        keyId,
+        requestId: input.requestId,
+        recentValid: summary.recentValid,
+        recentInvalid: summary.recentInvalid,
+        recentRateLimited: summary.recentRateLimited,
+        p95LatencyMs: String(summary.p95LatencyMs),
+        riskScore: String(summary.riskScore),
+        riskReason: summary.riskReason,
+        sample: summary.sampledRequests,
+        updatedAt: input.now,
+        createdAt: input.now,
+      })
+      .onDuplicateKeyUpdate({
+        set: {
+          requestId: input.requestId,
+          recentValid: summary.recentValid,
+          recentInvalid: summary.recentInvalid,
+          recentRateLimited: summary.recentRateLimited,
+          p95LatencyMs: String(summary.p95LatencyMs),
+          riskScore: String(summary.riskScore),
+          riskReason: summary.riskReason,
+          sample: summary.sampledRequests,
+          updatedAt: input.now,
+        },
+      });
+
+    await tx
+      .update(schema.keys)
+      .set({ lastUsedAt: input.now })
+      .where(and(eq(schema.keys.workspaceId, input.workspaceId), eq(schema.keys.id, keyId)));
+
+    if (summary.tags.length > 0) {
+      await tx
+        .delete(schema.verificationAnalyticsTags)
+        .where(
+          and(
+            eq(schema.verificationAnalyticsTags.workspaceId, input.workspaceId),
+            eq(schema.verificationAnalyticsTags.keyId, keyId),
+            gt(schema.verificationAnalyticsTags.lastSeenAt, input.now - 24 * 60 * 60 * 1000),
+          ),
+        );
+
+      await tx.insert(schema.verificationAnalyticsTags).values(tagRows);
+    }
+
+    await tx.insert(schema.clickhouseOutbox).values({
+      version: "verification_analytics.v1",
+      workspaceId: input.workspaceId,
+      eventId,
+      payload: {
+        type: "verification.analytics.enriched",
+        requestId: input.requestId,
+        keyId,
+        workspaceId: input.workspaceId,
+        summary,
+        backendCode: input.backendResponse.data.code,
+        backendValid: input.backendResponse.data.valid,
+      },
+      createdAt: input.now,
+    });
+  });
+}
+
+function calculateRiskScore(args: {
+  backendValid: boolean;
+  totals: { valid: number; invalid: number; rateLimited: number; p95LatencyMs: number };
+  existingSummary: { riskScore?: string | number | null } | null;
+  keyRows: Array<{ enabled: boolean; lastUsedAt: number; identityId: string | null }>;
+  tags: string[];
+}) {
+  if (!args.backendValid) {
+    return { score: 0, reason: "backend rejected key" };
+  }
+
+  if (args.keyRows.length === 0) {
+    return { score: 95, reason: "analytics could not find key row" };
+  }
+
+  const invalidTotal = args.totals.invalid + args.totals.rateLimited;
+  const total = args.totals.valid + invalidTotal;
+  const invalidRatio = total === 0 ? 0 : invalidTotal / total;
+  const prior = Number(args.existingSummary?.riskScore ?? 0);
+  const tagPenalty = args.tags.some((tag) => tag.startsWith("integration:legacy")) ? 25 : 0;
+  const latencyPenalty = args.totals.p95LatencyMs > 1_000 ? 20 : 0;
+  const score = Math.min(100, Math.round(invalidRatio * 70 + prior * 0.25 + tagPenalty + latencyPenalty));
+
+  if (score >= 90) {
+    return { score, reason: "recent verification analytics exceeded risk threshold" };
+  }
+  if (score >= 60) {
+    return { score, reason: "recent verification analytics are elevated" };
+  }
+  return { score, reason: "recent verification analytics are normal" };
+}
+
+function normalizeTags(tags: string[]) {
+  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 32);
+}
+
+function emptySummary(input: AnalyticsEnrichmentInput, reason: string): VerificationAnalyticsSummary {
+  return {
+    keyId: input.backendResponse.data.keyId ?? "unknown",
+    workspaceId: input.workspaceId,
+    requestId: input.requestId,
+    recentValid: 0,
+    recentInvalid: 0,
+    recentRateLimited: 0,
+    p95LatencyMs: 0,
+    riskScore: 0,
+    riskReason: reason,
+    lastSeenAt: input.now,
+    tags: normalizeTags(input.request.tags ?? []),
+    sampledRequests: [],
+  };
+}
diff --git a/web/internal/key-verification/verify-with-analytics.ts b/web/internal/key-verification/verify-with-analytics.ts
new file mode 100644
index 000000000..b18a0d8a1
--- /dev/null
+++ b/web/internal/key-verification/verify-with-analytics.ts
@@ -0,0 +1,248 @@
+import { logger } from "@/lib/logger";
+import {
+  buildBackendUnavailableResponse,
+  copyBackendResponse,
+  inferWorkspaceIdFromBackendResponse,
+  normalizeBackendError,
+  sanitizeVerifyRequestForLogs,
+} from "./backend";
+import { enrichVerificationAnalytics } from "./analytics-enrichment";
+import {
+  BackendVerifyResponse,
+  EnrichedVerifyResponse,
+  VerificationBackendClient,
+  VerifyKeyRequest,
+} from "./types";
+
+export type VerifyKeyWithAnalyticsOptions = {
+  backend: VerificationBackendClient;
+  headers: Headers;
+  requestId: string;
+  region: string;
+  now?: number;
+  logger?: Pick<typeof logger, "info" | "warn" | "error">;
+};
+
+export async function verifyKeyWithAnalytics(
+  request: VerifyKeyRequest,
+  options: VerifyKeyWithAnalyticsOptions,
+): Promise<EnrichedVerifyResponse> {
+  const log = options.logger ?? logger;
+  const now = options.now ?? Date.now();
+  const analyticsEnabled = request.analytics?.include ?? true;
+
+  let backendResponse: BackendVerifyResponse;
+  try {
+    backendResponse = await options.backend.verify(request, options.headers);
+  } catch (error) {
+    const normalized = normalizeBackendError(error);
+    log.error("backend verification failed", {
+      requestId: options.requestId,
+      error: normalized.message,
+      request: sanitizeVerifyRequestForLogs(request),
+    });
+    backendResponse = buildBackendUnavailableResponse(options.requestId);
+  }
+
+  const baseResponse = copyBackendResponse(backendResponse);
+  const workspaceId = inferWorkspaceIdFromBackendResponse(backendResponse);
+
+  if (!analyticsEnabled) {
+    return {
+      meta: baseResponse.meta,
+      data: {
+        ...baseResponse.data,
+        analytics: null,
+        decisionSource: "backend",
+      },
+    };
+  }
+
+  try {
+    const enrichment = await enrichVerificationAnalytics(
+      {
+        request,
+        backendResponse,
+        requestId: options.requestId,
+        workspaceId,
+        region: options.region,
+        now,
+      },
+      {
+        persistSummary: request.analytics?.persistSummary ?? true,
+        includeRecentRequests: request.analytics?.includeRecentRequests ?? true,
+        includeRiskScore: request.analytics?.includeRiskScore ?? true,
+      },
+    );
+
+    const data = applyAnalyticsDecision(baseResponse.data, enrichment);
+
+    log.info("verification analytics enriched", {
+      requestId: options.requestId,
+      keyId: enrichment.summary.keyId,
+      workspaceId,
+      decisionSource: data.decisionSource,
+      riskScore: enrichment.summary.riskScore,
+      backendValid: backendResponse.data.valid,
+      finalValid: data.valid,
+    });
+
+    return {
+      meta: baseResponse.meta,
+      data,
+    };
+  } catch (error) {
+    const message = error instanceof Error ? error.message : "unknown analytics error";
+    log.error("verification analytics failed", {
+      requestId: options.requestId,
+      keyId: backendResponse.data.keyId,
+      workspaceId,
+      error: message,
+      request: sanitizeVerifyRequestForLogs(request),
+    });
+
+    if (request.analytics?.failClosed ?? true) {
+      return {
+        meta: baseResponse.meta,
+        data: {
+          ...baseResponse.data,
+          code: "ANALYTICS_UNAVAILABLE",
+          valid: false,
+          analytics: null,
+          decisionSource: "analytics_error",
+        },
+      };
+    }
+
+    return {
+      meta: baseResponse.meta,
+      data: {
+        ...baseResponse.data,
+        analytics: null,
+        decisionSource: "backend",
+      },
+    };
+  }
+}
+
+function applyAnalyticsDecision(
+  backendData: EnrichedVerifyResponse["data"],
+  enrichment: Awaited<ReturnType<typeof enrichVerificationAnalytics>>,
+): EnrichedVerifyResponse["data"] {
+  if (!backendData.valid) {
+    return {
+      ...backendData,
+      analytics: enrichment.summary,
+      decisionSource: "backend",
+    };
+  }
+
+  if (!enrichment.decision.valid) {
+    return {
+      ...backendData,
+      code: enrichment.decision.code,
+      valid: false,
+      analytics: enrichment.summary,
+      decisionSource: enrichment.decision.source,
+    };
+  }
+
+  return {
+    ...backendData,
+    code: enrichment.decision.code,
+    valid: enrichment.decision.valid,
+    analytics: enrichment.summary,
+    decisionSource: enrichment.decision.source,
+  };
+}
+
+export function verifyResponseCacheKey(request: VerifyKeyRequest) {
+  const tagKey = [...(request.tags ?? [])].sort().join(",");
+  const permissionKey = request.permissions ?? "";
+  const ratelimitKey = (request.ratelimits ?? [])
+    .map((limit) => `${limit.name}:${limit.limit ?? ""}:${limit.duration ?? ""}:${limit.cost ?? ""}`)
+    .sort()
+    .join("|");
+
+  return [
+    request.apiId ?? "",
+    request.migrationId ?? "",
+    permissionKey,
+    tagKey,
+    ratelimitKey,
+    request.analytics?.include ?? true,
+    request.analytics?.persistSummary ?? true,
+    request.analytics?.includeRecentRequests ?? true,
+    request.analytics?.includeRiskScore ?? true,
+  ].join(":");
+}
+
+export type VerificationAuditRecord = {
+  requestId: string;
+  keyId?: string;
+  backendCode: string;
+  backendValid: boolean;
+  finalCode: string;
+  finalValid: boolean;
+  decisionSource: string;
+  latencyMs: number;
+};
+
+export function buildVerificationAuditRecord(args: {
+  requestId: string;
+  startedAt: number;
+  backend: BackendVerifyResponse;
+  response: EnrichedVerifyResponse;
+}): VerificationAuditRecord {
+  return {
+    requestId: args.requestId,
+    keyId: args.backend.data.keyId,
+    backendCode: args.backend.data.code,
+    backendValid: args.backend.data.valid,
+    finalCode: args.response.data.code,
+    finalValid: args.response.data.valid,
+    decisionSource: args.response.data.decisionSource,
+    latencyMs: Date.now() - args.startedAt,
+  };
+}
+
+export function shouldRetryAnalyticsFailure(error: unknown) {
+  if (!(error instanceof Error)) {
+    return false;
+  }
+  return (
+    error.message.includes("ClickHouse") ||
+    error.message.includes("timeout") ||
+    error.message.includes("connection") ||
+    error.message.includes("deadlock")
+  );
+}
+
+export function redactResponseForLogs(response: EnrichedVerifyResponse) {
+  return {
+    requestId: response.meta.requestId,
+    code: response.data.code,
+    valid: response.data.valid,
+    keyId: response.data.keyId,
+    decisionSource: response.data.decisionSource,
+    analytics: response.data.analytics
+      ? {
+          riskScore: response.data.analytics.riskScore,
+          riskReason: response.data.analytics.riskReason,
+          recentValid: response.data.analytics.recentValid,
+          recentInvalid: response.data.analytics.recentInvalid,
+          recentRateLimited: response.data.analytics.recentRateLimited,
+        }
+      : null,
+  };
+}
+
+export function explainDecision(response: EnrichedVerifyResponse) {
+  if (response.data.decisionSource === "analytics_error") {
+    return "analytics enrichment failed and the request was denied";
+  }
+  if (response.data.decisionSource === "analytics") {
+    return response.data.analytics?.riskReason ?? "analytics changed the verification decision";
+  }
+  return "backend verification decision was used";
+}
diff --git a/web/apps/dashboard/app/api/v2/keys/verify/route.ts b/web/apps/dashboard/app/api/v2/keys/verify/route.ts
new file mode 100644
index 000000000..b2390bc78
--- /dev/null
+++ b/web/apps/dashboard/app/api/v2/keys/verify/route.ts
@@ -0,0 +1,130 @@
+import { NextRequest, NextResponse } from "next/server";
+import { env } from "@/lib/env";
+import { logger } from "@/lib/logger";
+import { HttpVerificationBackendClient } from "@unkey/key-verification/backend";
+import { verifyKeyWithAnalytics } from "@unkey/key-verification/verify-with-analytics";
+import { verifyKeyRequestSchema } from "@unkey/key-verification/types";
+
+const backend = new HttpVerificationBackendClient({
+  baseUrl: env.UNKEY_API_URL,
+  timeoutMs: 2_000,
+});
+
+export const runtime = "nodejs";
+export const dynamic = "force-dynamic";
+
+export async function POST(request: NextRequest) {
+  const startedAt = Date.now();
+  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
+  const region = request.headers.get("x-unkey-region") ?? env.UNKEY_REGION ?? "unknown";
+
+  let body: unknown;
+  try {
+    body = await request.json();
+  } catch {
+    return NextResponse.json(
+      {
+        meta: { requestId },
+        data: {
+          code: "BAD_REQUEST",
+          valid: false,
+          analytics: null,
+          decisionSource: "backend",
+        },
+      },
+      { status: 400 },
+    );
+  }
+
+  const parsed = verifyKeyRequestSchema.safeParse(body);
+  if (!parsed.success) {
+    return NextResponse.json(
+      {
+        meta: { requestId },
+        data: {
+          code: "BAD_REQUEST",
+          valid: false,
+          analytics: null,
+          decisionSource: "backend",
+          errors: parsed.error.issues.map((issue) => ({
+            path: issue.path.join("."),
+            message: issue.message,
+          })),
+        },
+      },
+      { status: 400 },
+    );
+  }
+
+  const response = await verifyKeyWithAnalytics(parsed.data, {
+    backend,
+    headers: request.headers,
+    requestId,
+    region,
+    logger,
+  });
+
+  logger.info("web verification proxy response", {
+    requestId,
+    code: response.data.code,
+    valid: response.data.valid,
+    decisionSource: response.data.decisionSource,
+    elapsedMs: Date.now() - startedAt,
+  });
+
+  return NextResponse.json(response, {
+    status: 200,
+    headers: {
+      "x-request-id": requestId,
+      "cache-control": "no-store",
+    },
+  });
+}
+
+export async function GET() {
+  return NextResponse.json(
+    {
+      error: {
+        code: "METHOD_NOT_ALLOWED",
+        message: "Use POST to verify a key.",
+      },
+    },
+    { status: 405 },
+  );
+}
+
+export function OPTIONS() {
+  return new NextResponse(null, {
+    status: 204,
+    headers: {
+      allow: "POST, OPTIONS",
+      "access-control-allow-methods": "POST, OPTIONS",
+      "access-control-allow-headers": "authorization, content-type, x-request-id",
+      "access-control-max-age": "86400",
+    },
+  });
+}
+
+export function buildVerificationProxyHeaders(request: NextRequest) {
+  const headers = new Headers();
+  const authorization = request.headers.get("authorization");
+  const rootKey = request.headers.get("x-unkey-root-key");
+  const requestId = request.headers.get("x-request-id");
+  const traceparent = request.headers.get("traceparent");
+
+  if (authorization) {
+    headers.set("authorization", authorization);
+  }
+  if (rootKey) {
+    headers.set("x-unkey-root-key", rootKey);
+  }
+  if (requestId) {
+    headers.set("x-request-id", requestId);
+  }
+  if (traceparent) {
+    headers.set("traceparent", traceparent);
+  }
+
+  headers.set("content-type", "application/json");
+  return headers;
+}
diff --git a/web/internal/db/src/schema/verification_analytics.ts b/web/internal/db/src/schema/verification_analytics.ts
new file mode 100644
index 000000000..e9aa3fe04
--- /dev/null
+++ b/web/internal/db/src/schema/verification_analytics.ts
@@ -0,0 +1,153 @@
+import { relations } from "drizzle-orm";
+import {
+  bigint,
+  decimal,
+  index,
+  json,
+  mysqlTable,
+  text,
+  uniqueIndex,
+  varchar,
+} from "drizzle-orm/mysql-core";
+import { keys } from "./keys";
+import { workspaces } from "./workspaces";
+
+export const verificationAnalyticsSummaries = mysqlTable(
+  "verification_analytics_summaries",
+  {
+    pk: bigint("pk", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
+    id: varchar("id", { length: 256 }).notNull().unique(),
+    workspaceId: varchar("workspace_id", { length: 256 }).notNull(),
+    keyId: varchar("key_id", { length: 256 }).notNull(),
+    requestId: varchar("request_id", { length: 256 }).notNull(),
+    recentValid: bigint("recent_valid", { mode: "number", unsigned: true }).notNull().default(0),
+    recentInvalid: bigint("recent_invalid", { mode: "number", unsigned: true }).notNull().default(0),
+    recentRateLimited: bigint("recent_rate_limited", { mode: "number", unsigned: true })
+      .notNull()
+      .default(0),
+    p95LatencyMs: decimal("p95_latency_ms", { precision: 10, scale: 2 }).notNull().default("0"),
+    riskScore: decimal("risk_score", { precision: 5, scale: 2 }).notNull().default("0"),
+    riskReason: text("risk_reason").notNull(),
+    sample: json("sample").$type<
+      Array<{
+        requestId: string;
+        time: number;
+        outcome: string;
+        region: string;
+        tags: string[];
+      }>
+    >(),
+    updatedAt: bigint("updated_at", { mode: "number", unsigned: true }).notNull(),
+    createdAt: bigint("created_at", { mode: "number", unsigned: true }).notNull(),
+  },
+  (table) => [
+    uniqueIndex("verification_analytics_summary_workspace_key_idx").on(
+      table.workspaceId,
+      table.keyId,
+    ),
+    index("verification_analytics_summary_workspace_updated_idx").on(
+      table.workspaceId,
+      table.updatedAt,
+    ),
+    index("verification_analytics_summary_key_updated_idx").on(table.keyId, table.updatedAt),
+  ],
+);
+
+export const verificationAnalyticsTags = mysqlTable(
+  "verification_analytics_tags",
+  {
+    pk: bigint("pk", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
+    id: varchar("id", { length: 256 }).notNull().unique(),
+    workspaceId: varchar("workspace_id", { length: 256 }).notNull(),
+    keyId: varchar("key_id", { length: 256 }).notNull(),
+    tag: varchar("tag", { length: 256 }).notNull(),
+    lastSeenAt: bigint("last_seen_at", { mode: "number", unsigned: true }).notNull(),
+  },
+  (table) => [
+    uniqueIndex("verification_analytics_tags_workspace_key_tag_idx").on(
+      table.workspaceId,
+      table.keyId,
+      table.tag,
+    ),
+    index("verification_analytics_tags_workspace_tag_idx").on(table.workspaceId, table.tag),
+    index("verification_analytics_tags_key_seen_idx").on(table.keyId, table.lastSeenAt),
+  ],
+);
+
+export const verificationAnalyticsDecisions = mysqlTable(
+  "verification_analytics_decisions",
+  {
+    pk: bigint("pk", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
+    id: varchar("id", { length: 256 }).notNull().unique(),
+    workspaceId: varchar("workspace_id", { length: 256 }).notNull(),
+    keyId: varchar("key_id", { length: 256 }).notNull(),
+    requestId: varchar("request_id", { length: 256 }).notNull(),
+    backendCode: varchar("backend_code", { length: 64 }).notNull(),
+    backendValid: varchar("backend_valid", { length: 16 }).notNull(),
+    finalCode: varchar("final_code", { length: 64 }).notNull(),
+    finalValid: varchar("final_valid", { length: 16 }).notNull(),
+    decisionSource: varchar("decision_source", { length: 64 }).notNull(),
+    reason: text("reason").notNull(),
+    createdAt: bigint("created_at", { mode: "number", unsigned: true }).notNull(),
+  },
+  (table) => [
+    index("verification_analytics_decisions_workspace_created_idx").on(
+      table.workspaceId,
+      table.createdAt,
+    ),
+    index("verification_analytics_decisions_key_created_idx").on(table.keyId, table.createdAt),
+    uniqueIndex("verification_analytics_decisions_request_idx").on(table.requestId),
+  ],
+);
+
+export const verificationAnalyticsSummaryRelations = relations(
+  verificationAnalyticsSummaries,
+  ({ one }) => ({
+    workspace: one(workspaces, {
+      fields: [verificationAnalyticsSummaries.workspaceId],
+      references: [workspaces.id],
+    }),
+    key: one(keys, {
+      fields: [verificationAnalyticsSummaries.keyId],
+      references: [keys.id],
+    }),
+  }),
+);
+
+export const verificationAnalyticsTagsRelations = relations(verificationAnalyticsTags, ({ one }) => ({
+  workspace: one(workspaces, {
+    fields: [verificationAnalyticsTags.workspaceId],
+    references: [workspaces.id],
+  }),
+  key: one(keys, {
+    fields: [verificationAnalyticsTags.keyId],
+    references: [keys.id],
+  }),
+}));
+
+export const verificationAnalyticsDecisionsRelations = relations(
+  verificationAnalyticsDecisions,
+  ({ one }) => ({
+    workspace: one(workspaces, {
+      fields: [verificationAnalyticsDecisions.workspaceId],
+      references: [workspaces.id],
+    }),
+    key: one(keys, {
+      fields: [verificationAnalyticsDecisions.keyId],
+      references: [keys.id],
+    }),
+  }),
+);
+
+export type InsertVerificationAnalyticsSummary = typeof verificationAnalyticsSummaries.$inferInsert;
+export type SelectVerificationAnalyticsSummary = typeof verificationAnalyticsSummaries.$inferSelect;
+export type InsertVerificationAnalyticsTag = typeof verificationAnalyticsTags.$inferInsert;
+export type SelectVerificationAnalyticsTag = typeof verificationAnalyticsTags.$inferSelect;
+export type InsertVerificationAnalyticsDecision = typeof verificationAnalyticsDecisions.$inferInsert;
+export type SelectVerificationAnalyticsDecision = typeof verificationAnalyticsDecisions.$inferSelect;
+
+export const verificationAnalyticsTables = {
+  summaries: verificationAnalyticsSummaries,
+  tags: verificationAnalyticsTags,
+  decisions: verificationAnalyticsDecisions,
+};
diff --git a/web/internal/key-verification/analytics-enrichment.test.ts b/web/internal/key-verification/analytics-enrichment.test.ts
new file mode 100644
index 000000000..cd287091d
--- /dev/null
+++ b/web/internal/key-verification/analytics-enrichment.test.ts
@@ -0,0 +1,246 @@
+import { describe, expect, it, vi } from "vitest";
+import { verifyKeyWithAnalytics } from "./verify-with-analytics";
+import { BackendVerifyResponse, VerificationBackendClient, VerifyKeyRequest } from "./types";
+
+const validBackendResponse: BackendVerifyResponse = {
+  meta: { requestId: "req_backend" },
+  data: {
+    code: "VALID",
+    valid: true,
+    enabled: true,
+    name: "production key",
+    keyId: "key_123",
+    permissions: ["documents.read"],
+    roles: ["reader"],
+    credits: 100,
+    expires: 0,
+    identity: {
+      id: "id_123",
+      externalId: "customer_123",
+      meta: null,
+      ratelimits: null,
+    },
+    meta: {
+      workspaceId: "ws_123",
+    },
+    ratelimits: [],
+  },
+};
+
+const invalidBackendResponse: BackendVerifyResponse = {
+  meta: { requestId: "req_backend" },
+  data: {
+    code: "NOT_FOUND",
+    valid: false,
+    enabled: undefined,
+    name: null,
+    keyId: undefined,
+    permissions: [],
+    roles: [],
+    credits: null,
+    expires: 0,
+    identity: null,
+    meta: null,
+    ratelimits: [],
+  },
+};
+
+function request(overrides: Partial<VerifyKeyRequest> = {}): VerifyKeyRequest {
+  return {
+    key: "sk_live_123",
+    tags: ["api", "production"],
+    analytics: {
+      include: true,
+      persistSummary: true,
+      includeRecentRequests: true,
+      includeRiskScore: true,
+      failClosed: true,
+    },
+    ...overrides,
+  };
+}
+
+function backend(response: BackendVerifyResponse): VerificationBackendClient {
+  return {
+    verify: vi.fn(async () => response),
+  };
+}
+
+function headers() {
+  const h = new Headers();
+  h.set("authorization", "Bearer root_123");
+  h.set("x-request-id", "req_123");
+  return h;
+}
+
+vi.mock("./analytics-enrichment", () => ({
+  enrichVerificationAnalytics: vi.fn(async () => ({
+    summary: {
+      keyId: "key_123",
+      workspaceId: "ws_123",
+      requestId: "req_123",
+      recentValid: 10,
+      recentInvalid: 0,
+      recentRateLimited: 0,
+      p95LatencyMs: 12,
+      riskScore: 10,
+      riskReason: "recent verification analytics are normal",
+      lastSeenAt: 1778932320000,
+      tags: ["api", "production"],
+      sampledRequests: [],
+    },
+    decision: {
+      valid: true,
+      code: "VALID",
+      source: "backend",
+      reason: "recent verification analytics are normal",
+    },
+  })),
+}));
+
+describe("verifyKeyWithAnalytics", () => {
+  it("waits for analytics enrichment before returning a valid response", async () => {
+    const response = await verifyKeyWithAnalytics(request(), {
+      backend: backend(validBackendResponse),
+      headers: headers(),
+      requestId: "req_123",
+      region: "iad",
+      now: 1778932320000,
+      logger: testLogger(),
+    });
+
+    expect(response.data.valid).toBe(true);
+    expect(response.data.analytics?.recentValid).toBe(10);
+    expect(response.data.analytics?.riskScore).toBe(10);
+    expect(response.data.decisionSource).toBe("backend");
+  });
+
+  it("returns the backend invalid result with analytics attached", async () => {
+    const response = await verifyKeyWithAnalytics(request(), {
+      backend: backend(invalidBackendResponse),
+      headers: headers(),
+      requestId: "req_123",
+      region: "iad",
+      now: 1778932320000,
+      logger: testLogger(),
+    });
+
+    expect(response.data.valid).toBe(false);
+    expect(response.data.code).toBe("NOT_FOUND");
+    expect(response.data.decisionSource).toBe("backend");
+  });
+
+  it("denies a valid backend decision when analytics fails and failClosed is enabled", async () => {
+    const enrichment = await import("./analytics-enrichment");
+    vi.mocked(enrichment.enrichVerificationAnalytics).mockRejectedValueOnce(
+      new Error("ClickHouse connection refused"),
+    );
+
+    const response = await verifyKeyWithAnalytics(request(), {
+      backend: backend(validBackendResponse),
+      headers: headers(),
+      requestId: "req_123",
+      region: "iad",
+      now: 1778932320000,
+      logger: testLogger(),
+    });
+
+    expect(response.data.valid).toBe(false);
+    expect(response.data.code).toBe("ANALYTICS_UNAVAILABLE");
+    expect(response.data.analytics).toBeNull();
+    expect(response.data.decisionSource).toBe("analytics_error");
+  });
+
+  it("lets analytics risk override a valid backend decision", async () => {
+    const enrichment = await import("./analytics-enrichment");
+    vi.mocked(enrichment.enrichVerificationAnalytics).mockResolvedValueOnce({
+      summary: {
+        keyId: "key_123",
+        workspaceId: "ws_123",
+        requestId: "req_123",
+        recentValid: 2,
+        recentInvalid: 90,
+        recentRateLimited: 20,
+        p95LatencyMs: 1400,
+        riskScore: 96,
+        riskReason: "recent verification analytics exceeded risk threshold",
+        lastSeenAt: 1778932320000,
+        tags: ["api"],
+        sampledRequests: [],
+      },
+      decision: {
+        valid: false,
+        code: "ANALYTICS_RISK_BLOCKED",
+        source: "analytics",
+        reason: "recent verification analytics exceeded risk threshold",
+      },
+    });
+
+    const response = await verifyKeyWithAnalytics(request(), {
+      backend: backend(validBackendResponse),
+      headers: headers(),
+      requestId: "req_123",
+      region: "iad",
+      now: 1778932320000,
+      logger: testLogger(),
+    });
+
+    expect(response.data.valid).toBe(false);
+    expect(response.data.code).toBe("ANALYTICS_RISK_BLOCKED");
+    expect(response.data.decisionSource).toBe("analytics");
+  });
+
+  it("can skip analytics when the caller opts out", async () => {
+    const response = await verifyKeyWithAnalytics(
+      request({
+        analytics: {
+          include: false,
+          persistSummary: false,
+          includeRecentRequests: false,
+          includeRiskScore: false,
+          failClosed: false,
+        },
+      }),
+      {
+        backend: backend(validBackendResponse),
+        headers: headers(),
+        requestId: "req_123",
+        region: "iad",
+        now: 1778932320000,
+        logger: testLogger(),
+      },
+    );
+
+    expect(response.data.valid).toBe(true);
+    expect(response.data.analytics).toBeNull();
+    expect(response.data.decisionSource).toBe("backend");
+  });
+
+  it("returns backend unavailable when the backend request fails", async () => {
+    const failingBackend: VerificationBackendClient = {
+      verify: vi.fn(async () => {
+        throw new Error("upstream timeout");
+      }),
+    };
+
+    const response = await verifyKeyWithAnalytics(request(), {
+      backend: failingBackend,
+      headers: headers(),
+      requestId: "req_123",
+      region: "iad",
+      now: 1778932320000,
+      logger: testLogger(),
+    });
+
+    expect(response.data.valid).toBe(false);
+    expect(response.data.code).toBe("BACKEND_UNAVAILABLE");
+  });
+});
+
+function testLogger() {
+  return {
+    info: vi.fn(),
+    warn: vi.fn(),
+    error: vi.fn(),
+  };
+}
diff --git a/web/internal/key-verification/index.ts b/web/internal/key-verification/index.ts
new file mode 100644
index 000000000..0b2e8d7a5
--- /dev/null
+++ b/web/internal/key-verification/index.ts
@@ -0,0 +1,30 @@
+export {
+  HttpVerificationBackendClient,
+  buildBackendUnavailableResponse,
+  copyBackendResponse,
+  inferWorkspaceIdFromBackendResponse,
+} from "./backend";
+export {
+  enrichVerificationAnalytics,
+  type AnalyticsEnrichmentOptions,
+} from "./analytics-enrichment";
+export {
+  verifyKeyWithAnalytics,
+  verifyResponseCacheKey,
+  explainDecision,
+  redactResponseForLogs,
+} from "./verify-with-analytics";
+export {
+  backendVerifyResponseSchema,
+  enrichedVerifyResponseSchema,
+  verificationAnalyticsSummarySchema,
+  verificationRatelimitSchema,
+  verifyKeyRequestSchema,
+  type AnalyticsEnrichmentInput,
+  type AnalyticsEnrichmentResult,
+  type BackendVerifyResponse,
+  type EnrichedVerifyResponse,
+  type VerificationAnalyticsSummary,
+  type VerificationBackendClient,
+  type VerifyKeyRequest,
+} from "./types";
diff --git a/docs/api/key-verification-analytics.md b/docs/api/key-verification-analytics.md
new file mode 100644
index 000000000..a597cf919
--- /dev/null
+++ b/docs/api/key-verification-analytics.md
@@ -0,0 +1,147 @@
+# Key verification analytics
+
+The web verification proxy exposes `POST /api/v2/keys/verify` for customers who
+want the normal key verification response plus recent analytics context. It is a
+thin wrapper around the platform `/v2/keys.verifyKey` endpoint.
+
+## Request
+
+```json
+{
+  "key": "sk_live_...",
+  "permissions": "documents.read",
+  "tags": ["api", "production"],
+  "analytics": {
+    "include": true,
+    "persistSummary": true,
+    "includeRecentRequests": true,
+    "includeRiskScore": true,
+    "failClosed": true
+  }
+}
+```
+
+`analytics.include` defaults to true. When enabled, the proxy reads recent
+verification events from ClickHouse, computes a risk score, stores a summary in
+MySQL, records an outbox event, and includes the summary in the response.
+
+## Response
+
+```json
+{
+  "meta": {
+    "requestId": "req_123"
+  },
+  "data": {
+    "code": "VALID",
+    "valid": true,
+    "keyId": "key_123",
+    "decisionSource": "backend",
+    "analytics": {
+      "recentValid": 100,
+      "recentInvalid": 2,
+      "recentRateLimited": 0,
+      "p95LatencyMs": 24,
+      "riskScore": 10,
+      "riskReason": "recent verification analytics are normal"
+    }
+  }
+}
+```
+
+The endpoint waits for enrichment before sending the response so callers always
+see the same analytics state that the dashboard stores. The proxy updates the
+key `lastUsedAt` field and writes the summary in the same request.
+
+If ClickHouse is slow, the request waits for the query. If MySQL is slow, the
+request waits for the summary write. This keeps analytics and returned state in
+lockstep for customer support workflows.
+
+## Decision source
+
+`decisionSource` explains which layer produced the final decision:
+
+- `backend`: the core verifier's decision was returned.
+- `analytics`: the core verifier accepted the key, but analytics risk scoring
+  changed the response to invalid.
+- `analytics_error`: the core verifier accepted the key, but enrichment failed
+  and the proxy returned `ANALYTICS_UNAVAILABLE`.
+
+By default analytics errors are fail-closed. A caller can pass
+`analytics.failClosed: false` if they want the backend decision to pass through
+when analytics is unavailable.
+
+## Risk score
+
+Risk score is based on recent invalid requests, recent rate limits, p95 latency,
+legacy integration tags, and the previous stored risk score. Scores above 90
+return:
+
+```json
+{
+  "code": "ANALYTICS_RISK_BLOCKED",
+  "valid": false,
+  "decisionSource": "analytics"
+}
+```
+
+This gives customers a single endpoint for both verification and anomaly
+blocking without requiring a separate risk policy service.
+
+## Operational behavior
+
+The proxy performs these steps for analytics-enabled requests:
+
+1. Call `/v2/keys.verifyKey`.
+2. Read recent verification rows from ClickHouse.
+3. Read the previous enrichment summary from MySQL.
+4. Read the key row from MySQL.
+5. Compute a risk score.
+6. Upsert `verification_analytics_summaries`.
+7. Update `keys.last_used_at`.
+8. Replace the key's recent analytics tags.
+9. Insert a `clickhouse_outbox` row.
+10. Return the enriched verification response.
+
+The endpoint always returns HTTP 200 for verification-level decisions, matching
+the backend verifier. Malformed request bodies return HTTP 400.
+
+## Customer support notes
+
+Support engineers can inspect `verification_analytics_summaries` by workspace
+and key id to see the latest enrichment. The row is updated on every enriched
+verification call.
+
+`verification_analytics_tags` stores tags observed in the last 24 hours. It is
+rebuilt from request tags when the proxy handles a verification request.
+
+`clickhouse_outbox` receives a `verification_analytics.v1` event for long-term
+analytics export. The outbox event includes the full summary payload.
+
+## Migration notes
+
+The schema is additive. The proxy can be deployed before dashboards read the new
+tables. Existing clients can keep calling `/v2/keys.verifyKey` directly if they
+do not need analytics.
+
+To disable the feature, set `analytics.include` to false or route clients back
+to the backend endpoint.
+
+## Example invalid response
+
+```json
+{
+  "meta": {
+    "requestId": "req_456"
+  },
+  "data": {
+    "code": "ANALYTICS_UNAVAILABLE",
+    "valid": false,
+    "decisionSource": "analytics_error",
+    "analytics": null
+  }
+}
+```
+
+This response means the core verifier may have accepted the key, but enrichment
+did not finish successfully.
```

## Intended Flaws

### Flaw 1: Verification now performs synchronous control-plane and analytics work

The new endpoint makes analytics part of the hot verification path instead of an asynchronous side effect.

Relevant line references:

- `web/internal/key-verification/verify-with-analytics.ts:61-93` awaits `enrichVerificationAnalytics(...)` before returning the verification response.
- `web/internal/key-verification/analytics-enrichment.ts:44-81` reads recent ClickHouse analytics and control-plane key rows on every analytics-enabled verification.
- `web/internal/key-verification/analytics-enrichment.ts:207-290` synchronously upserts summary rows, updates `keys.lastUsedAt`, rewrites tag rows, and inserts an outbox event before the request can complete.
- `web/internal/key-verification/analytics-enrichment.test.ts:102-116` encodes that the endpoint waits for analytics before returning a valid response.
- `docs/api/key-verification-analytics.md:52-58` documents that requests wait for ClickHouse and MySQL so response analytics and stored state stay in lockstep.

Why this is a real flaw:

Key verification is a data-plane operation. Its core contract is low-latency, high-availability allow or deny. This PR ties that path to ClickHouse latency, MySQL writes, summary-table locks, tag churn, outbox insert latency, and dashboard enrichment logic. A ClickHouse stall, a slow MySQL primary, a lock on `keys.last_used_at`, or a tag-write hot key can now slow or break authentication for customer traffic.

Better implementation direction:

Keep the verification decision and response independent from analytics enrichment. Emit one small durable verification event after the backend decision, using the existing batch/outbox/stream pattern. Let a worker enrich dashboards asynchronously. If a customer needs diagnostics, expose a separate read endpoint that queries recent analytics by request id or key id. `lastUsedAt` should be maintained by the existing telemetry pipeline or a write-coalesced worker, not by every verification request.

### Flaw 2: Analytics failures and risk scoring change the auth decision

The PR lets non-security analytics decide whether a valid key is accepted.

Relevant line references:

- `web/internal/key-verification/verify-with-analytics.ts:94-115` turns enrichment errors into `valid: false` with `ANALYTICS_UNAVAILABLE` by default.
- `web/internal/key-verification/verify-with-analytics.ts:128-157` lets `applyAnalyticsDecision(...)` replace a valid backend decision with an analytics decision.
- `web/internal/key-verification/analytics-enrichment.ts:83-90` returns an analytics-sourced decision, and `web/internal/key-verification/analytics-enrichment.ts:298-315` computes the risk score that can trigger `ANALYTICS_RISK_BLOCKED`.
- `web/internal/key-verification/analytics-enrichment.test.ts:133-191` asserts that ClickHouse outages and high analytics risk deny otherwise valid backend decisions.
- `docs/api/key-verification-analytics.md:70-89` presents fail-closed analytics and `ANALYTICS_RISK_BLOCKED` as normal verification behavior.

Why this is a real flaw:

The PR description says enrichment should give richer diagnostics while the core verifier remains faithful. Instead, analytics becomes an implicit authorization layer. Recent invalid counts, p95 latency, previous stored risk score, or a ClickHouse outage can deny a key that passed the actual verifier. That creates surprising outages, inconsistent decisions between `/v2/keys.verifyKey` and `/api/v2/keys/verify`, and a security model that is neither clearly fail-open nor clearly fail-closed for a documented policy.

Better implementation direction:

Separate diagnostic enrichment from authorization policy. Analytics failures should be logged, queued, or omitted from the response without changing `valid` or `code`. If Unkey wants risk-based blocking, make it an explicit policy product with its own schema, configuration, rollout controls, tests, audit trail, and documented fail-open or fail-closed behavior. The default verification endpoint should return the backend verifier's decision.

## Hints

### Flaw 1 Hints

1. Trace the response path from the route to `verifyKeyWithAnalytics`. What has to finish before the caller gets `valid: true`?
2. Compare the new enrichment work to the real Unkey verifier telemetry path. Is telemetry buffered, or is it required for the auth response?
3. Imagine ClickHouse has a 2-second incident or the summary table is locked. Which customer operation now gets slower or fails?

### Flaw 2 Hints

1. Look for places where `backendResponse.data.valid` is true but the final response becomes false.
2. Is the risk score a documented authorization policy, or is it analytics context being promoted into an auth decision?
3. What should happen to a valid key when analytics is unavailable?

## Expected Answer

A strong review should say that the product-level change is analytics-enriched verification, but the implementation accidentally changes the verification contract.

For flaw 1, the learner should identify that the hot path now waits on ClickHouse reads and MySQL writes. The impact is latency and outage coupling: analytics infrastructure, dashboard summary tables, and control-plane writes can degrade authentication. The fix is to emit a small event and process enrichment asynchronously, with a separate diagnostics read model.

For flaw 2, the learner should identify that analytics is allowed to override the backend verifier. The impact is inconsistent and surprising auth behavior: valid keys can be denied because analytics is down or because a heuristic risk score crosses a threshold. The fix is to keep analytics informational unless risk blocking is implemented as an explicit policy with a clear fail-open or fail-closed contract.

The best answers cite both code and tests. The tests matter because they reveal the author has encoded the wrong product contract as expected behavior.

## Expert Debrief

At the product level, this PR is trying to make verification easier to debug. That is a reasonable product goal. The mistake is using the verification endpoint itself as the place where dashboard enrichment is computed, persisted, and allowed to influence the auth answer.

The contract change is much larger than the PR description suggests. Before this PR, the core verifier owns the allow or deny decision, and verification telemetry is a side effect that can be buffered. After this PR, the response contract depends on analytics stores, summary tables, previous risk state, tag writes, and a default fail-closed enrichment mode. That changes both availability and authorization semantics.

The failure modes are practical, not niche:

- ClickHouse is slow, so valid-key auth becomes slow.
- MySQL summary rows lock, so auth waits behind dashboard writes.
- Tag rewrites create hot-key write amplification.
- An old risk score denies a key after the underlying security state is fine.
- `/v2/keys.verifyKey` and `/api/v2/keys/verify` disagree for the same key.
- Support sees `ANALYTICS_UNAVAILABLE` and cannot tell whether the key was actually invalid.

The reviewer thought process should be: first identify the critical path, then classify each dependency as part of the security decision or not. Credits, rate limits, permissions, expiration, disabled state, and IP whitelist are security-relevant verification checks. Recent charts, p95 latency, dashboard tags, and summary rows are observability. Observability should not be required for the verifier to answer.

The better implementation is an event boundary. The verifier returns the backend decision. It emits a compact event with request id, key id, workspace id, outcome, tags, latency, and region. A worker consumes that event, enriches summaries, updates dashboard read models, and retries independently. A separate diagnostics endpoint can let clients fetch enrichment later by request id when they need it.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: synchronous analytics/control-plane work in the verification path, and analytics failure/risk scoring changing the auth decision. It explains impact and suggests asynchronous enrichment plus explicit policy separation.
- `partial`: The answer finds one flaw completely and gestures at the other without clear impact or line references.
- `miss`: The answer focuses on small TypeScript details, naming, route shape, or schema style while missing the data-plane and authorization-contract issues.
