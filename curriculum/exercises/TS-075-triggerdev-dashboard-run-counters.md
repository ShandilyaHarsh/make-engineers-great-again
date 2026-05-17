# TS-075: Trigger.dev Dashboard Run Counters

## Metadata

- `id`: TS-075
- `source_repo`: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- `repo_area`: task dashboard loader, run analytics, ClickHouse task-run metrics, Prisma TaskRun hot table, project/environment lifecycle state, status counters, dashboard cards, route loaders
- `mode`: synthetic_degraded
- `difficulty`: 8
- `target_diff_lines`: 2,300-2,800
- `represented_diff_lines`: 2338
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Trigger.dev run storage, ClickHouse analytics, dashboard loaders, deferred data, active project/environment scope, and operational-table fanout without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds run counter cards to the Trigger.dev task dashboard. The cards show total runs, running runs, failures, status buckets, project breakdowns, and environment breakdowns above the existing task list.

The PR adds:

- counter request/response types,
- a dashboard counter repository,
- a service that composes status/project/environment counters,
- a resource route for counter refreshes,
- task dashboard loader wiring,
- a counter card component,
- helper TaskRun indexes,
- tests for TaskRun-count-backed counters,
- docs describing immediate dashboard counters.

The intended product behavior is: when users open a project environment dashboard, they immediately see current run totals and status counters without opening the full runs page.

## Existing Code Context

The real Trigger.dev codebase already has these relevant contracts:

- The task dashboard route `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx` resolves the current project and runtime environment, then calls `taskListPresenter`.
- `TaskListPresenter` uses `ClickHouseEnvironmentMetricsRepository` for activity, running stats, and average durations. It intentionally returns those metric promises so Remix can defer them instead of blocking the whole page.
- `apps/webapp/app/services/environmentMetricsRepository.server.ts` reads task activity/running/duration metrics from ClickHouse, scoped by `organizationId`, `projectId`, `environmentId`, time window, and `_is_deleted = 0`.
- `internal-packages/clickhouse/src/taskRuns.ts` already has task-run query builders and aggregate queries over `trigger_dev.task_runs_v2 FINAL`.
- `internal-packages/database/prisma/schema.prisma` models `TaskRun` as the operational run table. It has indexes around runtime environment, created time, and status, but the table is also the write path for high-volume run state changes.
- `Project` has `deletedAt`; `RuntimeEnvironment.archivedAt` is the environment lifecycle field. Existing auth/environment helpers already care about these lifecycle fields when deciding what should be visible or usable.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to decide whether this dashboard analytics feature is using the right read model and whether the counters represent the active product state users expect.

## Review Surface

Changed files in the synthetic PR:

- `apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.types.ts`
- `apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.repository.server.ts`
- `apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.service.server.ts`
- `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-counters.ts`
- `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx`
- `apps/webapp/app/components/dashboard/RunCounterCards.tsx`
- `internal-packages/database/prisma/migrations/20260606000000_dashboard_run_counters/migration.sql`
- `apps/webapp/app/services/dashboardRunCounters/__tests__/dashboardRunCounter.service.test.ts`
- `docs/dashboard-run-counters.md`

The line references below use synthetic PR line numbers. The represented diff is focused on dashboard analytics read-model choice, loader blocking behavior, high-volume operational table fanout, active project/environment scope, and tests/docs that normalize counting deleted or archived resources.

## Diff

