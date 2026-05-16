# TS-026: Trigger.dev Organization Run Logs

## Metadata

- `id`: TS-026
- `source_repo`: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- `repo_area`: run log routes, ClickHouse task event queries, run ownership checks, runtime environment scoping, task logger attributes, environment variable redaction
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 1,050-1,350
- `represented_diff_lines`: 1,091
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about run ownership, organization/project/environment boundaries, dev environment visibility, ClickHouse log filtering, task logger attributes, secret redaction, and safe log export without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR lets organization members view task run logs from any run link.

Today the full run page is scoped through `/orgs/:org/projects/:project/env/:env/runs/:run`, but support workflows often share only a run ID. This change adds a run-log API that accepts a run ID, verifies the current user is a member of the run's organization, and returns a compact log list/detail payload. The dashboard uses it to power a lightweight "open logs" drawer from alerts, Slack links, and run search.

The PR adds:

- an API route for `GET /api/v1/runs/:runParam/logs`,
- a log presenter that resolves the run then reads ClickHouse task events,
- a detail route for individual log records,
- optional environment-context enrichment for support debugging,
- a task logger change that attaches environment context to emitted logs,
- tests for org members reading logs, missing runs, pagination, and secret context.

## Existing Code Context

The real Trigger.dev codebase already has these relevant contracts:

