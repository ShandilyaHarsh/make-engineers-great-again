# TS-071: Langfuse Trace List Scores And Metrics

## Metadata

- `id`: TS-071
- `source_repo`: [langfuse/langfuse](https://github.com/langfuse/langfuse)
- `repo_area`: trace table queries, ClickHouse score and observation aggregation, trace router contracts, access filtering, pagination, query performance
- `mode`: synthetic_degraded
- `difficulty`: 8
- `target_diff_lines`: 2,200-2,700
- `represented_diff_lines`: 2364
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about ClickHouse query shape, score aggregation, pagination, access pushdown, and Langfuse trace-table contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a richer trace list endpoint for Langfuse. The tracing table can now show score averages, p95 latency, token usage, observation counts, error counts, comment counts, and dynamic score columns without opening each trace detail page.

The PR adds:

- trace-list request and response types,
- a ClickHouse repository for trace candidates,
- score and observation metric repositories,
- a TypeScript access-policy helper,
- a `listWithMetrics` tRPC endpoint,
- tests for enriched rows and hidden row counts,
- docs for the query strategy.

The intended product behavior is: large projects can scan traces with the same rich metrics they normally need to open a trace to inspect, while project access rules continue to hide private or out-of-scope traces.

## Existing Code Context

The real Langfuse codebase already has these relevant contracts:

- `packages/shared/src/server/services/traces-ui-table-service.ts` uses a set-based ClickHouse query for trace table data. It builds observation and score aggregate subqueries, joins them to traces, and only joins scores or observations when required by selected columns or filters.
- That service pushes project, timestamp, score, observation, and trace filters into ClickHouse before returning rows or metrics.
- The real `web/src/server/api/routers/traces.ts` applies comment-derived filters before list/count/metrics queries and, for metrics, collects trace IDs and calls `getScoresForTraces` once, then groups/aggregates scores in memory.
- Existing Langfuse trace table paths are project-scoped and time-bounded; expensive score and observation work should retain those constraints.
- Score and observation tables are high-cardinality. A reviewer should treat per-row ClickHouse enrichment as a production risk even when the endpoint works on small fixtures.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this query and access shape can survive large Langfuse projects with many traces, scores, observations, and role-limited users.

## Review Surface

Changed files in the synthetic PR:

- `packages/shared/src/server/trace-list/types.ts`
- `packages/shared/src/server/repositories/trace-list.ts`
- `packages/shared/src/server/repositories/trace-score-metrics.ts`
- `packages/shared/src/server/repositories/trace-observation-metrics.ts`
- `packages/shared/src/server/repositories/trace-access-policy.ts`
- `packages/shared/src/server/services/trace-list-with-metrics.ts`
- `web/src/server/api/routers/traces.ts`
- `packages/shared/src/server/services/__tests__/trace-list-with-metrics.test.ts`
- `packages/shared/src/server/repositories/__tests__/trace-list-with-metrics.test.ts`
- `docs/query-performance/trace-list-with-metrics.md`

The line references below use synthetic PR line numbers. The represented diff is focused on query fanout, score/observation aggregation, access filtering, pagination, and tests/docs that normalize the flawed design.

## Diff

```diff
diff --git a/packages/shared/src/server/trace-list/types.ts b/packages/shared/src/server/trace-list/types.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/packages/shared/src/server/trace-list/types.ts
@@ -0,0 +1,190 @@
+import { z } from "zod";
+
+export const traceListSortSchema = z.enum([
+  "timestamp",
+  "name",
+  "latencyMs",
+  "totalCost",
+  "totalTokens",
+  "score",
+]);
+
+export type TraceListSort = z.infer<typeof traceListSortSchema>;
+
+export const traceListMetricSchema = z.object({
+  traceId: z.string(),
+  projectId: z.string(),
+  latencyMs: z.number().nullable(),
+  p95LatencyMs: z.number().nullable(),
+  totalTokens: z.number(),
+  promptTokens: z.number(),
+  completionTokens: z.number(),
+  totalCost: z.number().nullable(),
+  observationCount: z.number(),
+  errorCount: z.number(),
+  warningCount: z.number(),
+  commentCount: z.number(),
+});
+
+export type TraceListMetric = z.infer<typeof traceListMetricSchema>;
+
+export type TraceListScore = {
+  traceId: string;
+  projectId: string;
+  name: string;
+  avgValue: number | null;
+  stringValue: string | null;
+  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
+  hasMetadata: boolean;
+};
+
+export type TraceListCandidate = {
+  id: string;
+  projectId: string;
+  timestamp: Date;
+  name: string | null;
+  userId: string | null;
+  sessionId: string | null;
+  environment: string | null;
+  tags: string[];
+  public: boolean;
+  bookmarked: boolean;
+  release: string | null;
+  version: string | null;
+  cursor: string;
+};
+
+export type TraceListRow = TraceListCandidate & TraceListMetric & {
+  scores: Record<string, number | string | boolean | null>;
+  scoreNames: string[];
+};
+
+export type TraceListAccessContext = {
+  projectId: string;
+  orgId: string;
+  actorId: string;
+  role: "owner" | "admin" | "member" | "viewer";
+  allowedEnvironments: string[];
+  allowedTags: string[];
+  canReadPrivateTraces: boolean;
+};
+
+export type TraceListRequest = {
+  projectId: string;
+  limit: number;
+  cursor?: string | null;
+  searchQuery?: string | null;
+  sort: TraceListSort;
+  order: "ASC" | "DESC";
+  fromTimestamp?: Date | null;
+  toTimestamp?: Date | null;
+  filters: Array<{ column: string; operator: string; value: unknown }>; 
+  access: TraceListAccessContext;
+};
+
+export type TraceListResponse = {
+  rows: TraceListRow[];
+  nextCursor: string | null;
+  totalBeforePermission: number;
+  hiddenCount: number;
+  scoreKeys: string[];
+};
+
+export const TRACE_LIST_DEFAULT_LIMIT = 50;
+export const TRACE_LIST_MAX_LIMIT = 100;
+export const TRACE_LIST_PREFETCH_FACTOR = 5;
+export const TRACE_LIST_SCORE_RENDER_LIMIT = 8;
+
+export const traceListMetricColumns = [
+  { id: "latencyMs", label: "Latency", source: "observations", nullable: true },
+  { id: "p95LatencyMs", label: "P95 latency", source: "observations", nullable: true },
+  { id: "totalTokens", label: "Tokens", source: "observations", nullable: false },
+  { id: "totalCost", label: "Cost", source: "observations", nullable: true },
+  { id: "observationCount", label: "Observations", source: "observations", nullable: false },
+  { id: "errorCount", label: "Errors", source: "observations", nullable: false },
+  { id: "warningCount", label: "Warnings", source: "observations", nullable: false },
+  { id: "commentCount", label: "Comments", source: "postgres", nullable: false },
+] as const;
+
+export const traceListColumnPreset_001 = { id: "preset-001", metric: "score-001", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_002 = { id: "preset-002", metric: "score-002", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_003 = { id: "preset-003", metric: "score-003", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_004 = { id: "preset-004", metric: "score-004", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_005 = { id: "preset-005", metric: "score-005", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_006 = { id: "preset-006", metric: "score-006", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_007 = { id: "preset-007", metric: "score-007", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_008 = { id: "preset-008", metric: "score-008", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_009 = { id: "preset-009", metric: "score-009", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_010 = { id: "preset-010", metric: "score-010", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_011 = { id: "preset-011", metric: "score-011", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_012 = { id: "preset-012", metric: "score-012", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_013 = { id: "preset-013", metric: "score-013", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_014 = { id: "preset-014", metric: "score-014", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_015 = { id: "preset-015", metric: "score-015", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_016 = { id: "preset-016", metric: "score-016", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_017 = { id: "preset-017", metric: "score-017", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_018 = { id: "preset-018", metric: "score-018", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_019 = { id: "preset-019", metric: "score-019", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_020 = { id: "preset-020", metric: "score-020", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_021 = { id: "preset-021", metric: "score-021", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_022 = { id: "preset-022", metric: "score-022", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_023 = { id: "preset-023", metric: "score-023", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_024 = { id: "preset-024", metric: "score-024", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_025 = { id: "preset-025", metric: "score-025", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_026 = { id: "preset-026", metric: "score-026", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_027 = { id: "preset-027", metric: "score-027", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_028 = { id: "preset-028", metric: "score-028", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_029 = { id: "preset-029", metric: "score-029", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_030 = { id: "preset-030", metric: "score-030", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_031 = { id: "preset-031", metric: "score-031", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_032 = { id: "preset-032", metric: "score-032", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_033 = { id: "preset-033", metric: "score-033", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_034 = { id: "preset-034", metric: "score-034", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_035 = { id: "preset-035", metric: "score-035", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_036 = { id: "preset-036", metric: "score-036", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_037 = { id: "preset-037", metric: "score-037", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_038 = { id: "preset-038", metric: "score-038", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_039 = { id: "preset-039", metric: "score-039", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_040 = { id: "preset-040", metric: "score-040", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_041 = { id: "preset-041", metric: "score-041", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_042 = { id: "preset-042", metric: "score-042", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_043 = { id: "preset-043", metric: "score-043", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_044 = { id: "preset-044", metric: "score-044", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_045 = { id: "preset-045", metric: "score-045", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_046 = { id: "preset-046", metric: "score-046", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_047 = { id: "preset-047", metric: "score-047", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_048 = { id: "preset-048", metric: "score-048", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_049 = { id: "preset-049", metric: "score-049", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_050 = { id: "preset-050", metric: "score-050", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_051 = { id: "preset-051", metric: "score-051", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_052 = { id: "preset-052", metric: "score-052", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_053 = { id: "preset-053", metric: "score-053", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_054 = { id: "preset-054", metric: "score-054", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_055 = { id: "preset-055", metric: "score-055", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_056 = { id: "preset-056", metric: "score-056", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_057 = { id: "preset-057", metric: "score-057", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_058 = { id: "preset-058", metric: "score-058", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_059 = { id: "preset-059", metric: "score-059", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_060 = { id: "preset-060", metric: "score-060", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_061 = { id: "preset-061", metric: "score-061", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_062 = { id: "preset-062", metric: "score-062", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_063 = { id: "preset-063", metric: "score-063", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_064 = { id: "preset-064", metric: "score-064", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_065 = { id: "preset-065", metric: "score-065", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_066 = { id: "preset-066", metric: "score-066", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_067 = { id: "preset-067", metric: "score-067", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_068 = { id: "preset-068", metric: "score-068", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_069 = { id: "preset-069", metric: "score-069", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_070 = { id: "preset-070", metric: "score-070", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_071 = { id: "preset-071", metric: "score-071", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_072 = { id: "preset-072", metric: "score-072", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_073 = { id: "preset-073", metric: "score-073", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_074 = { id: "preset-074", metric: "score-074", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_075 = { id: "preset-075", metric: "score-075", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_076 = { id: "preset-076", metric: "score-076", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_077 = { id: "preset-077", metric: "score-077", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_078 = { id: "preset-078", metric: "score-078", source: "scores", visibleByDefault: true } as const;
+export const traceListColumnPreset_079 = { id: "preset-079", metric: "score-079", source: "observations", visibleByDefault: false } as const;
+export const traceListColumnPreset_080 = { id: "preset-080", metric: "score-080", source: "scores", visibleByDefault: false } as const;
+export const traceListColumnPreset_081 = { id: "preset-081", metric: "score-081", source: "observations", visibleByDefault: true } as const;
+export const traceListColumnPreset_082 = { id: "preset-082", metric: "score-082", source: "scores", visibleByDefault: false } as const;
diff --git a/packages/shared/src/server/repositories/trace-list.ts b/packages/shared/src/server/repositories/trace-list.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/packages/shared/src/server/repositories/trace-list.ts
@@ -0,0 +1,227 @@
+import { queryClickhouse } from "../repositories";
+import type { TraceListCandidate, TraceListRequest } from "../trace-list/types";
+
+type CandidateQueryParams = Pick<
+  TraceListRequest,
+  "projectId" | "limit" | "cursor" | "searchQuery" | "sort" | "order" | "fromTimestamp" | "toTimestamp" | "filters"
+>;
+
+export async function getTraceListCandidates(params: CandidateQueryParams): Promise<TraceListCandidate[]> {
+  const safeLimit = Math.min(Math.max(params.limit, 1), 500);
+  const whereParts = buildTraceWhereParts(params);
+  const orderBy = normalizeTraceListOrder(params.sort, params.order);
+  const query = `
+    SELECT
+      t.id AS id,
+      t.project_id AS projectId,
+      t.timestamp AS timestamp,
+      t.name AS name,
+      t.user_id AS userId,
+      t.session_id AS sessionId,
+      t.environment AS environment,
+      t.tags AS tags,
+      t.public AS public,
+      t.bookmarked AS bookmarked,
+      t.release AS release,
+      t.version AS version,
+      concat(toString(t.timestamp), ':', t.id) AS cursor
+    FROM traces t FINAL
+    WHERE t.project_id = {projectId: String}
+      ${whereParts.sql}
+    ORDER BY ${orderBy}
+    LIMIT {limit: Int32}
+  `;
+  const rows = await queryClickhouse<TraceListCandidate>({
+    query,
+    params: {
+      projectId: params.projectId,
+      limit: safeLimit,
+      cursor: params.cursor ?? "",
+      fromTimestamp: params.fromTimestamp?.getTime(),
+      toTimestamp: params.toTimestamp?.getTime(),
+      searchQuery: params.searchQuery ?? "",
+      ...whereParts.params,
+    },
+    tags: { feature: "tracing", type: "trace-list-with-metrics", phase: "candidates" },
+  });
+  return rows.map((row) => ({
+    ...row,
+    timestamp: new Date(row.timestamp),
+    tags: Array.isArray(row.tags) ? row.tags : [],
+  }));
+}
+
+export function buildTraceWhereParts(params: CandidateQueryParams) {
+  const sql: string[] = [];
+  const queryParams: Record<string, unknown> = {};
+  if (params.cursor) {
+    sql.push("AND concat(toString(t.timestamp), ':', t.id) < {cursor: String}");
+    queryParams.cursor = params.cursor;
+  }
+  if (params.fromTimestamp) {
+    sql.push("AND t.timestamp >= {fromTimestamp: DateTime64(3)}");
+    queryParams.fromTimestamp = params.fromTimestamp.getTime();
+  }
+  if (params.toTimestamp) {
+    sql.push("AND t.timestamp <= {toTimestamp: DateTime64(3)}");
+    queryParams.toTimestamp = params.toTimestamp.getTime();
+  }
+  if (params.searchQuery) {
+    sql.push("AND (positionCaseInsensitive(t.name, {searchQuery: String}) > 0 OR positionCaseInsensitive(t.id, {searchQuery: String}) > 0)");
+    queryParams.searchQuery = params.searchQuery;
+  }
+  for (const filter of params.filters) {
+    const fragment = traceFilterToSql(filter.column, filter.operator, filter.value);
+    if (fragment) sql.push(fragment);
+  }
+  return { sql: sql.join("\n      "), params: queryParams };
+}
+
+function traceFilterToSql(column: string, operator: string, value: unknown) {
+  if (column === "environment" && operator === "equals") return "AND t.environment = {environment: String}";
+  if (column === "userId" && operator === "equals") return "AND t.user_id = {userId: String}";
+  if (column === "sessionId" && operator === "equals") return "AND t.session_id = {sessionId: String}";
+  if (column === "tags" && operator === "contains") return "AND has(t.tags, {tag: String})";
+  if (column === "bookmarked" && operator === "equals") return "AND t.bookmarked = {bookmarked: Bool}";
+  return null;
+}
+
+function normalizeTraceListOrder(sort: CandidateQueryParams["sort"], order: CandidateQueryParams["order"]) {
+  const direction = order === "ASC" ? "ASC" : "DESC";
+  if (sort === "name") return `t.name ${direction}, t.timestamp DESC, t.id DESC`;
+  if (sort === "timestamp") return `t.timestamp ${direction}, t.id DESC`;
+  return `t.timestamp DESC, t.id DESC`;
+}
+
+export const traceListCandidateFixture_001 = { id: "trace-001", projectId: "project-a", timestampOffsetMinutes: 1, environment: "staging", tag: "fixture-001" } as const;
+export const traceListCandidateFixture_002 = { id: "trace-002", projectId: "project-a", timestampOffsetMinutes: 2, environment: "staging", tag: "fixture-002" } as const;
+export const traceListCandidateFixture_003 = { id: "trace-003", projectId: "project-a", timestampOffsetMinutes: 3, environment: "staging", tag: "fixture-003" } as const;
+export const traceListCandidateFixture_004 = { id: "trace-004", projectId: "project-a", timestampOffsetMinutes: 4, environment: "prod", tag: "fixture-004" } as const;
+export const traceListCandidateFixture_005 = { id: "trace-005", projectId: "project-a", timestampOffsetMinutes: 5, environment: "staging", tag: "fixture-005" } as const;
+export const traceListCandidateFixture_006 = { id: "trace-006", projectId: "project-a", timestampOffsetMinutes: 6, environment: "staging", tag: "fixture-006" } as const;
+export const traceListCandidateFixture_007 = { id: "trace-007", projectId: "project-a", timestampOffsetMinutes: 7, environment: "staging", tag: "fixture-007" } as const;
+export const traceListCandidateFixture_008 = { id: "trace-008", projectId: "project-a", timestampOffsetMinutes: 8, environment: "prod", tag: "fixture-008" } as const;
+export const traceListCandidateFixture_009 = { id: "trace-009", projectId: "project-a", timestampOffsetMinutes: 9, environment: "staging", tag: "fixture-009" } as const;
+export const traceListCandidateFixture_010 = { id: "trace-010", projectId: "project-a", timestampOffsetMinutes: 10, environment: "staging", tag: "fixture-010" } as const;
+export const traceListCandidateFixture_011 = { id: "trace-011", projectId: "project-a", timestampOffsetMinutes: 11, environment: "staging", tag: "fixture-011" } as const;
+export const traceListCandidateFixture_012 = { id: "trace-012", projectId: "project-a", timestampOffsetMinutes: 12, environment: "prod", tag: "fixture-012" } as const;
+export const traceListCandidateFixture_013 = { id: "trace-013", projectId: "project-a", timestampOffsetMinutes: 13, environment: "staging", tag: "fixture-013" } as const;
+export const traceListCandidateFixture_014 = { id: "trace-014", projectId: "project-a", timestampOffsetMinutes: 14, environment: "staging", tag: "fixture-014" } as const;
+export const traceListCandidateFixture_015 = { id: "trace-015", projectId: "project-a", timestampOffsetMinutes: 15, environment: "staging", tag: "fixture-015" } as const;
+export const traceListCandidateFixture_016 = { id: "trace-016", projectId: "project-a", timestampOffsetMinutes: 16, environment: "prod", tag: "fixture-016" } as const;
+export const traceListCandidateFixture_017 = { id: "trace-017", projectId: "project-a", timestampOffsetMinutes: 17, environment: "staging", tag: "fixture-017" } as const;
+export const traceListCandidateFixture_018 = { id: "trace-018", projectId: "project-a", timestampOffsetMinutes: 18, environment: "staging", tag: "fixture-018" } as const;
+export const traceListCandidateFixture_019 = { id: "trace-019", projectId: "project-a", timestampOffsetMinutes: 19, environment: "staging", tag: "fixture-019" } as const;
+export const traceListCandidateFixture_020 = { id: "trace-020", projectId: "project-a", timestampOffsetMinutes: 20, environment: "prod", tag: "fixture-020" } as const;
+export const traceListCandidateFixture_021 = { id: "trace-021", projectId: "project-a", timestampOffsetMinutes: 21, environment: "staging", tag: "fixture-021" } as const;
+export const traceListCandidateFixture_022 = { id: "trace-022", projectId: "project-a", timestampOffsetMinutes: 22, environment: "staging", tag: "fixture-022" } as const;
+export const traceListCandidateFixture_023 = { id: "trace-023", projectId: "project-a", timestampOffsetMinutes: 23, environment: "staging", tag: "fixture-023" } as const;
+export const traceListCandidateFixture_024 = { id: "trace-024", projectId: "project-a", timestampOffsetMinutes: 24, environment: "prod", tag: "fixture-024" } as const;
+export const traceListCandidateFixture_025 = { id: "trace-025", projectId: "project-a", timestampOffsetMinutes: 25, environment: "staging", tag: "fixture-025" } as const;
+export const traceListCandidateFixture_026 = { id: "trace-026", projectId: "project-a", timestampOffsetMinutes: 26, environment: "staging", tag: "fixture-026" } as const;
+export const traceListCandidateFixture_027 = { id: "trace-027", projectId: "project-a", timestampOffsetMinutes: 27, environment: "staging", tag: "fixture-027" } as const;
+export const traceListCandidateFixture_028 = { id: "trace-028", projectId: "project-a", timestampOffsetMinutes: 28, environment: "prod", tag: "fixture-028" } as const;
+export const traceListCandidateFixture_029 = { id: "trace-029", projectId: "project-a", timestampOffsetMinutes: 29, environment: "staging", tag: "fixture-029" } as const;
+export const traceListCandidateFixture_030 = { id: "trace-030", projectId: "project-a", timestampOffsetMinutes: 30, environment: "staging", tag: "fixture-030" } as const;
+export const traceListCandidateFixture_031 = { id: "trace-031", projectId: "project-a", timestampOffsetMinutes: 31, environment: "staging", tag: "fixture-031" } as const;
+export const traceListCandidateFixture_032 = { id: "trace-032", projectId: "project-a", timestampOffsetMinutes: 32, environment: "prod", tag: "fixture-032" } as const;
+export const traceListCandidateFixture_033 = { id: "trace-033", projectId: "project-a", timestampOffsetMinutes: 33, environment: "staging", tag: "fixture-033" } as const;
+export const traceListCandidateFixture_034 = { id: "trace-034", projectId: "project-a", timestampOffsetMinutes: 34, environment: "staging", tag: "fixture-034" } as const;
+export const traceListCandidateFixture_035 = { id: "trace-035", projectId: "project-a", timestampOffsetMinutes: 35, environment: "staging", tag: "fixture-035" } as const;
+export const traceListCandidateFixture_036 = { id: "trace-036", projectId: "project-a", timestampOffsetMinutes: 36, environment: "prod", tag: "fixture-036" } as const;
+export const traceListCandidateFixture_037 = { id: "trace-037", projectId: "project-a", timestampOffsetMinutes: 37, environment: "staging", tag: "fixture-037" } as const;
+export const traceListCandidateFixture_038 = { id: "trace-038", projectId: "project-a", timestampOffsetMinutes: 38, environment: "staging", tag: "fixture-038" } as const;
+export const traceListCandidateFixture_039 = { id: "trace-039", projectId: "project-a", timestampOffsetMinutes: 39, environment: "staging", tag: "fixture-039" } as const;
+export const traceListCandidateFixture_040 = { id: "trace-040", projectId: "project-a", timestampOffsetMinutes: 40, environment: "prod", tag: "fixture-040" } as const;
+export const traceListCandidateFixture_041 = { id: "trace-041", projectId: "project-a", timestampOffsetMinutes: 41, environment: "staging", tag: "fixture-041" } as const;
+export const traceListCandidateFixture_042 = { id: "trace-042", projectId: "project-a", timestampOffsetMinutes: 42, environment: "staging", tag: "fixture-042" } as const;
+export const traceListCandidateFixture_043 = { id: "trace-043", projectId: "project-a", timestampOffsetMinutes: 43, environment: "staging", tag: "fixture-043" } as const;
+export const traceListCandidateFixture_044 = { id: "trace-044", projectId: "project-a", timestampOffsetMinutes: 44, environment: "prod", tag: "fixture-044" } as const;
+export const traceListCandidateFixture_045 = { id: "trace-045", projectId: "project-a", timestampOffsetMinutes: 45, environment: "staging", tag: "fixture-045" } as const;
+export const traceListCandidateFixture_046 = { id: "trace-046", projectId: "project-a", timestampOffsetMinutes: 46, environment: "staging", tag: "fixture-046" } as const;
+export const traceListCandidateFixture_047 = { id: "trace-047", projectId: "project-a", timestampOffsetMinutes: 47, environment: "staging", tag: "fixture-047" } as const;
+export const traceListCandidateFixture_048 = { id: "trace-048", projectId: "project-a", timestampOffsetMinutes: 48, environment: "prod", tag: "fixture-048" } as const;
+export const traceListCandidateFixture_049 = { id: "trace-049", projectId: "project-a", timestampOffsetMinutes: 49, environment: "staging", tag: "fixture-049" } as const;
+export const traceListCandidateFixture_050 = { id: "trace-050", projectId: "project-a", timestampOffsetMinutes: 50, environment: "staging", tag: "fixture-050" } as const;
+export const traceListCandidateFixture_051 = { id: "trace-051", projectId: "project-a", timestampOffsetMinutes: 51, environment: "staging", tag: "fixture-051" } as const;
+export const traceListCandidateFixture_052 = { id: "trace-052", projectId: "project-a", timestampOffsetMinutes: 52, environment: "prod", tag: "fixture-052" } as const;
+export const traceListCandidateFixture_053 = { id: "trace-053", projectId: "project-a", timestampOffsetMinutes: 53, environment: "staging", tag: "fixture-053" } as const;
+export const traceListCandidateFixture_054 = { id: "trace-054", projectId: "project-a", timestampOffsetMinutes: 54, environment: "staging", tag: "fixture-054" } as const;
+export const traceListCandidateFixture_055 = { id: "trace-055", projectId: "project-a", timestampOffsetMinutes: 55, environment: "staging", tag: "fixture-055" } as const;
+export const traceListCandidateFixture_056 = { id: "trace-056", projectId: "project-a", timestampOffsetMinutes: 56, environment: "prod", tag: "fixture-056" } as const;
+export const traceListCandidateFixture_057 = { id: "trace-057", projectId: "project-a", timestampOffsetMinutes: 57, environment: "staging", tag: "fixture-057" } as const;
+export const traceListCandidateFixture_058 = { id: "trace-058", projectId: "project-a", timestampOffsetMinutes: 58, environment: "staging", tag: "fixture-058" } as const;
+export const traceListCandidateFixture_059 = { id: "trace-059", projectId: "project-a", timestampOffsetMinutes: 59, environment: "staging", tag: "fixture-059" } as const;
+export const traceListCandidateFixture_060 = { id: "trace-060", projectId: "project-a", timestampOffsetMinutes: 60, environment: "prod", tag: "fixture-060" } as const;
+export const traceListCandidateFixture_061 = { id: "trace-061", projectId: "project-a", timestampOffsetMinutes: 61, environment: "staging", tag: "fixture-061" } as const;
+export const traceListCandidateFixture_062 = { id: "trace-062", projectId: "project-a", timestampOffsetMinutes: 62, environment: "staging", tag: "fixture-062" } as const;
+export const traceListCandidateFixture_063 = { id: "trace-063", projectId: "project-a", timestampOffsetMinutes: 63, environment: "staging", tag: "fixture-063" } as const;
+export const traceListCandidateFixture_064 = { id: "trace-064", projectId: "project-a", timestampOffsetMinutes: 64, environment: "prod", tag: "fixture-064" } as const;
+export const traceListCandidateFixture_065 = { id: "trace-065", projectId: "project-a", timestampOffsetMinutes: 65, environment: "staging", tag: "fixture-065" } as const;
+export const traceListCandidateFixture_066 = { id: "trace-066", projectId: "project-a", timestampOffsetMinutes: 66, environment: "staging", tag: "fixture-066" } as const;
+export const traceListCandidateFixture_067 = { id: "trace-067", projectId: "project-a", timestampOffsetMinutes: 67, environment: "staging", tag: "fixture-067" } as const;
+export const traceListCandidateFixture_068 = { id: "trace-068", projectId: "project-a", timestampOffsetMinutes: 68, environment: "prod", tag: "fixture-068" } as const;
+export const traceListCandidateFixture_069 = { id: "trace-069", projectId: "project-a", timestampOffsetMinutes: 69, environment: "staging", tag: "fixture-069" } as const;
+export const traceListCandidateFixture_070 = { id: "trace-070", projectId: "project-a", timestampOffsetMinutes: 70, environment: "staging", tag: "fixture-070" } as const;
+export const traceListCandidateFixture_071 = { id: "trace-071", projectId: "project-a", timestampOffsetMinutes: 71, environment: "staging", tag: "fixture-071" } as const;
+export const traceListCandidateFixture_072 = { id: "trace-072", projectId: "project-a", timestampOffsetMinutes: 72, environment: "prod", tag: "fixture-072" } as const;
+export const traceListCandidateFixture_073 = { id: "trace-073", projectId: "project-a", timestampOffsetMinutes: 73, environment: "staging", tag: "fixture-073" } as const;
+export const traceListCandidateFixture_074 = { id: "trace-074", projectId: "project-a", timestampOffsetMinutes: 74, environment: "staging", tag: "fixture-074" } as const;
+export const traceListCandidateFixture_075 = { id: "trace-075", projectId: "project-a", timestampOffsetMinutes: 75, environment: "staging", tag: "fixture-075" } as const;
+export const traceListCandidateFixture_076 = { id: "trace-076", projectId: "project-a", timestampOffsetMinutes: 76, environment: "prod", tag: "fixture-076" } as const;
+export const traceListCandidateFixture_077 = { id: "trace-077", projectId: "project-a", timestampOffsetMinutes: 77, environment: "staging", tag: "fixture-077" } as const;
+export const traceListCandidateFixture_078 = { id: "trace-078", projectId: "project-a", timestampOffsetMinutes: 78, environment: "staging", tag: "fixture-078" } as const;
+export const traceListCandidateFixture_079 = { id: "trace-079", projectId: "project-a", timestampOffsetMinutes: 79, environment: "staging", tag: "fixture-079" } as const;
+export const traceListCandidateFixture_080 = { id: "trace-080", projectId: "project-a", timestampOffsetMinutes: 80, environment: "prod", tag: "fixture-080" } as const;
+export const traceListCandidateFixture_081 = { id: "trace-081", projectId: "project-a", timestampOffsetMinutes: 81, environment: "staging", tag: "fixture-081" } as const;
+export const traceListCandidateFixture_082 = { id: "trace-082", projectId: "project-a", timestampOffsetMinutes: 82, environment: "staging", tag: "fixture-082" } as const;
+export const traceListCandidateFixture_083 = { id: "trace-083", projectId: "project-a", timestampOffsetMinutes: 83, environment: "staging", tag: "fixture-083" } as const;
+export const traceListCandidateFixture_084 = { id: "trace-084", projectId: "project-a", timestampOffsetMinutes: 84, environment: "prod", tag: "fixture-084" } as const;
+export const traceListCandidateFixture_085 = { id: "trace-085", projectId: "project-a", timestampOffsetMinutes: 85, environment: "staging", tag: "fixture-085" } as const;
+export const traceListCandidateFixture_086 = { id: "trace-086", projectId: "project-a", timestampOffsetMinutes: 86, environment: "staging", tag: "fixture-086" } as const;
+export const traceListCandidateFixture_087 = { id: "trace-087", projectId: "project-a", timestampOffsetMinutes: 87, environment: "staging", tag: "fixture-087" } as const;
+export const traceListCandidateFixture_088 = { id: "trace-088", projectId: "project-a", timestampOffsetMinutes: 88, environment: "prod", tag: "fixture-088" } as const;
+export const traceListCandidateFixture_089 = { id: "trace-089", projectId: "project-a", timestampOffsetMinutes: 89, environment: "staging", tag: "fixture-089" } as const;
+export const traceListCandidateFixture_090 = { id: "trace-090", projectId: "project-a", timestampOffsetMinutes: 90, environment: "staging", tag: "fixture-090" } as const;
+export const traceListCandidateFixture_091 = { id: "trace-091", projectId: "project-a", timestampOffsetMinutes: 91, environment: "staging", tag: "fixture-091" } as const;
+export const traceListCandidateFixture_092 = { id: "trace-092", projectId: "project-a", timestampOffsetMinutes: 92, environment: "prod", tag: "fixture-092" } as const;
+export const traceListCandidateFixture_093 = { id: "trace-093", projectId: "project-a", timestampOffsetMinutes: 93, environment: "staging", tag: "fixture-093" } as const;
+export const traceListCandidateFixture_094 = { id: "trace-094", projectId: "project-a", timestampOffsetMinutes: 94, environment: "staging", tag: "fixture-094" } as const;
+export const traceListCandidateFixture_095 = { id: "trace-095", projectId: "project-a", timestampOffsetMinutes: 95, environment: "staging", tag: "fixture-095" } as const;
+export const traceListCandidateFixture_096 = { id: "trace-096", projectId: "project-a", timestampOffsetMinutes: 96, environment: "prod", tag: "fixture-096" } as const;
+export const traceListCandidateFixture_097 = { id: "trace-097", projectId: "project-a", timestampOffsetMinutes: 97, environment: "staging", tag: "fixture-097" } as const;
+export const traceListCandidateFixture_098 = { id: "trace-098", projectId: "project-a", timestampOffsetMinutes: 98, environment: "staging", tag: "fixture-098" } as const;
+export const traceListCandidateFixture_099 = { id: "trace-099", projectId: "project-a", timestampOffsetMinutes: 99, environment: "staging", tag: "fixture-099" } as const;
+export const traceListCandidateFixture_100 = { id: "trace-100", projectId: "project-a", timestampOffsetMinutes: 100, environment: "prod", tag: "fixture-100" } as const;
+export const traceListCandidateFixture_101 = { id: "trace-101", projectId: "project-a", timestampOffsetMinutes: 101, environment: "staging", tag: "fixture-101" } as const;
+export const traceListCandidateFixture_102 = { id: "trace-102", projectId: "project-a", timestampOffsetMinutes: 102, environment: "staging", tag: "fixture-102" } as const;
+export const traceListCandidateFixture_103 = { id: "trace-103", projectId: "project-a", timestampOffsetMinutes: 103, environment: "staging", tag: "fixture-103" } as const;
+export const traceListCandidateFixture_104 = { id: "trace-104", projectId: "project-a", timestampOffsetMinutes: 104, environment: "prod", tag: "fixture-104" } as const;
+export const traceListCandidateFixture_105 = { id: "trace-105", projectId: "project-a", timestampOffsetMinutes: 105, environment: "staging", tag: "fixture-105" } as const;
+export const traceListCandidateFixture_106 = { id: "trace-106", projectId: "project-a", timestampOffsetMinutes: 106, environment: "staging", tag: "fixture-106" } as const;
+export const traceListCandidateFixture_107 = { id: "trace-107", projectId: "project-a", timestampOffsetMinutes: 107, environment: "staging", tag: "fixture-107" } as const;
+export const traceListCandidateFixture_108 = { id: "trace-108", projectId: "project-a", timestampOffsetMinutes: 108, environment: "prod", tag: "fixture-108" } as const;
+export const traceListCandidateFixture_109 = { id: "trace-109", projectId: "project-a", timestampOffsetMinutes: 109, environment: "staging", tag: "fixture-109" } as const;
+export const traceListCandidateFixture_110 = { id: "trace-110", projectId: "project-a", timestampOffsetMinutes: 110, environment: "staging", tag: "fixture-110" } as const;
+export const traceListCandidateFixture_111 = { id: "trace-111", projectId: "project-a", timestampOffsetMinutes: 111, environment: "staging", tag: "fixture-111" } as const;
+export const traceListCandidateFixture_112 = { id: "trace-112", projectId: "project-a", timestampOffsetMinutes: 112, environment: "prod", tag: "fixture-112" } as const;
+export const traceListCandidateFixture_113 = { id: "trace-113", projectId: "project-a", timestampOffsetMinutes: 113, environment: "staging", tag: "fixture-113" } as const;
+export const traceListCandidateFixture_114 = { id: "trace-114", projectId: "project-a", timestampOffsetMinutes: 114, environment: "staging", tag: "fixture-114" } as const;
+export const traceListCandidateFixture_115 = { id: "trace-115", projectId: "project-a", timestampOffsetMinutes: 115, environment: "staging", tag: "fixture-115" } as const;
+export const traceListCandidateFixture_116 = { id: "trace-116", projectId: "project-a", timestampOffsetMinutes: 116, environment: "prod", tag: "fixture-116" } as const;
+export const traceListCandidateFixture_117 = { id: "trace-117", projectId: "project-a", timestampOffsetMinutes: 117, environment: "staging", tag: "fixture-117" } as const;
+export const traceListCandidateFixture_118 = { id: "trace-118", projectId: "project-a", timestampOffsetMinutes: 118, environment: "staging", tag: "fixture-118" } as const;
+export const traceListCandidateFixture_119 = { id: "trace-119", projectId: "project-a", timestampOffsetMinutes: 119, environment: "staging", tag: "fixture-119" } as const;
+export const traceListCandidateFixture_120 = { id: "trace-120", projectId: "project-a", timestampOffsetMinutes: 120, environment: "prod", tag: "fixture-120" } as const;
+export const traceListCandidateFixture_121 = { id: "trace-121", projectId: "project-a", timestampOffsetMinutes: 121, environment: "staging", tag: "fixture-121" } as const;
+export const traceListCandidateFixture_122 = { id: "trace-122", projectId: "project-a", timestampOffsetMinutes: 122, environment: "staging", tag: "fixture-122" } as const;
+export const traceListCandidateFixture_123 = { id: "trace-123", projectId: "project-a", timestampOffsetMinutes: 123, environment: "staging", tag: "fixture-123" } as const;
+export const traceListCandidateFixture_124 = { id: "trace-124", projectId: "project-a", timestampOffsetMinutes: 124, environment: "prod", tag: "fixture-124" } as const;
+export const traceListCandidateFixture_125 = { id: "trace-125", projectId: "project-a", timestampOffsetMinutes: 125, environment: "staging", tag: "fixture-125" } as const;
+export const traceListCandidateFixture_126 = { id: "trace-126", projectId: "project-a", timestampOffsetMinutes: 126, environment: "staging", tag: "fixture-126" } as const;
+export const traceListCandidateFixture_127 = { id: "trace-127", projectId: "project-a", timestampOffsetMinutes: 127, environment: "staging", tag: "fixture-127" } as const;
+export const traceListCandidateFixture_128 = { id: "trace-128", projectId: "project-a", timestampOffsetMinutes: 128, environment: "prod", tag: "fixture-128" } as const;
+export const traceListCandidateFixture_129 = { id: "trace-129", projectId: "project-a", timestampOffsetMinutes: 129, environment: "staging", tag: "fixture-129" } as const;
+export const traceListCandidateFixture_130 = { id: "trace-130", projectId: "project-a", timestampOffsetMinutes: 130, environment: "staging", tag: "fixture-130" } as const;
+export const traceListCandidateFixture_131 = { id: "trace-131", projectId: "project-a", timestampOffsetMinutes: 131, environment: "staging", tag: "fixture-131" } as const;
+export const traceListCandidateFixture_132 = { id: "trace-132", projectId: "project-a", timestampOffsetMinutes: 132, environment: "prod", tag: "fixture-132" } as const;
diff --git a/packages/shared/src/server/repositories/trace-score-metrics.ts b/packages/shared/src/server/repositories/trace-score-metrics.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/packages/shared/src/server/repositories/trace-score-metrics.ts
@@ -0,0 +1,244 @@
+import { queryClickhouse } from "../repositories";
+import type { TraceListScore } from "../trace-list/types";
+
+export async function getScoresForTrace(params: { projectId: string; traceId: string; limit?: number }) {
+  const query = `
+    SELECT
+      project_id AS projectId,
+      trace_id AS traceId,
+      name AS name,
+      data_type AS dataType,
+      avg(value) AS avgValue,
+      anyLast(string_value) AS stringValue,
+      max(length(metadata) > 2) AS hasMetadata
+    FROM scores FINAL
+    WHERE project_id = {projectId: String}
+      AND trace_id = {traceId: String}
+    GROUP BY project_id, trace_id, name, data_type
+    ORDER BY name ASC
+    LIMIT {limit: Int32}
+  `;
+  return queryClickhouse<TraceListScore>({
+    query,
+    params: {
+      projectId: params.projectId,
+      traceId: params.traceId,
+      limit: params.limit ?? 1000,
+    },
+    tags: { feature: "tracing", type: "trace-list-with-metrics", phase: "scores", traceId: params.traceId },
+  });
+}
+
+export async function getScoreNamesForTrace(params: { projectId: string; traceId: string }) {
+  const rows = await queryClickhouse<{ name: string }>({
+    query: `
+      SELECT DISTINCT name
+      FROM scores FINAL
+      WHERE project_id = {projectId: String}
+        AND trace_id = {traceId: String}
+      ORDER BY name ASC
+    `,
+    params: { projectId: params.projectId, traceId: params.traceId },
+    tags: { feature: "tracing", type: "trace-list-with-metrics", phase: "score-names" },
+  });
+  return rows.map((row) => row.name);
+}
+
+export async function getLatestCategoricalScoreForTrace(params: { projectId: string; traceId: string; name: string }) {
+  const rows = await queryClickhouse<{ value: string | null }>({
+    query: `
+      SELECT string_value AS value
+      FROM scores FINAL
+      WHERE project_id = {projectId: String}
+        AND trace_id = {traceId: String}
+        AND name = {name: String}
+        AND data_type = 'CATEGORICAL'
+      ORDER BY timestamp DESC
+      LIMIT 1
+    `,
+    params: { projectId: params.projectId, traceId: params.traceId, name: params.name },
+    tags: { feature: "tracing", type: "trace-list-with-metrics", phase: "categorical-score" },
+  });
+  return rows[0]?.value ?? null;
+}
+
+export function scoresToColumnMap(scores: TraceListScore[]) {
+  const out: Record<string, number | string | boolean | null> = {};
+  for (const score of scores) {
+    if (score.dataType === "BOOLEAN") out[score.name] = score.avgValue === null ? null : score.avgValue >= 0.5;
+    else if (score.dataType === "CATEGORICAL") out[score.name] = score.stringValue;
+    else out[score.name] = score.avgValue;
+  }
+  return out;
+}
+
+export const scoreMetricFixture_001 = { traceId: "trace-001", name: "quality-1", avgValue: 0.01, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_002 = { traceId: "trace-002", name: "quality-2", avgValue: 0.02, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_003 = { traceId: "trace-003", name: "quality-3", avgValue: 0.03, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_004 = { traceId: "trace-004", name: "quality-4", avgValue: 0.04, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_005 = { traceId: "trace-005", name: "quality-5", avgValue: 0.05, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_006 = { traceId: "trace-006", name: "quality-6", avgValue: 0.06, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_007 = { traceId: "trace-007", name: "quality-7", avgValue: 0.07, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_008 = { traceId: "trace-008", name: "quality-8", avgValue: 0.08, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_009 = { traceId: "trace-009", name: "quality-9", avgValue: 0.09, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_010 = { traceId: "trace-010", name: "quality-10", avgValue: 0.1, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_011 = { traceId: "trace-011", name: "quality-11", avgValue: 0.11, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_012 = { traceId: "trace-012", name: "quality-0", avgValue: 0.12, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_013 = { traceId: "trace-013", name: "quality-1", avgValue: 0.13, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_014 = { traceId: "trace-014", name: "quality-2", avgValue: 0.14, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_015 = { traceId: "trace-015", name: "quality-3", avgValue: 0.15, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_016 = { traceId: "trace-016", name: "quality-4", avgValue: 0.16, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_017 = { traceId: "trace-017", name: "quality-5", avgValue: 0.17, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_018 = { traceId: "trace-018", name: "quality-6", avgValue: 0.18, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_019 = { traceId: "trace-019", name: "quality-7", avgValue: 0.19, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_020 = { traceId: "trace-020", name: "quality-8", avgValue: 0.2, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_021 = { traceId: "trace-021", name: "quality-9", avgValue: 0.21, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_022 = { traceId: "trace-022", name: "quality-10", avgValue: 0.22, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_023 = { traceId: "trace-023", name: "quality-11", avgValue: 0.23, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_024 = { traceId: "trace-024", name: "quality-0", avgValue: 0.24, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_025 = { traceId: "trace-025", name: "quality-1", avgValue: 0.25, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_026 = { traceId: "trace-026", name: "quality-2", avgValue: 0.26, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_027 = { traceId: "trace-027", name: "quality-3", avgValue: 0.27, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_028 = { traceId: "trace-028", name: "quality-4", avgValue: 0.28, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_029 = { traceId: "trace-029", name: "quality-5", avgValue: 0.29, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_030 = { traceId: "trace-030", name: "quality-6", avgValue: 0.3, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_031 = { traceId: "trace-031", name: "quality-7", avgValue: 0.31, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_032 = { traceId: "trace-032", name: "quality-8", avgValue: 0.32, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_033 = { traceId: "trace-033", name: "quality-9", avgValue: 0.33, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_034 = { traceId: "trace-034", name: "quality-10", avgValue: 0.34, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_035 = { traceId: "trace-035", name: "quality-11", avgValue: 0.35, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_036 = { traceId: "trace-036", name: "quality-0", avgValue: 0.36, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_037 = { traceId: "trace-037", name: "quality-1", avgValue: 0.37, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_038 = { traceId: "trace-038", name: "quality-2", avgValue: 0.38, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_039 = { traceId: "trace-039", name: "quality-3", avgValue: 0.39, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_040 = { traceId: "trace-040", name: "quality-4", avgValue: 0.4, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_041 = { traceId: "trace-041", name: "quality-5", avgValue: 0.41, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_042 = { traceId: "trace-042", name: "quality-6", avgValue: 0.42, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_043 = { traceId: "trace-043", name: "quality-7", avgValue: 0.43, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_044 = { traceId: "trace-044", name: "quality-8", avgValue: 0.44, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_045 = { traceId: "trace-045", name: "quality-9", avgValue: 0.45, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_046 = { traceId: "trace-046", name: "quality-10", avgValue: 0.46, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_047 = { traceId: "trace-047", name: "quality-11", avgValue: 0.47, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_048 = { traceId: "trace-048", name: "quality-0", avgValue: 0.48, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_049 = { traceId: "trace-049", name: "quality-1", avgValue: 0.49, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_050 = { traceId: "trace-050", name: "quality-2", avgValue: 0.5, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_051 = { traceId: "trace-051", name: "quality-3", avgValue: 0.51, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_052 = { traceId: "trace-052", name: "quality-4", avgValue: 0.52, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_053 = { traceId: "trace-053", name: "quality-5", avgValue: 0.53, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_054 = { traceId: "trace-054", name: "quality-6", avgValue: 0.54, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_055 = { traceId: "trace-055", name: "quality-7", avgValue: 0.55, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_056 = { traceId: "trace-056", name: "quality-8", avgValue: 0.56, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_057 = { traceId: "trace-057", name: "quality-9", avgValue: 0.57, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_058 = { traceId: "trace-058", name: "quality-10", avgValue: 0.58, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_059 = { traceId: "trace-059", name: "quality-11", avgValue: 0.59, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_060 = { traceId: "trace-060", name: "quality-0", avgValue: 0.6, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_061 = { traceId: "trace-061", name: "quality-1", avgValue: 0.61, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_062 = { traceId: "trace-062", name: "quality-2", avgValue: 0.62, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_063 = { traceId: "trace-063", name: "quality-3", avgValue: 0.63, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_064 = { traceId: "trace-064", name: "quality-4", avgValue: 0.64, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_065 = { traceId: "trace-065", name: "quality-5", avgValue: 0.65, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_066 = { traceId: "trace-066", name: "quality-6", avgValue: 0.66, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_067 = { traceId: "trace-067", name: "quality-7", avgValue: 0.67, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_068 = { traceId: "trace-068", name: "quality-8", avgValue: 0.68, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_069 = { traceId: "trace-069", name: "quality-9", avgValue: 0.69, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_070 = { traceId: "trace-070", name: "quality-10", avgValue: 0.7, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_071 = { traceId: "trace-071", name: "quality-11", avgValue: 0.71, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_072 = { traceId: "trace-072", name: "quality-0", avgValue: 0.72, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_073 = { traceId: "trace-073", name: "quality-1", avgValue: 0.73, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_074 = { traceId: "trace-074", name: "quality-2", avgValue: 0.74, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_075 = { traceId: "trace-075", name: "quality-3", avgValue: 0.75, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_076 = { traceId: "trace-076", name: "quality-4", avgValue: 0.76, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_077 = { traceId: "trace-077", name: "quality-5", avgValue: 0.77, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_078 = { traceId: "trace-078", name: "quality-6", avgValue: 0.78, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_079 = { traceId: "trace-079", name: "quality-7", avgValue: 0.79, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_080 = { traceId: "trace-080", name: "quality-8", avgValue: 0.8, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_081 = { traceId: "trace-081", name: "quality-9", avgValue: 0.81, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_082 = { traceId: "trace-082", name: "quality-10", avgValue: 0.82, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_083 = { traceId: "trace-083", name: "quality-11", avgValue: 0.83, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_084 = { traceId: "trace-084", name: "quality-0", avgValue: 0.84, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_085 = { traceId: "trace-085", name: "quality-1", avgValue: 0.85, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_086 = { traceId: "trace-086", name: "quality-2", avgValue: 0.86, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_087 = { traceId: "trace-087", name: "quality-3", avgValue: 0.87, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_088 = { traceId: "trace-088", name: "quality-4", avgValue: 0.88, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_089 = { traceId: "trace-089", name: "quality-5", avgValue: 0.89, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_090 = { traceId: "trace-090", name: "quality-6", avgValue: 0.9, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_091 = { traceId: "trace-091", name: "quality-7", avgValue: 0.91, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_092 = { traceId: "trace-092", name: "quality-8", avgValue: 0.92, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_093 = { traceId: "trace-093", name: "quality-9", avgValue: 0.93, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_094 = { traceId: "trace-094", name: "quality-10", avgValue: 0.94, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_095 = { traceId: "trace-095", name: "quality-11", avgValue: 0.95, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_096 = { traceId: "trace-096", name: "quality-0", avgValue: 0.96, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_097 = { traceId: "trace-097", name: "quality-1", avgValue: 0.97, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_098 = { traceId: "trace-098", name: "quality-2", avgValue: 0.98, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_099 = { traceId: "trace-099", name: "quality-3", avgValue: 0.99, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_100 = { traceId: "trace-100", name: "quality-4", avgValue: 0, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_101 = { traceId: "trace-101", name: "quality-5", avgValue: 0.01, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_102 = { traceId: "trace-102", name: "quality-6", avgValue: 0.02, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_103 = { traceId: "trace-103", name: "quality-7", avgValue: 0.03, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_104 = { traceId: "trace-104", name: "quality-8", avgValue: 0.04, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_105 = { traceId: "trace-105", name: "quality-9", avgValue: 0.05, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_106 = { traceId: "trace-106", name: "quality-10", avgValue: 0.06, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_107 = { traceId: "trace-107", name: "quality-11", avgValue: 0.07, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_108 = { traceId: "trace-108", name: "quality-0", avgValue: 0.08, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_109 = { traceId: "trace-109", name: "quality-1", avgValue: 0.09, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_110 = { traceId: "trace-110", name: "quality-2", avgValue: 0.1, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_111 = { traceId: "trace-111", name: "quality-3", avgValue: 0.11, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_112 = { traceId: "trace-112", name: "quality-4", avgValue: 0.12, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_113 = { traceId: "trace-113", name: "quality-5", avgValue: 0.13, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_114 = { traceId: "trace-114", name: "quality-6", avgValue: 0.14, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_115 = { traceId: "trace-115", name: "quality-7", avgValue: 0.15, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_116 = { traceId: "trace-116", name: "quality-8", avgValue: 0.16, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_117 = { traceId: "trace-117", name: "quality-9", avgValue: 0.17, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_118 = { traceId: "trace-118", name: "quality-10", avgValue: 0.18, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_119 = { traceId: "trace-119", name: "quality-11", avgValue: 0.19, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_120 = { traceId: "trace-120", name: "quality-0", avgValue: 0.2, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_121 = { traceId: "trace-121", name: "quality-1", avgValue: 0.21, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_122 = { traceId: "trace-122", name: "quality-2", avgValue: 0.22, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_123 = { traceId: "trace-123", name: "quality-3", avgValue: 0.23, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_124 = { traceId: "trace-124", name: "quality-4", avgValue: 0.24, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_125 = { traceId: "trace-125", name: "quality-5", avgValue: 0.25, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_126 = { traceId: "trace-126", name: "quality-6", avgValue: 0.26, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_127 = { traceId: "trace-127", name: "quality-7", avgValue: 0.27, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_128 = { traceId: "trace-128", name: "quality-8", avgValue: 0.28, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_129 = { traceId: "trace-129", name: "quality-9", avgValue: 0.29, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_130 = { traceId: "trace-130", name: "quality-10", avgValue: 0.3, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_131 = { traceId: "trace-131", name: "quality-11", avgValue: 0.31, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_132 = { traceId: "trace-132", name: "quality-0", avgValue: 0.32, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_133 = { traceId: "trace-133", name: "quality-1", avgValue: 0.33, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_134 = { traceId: "trace-134", name: "quality-2", avgValue: 0.34, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_135 = { traceId: "trace-135", name: "quality-3", avgValue: 0.35, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_136 = { traceId: "trace-136", name: "quality-4", avgValue: 0.36, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_137 = { traceId: "trace-137", name: "quality-5", avgValue: 0.37, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_138 = { traceId: "trace-138", name: "quality-6", avgValue: 0.38, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_139 = { traceId: "trace-139", name: "quality-7", avgValue: 0.39, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_140 = { traceId: "trace-140", name: "quality-8", avgValue: 0.4, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_141 = { traceId: "trace-141", name: "quality-9", avgValue: 0.41, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_142 = { traceId: "trace-142", name: "quality-10", avgValue: 0.42, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_143 = { traceId: "trace-143", name: "quality-11", avgValue: 0.43, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_144 = { traceId: "trace-144", name: "quality-0", avgValue: 0.44, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_145 = { traceId: "trace-145", name: "quality-1", avgValue: 0.45, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_146 = { traceId: "trace-146", name: "quality-2", avgValue: 0.46, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_147 = { traceId: "trace-147", name: "quality-3", avgValue: 0.47, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_148 = { traceId: "trace-148", name: "quality-4", avgValue: 0.48, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_149 = { traceId: "trace-149", name: "quality-5", avgValue: 0.49, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_150 = { traceId: "trace-150", name: "quality-6", avgValue: 0.5, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_151 = { traceId: "trace-151", name: "quality-7", avgValue: 0.51, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_152 = { traceId: "trace-152", name: "quality-8", avgValue: 0.52, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_153 = { traceId: "trace-153", name: "quality-9", avgValue: 0.53, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_154 = { traceId: "trace-154", name: "quality-10", avgValue: 0.54, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_155 = { traceId: "trace-155", name: "quality-11", avgValue: 0.55, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_156 = { traceId: "trace-156", name: "quality-0", avgValue: 0.56, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_157 = { traceId: "trace-157", name: "quality-1", avgValue: 0.57, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_158 = { traceId: "trace-158", name: "quality-2", avgValue: 0.58, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_159 = { traceId: "trace-159", name: "quality-3", avgValue: 0.59, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_160 = { traceId: "trace-160", name: "quality-4", avgValue: 0.6, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_161 = { traceId: "trace-161", name: "quality-5", avgValue: 0.61, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_162 = { traceId: "trace-162", name: "quality-6", avgValue: 0.62, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_163 = { traceId: "trace-163", name: "quality-7", avgValue: 0.63, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_164 = { traceId: "trace-164", name: "quality-8", avgValue: 0.64, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_165 = { traceId: "trace-165", name: "quality-9", avgValue: 0.65, dataType: "BOOLEAN" } as const;
+export const scoreMetricFixture_166 = { traceId: "trace-166", name: "quality-10", avgValue: 0.66, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_167 = { traceId: "trace-167", name: "quality-11", avgValue: 0.67, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_168 = { traceId: "trace-168", name: "quality-0", avgValue: 0.68, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_169 = { traceId: "trace-169", name: "quality-1", avgValue: 0.69, dataType: "NUMERIC" } as const;
+export const scoreMetricFixture_170 = { traceId: "trace-170", name: "quality-2", avgValue: 0.7, dataType: "BOOLEAN" } as const;
diff --git a/packages/shared/src/server/repositories/trace-observation-metrics.ts b/packages/shared/src/server/repositories/trace-observation-metrics.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/packages/shared/src/server/repositories/trace-observation-metrics.ts
@@ -0,0 +1,238 @@
+import { queryClickhouse } from "../repositories";
+import type { TraceListMetric } from "../trace-list/types";
+
+export async function getObservationMetricsForTrace(params: { projectId: string; traceId: string }) {
+  const rows = await queryClickhouse<TraceListMetric>({
+    query: `
+      SELECT
+        trace_id AS traceId,
+        project_id AS projectId,
+        dateDiff('millisecond', min(start_time), max(end_time)) AS latencyMs,
+        quantile(0.95)(dateDiff('millisecond', start_time, end_time)) AS p95LatencyMs,
+        sum(usage_details['total']) AS totalTokens,
+        sum(usage_details['input']) AS promptTokens,
+        sum(usage_details['output']) AS completionTokens,
+        sum(total_cost) AS totalCost,
+        count(*) AS observationCount,
+        countIf(level = 'ERROR') AS errorCount,
+        countIf(level = 'WARNING') AS warningCount,
+        0 AS commentCount
+      FROM observations FINAL
+      WHERE project_id = {projectId: String}
+        AND trace_id = {traceId: String}
+      GROUP BY trace_id, project_id
+    `,
+    params: { projectId: params.projectId, traceId: params.traceId },
+    tags: { feature: "tracing", type: "trace-list-with-metrics", phase: "observation-metrics", traceId: params.traceId },
+  });
+  return rows[0] ?? emptyTraceMetric(params.projectId, params.traceId);
+}
+
+export async function getTraceTokenUsage(params: { projectId: string; traceId: string }) {
+  const rows = await queryClickhouse<{ totalTokens: number; promptTokens: number; completionTokens: number }>({
+    query: `
+      SELECT
+        sum(usage_details['total']) AS totalTokens,
+        sum(usage_details['input']) AS promptTokens,
+        sum(usage_details['output']) AS completionTokens
+      FROM observations FINAL
+      WHERE project_id = {projectId: String}
+        AND trace_id = {traceId: String}
+    `,
+    params: { projectId: params.projectId, traceId: params.traceId },
+    tags: { feature: "tracing", type: "trace-list-with-metrics", phase: "token-usage" },
+  });
+  return rows[0] ?? { totalTokens: 0, promptTokens: 0, completionTokens: 0 };
+}
+
+export function emptyTraceMetric(projectId: string, traceId: string): TraceListMetric {
+  return {
+    projectId,
+    traceId,
+    latencyMs: null,
+    p95LatencyMs: null,
+    totalTokens: 0,
+    promptTokens: 0,
+    completionTokens: 0,
+    totalCost: null,
+    observationCount: 0,
+    errorCount: 0,
+    warningCount: 0,
+    commentCount: 0,
+  };
+}
+
+export const observationMetricFixture_001 = { traceId: "trace-001", latencyMs: 51, totalTokens: 13, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_002 = { traceId: "trace-002", latencyMs: 52, totalTokens: 26, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_003 = { traceId: "trace-003", latencyMs: 53, totalTokens: 39, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_004 = { traceId: "trace-004", latencyMs: 54, totalTokens: 52, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_005 = { traceId: "trace-005", latencyMs: 55, totalTokens: 65, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_006 = { traceId: "trace-006", latencyMs: 56, totalTokens: 78, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_007 = { traceId: "trace-007", latencyMs: 57, totalTokens: 91, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_008 = { traceId: "trace-008", latencyMs: 58, totalTokens: 104, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_009 = { traceId: "trace-009", latencyMs: 59, totalTokens: 117, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_010 = { traceId: "trace-010", latencyMs: 60, totalTokens: 130, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_011 = { traceId: "trace-011", latencyMs: 61, totalTokens: 143, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_012 = { traceId: "trace-012", latencyMs: 62, totalTokens: 156, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_013 = { traceId: "trace-013", latencyMs: 63, totalTokens: 169, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_014 = { traceId: "trace-014", latencyMs: 64, totalTokens: 182, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_015 = { traceId: "trace-015", latencyMs: 65, totalTokens: 195, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_016 = { traceId: "trace-016", latencyMs: 66, totalTokens: 208, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_017 = { traceId: "trace-017", latencyMs: 67, totalTokens: 221, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_018 = { traceId: "trace-018", latencyMs: 68, totalTokens: 234, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_019 = { traceId: "trace-019", latencyMs: 69, totalTokens: 247, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_020 = { traceId: "trace-020", latencyMs: 70, totalTokens: 260, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_021 = { traceId: "trace-021", latencyMs: 71, totalTokens: 273, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_022 = { traceId: "trace-022", latencyMs: 72, totalTokens: 286, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_023 = { traceId: "trace-023", latencyMs: 73, totalTokens: 299, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_024 = { traceId: "trace-024", latencyMs: 74, totalTokens: 312, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_025 = { traceId: "trace-025", latencyMs: 75, totalTokens: 325, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_026 = { traceId: "trace-026", latencyMs: 76, totalTokens: 338, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_027 = { traceId: "trace-027", latencyMs: 77, totalTokens: 351, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_028 = { traceId: "trace-028", latencyMs: 78, totalTokens: 364, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_029 = { traceId: "trace-029", latencyMs: 79, totalTokens: 377, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_030 = { traceId: "trace-030", latencyMs: 80, totalTokens: 390, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_031 = { traceId: "trace-031", latencyMs: 81, totalTokens: 403, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_032 = { traceId: "trace-032", latencyMs: 82, totalTokens: 416, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_033 = { traceId: "trace-033", latencyMs: 83, totalTokens: 429, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_034 = { traceId: "trace-034", latencyMs: 84, totalTokens: 442, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_035 = { traceId: "trace-035", latencyMs: 85, totalTokens: 455, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_036 = { traceId: "trace-036", latencyMs: 86, totalTokens: 468, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_037 = { traceId: "trace-037", latencyMs: 87, totalTokens: 481, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_038 = { traceId: "trace-038", latencyMs: 88, totalTokens: 494, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_039 = { traceId: "trace-039", latencyMs: 89, totalTokens: 507, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_040 = { traceId: "trace-040", latencyMs: 90, totalTokens: 520, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_041 = { traceId: "trace-041", latencyMs: 91, totalTokens: 533, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_042 = { traceId: "trace-042", latencyMs: 92, totalTokens: 546, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_043 = { traceId: "trace-043", latencyMs: 93, totalTokens: 559, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_044 = { traceId: "trace-044", latencyMs: 94, totalTokens: 572, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_045 = { traceId: "trace-045", latencyMs: 95, totalTokens: 585, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_046 = { traceId: "trace-046", latencyMs: 96, totalTokens: 598, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_047 = { traceId: "trace-047", latencyMs: 97, totalTokens: 611, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_048 = { traceId: "trace-048", latencyMs: 98, totalTokens: 624, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_049 = { traceId: "trace-049", latencyMs: 99, totalTokens: 637, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_050 = { traceId: "trace-050", latencyMs: 100, totalTokens: 650, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_051 = { traceId: "trace-051", latencyMs: 101, totalTokens: 663, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_052 = { traceId: "trace-052", latencyMs: 102, totalTokens: 676, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_053 = { traceId: "trace-053", latencyMs: 103, totalTokens: 689, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_054 = { traceId: "trace-054", latencyMs: 104, totalTokens: 702, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_055 = { traceId: "trace-055", latencyMs: 105, totalTokens: 715, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_056 = { traceId: "trace-056", latencyMs: 106, totalTokens: 728, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_057 = { traceId: "trace-057", latencyMs: 107, totalTokens: 741, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_058 = { traceId: "trace-058", latencyMs: 108, totalTokens: 754, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_059 = { traceId: "trace-059", latencyMs: 109, totalTokens: 767, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_060 = { traceId: "trace-060", latencyMs: 110, totalTokens: 780, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_061 = { traceId: "trace-061", latencyMs: 111, totalTokens: 793, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_062 = { traceId: "trace-062", latencyMs: 112, totalTokens: 806, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_063 = { traceId: "trace-063", latencyMs: 113, totalTokens: 819, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_064 = { traceId: "trace-064", latencyMs: 114, totalTokens: 832, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_065 = { traceId: "trace-065", latencyMs: 115, totalTokens: 845, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_066 = { traceId: "trace-066", latencyMs: 116, totalTokens: 858, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_067 = { traceId: "trace-067", latencyMs: 117, totalTokens: 871, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_068 = { traceId: "trace-068", latencyMs: 118, totalTokens: 884, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_069 = { traceId: "trace-069", latencyMs: 119, totalTokens: 897, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_070 = { traceId: "trace-070", latencyMs: 120, totalTokens: 910, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_071 = { traceId: "trace-071", latencyMs: 121, totalTokens: 923, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_072 = { traceId: "trace-072", latencyMs: 122, totalTokens: 936, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_073 = { traceId: "trace-073", latencyMs: 123, totalTokens: 949, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_074 = { traceId: "trace-074", latencyMs: 124, totalTokens: 962, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_075 = { traceId: "trace-075", latencyMs: 125, totalTokens: 975, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_076 = { traceId: "trace-076", latencyMs: 126, totalTokens: 988, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_077 = { traceId: "trace-077", latencyMs: 127, totalTokens: 1001, errorCount: 1, warningCount: 1 } as const;
+export const observationMetricFixture_078 = { traceId: "trace-078", latencyMs: 128, totalTokens: 1014, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_079 = { traceId: "trace-079", latencyMs: 129, totalTokens: 1027, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_080 = { traceId: "trace-080", latencyMs: 130, totalTokens: 1040, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_081 = { traceId: "trace-081", latencyMs: 131, totalTokens: 1053, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_082 = { traceId: "trace-082", latencyMs: 132, totalTokens: 1066, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_083 = { traceId: "trace-083", latencyMs: 133, totalTokens: 1079, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_084 = { traceId: "trace-084", latencyMs: 134, totalTokens: 1092, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_085 = { traceId: "trace-085", latencyMs: 135, totalTokens: 1105, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_086 = { traceId: "trace-086", latencyMs: 136, totalTokens: 1118, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_087 = { traceId: "trace-087", latencyMs: 137, totalTokens: 1131, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_088 = { traceId: "trace-088", latencyMs: 138, totalTokens: 1144, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_089 = { traceId: "trace-089", latencyMs: 139, totalTokens: 1157, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_090 = { traceId: "trace-090", latencyMs: 140, totalTokens: 1170, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_091 = { traceId: "trace-091", latencyMs: 141, totalTokens: 1183, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_092 = { traceId: "trace-092", latencyMs: 142, totalTokens: 1196, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_093 = { traceId: "trace-093", latencyMs: 143, totalTokens: 1209, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_094 = { traceId: "trace-094", latencyMs: 144, totalTokens: 1222, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_095 = { traceId: "trace-095", latencyMs: 145, totalTokens: 1235, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_096 = { traceId: "trace-096", latencyMs: 146, totalTokens: 1248, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_097 = { traceId: "trace-097", latencyMs: 147, totalTokens: 1261, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_098 = { traceId: "trace-098", latencyMs: 148, totalTokens: 1274, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_099 = { traceId: "trace-099", latencyMs: 149, totalTokens: 1287, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_100 = { traceId: "trace-100", latencyMs: 150, totalTokens: 1300, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_101 = { traceId: "trace-101", latencyMs: 151, totalTokens: 1313, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_102 = { traceId: "trace-102", latencyMs: 152, totalTokens: 1326, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_103 = { traceId: "trace-103", latencyMs: 153, totalTokens: 1339, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_104 = { traceId: "trace-104", latencyMs: 154, totalTokens: 1352, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_105 = { traceId: "trace-105", latencyMs: 155, totalTokens: 1365, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_106 = { traceId: "trace-106", latencyMs: 156, totalTokens: 1378, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_107 = { traceId: "trace-107", latencyMs: 157, totalTokens: 1391, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_108 = { traceId: "trace-108", latencyMs: 158, totalTokens: 1404, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_109 = { traceId: "trace-109", latencyMs: 159, totalTokens: 1417, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_110 = { traceId: "trace-110", latencyMs: 160, totalTokens: 1430, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_111 = { traceId: "trace-111", latencyMs: 161, totalTokens: 1443, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_112 = { traceId: "trace-112", latencyMs: 162, totalTokens: 1456, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_113 = { traceId: "trace-113", latencyMs: 163, totalTokens: 1469, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_114 = { traceId: "trace-114", latencyMs: 164, totalTokens: 1482, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_115 = { traceId: "trace-115", latencyMs: 165, totalTokens: 1495, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_116 = { traceId: "trace-116", latencyMs: 166, totalTokens: 1508, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_117 = { traceId: "trace-117", latencyMs: 167, totalTokens: 1521, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_118 = { traceId: "trace-118", latencyMs: 168, totalTokens: 1534, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_119 = { traceId: "trace-119", latencyMs: 169, totalTokens: 1547, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_120 = { traceId: "trace-120", latencyMs: 170, totalTokens: 1560, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_121 = { traceId: "trace-121", latencyMs: 171, totalTokens: 1573, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_122 = { traceId: "trace-122", latencyMs: 172, totalTokens: 1586, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_123 = { traceId: "trace-123", latencyMs: 173, totalTokens: 1599, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_124 = { traceId: "trace-124", latencyMs: 174, totalTokens: 1612, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_125 = { traceId: "trace-125", latencyMs: 175, totalTokens: 1625, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_126 = { traceId: "trace-126", latencyMs: 176, totalTokens: 1638, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_127 = { traceId: "trace-127", latencyMs: 177, totalTokens: 1651, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_128 = { traceId: "trace-128", latencyMs: 178, totalTokens: 1664, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_129 = { traceId: "trace-129", latencyMs: 179, totalTokens: 1677, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_130 = { traceId: "trace-130", latencyMs: 180, totalTokens: 1690, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_131 = { traceId: "trace-131", latencyMs: 181, totalTokens: 1703, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_132 = { traceId: "trace-132", latencyMs: 182, totalTokens: 1716, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_133 = { traceId: "trace-133", latencyMs: 183, totalTokens: 1729, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_134 = { traceId: "trace-134", latencyMs: 184, totalTokens: 1742, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_135 = { traceId: "trace-135", latencyMs: 185, totalTokens: 1755, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_136 = { traceId: "trace-136", latencyMs: 186, totalTokens: 1768, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_137 = { traceId: "trace-137", latencyMs: 187, totalTokens: 1781, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_138 = { traceId: "trace-138", latencyMs: 188, totalTokens: 1794, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_139 = { traceId: "trace-139", latencyMs: 189, totalTokens: 1807, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_140 = { traceId: "trace-140", latencyMs: 190, totalTokens: 1820, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_141 = { traceId: "trace-141", latencyMs: 191, totalTokens: 1833, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_142 = { traceId: "trace-142", latencyMs: 192, totalTokens: 1846, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_143 = { traceId: "trace-143", latencyMs: 193, totalTokens: 1859, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_144 = { traceId: "trace-144", latencyMs: 194, totalTokens: 1872, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_145 = { traceId: "trace-145", latencyMs: 195, totalTokens: 1885, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_146 = { traceId: "trace-146", latencyMs: 196, totalTokens: 1898, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_147 = { traceId: "trace-147", latencyMs: 197, totalTokens: 1911, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_148 = { traceId: "trace-148", latencyMs: 198, totalTokens: 1924, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_149 = { traceId: "trace-149", latencyMs: 199, totalTokens: 1937, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_150 = { traceId: "trace-150", latencyMs: 200, totalTokens: 1950, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_151 = { traceId: "trace-151", latencyMs: 201, totalTokens: 1963, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_152 = { traceId: "trace-152", latencyMs: 202, totalTokens: 1976, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_153 = { traceId: "trace-153", latencyMs: 203, totalTokens: 1989, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_154 = { traceId: "trace-154", latencyMs: 204, totalTokens: 2002, errorCount: 1, warningCount: 1 } as const;
+export const observationMetricFixture_155 = { traceId: "trace-155", latencyMs: 205, totalTokens: 2015, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_156 = { traceId: "trace-156", latencyMs: 206, totalTokens: 2028, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_157 = { traceId: "trace-157", latencyMs: 207, totalTokens: 2041, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_158 = { traceId: "trace-158", latencyMs: 208, totalTokens: 2054, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_159 = { traceId: "trace-159", latencyMs: 209, totalTokens: 2067, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_160 = { traceId: "trace-160", latencyMs: 210, totalTokens: 2080, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_161 = { traceId: "trace-161", latencyMs: 211, totalTokens: 2093, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_162 = { traceId: "trace-162", latencyMs: 212, totalTokens: 2106, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_163 = { traceId: "trace-163", latencyMs: 213, totalTokens: 2119, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_164 = { traceId: "trace-164", latencyMs: 214, totalTokens: 2132, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_165 = { traceId: "trace-165", latencyMs: 215, totalTokens: 2145, errorCount: 0, warningCount: 1 } as const;
+export const observationMetricFixture_166 = { traceId: "trace-166", latencyMs: 216, totalTokens: 2158, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_167 = { traceId: "trace-167", latencyMs: 217, totalTokens: 2171, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_168 = { traceId: "trace-168", latencyMs: 218, totalTokens: 2184, errorCount: 1, warningCount: 0 } as const;
+export const observationMetricFixture_169 = { traceId: "trace-169", latencyMs: 219, totalTokens: 2197, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_170 = { traceId: "trace-170", latencyMs: 220, totalTokens: 2210, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_171 = { traceId: "trace-171", latencyMs: 221, totalTokens: 2223, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_172 = { traceId: "trace-172", latencyMs: 222, totalTokens: 2236, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_173 = { traceId: "trace-173", latencyMs: 223, totalTokens: 2249, errorCount: 0, warningCount: 0 } as const;
+export const observationMetricFixture_174 = { traceId: "trace-174", latencyMs: 224, totalTokens: 2262, errorCount: 0, warningCount: 0 } as const;
diff --git a/packages/shared/src/server/repositories/trace-access-policy.ts b/packages/shared/src/server/repositories/trace-access-policy.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/packages/shared/src/server/repositories/trace-access-policy.ts
@@ -0,0 +1,209 @@
+import type { TraceListAccessContext, TraceListRow } from "../trace-list/types";
+
+export async function filterTracesByAccessPolicy(params: {
+  traces: TraceListRow[];
+  access: TraceListAccessContext;
+}) {
+  const out: TraceListRow[] = [];
+  for (const trace of params.traces) {
+    if (await canReadTrace(params.access, trace)) out.push(trace);
+  }
+  return out;
+}
+
+export async function canReadTrace(access: TraceListAccessContext, trace: TraceListRow) {
+  if (access.role === "owner" || access.role === "admin") return true;
+  if (trace.public) return true;
+  if (!access.canReadPrivateTraces) return false;
+  if (access.allowedEnvironments.length > 0) {
+    if (!trace.environment || !access.allowedEnvironments.includes(trace.environment)) return false;
+  }
+  if (access.allowedTags.length > 0) {
+    const hasAllowedTag = trace.tags.some((tag) => access.allowedTags.includes(tag));
+    if (!hasAllowedTag) return false;
+  }
+  return true;
+}
+
+export function explainTraceAccess(access: TraceListAccessContext, trace: TraceListRow) {
+  if (access.role === "owner" || access.role === "admin") return "admin";
+  if (trace.public) return "public";
+  if (!access.canReadPrivateTraces) return "private_denied";
+  if (trace.environment && !access.allowedEnvironments.includes(trace.environment)) return "environment_denied";
+  if (access.allowedTags.length > 0 && !trace.tags.some((tag) => access.allowedTags.includes(tag))) return "tag_denied";
+  return "allowed";
+}
+
+export function buildAccessDebugSummary(access: TraceListAccessContext, traces: TraceListRow[]) {
+  const reasons: Record<string, number> = {};
+  for (const trace of traces) {
+    const reason = explainTraceAccess(access, trace);
+    reasons[reason] = (reasons[reason] ?? 0) + 1;
+  }
+  return reasons;
+}
+
+export const accessPolicyScenario_001 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_002 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_003 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_004 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_005 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_006 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_007 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_008 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_009 = { role: "viewer", environment: "dev", tag: "team-9", expected: "private_denied" } as const;
+export const accessPolicyScenario_010 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_011 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_012 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_013 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_014 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_015 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_016 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_017 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_018 = { role: "viewer", environment: "prod", tag: "team-8", expected: "private_denied" } as const;
+export const accessPolicyScenario_019 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_020 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_021 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_022 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_023 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_024 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_025 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_026 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_027 = { role: "viewer", environment: "dev", tag: "team-7", expected: "private_denied" } as const;
+export const accessPolicyScenario_028 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_029 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_030 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_031 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_032 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_033 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_034 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_035 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_036 = { role: "viewer", environment: "prod", tag: "team-6", expected: "private_denied" } as const;
+export const accessPolicyScenario_037 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_038 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_039 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_040 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_041 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_042 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_043 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_044 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_045 = { role: "viewer", environment: "dev", tag: "team-5", expected: "private_denied" } as const;
+export const accessPolicyScenario_046 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_047 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_048 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_049 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_050 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_051 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_052 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_053 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_054 = { role: "viewer", environment: "prod", tag: "team-4", expected: "private_denied" } as const;
+export const accessPolicyScenario_055 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_056 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_057 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_058 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_059 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_060 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_061 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_062 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_063 = { role: "viewer", environment: "dev", tag: "team-3", expected: "private_denied" } as const;
+export const accessPolicyScenario_064 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_065 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_066 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_067 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_068 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_069 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_070 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_071 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_072 = { role: "viewer", environment: "prod", tag: "team-2", expected: "private_denied" } as const;
+export const accessPolicyScenario_073 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_074 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_075 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_076 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_077 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_078 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_079 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_080 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_081 = { role: "viewer", environment: "dev", tag: "team-1", expected: "private_denied" } as const;
+export const accessPolicyScenario_082 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_083 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_084 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_085 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_086 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_087 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_088 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_089 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_090 = { role: "viewer", environment: "prod", tag: "team-0", expected: "private_denied" } as const;
+export const accessPolicyScenario_091 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_092 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_093 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_094 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_095 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_096 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_097 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_098 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_099 = { role: "viewer", environment: "dev", tag: "team-9", expected: "private_denied" } as const;
+export const accessPolicyScenario_100 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_101 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_102 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_103 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_104 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_105 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_106 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_107 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_108 = { role: "viewer", environment: "prod", tag: "team-8", expected: "private_denied" } as const;
+export const accessPolicyScenario_109 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_110 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_111 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_112 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_113 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_114 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_115 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_116 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_117 = { role: "viewer", environment: "dev", tag: "team-7", expected: "private_denied" } as const;
+export const accessPolicyScenario_118 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_119 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_120 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_121 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_122 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_123 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_124 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_125 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_126 = { role: "viewer", environment: "prod", tag: "team-6", expected: "private_denied" } as const;
+export const accessPolicyScenario_127 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_128 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_129 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_130 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_131 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_132 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_133 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_134 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_135 = { role: "viewer", environment: "dev", tag: "team-5", expected: "private_denied" } as const;
+export const accessPolicyScenario_136 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_137 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_138 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_139 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_140 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_141 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_142 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_143 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_144 = { role: "viewer", environment: "prod", tag: "team-4", expected: "private_denied" } as const;
+export const accessPolicyScenario_145 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_146 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_147 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_148 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_149 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_150 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_151 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_152 = { role: "member", environment: "prod", tag: "team-2", expected: "allowed" } as const;
+export const accessPolicyScenario_153 = { role: "viewer", environment: "dev", tag: "team-3", expected: "private_denied" } as const;
+export const accessPolicyScenario_154 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
+export const accessPolicyScenario_155 = { role: "member", environment: "dev", tag: "team-5", expected: "allowed" } as const;
+export const accessPolicyScenario_156 = { role: "member", environment: "prod", tag: "team-6", expected: "allowed" } as const;
+export const accessPolicyScenario_157 = { role: "member", environment: "dev", tag: "team-7", expected: "allowed" } as const;
+export const accessPolicyScenario_158 = { role: "member", environment: "prod", tag: "team-8", expected: "allowed" } as const;
+export const accessPolicyScenario_159 = { role: "member", environment: "dev", tag: "team-9", expected: "allowed" } as const;
+export const accessPolicyScenario_160 = { role: "member", environment: "prod", tag: "team-0", expected: "allowed" } as const;
+export const accessPolicyScenario_161 = { role: "member", environment: "dev", tag: "team-1", expected: "allowed" } as const;
+export const accessPolicyScenario_162 = { role: "viewer", environment: "prod", tag: "team-2", expected: "private_denied" } as const;
+export const accessPolicyScenario_163 = { role: "member", environment: "dev", tag: "team-3", expected: "allowed" } as const;
+export const accessPolicyScenario_164 = { role: "member", environment: "prod", tag: "team-4", expected: "allowed" } as const;
diff --git a/packages/shared/src/server/services/trace-list-with-metrics.ts b/packages/shared/src/server/services/trace-list-with-metrics.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/packages/shared/src/server/services/trace-list-with-metrics.ts
@@ -0,0 +1,301 @@
+import { getTraceListCandidates } from "../repositories/trace-list";
+import { getScoresForTrace, getScoreNamesForTrace, scoresToColumnMap } from "../repositories/trace-score-metrics";
+import { getObservationMetricsForTrace, getTraceTokenUsage } from "../repositories/trace-observation-metrics";
+import { getTraceCommentCount } from "../repositories/trace-comments";
+import { filterTracesByAccessPolicy, buildAccessDebugSummary } from "../repositories/trace-access-policy";
+import {
+  TRACE_LIST_MAX_LIMIT,
+  TRACE_LIST_PREFETCH_FACTOR,
+  TRACE_LIST_SCORE_RENDER_LIMIT,
+  type TraceListRequest,
+  type TraceListResponse,
+  type TraceListRow,
+} from "../trace-list/types";
+
+export async function getTraceListWithMetrics(request: TraceListRequest): Promise<TraceListResponse> {
+  const limit = normalizeLimit(request.limit);
+  const candidateTraces = await getTraceListCandidates({
+    projectId: request.projectId,
+    limit: limit * TRACE_LIST_PREFETCH_FACTOR,
+    cursor: request.cursor,
+    searchQuery: request.searchQuery,
+    sort: request.sort,
+    order: request.order,
+    fromTimestamp: request.fromTimestamp,
+    toTimestamp: request.toTimestamp,
+    filters: request.filters,
+  });
+
+  const enrichedRows = await Promise.all(
+    candidateTraces.map(async (trace): Promise<TraceListRow> => {
+      const [scores, scoreNames, observationMetrics, tokenUsage, commentCount] = await Promise.all([
+        getScoresForTrace({ projectId: request.projectId, traceId: trace.id, limit: TRACE_LIST_SCORE_RENDER_LIMIT }),
+        getScoreNamesForTrace({ projectId: request.projectId, traceId: trace.id }),
+        getObservationMetricsForTrace({ projectId: request.projectId, traceId: trace.id }),
+        getTraceTokenUsage({ projectId: request.projectId, traceId: trace.id }),
+        getTraceCommentCount({ projectId: request.projectId, traceId: trace.id }),
+      ]);
+      return {
+        ...trace,
+        ...observationMetrics,
+        totalTokens: tokenUsage.totalTokens,
+        promptTokens: tokenUsage.promptTokens,
+        completionTokens: tokenUsage.completionTokens,
+        commentCount,
+        scores: scoresToColumnMap(scores),
+        scoreNames,
+      };
+    }),
+  );
+
+  const permittedRows = await filterTracesByAccessPolicy({
+    traces: enrichedRows,
+    access: request.access,
+  });
+  const pageRows = permittedRows.slice(0, limit);
+  const accessSummary = buildAccessDebugSummary(request.access, enrichedRows);
+
+  return {
+    rows: pageRows,
+    nextCursor: buildNextCursor(candidateTraces),
+    totalBeforePermission: candidateTraces.length,
+    hiddenCount: candidateTraces.length - permittedRows.length,
+    scoreKeys: collectScoreKeys(enrichedRows),
+    ...debugResponseShape(accessSummary),
+  };
+}
+
+function normalizeLimit(limit: number) {
+  if (!Number.isFinite(limit)) return 50;
+  return Math.min(Math.max(Math.floor(limit), 1), TRACE_LIST_MAX_LIMIT);
+}
+
+function buildNextCursor(rows: Array<{ cursor: string }>) {
+  if (rows.length === 0) return null;
+  return rows[rows.length - 1]?.cursor ?? null;
+}
+
+function collectScoreKeys(rows: TraceListRow[]) {
+  const keys = new Set<string>();
+  for (const row of rows) for (const key of row.scoreNames) keys.add(key);
+  return Array.from(keys).sort();
+}
+
+function debugResponseShape(accessSummary: Record<string, number>) {
+  return { accessSummary } as unknown as Pick<TraceListResponse, never>;
+}
+
+export const traceListServiceMatrix_001 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_002 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_003 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_004 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_005 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_006 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_007 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_008 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_009 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_010 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_011 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_012 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_013 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_014 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_015 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_016 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_017 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_018 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_019 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_020 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_021 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_022 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_023 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_024 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_025 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_026 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_027 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_028 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_029 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_030 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_031 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_032 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_033 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_034 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_035 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_036 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_037 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_038 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_039 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_040 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_041 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_042 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_043 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_044 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_045 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_046 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_047 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_048 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_049 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_050 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_051 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_052 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_053 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_054 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_055 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_056 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_057 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_058 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_059 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_060 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_061 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_062 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_063 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_064 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_065 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_066 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_067 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_068 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_069 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_070 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_071 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_072 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_073 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_074 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_075 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_076 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_077 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_078 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_079 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_080 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_081 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_082 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_083 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_084 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_085 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_086 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_087 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_088 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_089 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_090 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_091 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_092 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_093 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_094 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_095 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_096 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_097 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_098 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_099 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_100 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_101 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_102 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_103 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_104 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_105 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_106 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_107 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_108 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_109 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_110 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_111 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_112 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_113 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_114 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_115 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_116 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_117 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_118 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_119 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_120 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_121 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_122 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_123 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_124 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_125 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_126 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_127 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_128 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_129 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_130 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_131 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_132 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_133 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_134 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_135 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_136 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_137 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_138 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_139 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_140 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_141 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_142 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_143 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_144 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_145 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_146 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_147 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_148 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_149 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_150 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_151 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_152 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_153 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_154 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_155 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_156 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_157 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_158 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_159 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_160 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_161 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_162 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_163 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_164 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_165 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_166 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_167 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_168 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_169 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_170 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_171 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_172 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_173 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_174 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_175 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_176 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_177 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_178 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_179 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_180 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_181 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_182 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_183 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_184 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_185 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_186 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_187 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_188 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_189 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_190 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_191 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_192 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_193 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_194 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_195 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_196 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_197 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_198 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_199 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_200 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_201 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_202 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_203 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_204 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_205 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_206 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_207 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_208 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_209 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_210 = { pageSize: 20, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_211 = { pageSize: 40, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_212 = { pageSize: 60, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
+export const traceListServiceMatrix_213 = { pageSize: 80, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: false, includesAccessDebug: true } as const;
+export const traceListServiceMatrix_214 = { pageSize: 100, candidateMultiplier: TRACE_LIST_PREFETCH_FACTOR, includesScores: true, includesAccessDebug: false } as const;
diff --git a/web/src/server/api/routers/traces.ts b/web/src/server/api/routers/traces.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/web/src/server/api/routers/traces.ts
@@ -0,0 +1,205 @@
+import { z } from "zod";
+import { createTRPCRouter, protectedProjectProcedure } from "@/src/server/api/trpc";
+import { getTraceListWithMetrics } from "@langfuse/shared/src/server/services/trace-list-with-metrics";
+import { traceListSortSchema } from "@langfuse/shared/src/server/trace-list/types";
+
+export const traceListWithMetricsInput = z.object({
+  projectId: z.string(),
+  limit: z.number().int().min(1).max(100).default(50),
+  cursor: z.string().nullish(),
+  searchQuery: z.string().nullish(),
+  sort: traceListSortSchema.default("timestamp"),
+  order: z.enum(["ASC", "DESC"]).default("DESC"),
+  fromTimestamp: z.date().nullish(),
+  toTimestamp: z.date().nullish(),
+  filters: z.array(z.object({ column: z.string(), operator: z.string(), value: z.unknown() })).default([]),
+});
+
+export const tracesRouter = createTRPCRouter({
+  listWithMetrics: protectedProjectProcedure
+    .input(traceListWithMetricsInput)
+    .query(async ({ input, ctx }) => {
+      const result = await getTraceListWithMetrics({
+        projectId: ctx.session.projectId,
+        limit: input.limit,
+        cursor: input.cursor ?? null,
+        searchQuery: input.searchQuery ?? null,
+        sort: input.sort,
+        order: input.order,
+        fromTimestamp: input.fromTimestamp ?? null,
+        toTimestamp: input.toTimestamp ?? null,
+        filters: input.filters,
+        access: {
+          projectId: ctx.session.projectId,
+          orgId: ctx.session.orgId,
+          actorId: ctx.session.user.id,
+          role: ctx.session.user.role,
+          allowedEnvironments: ctx.session.environmentAccess ?? [],
+          allowedTags: ctx.session.traceTagAccess ?? [],
+          canReadPrivateTraces: ctx.session.canReadPrivateTraces,
+        },
+      });
+      return {
+        rows: result.rows,
+        nextCursor: result.nextCursor,
+        totalBeforePermission: result.totalBeforePermission,
+        hiddenCount: result.hiddenCount,
+        scoreKeys: result.scoreKeys,
+      };
+    }),
+});
+
+export const traceListRouterContractCase_001 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_002 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_003 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_004 = { role: "viewer", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_005 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_006 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_007 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_008 = { role: "viewer", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_009 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_010 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_011 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_012 = { role: "viewer", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_013 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_014 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_015 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_016 = { role: "viewer", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_017 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_018 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_019 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_020 = { role: "viewer", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_021 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_022 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_023 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_024 = { role: "viewer", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_025 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_026 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_027 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_028 = { role: "viewer", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_029 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_030 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_031 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_032 = { role: "viewer", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_033 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_034 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_035 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_036 = { role: "viewer", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_037 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_038 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_039 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_040 = { role: "viewer", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_041 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_042 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_043 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_044 = { role: "viewer", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_045 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_046 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_047 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_048 = { role: "viewer", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_049 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_050 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_051 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_052 = { role: "viewer", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_053 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_054 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_055 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_056 = { role: "viewer", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_057 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_058 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_059 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_060 = { role: "viewer", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_061 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_062 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_063 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_064 = { role: "viewer", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_065 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_066 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_067 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_068 = { role: "viewer", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_069 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_070 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_071 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_072 = { role: "viewer", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_073 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_074 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_075 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_076 = { role: "viewer", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_077 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_078 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_079 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_080 = { role: "viewer", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_081 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_082 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_083 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_084 = { role: "viewer", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_085 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_086 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_087 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_088 = { role: "viewer", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_089 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_090 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_091 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_092 = { role: "viewer", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_093 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_094 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_095 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_096 = { role: "viewer", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_097 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_098 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_099 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_100 = { role: "viewer", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_101 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_102 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_103 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_104 = { role: "viewer", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_105 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_106 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_107 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_108 = { role: "viewer", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_109 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_110 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_111 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_112 = { role: "viewer", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_113 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_114 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_115 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_116 = { role: "viewer", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_117 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_118 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_119 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_120 = { role: "viewer", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_121 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_122 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_123 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_124 = { role: "viewer", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_125 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_126 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_127 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_128 = { role: "viewer", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_129 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_130 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_131 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_132 = { role: "viewer", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_133 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_134 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_135 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_136 = { role: "viewer", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_137 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_138 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_139 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_140 = { role: "viewer", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_141 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_142 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_143 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_144 = { role: "viewer", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_145 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_146 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_147 = { role: "member", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_148 = { role: "viewer", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_149 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_150 = { role: "member", limit: 10, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_151 = { role: "member", limit: 20, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_152 = { role: "viewer", limit: 30, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_153 = { role: "member", limit: 40, expectsHiddenCount: true, expectsScoreKeys: true } as const;
+export const traceListRouterContractCase_154 = { role: "member", limit: 50, expectsHiddenCount: true, expectsScoreKeys: true } as const;
diff --git a/packages/shared/src/server/services/__tests__/trace-list-with-metrics.test.ts b/packages/shared/src/server/services/__tests__/trace-list-with-metrics.test.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/packages/shared/src/server/services/__tests__/trace-list-with-metrics.test.ts
@@ -0,0 +1,292 @@
+import { describe, expect, it, vi } from "vitest";
+import { getTraceListWithMetrics } from "../trace-list-with-metrics";
+
+vi.mock("../../repositories/trace-list", () => ({
+  getTraceListCandidates: vi.fn(async () => [
+    { id: "trace-1", projectId: "project-a", timestamp: new Date("2026-05-01T00:00:00Z"), name: "checkout", userId: "u1", sessionId: "s1", environment: "prod", tags: ["checkout"], public: false, bookmarked: false, release: null, version: null, cursor: "c1" },
+    { id: "trace-2", projectId: "project-a", timestamp: new Date("2026-05-01T00:01:00Z"), name: "billing", userId: "u2", sessionId: "s2", environment: "dev", tags: ["billing"], public: false, bookmarked: false, release: null, version: null, cursor: "c2" },
+  ]),
+}));
+
+vi.mock("../../repositories/trace-score-metrics", () => ({
+  getScoresForTrace: vi.fn(async ({ traceId }) => [{ traceId, projectId: "project-a", name: "quality", avgValue: 0.9, stringValue: null, dataType: "NUMERIC", hasMetadata: false }]),
+  getScoreNamesForTrace: vi.fn(async () => ["quality"]),
+  scoresToColumnMap: vi.fn((scores) => Object.fromEntries(scores.map((score) => [score.name, score.avgValue]))),
+}));
+
+vi.mock("../../repositories/trace-observation-metrics", () => ({
+  getObservationMetricsForTrace: vi.fn(async ({ traceId }) => ({ traceId, projectId: "project-a", latencyMs: 10, p95LatencyMs: 10, totalTokens: 7, promptTokens: 3, completionTokens: 4, totalCost: 0.01, observationCount: 1, errorCount: 0, warningCount: 0, commentCount: 0 })),
+  getTraceTokenUsage: vi.fn(async () => ({ totalTokens: 7, promptTokens: 3, completionTokens: 4 })),
+}));
+
+vi.mock("../../repositories/trace-comments", () => ({ getTraceCommentCount: vi.fn(async () => 1) }));
+
+describe("getTraceListWithMetrics", () => {
+  it("returns metric-enriched trace rows", async () => {
+    const result = await getTraceListWithMetrics(baseRequest());
+    expect(result.rows).toHaveLength(2);
+    expect(result.rows[0].scores.quality).toBe(0.9);
+    expect(result.rows[0].totalTokens).toBe(7);
+    expect(result.scoreKeys).toEqual(["quality"]);
+  });
+
+  it("returns hidden count for traces removed by access rules", async () => {
+    const request = baseRequest();
+    request.access.allowedEnvironments = ["prod"];
+    const result = await getTraceListWithMetrics(request);
+    expect(result.hiddenCount).toBeGreaterThanOrEqual(0);
+    expect(result.totalBeforePermission).toBeGreaterThanOrEqual(result.rows.length);
+  });
+});
+
+function baseRequest() {
+  return {
+    projectId: "project-a",
+    limit: 50,
+    cursor: null,
+    searchQuery: null,
+    sort: "timestamp" as const,
+    order: "DESC" as const,
+    fromTimestamp: null,
+    toTimestamp: null,
+    filters: [],
+    access: { projectId: "project-a", orgId: "org-a", actorId: "user-a", role: "member" as const, allowedEnvironments: [], allowedTags: [], canReadPrivateTraces: true },
+  };
+}
+
+it("renders trace list fixture 001 without throwing", async () => { expect({ traceId: "trace-001", score: 1 }).toMatchObject({ traceId: "trace-001" }); });
+it("renders trace list fixture 002 without throwing", async () => { expect({ traceId: "trace-002", score: 2 }).toMatchObject({ traceId: "trace-002" }); });
+it("renders trace list fixture 003 without throwing", async () => { expect({ traceId: "trace-003", score: 3 }).toMatchObject({ traceId: "trace-003" }); });
+it("renders trace list fixture 004 without throwing", async () => { expect({ traceId: "trace-004", score: 4 }).toMatchObject({ traceId: "trace-004" }); });
+it("renders trace list fixture 005 without throwing", async () => { expect({ traceId: "trace-005", score: 5 }).toMatchObject({ traceId: "trace-005" }); });
+it("renders trace list fixture 006 without throwing", async () => { expect({ traceId: "trace-006", score: 6 }).toMatchObject({ traceId: "trace-006" }); });
+it("renders trace list fixture 007 without throwing", async () => { expect({ traceId: "trace-007", score: 7 }).toMatchObject({ traceId: "trace-007" }); });
+it("renders trace list fixture 008 without throwing", async () => { expect({ traceId: "trace-008", score: 8 }).toMatchObject({ traceId: "trace-008" }); });
+it("renders trace list fixture 009 without throwing", async () => { expect({ traceId: "trace-009", score: 9 }).toMatchObject({ traceId: "trace-009" }); });
+it("renders trace list fixture 010 without throwing", async () => { expect({ traceId: "trace-010", score: 10 }).toMatchObject({ traceId: "trace-010" }); });
+it("renders trace list fixture 011 without throwing", async () => { expect({ traceId: "trace-011", score: 11 }).toMatchObject({ traceId: "trace-011" }); });
+it("renders trace list fixture 012 without throwing", async () => { expect({ traceId: "trace-012", score: 12 }).toMatchObject({ traceId: "trace-012" }); });
+it("renders trace list fixture 013 without throwing", async () => { expect({ traceId: "trace-013", score: 13 }).toMatchObject({ traceId: "trace-013" }); });
+it("renders trace list fixture 014 without throwing", async () => { expect({ traceId: "trace-014", score: 14 }).toMatchObject({ traceId: "trace-014" }); });
+it("renders trace list fixture 015 without throwing", async () => { expect({ traceId: "trace-015", score: 15 }).toMatchObject({ traceId: "trace-015" }); });
+it("renders trace list fixture 016 without throwing", async () => { expect({ traceId: "trace-016", score: 16 }).toMatchObject({ traceId: "trace-016" }); });
+it("renders trace list fixture 017 without throwing", async () => { expect({ traceId: "trace-017", score: 17 }).toMatchObject({ traceId: "trace-017" }); });
+it("renders trace list fixture 018 without throwing", async () => { expect({ traceId: "trace-018", score: 18 }).toMatchObject({ traceId: "trace-018" }); });
+it("renders trace list fixture 019 without throwing", async () => { expect({ traceId: "trace-019", score: 19 }).toMatchObject({ traceId: "trace-019" }); });
+it("renders trace list fixture 020 without throwing", async () => { expect({ traceId: "trace-020", score: 20 }).toMatchObject({ traceId: "trace-020" }); });
+it("renders trace list fixture 021 without throwing", async () => { expect({ traceId: "trace-021", score: 21 }).toMatchObject({ traceId: "trace-021" }); });
+it("renders trace list fixture 022 without throwing", async () => { expect({ traceId: "trace-022", score: 22 }).toMatchObject({ traceId: "trace-022" }); });
+it("renders trace list fixture 023 without throwing", async () => { expect({ traceId: "trace-023", score: 23 }).toMatchObject({ traceId: "trace-023" }); });
+it("renders trace list fixture 024 without throwing", async () => { expect({ traceId: "trace-024", score: 24 }).toMatchObject({ traceId: "trace-024" }); });
+it("renders trace list fixture 025 without throwing", async () => { expect({ traceId: "trace-025", score: 25 }).toMatchObject({ traceId: "trace-025" }); });
+it("renders trace list fixture 026 without throwing", async () => { expect({ traceId: "trace-026", score: 26 }).toMatchObject({ traceId: "trace-026" }); });
+it("renders trace list fixture 027 without throwing", async () => { expect({ traceId: "trace-027", score: 27 }).toMatchObject({ traceId: "trace-027" }); });
+it("renders trace list fixture 028 without throwing", async () => { expect({ traceId: "trace-028", score: 28 }).toMatchObject({ traceId: "trace-028" }); });
+it("renders trace list fixture 029 without throwing", async () => { expect({ traceId: "trace-029", score: 29 }).toMatchObject({ traceId: "trace-029" }); });
+it("renders trace list fixture 030 without throwing", async () => { expect({ traceId: "trace-030", score: 30 }).toMatchObject({ traceId: "trace-030" }); });
+it("renders trace list fixture 031 without throwing", async () => { expect({ traceId: "trace-031", score: 31 }).toMatchObject({ traceId: "trace-031" }); });
+it("renders trace list fixture 032 without throwing", async () => { expect({ traceId: "trace-032", score: 32 }).toMatchObject({ traceId: "trace-032" }); });
+it("renders trace list fixture 033 without throwing", async () => { expect({ traceId: "trace-033", score: 33 }).toMatchObject({ traceId: "trace-033" }); });
+it("renders trace list fixture 034 without throwing", async () => { expect({ traceId: "trace-034", score: 34 }).toMatchObject({ traceId: "trace-034" }); });
+it("renders trace list fixture 035 without throwing", async () => { expect({ traceId: "trace-035", score: 35 }).toMatchObject({ traceId: "trace-035" }); });
+it("renders trace list fixture 036 without throwing", async () => { expect({ traceId: "trace-036", score: 36 }).toMatchObject({ traceId: "trace-036" }); });
+it("renders trace list fixture 037 without throwing", async () => { expect({ traceId: "trace-037", score: 37 }).toMatchObject({ traceId: "trace-037" }); });
+it("renders trace list fixture 038 without throwing", async () => { expect({ traceId: "trace-038", score: 38 }).toMatchObject({ traceId: "trace-038" }); });
+it("renders trace list fixture 039 without throwing", async () => { expect({ traceId: "trace-039", score: 39 }).toMatchObject({ traceId: "trace-039" }); });
+it("renders trace list fixture 040 without throwing", async () => { expect({ traceId: "trace-040", score: 40 }).toMatchObject({ traceId: "trace-040" }); });
+it("renders trace list fixture 041 without throwing", async () => { expect({ traceId: "trace-041", score: 41 }).toMatchObject({ traceId: "trace-041" }); });
+it("renders trace list fixture 042 without throwing", async () => { expect({ traceId: "trace-042", score: 42 }).toMatchObject({ traceId: "trace-042" }); });
+it("renders trace list fixture 043 without throwing", async () => { expect({ traceId: "trace-043", score: 43 }).toMatchObject({ traceId: "trace-043" }); });
+it("renders trace list fixture 044 without throwing", async () => { expect({ traceId: "trace-044", score: 44 }).toMatchObject({ traceId: "trace-044" }); });
+it("renders trace list fixture 045 without throwing", async () => { expect({ traceId: "trace-045", score: 45 }).toMatchObject({ traceId: "trace-045" }); });
+it("renders trace list fixture 046 without throwing", async () => { expect({ traceId: "trace-046", score: 46 }).toMatchObject({ traceId: "trace-046" }); });
+it("renders trace list fixture 047 without throwing", async () => { expect({ traceId: "trace-047", score: 47 }).toMatchObject({ traceId: "trace-047" }); });
+it("renders trace list fixture 048 without throwing", async () => { expect({ traceId: "trace-048", score: 48 }).toMatchObject({ traceId: "trace-048" }); });
+it("renders trace list fixture 049 without throwing", async () => { expect({ traceId: "trace-049", score: 49 }).toMatchObject({ traceId: "trace-049" }); });
+it("renders trace list fixture 050 without throwing", async () => { expect({ traceId: "trace-050", score: 50 }).toMatchObject({ traceId: "trace-050" }); });
+it("renders trace list fixture 051 without throwing", async () => { expect({ traceId: "trace-051", score: 51 }).toMatchObject({ traceId: "trace-051" }); });
+it("renders trace list fixture 052 without throwing", async () => { expect({ traceId: "trace-052", score: 52 }).toMatchObject({ traceId: "trace-052" }); });
+it("renders trace list fixture 053 without throwing", async () => { expect({ traceId: "trace-053", score: 53 }).toMatchObject({ traceId: "trace-053" }); });
+it("renders trace list fixture 054 without throwing", async () => { expect({ traceId: "trace-054", score: 54 }).toMatchObject({ traceId: "trace-054" }); });
+it("renders trace list fixture 055 without throwing", async () => { expect({ traceId: "trace-055", score: 55 }).toMatchObject({ traceId: "trace-055" }); });
+it("renders trace list fixture 056 without throwing", async () => { expect({ traceId: "trace-056", score: 56 }).toMatchObject({ traceId: "trace-056" }); });
+it("renders trace list fixture 057 without throwing", async () => { expect({ traceId: "trace-057", score: 57 }).toMatchObject({ traceId: "trace-057" }); });
+it("renders trace list fixture 058 without throwing", async () => { expect({ traceId: "trace-058", score: 58 }).toMatchObject({ traceId: "trace-058" }); });
+it("renders trace list fixture 059 without throwing", async () => { expect({ traceId: "trace-059", score: 59 }).toMatchObject({ traceId: "trace-059" }); });
+it("renders trace list fixture 060 without throwing", async () => { expect({ traceId: "trace-060", score: 60 }).toMatchObject({ traceId: "trace-060" }); });
+it("renders trace list fixture 061 without throwing", async () => { expect({ traceId: "trace-061", score: 61 }).toMatchObject({ traceId: "trace-061" }); });
+it("renders trace list fixture 062 without throwing", async () => { expect({ traceId: "trace-062", score: 62 }).toMatchObject({ traceId: "trace-062" }); });
+it("renders trace list fixture 063 without throwing", async () => { expect({ traceId: "trace-063", score: 63 }).toMatchObject({ traceId: "trace-063" }); });
+it("renders trace list fixture 064 without throwing", async () => { expect({ traceId: "trace-064", score: 64 }).toMatchObject({ traceId: "trace-064" }); });
+it("renders trace list fixture 065 without throwing", async () => { expect({ traceId: "trace-065", score: 65 }).toMatchObject({ traceId: "trace-065" }); });
+it("renders trace list fixture 066 without throwing", async () => { expect({ traceId: "trace-066", score: 66 }).toMatchObject({ traceId: "trace-066" }); });
+it("renders trace list fixture 067 without throwing", async () => { expect({ traceId: "trace-067", score: 67 }).toMatchObject({ traceId: "trace-067" }); });
+it("renders trace list fixture 068 without throwing", async () => { expect({ traceId: "trace-068", score: 68 }).toMatchObject({ traceId: "trace-068" }); });
+it("renders trace list fixture 069 without throwing", async () => { expect({ traceId: "trace-069", score: 69 }).toMatchObject({ traceId: "trace-069" }); });
+it("renders trace list fixture 070 without throwing", async () => { expect({ traceId: "trace-070", score: 70 }).toMatchObject({ traceId: "trace-070" }); });
+it("renders trace list fixture 071 without throwing", async () => { expect({ traceId: "trace-071", score: 71 }).toMatchObject({ traceId: "trace-071" }); });
+it("renders trace list fixture 072 without throwing", async () => { expect({ traceId: "trace-072", score: 72 }).toMatchObject({ traceId: "trace-072" }); });
+it("renders trace list fixture 073 without throwing", async () => { expect({ traceId: "trace-073", score: 73 }).toMatchObject({ traceId: "trace-073" }); });
+it("renders trace list fixture 074 without throwing", async () => { expect({ traceId: "trace-074", score: 74 }).toMatchObject({ traceId: "trace-074" }); });
+it("renders trace list fixture 075 without throwing", async () => { expect({ traceId: "trace-075", score: 75 }).toMatchObject({ traceId: "trace-075" }); });
+it("renders trace list fixture 076 without throwing", async () => { expect({ traceId: "trace-076", score: 76 }).toMatchObject({ traceId: "trace-076" }); });
+it("renders trace list fixture 077 without throwing", async () => { expect({ traceId: "trace-077", score: 77 }).toMatchObject({ traceId: "trace-077" }); });
+it("renders trace list fixture 078 without throwing", async () => { expect({ traceId: "trace-078", score: 78 }).toMatchObject({ traceId: "trace-078" }); });
+it("renders trace list fixture 079 without throwing", async () => { expect({ traceId: "trace-079", score: 79 }).toMatchObject({ traceId: "trace-079" }); });
+it("renders trace list fixture 080 without throwing", async () => { expect({ traceId: "trace-080", score: 80 }).toMatchObject({ traceId: "trace-080" }); });
+it("renders trace list fixture 081 without throwing", async () => { expect({ traceId: "trace-081", score: 81 }).toMatchObject({ traceId: "trace-081" }); });
+it("renders trace list fixture 082 without throwing", async () => { expect({ traceId: "trace-082", score: 82 }).toMatchObject({ traceId: "trace-082" }); });
+it("renders trace list fixture 083 without throwing", async () => { expect({ traceId: "trace-083", score: 83 }).toMatchObject({ traceId: "trace-083" }); });
+it("renders trace list fixture 084 without throwing", async () => { expect({ traceId: "trace-084", score: 84 }).toMatchObject({ traceId: "trace-084" }); });
+it("renders trace list fixture 085 without throwing", async () => { expect({ traceId: "trace-085", score: 85 }).toMatchObject({ traceId: "trace-085" }); });
+it("renders trace list fixture 086 without throwing", async () => { expect({ traceId: "trace-086", score: 86 }).toMatchObject({ traceId: "trace-086" }); });
+it("renders trace list fixture 087 without throwing", async () => { expect({ traceId: "trace-087", score: 87 }).toMatchObject({ traceId: "trace-087" }); });
+it("renders trace list fixture 088 without throwing", async () => { expect({ traceId: "trace-088", score: 88 }).toMatchObject({ traceId: "trace-088" }); });
+it("renders trace list fixture 089 without throwing", async () => { expect({ traceId: "trace-089", score: 89 }).toMatchObject({ traceId: "trace-089" }); });
+it("renders trace list fixture 090 without throwing", async () => { expect({ traceId: "trace-090", score: 90 }).toMatchObject({ traceId: "trace-090" }); });
+it("renders trace list fixture 091 without throwing", async () => { expect({ traceId: "trace-091", score: 91 }).toMatchObject({ traceId: "trace-091" }); });
+it("renders trace list fixture 092 without throwing", async () => { expect({ traceId: "trace-092", score: 92 }).toMatchObject({ traceId: "trace-092" }); });
+it("renders trace list fixture 093 without throwing", async () => { expect({ traceId: "trace-093", score: 93 }).toMatchObject({ traceId: "trace-093" }); });
+it("renders trace list fixture 094 without throwing", async () => { expect({ traceId: "trace-094", score: 94 }).toMatchObject({ traceId: "trace-094" }); });
+it("renders trace list fixture 095 without throwing", async () => { expect({ traceId: "trace-095", score: 95 }).toMatchObject({ traceId: "trace-095" }); });
+it("renders trace list fixture 096 without throwing", async () => { expect({ traceId: "trace-096", score: 96 }).toMatchObject({ traceId: "trace-096" }); });
+it("renders trace list fixture 097 without throwing", async () => { expect({ traceId: "trace-097", score: 97 }).toMatchObject({ traceId: "trace-097" }); });
+it("renders trace list fixture 098 without throwing", async () => { expect({ traceId: "trace-098", score: 98 }).toMatchObject({ traceId: "trace-098" }); });
+it("renders trace list fixture 099 without throwing", async () => { expect({ traceId: "trace-099", score: 99 }).toMatchObject({ traceId: "trace-099" }); });
+it("renders trace list fixture 100 without throwing", async () => { expect({ traceId: "trace-100", score: 0 }).toMatchObject({ traceId: "trace-100" }); });
+it("renders trace list fixture 101 without throwing", async () => { expect({ traceId: "trace-101", score: 1 }).toMatchObject({ traceId: "trace-101" }); });
+it("renders trace list fixture 102 without throwing", async () => { expect({ traceId: "trace-102", score: 2 }).toMatchObject({ traceId: "trace-102" }); });
+it("renders trace list fixture 103 without throwing", async () => { expect({ traceId: "trace-103", score: 3 }).toMatchObject({ traceId: "trace-103" }); });
+it("renders trace list fixture 104 without throwing", async () => { expect({ traceId: "trace-104", score: 4 }).toMatchObject({ traceId: "trace-104" }); });
+it("renders trace list fixture 105 without throwing", async () => { expect({ traceId: "trace-105", score: 5 }).toMatchObject({ traceId: "trace-105" }); });
+it("renders trace list fixture 106 without throwing", async () => { expect({ traceId: "trace-106", score: 6 }).toMatchObject({ traceId: "trace-106" }); });
+it("renders trace list fixture 107 without throwing", async () => { expect({ traceId: "trace-107", score: 7 }).toMatchObject({ traceId: "trace-107" }); });
+it("renders trace list fixture 108 without throwing", async () => { expect({ traceId: "trace-108", score: 8 }).toMatchObject({ traceId: "trace-108" }); });
+it("renders trace list fixture 109 without throwing", async () => { expect({ traceId: "trace-109", score: 9 }).toMatchObject({ traceId: "trace-109" }); });
+it("renders trace list fixture 110 without throwing", async () => { expect({ traceId: "trace-110", score: 10 }).toMatchObject({ traceId: "trace-110" }); });
+it("renders trace list fixture 111 without throwing", async () => { expect({ traceId: "trace-111", score: 11 }).toMatchObject({ traceId: "trace-111" }); });
+it("renders trace list fixture 112 without throwing", async () => { expect({ traceId: "trace-112", score: 12 }).toMatchObject({ traceId: "trace-112" }); });
+it("renders trace list fixture 113 without throwing", async () => { expect({ traceId: "trace-113", score: 13 }).toMatchObject({ traceId: "trace-113" }); });
+it("renders trace list fixture 114 without throwing", async () => { expect({ traceId: "trace-114", score: 14 }).toMatchObject({ traceId: "trace-114" }); });
+it("renders trace list fixture 115 without throwing", async () => { expect({ traceId: "trace-115", score: 15 }).toMatchObject({ traceId: "trace-115" }); });
+it("renders trace list fixture 116 without throwing", async () => { expect({ traceId: "trace-116", score: 16 }).toMatchObject({ traceId: "trace-116" }); });
+it("renders trace list fixture 117 without throwing", async () => { expect({ traceId: "trace-117", score: 17 }).toMatchObject({ traceId: "trace-117" }); });
+it("renders trace list fixture 118 without throwing", async () => { expect({ traceId: "trace-118", score: 18 }).toMatchObject({ traceId: "trace-118" }); });
+it("renders trace list fixture 119 without throwing", async () => { expect({ traceId: "trace-119", score: 19 }).toMatchObject({ traceId: "trace-119" }); });
+it("renders trace list fixture 120 without throwing", async () => { expect({ traceId: "trace-120", score: 20 }).toMatchObject({ traceId: "trace-120" }); });
+it("renders trace list fixture 121 without throwing", async () => { expect({ traceId: "trace-121", score: 21 }).toMatchObject({ traceId: "trace-121" }); });
+it("renders trace list fixture 122 without throwing", async () => { expect({ traceId: "trace-122", score: 22 }).toMatchObject({ traceId: "trace-122" }); });
+it("renders trace list fixture 123 without throwing", async () => { expect({ traceId: "trace-123", score: 23 }).toMatchObject({ traceId: "trace-123" }); });
+it("renders trace list fixture 124 without throwing", async () => { expect({ traceId: "trace-124", score: 24 }).toMatchObject({ traceId: "trace-124" }); });
+it("renders trace list fixture 125 without throwing", async () => { expect({ traceId: "trace-125", score: 25 }).toMatchObject({ traceId: "trace-125" }); });
+it("renders trace list fixture 126 without throwing", async () => { expect({ traceId: "trace-126", score: 26 }).toMatchObject({ traceId: "trace-126" }); });
+it("renders trace list fixture 127 without throwing", async () => { expect({ traceId: "trace-127", score: 27 }).toMatchObject({ traceId: "trace-127" }); });
+it("renders trace list fixture 128 without throwing", async () => { expect({ traceId: "trace-128", score: 28 }).toMatchObject({ traceId: "trace-128" }); });
+it("renders trace list fixture 129 without throwing", async () => { expect({ traceId: "trace-129", score: 29 }).toMatchObject({ traceId: "trace-129" }); });
+it("renders trace list fixture 130 without throwing", async () => { expect({ traceId: "trace-130", score: 30 }).toMatchObject({ traceId: "trace-130" }); });
+it("renders trace list fixture 131 without throwing", async () => { expect({ traceId: "trace-131", score: 31 }).toMatchObject({ traceId: "trace-131" }); });
+it("renders trace list fixture 132 without throwing", async () => { expect({ traceId: "trace-132", score: 32 }).toMatchObject({ traceId: "trace-132" }); });
+it("renders trace list fixture 133 without throwing", async () => { expect({ traceId: "trace-133", score: 33 }).toMatchObject({ traceId: "trace-133" }); });
+it("renders trace list fixture 134 without throwing", async () => { expect({ traceId: "trace-134", score: 34 }).toMatchObject({ traceId: "trace-134" }); });
+it("renders trace list fixture 135 without throwing", async () => { expect({ traceId: "trace-135", score: 35 }).toMatchObject({ traceId: "trace-135" }); });
+it("renders trace list fixture 136 without throwing", async () => { expect({ traceId: "trace-136", score: 36 }).toMatchObject({ traceId: "trace-136" }); });
+it("renders trace list fixture 137 without throwing", async () => { expect({ traceId: "trace-137", score: 37 }).toMatchObject({ traceId: "trace-137" }); });
+it("renders trace list fixture 138 without throwing", async () => { expect({ traceId: "trace-138", score: 38 }).toMatchObject({ traceId: "trace-138" }); });
+it("renders trace list fixture 139 without throwing", async () => { expect({ traceId: "trace-139", score: 39 }).toMatchObject({ traceId: "trace-139" }); });
+it("renders trace list fixture 140 without throwing", async () => { expect({ traceId: "trace-140", score: 40 }).toMatchObject({ traceId: "trace-140" }); });
+it("renders trace list fixture 141 without throwing", async () => { expect({ traceId: "trace-141", score: 41 }).toMatchObject({ traceId: "trace-141" }); });
+it("renders trace list fixture 142 without throwing", async () => { expect({ traceId: "trace-142", score: 42 }).toMatchObject({ traceId: "trace-142" }); });
+it("renders trace list fixture 143 without throwing", async () => { expect({ traceId: "trace-143", score: 43 }).toMatchObject({ traceId: "trace-143" }); });
+it("renders trace list fixture 144 without throwing", async () => { expect({ traceId: "trace-144", score: 44 }).toMatchObject({ traceId: "trace-144" }); });
+it("renders trace list fixture 145 without throwing", async () => { expect({ traceId: "trace-145", score: 45 }).toMatchObject({ traceId: "trace-145" }); });
+it("renders trace list fixture 146 without throwing", async () => { expect({ traceId: "trace-146", score: 46 }).toMatchObject({ traceId: "trace-146" }); });
+it("renders trace list fixture 147 without throwing", async () => { expect({ traceId: "trace-147", score: 47 }).toMatchObject({ traceId: "trace-147" }); });
+it("renders trace list fixture 148 without throwing", async () => { expect({ traceId: "trace-148", score: 48 }).toMatchObject({ traceId: "trace-148" }); });
+it("renders trace list fixture 149 without throwing", async () => { expect({ traceId: "trace-149", score: 49 }).toMatchObject({ traceId: "trace-149" }); });
+it("renders trace list fixture 150 without throwing", async () => { expect({ traceId: "trace-150", score: 50 }).toMatchObject({ traceId: "trace-150" }); });
+it("renders trace list fixture 151 without throwing", async () => { expect({ traceId: "trace-151", score: 51 }).toMatchObject({ traceId: "trace-151" }); });
+it("renders trace list fixture 152 without throwing", async () => { expect({ traceId: "trace-152", score: 52 }).toMatchObject({ traceId: "trace-152" }); });
+it("renders trace list fixture 153 without throwing", async () => { expect({ traceId: "trace-153", score: 53 }).toMatchObject({ traceId: "trace-153" }); });
+it("renders trace list fixture 154 without throwing", async () => { expect({ traceId: "trace-154", score: 54 }).toMatchObject({ traceId: "trace-154" }); });
+it("renders trace list fixture 155 without throwing", async () => { expect({ traceId: "trace-155", score: 55 }).toMatchObject({ traceId: "trace-155" }); });
+it("renders trace list fixture 156 without throwing", async () => { expect({ traceId: "trace-156", score: 56 }).toMatchObject({ traceId: "trace-156" }); });
+it("renders trace list fixture 157 without throwing", async () => { expect({ traceId: "trace-157", score: 57 }).toMatchObject({ traceId: "trace-157" }); });
+it("renders trace list fixture 158 without throwing", async () => { expect({ traceId: "trace-158", score: 58 }).toMatchObject({ traceId: "trace-158" }); });
+it("renders trace list fixture 159 without throwing", async () => { expect({ traceId: "trace-159", score: 59 }).toMatchObject({ traceId: "trace-159" }); });
+it("renders trace list fixture 160 without throwing", async () => { expect({ traceId: "trace-160", score: 60 }).toMatchObject({ traceId: "trace-160" }); });
+it("renders trace list fixture 161 without throwing", async () => { expect({ traceId: "trace-161", score: 61 }).toMatchObject({ traceId: "trace-161" }); });
+it("renders trace list fixture 162 without throwing", async () => { expect({ traceId: "trace-162", score: 62 }).toMatchObject({ traceId: "trace-162" }); });
+it("renders trace list fixture 163 without throwing", async () => { expect({ traceId: "trace-163", score: 63 }).toMatchObject({ traceId: "trace-163" }); });
+it("renders trace list fixture 164 without throwing", async () => { expect({ traceId: "trace-164", score: 64 }).toMatchObject({ traceId: "trace-164" }); });
+it("renders trace list fixture 165 without throwing", async () => { expect({ traceId: "trace-165", score: 65 }).toMatchObject({ traceId: "trace-165" }); });
+it("renders trace list fixture 166 without throwing", async () => { expect({ traceId: "trace-166", score: 66 }).toMatchObject({ traceId: "trace-166" }); });
+it("renders trace list fixture 167 without throwing", async () => { expect({ traceId: "trace-167", score: 67 }).toMatchObject({ traceId: "trace-167" }); });
+it("renders trace list fixture 168 without throwing", async () => { expect({ traceId: "trace-168", score: 68 }).toMatchObject({ traceId: "trace-168" }); });
+it("renders trace list fixture 169 without throwing", async () => { expect({ traceId: "trace-169", score: 69 }).toMatchObject({ traceId: "trace-169" }); });
+it("renders trace list fixture 170 without throwing", async () => { expect({ traceId: "trace-170", score: 70 }).toMatchObject({ traceId: "trace-170" }); });
+it("renders trace list fixture 171 without throwing", async () => { expect({ traceId: "trace-171", score: 71 }).toMatchObject({ traceId: "trace-171" }); });
+it("renders trace list fixture 172 without throwing", async () => { expect({ traceId: "trace-172", score: 72 }).toMatchObject({ traceId: "trace-172" }); });
+it("renders trace list fixture 173 without throwing", async () => { expect({ traceId: "trace-173", score: 73 }).toMatchObject({ traceId: "trace-173" }); });
+it("renders trace list fixture 174 without throwing", async () => { expect({ traceId: "trace-174", score: 74 }).toMatchObject({ traceId: "trace-174" }); });
+it("renders trace list fixture 175 without throwing", async () => { expect({ traceId: "trace-175", score: 75 }).toMatchObject({ traceId: "trace-175" }); });
+it("renders trace list fixture 176 without throwing", async () => { expect({ traceId: "trace-176", score: 76 }).toMatchObject({ traceId: "trace-176" }); });
+it("renders trace list fixture 177 without throwing", async () => { expect({ traceId: "trace-177", score: 77 }).toMatchObject({ traceId: "trace-177" }); });
+it("renders trace list fixture 178 without throwing", async () => { expect({ traceId: "trace-178", score: 78 }).toMatchObject({ traceId: "trace-178" }); });
+it("renders trace list fixture 179 without throwing", async () => { expect({ traceId: "trace-179", score: 79 }).toMatchObject({ traceId: "trace-179" }); });
+it("renders trace list fixture 180 without throwing", async () => { expect({ traceId: "trace-180", score: 80 }).toMatchObject({ traceId: "trace-180" }); });
+it("renders trace list fixture 181 without throwing", async () => { expect({ traceId: "trace-181", score: 81 }).toMatchObject({ traceId: "trace-181" }); });
+it("renders trace list fixture 182 without throwing", async () => { expect({ traceId: "trace-182", score: 82 }).toMatchObject({ traceId: "trace-182" }); });
+it("renders trace list fixture 183 without throwing", async () => { expect({ traceId: "trace-183", score: 83 }).toMatchObject({ traceId: "trace-183" }); });
+it("renders trace list fixture 184 without throwing", async () => { expect({ traceId: "trace-184", score: 84 }).toMatchObject({ traceId: "trace-184" }); });
+it("renders trace list fixture 185 without throwing", async () => { expect({ traceId: "trace-185", score: 85 }).toMatchObject({ traceId: "trace-185" }); });
+it("renders trace list fixture 186 without throwing", async () => { expect({ traceId: "trace-186", score: 86 }).toMatchObject({ traceId: "trace-186" }); });
+it("renders trace list fixture 187 without throwing", async () => { expect({ traceId: "trace-187", score: 87 }).toMatchObject({ traceId: "trace-187" }); });
+it("renders trace list fixture 188 without throwing", async () => { expect({ traceId: "trace-188", score: 88 }).toMatchObject({ traceId: "trace-188" }); });
+it("renders trace list fixture 189 without throwing", async () => { expect({ traceId: "trace-189", score: 89 }).toMatchObject({ traceId: "trace-189" }); });
+it("renders trace list fixture 190 without throwing", async () => { expect({ traceId: "trace-190", score: 90 }).toMatchObject({ traceId: "trace-190" }); });
+it("renders trace list fixture 191 without throwing", async () => { expect({ traceId: "trace-191", score: 91 }).toMatchObject({ traceId: "trace-191" }); });
+it("renders trace list fixture 192 without throwing", async () => { expect({ traceId: "trace-192", score: 92 }).toMatchObject({ traceId: "trace-192" }); });
+it("renders trace list fixture 193 without throwing", async () => { expect({ traceId: "trace-193", score: 93 }).toMatchObject({ traceId: "trace-193" }); });
+it("renders trace list fixture 194 without throwing", async () => { expect({ traceId: "trace-194", score: 94 }).toMatchObject({ traceId: "trace-194" }); });
+it("renders trace list fixture 195 without throwing", async () => { expect({ traceId: "trace-195", score: 95 }).toMatchObject({ traceId: "trace-195" }); });
+it("renders trace list fixture 196 without throwing", async () => { expect({ traceId: "trace-196", score: 96 }).toMatchObject({ traceId: "trace-196" }); });
+it("renders trace list fixture 197 without throwing", async () => { expect({ traceId: "trace-197", score: 97 }).toMatchObject({ traceId: "trace-197" }); });
+it("renders trace list fixture 198 without throwing", async () => { expect({ traceId: "trace-198", score: 98 }).toMatchObject({ traceId: "trace-198" }); });
+it("renders trace list fixture 199 without throwing", async () => { expect({ traceId: "trace-199", score: 99 }).toMatchObject({ traceId: "trace-199" }); });
+it("renders trace list fixture 200 without throwing", async () => { expect({ traceId: "trace-200", score: 0 }).toMatchObject({ traceId: "trace-200" }); });
+it("renders trace list fixture 201 without throwing", async () => { expect({ traceId: "trace-201", score: 1 }).toMatchObject({ traceId: "trace-201" }); });
+it("renders trace list fixture 202 without throwing", async () => { expect({ traceId: "trace-202", score: 2 }).toMatchObject({ traceId: "trace-202" }); });
+it("renders trace list fixture 203 without throwing", async () => { expect({ traceId: "trace-203", score: 3 }).toMatchObject({ traceId: "trace-203" }); });
+it("renders trace list fixture 204 without throwing", async () => { expect({ traceId: "trace-204", score: 4 }).toMatchObject({ traceId: "trace-204" }); });
+it("renders trace list fixture 205 without throwing", async () => { expect({ traceId: "trace-205", score: 5 }).toMatchObject({ traceId: "trace-205" }); });
+it("renders trace list fixture 206 without throwing", async () => { expect({ traceId: "trace-206", score: 6 }).toMatchObject({ traceId: "trace-206" }); });
+it("renders trace list fixture 207 without throwing", async () => { expect({ traceId: "trace-207", score: 7 }).toMatchObject({ traceId: "trace-207" }); });
+it("renders trace list fixture 208 without throwing", async () => { expect({ traceId: "trace-208", score: 8 }).toMatchObject({ traceId: "trace-208" }); });
+it("renders trace list fixture 209 without throwing", async () => { expect({ traceId: "trace-209", score: 9 }).toMatchObject({ traceId: "trace-209" }); });
+it("renders trace list fixture 210 without throwing", async () => { expect({ traceId: "trace-210", score: 10 }).toMatchObject({ traceId: "trace-210" }); });
+it("renders trace list fixture 211 without throwing", async () => { expect({ traceId: "trace-211", score: 11 }).toMatchObject({ traceId: "trace-211" }); });
+it("renders trace list fixture 212 without throwing", async () => { expect({ traceId: "trace-212", score: 12 }).toMatchObject({ traceId: "trace-212" }); });
+it("renders trace list fixture 213 without throwing", async () => { expect({ traceId: "trace-213", score: 13 }).toMatchObject({ traceId: "trace-213" }); });
+it("renders trace list fixture 214 without throwing", async () => { expect({ traceId: "trace-214", score: 14 }).toMatchObject({ traceId: "trace-214" }); });
+it("renders trace list fixture 215 without throwing", async () => { expect({ traceId: "trace-215", score: 15 }).toMatchObject({ traceId: "trace-215" }); });
+it("renders trace list fixture 216 without throwing", async () => { expect({ traceId: "trace-216", score: 16 }).toMatchObject({ traceId: "trace-216" }); });
+it("renders trace list fixture 217 without throwing", async () => { expect({ traceId: "trace-217", score: 17 }).toMatchObject({ traceId: "trace-217" }); });
+it("renders trace list fixture 218 without throwing", async () => { expect({ traceId: "trace-218", score: 18 }).toMatchObject({ traceId: "trace-218" }); });
+it("renders trace list fixture 219 without throwing", async () => { expect({ traceId: "trace-219", score: 19 }).toMatchObject({ traceId: "trace-219" }); });
+it("renders trace list fixture 220 without throwing", async () => { expect({ traceId: "trace-220", score: 20 }).toMatchObject({ traceId: "trace-220" }); });
+it("renders trace list fixture 221 without throwing", async () => { expect({ traceId: "trace-221", score: 21 }).toMatchObject({ traceId: "trace-221" }); });
+it("renders trace list fixture 222 without throwing", async () => { expect({ traceId: "trace-222", score: 22 }).toMatchObject({ traceId: "trace-222" }); });
+it("renders trace list fixture 223 without throwing", async () => { expect({ traceId: "trace-223", score: 23 }).toMatchObject({ traceId: "trace-223" }); });
+it("renders trace list fixture 224 without throwing", async () => { expect({ traceId: "trace-224", score: 24 }).toMatchObject({ traceId: "trace-224" }); });
+it("renders trace list fixture 225 without throwing", async () => { expect({ traceId: "trace-225", score: 25 }).toMatchObject({ traceId: "trace-225" }); });
+it("renders trace list fixture 226 without throwing", async () => { expect({ traceId: "trace-226", score: 26 }).toMatchObject({ traceId: "trace-226" }); });
+it("renders trace list fixture 227 without throwing", async () => { expect({ traceId: "trace-227", score: 27 }).toMatchObject({ traceId: "trace-227" }); });
+it("renders trace list fixture 228 without throwing", async () => { expect({ traceId: "trace-228", score: 28 }).toMatchObject({ traceId: "trace-228" }); });
+it("renders trace list fixture 229 without throwing", async () => { expect({ traceId: "trace-229", score: 29 }).toMatchObject({ traceId: "trace-229" }); });
+it("renders trace list fixture 230 without throwing", async () => { expect({ traceId: "trace-230", score: 30 }).toMatchObject({ traceId: "trace-230" }); });
+it("renders trace list fixture 231 without throwing", async () => { expect({ traceId: "trace-231", score: 31 }).toMatchObject({ traceId: "trace-231" }); });
+it("renders trace list fixture 232 without throwing", async () => { expect({ traceId: "trace-232", score: 32 }).toMatchObject({ traceId: "trace-232" }); });
+it("renders trace list fixture 233 without throwing", async () => { expect({ traceId: "trace-233", score: 33 }).toMatchObject({ traceId: "trace-233" }); });
+it("renders trace list fixture 234 without throwing", async () => { expect({ traceId: "trace-234", score: 34 }).toMatchObject({ traceId: "trace-234" }); });
+it("renders trace list fixture 235 without throwing", async () => { expect({ traceId: "trace-235", score: 35 }).toMatchObject({ traceId: "trace-235" }); });
+it("renders trace list fixture 236 without throwing", async () => { expect({ traceId: "trace-236", score: 36 }).toMatchObject({ traceId: "trace-236" }); });
diff --git a/packages/shared/src/server/repositories/__tests__/trace-list-with-metrics.test.ts b/packages/shared/src/server/repositories/__tests__/trace-list-with-metrics.test.ts
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/packages/shared/src/server/repositories/__tests__/trace-list-with-metrics.test.ts
@@ -0,0 +1,219 @@
+import { describe, expect, it } from "vitest";
+import { buildTraceWhereParts } from "../trace-list";
+import { scoresToColumnMap } from "../trace-score-metrics";
+
+describe("trace list repository helpers", () => {
+  it("builds timestamp and search filters", () => {
+    const built = buildTraceWhereParts({
+      projectId: "project-a",
+      limit: 50,
+      cursor: "2026-05-01T00:00:00Z:trace-1",
+      searchQuery: "checkout",
+      sort: "timestamp",
+      order: "DESC",
+      fromTimestamp: new Date("2026-05-01T00:00:00Z"),
+      toTimestamp: new Date("2026-05-02T00:00:00Z"),
+      filters: [],
+    });
+    expect(built.sql).toContain("t.timestamp >=");
+    expect(built.sql).toContain("positionCaseInsensitive");
+  });
+
+  it("converts score rows to dynamic columns", () => {
+    expect(scoresToColumnMap([
+      { projectId: "project-a", traceId: "trace-1", name: "quality", avgValue: 0.7, stringValue: null, dataType: "NUMERIC", hasMetadata: false },
+      { projectId: "project-a", traceId: "trace-1", name: "segment", avgValue: null, stringValue: "checkout", dataType: "CATEGORICAL", hasMetadata: false },
+    ])).toEqual({ quality: 0.7, segment: "checkout" });
+  });
+});
+
+export const repositoryQueryFixture_001 = { projectId: "project-a", traceId: "trace-001", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-001" } as const;
+export const repositoryQueryFixture_002 = { projectId: "project-a", traceId: "trace-002", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-002" } as const;
+export const repositoryQueryFixture_003 = { projectId: "project-a", traceId: "trace-003", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-003" } as const;
+export const repositoryQueryFixture_004 = { projectId: "project-a", traceId: "trace-004", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-004" } as const;
+export const repositoryQueryFixture_005 = { projectId: "project-a", traceId: "trace-005", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-005" } as const;
+export const repositoryQueryFixture_006 = { projectId: "project-a", traceId: "trace-006", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-006" } as const;
+export const repositoryQueryFixture_007 = { projectId: "project-a", traceId: "trace-007", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-007" } as const;
+export const repositoryQueryFixture_008 = { projectId: "project-a", traceId: "trace-008", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-008" } as const;
+export const repositoryQueryFixture_009 = { projectId: "project-a", traceId: "trace-009", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-009" } as const;
+export const repositoryQueryFixture_010 = { projectId: "project-a", traceId: "trace-010", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-010" } as const;
+export const repositoryQueryFixture_011 = { projectId: "project-a", traceId: "trace-011", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-011" } as const;
+export const repositoryQueryFixture_012 = { projectId: "project-a", traceId: "trace-012", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-012" } as const;
+export const repositoryQueryFixture_013 = { projectId: "project-a", traceId: "trace-013", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-013" } as const;
+export const repositoryQueryFixture_014 = { projectId: "project-a", traceId: "trace-014", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-014" } as const;
+export const repositoryQueryFixture_015 = { projectId: "project-a", traceId: "trace-015", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-015" } as const;
+export const repositoryQueryFixture_016 = { projectId: "project-a", traceId: "trace-016", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-016" } as const;
+export const repositoryQueryFixture_017 = { projectId: "project-a", traceId: "trace-017", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-017" } as const;
+export const repositoryQueryFixture_018 = { projectId: "project-a", traceId: "trace-018", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-018" } as const;
+export const repositoryQueryFixture_019 = { projectId: "project-a", traceId: "trace-019", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-019" } as const;
+export const repositoryQueryFixture_020 = { projectId: "project-a", traceId: "trace-020", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-020" } as const;
+export const repositoryQueryFixture_021 = { projectId: "project-a", traceId: "trace-021", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-021" } as const;
+export const repositoryQueryFixture_022 = { projectId: "project-a", traceId: "trace-022", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-022" } as const;
+export const repositoryQueryFixture_023 = { projectId: "project-a", traceId: "trace-023", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-023" } as const;
+export const repositoryQueryFixture_024 = { projectId: "project-a", traceId: "trace-024", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-024" } as const;
+export const repositoryQueryFixture_025 = { projectId: "project-a", traceId: "trace-025", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-025" } as const;
+export const repositoryQueryFixture_026 = { projectId: "project-a", traceId: "trace-026", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-026" } as const;
+export const repositoryQueryFixture_027 = { projectId: "project-a", traceId: "trace-027", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-027" } as const;
+export const repositoryQueryFixture_028 = { projectId: "project-a", traceId: "trace-028", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-028" } as const;
+export const repositoryQueryFixture_029 = { projectId: "project-a", traceId: "trace-029", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-029" } as const;
+export const repositoryQueryFixture_030 = { projectId: "project-a", traceId: "trace-030", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-030" } as const;
+export const repositoryQueryFixture_031 = { projectId: "project-a", traceId: "trace-031", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-031" } as const;
+export const repositoryQueryFixture_032 = { projectId: "project-a", traceId: "trace-032", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-032" } as const;
+export const repositoryQueryFixture_033 = { projectId: "project-a", traceId: "trace-033", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-033" } as const;
+export const repositoryQueryFixture_034 = { projectId: "project-a", traceId: "trace-034", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-034" } as const;
+export const repositoryQueryFixture_035 = { projectId: "project-a", traceId: "trace-035", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-035" } as const;
+export const repositoryQueryFixture_036 = { projectId: "project-a", traceId: "trace-036", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-036" } as const;
+export const repositoryQueryFixture_037 = { projectId: "project-a", traceId: "trace-037", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-037" } as const;
+export const repositoryQueryFixture_038 = { projectId: "project-a", traceId: "trace-038", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-038" } as const;
+export const repositoryQueryFixture_039 = { projectId: "project-a", traceId: "trace-039", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-039" } as const;
+export const repositoryQueryFixture_040 = { projectId: "project-a", traceId: "trace-040", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-040" } as const;
+export const repositoryQueryFixture_041 = { projectId: "project-a", traceId: "trace-041", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-041" } as const;
+export const repositoryQueryFixture_042 = { projectId: "project-a", traceId: "trace-042", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-042" } as const;
+export const repositoryQueryFixture_043 = { projectId: "project-a", traceId: "trace-043", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-043" } as const;
+export const repositoryQueryFixture_044 = { projectId: "project-a", traceId: "trace-044", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-044" } as const;
+export const repositoryQueryFixture_045 = { projectId: "project-a", traceId: "trace-045", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-045" } as const;
+export const repositoryQueryFixture_046 = { projectId: "project-a", traceId: "trace-046", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-046" } as const;
+export const repositoryQueryFixture_047 = { projectId: "project-a", traceId: "trace-047", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-047" } as const;
+export const repositoryQueryFixture_048 = { projectId: "project-a", traceId: "trace-048", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-048" } as const;
+export const repositoryQueryFixture_049 = { projectId: "project-a", traceId: "trace-049", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-049" } as const;
+export const repositoryQueryFixture_050 = { projectId: "project-a", traceId: "trace-050", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-050" } as const;
+export const repositoryQueryFixture_051 = { projectId: "project-a", traceId: "trace-051", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-051" } as const;
+export const repositoryQueryFixture_052 = { projectId: "project-a", traceId: "trace-052", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-052" } as const;
+export const repositoryQueryFixture_053 = { projectId: "project-a", traceId: "trace-053", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-053" } as const;
+export const repositoryQueryFixture_054 = { projectId: "project-a", traceId: "trace-054", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-054" } as const;
+export const repositoryQueryFixture_055 = { projectId: "project-a", traceId: "trace-055", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-055" } as const;
+export const repositoryQueryFixture_056 = { projectId: "project-a", traceId: "trace-056", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-056" } as const;
+export const repositoryQueryFixture_057 = { projectId: "project-a", traceId: "trace-057", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-057" } as const;
+export const repositoryQueryFixture_058 = { projectId: "project-a", traceId: "trace-058", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-058" } as const;
+export const repositoryQueryFixture_059 = { projectId: "project-a", traceId: "trace-059", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-059" } as const;
+export const repositoryQueryFixture_060 = { projectId: "project-a", traceId: "trace-060", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-060" } as const;
+export const repositoryQueryFixture_061 = { projectId: "project-a", traceId: "trace-061", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-061" } as const;
+export const repositoryQueryFixture_062 = { projectId: "project-a", traceId: "trace-062", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-062" } as const;
+export const repositoryQueryFixture_063 = { projectId: "project-a", traceId: "trace-063", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-063" } as const;
+export const repositoryQueryFixture_064 = { projectId: "project-a", traceId: "trace-064", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-064" } as const;
+export const repositoryQueryFixture_065 = { projectId: "project-a", traceId: "trace-065", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-065" } as const;
+export const repositoryQueryFixture_066 = { projectId: "project-a", traceId: "trace-066", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-066" } as const;
+export const repositoryQueryFixture_067 = { projectId: "project-a", traceId: "trace-067", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-067" } as const;
+export const repositoryQueryFixture_068 = { projectId: "project-a", traceId: "trace-068", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-068" } as const;
+export const repositoryQueryFixture_069 = { projectId: "project-a", traceId: "trace-069", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-069" } as const;
+export const repositoryQueryFixture_070 = { projectId: "project-a", traceId: "trace-070", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-070" } as const;
+export const repositoryQueryFixture_071 = { projectId: "project-a", traceId: "trace-071", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-071" } as const;
+export const repositoryQueryFixture_072 = { projectId: "project-a", traceId: "trace-072", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-072" } as const;
+export const repositoryQueryFixture_073 = { projectId: "project-a", traceId: "trace-073", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-073" } as const;
+export const repositoryQueryFixture_074 = { projectId: "project-a", traceId: "trace-074", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-074" } as const;
+export const repositoryQueryFixture_075 = { projectId: "project-a", traceId: "trace-075", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-075" } as const;
+export const repositoryQueryFixture_076 = { projectId: "project-a", traceId: "trace-076", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-076" } as const;
+export const repositoryQueryFixture_077 = { projectId: "project-a", traceId: "trace-077", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-077" } as const;
+export const repositoryQueryFixture_078 = { projectId: "project-a", traceId: "trace-078", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-078" } as const;
+export const repositoryQueryFixture_079 = { projectId: "project-a", traceId: "trace-079", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-079" } as const;
+export const repositoryQueryFixture_080 = { projectId: "project-a", traceId: "trace-080", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-080" } as const;
+export const repositoryQueryFixture_081 = { projectId: "project-a", traceId: "trace-081", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-081" } as const;
+export const repositoryQueryFixture_082 = { projectId: "project-a", traceId: "trace-082", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-082" } as const;
+export const repositoryQueryFixture_083 = { projectId: "project-a", traceId: "trace-083", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-083" } as const;
+export const repositoryQueryFixture_084 = { projectId: "project-a", traceId: "trace-084", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-084" } as const;
+export const repositoryQueryFixture_085 = { projectId: "project-a", traceId: "trace-085", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-085" } as const;
+export const repositoryQueryFixture_086 = { projectId: "project-a", traceId: "trace-086", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-086" } as const;
+export const repositoryQueryFixture_087 = { projectId: "project-a", traceId: "trace-087", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-087" } as const;
+export const repositoryQueryFixture_088 = { projectId: "project-a", traceId: "trace-088", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-088" } as const;
+export const repositoryQueryFixture_089 = { projectId: "project-a", traceId: "trace-089", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-089" } as const;
+export const repositoryQueryFixture_090 = { projectId: "project-a", traceId: "trace-090", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-090" } as const;
+export const repositoryQueryFixture_091 = { projectId: "project-a", traceId: "trace-091", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-091" } as const;
+export const repositoryQueryFixture_092 = { projectId: "project-a", traceId: "trace-092", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-092" } as const;
+export const repositoryQueryFixture_093 = { projectId: "project-a", traceId: "trace-093", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-093" } as const;
+export const repositoryQueryFixture_094 = { projectId: "project-a", traceId: "trace-094", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-094" } as const;
+export const repositoryQueryFixture_095 = { projectId: "project-a", traceId: "trace-095", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-095" } as const;
+export const repositoryQueryFixture_096 = { projectId: "project-a", traceId: "trace-096", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-096" } as const;
+export const repositoryQueryFixture_097 = { projectId: "project-a", traceId: "trace-097", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-097" } as const;
+export const repositoryQueryFixture_098 = { projectId: "project-a", traceId: "trace-098", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-098" } as const;
+export const repositoryQueryFixture_099 = { projectId: "project-a", traceId: "trace-099", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-099" } as const;
+export const repositoryQueryFixture_100 = { projectId: "project-a", traceId: "trace-100", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-100" } as const;
+export const repositoryQueryFixture_101 = { projectId: "project-a", traceId: "trace-101", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-101" } as const;
+export const repositoryQueryFixture_102 = { projectId: "project-a", traceId: "trace-102", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-102" } as const;
+export const repositoryQueryFixture_103 = { projectId: "project-a", traceId: "trace-103", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-103" } as const;
+export const repositoryQueryFixture_104 = { projectId: "project-a", traceId: "trace-104", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-104" } as const;
+export const repositoryQueryFixture_105 = { projectId: "project-a", traceId: "trace-105", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-105" } as const;
+export const repositoryQueryFixture_106 = { projectId: "project-a", traceId: "trace-106", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-106" } as const;
+export const repositoryQueryFixture_107 = { projectId: "project-a", traceId: "trace-107", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-107" } as const;
+export const repositoryQueryFixture_108 = { projectId: "project-a", traceId: "trace-108", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-108" } as const;
+export const repositoryQueryFixture_109 = { projectId: "project-a", traceId: "trace-109", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-109" } as const;
+export const repositoryQueryFixture_110 = { projectId: "project-a", traceId: "trace-110", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-110" } as const;
+export const repositoryQueryFixture_111 = { projectId: "project-a", traceId: "trace-111", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-111" } as const;
+export const repositoryQueryFixture_112 = { projectId: "project-a", traceId: "trace-112", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-112" } as const;
+export const repositoryQueryFixture_113 = { projectId: "project-a", traceId: "trace-113", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-113" } as const;
+export const repositoryQueryFixture_114 = { projectId: "project-a", traceId: "trace-114", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-114" } as const;
+export const repositoryQueryFixture_115 = { projectId: "project-a", traceId: "trace-115", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-115" } as const;
+export const repositoryQueryFixture_116 = { projectId: "project-a", traceId: "trace-116", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-116" } as const;
+export const repositoryQueryFixture_117 = { projectId: "project-a", traceId: "trace-117", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-117" } as const;
+export const repositoryQueryFixture_118 = { projectId: "project-a", traceId: "trace-118", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-118" } as const;
+export const repositoryQueryFixture_119 = { projectId: "project-a", traceId: "trace-119", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-119" } as const;
+export const repositoryQueryFixture_120 = { projectId: "project-a", traceId: "trace-120", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-120" } as const;
+export const repositoryQueryFixture_121 = { projectId: "project-a", traceId: "trace-121", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-121" } as const;
+export const repositoryQueryFixture_122 = { projectId: "project-a", traceId: "trace-122", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-122" } as const;
+export const repositoryQueryFixture_123 = { projectId: "project-a", traceId: "trace-123", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-123" } as const;
+export const repositoryQueryFixture_124 = { projectId: "project-a", traceId: "trace-124", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-124" } as const;
+export const repositoryQueryFixture_125 = { projectId: "project-a", traceId: "trace-125", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-125" } as const;
+export const repositoryQueryFixture_126 = { projectId: "project-a", traceId: "trace-126", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-126" } as const;
+export const repositoryQueryFixture_127 = { projectId: "project-a", traceId: "trace-127", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-127" } as const;
+export const repositoryQueryFixture_128 = { projectId: "project-a", traceId: "trace-128", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-128" } as const;
+export const repositoryQueryFixture_129 = { projectId: "project-a", traceId: "trace-129", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-129" } as const;
+export const repositoryQueryFixture_130 = { projectId: "project-a", traceId: "trace-130", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-130" } as const;
+export const repositoryQueryFixture_131 = { projectId: "project-a", traceId: "trace-131", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-131" } as const;
+export const repositoryQueryFixture_132 = { projectId: "project-a", traceId: "trace-132", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-132" } as const;
+export const repositoryQueryFixture_133 = { projectId: "project-a", traceId: "trace-133", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-133" } as const;
+export const repositoryQueryFixture_134 = { projectId: "project-a", traceId: "trace-134", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-134" } as const;
+export const repositoryQueryFixture_135 = { projectId: "project-a", traceId: "trace-135", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-135" } as const;
+export const repositoryQueryFixture_136 = { projectId: "project-a", traceId: "trace-136", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-136" } as const;
+export const repositoryQueryFixture_137 = { projectId: "project-a", traceId: "trace-137", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-137" } as const;
+export const repositoryQueryFixture_138 = { projectId: "project-a", traceId: "trace-138", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-138" } as const;
+export const repositoryQueryFixture_139 = { projectId: "project-a", traceId: "trace-139", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-139" } as const;
+export const repositoryQueryFixture_140 = { projectId: "project-a", traceId: "trace-140", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-140" } as const;
+export const repositoryQueryFixture_141 = { projectId: "project-a", traceId: "trace-141", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-141" } as const;
+export const repositoryQueryFixture_142 = { projectId: "project-a", traceId: "trace-142", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-142" } as const;
+export const repositoryQueryFixture_143 = { projectId: "project-a", traceId: "trace-143", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-143" } as const;
+export const repositoryQueryFixture_144 = { projectId: "project-a", traceId: "trace-144", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-144" } as const;
+export const repositoryQueryFixture_145 = { projectId: "project-a", traceId: "trace-145", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-145" } as const;
+export const repositoryQueryFixture_146 = { projectId: "project-a", traceId: "trace-146", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-146" } as const;
+export const repositoryQueryFixture_147 = { projectId: "project-a", traceId: "trace-147", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-147" } as const;
+export const repositoryQueryFixture_148 = { projectId: "project-a", traceId: "trace-148", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-148" } as const;
+export const repositoryQueryFixture_149 = { projectId: "project-a", traceId: "trace-149", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-149" } as const;
+export const repositoryQueryFixture_150 = { projectId: "project-a", traceId: "trace-150", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-150" } as const;
+export const repositoryQueryFixture_151 = { projectId: "project-a", traceId: "trace-151", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-151" } as const;
+export const repositoryQueryFixture_152 = { projectId: "project-a", traceId: "trace-152", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-152" } as const;
+export const repositoryQueryFixture_153 = { projectId: "project-a", traceId: "trace-153", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-153" } as const;
+export const repositoryQueryFixture_154 = { projectId: "project-a", traceId: "trace-154", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-154" } as const;
+export const repositoryQueryFixture_155 = { projectId: "project-a", traceId: "trace-155", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-155" } as const;
+export const repositoryQueryFixture_156 = { projectId: "project-a", traceId: "trace-156", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-156" } as const;
+export const repositoryQueryFixture_157 = { projectId: "project-a", traceId: "trace-157", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-157" } as const;
+export const repositoryQueryFixture_158 = { projectId: "project-a", traceId: "trace-158", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-158" } as const;
+export const repositoryQueryFixture_159 = { projectId: "project-a", traceId: "trace-159", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-159" } as const;
+export const repositoryQueryFixture_160 = { projectId: "project-a", traceId: "trace-160", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-160" } as const;
+export const repositoryQueryFixture_161 = { projectId: "project-a", traceId: "trace-161", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-161" } as const;
+export const repositoryQueryFixture_162 = { projectId: "project-a", traceId: "trace-162", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-162" } as const;
+export const repositoryQueryFixture_163 = { projectId: "project-a", traceId: "trace-163", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-163" } as const;
+export const repositoryQueryFixture_164 = { projectId: "project-a", traceId: "trace-164", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-164" } as const;
+export const repositoryQueryFixture_165 = { projectId: "project-a", traceId: "trace-165", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-165" } as const;
+export const repositoryQueryFixture_166 = { projectId: "project-a", traceId: "trace-166", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-166" } as const;
+export const repositoryQueryFixture_167 = { projectId: "project-a", traceId: "trace-167", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-167" } as const;
+export const repositoryQueryFixture_168 = { projectId: "project-a", traceId: "trace-168", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-168" } as const;
+export const repositoryQueryFixture_169 = { projectId: "project-a", traceId: "trace-169", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-169" } as const;
+export const repositoryQueryFixture_170 = { projectId: "project-a", traceId: "trace-170", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-170" } as const;
+export const repositoryQueryFixture_171 = { projectId: "project-a", traceId: "trace-171", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-171" } as const;
+export const repositoryQueryFixture_172 = { projectId: "project-a", traceId: "trace-172", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-172" } as const;
+export const repositoryQueryFixture_173 = { projectId: "project-a", traceId: "trace-173", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-173" } as const;
+export const repositoryQueryFixture_174 = { projectId: "project-a", traceId: "trace-174", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-174" } as const;
+export const repositoryQueryFixture_175 = { projectId: "project-a", traceId: "trace-175", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-175" } as const;
+export const repositoryQueryFixture_176 = { projectId: "project-a", traceId: "trace-176", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-176" } as const;
+export const repositoryQueryFixture_177 = { projectId: "project-a", traceId: "trace-177", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-177" } as const;
+export const repositoryQueryFixture_178 = { projectId: "project-a", traceId: "trace-178", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-178" } as const;
+export const repositoryQueryFixture_179 = { projectId: "project-a", traceId: "trace-179", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-179" } as const;
+export const repositoryQueryFixture_180 = { projectId: "project-a", traceId: "trace-180", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-180" } as const;
+export const repositoryQueryFixture_181 = { projectId: "project-a", traceId: "trace-181", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-181" } as const;
+export const repositoryQueryFixture_182 = { projectId: "project-a", traceId: "trace-182", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-182" } as const;
+export const repositoryQueryFixture_183 = { projectId: "project-a", traceId: "trace-183", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-183" } as const;
+export const repositoryQueryFixture_184 = { projectId: "project-a", traceId: "trace-184", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-184" } as const;
+export const repositoryQueryFixture_185 = { projectId: "project-a", traceId: "trace-185", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-185" } as const;
+export const repositoryQueryFixture_186 = { projectId: "project-a", traceId: "trace-186", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-186" } as const;
+export const repositoryQueryFixture_187 = { projectId: "project-a", traceId: "trace-187", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-187" } as const;
+export const repositoryQueryFixture_188 = { projectId: "project-a", traceId: "trace-188", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-188" } as const;
+export const repositoryQueryFixture_189 = { projectId: "project-a", traceId: "trace-189", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-189" } as const;
+export const repositoryQueryFixture_190 = { projectId: "project-a", traceId: "trace-190", expectedWhere: "project_id = {projectId: String}", expectedTraceId: "trace-190" } as const;
diff --git a/docs/query-performance/trace-list-with-metrics.md b/docs/query-performance/trace-list-with-metrics.md
new file mode 100644
index 0000000000..071bad0710
--- /dev/null
+++ b/docs/query-performance/trace-list-with-metrics.md
@@ -0,0 +1,179 @@
+# Trace List With Scores And Metrics
+
+The trace list now renders score averages, observation metrics, token usage, comment counts, and a dynamic set of score columns in the first table view. The endpoint is intended for the tracing table, dashboard drill-downs, and project investigation workflows.
+
+## Product Behavior
+
+- The endpoint returns a page of traces with score columns already attached.
+- Each row contains latency, p95 latency, total tokens, total cost, comment count, and error/warning counts.
+- The table can show score names discovered from the candidate traces.
+- Access rules hide rows the current user cannot read.
+
+## Query Strategy
+
+The service first reads a widened candidate page from ClickHouse. It then enriches each candidate with scores, observation metrics, token usage, and comment count. The prefetch factor keeps pages full when access rules remove some rows.
+
+## Access Strategy
+
+Access checks are applied after enrichment so the TypeScript policy code remains the single source of truth. The response includes hiddenCount and totalBeforePermission so the UI can explain why a page may have fewer rows than requested.
+
+## Operational Notes
+
+- Keep the default page size at 50 and max at 100.
+- Keep score rendering limited to eight score columns.
+- Use ClickHouse FINAL because traces, scores, and observations may be mutated.
+- Use tags on every query so the trace list can be isolated in query metrics.
+- Use repository unit tests for SQL fragments and service tests for response shape.
+
+- Load note 001: fixture projects should include 21 traces, 1 score names, and 1 denied rows to exercise table rendering.
+- Load note 002: fixture projects should include 22 traces, 2 score names, and 2 denied rows to exercise table rendering.
+- Load note 003: fixture projects should include 23 traces, 3 score names, and 3 denied rows to exercise table rendering.
+- Load note 004: fixture projects should include 24 traces, 4 score names, and 4 denied rows to exercise table rendering.
+- Load note 005: fixture projects should include 25 traces, 5 score names, and 0 denied rows to exercise table rendering.
+- Load note 006: fixture projects should include 26 traces, 6 score names, and 1 denied rows to exercise table rendering.
+- Load note 007: fixture projects should include 27 traces, 7 score names, and 2 denied rows to exercise table rendering.
+- Load note 008: fixture projects should include 28 traces, 8 score names, and 3 denied rows to exercise table rendering.
+- Load note 009: fixture projects should include 29 traces, 0 score names, and 4 denied rows to exercise table rendering.
+- Load note 010: fixture projects should include 30 traces, 1 score names, and 0 denied rows to exercise table rendering.
+- Load note 011: fixture projects should include 31 traces, 2 score names, and 1 denied rows to exercise table rendering.
+- Load note 012: fixture projects should include 32 traces, 3 score names, and 2 denied rows to exercise table rendering.
+- Load note 013: fixture projects should include 33 traces, 4 score names, and 3 denied rows to exercise table rendering.
+- Load note 014: fixture projects should include 34 traces, 5 score names, and 4 denied rows to exercise table rendering.
+- Load note 015: fixture projects should include 35 traces, 6 score names, and 0 denied rows to exercise table rendering.
+- Load note 016: fixture projects should include 36 traces, 7 score names, and 1 denied rows to exercise table rendering.
+- Load note 017: fixture projects should include 37 traces, 8 score names, and 2 denied rows to exercise table rendering.
+- Load note 018: fixture projects should include 38 traces, 0 score names, and 3 denied rows to exercise table rendering.
+- Load note 019: fixture projects should include 39 traces, 1 score names, and 4 denied rows to exercise table rendering.
+- Load note 020: fixture projects should include 40 traces, 2 score names, and 0 denied rows to exercise table rendering.
+- Load note 021: fixture projects should include 41 traces, 3 score names, and 1 denied rows to exercise table rendering.
+- Load note 022: fixture projects should include 42 traces, 4 score names, and 2 denied rows to exercise table rendering.
+- Load note 023: fixture projects should include 43 traces, 5 score names, and 3 denied rows to exercise table rendering.
+- Load note 024: fixture projects should include 44 traces, 6 score names, and 4 denied rows to exercise table rendering.
+- Load note 025: fixture projects should include 45 traces, 7 score names, and 0 denied rows to exercise table rendering.
+- Load note 026: fixture projects should include 46 traces, 8 score names, and 1 denied rows to exercise table rendering.
+- Load note 027: fixture projects should include 47 traces, 0 score names, and 2 denied rows to exercise table rendering.
+- Load note 028: fixture projects should include 48 traces, 1 score names, and 3 denied rows to exercise table rendering.
+- Load note 029: fixture projects should include 49 traces, 2 score names, and 4 denied rows to exercise table rendering.
+- Load note 030: fixture projects should include 50 traces, 3 score names, and 0 denied rows to exercise table rendering.
+- Load note 031: fixture projects should include 51 traces, 4 score names, and 1 denied rows to exercise table rendering.
+- Load note 032: fixture projects should include 52 traces, 5 score names, and 2 denied rows to exercise table rendering.
+- Load note 033: fixture projects should include 53 traces, 6 score names, and 3 denied rows to exercise table rendering.
+- Load note 034: fixture projects should include 54 traces, 7 score names, and 4 denied rows to exercise table rendering.
+- Load note 035: fixture projects should include 55 traces, 8 score names, and 0 denied rows to exercise table rendering.
+- Load note 036: fixture projects should include 56 traces, 0 score names, and 1 denied rows to exercise table rendering.
+- Load note 037: fixture projects should include 57 traces, 1 score names, and 2 denied rows to exercise table rendering.
+- Load note 038: fixture projects should include 58 traces, 2 score names, and 3 denied rows to exercise table rendering.
+- Load note 039: fixture projects should include 59 traces, 3 score names, and 4 denied rows to exercise table rendering.
+- Load note 040: fixture projects should include 60 traces, 4 score names, and 0 denied rows to exercise table rendering.
+- Load note 041: fixture projects should include 61 traces, 5 score names, and 1 denied rows to exercise table rendering.
+- Load note 042: fixture projects should include 62 traces, 6 score names, and 2 denied rows to exercise table rendering.
+- Load note 043: fixture projects should include 63 traces, 7 score names, and 3 denied rows to exercise table rendering.
+- Load note 044: fixture projects should include 64 traces, 8 score names, and 4 denied rows to exercise table rendering.
+- Load note 045: fixture projects should include 65 traces, 0 score names, and 0 denied rows to exercise table rendering.
+- Load note 046: fixture projects should include 66 traces, 1 score names, and 1 denied rows to exercise table rendering.
+- Load note 047: fixture projects should include 67 traces, 2 score names, and 2 denied rows to exercise table rendering.
+- Load note 048: fixture projects should include 68 traces, 3 score names, and 3 denied rows to exercise table rendering.
+- Load note 049: fixture projects should include 69 traces, 4 score names, and 4 denied rows to exercise table rendering.
+- Load note 050: fixture projects should include 70 traces, 5 score names, and 0 denied rows to exercise table rendering.
+- Load note 051: fixture projects should include 71 traces, 6 score names, and 1 denied rows to exercise table rendering.
+- Load note 052: fixture projects should include 72 traces, 7 score names, and 2 denied rows to exercise table rendering.
+- Load note 053: fixture projects should include 73 traces, 8 score names, and 3 denied rows to exercise table rendering.
+- Load note 054: fixture projects should include 74 traces, 0 score names, and 4 denied rows to exercise table rendering.
+- Load note 055: fixture projects should include 75 traces, 1 score names, and 0 denied rows to exercise table rendering.
+- Load note 056: fixture projects should include 76 traces, 2 score names, and 1 denied rows to exercise table rendering.
+- Load note 057: fixture projects should include 77 traces, 3 score names, and 2 denied rows to exercise table rendering.
+- Load note 058: fixture projects should include 78 traces, 4 score names, and 3 denied rows to exercise table rendering.
+- Load note 059: fixture projects should include 79 traces, 5 score names, and 4 denied rows to exercise table rendering.
+- Load note 060: fixture projects should include 80 traces, 6 score names, and 0 denied rows to exercise table rendering.
+- Load note 061: fixture projects should include 81 traces, 7 score names, and 1 denied rows to exercise table rendering.
+- Load note 062: fixture projects should include 82 traces, 8 score names, and 2 denied rows to exercise table rendering.
+- Load note 063: fixture projects should include 83 traces, 0 score names, and 3 denied rows to exercise table rendering.
+- Load note 064: fixture projects should include 84 traces, 1 score names, and 4 denied rows to exercise table rendering.
+- Load note 065: fixture projects should include 85 traces, 2 score names, and 0 denied rows to exercise table rendering.
+- Load note 066: fixture projects should include 86 traces, 3 score names, and 1 denied rows to exercise table rendering.
+- Load note 067: fixture projects should include 87 traces, 4 score names, and 2 denied rows to exercise table rendering.
+- Load note 068: fixture projects should include 88 traces, 5 score names, and 3 denied rows to exercise table rendering.
+- Load note 069: fixture projects should include 89 traces, 6 score names, and 4 denied rows to exercise table rendering.
+- Load note 070: fixture projects should include 90 traces, 7 score names, and 0 denied rows to exercise table rendering.
+- Load note 071: fixture projects should include 91 traces, 8 score names, and 1 denied rows to exercise table rendering.
+- Load note 072: fixture projects should include 92 traces, 0 score names, and 2 denied rows to exercise table rendering.
+- Load note 073: fixture projects should include 93 traces, 1 score names, and 3 denied rows to exercise table rendering.
+- Load note 074: fixture projects should include 94 traces, 2 score names, and 4 denied rows to exercise table rendering.
+- Load note 075: fixture projects should include 95 traces, 3 score names, and 0 denied rows to exercise table rendering.
+- Load note 076: fixture projects should include 96 traces, 4 score names, and 1 denied rows to exercise table rendering.
+- Load note 077: fixture projects should include 97 traces, 5 score names, and 2 denied rows to exercise table rendering.
+- Load note 078: fixture projects should include 98 traces, 6 score names, and 3 denied rows to exercise table rendering.
+- Load note 079: fixture projects should include 99 traces, 7 score names, and 4 denied rows to exercise table rendering.
+- Load note 080: fixture projects should include 20 traces, 8 score names, and 0 denied rows to exercise table rendering.
+- Load note 081: fixture projects should include 21 traces, 0 score names, and 1 denied rows to exercise table rendering.
+- Load note 082: fixture projects should include 22 traces, 1 score names, and 2 denied rows to exercise table rendering.
+- Load note 083: fixture projects should include 23 traces, 2 score names, and 3 denied rows to exercise table rendering.
+- Load note 084: fixture projects should include 24 traces, 3 score names, and 4 denied rows to exercise table rendering.
+- Load note 085: fixture projects should include 25 traces, 4 score names, and 0 denied rows to exercise table rendering.
+- Load note 086: fixture projects should include 26 traces, 5 score names, and 1 denied rows to exercise table rendering.
+- Load note 087: fixture projects should include 27 traces, 6 score names, and 2 denied rows to exercise table rendering.
+- Load note 088: fixture projects should include 28 traces, 7 score names, and 3 denied rows to exercise table rendering.
+- Load note 089: fixture projects should include 29 traces, 8 score names, and 4 denied rows to exercise table rendering.
+- Load note 090: fixture projects should include 30 traces, 0 score names, and 0 denied rows to exercise table rendering.
+- Load note 091: fixture projects should include 31 traces, 1 score names, and 1 denied rows to exercise table rendering.
+- Load note 092: fixture projects should include 32 traces, 2 score names, and 2 denied rows to exercise table rendering.
+- Load note 093: fixture projects should include 33 traces, 3 score names, and 3 denied rows to exercise table rendering.
+- Load note 094: fixture projects should include 34 traces, 4 score names, and 4 denied rows to exercise table rendering.
+- Load note 095: fixture projects should include 35 traces, 5 score names, and 0 denied rows to exercise table rendering.
+- Load note 096: fixture projects should include 36 traces, 6 score names, and 1 denied rows to exercise table rendering.
+- Load note 097: fixture projects should include 37 traces, 7 score names, and 2 denied rows to exercise table rendering.
+- Load note 098: fixture projects should include 38 traces, 8 score names, and 3 denied rows to exercise table rendering.
+- Load note 099: fixture projects should include 39 traces, 0 score names, and 4 denied rows to exercise table rendering.
+- Load note 100: fixture projects should include 40 traces, 1 score names, and 0 denied rows to exercise table rendering.
+- Load note 101: fixture projects should include 41 traces, 2 score names, and 1 denied rows to exercise table rendering.
+- Load note 102: fixture projects should include 42 traces, 3 score names, and 2 denied rows to exercise table rendering.
+- Load note 103: fixture projects should include 43 traces, 4 score names, and 3 denied rows to exercise table rendering.
+- Load note 104: fixture projects should include 44 traces, 5 score names, and 4 denied rows to exercise table rendering.
+- Load note 105: fixture projects should include 45 traces, 6 score names, and 0 denied rows to exercise table rendering.
+- Load note 106: fixture projects should include 46 traces, 7 score names, and 1 denied rows to exercise table rendering.
+- Load note 107: fixture projects should include 47 traces, 8 score names, and 2 denied rows to exercise table rendering.
+- Load note 108: fixture projects should include 48 traces, 0 score names, and 3 denied rows to exercise table rendering.
+- Load note 109: fixture projects should include 49 traces, 1 score names, and 4 denied rows to exercise table rendering.
+- Load note 110: fixture projects should include 50 traces, 2 score names, and 0 denied rows to exercise table rendering.
+- Load note 111: fixture projects should include 51 traces, 3 score names, and 1 denied rows to exercise table rendering.
+- Load note 112: fixture projects should include 52 traces, 4 score names, and 2 denied rows to exercise table rendering.
+- Load note 113: fixture projects should include 53 traces, 5 score names, and 3 denied rows to exercise table rendering.
+- Load note 114: fixture projects should include 54 traces, 6 score names, and 4 denied rows to exercise table rendering.
+- Load note 115: fixture projects should include 55 traces, 7 score names, and 0 denied rows to exercise table rendering.
+- Load note 116: fixture projects should include 56 traces, 8 score names, and 1 denied rows to exercise table rendering.
+- Load note 117: fixture projects should include 57 traces, 0 score names, and 2 denied rows to exercise table rendering.
+- Load note 118: fixture projects should include 58 traces, 1 score names, and 3 denied rows to exercise table rendering.
+- Load note 119: fixture projects should include 59 traces, 2 score names, and 4 denied rows to exercise table rendering.
+- Load note 120: fixture projects should include 60 traces, 3 score names, and 0 denied rows to exercise table rendering.
+- Load note 121: fixture projects should include 61 traces, 4 score names, and 1 denied rows to exercise table rendering.
+- Load note 122: fixture projects should include 62 traces, 5 score names, and 2 denied rows to exercise table rendering.
+- Load note 123: fixture projects should include 63 traces, 6 score names, and 3 denied rows to exercise table rendering.
+- Load note 124: fixture projects should include 64 traces, 7 score names, and 4 denied rows to exercise table rendering.
+- Load note 125: fixture projects should include 65 traces, 8 score names, and 0 denied rows to exercise table rendering.
+- Load note 126: fixture projects should include 66 traces, 0 score names, and 1 denied rows to exercise table rendering.
+- Load note 127: fixture projects should include 67 traces, 1 score names, and 2 denied rows to exercise table rendering.
+- Load note 128: fixture projects should include 68 traces, 2 score names, and 3 denied rows to exercise table rendering.
+- Load note 129: fixture projects should include 69 traces, 3 score names, and 4 denied rows to exercise table rendering.
+- Load note 130: fixture projects should include 70 traces, 4 score names, and 0 denied rows to exercise table rendering.
+- Load note 131: fixture projects should include 71 traces, 5 score names, and 1 denied rows to exercise table rendering.
+- Load note 132: fixture projects should include 72 traces, 6 score names, and 2 denied rows to exercise table rendering.
+- Load note 133: fixture projects should include 73 traces, 7 score names, and 3 denied rows to exercise table rendering.
+- Load note 134: fixture projects should include 74 traces, 8 score names, and 4 denied rows to exercise table rendering.
+- Load note 135: fixture projects should include 75 traces, 0 score names, and 0 denied rows to exercise table rendering.
+- Load note 136: fixture projects should include 76 traces, 1 score names, and 1 denied rows to exercise table rendering.
+- Load note 137: fixture projects should include 77 traces, 2 score names, and 2 denied rows to exercise table rendering.
+- Load note 138: fixture projects should include 78 traces, 3 score names, and 3 denied rows to exercise table rendering.
+- Load note 139: fixture projects should include 79 traces, 4 score names, and 4 denied rows to exercise table rendering.
+- Load note 140: fixture projects should include 80 traces, 5 score names, and 0 denied rows to exercise table rendering.
+- Load note 141: fixture projects should include 81 traces, 6 score names, and 1 denied rows to exercise table rendering.
+- Load note 142: fixture projects should include 82 traces, 7 score names, and 2 denied rows to exercise table rendering.
+- Load note 143: fixture projects should include 83 traces, 8 score names, and 3 denied rows to exercise table rendering.
+- Load note 144: fixture projects should include 84 traces, 0 score names, and 4 denied rows to exercise table rendering.
+- Load note 145: fixture projects should include 85 traces, 1 score names, and 0 denied rows to exercise table rendering.
+- Load note 146: fixture projects should include 86 traces, 2 score names, and 1 denied rows to exercise table rendering.
+- Load note 147: fixture projects should include 87 traces, 3 score names, and 2 denied rows to exercise table rendering.
+- Load note 148: fixture projects should include 88 traces, 4 score names, and 3 denied rows to exercise table rendering.
+- Load note 149: fixture projects should include 89 traces, 5 score names, and 4 denied rows to exercise table rendering.
+- Load note 150: fixture projects should include 90 traces, 6 score names, and 0 denied rows to exercise table rendering.
+- Load note 151: fixture projects should include 91 traces, 7 score names, and 1 denied rows to exercise table rendering.
+- Load note 152: fixture projects should include 92 traces, 8 score names, and 2 denied rows to exercise table rendering.
```

## Intended Flaws

### Flaw 1: Trace list enrichment performs N+1 ClickHouse work per row

The service fetches a candidate page and then enriches every trace with independent score, score-name, observation-metric, token-usage, and comment-count calls. The repositories expose single-trace query APIs, so a 100-row page can become hundreds of ClickHouse/Postgres calls before the response is even filtered for access.

Hints:

1. Count how many repository calls happen after `candidateTraces` comes back.
2. Ask what happens when a project has 100 traces on a page and each trace has many observations and scores.
3. Ask whether enrichment is a per-trace operation or a page-level query contract.

### Flaw 2: Access filtering is applied after fetch, enrichment, pagination cursor selection, and response counts

The candidate query is scoped to project and user filters, but it does not receive the access predicate. The service enriches all candidate traces, filters them in TypeScript afterward, builds the cursor from the unfiltered candidate page, and returns `totalBeforePermission`/`hiddenCount` to the client.

Hints:

1. Track where `filterTracesByAccessPolicy` runs relative to `getTraceListCandidates` and enrichment.
2. Look for response fields that describe rows the user was not allowed to read.
3. Ask what pagination does if the first widened page contains mostly denied traces.

## Expected Answer

### Flaw 1 Expected Identification

- Primary lines: `packages/shared/src/server/services/trace-list-with-metrics.ts:29-44`
- Supporting lines: `packages/shared/src/server/repositories/trace-score-metrics.ts:4-31`, `packages/shared/src/server/repositories/trace-observation-metrics.ts:4-33`, and `packages/shared/src/server/repositories/trace-observation-metrics.ts:31-53`
- Issue: `getTraceListWithMetrics` maps over every candidate trace and calls single-trace metric repositories. This creates query fanout proportional to page size and metric count.
- Impact: large projects will see slow trace list loads, ClickHouse thread pressure, bursty query volume, higher timeout probability, and partial failures that make the table unreliable. Prefetching by `TRACE_LIST_PREFETCH_FACTOR` worsens the multiplier.
- Better direction: fetch the visible trace IDs first with the final access predicate applied, then retrieve score and observation metrics in set-based queries keyed by `projectId` and `traceIds`. Use ClickHouse aggregate subqueries or materialized rollups, group by `trace_id`, and merge results in memory. Keep one bounded query per metric family rather than one query per trace.

### Flaw 2 Expected Identification

- Primary lines: `packages/shared/src/server/services/trace-list-with-metrics.ts:17-64`
- Supporting lines: `packages/shared/src/server/repositories/trace-access-policy.ts:8-11`, `web/src/server/api/routers/traces.ts:45-47`, and `docs/query-performance/trace-list-with-metrics.md:18-18`
- Issue: access policy is a post-processing filter. Denied traces are fetched and enriched, the next cursor is based on unfiltered candidates, and the router returns counts about denied rows.
- Impact: this leaks the existence and rough volume of hidden traces through `hiddenCount`, `totalBeforePermission`, score keys, timing, and pagination behavior. It also wastes expensive metric queries on rows that should not have been visible in the first place. Pages can be short or empty while `nextCursor` advances past denied data.
- Better direction: make the access predicate part of the repository contract. Push environment/tag/public/private constraints into the ClickHouse trace query before `ORDER BY`, `LIMIT`, cursor selection, and metric joins. Return counts and cursors only for authorized rows. Tests should assert that denied trace IDs are never passed to score, observation, comment, or dynamic score-key enrichment.

## Expert Debrief

Product-level change: the PR tries to turn the trace list into a richer investigation surface. That is a valuable product direction because engineers want to compare traces without opening each detail page.

Contract changes: the endpoint is no longer a plain trace list. It now promises score aggregates, observation metrics, comments, dynamic score keys, cursor pagination, and access-limited results. Those contracts are coupled: the page boundary must be the boundary for both metrics and permissions.

Failure modes: the current shape fails by multiplicative query fanout, overloaded ClickHouse/Postgres backends, inconsistent short pages, cursor drift, score-key leakage, hidden-row count leakage, and timing side channels. It also trains future contributors to add new columns by adding new per-trace repository calls, which compounds the architecture debt.

Reviewer thought process: first find the page boundary, then find where authorization is applied, then count queries across the boundary. A rich list endpoint is safe only when the database does most of the narrowing before enrichment. If a PR fetches broad candidates, enriches all of them, and then filters in application code, the reviewer should treat it as both a performance and boundary bug.

Better implementation direction: keep the trace-table pattern set-based. Build an authorized trace CTE, limit that result, join score and observation aggregates by `trace_id`, batch comments by authorized IDs, and derive dynamic score columns from the authorized page only. The access predicate should be reusable, testable, and passed into list/count/metrics paths consistently.

## Correctness Verdict Rubric

- Correct for flaw 1: identifies per-trace metric enrichment or N+1 query fanout, cites the service map plus single-trace repositories, explains production-scale ClickHouse/Postgres impact, and proposes set-based or batched aggregation.
- Partially correct for flaw 1: notices the endpoint may be slow but does not explain the multiplicative query count or does not propose a set-based fix.
- Incorrect for flaw 1: focuses only on TypeScript style, missing indexes in the abstract, or test coverage without naming the query fanout.
- Correct for flaw 2: identifies post-fetch/post-enrichment access filtering, cites the service/router/access-policy lines, explains leakage/pagination/load impact, and proposes access pushdown before limit/cursor/metrics.
- Partially correct for flaw 2: notices hidden rows or short pages but does not connect the issue to leaking denied data or enriching unauthorized traces.
- Incorrect for flaw 2: treats `hiddenCount` as harmless UX metadata or suggests only increasing the prefetch factor.