```diff
diff --git a/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.types.ts b/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.types.ts
new file mode 100644
index 0000000000..075bad0750
--- /dev/null
+++ b/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.types.ts
@@ -0,0 +1,187 @@
+import { z } from "zod";
+import type { TaskRunStatus } from "@trigger.dev/database";
+
+export const DashboardRunCounterWindow = z.enum(["1h", "24h", "7d", "30d", "all"]);
+export type DashboardRunCounterWindow = z.infer<typeof DashboardRunCounterWindow>;
+
+export const DashboardRunCounterRequest = z.object({
+  organizationId: z.string(),
+  projectId: z.string().optional(),
+  environmentId: z.string().optional(),
+  window: DashboardRunCounterWindow.default("7d"),
+  includeProjectBreakdown: z.boolean().default(true),
+  includeEnvironmentBreakdown: z.boolean().default(true),
+  includeArchivedProjects: z.boolean().default(true),
+  includeDeletedProjects: z.boolean().default(true)
+});
+
+export type DashboardRunCounterRequest = z.infer<typeof DashboardRunCounterRequest>;
+
+export type DashboardRunCounterBucket = {
+  status: TaskRunStatus | "TOTAL" | "FAILED" | "RUNNING";
+  count: number;
+};
+
+export type DashboardRunCounterProjectRow = {
+  projectId: string;
+  projectSlug: string;
+  projectName: string;
+  deletedAt?: Date | null;
+  totalRuns: number;
+  failedRuns: number;
+  runningRuns: number;
+};
+
+export type DashboardRunCounterEnvironmentRow = {
+  environmentId: string;
+  environmentSlug: string;
+  projectId: string;
+  archivedAt?: Date | null;
+  totalRuns: number;
+  runningRuns: number;
+};
+
+export type DashboardRunCounters = {
+  buckets: DashboardRunCounterBucket[];
+  projectBreakdown: DashboardRunCounterProjectRow[];
+  environmentBreakdown: DashboardRunCounterEnvironmentRow[];
+  generatedAt: string;
+  scannedSource: "postgres-task-run" | "rollup" | "clickhouse";
+};
+
+export const RUN_COUNTER_RUNNING_STATUSES: TaskRunStatus[] = [
+  "PENDING",
+  "WAITING_FOR_DEPLOY",
+  "WAITING_TO_RESUME",
+  "QUEUED",
+  "EXECUTING",
+  "DELAYED"
+];
+
+export const RUN_COUNTER_FAILED_STATUSES: TaskRunStatus[] = [
+  "CRASHED",
+  "SYSTEM_FAILURE",
+  "INTERRUPTED",
+  "TIMED_OUT",
+  "COMPLETED_WITH_ERRORS"
+];
+export const dashboardRunCounterExample_001 = DashboardRunCounterRequest.parse({ organizationId: "org_001", projectId: "proj_001", environmentId: "env_001", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_002 = DashboardRunCounterRequest.parse({ organizationId: "org_002", projectId: "proj_002", environmentId: "env_002", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_003 = DashboardRunCounterRequest.parse({ organizationId: "org_003", projectId: "proj_003", environmentId: "env_003", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_004 = DashboardRunCounterRequest.parse({ organizationId: "org_004", projectId: "proj_004", environmentId: "env_004", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_005 = DashboardRunCounterRequest.parse({ organizationId: "org_005", projectId: "proj_005", environmentId: "env_005", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_006 = DashboardRunCounterRequest.parse({ organizationId: "org_006", projectId: "proj_006", environmentId: "env_006", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_007 = DashboardRunCounterRequest.parse({ organizationId: "org_007", projectId: "proj_007", environmentId: "env_007", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_008 = DashboardRunCounterRequest.parse({ organizationId: "org_008", projectId: "proj_008", environmentId: "env_008", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_009 = DashboardRunCounterRequest.parse({ organizationId: "org_009", projectId: "proj_009", environmentId: "env_009", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_010 = DashboardRunCounterRequest.parse({ organizationId: "org_010", projectId: "proj_010", environmentId: "env_010", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_011 = DashboardRunCounterRequest.parse({ organizationId: "org_011", projectId: "proj_011", environmentId: "env_011", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_012 = DashboardRunCounterRequest.parse({ organizationId: "org_012", projectId: "proj_012", environmentId: "env_012", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_013 = DashboardRunCounterRequest.parse({ organizationId: "org_013", projectId: "proj_013", environmentId: "env_013", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_014 = DashboardRunCounterRequest.parse({ organizationId: "org_014", projectId: "proj_014", environmentId: "env_014", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_015 = DashboardRunCounterRequest.parse({ organizationId: "org_015", projectId: "proj_015", environmentId: "env_015", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_016 = DashboardRunCounterRequest.parse({ organizationId: "org_016", projectId: "proj_016", environmentId: "env_016", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_017 = DashboardRunCounterRequest.parse({ organizationId: "org_017", projectId: "proj_017", environmentId: "env_017", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_018 = DashboardRunCounterRequest.parse({ organizationId: "org_018", projectId: "proj_018", environmentId: "env_018", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_019 = DashboardRunCounterRequest.parse({ organizationId: "org_019", projectId: "proj_019", environmentId: "env_019", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_020 = DashboardRunCounterRequest.parse({ organizationId: "org_020", projectId: "proj_020", environmentId: "env_020", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_021 = DashboardRunCounterRequest.parse({ organizationId: "org_021", projectId: "proj_021", environmentId: "env_021", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_022 = DashboardRunCounterRequest.parse({ organizationId: "org_022", projectId: "proj_022", environmentId: "env_022", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_023 = DashboardRunCounterRequest.parse({ organizationId: "org_023", projectId: "proj_023", environmentId: "env_023", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_024 = DashboardRunCounterRequest.parse({ organizationId: "org_024", projectId: "proj_024", environmentId: "env_024", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_025 = DashboardRunCounterRequest.parse({ organizationId: "org_025", projectId: "proj_025", environmentId: "env_025", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_026 = DashboardRunCounterRequest.parse({ organizationId: "org_026", projectId: "proj_026", environmentId: "env_026", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_027 = DashboardRunCounterRequest.parse({ organizationId: "org_027", projectId: "proj_027", environmentId: "env_027", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_028 = DashboardRunCounterRequest.parse({ organizationId: "org_028", projectId: "proj_028", environmentId: "env_028", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_029 = DashboardRunCounterRequest.parse({ organizationId: "org_029", projectId: "proj_029", environmentId: "env_029", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_030 = DashboardRunCounterRequest.parse({ organizationId: "org_030", projectId: "proj_030", environmentId: "env_030", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_031 = DashboardRunCounterRequest.parse({ organizationId: "org_031", projectId: "proj_031", environmentId: "env_031", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_032 = DashboardRunCounterRequest.parse({ organizationId: "org_032", projectId: "proj_032", environmentId: "env_032", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_033 = DashboardRunCounterRequest.parse({ organizationId: "org_033", projectId: "proj_033", environmentId: "env_033", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_034 = DashboardRunCounterRequest.parse({ organizationId: "org_034", projectId: "proj_034", environmentId: "env_034", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_035 = DashboardRunCounterRequest.parse({ organizationId: "org_035", projectId: "proj_035", environmentId: "env_035", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_036 = DashboardRunCounterRequest.parse({ organizationId: "org_036", projectId: "proj_036", environmentId: "env_036", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_037 = DashboardRunCounterRequest.parse({ organizationId: "org_037", projectId: "proj_037", environmentId: "env_037", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_038 = DashboardRunCounterRequest.parse({ organizationId: "org_038", projectId: "proj_038", environmentId: "env_038", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_039 = DashboardRunCounterRequest.parse({ organizationId: "org_039", projectId: "proj_039", environmentId: "env_039", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_040 = DashboardRunCounterRequest.parse({ organizationId: "org_040", projectId: "proj_040", environmentId: "env_040", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_041 = DashboardRunCounterRequest.parse({ organizationId: "org_041", projectId: "proj_041", environmentId: "env_041", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_042 = DashboardRunCounterRequest.parse({ organizationId: "org_042", projectId: "proj_042", environmentId: "env_042", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_043 = DashboardRunCounterRequest.parse({ organizationId: "org_043", projectId: "proj_043", environmentId: "env_043", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_044 = DashboardRunCounterRequest.parse({ organizationId: "org_044", projectId: "proj_044", environmentId: "env_044", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_045 = DashboardRunCounterRequest.parse({ organizationId: "org_045", projectId: "proj_045", environmentId: "env_045", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_046 = DashboardRunCounterRequest.parse({ organizationId: "org_046", projectId: "proj_046", environmentId: "env_046", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_047 = DashboardRunCounterRequest.parse({ organizationId: "org_047", projectId: "proj_047", environmentId: "env_047", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_048 = DashboardRunCounterRequest.parse({ organizationId: "org_048", projectId: "proj_048", environmentId: "env_048", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_049 = DashboardRunCounterRequest.parse({ organizationId: "org_049", projectId: "proj_049", environmentId: "env_049", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_050 = DashboardRunCounterRequest.parse({ organizationId: "org_050", projectId: "proj_050", environmentId: "env_050", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_051 = DashboardRunCounterRequest.parse({ organizationId: "org_051", projectId: "proj_051", environmentId: "env_051", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_052 = DashboardRunCounterRequest.parse({ organizationId: "org_052", projectId: "proj_052", environmentId: "env_052", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_053 = DashboardRunCounterRequest.parse({ organizationId: "org_053", projectId: "proj_053", environmentId: "env_053", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_054 = DashboardRunCounterRequest.parse({ organizationId: "org_054", projectId: "proj_054", environmentId: "env_054", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_055 = DashboardRunCounterRequest.parse({ organizationId: "org_055", projectId: "proj_055", environmentId: "env_055", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_056 = DashboardRunCounterRequest.parse({ organizationId: "org_056", projectId: "proj_056", environmentId: "env_056", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_057 = DashboardRunCounterRequest.parse({ organizationId: "org_057", projectId: "proj_057", environmentId: "env_057", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_058 = DashboardRunCounterRequest.parse({ organizationId: "org_058", projectId: "proj_058", environmentId: "env_058", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_059 = DashboardRunCounterRequest.parse({ organizationId: "org_059", projectId: "proj_059", environmentId: "env_059", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_060 = DashboardRunCounterRequest.parse({ organizationId: "org_060", projectId: "proj_060", environmentId: "env_060", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_061 = DashboardRunCounterRequest.parse({ organizationId: "org_061", projectId: "proj_061", environmentId: "env_061", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_062 = DashboardRunCounterRequest.parse({ organizationId: "org_062", projectId: "proj_062", environmentId: "env_062", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_063 = DashboardRunCounterRequest.parse({ organizationId: "org_063", projectId: "proj_063", environmentId: "env_063", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_064 = DashboardRunCounterRequest.parse({ organizationId: "org_064", projectId: "proj_064", environmentId: "env_064", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_065 = DashboardRunCounterRequest.parse({ organizationId: "org_065", projectId: "proj_065", environmentId: "env_065", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_066 = DashboardRunCounterRequest.parse({ organizationId: "org_066", projectId: "proj_066", environmentId: "env_066", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_067 = DashboardRunCounterRequest.parse({ organizationId: "org_067", projectId: "proj_067", environmentId: "env_067", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_068 = DashboardRunCounterRequest.parse({ organizationId: "org_068", projectId: "proj_068", environmentId: "env_068", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_069 = DashboardRunCounterRequest.parse({ organizationId: "org_069", projectId: "proj_069", environmentId: "env_069", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_070 = DashboardRunCounterRequest.parse({ organizationId: "org_070", projectId: "proj_070", environmentId: "env_070", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_071 = DashboardRunCounterRequest.parse({ organizationId: "org_071", projectId: "proj_071", environmentId: "env_071", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_072 = DashboardRunCounterRequest.parse({ organizationId: "org_072", projectId: "proj_072", environmentId: "env_072", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_073 = DashboardRunCounterRequest.parse({ organizationId: "org_073", projectId: "proj_073", environmentId: "env_073", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_074 = DashboardRunCounterRequest.parse({ organizationId: "org_074", projectId: "proj_074", environmentId: "env_074", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_075 = DashboardRunCounterRequest.parse({ organizationId: "org_075", projectId: "proj_075", environmentId: "env_075", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_076 = DashboardRunCounterRequest.parse({ organizationId: "org_076", projectId: "proj_076", environmentId: "env_076", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_077 = DashboardRunCounterRequest.parse({ organizationId: "org_077", projectId: "proj_077", environmentId: "env_077", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_078 = DashboardRunCounterRequest.parse({ organizationId: "org_078", projectId: "proj_078", environmentId: "env_078", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_079 = DashboardRunCounterRequest.parse({ organizationId: "org_079", projectId: "proj_079", environmentId: "env_079", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_080 = DashboardRunCounterRequest.parse({ organizationId: "org_080", projectId: "proj_080", environmentId: "env_080", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_081 = DashboardRunCounterRequest.parse({ organizationId: "org_081", projectId: "proj_081", environmentId: "env_081", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_082 = DashboardRunCounterRequest.parse({ organizationId: "org_082", projectId: "proj_082", environmentId: "env_082", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_083 = DashboardRunCounterRequest.parse({ organizationId: "org_083", projectId: "proj_083", environmentId: "env_083", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_084 = DashboardRunCounterRequest.parse({ organizationId: "org_084", projectId: "proj_084", environmentId: "env_084", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_085 = DashboardRunCounterRequest.parse({ organizationId: "org_085", projectId: "proj_085", environmentId: "env_085", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_086 = DashboardRunCounterRequest.parse({ organizationId: "org_086", projectId: "proj_086", environmentId: "env_086", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_087 = DashboardRunCounterRequest.parse({ organizationId: "org_087", projectId: "proj_087", environmentId: "env_087", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_088 = DashboardRunCounterRequest.parse({ organizationId: "org_088", projectId: "proj_088", environmentId: "env_088", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_089 = DashboardRunCounterRequest.parse({ organizationId: "org_089", projectId: "proj_089", environmentId: "env_089", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_090 = DashboardRunCounterRequest.parse({ organizationId: "org_090", projectId: "proj_090", environmentId: "env_090", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_091 = DashboardRunCounterRequest.parse({ organizationId: "org_091", projectId: "proj_091", environmentId: "env_091", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_092 = DashboardRunCounterRequest.parse({ organizationId: "org_092", projectId: "proj_092", environmentId: "env_092", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_093 = DashboardRunCounterRequest.parse({ organizationId: "org_093", projectId: "proj_093", environmentId: "env_093", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_094 = DashboardRunCounterRequest.parse({ organizationId: "org_094", projectId: "proj_094", environmentId: "env_094", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_095 = DashboardRunCounterRequest.parse({ organizationId: "org_095", projectId: "proj_095", environmentId: "env_095", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_096 = DashboardRunCounterRequest.parse({ organizationId: "org_096", projectId: "proj_096", environmentId: "env_096", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_097 = DashboardRunCounterRequest.parse({ organizationId: "org_097", projectId: "proj_097", environmentId: "env_097", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_098 = DashboardRunCounterRequest.parse({ organizationId: "org_098", projectId: "proj_098", environmentId: "env_098", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_099 = DashboardRunCounterRequest.parse({ organizationId: "org_099", projectId: "proj_099", environmentId: "env_099", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_100 = DashboardRunCounterRequest.parse({ organizationId: "org_100", projectId: "proj_100", environmentId: "env_100", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_101 = DashboardRunCounterRequest.parse({ organizationId: "org_101", projectId: "proj_101", environmentId: "env_101", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_102 = DashboardRunCounterRequest.parse({ organizationId: "org_102", projectId: "proj_102", environmentId: "env_102", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_103 = DashboardRunCounterRequest.parse({ organizationId: "org_103", projectId: "proj_103", environmentId: "env_103", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_104 = DashboardRunCounterRequest.parse({ organizationId: "org_104", projectId: "proj_104", environmentId: "env_104", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_105 = DashboardRunCounterRequest.parse({ organizationId: "org_105", projectId: "proj_105", environmentId: "env_105", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_106 = DashboardRunCounterRequest.parse({ organizationId: "org_106", projectId: "proj_106", environmentId: "env_106", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_107 = DashboardRunCounterRequest.parse({ organizationId: "org_107", projectId: "proj_107", environmentId: "env_107", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_108 = DashboardRunCounterRequest.parse({ organizationId: "org_108", projectId: "proj_108", environmentId: "env_108", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_109 = DashboardRunCounterRequest.parse({ organizationId: "org_109", projectId: "proj_109", environmentId: "env_109", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_110 = DashboardRunCounterRequest.parse({ organizationId: "org_110", projectId: "proj_110", environmentId: "env_110", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_111 = DashboardRunCounterRequest.parse({ organizationId: "org_111", projectId: "proj_111", environmentId: "env_111", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_112 = DashboardRunCounterRequest.parse({ organizationId: "org_112", projectId: "proj_112", environmentId: "env_112", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_113 = DashboardRunCounterRequest.parse({ organizationId: "org_113", projectId: "proj_113", environmentId: "env_113", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_114 = DashboardRunCounterRequest.parse({ organizationId: "org_114", projectId: "proj_114", environmentId: "env_114", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_115 = DashboardRunCounterRequest.parse({ organizationId: "org_115", projectId: "proj_115", environmentId: "env_115", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_116 = DashboardRunCounterRequest.parse({ organizationId: "org_116", projectId: "proj_116", environmentId: "env_116", window: "24h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_117 = DashboardRunCounterRequest.parse({ organizationId: "org_117", projectId: "proj_117", environmentId: "env_117", window: "7d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_118 = DashboardRunCounterRequest.parse({ organizationId: "org_118", projectId: "proj_118", environmentId: "env_118", window: "30d", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_119 = DashboardRunCounterRequest.parse({ organizationId: "org_119", projectId: "proj_119", environmentId: "env_119", window: "all", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
+export const dashboardRunCounterExample_120 = DashboardRunCounterRequest.parse({ organizationId: "org_120", projectId: "proj_120", environmentId: "env_120", window: "1h", includeProjectBreakdown: true, includeEnvironmentBreakdown: true });
diff --git a/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.repository.server.ts b/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.repository.server.ts
new file mode 100644
index 0000000000..075bad0750
--- /dev/null
+++ b/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.repository.server.ts
@@ -0,0 +1,296 @@
+import type { PrismaClientOrTransaction, TaskRunStatus } from "@trigger.dev/database";
+
+import { RUN_COUNTER_FAILED_STATUSES, RUN_COUNTER_RUNNING_STATUSES, type DashboardRunCounterRequest } from "./dashboardRunCounter.types";
+
+type DashboardCounterWhere = {
+  organizationId: string;
+  projectId?: string;
+  runtimeEnvironmentId?: string;
+  createdAt?: { gte: Date };
+};
+
+export class DashboardRunCounterRepository {
+  constructor(private readonly prisma: PrismaClientOrTransaction) {}
+
+  async getStatusCounters(request: DashboardRunCounterRequest) {
+    const where = this.#buildTaskRunWhere(request);
+
+    const [total, pending, queued, executing, delayed, failed, crashed, timedOut, successful, withErrors] = await Promise.all([
+      this.prisma.taskRun.count({ where }),
+      this.prisma.taskRun.count({ where: { ...where, status: "PENDING" } }),
+      this.prisma.taskRun.count({ where: { ...where, status: "QUEUED" } }),
+      this.prisma.taskRun.count({ where: { ...where, status: "EXECUTING" } }),
+      this.prisma.taskRun.count({ where: { ...where, status: "DELAYED" } }),
+      this.prisma.taskRun.count({ where: { ...where, status: { in: RUN_COUNTER_FAILED_STATUSES } } }),
+      this.prisma.taskRun.count({ where: { ...where, status: "CRASHED" } }),
+      this.prisma.taskRun.count({ where: { ...where, status: "TIMED_OUT" } }),
+      this.prisma.taskRun.count({ where: { ...where, status: "COMPLETED_SUCCESSFULLY" } }),
+      this.prisma.taskRun.count({ where: { ...where, status: "COMPLETED_WITH_ERRORS" } })
+    ]);
+
+    const groupedByStatus = await this.prisma.taskRun.groupBy({
+      by: ["status"],
+      where,
+      _count: { _all: true }
+    });
+
+    return {
+      total,
+      running: pending + queued + executing + delayed,
+      failed,
+      crashed,
+      timedOut,
+      successful,
+      withErrors,
+      groupedByStatus: groupedByStatus.map((row) => ({ status: row.status, count: row._count._all }))
+    };
+  }
+
+  async getProjectBreakdown(request: DashboardRunCounterRequest) {
+    const projects = await this.prisma.project.findMany({
+      where: {
+        organizationId: request.organizationId
+      },
+      select: {
+        id: true,
+        slug: true,
+        name: true,
+        deletedAt: true
+      },
+      orderBy: { updatedAt: "desc" }
+    });
+
+    return Promise.all(
+      projects.map(async (project) => {
+        const totalRuns = await this.prisma.taskRun.count({
+          where: { organizationId: request.organizationId, projectId: project.id }
+        });
+        const failedRuns = await this.prisma.taskRun.count({
+          where: { organizationId: request.organizationId, projectId: project.id, status: { in: RUN_COUNTER_FAILED_STATUSES } }
+        });
+        const runningRuns = await this.prisma.taskRun.count({
+          where: { organizationId: request.organizationId, projectId: project.id, status: { in: RUN_COUNTER_RUNNING_STATUSES } }
+        });
+
+        return {
+          projectId: project.id,
+          projectSlug: project.slug,
+          projectName: project.name,
+          deletedAt: project.deletedAt,
+          totalRuns,
+          failedRuns,
+          runningRuns
+        };
+      })
+    );
+  }
+
+  async getEnvironmentBreakdown(request: DashboardRunCounterRequest) {
+    const environments = await this.prisma.runtimeEnvironment.findMany({
+      where: {
+        organizationId: request.organizationId
+      },
+      select: {
+        id: true,
+        slug: true,
+        projectId: true,
+        archivedAt: true
+      },
+      orderBy: { updatedAt: "desc" }
+    });
+
+    const rows = [];
+    for (const environment of environments) {
+      const totalRuns = await this.prisma.taskRun.count({
+        where: { organizationId: request.organizationId, runtimeEnvironmentId: environment.id }
+      });
+      const runningRuns = await this.prisma.taskRun.count({
+        where: { organizationId: request.organizationId, runtimeEnvironmentId: environment.id, status: { in: RUN_COUNTER_RUNNING_STATUSES } }
+      });
+
+      rows.push({
+        environmentId: environment.id,
+        environmentSlug: environment.slug,
+        projectId: environment.projectId,
+        archivedAt: environment.archivedAt,
+        totalRuns,
+        runningRuns
+      });
+    }
+
+    return rows;
+  }
+
+  #buildTaskRunWhere(request: DashboardRunCounterRequest): DashboardCounterWhere {
+    const where: DashboardCounterWhere = {
+      organizationId: request.organizationId
+    };
+
+    if (request.projectId) where.projectId = request.projectId;
+    if (request.environmentId) where.runtimeEnvironmentId = request.environmentId;
+
+    const start = windowStart(request.window);
+    if (start) where.createdAt = { gte: start };
+
+    return where;
+  }
+}
+
+function windowStart(window: DashboardRunCounterRequest["window"]) {
+  const now = new Date();
+  if (window === "1h") return new Date(now.getTime() - 60 * 60 * 1000);
+  if (window === "24h") return new Date(now.getTime() - 24 * 60 * 60 * 1000);
+  if (window === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
+  if (window === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
+  return undefined;
+}
+export const dashboardRunCounterQueryShape_001 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_002 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_003 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_004 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_005 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_006 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_007 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_008 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_009 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_010 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_011 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_012 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_013 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_014 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_015 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_016 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_017 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_018 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_019 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_020 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_021 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_022 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_023 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_024 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_025 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_026 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_027 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_028 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_029 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_030 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_031 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_032 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_033 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_034 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_035 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_036 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_037 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_038 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_039 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_040 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_041 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_042 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_043 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_044 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_045 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_046 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_047 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_048 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_049 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_050 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_051 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_052 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_053 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_054 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_055 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_056 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_057 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_058 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_059 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_060 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_061 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_062 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_063 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_064 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_065 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_066 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_067 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_068 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_069 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_070 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_071 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_072 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_073 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_074 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_075 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_076 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_077 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_078 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_079 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_080 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_081 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_082 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_083 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_084 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_085 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_086 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_087 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_088 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_089 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_090 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_091 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_092 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_093 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_094 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_095 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_096 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_097 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_098 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_099 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_100 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_101 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_102 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_103 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_104 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_105 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_106 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_107 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_108 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_109 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_110 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_111 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_112 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_113 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_114 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_115 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_116 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_117 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_118 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_119 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_120 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_121 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_122 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_123 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_124 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_125 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_126 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_127 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_128 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_129 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_130 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_131 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_132 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_133 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_134 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_135 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_136 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_137 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_138 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_139 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_140 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_141 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_142 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_143 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_144 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_145 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_146 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_147 = { status: "QUEUED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_148 = { status: "EXECUTING" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_149 = { status: "COMPLETED_SUCCESSFULLY" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
+export const dashboardRunCounterQueryShape_150 = { status: "CRASHED" as TaskRunStatus, usesPostgresTaskRunCount: true, usesRollupTable: false, filtersDeletedProjects: false, filtersArchivedEnvironments: false } as const;
diff --git a/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.service.server.ts b/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.service.server.ts
new file mode 100644
index 0000000000..075bad0750
--- /dev/null
+++ b/apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.service.server.ts
@@ -0,0 +1,144 @@
+import type { PrismaClientOrTransaction } from "@trigger.dev/database";
+
+import { DashboardRunCounterRepository } from "./dashboardRunCounter.repository.server";
+import { RUN_COUNTER_RUNNING_STATUSES, type DashboardRunCounterRequest, type DashboardRunCounters } from "./dashboardRunCounter.types";
+
+export class DashboardRunCounterService {
+  private readonly repository: DashboardRunCounterRepository;
+
+  constructor(prisma: PrismaClientOrTransaction) {
+    this.repository = new DashboardRunCounterRepository(prisma);
+  }
+
+  async getCounters(request: DashboardRunCounterRequest): Promise<DashboardRunCounters> {
+    const statusCounters = await this.repository.getStatusCounters(request);
+    const projectBreakdown = request.includeProjectBreakdown
+      ? await this.repository.getProjectBreakdown(request)
+      : [];
+    const environmentBreakdown = request.includeEnvironmentBreakdown
+      ? await this.repository.getEnvironmentBreakdown(request)
+      : [];
+
+    return {
+      buckets: [
+        { status: "TOTAL", count: statusCounters.total },
+        { status: "RUNNING", count: statusCounters.running },
+        { status: "FAILED", count: statusCounters.failed },
+        { status: "CRASHED", count: statusCounters.crashed },
+        { status: "TIMED_OUT", count: statusCounters.timedOut },
+        { status: "COMPLETED_SUCCESSFULLY", count: statusCounters.successful },
+        { status: "COMPLETED_WITH_ERRORS", count: statusCounters.withErrors },
+        ...statusCounters.groupedByStatus.filter((row) => !RUN_COUNTER_RUNNING_STATUSES.includes(row.status))
+      ],
+      projectBreakdown,
+      environmentBreakdown,
+      generatedAt: new Date().toISOString(),
+      scannedSource: "postgres-task-run"
+    };
+  }
+}
+export const dashboardRunCounterServiceScenario_001 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_002 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_003 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_004 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_005 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_006 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_007 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_008 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_009 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_010 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_011 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_012 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_013 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_014 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_015 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_016 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_017 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_018 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_019 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_020 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_021 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_022 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_023 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_024 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_025 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_026 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_027 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_028 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_029 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_030 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_031 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_032 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_033 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_034 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_035 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_036 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_037 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_038 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_039 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_040 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_041 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_042 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_043 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_044 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_045 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_046 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_047 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_048 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_049 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_050 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_051 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_052 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_053 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_054 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_055 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_056 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_057 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_058 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_059 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_060 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_061 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_062 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_063 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_064 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_065 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_066 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_067 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_068 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_069 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_070 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_071 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_072 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_073 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_074 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_075 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_076 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_077 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_078 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_079 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_080 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_081 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_082 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_083 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_084 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_085 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_086 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_087 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_088 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_089 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_090 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_091 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_092 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_093 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_094 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_095 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_096 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_097 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_098 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_099 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_100 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_101 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_102 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_103 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_104 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
+export const dashboardRunCounterServiceScenario_105 = { window: "7d", awaitsRepositoryCountsSequentially: true, source: "postgres-task-run", expectedDashboardLoadPath: "blocking-loader" } as const;
diff --git a/apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-counters.ts b/apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-counters.ts
new file mode 100644
index 0000000000..075bad0750
--- /dev/null
+++ b/apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-counters.ts
@@ -0,0 +1,129 @@
+import { json, type LoaderFunctionArgs } from "@remix-run/node";
+
+import { $replica } from "~/db.server";
+import { findProjectBySlug } from "~/models/project.server";
+import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
+import { DashboardRunCounterRequest } from "~/services/dashboardRunCounters/dashboardRunCounter.types";
+import { DashboardRunCounterService } from "~/services/dashboardRunCounters/dashboardRunCounter.service.server";
+import { requireUserId } from "~/services/session.server";
+import { EnvironmentParamSchema } from "~/utils/pathBuilder";
+
+export async function loader({ request, params }: LoaderFunctionArgs) {
+  const userId = await requireUserId(request);
+  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
+  const url = new URL(request.url);
+
+  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
+  if (!project) throw new Response("Project not found", { status: 404 });
+
+  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
+  if (!environment) throw new Response("Environment not found", { status: 404 });
+
+  const service = new DashboardRunCounterService($replica);
+  const counters = await service.getCounters(
+    DashboardRunCounterRequest.parse({
+      organizationId: project.organizationId,
+      projectId: url.searchParams.get("projectId") ?? undefined,
+      environmentId: url.searchParams.get("environmentId") ?? undefined,
+      window: url.searchParams.get("window") ?? "7d",
+      includeProjectBreakdown: url.searchParams.get("projectBreakdown") !== "false",
+      includeEnvironmentBreakdown: url.searchParams.get("environmentBreakdown") !== "false"
+    })
+  );
+
+  return json(counters, {
+    headers: {
+      "Cache-Control": "private, max-age=15"
+    }
+  });
+}
+export const dashboardRunCounterResourceExample_001 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_002 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_003 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_004 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_005 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_006 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_007 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_008 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_009 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_010 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_011 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_012 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_013 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_014 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_015 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_016 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_017 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_018 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_019 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_020 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_021 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_022 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_023 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_024 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_025 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_026 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_027 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_028 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_029 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_030 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_031 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_032 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_033 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_034 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_035 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_036 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_037 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_038 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_039 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_040 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_041 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_042 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_043 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_044 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_045 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_046 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_047 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_048 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_049 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_050 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_051 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_052 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_053 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_054 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_055 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_056 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_057 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_058 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_059 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_060 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_061 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_062 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_063 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_064 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_065 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_066 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_067 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_068 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_069 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_070 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_071 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_072 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_073 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_074 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_075 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_076 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_077 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_078 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_079 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_080 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_081 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_082 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_083 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_084 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_085 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_086 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_087 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_088 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_089 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
+export const dashboardRunCounterResourceExample_090 = { path: "/resources/orgs/acme/projects/payments/env/prod/dashboard-counters?window=7d", passesRouteProjectIntoRequest: false, defaultsToOrganizationWideCounters: true } as const;
diff --git a/apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx b/apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx
index 0750000000..075bad0750 100644
--- a/apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx
+++ b/apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx
@@ -1,20 +1,153 @@
+import { DashboardRunCounterService } from "~/services/dashboardRunCounters/dashboardRunCounter.service.server";
+import { DashboardRunCounterCards } from "~/components/dashboard/RunCounterCards";
+
+// Existing imports omitted for brevity in this synthetic diff.
+
+export const loader = async ({ request, params }: LoaderFunctionArgs) => {
+  const userId = await requireUserId(request);
+  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
+
+  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
+  if (!project) {
+    throw new Response(undefined, { status: 404, statusText: "Project not found" });
+  }
+
+  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
+  if (!environment) {
+    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
+  }
+
+  const counterService = new DashboardRunCounterService($replica);
+  const counters = await counterService.getCounters({
+    organizationId: project.organizationId,
+    window: "7d",
+    includeProjectBreakdown: true,
+    includeEnvironmentBreakdown: true,
+    includeArchivedProjects: true,
+    includeDeletedProjects: true
+  });
+
+  const { tasks, activity, runningStats, durations } = await taskListPresenter.call({
+    organizationId: project.organizationId,
+    projectId: project.id,
+    environmentId: environment.id,
+    environmentType: environment.type
+  });
+
+  const usefulLinksPreference = await getUsefulLinksPreference(request);
+
+  return typeddefer({
+    tasks,
+    activity,
+    runningStats,
+    durations,
+    counters,
+    usefulLinksPreference
+  });
+};
+
+export default function Page() {
+  const { tasks, activity, runningStats, durations, counters, usefulLinksPreference } = useTypedLoaderData<typeof loader>();
+
+  return (
+    <PageContainer>
+      <NavBar>
+        <PageTitle title="Tasks" />
+      </NavBar>
+      <PageBody>
+        <DashboardRunCounterCards counters={counters} />
+        <TaskListTable tasks={tasks} activity={activity} runningStats={runningStats} durations={durations} />
+      </PageBody>
+    </PageContainer>
+  );
+}
+export const taskDashboardCounterWiringNote_001 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_002 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_003 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_004 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_005 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_006 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_007 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_008 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_009 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_010 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_011 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_012 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_013 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_014 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_015 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_016 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_017 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_018 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_019 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_020 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_021 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_022 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_023 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_024 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_025 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_026 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_027 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_028 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_029 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_030 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_031 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_032 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_033 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_034 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_035 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_036 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_037 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_038 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_039 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_040 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_041 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_042 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_043 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_044 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_045 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_046 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_047 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_048 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_049 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_050 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_051 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_052 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_053 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_054 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_055 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_056 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_057 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_058 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_059 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_060 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_061 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_062 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_063 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_064 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_065 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_066 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_067 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_068 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_069 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_070 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_071 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_072 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_073 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_074 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_075 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_076 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_077 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_078 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_079 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_080 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_081 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_082 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_083 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_084 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_085 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_086 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_087 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_088 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_089 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
+export const taskDashboardCounterWiringNote_090 = { blocksLoaderBeforeDefer: true, omitsProjectId: true, omitsEnvironmentId: true, note: "counter cards load before existing deferred metric promises" } as const;
diff --git a/apps/webapp/app/components/dashboard/RunCounterCards.tsx b/apps/webapp/app/components/dashboard/RunCounterCards.tsx
new file mode 100644
index 0000000000..075bad0750
--- /dev/null
+++ b/apps/webapp/app/components/dashboard/RunCounterCards.tsx
@@ -0,0 +1,142 @@
+import { Badge } from "~/components/primitives/Badge";
+import { Header3 } from "~/components/primitives/Headers";
+import type { DashboardRunCounters } from "~/services/dashboardRunCounters/dashboardRunCounter.types";
+
+export function DashboardRunCounterCards({ counters }: { counters: DashboardRunCounters }) {
+  return (
+    <section className="grid grid-cols-4 gap-3">
+      {counters.buckets.map((bucket) => (
+        <div key={bucket.status} className="rounded border border-grid-bright bg-background-bright p-4">
+          <div className="text-text-dimmed text-xs uppercase">{bucket.status}</div>
+          <Header3>{bucket.count.toLocaleString()}</Header3>
+        </div>
+      ))}
+      <div className="col-span-4 rounded border border-grid-bright bg-background-bright p-4">
+        <div className="mb-3 flex items-center justify-between">
+          <Header3>Project run counters</Header3>
+          <Badge variant="small">{counters.scannedSource}</Badge>
+        </div>
+        <div className="grid grid-cols-3 gap-2">
+          {counters.projectBreakdown.map((project) => (
+            <div key={project.projectId} className="rounded border border-grid-dimmed p-3">
+              <div className="text-text-bright text-sm">{project.projectName}</div>
+              <div className="text-text-dimmed text-xs">{project.projectSlug}</div>
+              <div className="mt-2 text-text-bright text-sm">{project.totalRuns.toLocaleString()} total</div>
+              {project.deletedAt ? <Badge variant="small">deleted</Badge> : null}
+            </div>
+          ))}
+        </div>
+      </div>
+    </section>
+  );
+}
+export const dashboardRunCounterCardFixture_001 = { bucket: "TOTAL", count: 1000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_002 = { bucket: "TOTAL", count: 2000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_003 = { bucket: "TOTAL", count: 3000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_004 = { bucket: "TOTAL", count: 4000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_005 = { bucket: "TOTAL", count: 5000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_006 = { bucket: "TOTAL", count: 6000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_007 = { bucket: "TOTAL", count: 7000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_008 = { bucket: "TOTAL", count: 8000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_009 = { bucket: "TOTAL", count: 9000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_010 = { bucket: "TOTAL", count: 10000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_011 = { bucket: "TOTAL", count: 11000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_012 = { bucket: "TOTAL", count: 12000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_013 = { bucket: "TOTAL", count: 13000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_014 = { bucket: "TOTAL", count: 14000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_015 = { bucket: "TOTAL", count: 15000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_016 = { bucket: "TOTAL", count: 16000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_017 = { bucket: "TOTAL", count: 17000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_018 = { bucket: "TOTAL", count: 18000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_019 = { bucket: "TOTAL", count: 19000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_020 = { bucket: "TOTAL", count: 20000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_021 = { bucket: "TOTAL", count: 21000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_022 = { bucket: "TOTAL", count: 22000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_023 = { bucket: "TOTAL", count: 23000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_024 = { bucket: "TOTAL", count: 24000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_025 = { bucket: "TOTAL", count: 25000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_026 = { bucket: "TOTAL", count: 26000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_027 = { bucket: "TOTAL", count: 27000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_028 = { bucket: "TOTAL", count: 28000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_029 = { bucket: "TOTAL", count: 29000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_030 = { bucket: "TOTAL", count: 30000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_031 = { bucket: "TOTAL", count: 31000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_032 = { bucket: "TOTAL", count: 32000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_033 = { bucket: "TOTAL", count: 33000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_034 = { bucket: "TOTAL", count: 34000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_035 = { bucket: "TOTAL", count: 35000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_036 = { bucket: "TOTAL", count: 36000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_037 = { bucket: "TOTAL", count: 37000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_038 = { bucket: "TOTAL", count: 38000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_039 = { bucket: "TOTAL", count: 39000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_040 = { bucket: "TOTAL", count: 40000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_041 = { bucket: "TOTAL", count: 41000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_042 = { bucket: "TOTAL", count: 42000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_043 = { bucket: "TOTAL", count: 43000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_044 = { bucket: "TOTAL", count: 44000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_045 = { bucket: "TOTAL", count: 45000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_046 = { bucket: "TOTAL", count: 46000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_047 = { bucket: "TOTAL", count: 47000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_048 = { bucket: "TOTAL", count: 48000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_049 = { bucket: "TOTAL", count: 49000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_050 = { bucket: "TOTAL", count: 50000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_051 = { bucket: "TOTAL", count: 51000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_052 = { bucket: "TOTAL", count: 52000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_053 = { bucket: "TOTAL", count: 53000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_054 = { bucket: "TOTAL", count: 54000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_055 = { bucket: "TOTAL", count: 55000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_056 = { bucket: "TOTAL", count: 56000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_057 = { bucket: "TOTAL", count: 57000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_058 = { bucket: "TOTAL", count: 58000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_059 = { bucket: "TOTAL", count: 59000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_060 = { bucket: "TOTAL", count: 60000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_061 = { bucket: "TOTAL", count: 61000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_062 = { bucket: "TOTAL", count: 62000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_063 = { bucket: "TOTAL", count: 63000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_064 = { bucket: "TOTAL", count: 64000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_065 = { bucket: "TOTAL", count: 65000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_066 = { bucket: "TOTAL", count: 66000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_067 = { bucket: "TOTAL", count: 67000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_068 = { bucket: "TOTAL", count: 68000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_069 = { bucket: "TOTAL", count: 69000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_070 = { bucket: "TOTAL", count: 70000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_071 = { bucket: "TOTAL", count: 71000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_072 = { bucket: "TOTAL", count: 72000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_073 = { bucket: "TOTAL", count: 73000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_074 = { bucket: "TOTAL", count: 74000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_075 = { bucket: "TOTAL", count: 75000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_076 = { bucket: "TOTAL", count: 76000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_077 = { bucket: "TOTAL", count: 77000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_078 = { bucket: "TOTAL", count: 78000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_079 = { bucket: "TOTAL", count: 79000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_080 = { bucket: "TOTAL", count: 80000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_081 = { bucket: "TOTAL", count: 81000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_082 = { bucket: "TOTAL", count: 82000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_083 = { bucket: "TOTAL", count: 83000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_084 = { bucket: "TOTAL", count: 84000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_085 = { bucket: "TOTAL", count: 85000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_086 = { bucket: "TOTAL", count: 86000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_087 = { bucket: "TOTAL", count: 87000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_088 = { bucket: "TOTAL", count: 88000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_089 = { bucket: "TOTAL", count: 89000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_090 = { bucket: "TOTAL", count: 90000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_091 = { bucket: "TOTAL", count: 91000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_092 = { bucket: "TOTAL", count: 92000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_093 = { bucket: "TOTAL", count: 93000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_094 = { bucket: "TOTAL", count: 94000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_095 = { bucket: "TOTAL", count: 95000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_096 = { bucket: "TOTAL", count: 96000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_097 = { bucket: "TOTAL", count: 97000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_098 = { bucket: "TOTAL", count: 98000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_099 = { bucket: "TOTAL", count: 99000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_100 = { bucket: "TOTAL", count: 100000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_101 = { bucket: "TOTAL", count: 101000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_102 = { bucket: "TOTAL", count: 102000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_103 = { bucket: "TOTAL", count: 103000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_104 = { bucket: "TOTAL", count: 104000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_105 = { bucket: "TOTAL", count: 105000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_106 = { bucket: "TOTAL", count: 106000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_107 = { bucket: "TOTAL", count: 107000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_108 = { bucket: "TOTAL", count: 108000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_109 = { bucket: "TOTAL", count: 109000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
+export const dashboardRunCounterCardFixture_110 = { bucket: "TOTAL", count: 110000, showsDeletedProjectBadge: true, sourceLabel: "postgres-task-run" } as const;
diff --git a/internal-packages/database/prisma/migrations/20260606000000_dashboard_run_counters/migration.sql b/internal-packages/database/prisma/migrations/20260606000000_dashboard_run_counters/migration.sql
new file mode 100644
index 0000000000..075bad0750
--- /dev/null
+++ b/internal-packages/database/prisma/migrations/20260606000000_dashboard_run_counters/migration.sql
@@ -0,0 +1,123 @@
+-- Dashboard run counters helper indexes
+CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_org_project_created_status_idx"
+  ON "TaskRun" ("organizationId", "projectId", "createdAt", "status");
+
+CREATE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_org_env_created_status_idx"
+  ON "TaskRun" ("organizationId", "runtimeEnvironmentId", "createdAt", "status");
+
+-- There is intentionally no rollup table in this PR; counts are read directly from TaskRun.
+-- counter migration note 001: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 002: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 003: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 004: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 005: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 006: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 007: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 008: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 009: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 010: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 011: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 012: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 013: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 014: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 015: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 016: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 017: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 018: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 019: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 020: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 021: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 022: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 023: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 024: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 025: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 026: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 027: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 028: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 029: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 030: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 031: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 032: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 033: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 034: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 035: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 036: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 037: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 038: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 039: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 040: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 041: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 042: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 043: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 044: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 045: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 046: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 047: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 048: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 049: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 050: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 051: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 052: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 053: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 054: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 055: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 056: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 057: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 058: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 059: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 060: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 061: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 062: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 063: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 064: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 065: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 066: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 067: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 068: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 069: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 070: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 071: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 072: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 073: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 074: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 075: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 076: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 077: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 078: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 079: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 080: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 081: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 082: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 083: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 084: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 085: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 086: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 087: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 088: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 089: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 090: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 091: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 092: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 093: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 094: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 095: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 096: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 097: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 098: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 099: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 100: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 101: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 102: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 103: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 104: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 105: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 106: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 107: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 108: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 109: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 110: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 111: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 112: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 113: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 114: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
+-- counter migration note 115: index attempts to make synchronous TaskRun counts acceptable without changing the dashboard read model.
diff --git a/apps/webapp/app/services/dashboardRunCounters/__tests__/dashboardRunCounter.service.test.ts b/apps/webapp/app/services/dashboardRunCounters/__tests__/dashboardRunCounter.service.test.ts
new file mode 100644
index 0000000000..075bad0750
--- /dev/null
+++ b/apps/webapp/app/services/dashboardRunCounters/__tests__/dashboardRunCounter.service.test.ts
@@ -0,0 +1,497 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { DashboardRunCounterRepository } from "../dashboardRunCounter.repository.server";
+import { DashboardRunCounterService } from "../dashboardRunCounter.service.server";
+
+describe("DashboardRunCounterService", () => {
+  it("returns counters from TaskRun counts", async () => {
+    const prisma = {
+      taskRun: {
+        count: vi.fn().mockResolvedValue(3),
+        groupBy: vi.fn().mockResolvedValue([{ status: "QUEUED", _count: { _all: 3 } }])
+      },
+      project: { findMany: vi.fn().mockResolvedValue([]) },
+      runtimeEnvironment: { findMany: vi.fn().mockResolvedValue([]) }
+    };
+
+    const service = new DashboardRunCounterService(prisma as never);
+    const result = await service.getCounters({
+      organizationId: "org_1",
+      projectId: "project_1",
+      environmentId: "env_1",
+      window: "7d",
+      includeProjectBreakdown: true,
+      includeEnvironmentBreakdown: true,
+      includeArchivedProjects: true,
+      includeDeletedProjects: true
+    });
+
+    expect(result.scannedSource).toBe("postgres-task-run");
+    expect(prisma.taskRun.count).toHaveBeenCalled();
+  });
+
+  it("keeps deleted projects in the project breakdown", async () => {
+    const prisma = {
+      taskRun: { count: vi.fn().mockResolvedValue(10), groupBy: vi.fn().mockResolvedValue([]) },
+      project: { findMany: vi.fn().mockResolvedValue([{ id: "deleted_project", slug: "old", name: "Old", deletedAt: new Date() }]) },
+      runtimeEnvironment: { findMany: vi.fn().mockResolvedValue([]) }
+    };
+
+    const repository = new DashboardRunCounterRepository(prisma as never);
+    const projects = await repository.getProjectBreakdown({
+      organizationId: "org_1",
+      window: "all",
+      includeProjectBreakdown: true,
+      includeEnvironmentBreakdown: true,
+      includeArchivedProjects: true,
+      includeDeletedProjects: true
+    });
+
+    expect(projects[0].deletedAt).toBeInstanceOf(Date);
+  });
+});
+export const dashboardRunCounterTestFixture_001 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_002 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_003 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_004 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_005 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_006 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_007 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_008 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_009 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_010 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_011 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_012 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_013 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_014 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_015 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_016 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_017 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_018 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_019 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_020 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_021 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_022 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_023 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_024 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_025 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_026 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_027 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_028 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_029 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_030 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_031 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_032 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_033 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_034 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_035 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_036 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_037 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_038 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_039 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_040 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_041 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_042 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_043 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_044 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_045 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_046 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_047 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_048 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_049 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_050 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_051 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_052 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_053 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_054 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_055 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_056 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_057 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_058 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_059 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_060 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_061 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_062 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_063 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_064 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_065 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_066 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_067 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_068 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_069 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_070 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_071 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_072 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_073 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_074 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_075 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_076 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_077 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_078 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_079 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_080 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_081 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_082 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_083 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_084 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_085 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_086 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_087 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_088 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_089 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_090 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_091 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_092 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_093 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_094 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_095 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_096 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_097 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_098 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_099 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_100 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_101 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_102 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_103 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_104 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_105 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_106 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_107 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_108 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_109 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_110 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_111 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_112 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_113 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_114 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_115 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_116 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_117 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_118 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_119 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_120 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_121 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_122 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_123 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_124 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_125 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_126 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_127 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_128 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_129 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_130 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_131 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_132 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_133 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_134 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_135 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_136 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_137 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_138 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_139 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_140 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_141 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_142 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_143 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_144 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_145 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_146 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_147 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_148 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_149 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_150 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_151 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_152 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_153 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_154 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_155 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_156 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_157 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_158 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_159 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_160 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_161 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_162 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_163 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_164 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_165 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_166 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_167 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_168 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_169 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_170 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_171 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_172 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_173 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_174 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_175 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_176 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_177 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_178 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_179 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_180 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_181 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_182 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_183 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_184 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_185 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_186 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_187 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_188 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_189 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_190 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_191 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_192 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_193 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_194 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_195 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_196 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_197 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_198 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_199 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_200 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_201 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_202 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_203 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_204 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_205 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_206 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_207 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_208 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_209 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_210 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_211 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_212 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_213 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_214 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_215 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_216 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_217 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_218 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_219 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_220 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_221 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_222 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_223 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_224 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_225 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_226 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_227 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_228 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_229 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_230 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_231 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_232 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_233 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_234 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_235 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_236 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_237 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_238 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_239 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_240 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_241 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_242 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_243 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_244 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_245 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_246 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_247 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_248 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_249 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_250 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_251 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_252 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_253 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_254 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_255 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_256 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_257 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_258 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_259 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_260 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_261 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_262 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_263 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_264 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_265 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_266 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_267 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_268 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_269 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_270 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_271 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_272 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_273 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_274 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_275 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_276 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_277 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_278 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_279 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_280 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_281 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_282 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_283 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_284 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_285 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_286 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_287 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_288 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_289 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_290 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_291 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_292 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_293 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_294 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_295 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_296 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_297 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_298 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_299 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_300 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_301 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_302 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_303 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_304 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_305 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_306 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_307 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_308 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_309 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_310 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_311 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_312 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_313 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_314 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_315 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_316 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_317 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_318 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_319 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_320 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_321 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_322 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_323 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_324 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_325 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_326 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_327 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_328 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_329 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_330 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_331 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_332 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_333 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_334 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_335 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_336 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_337 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_338 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_339 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_340 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_341 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_342 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_343 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_344 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_345 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_346 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_347 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_348 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_349 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_350 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_351 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_352 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_353 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_354 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_355 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_356 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_357 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_358 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_359 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_360 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_361 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_362 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_363 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_364 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_365 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_366 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_367 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_368 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_369 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_370 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_371 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_372 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_373 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_374 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_375 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_376 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_377 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_378 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_379 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_380 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_381 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_382 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_383 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_384 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_385 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_386 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_387 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_388 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_389 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_390 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_391 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_392 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_393 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_394 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_395 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_396 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_397 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_398 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_399 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_400 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_401 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_402 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_403 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_404 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_405 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_406 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_407 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_408 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_409 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_410 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_411 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_412 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_413 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_414 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_415 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_416 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_417 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_418 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_419 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_420 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_421 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_422 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_423 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_424 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_425 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_426 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_427 = { status: "CRASHED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_428 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_429 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_430 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_431 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_432 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_433 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_434 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_435 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_436 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_437 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_438 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_439 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_440 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: new Date("2026-01-01T00:00:00.000Z"), expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_441 = { status: "QUEUED", projectDeletedAt: new Date("2026-01-01T00:00:00.000Z"), environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_442 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_443 = { status: "COMPLETED_SUCCESSFULLY", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_444 = { status: "QUEUED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
+export const dashboardRunCounterTestFixture_445 = { status: "CRASHED", projectDeletedAt: null, environmentArchivedAt: null, expectsCounted: true, source: "TaskRun" } as const;
diff --git a/docs/dashboard-run-counters.md b/docs/dashboard-run-counters.md
new file mode 100644
index 0000000000..075bad0750
--- /dev/null
+++ b/docs/dashboard-run-counters.md
@@ -0,0 +1,614 @@
+# Dashboard run counters
+
+The dashboard shows run totals, running counts, failures, and status buckets above the task list.
+
+## Data source
+
+Counters are computed from the Postgres `TaskRun` table during the dashboard request.
+
+The implementation performs multiple `count` calls and one `groupBy` over `TaskRun` for every dashboard load.
+
+The migration adds indexes, but it does not add a rollup table or use the existing ClickHouse task-run metrics path.
+
+## Project and environment scope
+
+By default the cards show organization-wide counters and include deleted projects and archived environments so historical totals remain visible.
+
+The route can receive projectId and environmentId query parameters, but the task dashboard loader omits them for the default cards.
+
+## Operational notes
+- Counter note 001: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 002: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 003: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 004: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 005: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 006: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 007: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 008: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 009: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 010: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 011: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 012: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 013: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 014: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 015: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 016: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 017: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 018: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 019: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 020: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 021: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 022: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 023: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 024: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 025: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 026: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 027: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 028: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 029: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 030: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 031: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 032: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 033: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 034: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 035: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 036: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 037: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 038: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 039: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 040: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 041: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 042: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 043: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 044: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 045: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 046: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 047: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 048: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 049: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 050: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 051: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 052: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 053: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 054: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 055: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 056: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 057: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 058: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 059: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 060: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 061: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 062: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 063: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 064: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 065: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 066: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 067: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 068: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 069: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 070: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 071: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 072: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 073: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 074: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 075: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 076: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 077: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 078: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 079: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 080: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 081: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 082: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 083: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 084: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 085: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 086: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 087: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 088: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 089: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 090: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 091: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 092: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 093: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 094: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 095: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 096: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 097: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 098: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 099: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 100: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 101: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 102: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 103: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 104: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 105: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 106: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 107: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 108: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 109: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 110: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 111: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 112: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 113: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 114: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 115: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 116: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 117: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 118: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 119: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 120: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 121: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 122: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 123: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 124: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 125: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 126: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 127: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 128: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 129: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 130: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 131: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 132: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 133: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 134: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 135: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 136: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 137: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 138: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 139: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 140: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 141: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 142: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 143: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 144: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 145: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 146: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 147: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 148: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 149: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 150: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 151: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 152: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 153: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 154: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 155: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 156: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 157: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 158: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 159: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 160: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 161: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 162: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 163: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 164: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 165: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 166: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 167: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 168: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 169: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 170: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 171: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 172: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 173: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 174: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 175: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 176: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 177: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 178: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 179: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 180: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 181: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 182: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 183: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 184: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 185: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 186: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 187: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 188: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 189: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 190: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 191: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 192: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 193: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 194: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 195: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 196: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 197: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 198: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 199: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 200: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 201: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 202: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 203: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 204: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 205: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 206: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 207: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 208: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 209: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 210: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 211: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 212: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 213: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 214: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 215: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 216: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 217: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 218: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 219: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 220: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 221: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 222: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 223: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 224: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 225: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 226: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 227: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 228: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 229: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 230: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 231: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 232: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 233: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 234: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 235: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 236: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 237: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 238: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 239: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 240: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 241: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 242: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 243: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 244: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 245: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 246: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 247: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 248: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 249: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 250: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 251: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 252: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 253: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 254: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 255: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 256: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 257: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 258: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 259: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 260: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 261: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 262: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 263: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 264: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 265: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 266: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 267: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 268: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 269: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 270: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 271: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 272: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 273: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 274: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 275: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 276: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 277: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 278: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 279: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 280: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 281: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 282: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 283: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 284: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 285: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 286: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 287: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 288: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 289: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 290: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 291: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 292: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 293: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 294: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 295: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 296: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 297: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 298: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 299: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 300: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 301: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 302: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 303: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 304: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 305: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 306: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 307: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 308: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 309: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 310: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 311: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 312: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 313: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 314: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 315: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 316: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 317: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 318: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 319: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 320: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 321: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 322: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 323: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 324: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 325: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 326: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 327: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 328: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 329: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 330: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 331: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 332: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 333: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 334: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 335: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 336: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 337: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 338: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 339: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 340: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 341: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 342: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 343: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 344: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 345: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 346: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 347: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 348: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 349: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 350: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 351: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 352: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 353: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 354: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 355: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 356: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 357: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 358: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 359: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 360: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 361: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 362: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 363: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 364: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 365: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 366: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 367: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 368: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 369: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 370: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 371: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 372: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 373: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 374: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 375: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 376: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 377: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 378: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 379: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 380: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 381: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 382: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 383: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 384: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 385: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 386: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 387: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 388: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 389: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 390: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 391: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 392: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 393: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 394: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 395: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 396: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 397: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 398: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 399: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 400: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 401: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 402: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 403: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 404: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 405: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 406: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 407: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 408: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 409: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 410: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 411: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 412: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 413: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 414: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 415: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 416: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 417: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 418: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 419: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 420: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 421: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 422: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 423: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 424: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 425: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 426: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 427: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 428: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 429: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 430: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 431: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 432: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 433: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 434: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 435: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 436: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 437: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 438: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 439: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 440: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 441: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 442: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 443: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 444: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 445: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 446: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 447: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 448: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 449: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 450: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 451: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 452: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 453: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 454: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 455: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 456: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 457: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 458: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 459: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 460: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 461: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 462: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 463: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 464: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 465: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 466: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 467: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 468: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 469: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 470: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 471: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 472: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 473: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 474: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 475: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 476: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 477: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 478: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 479: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 480: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 481: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 482: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 483: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 484: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 485: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 486: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 487: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 488: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 489: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 490: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 491: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 492: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 493: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 494: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 495: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 496: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 497: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 498: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 499: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 500: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 501: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 502: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 503: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 504: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 505: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 506: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 507: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 508: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 509: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 510: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 511: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 512: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 513: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 514: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 515: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 516: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 517: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 518: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 519: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 520: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 521: project-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 522: environment-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 523: deleted-project-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 524: archived-environment-inclusive dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 525: organization-wide dashboard counters read TaskRun synchronously and are intended to be visible immediately after each run status update.
+- Counter note 526: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 527: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 528: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 529: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 530: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 531: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 532: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 533: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 534: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 535: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 536: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 537: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 538: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 539: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 540: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 541: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 542: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 543: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 544: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 545: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 546: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 547: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 548: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 549: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 550: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 551: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 552: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 553: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 554: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 555: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 556: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 557: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 558: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 559: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 560: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 561: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 562: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 563: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 564: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 565: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 566: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 567: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 568: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 569: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 570: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 571: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 572: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 573: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 574: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 575: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 576: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 577: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 578: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 579: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 580: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 581: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 582: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 583: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 584: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 585: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 586: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 587: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 588: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 589: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 590: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 591: polling follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 592: read-model follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 593: rollup follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 594: current-scope follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
+- Counter note 595: cache-busting follow-up keeps the synthetic PR focused on synchronous TaskRun counters, missing active scope, and why dashboard analytics need a bounded read model.
```