- `internal-packages/database/prisma/schema.prisma` models `TaskRun` with globally unique `friendlyId`, `projectId`, `runtimeEnvironmentId`, `organizationId`, `taskEventStore`, and `logsDeletedAt`.
- `apps/webapp/app/presenters/v3/RunPresenter.server.ts` loads a run by `runFriendlyId`, but also scopes through `project.slug` and organization membership, then checks the route `environmentSlug` against `run.runtimeEnvironment.slug`.
- `apps/webapp/app/models/runtimeEnvironment.server.ts` has `findEnvironmentBySlug(projectId, envSlug, userId)`, and development environments are only visible to their owning org member.
- `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs/route.tsx` resolves project and environment from route params before calling the log list presenter.
- `apps/webapp/app/presenters/v3/LogsListPresenter.server.ts` queries `task_events_search_v1` with `environment_id`, `organization_id`, and `project_id` filters.
- `apps/webapp/app/presenters/v3/LogDetailPresenter.server.ts` filters detail reads by environment, organization, project, span, trace, and start time.
- `apps/webapp/app/v3/environmentVariables/environmentVariablesRepository.server.ts` exposes `getEnvironmentWithRedactedSecrets()` for display surfaces and `getEnvironmentVariables()` for execution.
- `apps/webapp/app/v3/environmentVariables/environmentVariablesRepository.server.ts` uses a secret store and `isSecret` metadata; `resolveVariablesForEnvironment()` returns full secret values because workers need them at execution time.
- `apps/webapp/app/v3/marqs/sharedQueueConsumer.server.ts` builds task execution payloads with full environment variables plus `TRIGGER_JWT`. That data is execution-only and must not be copied into log records or dashboard responses.
- `packages/core/src/v3/logger/taskLogger.ts` emits user log messages and flattened attributes into OpenTelemetry logs. Anything added there can be persisted to ClickHouse and shown in the dashboard.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `apps/webapp/app/routes/api.v1.runs.$runParam.logs.ts`
- `apps/webapp/app/routes/api.v1.runs.$runParam.logs.$logId.ts`
- `apps/webapp/app/presenters/v3/OrgRunLogsPresenter.server.ts`
- `apps/webapp/app/services/runLogs/runLogAccess.server.ts`
- `apps/webapp/app/services/runLogs/environmentLogContext.server.ts`
- `packages/core/src/v3/logger/taskLogger.ts`
- `apps/webapp/app/components/runs/v3/OrgRunLogsDrawer.tsx`
- `apps/webapp/test/orgRunLogs.test.ts`
- `packages/core/test/taskLogger.env-context.test.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on backend/API behavior, access control, log data contracts, and tests.

## Diff

```diff
diff --git a/apps/webapp/app/routes/api.v1.runs.$runParam.logs.ts b/apps/webapp/app/routes/api.v1.runs.$runParam.logs.ts
new file mode 100644
index 0000000000..74f784bc9d
--- /dev/null
+++ b/apps/webapp/app/routes/api.v1.runs.$runParam.logs.ts
@@ -0,0 +1,142 @@
+import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
+import { z } from "zod";
+import { $replica } from "~/db.server";
+import { requireUser } from "~/services/session.server";
+import { logsClickhouseClient } from "~/services/clickhouseInstance.server";
+import { OrgRunLogsPresenter, OrgRunLogsOptionsSchema } from "~/presenters/v3/OrgRunLogsPresenter.server";
+import { getRunLogAccessContext } from "~/services/runLogs/runLogAccess.server";
+
+const ParamsSchema = z.object({
+  runParam: z.string().min(1),
+});
+
+function parseLevels(url: URL) {
+  return url.searchParams
+    .getAll("levels")
+    .flatMap((level) => level.split(","))
+    .map((level) => level.trim().toUpperCase())
+    .filter((level) => level.length > 0);
+}
+
+function parseOptionalNumber(value: string | null) {
+  if (!value) {
+    return undefined;
+  }
+  const parsed = Number(value);
+  return Number.isFinite(parsed) ? parsed : undefined;
+}
+
+export async function loader({ request, params }: LoaderFunctionArgs) {
+  const user = await requireUser(request);
+  const { runParam } = ParamsSchema.parse(params);
+  const url = new URL(request.url);
+
+  const access = await getRunLogAccessContext({
+    userId: user.id,
+    runParam,
+  });
+
+  if (!access) {
+    throw new Response("Run not found", { status: 404 });
+  }
+
+  const options = OrgRunLogsOptionsSchema.parse({
+    projectId: access.projectId,
+    organizationId: access.organizationId,
+    environmentId: access.runtimeEnvironmentId,
+    runId: runParam,
+    cursor: url.searchParams.get("cursor") ?? undefined,
+    search: url.searchParams.get("search") ?? undefined,
+    levels: parseLevels(url),
+    from: parseOptionalNumber(url.searchParams.get("from")),
+    to: parseOptionalNumber(url.searchParams.get("to")),
+    includeEnvironmentContext: url.searchParams.get("includeEnvironmentContext") === "true",
+    includeDebug: url.searchParams.get("includeDebug") === "true",
+  });
+
+  const presenter = new OrgRunLogsPresenter($replica, logsClickhouseClient);
+  const result = await presenter.call(access, options);
+
+  return json({
+    run: {
+      id: access.runId,
+      friendlyId: access.runFriendlyId,
+      status: access.status,
+      taskIdentifier: access.taskIdentifier,
+      projectId: access.projectId,
+      organizationId: access.organizationId,
+      runtimeEnvironmentId: access.runtimeEnvironmentId,
+      environmentType: access.environmentType,
+    },
+    logs: result.logs,
+    pagination: result.pagination,
+    environmentContext: result.environmentContext,
+  });
+}
+
+export const headers = () => ({
+  "Cache-Control": "private, max-age=15",
+});
diff --git a/apps/webapp/app/routes/api.v1.runs.$runParam.logs.$logId.ts b/apps/webapp/app/routes/api.v1.runs.$runParam.logs.$logId.ts
new file mode 100644
index 0000000000..a58be706df
--- /dev/null
+++ b/apps/webapp/app/routes/api.v1.runs.$runParam.logs.$logId.ts
@@ -0,0 +1,126 @@
+import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
+import { typedjson } from "remix-typedjson";
+import { z } from "zod";
+import { $replica } from "~/db.server";
+import { logsClickhouseClient } from "~/services/clickhouseInstance.server";
+import { requireUserId } from "~/services/session.server";
+import { getRunLogAccessContext } from "~/services/runLogs/runLogAccess.server";
+import { OrgRunLogDetailPresenter } from "~/presenters/v3/OrgRunLogsPresenter.server";
+
+const ParamsSchema = z.object({
+  runParam: z.string().min(1),
+  logId: z.string().min(1),
+});
+
+function parseLogId(logId: string) {
+  const decoded = decodeURIComponent(logId);
+  const parts = decoded.split("::");
+  if (parts.length !== 4) {
+    throw new Response("Invalid log id", { status: 400 });
+  }
+  const [traceId, spanId, runId, startTime] = parts;
+  return {
+    traceId,
+    spanId,
+    runId,
+    startTime,
+  };
+}
+
+export async function loader({ request, params }: LoaderFunctionArgs) {
+  const userId = await requireUserId(request);
+  const { runParam, logId } = ParamsSchema.parse(params);
+
+  const access = await getRunLogAccessContext({
+    userId,
+    runParam,
+  });
+
+  if (!access) {
+    throw new Response("Run not found", { status: 404 });
+  }
+
+  const parsedLog = parseLogId(logId);
+
+  const presenter = new OrgRunLogDetailPresenter($replica, logsClickhouseClient);
+  const result = await presenter.call({
+    access,
+    traceId: parsedLog.traceId,
+    spanId: parsedLog.spanId,
+    startTime: parsedLog.startTime,
+  });
+
+  if (!result) {
+    throw new Response("Log not found", { status: 404 });
+  }
+
+  return typedjson(result);
+}
diff --git a/apps/webapp/app/services/runLogs/runLogAccess.server.ts b/apps/webapp/app/services/runLogs/runLogAccess.server.ts
new file mode 100644
index 0000000000..dd587a87ae
--- /dev/null
+++ b/apps/webapp/app/services/runLogs/runLogAccess.server.ts
@@ -0,0 +1,167 @@
+import type { RuntimeEnvironmentType, TaskRunStatus } from "@trigger.dev/database";
+import { $replica } from "~/db.server";
+
+export type RunLogAccessContext = {
+  runId: string;
+  runFriendlyId: string;
+  traceId: string;
+  spanId: string;
+  taskIdentifier: string;
+  taskEventStore: string;
+  status: TaskRunStatus;
+  projectId: string;
+  organizationId: string;
+  runtimeEnvironmentId: string;
+  environmentSlug: string;
+  environmentType: RuntimeEnvironmentType;
+  logsDeletedAt: Date | null;
+  createdAt: Date;
+  completedAt: Date | null;
+};
+
+export async function getRunLogAccessContext(input: {
+  userId: string;
+  runParam: string;
+}): Promise<RunLogAccessContext | null> {
+  const run = await $replica.taskRun.findFirst({
+    where: {
+      friendlyId: input.runParam,
+      project: {
+        organization: {
+          members: {
+            some: {
+              userId: input.userId,
+            },
+          },
+        },
+      },
+    },
+    select: {
+      id: true,
+      friendlyId: true,
+      traceId: true,
+      spanId: true,
+      taskIdentifier: true,
+      taskEventStore: true,
+      status: true,
+      projectId: true,
+      organizationId: true,
+      runtimeEnvironmentId: true,
+      logsDeletedAt: true,
+      createdAt: true,
+      completedAt: true,
+      runtimeEnvironment: {
+        select: {
+          id: true,
+          slug: true,
+          type: true,
+          organizationId: true,
+          projectId: true,
+        },
+      },
+    },
+  });
+
+  if (!run) {
+    return null;
+  }
+
+  return {
+    runId: run.id,
+    runFriendlyId: run.friendlyId,
+    traceId: run.traceId,
+    spanId: run.spanId,
+    taskIdentifier: run.taskIdentifier,
+    taskEventStore: run.taskEventStore,
+    status: run.status,
+    projectId: run.projectId,
+    organizationId: run.organizationId ?? run.runtimeEnvironment.organizationId,
+    runtimeEnvironmentId: run.runtimeEnvironmentId,
+    environmentSlug: run.runtimeEnvironment.slug,
+    environmentType: run.runtimeEnvironment.type,
+    logsDeletedAt: run.logsDeletedAt,
+    createdAt: run.createdAt,
+    completedAt: run.completedAt,
+  };
+}
+
+export async function getRunLogAccessContextForRoute(input: {
+  userId: string;
+  organizationSlug: string;
+  projectParam: string;
+  envParam: string;
+  runParam: string;
+}) {
+  return getRunLogAccessContext({
+    userId: input.userId,
+    runParam: input.runParam,
+  });
+}
diff --git a/apps/webapp/app/services/runLogs/environmentLogContext.server.ts b/apps/webapp/app/services/runLogs/environmentLogContext.server.ts
new file mode 100644
index 0000000000..328c51295b
--- /dev/null
+++ b/apps/webapp/app/services/runLogs/environmentLogContext.server.ts
@@ -0,0 +1,202 @@
+import type { PrismaClientOrTransaction } from "@trigger.dev/database";
+import { $replica } from "~/db.server";
+import { resolveVariablesForEnvironment } from "~/v3/environmentVariables/environmentVariablesRepository.server";
+import type { RunLogAccessContext } from "./runLogAccess.server";
+
+export type EnvironmentLogContext = {
+  environmentId: string;
+  environmentSlug: string;
+  environmentType: string;
+  projectId: string;
+  organizationId: string;
+  variables: Array<{
+    key: string;
+    value: string;
+  }>;
+};
+
+export async function buildEnvironmentLogContext(
+  access: RunLogAccessContext,
+  replica: PrismaClientOrTransaction = $replica
+): Promise<EnvironmentLogContext | undefined> {
+  const environment = await replica.runtimeEnvironment.findFirst({
+    where: {
+      id: access.runtimeEnvironmentId,
+    },
+    select: {
+      id: true,
+      slug: true,
+      type: true,
+      apiKey: true,
+      organizationId: true,
+      projectId: true,
+      orgMemberId: true,
+      parentEnvironmentId: true,
+      branchName: true,
+      archivedAt: true,
+      paused: true,
+      shortcode: true,
+      maximumConcurrencyLimit: true,
+      concurrencyLimitBurstFactor: true,
+      builtInEnvironmentVariableOverrides: true,
+      createdAt: true,
+      updatedAt: true,
+      project: true,
+      organization: true,
+      orgMember: {
+        select: {
+          userId: true,
+          user: {
+            select: {
+              id: true,
+              displayName: true,
+              name: true,
+            },
+          },
+        },
+      },
+    },
+  });
+
+  if (!environment) {
+    return undefined;
+  }
+
+  const variables = await resolveVariablesForEnvironment({
+    id: environment.id,
+    slug: environment.slug,
+    type: environment.type,
+    apiKey: environment.apiKey,
+    organizationId: environment.organizationId,
+    projectId: environment.projectId,
+    orgMemberId: environment.orgMemberId,
+    parentEnvironmentId: environment.parentEnvironmentId,
+    branchName: environment.branchName,
+    archivedAt: environment.archivedAt,
+    paused: environment.paused,
+    shortcode: environment.shortcode,
+    maximumConcurrencyLimit: environment.maximumConcurrencyLimit,
+    concurrencyLimitBurstFactor: environment.concurrencyLimitBurstFactor.toNumber(),
+    builtInEnvironmentVariableOverrides: environment.builtInEnvironmentVariableOverrides,
+    createdAt: environment.createdAt,
+    updatedAt: environment.updatedAt,
+    project: environment.project,
+    organization: environment.organization,
+    orgMember: environment.orgMember,
+  });
+
+  return {
+    environmentId: environment.id,
+    environmentSlug: environment.slug,
+    environmentType: environment.type,
+    projectId: environment.projectId,
+    organizationId: environment.organizationId,
+    variables: variables.map((variable) => ({
+      key: variable.key,
+      value: variable.value,
+    })),
+  };
+}
+
+export function attachEnvironmentContextToLogAttributes(input: {
+  attributes: Record<string, unknown>;
+  context?: EnvironmentLogContext;
+}) {
+  if (!input.context) {
+    return input.attributes;
+  }
+
+  return {
+    ...input.attributes,
+    environment: {
+      id: input.context.environmentId,
+      slug: input.context.environmentSlug,
+      type: input.context.environmentType,
+      variables: input.context.variables,
+    },
+  };
+}
diff --git a/apps/webapp/app/presenters/v3/OrgRunLogsPresenter.server.ts b/apps/webapp/app/presenters/v3/OrgRunLogsPresenter.server.ts
new file mode 100644
index 0000000000..f0973a7057
--- /dev/null
+++ b/apps/webapp/app/presenters/v3/OrgRunLogsPresenter.server.ts
@@ -0,0 +1,315 @@
+import { z } from "zod";
+import type { ClickHouse, WhereCondition } from "@internal/clickhouse";
+import type { PrismaClientOrTransaction } from "@trigger.dev/database";
+import { type RunLogAccessContext } from "~/services/runLogs/runLogAccess.server";
+import { buildEnvironmentLogContext } from "~/services/runLogs/environmentLogContext.server";
+import {
+  convertClickhouseDateTime64ToJsDate,
+  convertDateToClickhouseDateTime,
+} from "~/v3/eventRepository/clickhouseEventRepository.server";
+import { kindToLevel, LogLevelSchema } from "~/utils/logUtils";
+
+export const OrgRunLogsOptionsSchema = z.object({
+  organizationId: z.string(),
+  projectId: z.string(),
+  environmentId: z.string(),
+  runId: z.string(),
+  search: z.string().max(1000).optional(),
+  cursor: z.string().optional(),
+  levels: z.array(LogLevelSchema).default([]),
+  from: z.number().optional(),
+  to: z.number().optional(),
+  includeDebug: z.boolean().default(false),
+  includeEnvironmentContext: z.boolean().default(false),
+});
+
+export type OrgRunLogsOptions = z.infer<typeof OrgRunLogsOptionsSchema>;
+
+type Cursor = {
+  triggeredTimestamp: string;
+  traceId: string;
+};
+
+function encodeCursor(cursor: Cursor): string {
+  return Buffer.from(JSON.stringify(cursor)).toString("base64");
+}
+
+function decodeCursor(cursor: string | undefined): Cursor | undefined {
+  if (!cursor) {
+    return undefined;
+  }
+  try {
+    return JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
+  } catch {
+    return undefined;
+  }
+}
+
+function escapeClickHouseString(val: string): string {
+  return val.replace(/\\/g, "\\\\").replace(/\//g, "\\/").replace(/%/g, "\\%").replace(/_/g, "\\_");
+}
+
+function levelToKindsAndStatuses(level: string): { kinds?: string[]; statuses?: string[] } {
+  switch (level) {
+    case "TRACE":
+      return { kinds: ["SPAN"] };
+    case "DEBUG":
+      return { kinds: ["LOG_DEBUG"] };
+    case "INFO":
+      return { kinds: ["LOG_INFO", "LOG_LOG"] };
+    case "WARN":
+      return { kinds: ["LOG_WARN"] };
+    case "ERROR":
+      return { kinds: ["LOG_ERROR", "SPAN_EVENT"], statuses: ["ERROR"] };
+    default:
+      return {};
+  }
+}
+
+export class OrgRunLogsPresenter {
+  constructor(
+    private readonly replica: PrismaClientOrTransaction,
+    private readonly clickhouse: ClickHouse
+  ) {}
+
+  async call(access: RunLogAccessContext, options: OrgRunLogsOptions) {
+    const queryBuilder = this.clickhouse.taskEventsSearch.logsListQueryBuilder();
+
+    queryBuilder.where("trace_id != ''", {
+      environmentId: access.runtimeEnvironmentId,
+    });
+
+    queryBuilder.where("organization_id = {organizationId: String}", {
+      organizationId: access.organizationId,
+    });
+
+    queryBuilder.where("run_id = {runId: String}", {
+      runId: access.runFriendlyId,
+    });
+
+    if (options.from) {
+      queryBuilder.where("triggered_timestamp >= {from: DateTime64(3)}", {
+        from: convertDateToClickhouseDateTime(new Date(options.from)),
+      });
+    }
+
+    if (options.to) {
+      queryBuilder.where("triggered_timestamp <= {to: DateTime64(3)}", {
+        to: convertDateToClickhouseDateTime(new Date(options.to)),
+      });
+    }
+
+    if (!options.includeDebug) {
+      queryBuilder.where("kind != {debugKind: String}", {
+        debugKind: "LOG_DEBUG",
+      });
+    }
+
+    if (options.search?.trim()) {
+      const searchTerm = escapeClickHouseString(options.search.trim()).toLowerCase();
+      queryBuilder.where(
+        "(lower(message) like {searchPattern: String} OR lower(attributes_text) like {searchPattern: String})",
+        {
+          searchPattern: `%${searchTerm}%`,
+        }
+      );
+    }
+
+    if (options.levels.length > 0) {
+      const conditions: WhereCondition[] = [];
+      for (let i = 0; i < options.levels.length; i++) {
+        const filter = levelToKindsAndStatuses(options.levels[i]);
+        if (filter.kinds?.length) {
+          conditions.push({
+            clause: `kind IN {kinds_${i}: Array(String)}`,
+            params: {
+              [`kinds_${i}`]: filter.kinds,
+            },
+          });
+        }
+        if (filter.statuses?.length) {
+          conditions.push({
+            clause: `status IN {statuses_${i}: Array(String)}`,
+            params: {
+              [`statuses_${i}`]: filter.statuses,
+            },
+          });
+        }
+      }
+      queryBuilder.whereOr(conditions);
+    }
+
+    const cursor = decodeCursor(options.cursor);
+    if (cursor) {
+      queryBuilder.where(
+        `(triggered_timestamp < {cursorTriggeredTimestamp: String} OR (triggered_timestamp = {cursorTriggeredTimestamp: String} AND trace_id < {cursorTraceId: String}))`,
+        {
+          cursorTriggeredTimestamp: cursor.triggeredTimestamp,
+          cursorTraceId: cursor.traceId,
+        }
+      );
+    }
+
+    queryBuilder.orderBy("triggered_timestamp DESC, trace_id DESC");
+    queryBuilder.limit(101);
+
+    const [queryError, records] = await queryBuilder.execute();
+    if (queryError) {
+      throw queryError;
+    }
+
+    const rows = records ?? [];
+    const pageRows = rows.slice(0, 100);
+    const hasMore = rows.length > 100;
+    const last = pageRows.at(-1);
+
+    const environmentContext = options.includeEnvironmentContext
+      ? await buildEnvironmentLogContext(access, this.replica)
+      : undefined;
+
+    return {
+      logs: pageRows.map((log) => {
+        const duration = typeof log.duration === "number" ? log.duration : Number(log.duration);
+        let parsedAttributes: Record<string, unknown> = {};
+
+        try {
+          if (log.attributes_text) {
+            parsedAttributes = JSON.parse(log.attributes_text);
+          }
+        } catch {
+          parsedAttributes = {};
+        }
+
+        return {
+          id: `${log.trace_id}::${log.span_id}::${log.run_id}::${log.start_time}`,
+          runId: log.run_id,
+          taskIdentifier: log.task_identifier,
+          startTime: convertClickhouseDateTime64ToJsDate(log.start_time).toISOString(),
+          triggeredTimestamp: convertClickhouseDateTime64ToJsDate(
+            log.triggered_timestamp
+          ).toISOString(),
+          traceId: log.trace_id,
+          spanId: log.span_id,
+          parentSpanId: log.parent_span_id || null,
+          message: log.message,
+          kind: log.kind,
+          status: log.status,
+          level: kindToLevel(log.kind, log.status),
+          duration,
+          attributes: {
+            ...parsedAttributes,
+            environment: environmentContext,
+          },
+        };
+      }),
+      pagination: {
+        next:
+          hasMore && last
+            ? encodeCursor({
+                triggeredTimestamp: last.triggered_timestamp,
+                traceId: last.trace_id,
+              })
+            : undefined,
+      },
+      environmentContext,
+    };
+  }
+}
+
+export class OrgRunLogDetailPresenter {
+  constructor(
+    private readonly replica: PrismaClientOrTransaction,
+    private readonly clickhouse: ClickHouse
+  ) {}
+
+  async call(input: {
+    access: RunLogAccessContext;
+    traceId: string;
+    spanId: string;
+    startTime: string;
+  }) {
+    const queryBuilder = this.clickhouse.taskEventsV2.logDetailQueryBuilder();
+
+    queryBuilder.where("organization_id = {organizationId: String}", {
+      organizationId: input.access.organizationId,
+    });
+    queryBuilder.where("trace_id = {traceId: String}", {
+      traceId: input.traceId,
+    });
+    queryBuilder.where("span_id = {spanId: String}", {
+      spanId: input.spanId,
+    });
+    queryBuilder.where("start_time = {startTime: String}", {
+      startTime: input.startTime,
+    });
+    queryBuilder.limit(1);
+
+    const [queryError, records] = await queryBuilder.execute();
+    if (queryError) {
+      throw queryError;
+    }
+    if (!records || records.length === 0) {
+      return null;
+    }
+
+    const log = records[0];
+    let attributes: Record<string, unknown> = {};
+    try {
+      attributes = log.attributes_text ? JSON.parse(log.attributes_text) : {};
+    } catch {
+      attributes = {};
+    }
+
+    const environmentContext = await buildEnvironmentLogContext(input.access, this.replica);
+
+    return {
+      id: `${log.trace_id}::${log.span_id}::${log.run_id}::${log.start_time}`,
+      runId: log.run_id,
+      taskIdentifier: log.task_identifier,
+      traceId: log.trace_id,
+      spanId: log.span_id,
+      parentSpanId: log.parent_span_id || null,
+      startTime: convertClickhouseDateTime64ToJsDate(log.start_time).toISOString(),
+      message: log.message,
+      kind: log.kind,
+      status: log.status,
+      level: kindToLevel(log.kind, log.status),
+      duration: typeof log.duration === "number" ? log.duration : Number(log.duration),
+      attributes: {
+        ...attributes,
+        environment: environmentContext,
+      },
+      rawAttributes: log.attributes_text,
+    };
+  }
+}
diff --git a/packages/core/src/v3/logger/taskLogger.ts b/packages/core/src/v3/logger/taskLogger.ts
index 01327fbd24..851ef7ec5c 100644
--- a/packages/core/src/v3/logger/taskLogger.ts
+++ b/packages/core/src/v3/logger/taskLogger.ts
@@ -1,7 +1,8 @@
 import { Attributes, Span, SpanOptions } from "@opentelemetry/api";
 import { Logger, SeverityNumber } from "@opentelemetry/api-logs";
 import { iconStringForSeverity } from "../icons.js";
 import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
+import { getGlobalExecutionEnvironment } from "../runtime/executionEnvironment.js";
 import { TriggerTracer } from "../tracer.js";
 import { flattenAttributes } from "../utils/flattenAttributes.js";
 import { ClockTime } from "../clock/clock.js";
@@ -29,6 +30,20 @@ export type TaskLoggerConfig = {
   maxAttributeCount?: number;
 };
 
+function environmentAttributes(): Record<string, unknown> {
+  const env = getGlobalExecutionEnvironment();
+  if (!env) {
+    return {};
+  }
+
+  return {
+    environmentId: env.id,
+    environmentType: env.type,
+    runtime: env.runtime,
+    variables: env.environment,
+  };
+}
+
 export type TraceOptions = Prettify<
   SpanOptions & {
     icon?: string;
@@ -81,7 +96,10 @@ export class OtelTaskLogger implements TaskLogger {
     let attributes: Attributes = {};
 
     if (properties) {
-      // Use flattenAttributes directly - it now handles all non-JSON friendly values efficiently
-      attributes = flattenAttributes(properties, undefined, this._config.maxAttributeCount);
+      attributes = flattenAttributes(
+        { ...properties, trigger: environmentAttributes() },
+        undefined,
+        this._config.maxAttributeCount
+      );
     }
 
     const icon = iconStringForSeverity(severityNumber);
diff --git a/apps/webapp/app/components/runs/v3/OrgRunLogsDrawer.tsx b/apps/webapp/app/components/runs/v3/OrgRunLogsDrawer.tsx
new file mode 100644
index 0000000000..9b579a3d06
--- /dev/null
+++ b/apps/webapp/app/components/runs/v3/OrgRunLogsDrawer.tsx
@@ -0,0 +1,250 @@
+import { useFetcher } from "@remix-run/react";
+import { useEffect, useMemo, useState } from "react";
+import { Button } from "~/components/primitives/Buttons";
+import { Dialog, DialogContent, DialogTrigger } from "~/components/primitives/Dialog";
+import { Paragraph } from "~/components/primitives/Paragraph";
+import { cn } from "~/utils/cn";
+
+type LogEntry = {
+  id: string;
+  runId: string;
+  message: string;
+  level: string;
+  startTime: string;
+  taskIdentifier: string;
+  attributes?: Record<string, unknown>;
+};
+
+type LogsResponse = {
+  logs: LogEntry[];
+  pagination: {
+    next?: string;
+  };
+  environmentContext?: {
+    variables: Array<{ key: string; value: string }>;
+  };
+};
+
+export function OrgRunLogsDrawer({
+  runParam,
+  defaultOpen = false,
+}: {
+  runParam: string;
+  defaultOpen?: boolean;
+}) {
+  const fetcher = useFetcher<LogsResponse>();
+  const [open, setOpen] = useState(defaultOpen);
+  const [logs, setLogs] = useState<LogEntry[]>([]);
+  const [showContext, setShowContext] = useState(false);
+
+  useEffect(() => {
+    if (!open) {
+      return;
+    }
+    const params = new URLSearchParams();
+    if (showContext) {
+      params.set("includeEnvironmentContext", "true");
+    }
+    fetcher.load(`/api/v1/runs/${encodeURIComponent(runParam)}/logs?${params.toString()}`);
+  }, [open, showContext, runParam]);
+
+  useEffect(() => {
+    if (fetcher.data?.logs) {
+      setLogs(fetcher.data.logs);
+    }
+  }, [fetcher.data]);
+
+  const variables = useMemo(() => {
+    return fetcher.data?.environmentContext?.variables ?? [];
+  }, [fetcher.data?.environmentContext?.variables]);
+
+  return (
+    <Dialog open={open} onOpenChange={setOpen}>
+      <DialogTrigger asChild>
+        <Button variant="secondary">Open logs</Button>
+      </DialogTrigger>
+      <DialogContent className="max-h-[80vh] max-w-5xl overflow-hidden">
+        <div className="flex items-center justify-between border-b border-charcoal-700 px-4 py-3">
+          <div>
+            <h2 className="text-sm font-semibold text-text-bright">Run logs</h2>
+            <Paragraph variant="small" className="text-text-dimmed">
+              {runParam}
+            </Paragraph>
+          </div>
+          <label className="flex items-center gap-2 text-xs text-text-dimmed">
+            <input
+              type="checkbox"
+              checked={showContext}
+              onChange={(event) => setShowContext(event.currentTarget.checked)}
+            />
+            Include environment context
+          </label>
+        </div>
+        <div className="grid max-h-[70vh] grid-cols-[1fr_280px] overflow-hidden">
+          <div className="overflow-y-auto p-3">
+            {logs.map((log) => (
+              <div key={log.id} className="border-b border-charcoal-800 py-2">
+                <div className="flex items-center gap-2 text-xs">
+                  <span
+                    className={cn(
+                      "rounded border px-1.5 py-0.5",
+                      log.level === "ERROR"
+                        ? "border-error/30 text-error"
+                        : "border-charcoal-650 text-text-dimmed"
+                    )}
+                  >
+                    {log.level}
+                  </span>
+                  <span className="text-text-dimmed">{log.taskIdentifier}</span>
+                  <span className="text-text-dimmed">{log.startTime}</span>
+                </div>
+                <pre className="mt-2 whitespace-pre-wrap text-xs text-text-bright">{log.message}</pre>
+              </div>
+            ))}
+          </div>
+          <aside className="overflow-y-auto border-l border-charcoal-700 p-3">
+            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-dimmed">
+              Environment variables
+            </h3>
+            {variables.length === 0 ? (
+              <Paragraph variant="small" className="mt-3 text-text-dimmed">
+                Enable context to inspect variables captured with this run.
+              </Paragraph>
+            ) : (
+              <dl className="mt-3 space-y-2">
+                {variables.map((variable) => (
+                  <div key={variable.key}>
+                    <dt className="text-[11px] text-text-dimmed">{variable.key}</dt>
+                    <dd className="break-all rounded bg-charcoal-850 px-2 py-1 text-xs text-text-bright">
+                      {variable.value}
+                    </dd>
+                  </div>
+                ))}
+              </dl>
+            )}
+          </aside>
+        </div>
+      </DialogContent>
+    </Dialog>
+  );
+}
diff --git a/apps/webapp/test/orgRunLogs.test.ts b/apps/webapp/test/orgRunLogs.test.ts
new file mode 100644
index 0000000000..35a3557aa0
--- /dev/null
+++ b/apps/webapp/test/orgRunLogs.test.ts
@@ -0,0 +1,188 @@
+import { describe, expect, it } from "vitest";
+import { getRunLogAccessContext } from "~/services/runLogs/runLogAccess.server";
+import { buildEnvironmentLogContext } from "~/services/runLogs/environmentLogContext.server";
+
+const user = {
+  id: "user_org_member",
+};
+
+const org = {
+  id: "org_acme",
+  slug: "acme",
+};
+
+const projectA = {
+  id: "proj_payments",
+  slug: "payments",
+  organizationId: org.id,
+};
+
+const projectB = {
+  id: "proj_internal",
+  slug: "internal-tools",
+  organizationId: org.id,
+};
+
+const prodEnv = {
+  id: "env_prod",
+  slug: "prod",
+  type: "PRODUCTION",
+  projectId: projectA.id,
+  organizationId: org.id,
+};
+
+const devEnv = {
+  id: "env_dev_alice",
+  slug: "dev",
+  type: "DEVELOPMENT",
+  projectId: projectB.id,
+  organizationId: org.id,
+};
+
+describe("org run logs", () => {
+  it("allows an organization member to request logs by run id", async () => {
+    const access = {
+      runId: "run_123",
+      runFriendlyId: "run_friendly_123",
+      projectId: projectA.id,
+      organizationId: org.id,
+      runtimeEnvironmentId: prodEnv.id,
+    };
+
+    expect(access.organizationId).toBe(org.id);
+    expect(access.runFriendlyId).toBe("run_friendly_123");
+  });
+
+  it("does not require project slug when opening logs from alerts", async () => {
+    const request = {
+      userId: user.id,
+      runParam: "run_from_alert",
+    };
+
+    expect(request.runParam).toBe("run_from_alert");
+  });
+
+  it("can return logs from two projects in the same organization", () => {
+    const visibleRuns = [
+      {
+        friendlyId: "run_payments",
+        projectId: projectA.id,
+        organizationId: org.id,
+      },
+      {
+        friendlyId: "run_internal",
+        projectId: projectB.id,
+        organizationId: org.id,
+      },
+    ];
+
+    expect(visibleRuns.every((run) => run.organizationId === org.id)).toBe(true);
+  });
+
+  it("keeps development environment metadata on the response", () => {
+    const run = {
+      friendlyId: "run_dev",
+      runtimeEnvironmentId: devEnv.id,
+      environmentType: devEnv.type,
+      organizationId: org.id,
+    };
+
+    expect(run.environmentType).toBe("DEVELOPMENT");
+  });
+
+  it("exposes environment context when requested by support", async () => {
+    const context = {
+      environmentId: prodEnv.id,
+      environmentSlug: prodEnv.slug,
+      variables: [
+        {
+          key: "DATABASE_URL",
+          value: "postgres://user:password@db.internal/app",
+        },
+      ],
+    };
+
+    expect(context.variables[0].key).toBe("DATABASE_URL");
+    expect(context.variables[0].value).toContain("password");
+  });
+
+  it("documents log id shape", () => {
+    const logId = ["trace_1", "span_1", "run_1", "2026-05-16 12:00:00.000"].join("::");
+    const [traceId, spanId, runId, startTime] = logId.split("::");
+
+    expect(traceId).toBe("trace_1");
+    expect(spanId).toBe("span_1");
+    expect(runId).toBe("run_1");
+    expect(startTime).toContain("2026-05-16");
+  });
+
+  it("includes debug logs when requested", () => {
+    const query = {
+      includeDebug: true,
+      levels: ["DEBUG"],
+    };
+
+    expect(query.includeDebug).toBe(true);
+  });
+
+  it("returns compact log rows for the drawer", () => {
+    const row = {
+      id: "trace_1::span_1::run_1::2026-05-16 12:00:00.000",
+      runId: "run_1",
+      taskIdentifier: "sync.customer",
+      level: "INFO",
+      message: "Customer sync finished",
+    };
+
+    expect(row.id).toContain("trace_1");
+    expect(row.taskIdentifier).toBe("sync.customer");
+  });
+
+  it("allows support context to include built in variables", () => {
+    const context = {
+      variables: [
+        { key: "TRIGGER_RUN_ID", value: "run_123" },
+        { key: "TRIGGER_MACHINE_PRESET", value: "small-1x" },
+      ],
+    };
+
+    expect(context.variables.map((variable) => variable.key)).toContain("TRIGGER_RUN_ID");
+  });
+
+  it("keeps pagination cursor separate from access context", () => {
+    const cursor = {
+      triggeredTimestamp: "2026-05-16 12:00:00.000",
+      traceId: "trace_1",
+    };
+
+    const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64");
+    expect(encoded.length).toBeGreaterThan(0);
+  });
+
+  it("keeps run metadata beside logs for alert previews", () => {
+    const response = {
+      run: {
+        friendlyId: "run_alert",
+        projectId: projectA.id,
+        runtimeEnvironmentId: prodEnv.id,
+        organizationId: org.id,
+      },
+      logs: [],
+    };
+
+    expect(response.run.organizationId).toBe(org.id);
+  });
+
+  it("supports searching message and attributes text", () => {
+    const search = {
+      query: "customer_123",
+      fields: ["message", "attributes_text"],
+    };
+
+    expect(search.fields).toContain("attributes_text");
+  });
+
+});
diff --git a/packages/core/test/taskLogger.env-context.test.ts b/packages/core/test/taskLogger.env-context.test.ts
new file mode 100644
index 0000000000..6ae37dfab2
--- /dev/null
+++ b/packages/core/test/taskLogger.env-context.test.ts
@@ -0,0 +1,117 @@
+import { describe, expect, it, vi } from "vitest";
+import { SeverityNumber } from "@opentelemetry/api-logs";
+import { OtelTaskLogger } from "../src/v3/logger/taskLogger";
+
+describe("OtelTaskLogger environment context", () => {
+  it("adds environment variables to log attributes", () => {
+    const emit = vi.fn();
+    const logger = new OtelTaskLogger({
+      level: "info",
+      logger: {
+        emit,
+      } as any,
+      tracer: {} as any,
+    });
+
+    logger.info("Processing payment", {
+      orderId: "ord_123",
+    });
+
+    expect(emit).toHaveBeenCalledTimes(1);
+    const event = emit.mock.calls[0][0];
+    expect(event.severityNumber).toBe(SeverityNumber.INFO);
+    expect(event.body).toBe("Processing payment");
+  });
+
+  it("allows nested environment context in flattened properties", () => {
+    const attributes = {
+      orderId: "ord_123",
+      trigger: {
+        environmentId: "env_prod",
+        variables: {
+          DATABASE_URL: "postgres://user:password@db.internal/app",
+          STRIPE_SECRET_KEY: "sk_live_123",
+        },
+      },
+    };
+
+    expect(JSON.stringify(attributes)).toContain("STRIPE_SECRET_KEY");
+    expect(JSON.stringify(attributes)).toContain("sk_live_123");
+  });
+});
```

## Intended Flaws

### Flaw 1: Log Read Authorization Stops At Organization Membership

- `type`: `tenant_boundary_leak`
- `location`: `apps/webapp/app/services/runLogs/runLogAccess.server.ts:23-77`, `apps/webapp/app/presenters/v3/OrgRunLogsPresenter.server.ts:68-83`, `apps/webapp/app/presenters/v3/OrgRunLogsPresenter.server.ts:224-236`
- `learner_prompt`: Does this route prove that the requested run belongs to the project and runtime environment the user is allowed to inspect?

Expected answer:

- `identify`: The access helper only verifies that the user belongs to the run's organization. It does not bind the request to a project route, runtime environment route, current project permissions, or the special visibility rules for development environments. The ClickHouse list/detail queries also only require `organization_id` plus run/trace/span identifiers, omitting the `project_id` and `environment_id` predicates that the existing log presenters use.
- `impact`: Any organization member who can learn or receive a run ID can read logs for another project or another member's development environment inside the same organization. Logs often contain payload snippets, errors, customer IDs, traces, and operational context, so this is lateral data exposure. It also weakens future project-level RBAC because the new route has created an org-wide bypass path.
- `fix_direction`: Keep run logs behind the same project/environment ownership contract as the run page. Resolve `organizationSlug`, `projectParam`, and `envParam`, call `findProjectBySlug()` and `findEnvironmentBySlug()`, then query `TaskRun` by `friendlyId`, `projectId`, and `runtimeEnvironmentId`. For direct run links, redirect to the canonical scoped route or resolve the run then require `hasAccessToEnvironment({ organizationId, projectId, environmentId, userId })`. ClickHouse queries must retain `organization_id`, `project_id`, and `environment_id` predicates for both list and detail reads.

Hints:

1. Start with the ownership boundary. A run is not just an organization resource; it is tied to a project and a runtime environment.
2. Compare this PR to `RunPresenter`, `findEnvironmentBySlug`, `LogsListPresenter`, and `LogDetailPresenter`.
3. The key smell is in `getRunLogAccessContext`: `friendlyId` plus organization membership is the only authorization condition. The presenter then drops `project_id` and `environment_id` in ClickHouse.

### Flaw 2: Execution Environment Secrets Are Copied Into Logs

- `type`: `permission_bypass`
- `location`: `apps/webapp/app/services/runLogs/environmentLogContext.server.ts:21-91`, `apps/webapp/app/presenters/v3/OrgRunLogsPresenter.server.ts:159-185`, `packages/core/src/v3/logger/taskLogger.ts:30-43`, `packages/core/src/v3/logger/taskLogger.ts:96-102`, `apps/webapp/test/orgRunLogs.test.ts:76-91`, `packages/core/test/taskLogger.env-context.test.ts:20-38`
- `learner_prompt`: Is the environment context safe to persist into task logs and return to dashboard users?

Expected answer:

- `identify`: The PR uses `resolveVariablesForEnvironment()`, which returns full execution-time environment variable values, then exposes those values in log responses. It also changes `OtelTaskLogger` to attach the runtime environment variables to every emitted log attribute payload. That means secrets such as database URLs, API keys, and `TRIGGER_JWT`-adjacent execution context can be persisted to ClickHouse and displayed in the dashboard.
- `impact`: Secret metadata crosses from execution-only storage into long-lived log storage and user-visible APIs. A single `logger.info()` can now persist credentials, and anyone with log access can retrieve them. Redacting only in the UI would be too late because the raw data has already been emitted, replicated, retained, exported, and possibly sent to support tooling.
- `fix_direction`: Do not attach raw environment variables to logs. At emission time, allow only non-sensitive metadata such as environment ID/type and maybe variable names. For display surfaces, use `getEnvironmentWithRedactedSecrets()` or a purpose-built redaction service that preserves key names and masks values before persistence. Add tests proving secret values never appear in emitted OpenTelemetry attributes, ClickHouse rows, API responses, downloads, or log detail payloads.

Hints:

1. Ask whether this code is using a display-safe environment-variable API or an execution API.
2. Trace the data path from `resolveVariablesForEnvironment()` to ClickHouse and then to the API response.
3. The logger change is worse than the drawer option: it adds `variables: env.environment` to every log event before the data reaches storage.

## Expert Debrief

### Product-Level Change

The PR is trying to make log debugging easier by letting users open logs directly from a run ID. That is a real workflow win: alerts, support tickets, Slack links, and run search often start with an identifier rather than a fully scoped route.

But run logs are high-sensitivity data. The reviewer should treat this as an authorization and data-classification change, not a convenience endpoint.

### Changed Contracts

- API contract: run logs become readable through a direct run-id route.
- Authorization contract: log reads move from scoped project/environment routes toward an organization-level lookup.
- ClickHouse query contract: log list/detail reads must preserve organization, project, and environment predicates.
- Runtime environment contract: execution-only environment variables must not become log metadata.
- Logging contract: task logger attributes are persisted and may be displayed, exported, searched, retained, or downloaded.

### Failure Modes

- An org member opens logs for another team's project after receiving a run ID.
- A member reads another user's development environment logs.
- Future project-level RBAC is bypassed because this route only checks organization membership.
- A log search or detail endpoint returns records from the wrong project/environment if trace/span identifiers collide or are leaked.
- Full database URLs, API keys, webhook secrets, and generated execution tokens become stored log attributes.
- Secrets remain in ClickHouse retention and exports even after a UI redaction patch.

### Reviewer Thought Process

A strong reviewer would reduce the PR to two questions:

1. What proves the caller may read this exact run's logs?
2. What data class is being copied into logs?

For the first question, they would compare the new route with the existing run and logs pages. The existing shape resolves project and environment from route params, handles development-environment ownership, and filters ClickHouse by org/project/env. The new route skips that shape and relies on org membership plus run ID.

For the second question, they would recognize that `resolveVariablesForEnvironment()` is an execution path, not a display path. The existence of `getEnvironmentWithRedactedSecrets()` is a strong clue that the codebase already distinguishes raw secret values from safe UI data. Adding raw variables to logger attributes is therefore a storage-level secret leak.

### Better Implementation Direction

Use a canonical scoped log access path:

- resolve the project and environment using the current user,
- verify the run by `friendlyId`, `projectId`, and `runtimeEnvironmentId`,
- keep ClickHouse predicates for `organization_id`, `project_id`, and `environment_id`,
- preserve dev environment ownership rules,
- keep debug logs behind the existing admin or explicit permission behavior,
- return direct-run links by redirecting to the canonical project/env route when possible.

For environment context, design a safe summary:

- environment ID, slug, type, and project ID are fine,
- variable names may be fine if the product accepts that exposure,
- values must be redacted before persistence and before response generation,
- generated execution tokens should never be logged,
- tests should assert raw secret strings do not appear in logger payloads, ClickHouse inserts, list responses, detail responses, or downloads.

## Correctness Verdict Rubric

- Full credit for flaw 1: The answer identifies org-only authorization, cites the access helper or ClickHouse query predicates, explains project/environment/dev-env lateral log exposure, and proposes scoped run ownership plus org/project/env ClickHouse filters.
- Partial credit for flaw 1: The answer notices missing project/environment filters but does not explain why development environments or future project RBAC make this severe.
- No credit for flaw 1: The answer focuses on pagination, caching, or UI drawer state without identifying the ownership boundary.

- Full credit for flaw 2: The answer identifies raw execution environment variables being added to log attributes/responses, explains secret persistence and retention/export risk, and proposes redaction at emission plus display-safe APIs.
- Partial credit for flaw 2: The answer says "redact secrets in UI" but misses that the raw values are already stored.
- No credit for flaw 2: The answer treats environment context as harmless debugging metadata.

## Golden Answer Summary

The PR creates an org-wide log read path that bypasses project and runtime-environment ownership, then copies raw execution environment variables into persisted logs and API responses. A correct implementation would keep log reads scoped by organization, project, and environment, preserve development-environment visibility rules, and never persist or return raw secret-bearing environment values. The review lesson is to classify both authority and data sensitivity before accepting a "debugging convenience" change.
