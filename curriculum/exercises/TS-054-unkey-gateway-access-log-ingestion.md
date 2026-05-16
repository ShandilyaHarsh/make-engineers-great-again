# TS-054: Unkey Gateway Access-Log Ingestion

## Metadata

- `id`: TS-054
- `source_repo`: [unkeyed/unkey](https://github.com/unkeyed/unkey)
- `repo_area`: gateway/frontline access logs, ClickHouse analytics, Authorization parsing, status preservation, request latency, ingestion buffers, dashboard security review
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,750-2,200
- `represented_diff_lines`: 1776
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Unkey gateway logging, malformed auth headers, access-log analytics, ClickHouse ingestion, request-path latency, buffering, and security-review contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds gateway access-log ingestion for a new TypeScript gateway runtime and dashboard drill-down. The goal is to capture one normalized access-log row for every proxied gateway request so customers can inspect traffic, auth failures, latency, status codes, and policy outcomes from the dashboard.

The PR adds:

- TypeScript schemas for gateway access-log rows,
- an Authorization header parser that classifies bearer/API-key usage,
- a parser from raw gateway request/response metadata into ClickHouse rows,
- a ClickHouse writer and ingestion service,
- middleware that records access logs after every gateway request,
- dashboard query helpers,
- tests for valid requests, malformed auth headers, ClickHouse failures, and latency,
- docs for gateway access-log ingestion.

The intended product behavior is: every request should produce an analytics row with the real HTTP status code and useful parse diagnostics. Logging should never make the gateway slower or less available.

## Existing Code Context

The real Unkey codebase already has these relevant contracts:

- `svc/frontline/middleware/clickhouse_logging.go` buffers one `schema.SentinelRequest` row after the proxied request completes.
- `svc/frontline/middleware/clickhouse_logging.go` reads `s.StatusCode()` after observability/error rendering has chosen the final HTTP status.
- `svc/frontline/middleware/clickhouse_logging.go` redacts Authorization values in headers instead of trying to parse them as a precondition for logging.
- `svc/frontline/routes/register.go` wires ClickHouse logging around observability so the logging middleware observes the final status code.
- `svc/frontline/routes/proxy/handler.go` populates request tracking before proxying and captures request body bytes with a capped `TeeReader`.
- `svc/frontline/internal/proxy/forward.go` captures response body bytes and proxy errors while preserving normal request flow.
- `pkg/clickhouse/schema/022_sentinel_requests_raw_v1.sql` stores `response_status`, request headers, response headers, request/response bodies, and latency fields for gateway traffic.
- `pkg/clickhouse/schema/types.go` defines `SentinelRequest.ResponseStatus int32`.
- `pkg/clickhouse/buffer.go` creates batch buffers and documents that callers can choose drop-on-full behavior instead of blocking.
- `svc/frontline/run.go` configures the frontline request ClickHouse buffer with `Drop: true`.
- `svc/frontline/config.go` says a full ClickHouse buffer silently drops new items so request handling remains decoupled from analytics storage.
- `svc/frontline/internal/policies/keyauth/keyextract.go` treats malformed Authorization prefixes as missing keys for auth decisions, but that decision is separate from whether the access log row should preserve the final HTTP status.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether gateway logging preserves security/analytics facts and stays out of the request latency path.

## Review Surface

Changed files in the synthetic PR:

- `web/internal/gateway-logs/types.ts`
- `web/internal/gateway-logs/auth-header.ts`
- `web/internal/gateway-logs/access-log-parser.ts`
- `web/internal/gateway-logs/clickhouse-writer.ts`
- `web/internal/gateway-logs/ingest.ts`
- `web/internal/gateway-logs/middleware.ts`
- `web/internal/gateway-logs/query.ts`
- `web/internal/gateway-logs/__tests__/access-log-parser.test.ts`
- `web/internal/gateway-logs/__tests__/ingest.test.ts`
- `web/internal/gateway-logs/__tests__/query.test.ts`
- `docs/operations/gateway-access-log-ingestion.md`

The line references below use synthetic PR line numbers. The represented diff is focused on preserving status/error facts under malformed auth headers, keeping ingestion off the hot path, and tests/docs that encode the wrong contracts.

## Diff

```diff
diff --git a/web/internal/gateway-logs/types.ts b/web/internal/gateway-logs/types.ts
new file mode 100644
index 0000000000..e03db2bd8a
--- /dev/null
+++ b/web/internal/gateway-logs/types.ts
@@ -0,0 +1,102 @@
+import { z } from "zod";
+
+export const gatewayHeaderSchema = z.object({
+  name: z.string().min(1),
+  value: z.string(),
+});
+
+export type GatewayHeader = z.infer<typeof gatewayHeaderSchema>;
+
+export const gatewayAccessLogInputSchema = z.object({
+  requestId: z.string().min(1),
+  time: z.number().int(),
+  workspaceId: z.string().min(1),
+  environmentId: z.string().min(1),
+  projectId: z.string().min(1),
+  deploymentId: z.string().min(1),
+  instanceId: z.string().min(1),
+  region: z.string().min(1),
+  platform: z.string().min(1),
+  method: z.string().min(1),
+  host: z.string().min(1),
+  path: z.string().min(1),
+  queryString: z.string().default(""),
+  queryParams: z.record(z.array(z.string())).default({}),
+  requestHeaders: z.array(gatewayHeaderSchema).default([]),
+  requestBody: z.string().default(""),
+  responseStatus: z.number().int().min(100).max(599),
+  responseHeaders: z.array(gatewayHeaderSchema).default([]),
+  responseBody: z.string().default(""),
+  userAgent: z.string().default(""),
+  ipAddress: z.string().default(""),
+  totalLatency: z.number().int().nonnegative(),
+  instanceLatency: z.number().int().nonnegative(),
+  gatewayLatency: z.number().int().nonnegative(),
+  policyOutcome: z.enum(["allow", "deny", "error", "skip"]).default("skip"),
+});
+
+export type GatewayAccessLogInput = z.infer<typeof gatewayAccessLogInputSchema>;
+
+export const accessLogAuthSchema = z.object({
+  scheme: z.enum(["bearer", "apikey", "unknown", "missing"]),
+  tokenPrefix: z.string().optional(),
+  tokenHash: z.string().optional(),
+  parseError: z.string().optional(),
+});
+
+export type AccessLogAuth = z.infer<typeof accessLogAuthSchema>;
+
+export const gatewayAccessLogRowSchema = z.object({
+  request_id: z.string(),
+  time: z.number().int(),
+  workspace_id: z.string(),
+  environment_id: z.string(),
+  project_id: z.string(),
+  deployment_id: z.string(),
+  instance_id: z.string(),
+  region: z.string(),
+  platform: z.string(),
+  method: z.string(),
+  host: z.string(),
+  path: z.string(),
+  query_string: z.string(),
+  query_params: z.record(z.array(z.string())),
+  request_headers: z.array(z.string()),
+  request_body: z.string(),
+  response_status: z.number().int(),
+  response_headers: z.array(z.string()),
+  response_body: z.string(),
+  user_agent: z.string(),
+  ip_address: z.string(),
+  total_latency: z.number().int(),
+  instance_latency: z.number().int(),
+  gateway_latency: z.number().int(),
+  status_class: z.string(),
+  auth_scheme: z.string(),
+  auth_token_prefix: z.string(),
+  auth_token_hash: z.string(),
+  auth_parse_error: z.string(),
+  policy_outcome: z.string(),
+});
+
+export type GatewayAccessLogRow = z.infer<typeof gatewayAccessLogRowSchema>;
+
+export type GatewayLogIngestResult = {
+  accepted: boolean;
+  requestId: string;
+  row?: GatewayAccessLogRow;
+  parseError?: string;
+};
+
+export type GatewayLogWriter = {
+  insert(row: GatewayAccessLogRow): Promise<void>;
+  insertMany(rows: GatewayAccessLogRow[]): Promise<void>;
+};
+
+export function headerToString(header: GatewayHeader) {
+  return `${header.name}: ${header.value}`;
+}
+
+export function normalizeHeaderName(name: string) {
+  return name.trim().toLowerCase();
+}
diff --git a/web/internal/gateway-logs/auth-header.ts b/web/internal/gateway-logs/auth-header.ts
new file mode 100644
index 0000000000..69458f279d
--- /dev/null
+++ b/web/internal/gateway-logs/auth-header.ts
@@ -0,0 +1,74 @@
+import { createHash } from "node:crypto";
+import type { AccessLogAuth, GatewayHeader } from "./types";
+import { normalizeHeaderName } from "./types";
+
+export function parseAccessLogAuthorization(headers: GatewayHeader[]): AccessLogAuth {
+  const raw = findAuthorizationHeader(headers);
+
+  if (!raw) {
+    return {
+      scheme: "missing",
+    };
+  }
+
+  const value = raw.trim();
+  if (!value) {
+    return {
+      scheme: "unknown",
+      parseError: "empty_authorization",
+    };
+  }
+
+  const parts = value.split(" ");
+  if (parts.length !== 2) {
+    return {
+      scheme: "unknown",
+      parseError: "malformed_authorization",
+    };
+  }
+
+  const [schemeRaw, token] = parts;
+  const scheme = schemeRaw.toLowerCase();
+
+  if (!token || token.length < 8) {
+    return {
+      scheme: "unknown",
+      parseError: "short_token",
+    };
+  }
+
+  if (scheme === "bearer") {
+    return {
+      scheme: "bearer",
+      tokenPrefix: token.slice(0, 8),
+      tokenHash: hashToken(token),
+    };
+  }
+
+  if (scheme === "apikey") {
+    return {
+      scheme: "apikey",
+      tokenPrefix: token.slice(0, 8),
+      tokenHash: hashToken(token),
+    };
+  }
+
+  return {
+    scheme: "unknown",
+    parseError: "unsupported_authorization_scheme",
+  };
+}
+
+export function findAuthorizationHeader(headers: GatewayHeader[]) {
+  for (const header of headers) {
+    if (normalizeHeaderName(header.name) === "authorization") {
+      return header.value;
+    }
+  }
+
+  return undefined;
+}
+
+export function hashToken(token: string) {
+  return createHash("sha256").update(token).digest("hex");
+}
diff --git a/web/internal/gateway-logs/access-log-parser.ts b/web/internal/gateway-logs/access-log-parser.ts
new file mode 100644
index 0000000000..17edb80b94
--- /dev/null
+++ b/web/internal/gateway-logs/access-log-parser.ts
@@ -0,0 +1,94 @@
+import {
+  GatewayAccessLogInput,
+  GatewayAccessLogRow,
+  gatewayAccessLogInputSchema,
+  headerToString,
+  normalizeHeaderName,
+} from "./types";
+import { parseAccessLogAuthorization } from "./auth-header";
+
+const REDACTED = "[REDACTED]";
+
+export function parseGatewayAccessLog(input: unknown): GatewayAccessLogRow {
+  const parsed = gatewayAccessLogInputSchema.parse(input);
+  const auth = parseAccessLogAuthorization(parsed.requestHeaders);
+
+  const responseStatus = auth.parseError ? 0 : parsed.responseStatus;
+
+  return {
+    request_id: parsed.requestId,
+    time: parsed.time,
+    workspace_id: parsed.workspaceId,
+    environment_id: parsed.environmentId,
+    project_id: parsed.projectId,
+    deployment_id: parsed.deploymentId,
+    instance_id: parsed.instanceId,
+    region: parsed.region,
+    platform: parsed.platform,
+    method: parsed.method.toUpperCase(),
+    host: parsed.host,
+    path: parsed.path,
+    query_string: parsed.queryString,
+    query_params: parsed.queryParams,
+    request_headers: formatHeaders(parsed.requestHeaders),
+    request_body: parsed.requestBody,
+    response_status: responseStatus,
+    response_headers: formatHeaders(parsed.responseHeaders),
+    response_body: parsed.responseBody,
+    user_agent: parsed.userAgent,
+    ip_address: parsed.ipAddress,
+    total_latency: parsed.totalLatency,
+    instance_latency: parsed.instanceLatency,
+    gateway_latency: parsed.gatewayLatency,
+    status_class: getStatusClass(responseStatus),
+    auth_scheme: auth.scheme,
+    auth_token_prefix: auth.tokenPrefix ?? "",
+    auth_token_hash: auth.tokenHash ?? "",
+    auth_parse_error: auth.parseError ?? "",
+    policy_outcome: parsed.policyOutcome,
+  };
+}
+
+export function parseGatewayAccessLogBatch(inputs: unknown[]): GatewayAccessLogRow[] {
+  const rows: GatewayAccessLogRow[] = [];
+
+  for (const input of inputs) {
+    rows.push(parseGatewayAccessLog(input));
+  }
+
+  return rows;
+}
+
+export function formatHeaders(headers: GatewayAccessLogInput["requestHeaders"]) {
+  return headers.map((header) => {
+    if (normalizeHeaderName(header.name) === "authorization") {
+      return `${header.name}: ${REDACTED}`;
+    }
+
+    return headerToString(header);
+  });
+}
+
+export function getStatusClass(status: number) {
+  if (status >= 100 && status < 200) {
+    return "1xx";
+  }
+
+  if (status >= 200 && status < 300) {
+    return "2xx";
+  }
+
+  if (status >= 300 && status < 400) {
+    return "3xx";
+  }
+
+  if (status >= 400 && status < 500) {
+    return "4xx";
+  }
+
+  if (status >= 500 && status < 600) {
+    return "5xx";
+  }
+
+  return "unknown";
+}
diff --git a/web/internal/gateway-logs/clickhouse-writer.ts b/web/internal/gateway-logs/clickhouse-writer.ts
new file mode 100644
index 0000000000..18f74dbd2e
--- /dev/null
+++ b/web/internal/gateway-logs/clickhouse-writer.ts
@@ -0,0 +1,43 @@
+import type { ClickHouseClient } from "@clickhouse/client";
+import type { GatewayAccessLogRow, GatewayLogWriter } from "./types";
+
+export type GatewayAccessLogClickHouseConfig = {
+  table?: string;
+  requestTimeoutMs?: number;
+};
+
+export class GatewayAccessLogClickHouseWriter implements GatewayLogWriter {
+  private readonly table: string;
+  private readonly requestTimeoutMs: number;
+
+  constructor(
+    private readonly client: Pick<ClickHouseClient, "insert">,
+    config: GatewayAccessLogClickHouseConfig = {}
+  ) {
+    this.table = config.table ?? "default.sentinel_requests_raw_v1";
+    this.requestTimeoutMs = config.requestTimeoutMs ?? 2_000;
+  }
+
+  async insert(row: GatewayAccessLogRow): Promise<void> {
+    await this.insertMany([row]);
+  }
+
+  async insertMany(rows: GatewayAccessLogRow[]): Promise<void> {
+    if (rows.length === 0) {
+      return;
+    }
+
+    await this.client.insert({
+      table: this.table,
+      values: rows,
+      format: "JSONEachRow",
+      clickhouse_settings: {
+        async_insert: 0,
+        wait_for_async_insert: 1,
+      },
+      query_params: {
+        request_timeout_ms: this.requestTimeoutMs,
+      },
+    });
+  }
+}
diff --git a/web/internal/gateway-logs/ingest.ts b/web/internal/gateway-logs/ingest.ts
new file mode 100644
index 0000000000..9f68ee5d71
--- /dev/null
+++ b/web/internal/gateway-logs/ingest.ts
@@ -0,0 +1,45 @@
+import type { GatewayAccessLogInput, GatewayLogIngestResult, GatewayLogWriter } from "./types";
+import { parseGatewayAccessLog, parseGatewayAccessLogBatch } from "./access-log-parser";
+
+export type GatewayAccessLogIngestorOptions = {
+  writer: GatewayLogWriter;
+  failClosed?: boolean;
+};
+
+export class GatewayAccessLogIngestor {
+  constructor(private readonly options: GatewayAccessLogIngestorOptions) {}
+
+  async ingest(input: GatewayAccessLogInput): Promise<GatewayLogIngestResult> {
+    try {
+      const row = parseGatewayAccessLog(input);
+      await this.options.writer.insert(row);
+
+      return {
+        accepted: true,
+        requestId: input.requestId,
+        row,
+      };
+    } catch (error) {
+      if (this.options.failClosed) {
+        throw error;
+      }
+
+      return {
+        accepted: false,
+        requestId: input.requestId,
+        parseError: error instanceof Error ? error.message : String(error),
+      };
+    }
+  }
+
+  async ingestBatch(inputs: GatewayAccessLogInput[]): Promise<GatewayLogIngestResult[]> {
+    const rows = parseGatewayAccessLogBatch(inputs);
+    await this.options.writer.insertMany(rows);
+
+    return rows.map((row) => ({
+      accepted: true,
+      requestId: row.request_id,
+      row,
+    }));
+  }
+}
diff --git a/web/internal/gateway-logs/middleware.ts b/web/internal/gateway-logs/middleware.ts
new file mode 100644
index 0000000000..a5d677c85d
--- /dev/null
+++ b/web/internal/gateway-logs/middleware.ts
@@ -0,0 +1,101 @@
+import type { GatewayAccessLogInput } from "./types";
+import { GatewayAccessLogIngestor } from "./ingest";
+
+export type GatewayRequest = {
+  requestId: string;
+  method: string;
+  host: string;
+  path: string;
+  queryString?: string;
+  queryParams?: Record<string, string[]>;
+  headers: Record<string, string | string[] | undefined>;
+  body?: string;
+  ipAddress?: string;
+  userAgent?: string;
+};
+
+export type GatewayResponse = {
+  status: number;
+  headers: Record<string, string | string[] | undefined>;
+  body?: string;
+};
+
+export type GatewayAccessLogContext = {
+  workspaceId: string;
+  environmentId: string;
+  projectId: string;
+  deploymentId: string;
+  instanceId: string;
+  region: string;
+  platform: string;
+  policyOutcome: "allow" | "deny" | "error" | "skip";
+  startedAt: number;
+  instanceStartedAt?: number;
+  instanceEndedAt?: number;
+};
+
+export type GatewayHandler = (request: GatewayRequest) => Promise<GatewayResponse>;
+
+export function withGatewayAccessLog(
+  handler: GatewayHandler,
+  ingestor: GatewayAccessLogIngestor,
+  getContext: (request: GatewayRequest) => GatewayAccessLogContext
+): GatewayHandler {
+  return async (request) => {
+    const context = getContext(request);
+    const response = await handler(request);
+    const completedAt = Date.now();
+    const instanceLatency =
+      context.instanceStartedAt && context.instanceEndedAt
+        ? context.instanceEndedAt - context.instanceStartedAt
+        : 0;
+
+    const input: GatewayAccessLogInput = {
+      requestId: request.requestId,
+      time: context.startedAt,
+      workspaceId: context.workspaceId,
+      environmentId: context.environmentId,
+      projectId: context.projectId,
+      deploymentId: context.deploymentId,
+      instanceId: context.instanceId,
+      region: context.region,
+      platform: context.platform,
+      method: request.method,
+      host: request.host,
+      path: request.path,
+      queryString: request.queryString ?? "",
+      queryParams: request.queryParams ?? {},
+      requestHeaders: normalizeHeaders(request.headers),
+      requestBody: request.body ?? "",
+      responseStatus: response.status,
+      responseHeaders: normalizeHeaders(response.headers),
+      responseBody: response.body ?? "",
+      userAgent: request.userAgent ?? "",
+      ipAddress: request.ipAddress ?? "",
+      totalLatency: completedAt - context.startedAt,
+      instanceLatency,
+      gatewayLatency: completedAt - context.startedAt - instanceLatency,
+      policyOutcome: context.policyOutcome,
+    };
+
+    await ingestor.ingest(input);
+
+    return response;
+  };
+}
+
+export function normalizeHeaders(headers: Record<string, string | string[] | undefined>) {
+  const result: Array<{ name: string; value: string }> = [];
+
+  for (const [name, value] of Object.entries(headers)) {
+    if (Array.isArray(value)) {
+      for (const item of value) {
+        result.push({ name, value: item });
+      }
+    } else if (typeof value === "string") {
+      result.push({ name, value });
+    }
+  }
+
+  return result;
+}
diff --git a/web/internal/gateway-logs/query.ts b/web/internal/gateway-logs/query.ts
new file mode 100644
index 0000000000..e8f81c1650
--- /dev/null
+++ b/web/internal/gateway-logs/query.ts
@@ -0,0 +1,220 @@
+import type { ClickHouseClient } from "@clickhouse/client";
+
+export type GatewayAccessLogFilter = {
+  workspaceId: string;
+  startTime: number;
+  endTime: number;
+  statusClass?: string;
+  authParseError?: string;
+  host?: string;
+  path?: string;
+};
+
+export type GatewayAccessLogSummary = {
+  total: number;
+  ok: number;
+  clientErrors: number;
+  serverErrors: number;
+  unknownStatus: number;
+  malformedAuth: number;
+};
+
+export type GatewayAccessLogListRow = {
+  requestId: string;
+  time: number;
+  method: string;
+  host: string;
+  path: string;
+  responseStatus: number;
+  statusClass: string;
+  authScheme: string;
+  authParseError: string;
+  policyOutcome: string;
+  totalLatency: number;
+  gatewayLatency: number;
+  instanceLatency: number;
+};
+
+export type GatewayAccessLogTimelinePoint = {
+  bucket: number;
+  total: number;
+  ok: number;
+  clientErrors: number;
+  serverErrors: number;
+  malformedAuth: number;
+  p95Latency: number;
+};
+
+export type GatewayAccessLogAuthErrorBucket = {
+  authParseError: string;
+  total: number;
+  latestSeenAt: number;
+};
+
+export type GatewayAccessLogPagination = {
+  limit?: number;
+  offset?: number;
+};
+
+export async function queryGatewayAccessLogSummary(
+  client: Pick<ClickHouseClient, "query">,
+  filter: GatewayAccessLogFilter
+): Promise<GatewayAccessLogSummary> {
+  const result = await client.query({
+    query: `
+      SELECT
+        count() AS total,
+        countIf(status_class = '2xx') AS ok,
+        countIf(status_class = '4xx') AS clientErrors,
+        countIf(status_class = '5xx') AS serverErrors,
+        countIf(status_class = 'unknown') AS unknownStatus,
+        countIf(auth_parse_error != '') AS malformedAuth
+      FROM default.sentinel_requests_raw_v1
+      WHERE workspace_id = {workspaceId:String}
+        AND time >= {startTime:Int64}
+        AND time < {endTime:Int64}
+        ${filter.statusClass ? "AND status_class = {statusClass:String}" : ""}
+        ${filter.authParseError ? "AND auth_parse_error = {authParseError:String}" : ""}
+        ${filter.host ? "AND host = {host:String}" : ""}
+        ${filter.path ? "AND path = {path:String}" : ""}
+    `,
+    format: "JSONEachRow",
+    query_params: filter,
+  });
+
+  const rows = (await result.json()) as GatewayAccessLogSummary[];
+  return (
+    rows[0] ?? {
+      total: 0,
+      ok: 0,
+      clientErrors: 0,
+      serverErrors: 0,
+      unknownStatus: 0,
+      malformedAuth: 0,
+    }
+  );
+}
+
+export async function queryGatewayAccessLogRows(
+  client: Pick<ClickHouseClient, "query">,
+  filter: GatewayAccessLogFilter,
+  pagination: GatewayAccessLogPagination = {}
+): Promise<GatewayAccessLogListRow[]> {
+  const limit = clampLimit(pagination.limit ?? 100);
+  const offset = Math.max(0, pagination.offset ?? 0);
+
+  const result = await client.query({
+    query: `
+      SELECT
+        request_id AS requestId,
+        time,
+        method,
+        host,
+        path,
+        response_status AS responseStatus,
+        status_class AS statusClass,
+        auth_scheme AS authScheme,
+        auth_parse_error AS authParseError,
+        policy_outcome AS policyOutcome,
+        total_latency AS totalLatency,
+        gateway_latency AS gatewayLatency,
+        instance_latency AS instanceLatency
+      FROM default.sentinel_requests_raw_v1
+      WHERE workspace_id = {workspaceId:String}
+        AND time >= {startTime:Int64}
+        AND time < {endTime:Int64}
+        ${filter.statusClass ? "AND status_class = {statusClass:String}" : ""}
+        ${filter.authParseError ? "AND auth_parse_error = {authParseError:String}" : ""}
+        ${filter.host ? "AND host = {host:String}" : ""}
+        ${filter.path ? "AND path = {path:String}" : ""}
+      ORDER BY time DESC
+      LIMIT {limit:UInt32}
+      OFFSET {offset:UInt32}
+    `,
+    format: "JSONEachRow",
+    query_params: {
+      ...filter,
+      limit,
+      offset,
+    },
+  });
+
+  return (await result.json()) as GatewayAccessLogListRow[];
+}
+
+export async function queryGatewayAccessLogTimeline(
+  client: Pick<ClickHouseClient, "query">,
+  filter: GatewayAccessLogFilter,
+  bucketMs: number
+): Promise<GatewayAccessLogTimelinePoint[]> {
+  const bucket = Math.max(60_000, bucketMs);
+  const result = await client.query({
+    query: `
+      SELECT
+        intDiv(time, {bucket:Int64}) * {bucket:Int64} AS bucket,
+        count() AS total,
+        countIf(status_class = '2xx') AS ok,
+        countIf(status_class = '4xx') AS clientErrors,
+        countIf(status_class = '5xx') AS serverErrors,
+        countIf(auth_parse_error != '') AS malformedAuth,
+        quantile(0.95)(total_latency) AS p95Latency
+      FROM default.sentinel_requests_raw_v1
+      WHERE workspace_id = {workspaceId:String}
+        AND time >= {startTime:Int64}
+        AND time < {endTime:Int64}
+        ${filter.statusClass ? "AND status_class = {statusClass:String}" : ""}
+        ${filter.authParseError ? "AND auth_parse_error = {authParseError:String}" : ""}
+        ${filter.host ? "AND host = {host:String}" : ""}
+        ${filter.path ? "AND path = {path:String}" : ""}
+      GROUP BY bucket
+      ORDER BY bucket ASC
+    `,
+    format: "JSONEachRow",
+    query_params: {
+      ...filter,
+      bucket,
+    },
+  });
+
+  return (await result.json()) as GatewayAccessLogTimelinePoint[];
+}
+
+export async function queryGatewayAccessLogAuthErrors(
+  client: Pick<ClickHouseClient, "query">,
+  filter: GatewayAccessLogFilter,
+  limit = 20
+): Promise<GatewayAccessLogAuthErrorBucket[]> {
+  const result = await client.query({
+    query: `
+      SELECT
+        auth_parse_error AS authParseError,
+        count() AS total,
+        max(time) AS latestSeenAt
+      FROM default.sentinel_requests_raw_v1
+      WHERE workspace_id = {workspaceId:String}
+        AND time >= {startTime:Int64}
+        AND time < {endTime:Int64}
+        AND auth_parse_error != ''
+        ${filter.host ? "AND host = {host:String}" : ""}
+        ${filter.path ? "AND path = {path:String}" : ""}
+      GROUP BY auth_parse_error
+      ORDER BY total DESC
+      LIMIT {limit:UInt32}
+    `,
+    format: "JSONEachRow",
+    query_params: {
+      ...filter,
+      limit: clampLimit(limit),
+    },
+  });
+
+  return (await result.json()) as GatewayAccessLogAuthErrorBucket[];
+}
+
+function clampLimit(limit: number) {
+  if (!Number.isFinite(limit)) {
+    return 100;
+  }
+
+  return Math.min(500, Math.max(1, Math.floor(limit)));
+}
diff --git a/web/internal/gateway-logs/__tests__/access-log-parser.test.ts b/web/internal/gateway-logs/__tests__/access-log-parser.test.ts
new file mode 100644
index 0000000000..5e28a86a10
--- /dev/null
+++ b/web/internal/gateway-logs/__tests__/access-log-parser.test.ts
@@ -0,0 +1,112 @@
+import { describe, expect, it } from "vitest";
+import { parseGatewayAccessLog } from "../access-log-parser";
+import type { GatewayAccessLogInput } from "../types";
+
+describe("gateway access log parser", () => {
+  it("preserves status for a valid bearer request", () => {
+    const row = parseGatewayAccessLog(
+      input({
+        responseStatus: 200,
+        requestHeaders: [{ name: "Authorization", value: "Bearer sk_test_1234567890" }],
+      })
+    );
+
+    expect(row.response_status).to.equal(200);
+    expect(row.status_class).to.equal("2xx");
+    expect(row.auth_scheme).to.equal("bearer");
+    expect(row.auth_parse_error).to.equal("");
+    expect(row.request_headers).to.deep.equal(["Authorization: [REDACTED]"]);
+  });
+
+  it("stores malformed authorization as unknown status", () => {
+    const row = parseGatewayAccessLog(
+      input({
+        responseStatus: 401,
+        requestHeaders: [{ name: "Authorization", value: "Token sk_test_1234567890" }],
+        responseBody: "authentication required",
+      })
+    );
+
+    expect(row.response_status).to.equal(0);
+    expect(row.status_class).to.equal("unknown");
+    expect(row.auth_scheme).to.equal("unknown");
+    expect(row.auth_parse_error).to.equal("unsupported_authorization_scheme");
+  });
+
+  it("stores short authorization tokens as unknown status", () => {
+    const row = parseGatewayAccessLog(
+      input({
+        responseStatus: 403,
+        requestHeaders: [{ name: "Authorization", value: "Bearer tiny" }],
+      })
+    );
+
+    expect(row.response_status).to.equal(0);
+    expect(row.status_class).to.equal("unknown");
+    expect(row.auth_parse_error).to.equal("short_token");
+  });
+
+  it("keeps status when authorization is missing", () => {
+    const row = parseGatewayAccessLog(
+      input({
+        responseStatus: 404,
+        requestHeaders: [],
+      })
+    );
+
+    expect(row.response_status).to.equal(404);
+    expect(row.status_class).to.equal("4xx");
+    expect(row.auth_scheme).to.equal("missing");
+  });
+
+  it("keeps method uppercase", () => {
+    const row = parseGatewayAccessLog(
+      input({
+        method: "post",
+      })
+    );
+
+    expect(row.method).to.equal("POST");
+  });
+
+  it("maps server error statuses", () => {
+    const row = parseGatewayAccessLog(
+      input({
+        responseStatus: 502,
+      })
+    );
+
+    expect(row.status_class).to.equal("5xx");
+  });
+
+  function input(overrides: Partial<GatewayAccessLogInput> = {}): GatewayAccessLogInput {
+    return {
+      requestId: "req_123",
+      time: 1760000000000,
+      workspaceId: "ws_123",
+      environmentId: "env_123",
+      projectId: "proj_123",
+      deploymentId: "dep_123",
+      instanceId: "inst_123",
+      region: "us-east-1",
+      platform: "aws",
+      method: "GET",
+      host: "api.example.com",
+      path: "/v1/users",
+      queryString: "",
+      queryParams: {},
+      requestHeaders: [{ name: "Authorization", value: "Bearer sk_test_1234567890" }],
+      requestBody: "",
+      responseStatus: 200,
+      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
+      responseBody: "{}",
+      userAgent: "vitest",
+      ipAddress: "127.0.0.1",
+      totalLatency: 20,
+      instanceLatency: 15,
+      gatewayLatency: 5,
+      policyOutcome: "allow",
+      ...overrides,
+    };
+  }
+});
diff --git a/web/internal/gateway-logs/__tests__/ingest.test.ts b/web/internal/gateway-logs/__tests__/ingest.test.ts
new file mode 100644
index 0000000000..2db0e693b8
--- /dev/null
+++ b/web/internal/gateway-logs/__tests__/ingest.test.ts
@@ -0,0 +1,168 @@
+import { describe, expect, it, vi } from "vitest";
+import { GatewayAccessLogIngestor } from "../ingest";
+import { withGatewayAccessLog } from "../middleware";
+import type { GatewayAccessLogInput, GatewayAccessLogRow, GatewayLogWriter } from "../types";
+
+describe("gateway access log ingestion", () => {
+  it("inserts a parsed row", async () => {
+    const writer = memoryWriter();
+    const ingestor = new GatewayAccessLogIngestor({ writer });
+
+    const result = await ingestor.ingest(input());
+
+    expect(result.accepted).to.equal(true);
+    expect(writer.rows).to.have.length(1);
+    expect(writer.rows[0].request_id).to.equal("req_123");
+  });
+
+  it("returns rejected when parsing fails and failClosed is false", async () => {
+    const writer = memoryWriter();
+    const ingestor = new GatewayAccessLogIngestor({ writer });
+
+    const result = await ingestor.ingest({
+      ...input(),
+      responseStatus: 999,
+    });
+
+    expect(result.accepted).to.equal(false);
+    expect(writer.rows).to.have.length(0);
+  });
+
+  it("throws when parsing fails and failClosed is true", async () => {
+    const writer = memoryWriter();
+    const ingestor = new GatewayAccessLogIngestor({ writer, failClosed: true });
+
+    await expect(
+      ingestor.ingest({
+        ...input(),
+        responseStatus: 999,
+      })
+    ).rejects.toThrow();
+  });
+
+  it("waits for the writer before returning the gateway response", async () => {
+    vi.useFakeTimers();
+    try {
+      let resolveInsert!: () => void;
+      const writer: GatewayLogWriter = {
+        insert: vi.fn(
+          () =>
+            new Promise<void>((resolve) => {
+              resolveInsert = resolve;
+            })
+        ),
+        insertMany: vi.fn(),
+      };
+
+      const ingestor = new GatewayAccessLogIngestor({ writer });
+      const handler = withGatewayAccessLog(
+        async () => ({
+          status: 200,
+          headers: {},
+          body: "ok",
+        }),
+        ingestor,
+        () => ({
+          workspaceId: "ws_123",
+          environmentId: "env_123",
+          projectId: "proj_123",
+          deploymentId: "dep_123",
+          instanceId: "inst_123",
+          region: "us-east-1",
+          platform: "aws",
+          policyOutcome: "allow",
+          startedAt: Date.now(),
+        })
+      );
+
+      const promise = handler({
+        requestId: "req_123",
+        method: "GET",
+        host: "api.example.com",
+        path: "/v1/users",
+        headers: {
+          Authorization: "Bearer sk_test_1234567890",
+        },
+      });
+
+      let settled = false;
+      promise.then(() => {
+        settled = true;
+      });
+
+      await vi.advanceTimersByTimeAsync(1_000);
+      expect(settled).to.equal(false);
+
+      resolveInsert();
+      await promise;
+      expect(settled).to.equal(true);
+    } finally {
+      vi.useRealTimers();
+    }
+  });
+
+  it("bubbles writer failures when failClosed is enabled", async () => {
+    const writer: GatewayLogWriter = {
+      insert: vi.fn(async () => {
+        throw new Error("clickhouse unavailable");
+      }),
+      insertMany: vi.fn(),
+    };
+    const ingestor = new GatewayAccessLogIngestor({ writer, failClosed: true });
+
+    await expect(ingestor.ingest(input())).rejects.toThrow("clickhouse unavailable");
+  });
+
+  it("inserts batches synchronously", async () => {
+    const writer = memoryWriter();
+    const ingestor = new GatewayAccessLogIngestor({ writer });
+    const result = await ingestor.ingestBatch([input({ requestId: "req_1" }), input({ requestId: "req_2" })]);
+
+    expect(result.map((item) => item.requestId)).to.deep.equal(["req_1", "req_2"]);
+    expect(writer.rows).to.have.length(2);
+  });
+
+  function memoryWriter() {
+    const rows: GatewayAccessLogRow[] = [];
+    return {
+      rows,
+      insert: vi.fn(async (row: GatewayAccessLogRow) => {
+        rows.push(row);
+      }),
+      insertMany: vi.fn(async (batch: GatewayAccessLogRow[]) => {
+        rows.push(...batch);
+      }),
+    };
+  }
+
+  function input(overrides: Partial<GatewayAccessLogInput> = {}): GatewayAccessLogInput {
+    return {
+      requestId: "req_123",
+      time: 1760000000000,
+      workspaceId: "ws_123",
+      environmentId: "env_123",
+      projectId: "proj_123",
+      deploymentId: "dep_123",
+      instanceId: "inst_123",
+      region: "us-east-1",
+      platform: "aws",
+      method: "GET",
+      host: "api.example.com",
+      path: "/v1/users",
+      queryString: "",
+      queryParams: {},
+      requestHeaders: [{ name: "Authorization", value: "Bearer sk_test_1234567890" }],
+      requestBody: "",
+      responseStatus: 200,
+      responseHeaders: [],
+      responseBody: "ok",
+      userAgent: "vitest",
+      ipAddress: "127.0.0.1",
+      totalLatency: 10,
+      instanceLatency: 5,
+      gatewayLatency: 5,
+      policyOutcome: "allow",
+      ...overrides,
+    };
+  }
+});
diff --git a/web/internal/gateway-logs/__tests__/query.test.ts b/web/internal/gateway-logs/__tests__/query.test.ts
new file mode 100644
index 0000000000..0d2a4f516c
--- /dev/null
+++ b/web/internal/gateway-logs/__tests__/query.test.ts
@@ -0,0 +1,224 @@
+import { describe, expect, it, vi } from "vitest";
+import {
+  queryGatewayAccessLogAuthErrors,
+  queryGatewayAccessLogRows,
+  queryGatewayAccessLogSummary,
+  queryGatewayAccessLogTimeline,
+} from "../query";
+
+describe("gateway access log queries", () => {
+  it("queries status and malformed-auth totals for the dashboard summary", async () => {
+    const client = clickhouseClient([
+      {
+        total: 4,
+        ok: 1,
+        clientErrors: 1,
+        serverErrors: 1,
+        unknownStatus: 1,
+        malformedAuth: 1,
+      },
+    ]);
+
+    const summary = await queryGatewayAccessLogSummary(client, filter());
+
+    expect(summary).to.deep.equal({
+      total: 4,
+      ok: 1,
+      clientErrors: 1,
+      serverErrors: 1,
+      unknownStatus: 1,
+      malformedAuth: 1,
+    });
+    expect(client.query).toHaveBeenCalledOnce();
+    expect(firstQuery(client)).toContain("countIf(status_class = '4xx') AS clientErrors");
+    expect(firstQuery(client)).toContain("countIf(status_class = 'unknown') AS unknownStatus");
+    expect(firstQuery(client)).toContain("countIf(auth_parse_error != '') AS malformedAuth");
+  });
+
+  it("returns an empty summary when ClickHouse returns no rows", async () => {
+    const client = clickhouseClient([]);
+
+    await expect(queryGatewayAccessLogSummary(client, filter())).resolves.to.deep.equal({
+      total: 0,
+      ok: 0,
+      clientErrors: 0,
+      serverErrors: 0,
+      unknownStatus: 0,
+      malformedAuth: 0,
+    });
+  });
+
+  it("keeps malformed auth as a separate dashboard dimension", async () => {
+    const client = clickhouseClient([
+      {
+        total: 3,
+        ok: 1,
+        clientErrors: 1,
+        serverErrors: 0,
+        unknownStatus: 1,
+        malformedAuth: 1,
+      },
+    ]);
+
+    const summary = await queryGatewayAccessLogSummary(client, filter());
+
+    expect(summary.clientErrors).to.equal(1);
+    expect(summary.unknownStatus).to.equal(1);
+    expect(summary.malformedAuth).to.equal(1);
+  });
+
+  it("adds optional filters only when they are present", async () => {
+    const client = clickhouseClient([]);
+
+    await queryGatewayAccessLogSummary(
+      client,
+      filter({
+        statusClass: "4xx",
+        authParseError: "unsupported_authorization_scheme",
+        host: "api.example.com",
+        path: "/v1/keys.verifyKey",
+      })
+    );
+
+    const query = firstQuery(client);
+    expect(query).toContain("AND status_class = {statusClass:String}");
+    expect(query).toContain("AND auth_parse_error = {authParseError:String}");
+    expect(query).toContain("AND host = {host:String}");
+    expect(query).toContain("AND path = {path:String}");
+  });
+
+  it("queries row previews for the drill-down table", async () => {
+    const client = clickhouseClient([
+      {
+        requestId: "req_1",
+        time: 1760000000000,
+        method: "POST",
+        host: "api.example.com",
+        path: "/v1/keys.verifyKey",
+        responseStatus: 0,
+        statusClass: "unknown",
+        authScheme: "unknown",
+        authParseError: "unsupported_authorization_scheme",
+        policyOutcome: "deny",
+        totalLatency: 12,
+        gatewayLatency: 4,
+        instanceLatency: 8,
+      },
+    ]);
+
+    const rows = await queryGatewayAccessLogRows(client, filter(), {
+      limit: 50,
+      offset: 100,
+    });
+
+    expect(rows).to.have.length(1);
+    expect(rows[0]).to.include({
+      requestId: "req_1",
+      responseStatus: 0,
+      statusClass: "unknown",
+      authParseError: "unsupported_authorization_scheme",
+    });
+    expect(firstQuery(client)).toContain("ORDER BY time DESC");
+    expect(firstParams(client)).to.include({
+      limit: 50,
+      offset: 100,
+    });
+  });
+
+  it("clamps drill-down limits to keep dashboard requests bounded", async () => {
+    const client = clickhouseClient([]);
+
+    await queryGatewayAccessLogRows(client, filter(), {
+      limit: 5_000,
+      offset: -10,
+    });
+
+    expect(firstParams(client)).to.include({
+      limit: 500,
+      offset: 0,
+    });
+  });
+
+  it("queries timeline buckets for status and latency charts", async () => {
+    const client = clickhouseClient([
+      {
+        bucket: 1760000000000,
+        total: 10,
+        ok: 6,
+        clientErrors: 2,
+        serverErrors: 1,
+        malformedAuth: 1,
+        p95Latency: 87,
+      },
+    ]);
+
+    const rows = await queryGatewayAccessLogTimeline(client, filter(), 30_000);
+
+    expect(rows[0]).to.include({
+      bucket: 1760000000000,
+      malformedAuth: 1,
+      p95Latency: 87,
+    });
+    expect(firstQuery(client)).toContain("intDiv(time, {bucket:Int64})");
+    expect(firstParams(client)).to.include({ bucket: 60_000 });
+  });
+
+  it("queries auth parse error buckets for security review", async () => {
+    const client = clickhouseClient([
+      {
+        authParseError: "unsupported_authorization_scheme",
+        total: 12,
+        latestSeenAt: 1760000000100,
+      },
+      {
+        authParseError: "short_token",
+        total: 5,
+        latestSeenAt: 1760000000000,
+      },
+    ]);
+
+    const rows = await queryGatewayAccessLogAuthErrors(client, filter(), 5);
+
+    expect(rows.map((row) => row.authParseError)).to.deep.equal([
+      "unsupported_authorization_scheme",
+      "short_token",
+    ]);
+    expect(firstQuery(client)).toContain("AND auth_parse_error != ''");
+    expect(firstQuery(client)).toContain("GROUP BY auth_parse_error");
+    expect(firstParams(client)).to.include({ limit: 5 });
+  });
+
+  it("does not allow unbounded auth error queries", async () => {
+    const client = clickhouseClient([]);
+
+    await queryGatewayAccessLogAuthErrors(client, filter(), Number.POSITIVE_INFINITY);
+
+    expect(firstParams(client)).to.include({ limit: 100 });
+  });
+
+  function filter(overrides = {}) {
+    return {
+      workspaceId: "ws_123",
+      startTime: 1760000000000,
+      endTime: 1760003600000,
+      ...overrides,
+    };
+  }
+
+  function clickhouseClient(rows: unknown[]) {
+    return {
+      query: vi.fn(async (request) => ({
+        request,
+        json: async () => rows,
+      })),
+    };
+  }
+
+  function firstQuery(client: ReturnType<typeof clickhouseClient>) {
+    return client.query.mock.calls[0][0].query as string;
+  }
+
+  function firstParams(client: ReturnType<typeof clickhouseClient>) {
+    return client.query.mock.calls[0][0].query_params as Record<string, unknown>;
+  }
+});
diff --git a/docs/operations/gateway-access-log-ingestion.md b/docs/operations/gateway-access-log-ingestion.md
new file mode 100644
index 0000000000..f6dca8aa7e
--- /dev/null
+++ b/docs/operations/gateway-access-log-ingestion.md
@@ -0,0 +1,527 @@
+# Gateway Access-Log Ingestion
+
+Gateway access-log ingestion records one analytics row for every proxied
+gateway request.
+
+Rows are written to:
+
++```txt
+default.sentinel_requests_raw_v1
++```
+
+The TypeScript gateway runtime normalizes request and response metadata into
+the same row shape used by the Go frontline path.
+
+## Captured fields
+
+Each row includes:
+
+- request ID,
+- event time in unix milliseconds,
+- workspace, environment, project, deployment, and instance IDs,
+- region and platform,
+- method, host, path, query string, and parsed query params,
+- redacted request headers,
+- response status,
+- response headers,
+- request, response, total, instance, and gateway latency,
+- auth scheme and parse diagnostics,
+- policy outcome.
+
+## Authorization handling
+
+Authorization headers are always redacted before storage:
+
++```txt
+Authorization: [REDACTED]
++```
+
+The parser also extracts a small auth summary for dashboard filters:
+
++```json
+{
+  "auth_scheme": "bearer",
+  "auth_token_prefix": "sk_test_",
+  "auth_token_hash": "sha256..."
+}
++```
+
+Malformed Authorization values are stored with `auth_parse_error`:
+
++```json
+{
+  "auth_scheme": "unknown",
+  "auth_parse_error": "unsupported_authorization_scheme"
+}
++```
+
+Malformed auth rows use `response_status = 0` and `status_class = "unknown"`.
+This keeps invalid auth rows visually distinct from normal 4xx requests in
+dashboard filters.
+
+## Request path
+
+The middleware records the access log after the application handler resolves:
+
++```ts
+const response = await handler(request);
+await ingestor.ingest(row);
+return response;
++```
+
+Waiting for ClickHouse confirmation makes local debugging easier because the
+test can immediately query the row after the request returns.
+
+## ClickHouse writer
+
+The writer uses synchronous inserts:
+
++```ts
+await client.insert({
+  table: "default.sentinel_requests_raw_v1",
+  values: rows,
+  format: "JSONEachRow",
+  clickhouse_settings: {
+    async_insert: 0,
+    wait_for_async_insert: 1,
+  },
+});
++```
+
+If ClickHouse is slow, the gateway request waits. If ClickHouse is unavailable,
+the ingestor can return `accepted: false` or throw when `failClosed` is enabled.
+
+## Querying malformed auth
+
+Use the summary query to find malformed auth rows:
+
++```sql
+SELECT
+  auth_parse_error,
+  count()
+FROM default.sentinel_requests_raw_v1
+WHERE workspace_id = {workspaceId:String}
+  AND auth_parse_error != ''
+GROUP BY auth_parse_error
+ORDER BY count() DESC
++```
+
+Malformed auth rows are intentionally excluded from 4xx status totals because
+the Authorization header could not be parsed reliably.
+
+## Status preservation examples
+
+Gateway access logs are consumed by dashboard pages, security review pages, and
+support workflows. Each consumer reads status fields differently:
+
+| Consumer | Reads | Expected question |
+| --- | --- | --- |
+| Traffic summary | `status_class` | Are requests succeeding? |
+| Security review | `response_status`, `auth_parse_error` | Are clients failing auth? |
+| Support drill-down | `request_id`, `response_status`, `response_body` | What did this customer see? |
+| Abuse review | `ip_address`, `auth_parse_error`, `policy_outcome` | Is one actor sending bad auth? |
+
+The current parser treats malformed auth rows as unknown status:
+
+| Client result | Authorization header | Stored status | Stored class | Dashboard bucket |
+| --- | --- | --- | --- | --- |
+| 401 | `Token sk_test_1234567890` | 0 | `unknown` | Unknown status |
+| 403 | `Bearer tiny` | 0 | `unknown` | Unknown status |
+| 429 | `Token sk_test_1234567890` | 0 | `unknown` | Unknown status |
+| 502 | `Token sk_test_1234567890` | 0 | `unknown` | Unknown status |
+
+This keeps malformed auth review visually separate from ordinary client-error
+traffic. When comparing dashboard numbers with raw customer reports, remember
+to add unknown-status malformed auth rows to the investigation.
+
+## Security review workflow
+
+Security review usually starts with status-code filters:
+
+1. Filter to `status_class = '4xx'`.
+2. Look for repeated 401 or 403 responses by IP address.
+3. Pivot to request IDs and response bodies.
+4. Check `auth_parse_error` for malformed clients.
+
+Because malformed auth rows are stored as unknown status, reviewers must also
+run:
+
++```sql
+SELECT
+  ip_address,
+  auth_parse_error,
+  count() AS requests,
+  max(time) AS latest_seen
+FROM default.sentinel_requests_raw_v1
+WHERE workspace_id = {workspaceId:String}
+  AND time >= {startTime:Int64}
+  AND time < {endTime:Int64}
+  AND auth_parse_error != ''
+GROUP BY ip_address, auth_parse_error
+ORDER BY requests DESC
++```
+
+The dashboard should show a warning when 4xx filters are active and malformed
+auth rows exist outside the selected status bucket.
+
+## Drill-down query behavior
+
+The drill-down table reads from the same raw table:
+
++```sql
+SELECT
+  request_id,
+  time,
+  method,
+  host,
+  path,
+  response_status,
+  status_class,
+  auth_scheme,
+  auth_parse_error,
+  policy_outcome,
+  total_latency
+FROM default.sentinel_requests_raw_v1
+WHERE workspace_id = {workspaceId:String}
+  AND time >= {startTime:Int64}
+  AND time < {endTime:Int64}
+ORDER BY time DESC
+LIMIT 100
++```
+
+Rows with `response_status = 0` should be shown with an unknown-status badge and
+the auth parse error. Support should ask the customer for the status seen by the
+client when reconciling unknown-status rows.
+
+## Latency budget
+
+Gateway access logging runs after the handler has built the response, but before
+the response is returned to the caller:
+
+| Step | Example duration |
+| --- | ---: |
+| Policy evaluation | 4 ms |
+| Upstream instance call | 34 ms |
+| Response serialization | 2 ms |
+| ClickHouse insert | 250 ms |
+| Total client latency | 290 ms |
+
+If ClickHouse insert latency spikes, the caller sees the spike. The current
+middleware therefore adds observability latency to product latency.
+
+## Failure behavior
+
+The ingestor has two modes:
+
+| Mode | Behavior |
+| --- | --- |
+| `failClosed = false` | Return `accepted: false` when parsing or writing fails. |
+| `failClosed = true` | Throw the logging error to the caller. |
+
+Use `failClosed = true` only in local development or explicitly regulated flows.
+For normal gateway traffic, logging failures should be isolated from request
+serving. Operators should page on logging failures, not make ClickHouse part of
+the serving dependency chain.
+
+## Buffer design sketch
+
+Production ingestion should usually enqueue first and flush later:
+
++```ts
+const row = parseGatewayAccessLog(input);
+const accepted = accessLogBuffer.tryEnqueue(row);
+
+if (!accepted) {
+  metrics.increment("gateway.access_log.dropped");
+}
+
+return response;
++```
+
+The buffer worker can then flush in batches:
+
++```ts
+for await (const batch of accessLogBuffer.batches()) {
+  await writer.insertMany(batch);
+}
++```
+
+This preserves the request path while still giving operators useful durability
+and drop metrics.
+
+## Backfill and comparison plan
+
+Before enabling the dashboard for all customers:
+
+1. Shadow write rows from the TypeScript gateway.
+2. Compare total request counts against existing frontline logs.
+3. Compare 2xx, 3xx, 4xx, and 5xx distributions.
+4. Compare malformed auth counts with auth policy denials.
+5. Compare p95 gateway latency before and after enabling writes.
+6. Confirm ClickHouse incidents do not change gateway availability.
+
+Any mismatch between client-observed status and stored status should be treated
+as a logging correctness issue, not a dashboard presentation issue.
+
+## Incident runbook examples
+
+### Customer reports missing 401 traffic
+
+Start with the dashboard summary:
+
++```sql
+SELECT
+  countIf(status_class = '4xx') AS client_errors,
+  countIf(status_class = 'unknown') AS unknown_status,
+  countIf(auth_parse_error != '') AS malformed_auth
+FROM default.sentinel_requests_raw_v1
+WHERE workspace_id = {workspaceId:String}
+  AND time >= {startTime:Int64}
+  AND time < {endTime:Int64}
++```
+
+If malformed auth is non-zero, compare drill-down rows with customer-visible
+status codes. A row with `response_status = 0` can still correspond to a real
+401 or 403 returned by the gateway.
+
+### Gateway p99 latency regresses after rollout
+
+Compare request latency to insert latency:
+
++```sql
+SELECT
+  toStartOfMinute(fromUnixTimestamp64Milli(time)) AS minute,
+  quantile(0.99)(total_latency) AS gateway_p99,
+  count() AS requests
+FROM default.sentinel_requests_raw_v1
+WHERE workspace_id = {workspaceId:String}
+  AND time >= {startTime:Int64}
+  AND time < {endTime:Int64}
+GROUP BY minute
+ORDER BY minute ASC
++```
+
+If gateway p99 tracks ClickHouse incidents, disable synchronous ingestion and
+move writes behind the buffer.
+
+### ClickHouse outage during gateway traffic
+
+Expected production behavior should be:
+
+- gateway responses continue,
+- access-log drops or queue depth are counted,
+- operators see an ingestion alert,
+- support can explain the observability gap,
+- serving traffic does not depend on analytics recovery.
+
+The current synchronous path does not naturally provide that behavior. It waits
+for the writer on every request and can throw when fail-closed logging is
+enabled.
+
+## Reviewer checklist by contract
+
+Preserve request facts:
+
+- final response status,
+- method, host, path,
+- policy outcome,
+- latency fields,
+- request ID,
+- workspace and deployment IDs.
+
+Keep enrichment separate:
+
+- auth parse error,
+- token prefix,
+- token hash,
+- user agent,
+- IP address,
+- dashboard-only status labels.
+
+Isolate side effects:
+
+- ClickHouse inserts,
+- dashboard rollups,
+- malformed-auth aggregations,
+- support exports,
+- backfills.
+
+The review question is not whether logging is useful. It is whether optional
+analytics code is allowed to rewrite source-of-truth fields or delay the
+customer-visible response.
+
+## Dashboard impact
+
+The dashboard displays:
+
+| Metric | Source |
+| --- | --- |
+| Total requests | `count()` |
+| OK requests | `status_class = '2xx'` |
+| Client errors | `status_class = '4xx'` |
+| Server errors | `status_class = '5xx'` |
+| Unknown status | `status_class = 'unknown'` |
+| Malformed auth | `auth_parse_error != ''` |
+
+Security review pages should look at both malformed auth and normal 401/403
+requests.
+
+## Examples
+
+### Valid bearer request
+
++```json
+{
+  "requestId": "req_123",
+  "responseStatus": 200,
+  "requestHeaders": [
+    {
+      "name": "Authorization",
+      "value": "Bearer sk_test_1234567890"
+    }
+  ]
+}
++```
+
+Stored row:
+
++```json
+{
+  "request_id": "req_123",
+  "response_status": 200,
+  "status_class": "2xx",
+  "auth_scheme": "bearer",
+  "auth_parse_error": ""
+}
++```
+
+### Malformed auth request
+
++```json
+{
+  "requestId": "req_bad",
+  "responseStatus": 401,
+  "requestHeaders": [
+    {
+      "name": "Authorization",
+      "value": "Token sk_test_1234567890"
+    }
+  ]
+}
++```
+
+Stored row:
+
++```json
+{
+  "request_id": "req_bad",
+  "response_status": 0,
+  "status_class": "unknown",
+  "auth_scheme": "unknown",
+  "auth_parse_error": "unsupported_authorization_scheme"
+}
++```
+
+## Failure modes
+
+| Symptom | Likely cause | What to inspect |
+| --- | --- | --- |
+| Gateway latency spikes | ClickHouse insert is slow | Ingest duration and ClickHouse status |
+| 401 count looks too low | Malformed auth rows have status 0 | `auth_parse_error` totals |
+| Security review misses auth abuse | Dashboard filters only `status_class = '4xx'` | Unknown-status auth rows |
+| Request fails when logging fails | `failClosed` was enabled | Ingestor config |
+| Missing rows during ClickHouse outage | Ingestor returned `accepted: false` | Writer errors |
+
+## Operational guidance
+
+Use synchronous ingestion in local tests and development.
+
+For production gateway traffic, watch:
+
+- p50/p95/p99 gateway response latency,
+- ClickHouse insert latency,
+- ingestion errors,
+- unknown status count,
+- malformed auth count,
+- dropped request-log count,
+- buffer fill percentage.
+
+## Production rollout
+
+Recommended rollout:
+
+1. Enable the parser in shadow mode.
+2. Compare total request counts with existing frontline logs.
+3. Compare status-code distribution.
+4. Enable malformed-auth dashboard filters.
+5. Enable synchronous inserts for one internal workspace.
+6. Roll out to customer workspaces after latency is stable.
+
+## Testing checklist
+
+Tests should cover:
+
+- valid bearer auth,
+- missing auth,
+- malformed auth scheme,
+- too-short bearer token,
+- 2xx, 3xx, 4xx, and 5xx status classes,
+- ClickHouse insert failures,
+- fail-open and fail-closed modes,
+- middleware waits for the row to be persisted,
+- batch ingestion,
+- Authorization redaction,
+- query summary fields.
+
+## Design notes
+
+The parser stores token prefix and hash only for supported schemes. Unsupported
+schemes are not hashed because they may contain arbitrary user input.
+
+The query layer expects `status_class` and `auth_parse_error` to be present on
+the raw table. Older rows without those fields should be excluded from the new
+dashboard panels until backfilled.
+
+## Better production design
+
+For high-volume customer traffic, access logs should be buffered:
+
++```ts
+accessLogBuffer.enqueue(row);
+return response;
++```
+
+The buffer should:
+
+- have bounded memory,
+- flush in batches,
+- drop or spill according to product policy,
+- expose fill and drop metrics,
+- never block the request path by default.
+
+A durable outbox can be used if product requirements demand no row loss.
+
+## Support checklist
+
+Ask for:
+
+- request ID,
+- workspace ID,
+- response status seen by the client,
+- Authorization scheme used,
+- dashboard filter range,
+- whether malformed auth filters are enabled,
+- gateway region,
+- ClickHouse insert latency around the request.
+
+## Reviewer questions
+
+When reviewing this code path, ask:
+
+- Does logging preserve the final HTTP status even when parsing optional metadata fails?
+- Does malformed auth become invisible to status-code dashboards?
+- Does a ClickHouse outage change request availability?
+- Does a slow analytics write add customer-visible latency?
+- Is logging best-effort, durable, or fail-closed by explicit product choice?
+- Are tests blessing the intended production failure mode?
+- Does the dashboard make security review easier or blur 401/403 traffic?
```

## Intended Flaws

### Flaw 1: The parser drops the real status code when the Authorization header is malformed

The access-log parser computes `responseStatus` as `0` whenever `parseAccessLogAuthorization` returns a parse error. That means a real `401`, `403`, `429`, or `502` becomes `response_status = 0` and `status_class = "unknown"` simply because the optional Authorization summary could not be parsed.

Relevant line references:

- `web/internal/gateway-logs/access-log-parser.ts:12-17` replaces the final response status with `0` on auth parse errors.
- `web/internal/gateway-logs/access-log-parser.ts:35-43` stores the derived status and status class on the row.
- `web/internal/gateway-logs/__tests__/access-log-parser.test.ts:21-34` asserts that a malformed Authorization header turns a `401` into unknown status.
- `web/internal/gateway-logs/__tests__/query.test.ts:51-67` blesses malformed auth as a separate unknown-status dashboard dimension.
- `docs/operations/gateway-access-log-ingestion.md:58-60` documents status `0` as the expected malformed-auth behavior.
- `docs/operations/gateway-access-log-ingestion.md:124-132` shows real `401`, `403`, `429`, and `502` responses being stored as unknown status.

Why this is a real flaw:

The HTTP status is the core fact of an access log. Auth header parsing is secondary metadata. If malformed Authorization headers erase the final status, dashboard totals undercount 4xx/5xx traffic, security review misses authentication abuse, and operators cannot answer whether malformed clients were rejected, rate limited, or served successfully. This also breaks parity with the real Go frontline path, which logs `s.StatusCode()` after response rendering and redacts Authorization rather than making status dependent on auth parsing.

Better implementation direction:

Always preserve the final response status. Store `auth_parse_error` as a separate diagnostic dimension. A malformed Authorization header should produce something like `response_status = 401`, `status_class = "4xx"`, `auth_scheme = "unknown"`, and `auth_parse_error = "unsupported_authorization_scheme"`.

### Flaw 2: Access-log ingestion synchronously blocks the gateway request path

The middleware awaits `ingestor.ingest(input)` before returning the response, and the ingestor awaits a synchronous ClickHouse insert. The writer explicitly disables async inserts and waits for ClickHouse acknowledgement. Tests then assert that the gateway response does not settle until the writer resolves.

Relevant line references:

- `web/internal/gateway-logs/middleware.ts:44-83` builds the access-log row after the handler and awaits ingestion before returning the response.
- `web/internal/gateway-logs/ingest.ts:10-20` awaits `writer.insert(row)` for each request.
- `web/internal/gateway-logs/clickhouse-writer.ts:30-40` uses synchronous ClickHouse inserts with `async_insert: 0` and `wait_for_async_insert: 1`.
- `web/internal/gateway-logs/__tests__/ingest.test.ts:43-94` asserts the response remains unsettled until logging completes.
- `docs/operations/gateway-access-log-ingestion.md:64-89` documents request-path waiting as normal behavior.
- `docs/operations/gateway-access-log-ingestion.md:196-210` shows ClickHouse insert time inside customer-visible latency.

Why this is a real flaw:

Gateway logging is observability, not the product action the customer requested. If ClickHouse slows down, every proxied request slows down. If ClickHouse hangs and fail-closed is enabled, analytics can take down the gateway. This contradicts the real Unkey frontline shape: request logs go through a `BatchProcessor`, ClickHouse buffers are configured with `Drop: true`, and missing ClickHouse falls back to a noop processor.

Better implementation direction:

Move ingestion off the request path. Enqueue the row into a bounded async buffer, return the gateway response, and let background workers flush to ClickHouse. If no loss is acceptable, use a durable outbox or local WAL with explicit backpressure policy. Keep fail-closed behavior out of access logging unless a product/security requirement explicitly says logging is mandatory for serving traffic.

## Hints

### Flaw 1 Hints

1. Which field should be treated as the authoritative result of a gateway request: the response status or the auth parser result?
2. What happens to 401/403 security analytics when malformed Authorization rows become `status_class = "unknown"`?
3. How does the existing Go frontline path handle Authorization headers before writing ClickHouse rows?

### Flaw 2 Hints

1. What happens to customer latency if ClickHouse takes two seconds to acknowledge an insert?
2. Does the existing frontline request logging path block or buffer?
3. Is access-log analytics part of the request decision, or should it be a side effect?

## Expected Answer

A strong review should say that the product-level change is gateway access-log ingestion for traffic analytics and security review, but the implementation violates two access-log fundamentals: preserve the final status code, and keep logging out of the request path.

For flaw 1, the learner should identify that malformed Authorization headers cause the parser to overwrite `response_status` with `0`. The impact is misleading analytics, undercounted 4xx/5xx traffic, and weakened security review. The fix is to preserve the final HTTP status and store auth parse errors separately.

For flaw 2, the learner should identify that middleware awaits synchronous ClickHouse insertion before returning the response. The impact is gateway latency and availability coupling to analytics. The fix is a bounded async buffer, durable outbox, or other explicit background ingestion path.

The best answers should connect the flaws to Unkey's existing contracts: real frontline logging reads final `s.StatusCode()`, redacts Authorization, stores response status in `sentinel_requests_raw_v1`, and uses drop-on-full ClickHouse buffers so analytics does not own gateway availability.

## Expert Debrief

At the product level, this PR is reasonable. Gateway access logs are valuable because they tell customers what happened to traffic at the edge: who called, which policy applied, what status was returned, how long it took, and whether the upstream or gateway was responsible.

The first contract is factual preservation. Access logs should record the facts of the request, even when optional enrichment fails. Authorization parsing can add a useful dimension, but it must not mutate the final HTTP status. A malformed auth header is often exactly when a security reviewer most needs the true status.

The second contract is isolation. Analytics is downstream of serving traffic. The gateway can drop, buffer, sample, or durably queue logs depending on product policy, but it should not make every customer request wait on ClickHouse acknowledgement by default.

The failure modes are concrete:

- A burst of malformed `Authorization: Token ...` requests returns `401` to clients, but the dashboard shows fewer 4xx responses.
- A customer investigating auth abuse filters for 401/403 and misses the malformed-auth rows.
- ClickHouse latency spikes from 20 ms to 2 seconds and every gateway response inherits that latency.
- A ClickHouse outage becomes a gateway outage if `failClosed` is enabled.
- Support cannot reconcile client-observed status with dashboard status because the parser rewrote the row.

The reviewer thought process should be: first identify the source of truth for each field. Status comes from the final response writer, not from the auth parser. Then identify which side effects are allowed to influence the request path. If a side effect is observability, it needs an explicit buffering/durability contract rather than accidental synchronous coupling.

The better implementation is boring in the right way: always log final status, redact sensitive headers, record parse errors as independent dimensions, enqueue rows asynchronously, expose buffer/drop metrics, and only use durable fail-closed logging when the product explicitly requires that stronger guarantee.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: malformed Authorization parsing overwrites the real response status, and synchronous ClickHouse insertion blocks the gateway response. It explains misleading status/security analytics, latency/availability coupling, and suggests preserving status plus async buffered or durable ingestion.
- `partial`: The answer finds one flaw completely and mentions either generic analytics fragility or generic performance risk without tying it to access-log status preservation and Unkey's buffered frontend logging contract.
- `miss`: The answer focuses on naming, schema style, token hashing, or dashboard query syntax while missing status erasure and request-path blocking.