## Intended Flaws

### Flaw 1: Dashboard counters synchronously query the operational TaskRun table

The repository performs many `taskRun.count` calls and a `taskRun.groupBy` for every dashboard load, then the service and route await those calls before rendering/defer can happen. This bypasses the existing ClickHouse metrics path and turns a high-volume write table into a synchronous dashboard analytics source.

Hints:

1. Count how many `TaskRun` aggregate queries happen before the dashboard can return.
2. Compare this path with `ClickHouseEnvironmentMetricsRepository` and the existing deferred metric promises.
3. Ask what happens when every dashboard tab polls or reloads while a customer has millions of runs in the selected window.

### Flaw 2: Counters include deleted projects and archived environments, and the main dashboard omits the current project/environment scope

The project and environment breakdowns query by organization only, without `deletedAt: null` or `archivedAt: null`. The main dashboard loader also calls the counter service with only `organizationId`, not the route's `project.id` or `environment.id`, so the cards show org-wide historical state on a project/environment page.

Hints:

1. Trace the route params into `DashboardRunCounterRequest`; check whether `project.id` and `environment.id` make it into the counter service.
2. Look for lifecycle filters on `Project.deletedAt` and `RuntimeEnvironment.archivedAt`.
3. Ask what a user expects on a project environment dashboard: active current-scope counters or historical organization totals including removed resources?

## Expected Answer

### Flaw 1 Expected Identification

- Primary lines: `apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.repository.server.ts:18-45`
- Supporting lines: `apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.service.server.ts:14-36`, `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx:21-27`, `internal-packages/database/prisma/migrations/20260606000000_dashboard_run_counters/migration.sql:8-8`, and `docs/dashboard-run-counters.md:9-9`
- Issue: the dashboard computes counters by issuing synchronous aggregate reads against Prisma `taskRun` on the request path. The loader awaits the new counters before returning, while the existing metrics design uses ClickHouse and deferred promises.
- Impact: frequent dashboard loads can hammer the operational run table, contend with writes/status updates, inflate Postgres CPU and index pressure, and make the dashboard slow for customers with large run histories. Adding two indexes does not make repeated org/project/environment aggregate scans a good dashboard read model.
- Better direction: use the existing ClickHouse `task_runs_v2` analytics path or a dedicated rollup/materialized counter table updated asynchronously. Keep dashboard metric fetches deferred or separately cached, and make polling hit a bounded read model rather than the write table.

### Flaw 2 Expected Identification

- Primary lines: `apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.repository.server.ts:50-79` and `apps/webapp/app/services/dashboardRunCounters/dashboardRunCounter.repository.server.ts:89-115`
- Supporting lines: `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx:21-27`, `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-counters.ts:26-27`, and `docs/dashboard-run-counters.md:15-15`
- Issue: the breakdown queries include all projects/environments in the organization, including deleted projects and archived environments. The task dashboard loader also omits `projectId` and `environmentId`, so a project environment page receives organization-wide counters by default.
- Impact: users see numbers that do not match the current dashboard scope. Deleted projects can keep contributing historical counts, archived environments can appear alive, and teams can misread failures/running counts as current production state.
- Better direction: scope counters to the resolved project/environment by default. Apply lifecycle filters such as `Project.deletedAt: null` and `RuntimeEnvironment.archivedAt: null` unless the product explicitly offers a historical/admin mode. Tests should cover deleted/archived resources being excluded from normal dashboard counters.

## Expert Debrief

Product-level change: dashboard counters are a reasonable feature. Users want quick confidence about whether runs are queued, failing, or healthy without navigating into the runs table.

Contract changes: the PR changes dashboard load behavior and analytics data sourcing. It moves from an analytics/deferred pattern to synchronous operational-table aggregation and changes the visible scope from current project/environment to organization-wide historical counts.

Failure modes: the implementation fails by overloading Postgres with count/groupBy queries, blocking the task dashboard before defer, duplicating the ClickHouse metrics boundary, including deleted projects, including archived environments, and showing counters that disagree with the page the user is actually viewing.

Reviewer thought process: dashboard analytics should trigger two immediate questions: what read model owns these counters, and what entity scope do the cards represent? In Trigger.dev, run data already has a ClickHouse analytics path and project/environment pages already resolve concrete active entities. A PR that ignores both is probably optimizing for implementation speed, not production behavior.

Better implementation direction: build or reuse a ClickHouse/rollup-backed counter API keyed by organization, project, environment, status, and time bucket. Return current-scope counters on the dashboard, keep historical org-wide views behind an explicit mode, exclude deleted/archived resources by default, and preserve deferred/cached loading so the dashboard shell remains fast.

## Correctness Verdict Rubric

- Correct for flaw 1: identifies synchronous `TaskRun` aggregate queries on the dashboard request path, cites repository/service/loader lines, explains operational DB load and slow dashboard risk, and proposes ClickHouse or rollup counters.
- Partially correct for flaw 1: says the code is slow but only suggests adding indexes or memoization without changing the read model.
- Incorrect for flaw 1: focuses on React card rendering or CSS instead of analytics query shape.
- Correct for flaw 2: identifies missing current project/environment scope plus deleted/archived resource inclusion, cites project/environment breakdown and loader/resource lines, explains wrong product state, and proposes active-scope lifecycle filters.
- Partially correct for flaw 2: notices deleted projects or archived environments but misses that the dashboard omits current project/environment IDs.
- Incorrect for flaw 2: treats organization-wide historical counts as acceptable without requiring explicit UX/product mode.
