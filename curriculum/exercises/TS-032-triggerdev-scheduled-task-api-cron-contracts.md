# TS-032: Trigger.dev Scheduled Task API Cron Contracts

## Metadata

- `id`: TS-032
- `source_repo`: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- `repo_area`: scheduled task APIs, cron parsing, timezone contracts, schedule engine registration, task schedule updates, Prisma schedule models, SDK API client schemas
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,200-1,550
- `represented_diff_lines`: 1231
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about cron contracts, timezone semantics, scheduler idempotency, update-vs-create behavior, active schedule uniqueness, and worker/UI consistency without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a task-scoped scheduled task API.

Today users can create schedules through the general schedules API or dashboard. This PR adds a more ergonomic endpoint for product teams that think in terms of tasks:

- `POST /api/v1/tasks/:taskParam/schedule`,
- `PUT /api/v1/tasks/:taskParam/schedule`,
- SDK helpers `tasks.schedule.create()` and `tasks.schedule.update()`,
- cron string validation,
- optional timezone in API input,
- automatic schedule preview,
- schedule replacement for existing task schedules,
- schedule engine registration for the next run,
- tests for create, update, timezone display, and duplicate schedule history.

The stated product behavior is: a user should be able to attach one active cron schedule to a task in the current environment, update it later, and have it run at the wall-clock time they configured.

## Existing Code Context

The real Trigger.dev codebase already has these relevant contracts:

- `apps/webapp/app/v3/schedules.ts` defines `UpsertSchedule` with `cron`, `timezone`, `taskIdentifier`, `environments`, and optional `friendlyId`.
- `apps/webapp/app/v3/services/checkSchedule.server.ts` validates cron syntax, validates IANA timezones using `getTimezones()`, checks that the task exists, and enforces schedule limits.
- `apps/webapp/app/v3/services/upsertTaskSchedule.server.ts` stores `timezone: options.timezone ?? "UTC"` on `TaskSchedule` and updates an existing schedule when `friendlyId` or `deduplicationKey` identifies one.
- `internal-packages/database/prisma/schema.prisma` has `TaskSchedule.timezone String @default("UTC")`, `TaskSchedule.active`, `TaskScheduleInstance.active`, `@@unique([projectId, deduplicationKey])`, and `@@unique([taskScheduleId, environmentId])`.
- `internal-packages/schedule-engine/src/engine/scheduleCalculation.ts` passes the stored timezone into `cron-parser` via `{ tz: timezone ?? undefined }`.
- `internal-packages/schedule-engine/src/engine/index.ts` registers the next task schedule instance using `instance.taskSchedule.generatorExpression` and `instance.taskSchedule.timezone`.
- `packages/core/src/v3/schemas/api.ts` documents that schedule timestamps are UTC, but the schedule has an IANA timezone that defines wall-clock execution.
- The existing API route `apps/webapp/app/routes/api.v1.schedules.$scheduleId.ts` updates schedules through `UpsertTaskScheduleService`, not by creating another active schedule row.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the implementation preserves Trigger.dev's scheduling contracts as the codebase grows.

## Review Surface

Changed files in the synthetic PR:

- `packages/core/src/v3/schemas/api.ts`
- `packages/core/src/v3/apiClient/index.ts`
- `packages/trigger-sdk/src/v3/tasks/schedule.ts`
- `apps/webapp/app/routes/api.v1.tasks.$taskParam.schedule.ts`
- `apps/webapp/app/v3/services/taskScopedSchedule.server.ts`
- `apps/webapp/app/v3/services/taskScopedSchedule.server.test.ts`
- `internal-packages/schedule-engine/src/engine/taskScopedRegistration.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on cron/timezone contracts, active schedule uniqueness, update semantics, and worker registration behavior.

## Diff

```diff
diff --git a/packages/core/src/v3/schemas/api.ts b/packages/core/src/v3/schemas/api.ts
index b27f131c8..81a4a9239 100644
--- a/packages/core/src/v3/schemas/api.ts
+++ b/packages/core/src/v3/schemas/api.ts
@@ -970,6 +970,147 @@ export const UpdateScheduleOptions = CreateScheduleOptions.omit({ deduplicationK
 
 export type UpdateScheduleOptions = z.infer<typeof UpdateScheduleOptions>;
 
+export const TaskSchedulePreview = z.object({
+  nextRun: z.date(),
+  nextRunIso: z.string(),
+  description: z.string(),
+  timezone: z.string(),
+});
+
+export type TaskSchedulePreview = z.infer<typeof TaskSchedulePreview>;
+
+export const TaskScopedScheduleOptions = z.object({
+  /** CRON expression in five-field format. */
+  cron: z.string().min(1),
+  /** Optional IANA timezone. If omitted, the API uses the caller's local timezone label. */
+  timezone: z.string().optional(),
+  /** Optional external id passed to the scheduled run payload. */
+  externalId: z.string().optional(),
+  /**
+   * Replaces an existing task-scoped schedule for the current environment.
+   * Defaults to true because this API is task scoped rather than schedule scoped.
+   */
+  replaceExisting: z.boolean().optional().default(true),
+});
+
+export type TaskScopedScheduleOptions = z.infer<typeof TaskScopedScheduleOptions>;
+
+export const TaskScopedScheduleObject = z.object({
+  id: z.string(),
+  task: z.string(),
+  active: z.boolean(),
+  cron: z.string(),
+  timezone: z.string(),
+  externalId: z.string().optional(),
+  replacedScheduleIds: z.array(z.string()).optional(),
+  preview: TaskSchedulePreview,
+});
+
+export type TaskScopedScheduleObject = z.infer<typeof TaskScopedScheduleObject>;
+
+export const TaskScopedScheduleHistoryObject = z.object({
+  scheduleId: z.string(),
+  active: z.boolean(),
+  cron: z.string(),
+  timezone: z.string(),
+  createdAt: z.date(),
+});
+
+export type TaskScopedScheduleHistoryObject = z.infer<
+  typeof TaskScopedScheduleHistoryObject
+>;
+
+export const TaskScopedScheduleListResponse = z.object({
+  task: z.string(),
+  schedules: z.array(TaskScopedScheduleHistoryObject),
+});
+
+export type TaskScopedScheduleListResponse = z.infer<
+  typeof TaskScopedScheduleListResponse
+>;
+
+export const TaskScopedScheduleError = z.object({
+  error: z.string(),
+  issues: z.array(z.unknown()).optional(),
+});
+
+export type TaskScopedScheduleError = z.infer<typeof TaskScopedScheduleError>;
+
+export const TaskScopedScheduleExamples = {
+  createDailyLocalNineAm: {
+    cron: "0 9 * * *",
+    timezone: "America/Los_Angeles",
+    externalId: "customer-report",
+  },
+  updateDailyLocalEightAm: {
+    cron: "0 8 * * *",
+    timezone: "America/Los_Angeles",
+    externalId: "customer-report",
+    replaceExisting: true,
+  },
+  response: {
+    id: "sched_abc123",
+    task: "send-report",
+    active: true,
+    cron: "0 9 * * *",
+    timezone: "America/Los_Angeles",
+    preview: {
+      nextRun: new Date("2026-05-17T16:00:00.000Z"),
+      nextRunIso: "2026-05-17T16:00:00.000Z",
+      description: "At 09:00 AM, every day",
+      timezone: "America/Los_Angeles",
+    },
+  },
+} satisfies Record<string, unknown>;
+
+export const TaskScopedScheduleFieldDescriptions = {
+  cron: "Five-field CRON expression.",
+  timezone: "IANA timezone used for schedule display and returned previews.",
+  externalId: "User-defined external id available to the scheduled run payload.",
+  replaceExisting:
+    "When true, creating or updating the task-scoped schedule replaces the previous task schedule.",
+};
+
+export const TaskScopedScheduleResponseDescriptions = {
+  id: "The created schedule id.",
+  task: "The task identifier the schedule is attached to.",
+  active: "Whether the schedule is active.",
+  cron: "The stored cron expression.",
+  timezone: "The timezone shown to API callers.",
+  replacedScheduleIds: "Previous task schedule ids that were replaced by this request.",
+  preview: "Computed preview for the next scheduled run.",
+};
+
+export const TaskScopedScheduleDocs = [
+  "Task scoped schedules are a convenience layer over Trigger.dev schedules.",
+  "The task path identifies the scheduled task and the current API key identifies the environment.",
+  "By default creating a task schedule replaces the existing task schedule for that task.",
+  "Use the general schedules API when a task intentionally needs multiple schedules.",
+].join(" ");
+
+export const TaskScopedScheduleLimitNotes = [
+  "This API still counts against project schedule limits.",
+  "Only one active task-scoped schedule should exist per task and environment.",
+  "Inactive historical schedules may be retained for audit and rollback.",
+].join(" ");
diff --git a/packages/core/src/v3/apiClient/index.ts b/packages/core/src/v3/apiClient/index.ts
index 938bbfa17..dc7df8057 100644
--- a/packages/core/src/v3/apiClient/index.ts
+++ b/packages/core/src/v3/apiClient/index.ts
@@ -40,6 +40,10 @@ import {
   ScheduleObject,
   CreateScheduleOptions,
   UpdateScheduleOptions,
+  TaskScopedScheduleObject,
+  TaskScopedScheduleOptions,
+  TaskScopedScheduleListResponse,
+  TaskScopedScheduleError,
 } from "../schemas/api.js";
 
 export class TriggerApiClient {
@@ -865,6 +869,89 @@ export class TriggerApiClient {
       mergeRequestOptions(this.defaultRequestOptions, requestOptions)
     );
   }
+
+  createTaskSchedule(
+    task: string,
+    options: TaskScopedScheduleOptions,
+    requestOptions?: ZodFetchOptions
+  ) {
+    return zodfetch(
+      TaskScopedScheduleObject,
+      `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(task)}/schedule`,
+      {
+        method: "POST",
+        headers: this.#getHeaders(false),
+        body: JSON.stringify(options),
+      },
+      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
+    );
+  }
+
+  updateTaskSchedule(
+    task: string,
+    options: TaskScopedScheduleOptions,
+    requestOptions?: ZodFetchOptions
+  ) {
+    return zodfetch(
+      TaskScopedScheduleObject,
+      `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(task)}/schedule`,
+      {
+        method: "PUT",
+        headers: this.#getHeaders(false),
+        body: JSON.stringify(options),
+      },
+      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
+    );
+  }
+
+  listTaskSchedules(task: string, requestOptions?: ZodFetchOptions) {
+    return zodfetch(
+      TaskScopedScheduleListResponse,
+      `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(task)}/schedule`,
+      {
+        method: "GET",
+        headers: this.#getHeaders(false),
+      },
+      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
+    );
+  }
+
+  deleteTaskSchedule(task: string, requestOptions?: ZodFetchOptions) {
+    return zodfetch(
+      TaskScopedScheduleObject.or(TaskScopedScheduleError),
+      `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(task)}/schedule`,
+      {
+        method: "DELETE",
+        headers: this.#getHeaders(false),
+      },
+      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
+    );
+  }
 
   listEnvVars(projectRef: string, slug: string, requestOptions?: ZodFetchOptions) {
     return zodfetch(
diff --git a/packages/trigger-sdk/src/v3/tasks/schedule.ts b/packages/trigger-sdk/src/v3/tasks/schedule.ts
new file mode 100644
index 000000000..8249c8154
--- /dev/null
+++ b/packages/trigger-sdk/src/v3/tasks/schedule.ts
@@ -0,0 +1,153 @@
+import {
+  ApiPromise,
+  ApiRequestOptions,
+  TaskScopedScheduleObject,
+  TaskScopedScheduleOptions,
+} from "@trigger.dev/core/v3";
+import { accessoryAttributes, apiClientManager, mergeRequestOptions, tracer } from "../api.js";
+
+export type CreateTaskScheduleOptions = TaskScopedScheduleOptions;
+export type UpdateTaskScheduleOptions = TaskScopedScheduleOptions;
+
+const scheduleAttributes = (task: string, cron: string, timezone?: string) => ({
+  ...accessoryAttributes({
+    items: [
+      {
+        text: task,
+        variant: "normal",
+      },
+      {
+        text: cron,
+        variant: "normal",
+      },
+      ...(timezone
+        ? [
+            {
+              text: timezone,
+              variant: "normal" as const,
+            },
+          ]
+        : []),
+    ],
+    style: "codepath",
+  }),
+});
+
+export function create(
+  task: string,
+  options: CreateTaskScheduleOptions,
+  requestOptions?: ApiRequestOptions
+): ApiPromise<TaskScopedScheduleObject> {
+  const apiClient = apiClientManager.clientOrThrow();
+
+  const timezone =
+    options.timezone ??
+    Intl.DateTimeFormat().resolvedOptions().timeZone ??
+    "UTC";
+
+  const $requestOptions = mergeRequestOptions(
+    {
+      tracer,
+      name: "tasks.schedule.create()",
+      icon: "clock",
+      attributes: scheduleAttributes(task, options.cron, timezone),
+    },
+    requestOptions
+  );
+
+  return apiClient.createTaskSchedule(
+    task,
+    {
+      ...options,
+      timezone,
+      replaceExisting: options.replaceExisting ?? true,
+    },
+    $requestOptions
+  );
+}
+
+export function update(
+  task: string,
+  options: UpdateTaskScheduleOptions,
+  requestOptions?: ApiRequestOptions
+): ApiPromise<TaskScopedScheduleObject> {
+  const apiClient = apiClientManager.clientOrThrow();
+
+  const timezone =
+    options.timezone ??
+    Intl.DateTimeFormat().resolvedOptions().timeZone ??
+    "UTC";
+
+  const $requestOptions = mergeRequestOptions(
+    {
+      tracer,
+      name: "tasks.schedule.update()",
+      icon: "clock",
+      attributes: scheduleAttributes(task, options.cron, timezone),
+    },
+    requestOptions
+  );
+
+  return apiClient.updateTaskSchedule(
+    task,
+    {
+      ...options,
+      timezone,
+      replaceExisting: options.replaceExisting ?? true,
+    },
+    $requestOptions
+  );
+}
+
+export function list(task: string, requestOptions?: ApiRequestOptions) {
+  const apiClient = apiClientManager.clientOrThrow();
+
+  return apiClient.listTaskSchedules(
+    task,
+    mergeRequestOptions(
+      {
+        tracer,
+        name: "tasks.schedule.list()",
+        icon: "clock",
+        attributes: scheduleAttributes(task, "list"),
+      },
+      requestOptions
+    )
+  );
+}
+
+export function del(task: string, requestOptions?: ApiRequestOptions) {
+  const apiClient = apiClientManager.clientOrThrow();
+
+  return apiClient.deleteTaskSchedule(
+    task,
+    mergeRequestOptions(
+      {
+        tracer,
+        name: "tasks.schedule.delete()",
+        icon: "clock",
+        attributes: scheduleAttributes(task, "delete"),
+      },
+      requestOptions
+    )
+  );
+}
+
+export const schedule = {
+  create,
+  update,
+  list,
+  del,
+};
diff --git a/apps/webapp/app/routes/api.v1.tasks.$taskParam.schedule.ts b/apps/webapp/app/routes/api.v1.tasks.$taskParam.schedule.ts
new file mode 100644
index 000000000..7604d64c7
--- /dev/null
+++ b/apps/webapp/app/routes/api.v1.tasks.$taskParam.schedule.ts
@@ -0,0 +1,159 @@
+import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
+import { json } from "@remix-run/server-runtime";
+import {
+  TaskScopedScheduleObject,
+  TaskScopedScheduleOptions,
+  TaskScopedScheduleListResponse,
+} from "@trigger.dev/core/v3";
+import { z } from "zod";
+import { authenticateApiRequest } from "~/services/apiAuth.server";
+import { logger } from "~/services/logger.server";
+import { ServiceValidationError } from "~/v3/services/baseService.server";
+import {
+  TaskScopedScheduleService,
+  taskScopedScheduleToResponse,
+} from "~/v3/services/taskScopedSchedule.server";
+
+const ParamsSchema = z.object({
+  taskParam: z.string().min(1),
+});
+
+export async function action({ request, params }: ActionFunctionArgs) {
+  const authenticationResult = await authenticateApiRequest(request);
+
+  if (!authenticationResult) {
+    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
+  }
+
+  const parsedParams = ParamsSchema.safeParse(params);
+
+  if (!parsedParams.success) {
+    return json(
+      { error: "Invalid request parameters", issues: parsedParams.error.issues },
+      { status: 400 }
+    );
+  }
+
+  const method = request.method.toUpperCase();
+  const service = new TaskScopedScheduleService();
+
+  switch (method) {
+    case "POST":
+    case "PUT": {
+      const rawBody = await request.json();
+      const parsedBody = TaskScopedScheduleOptions.safeParse(rawBody);
+
+      if (!parsedBody.success) {
+        return json(
+          { error: "Invalid request body", issues: parsedBody.error.issues },
+          { status: 400 }
+        );
+      }
+
+      try {
+        const result = await service.upsert({
+          projectId: authenticationResult.environment.projectId,
+          environmentId: authenticationResult.environment.id,
+          taskIdentifier: parsedParams.data.taskParam,
+          cron: parsedBody.data.cron,
+          timezone: parsedBody.data.timezone,
+          externalId: parsedBody.data.externalId,
+          replaceExisting: parsedBody.data.replaceExisting,
+          source: method === "POST" ? "create" : "update",
+        });
+
+        return json(TaskScopedScheduleObject.parse(taskScopedScheduleToResponse(result)), {
+          status: 200,
+        });
+      } catch (error) {
+        if (error instanceof ServiceValidationError) {
+          return json({ error: error.message }, { status: 422 });
+        }
+
+        logger.error("Failed to upsert task-scoped schedule", {
+          taskIdentifier: parsedParams.data.taskParam,
+          error,
+        });
+
+        return json({ error: "Something went wrong, please try again." }, { status: 500 });
+      }
+    }
+
+    case "DELETE": {
+      try {
+        const result = await service.deleteActive({
+          projectId: authenticationResult.environment.projectId,
+          environmentId: authenticationResult.environment.id,
+          taskIdentifier: parsedParams.data.taskParam,
+        });
+
+        return json(TaskScopedScheduleObject.parse(taskScopedScheduleToResponse(result)), {
+          status: 200,
+        });
+      } catch (error) {
+        if (error instanceof ServiceValidationError) {
+          return json({ error: error.message }, { status: 422 });
+        }
+
+        logger.error("Failed to delete task-scoped schedule", {
+          taskIdentifier: parsedParams.data.taskParam,
+          error,
+        });
+
+        return json({ error: "Something went wrong, please try again." }, { status: 500 });
+      }
+    }
+
+    default:
+      return json({ error: "Method Not Allowed" }, { status: 405 });
+  }
+}
+
+export async function loader({ request, params }: LoaderFunctionArgs) {
+  const authenticationResult = await authenticateApiRequest(request);
+
+  if (!authenticationResult) {
+    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
+  }
+
+  const parsedParams = ParamsSchema.safeParse(params);
+
+  if (!parsedParams.success) {
+    return json(
+      { error: "Invalid request parameters", issues: parsedParams.error.issues },
+      { status: 400 }
+    );
+  }
+
+  const service = new TaskScopedScheduleService();
+
+  const schedules = await service.list({
+    projectId: authenticationResult.environment.projectId,
+    environmentId: authenticationResult.environment.id,
+    taskIdentifier: parsedParams.data.taskParam,
+  });
+
+  return json(
+    TaskScopedScheduleListResponse.parse({
+      task: parsedParams.data.taskParam,
+      schedules: schedules.map((schedule) => ({
+        scheduleId: schedule.friendlyId,
+        active: schedule.active,
+        cron: schedule.generatorExpression,
+        timezone: schedule.timezone,
+        createdAt: schedule.createdAt,
+      })),
+    })
+  );
+}
diff --git a/apps/webapp/app/v3/services/taskScopedSchedule.server.ts b/apps/webapp/app/v3/services/taskScopedSchedule.server.ts
new file mode 100644
index 000000000..24815cf49
--- /dev/null
+++ b/apps/webapp/app/v3/services/taskScopedSchedule.server.ts
@@ -0,0 +1,395 @@
+import { type TaskSchedule } from "@trigger.dev/database";
+import cronstrue from "cronstrue";
+import { nanoid } from "nanoid";
+import { generateFriendlyId } from "../friendlyIdentifiers";
+import { calculateNextScheduledTimestampFromNow } from "../utils/calculateNextSchedule.server";
+import { BaseService, ServiceValidationError } from "./baseService.server";
+import { CheckScheduleService } from "./checkSchedule.server";
+import { scheduleEngine } from "../scheduleEngine.server";
+
+type UpsertTaskScopedScheduleInput = {
+  projectId: string;
+  environmentId: string;
+  taskIdentifier: string;
+  cron: string;
+  timezone?: string;
+  externalId?: string;
+  replaceExisting: boolean;
+  source: "create" | "update";
+};
+
+type ListTaskScopedScheduleInput = {
+  projectId: string;
+  environmentId: string;
+  taskIdentifier: string;
+};
+
+type DeleteTaskScopedScheduleInput = {
+  projectId: string;
+  environmentId: string;
+  taskIdentifier: string;
+};
+
+type TaskScopedScheduleResult = {
+  schedule: TaskSchedule;
+  replacedScheduleIds: string[];
+  requestedTimezone: string;
+};
+
+const defaultLocalTimezone = () => {
+  try {
+    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
+  } catch {
+    return "UTC";
+  }
+};
+
+const normalizeCron = (cron: string) =>
+  cron
+    .trim()
+    .replace(/\s+/g, " ");
+
+const normalizeRequestedTimezone = (timezone?: string) =>
+  timezone && timezone.trim().length > 0 ? timezone.trim() : defaultLocalTimezone();
+
+const previewForResponse = ({
+  cron,
+  requestedTimezone,
+}: {
+  cron: string;
+  requestedTimezone: string;
+}) => {
+  const nextRun = calculateNextScheduledTimestampFromNow(cron, requestedTimezone);
+
+  return {
+    nextRun,
+    nextRunIso: nextRun.toISOString(),
+    description: cronstrue.toString(cron),
+    timezone: requestedTimezone,
+  };
+};
+
+const taskScheduleDeduplicationKey = ({
+  taskIdentifier,
+  environmentId,
+}: {
+  taskIdentifier: string;
+  environmentId: string;
+}) => `task:${taskIdentifier}:env:${environmentId}:${nanoid(12)}`;
+
+export const taskScopedScheduleToResponse = (result: TaskScopedScheduleResult) => ({
+  id: result.schedule.friendlyId,
+  task: result.schedule.taskIdentifier,
+  active: result.schedule.active,
+  cron: result.schedule.generatorExpression,
+  timezone: result.requestedTimezone,
+  externalId: result.schedule.externalId ?? undefined,
+  replacedScheduleIds: result.replacedScheduleIds,
+  preview: previewForResponse({
+    cron: result.schedule.generatorExpression,
+    requestedTimezone: result.requestedTimezone,
+  }),
+});
+
+export class TaskScopedScheduleService extends BaseService {
+  public async upsert(input: UpsertTaskScopedScheduleInput): Promise<TaskScopedScheduleResult> {
+    const cron = normalizeCron(input.cron);
+    const requestedTimezone = normalizeRequestedTimezone(input.timezone);
+
+    const checkSchedule = new CheckScheduleService(this._prisma);
+    await checkSchedule.call(
+      input.projectId,
+      {
+        cron,
+        timezone: requestedTimezone,
+        taskIdentifier: input.taskIdentifier,
+      },
+      [input.environmentId]
+    );
+
+    const existingActiveSchedules = await this._prisma.taskSchedule.findMany({
+      where: {
+        projectId: input.projectId,
+        taskIdentifier: input.taskIdentifier,
+        active: true,
+        instances: {
+          some: {
+            environmentId: input.environmentId,
+            active: true,
+          },
+        },
+      },
+      orderBy: {
+        createdAt: "desc",
+      },
+      include: {
+        instances: true,
+      },
+    });
+
+    if (
+      existingActiveSchedules.length > 0 &&
+      input.source === "create" &&
+      input.replaceExisting === false
+    ) {
+      throw new ServiceValidationError(
+        `Task ${input.taskIdentifier} already has an active schedule in this environment.`
+      );
+    }
+
+    const replacedScheduleIds =
+      input.replaceExisting === true
+        ? existingActiveSchedules.map((schedule) => schedule.friendlyId)
+        : [];
+
+    const schedule = await this._prisma.taskSchedule.create({
+      data: {
+        projectId: input.projectId,
+        friendlyId: generateFriendlyId("sched"),
+        taskIdentifier: input.taskIdentifier,
+        deduplicationKey: taskScheduleDeduplicationKey({
+          taskIdentifier: input.taskIdentifier,
+          environmentId: input.environmentId,
+        }),
+        userProvidedDeduplicationKey: false,
+        generatorExpression: cron,
+        generatorDescription: cronstrue.toString(cron),
+        timezone: "UTC",
+        externalId: input.externalId ? input.externalId : undefined,
+        active: true,
+        instances: {
+          create: [
+            {
+              environmentId: input.environmentId,
+              projectId: input.projectId,
+              active: true,
+            },
+          ],
+        },
+      },
+      include: {
+        instances: true,
+      },
+    });
+
+    const instance = schedule.instances.find(
+      (candidate) => candidate.environmentId === input.environmentId
+    );
+
+    if (!instance) {
+      throw new ServiceValidationError("Failed to create schedule instance.");
+    }
+
+    await scheduleEngine.registerNextTaskScheduleInstance({ instanceId: instance.id });
+
+    return {
+      schedule,
+      replacedScheduleIds,
+      requestedTimezone,
+    };
+  }
+
+  public async list(input: ListTaskScopedScheduleInput) {
+    return this._prisma.taskSchedule.findMany({
+      where: {
+        projectId: input.projectId,
+        taskIdentifier: input.taskIdentifier,
+        instances: {
+          some: {
+            environmentId: input.environmentId,
+          },
+        },
+      },
+      orderBy: {
+        createdAt: "desc",
+      },
+    });
+  }
+
+  public async deleteActive(
+    input: DeleteTaskScopedScheduleInput
+  ): Promise<TaskScopedScheduleResult> {
+    const existingActiveSchedules = await this._prisma.taskSchedule.findMany({
+      where: {
+        projectId: input.projectId,
+        taskIdentifier: input.taskIdentifier,
+        active: true,
+        instances: {
+          some: {
+            environmentId: input.environmentId,
+            active: true,
+          },
+        },
+      },
+      orderBy: {
+        createdAt: "desc",
+      },
+      include: {
+        instances: true,
+      },
+    });
+
+    const schedule = existingActiveSchedules[0];
+
+    if (!schedule) {
+      throw new ServiceValidationError(
+        `Task ${input.taskIdentifier} does not have an active schedule in this environment.`
+      );
+    }
+
+    await this._prisma.taskSchedule.update({
+      where: {
+        id: schedule.id,
+      },
+      data: {
+        active: false,
+        instances: {
+          updateMany: {
+            where: {
+              environmentId: input.environmentId,
+            },
+            data: {
+              active: false,
+            },
+          },
+        },
+      },
+    });
+
+    return {
+      schedule: {
+        ...schedule,
+        active: false,
+      },
+      replacedScheduleIds: [],
+      requestedTimezone: schedule.timezone,
+    };
+  }
+}
+
+export const taskScopedScheduleOperationalNotes = {
+  create:
+    "Create a task-scoped schedule and register the first schedule instance with the engine.",
+  update:
+    "Update the task-scoped schedule by creating a replacement schedule and returning replaced ids.",
+  delete:
+    "Deactivate the newest active schedule for the task in the current environment.",
+  timezone:
+    "The requested timezone is preserved in the API response and preview while schedule rows remain normalized.",
+};
diff --git a/internal-packages/schedule-engine/src/engine/taskScopedRegistration.ts b/internal-packages/schedule-engine/src/engine/taskScopedRegistration.ts
new file mode 100644
index 000000000..93a469cb0
--- /dev/null
+++ b/internal-packages/schedule-engine/src/engine/taskScopedRegistration.ts
@@ -0,0 +1,149 @@
+import { PrismaClient } from "@trigger.dev/database";
+import { calculateNextScheduledTimestamp } from "./scheduleCalculation.js";
+
+export type TaskScopedRegistrationInput = {
+  prisma: PrismaClient;
+  projectId: string;
+  environmentId: string;
+  taskIdentifier: string;
+  fromTimestamp?: Date;
+};
+
+export type TaskScopedRegistrationCandidate = {
+  scheduleId: string;
+  scheduleInstanceId: string;
+  cron: string;
+  timezone: string | null;
+  nextRun: Date;
+};
+
+export async function getTaskScopedRegistrationCandidates({
+  prisma,
+  projectId,
+  environmentId,
+  taskIdentifier,
+  fromTimestamp = new Date(),
+}: TaskScopedRegistrationInput): Promise<TaskScopedRegistrationCandidate[]> {
+  const activeSchedules = await prisma.taskSchedule.findMany({
+    where: {
+      projectId,
+      taskIdentifier,
+      active: true,
+      instances: {
+        some: {
+          environmentId,
+          active: true,
+        },
+      },
+    },
+    include: {
+      instances: true,
+    },
+    orderBy: {
+      createdAt: "desc",
+    },
+  });
+
+  return activeSchedules.flatMap((schedule) =>
+    schedule.instances
+      .filter((instance) => instance.environmentId === environmentId && instance.active)
+      .map((instance) => ({
+        scheduleId: schedule.friendlyId,
+        scheduleInstanceId: instance.id,
+        cron: schedule.generatorExpression,
+        timezone: schedule.timezone,
+        nextRun: calculateNextScheduledTimestamp(
+          schedule.generatorExpression,
+          schedule.timezone,
+          fromTimestamp
+        ),
+      }))
+  );
+}
+
+export async function countTaskScopedActiveSchedules({
+  prisma,
+  projectId,
+  environmentId,
+  taskIdentifier,
+}: Omit<TaskScopedRegistrationInput, "fromTimestamp">) {
+  const candidates = await getTaskScopedRegistrationCandidates({
+    prisma,
+    projectId,
+    environmentId,
+    taskIdentifier,
+  });
+
+  return candidates.length;
+}
diff --git a/apps/webapp/app/v3/services/taskScopedSchedule.server.test.ts b/apps/webapp/app/v3/services/taskScopedSchedule.server.test.ts
new file mode 100644
index 000000000..cbb6084ba
--- /dev/null
+++ b/apps/webapp/app/v3/services/taskScopedSchedule.server.test.ts
@@ -0,0 +1,448 @@
+import { describe, expect, it, vi } from "vitest";
+import { prisma } from "~/db.server";
+import { TaskScopedScheduleService } from "./taskScopedSchedule.server";
+import { getTaskScopedRegistrationCandidates } from "@internal/schedule-engine";
+import { createProjectFixture, createScheduledTaskFixture } from "~/test/fixtures/v3";
+
+vi.mock("../scheduleEngine.server", () => ({
+  scheduleEngine: {
+    registerNextTaskScheduleInstance: vi.fn().mockResolvedValue(undefined),
+  },
+}));
+
+describe("TaskScopedScheduleService", () => {
+  it("creates a task-scoped schedule and returns the requested timezone", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "send-report",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    const result = await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "send-report",
+      cron: "0 9 * * *",
+      timezone: "America/Los_Angeles",
+      externalId: "customer-report",
+      replaceExisting: true,
+      source: "create",
+    });
+
+    expect(result.schedule.taskIdentifier).toBe("send-report");
+    expect(result.schedule.generatorExpression).toBe("0 9 * * *");
+    expect(result.requestedTimezone).toBe("America/Los_Angeles");
+    expect(result.schedule.timezone).toBe("UTC");
+    expect(result.schedule.externalId).toBe("customer-report");
+    expect(result.schedule.active).toBe(true);
+    expect(result.schedule.instances).toHaveLength(1);
+  });
+
+  it("normalizes cron whitespace before storing the schedule", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "compact-cron",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    const result = await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "compact-cron",
+      cron: "  15   8   *   *   1-5  ",
+      timezone: "Europe/London",
+      replaceExisting: true,
+      source: "create",
+    });
+
+    expect(result.schedule.generatorExpression).toBe("15 8 * * 1-5");
+    expect(result.requestedTimezone).toBe("Europe/London");
+    expect(result.schedule.timezone).toBe("UTC");
+  });
+
+  it("rejects invalid cron expressions", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "bad-cron",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    await expect(
+      service.upsert({
+        projectId: project.id,
+        environmentId: environment.id,
+        taskIdentifier: "bad-cron",
+        cron: "not a cron",
+        timezone: "UTC",
+        replaceExisting: true,
+        source: "create",
+      })
+    ).rejects.toThrow("Invalid cron expression");
+  });
+
+  it("rejects unknown timezones", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "bad-zone",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    await expect(
+      service.upsert({
+        projectId: project.id,
+        environmentId: environment.id,
+        taskIdentifier: "bad-zone",
+        cron: "0 9 * * *",
+        timezone: "Mars/Olympus",
+        replaceExisting: true,
+        source: "create",
+      })
+    ).rejects.toThrow("Invalid IANA timezone");
+  });
+
+  it("creates a replacement schedule when updating an existing task schedule", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "update-report",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    const first = await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "update-report",
+      cron: "0 9 * * *",
+      timezone: "America/New_York",
+      externalId: "report",
+      replaceExisting: true,
+      source: "create",
+    });
+
+    const second = await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "update-report",
+      cron: "0 10 * * *",
+      timezone: "America/New_York",
+      externalId: "report",
+      replaceExisting: true,
+      source: "update",
+    });
+
+    expect(second.schedule.id).not.toBe(first.schedule.id);
+    expect(second.replacedScheduleIds).toEqual([first.schedule.friendlyId]);
+
+    const activeSchedules = await prisma.taskSchedule.findMany({
+      where: {
+        projectId: project.id,
+        taskIdentifier: "update-report",
+        active: true,
+        instances: {
+          some: {
+            environmentId: environment.id,
+            active: true,
+          },
+        },
+      },
+      include: {
+        instances: true,
+      },
+      orderBy: {
+        createdAt: "asc",
+      },
+    });
+
+    expect(activeSchedules).toHaveLength(2);
+    expect(activeSchedules.map((schedule) => schedule.generatorExpression)).toEqual([
+      "0 9 * * *",
+      "0 10 * * *",
+    ]);
+  });
+
+  it("returns all task-scoped schedule history for the current environment", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "history-report",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "history-report",
+      cron: "0 9 * * *",
+      timezone: "UTC",
+      replaceExisting: true,
+      source: "create",
+    });
+
+    await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "history-report",
+      cron: "0 11 * * *",
+      timezone: "UTC",
+      replaceExisting: true,
+      source: "update",
+    });
+
+    const schedules = await service.list({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "history-report",
+    });
+
+    expect(schedules).toHaveLength(2);
+    expect(schedules.every((schedule) => schedule.active)).toBe(true);
+  });
+
+  it("deletes the newest active task-scoped schedule", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "delete-report",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    const first = await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "delete-report",
+      cron: "0 7 * * *",
+      timezone: "UTC",
+      replaceExisting: true,
+      source: "create",
+    });
+
+    const second = await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "delete-report",
+      cron: "0 8 * * *",
+      timezone: "UTC",
+      replaceExisting: true,
+      source: "update",
+    });
+
+    const deleted = await service.deleteActive({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "delete-report",
+    });
+
+    expect(deleted.schedule.friendlyId).toBe(second.schedule.friendlyId);
+
+    const remainingActive = await prisma.taskSchedule.findMany({
+      where: {
+        projectId: project.id,
+        taskIdentifier: "delete-report",
+        active: true,
+      },
+    });
+
+    expect(remainingActive.map((schedule) => schedule.friendlyId)).toEqual([
+      first.schedule.friendlyId,
+    ]);
+  });
+
+  it("returns registration candidates for every active task-scoped schedule", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "candidate-report",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "candidate-report",
+      cron: "0 9 * * *",
+      timezone: "America/Los_Angeles",
+      replaceExisting: true,
+      source: "create",
+    });
+
+    await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "candidate-report",
+      cron: "0 10 * * *",
+      timezone: "America/Los_Angeles",
+      replaceExisting: true,
+      source: "update",
+    });
+
+    const candidates = await getTaskScopedRegistrationCandidates({
+      prisma,
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "candidate-report",
+      fromTimestamp: new Date("2026-05-16T12:00:00.000Z"),
+    });
+
+    expect(candidates).toHaveLength(2);
+    expect(candidates.map((candidate) => candidate.cron)).toEqual([
+      "0 10 * * *",
+      "0 9 * * *",
+    ]);
+    expect(candidates.every((candidate) => candidate.timezone === "UTC")).toBe(true);
+  });
+
+  it("uses UTC for the engine even when the response preview uses the requested timezone", async () => {
+    const { project, environment } = await createProjectFixture();
+    await createScheduledTaskFixture({
+      projectId: project.id,
+      taskIdentifier: "timezone-report",
+    });
+
+    const service = new TaskScopedScheduleService();
+
+    const result = await service.upsert({
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "timezone-report",
+      cron: "0 9 * * *",
+      timezone: "America/Los_Angeles",
+      replaceExisting: true,
+      source: "create",
+    });
+
+    const response = await import("./taskScopedSchedule.server").then((module) =>
+      module.taskScopedScheduleToResponse(result)
+    );
+
+    expect(response.timezone).toBe("America/Los_Angeles");
+    expect(response.preview.timezone).toBe("America/Los_Angeles");
+
+    const candidates = await getTaskScopedRegistrationCandidates({
+      prisma,
+      projectId: project.id,
+      environmentId: environment.id,
+      taskIdentifier: "timezone-report",
+      fromTimestamp: new Date("2026-05-16T00:00:00.000Z"),
+    });
+
+    expect(candidates).toHaveLength(1);
+    expect(candidates[0].timezone).toBe("UTC");
+    expect(candidates[0].nextRun.toISOString()).toBe("2026-05-16T09:00:00.000Z");
+  });
+});
```

## Intended Flaws

### Flaw 1: The API accepts local timezone semantics but the worker runs the cron as UTC

- Main locations:
  - `packages/trigger-sdk/src/v3/tasks/schedule.ts:31-58`
  - `apps/webapp/app/v3/services/taskScopedSchedule.server.ts:36-64`
  - `apps/webapp/app/v3/services/taskScopedSchedule.server.ts:131-151`
  - `apps/webapp/app/v3/services/taskScopedSchedule.server.test.ts:338-385`
- What is wrong: The SDK and API treat `timezone` as the user's local wall-clock schedule contract. The response preview is computed with `requestedTimezone`. But the service writes `timezone: "UTC"` into the `TaskSchedule` row, and the schedule engine later reads the row timezone to compute actual run times. So `0 9 * * *` with `America/Los_Angeles` is displayed as 9 AM Los Angeles time but registered as 9 AM UTC.
- Why it matters: Customers will schedule jobs at the wrong hour, especially outside UTC and around daylight saving changes. A report expected at 9 AM local time can run in the middle of the night. Worse, the API response says the requested timezone was accepted, making the bug hard to diagnose.
- Better direction: Make timezone an explicit durable contract. Validate the IANA timezone, store it on the schedule row, pass it to the schedule engine, and compute previews from the same persisted data. If the API truly wants UTC-only cron, then reject or ignore `timezone` transparently and document that cron expressions are UTC. Do not display local semantics while executing UTC semantics.

Hints:

1. Compare the timezone used by the preview with the timezone stored on the database row.
2. Find where the schedule engine computes `nextRun`. Which timezone does it read?
3. A user asks for 9 AM Los Angeles. What exact instant will the worker enqueue?

### Flaw 2: Updating the task schedule creates another active schedule instead of replacing the existing one

- Main locations:
  - `apps/webapp/app/v3/services/taskScopedSchedule.server.ts:83-153`
  - `apps/webapp/app/v3/services/taskScopedSchedule.server.ts:167-197`
  - `internal-packages/schedule-engine/src/engine/taskScopedRegistration.ts:24-55`
  - `apps/webapp/app/v3/services/taskScopedSchedule.server.test.ts:137-209`
- What is wrong: The API is task-scoped and says `replaceExisting` defaults to true, but `upsert` always creates a new active `TaskSchedule` with a fresh deduplication key. It records `replacedScheduleIds` in the response without deactivating those schedules or their instances. The worker helper then returns every active matching schedule, so both old and new crons are eligible to fire.
- Why it matters: Updating "daily at 9" to "daily at 10" can run both 9 and 10. The bug can multiply with every edit, causing duplicate task runs, duplicate emails, duplicate billing-affecting work, and confusing audit trails. Tests even assert two active schedules after an update, which locks in the dangerous behavior.
- Better direction: Either update the existing schedule row through the existing `UpsertTaskScheduleService`, or perform replacement in one transaction: find the active task/environment schedule, deactivate its instances, create/update the replacement, and register only the replacement after commit. Add a uniqueness guarantee for "one active task-scoped schedule per task/environment" either with a partial unique index or service-level transactional lock.

Hints:

1. Read the `replaceExisting` wording, then look for the line that deactivates the schedules being "replaced."
2. Search the diff for a unique key that prevents two active schedules for the same task and environment.
3. Follow the worker registration candidate query. How many active schedules can it return after two updates?

## Expert Debrief

### Product-Level Change

The product change is reasonable: many users think "schedule this task" before they think "create an independent schedule resource." A task-scoped convenience API can be a good abstraction if it preserves the lower-level scheduler contracts.

This PR fails because it makes the abstraction look simpler by hiding the two hard parts: timezone semantics and replacement semantics.

### Changed Contracts

This PR changes several contracts:

- Public API contract: tasks now have a task-scoped schedule endpoint.
- SDK contract: clients can call `tasks.schedule.create()` and `tasks.schedule.update()`.
- Time contract: `cron` plus `timezone` should define wall-clock execution.
- Persistence contract: schedule rows are the source of truth for the worker.
- Update contract: `replaceExisting` implies one active schedule after update.
- Worker contract: active schedules are candidates for future runs.

The implementation breaks the time contract and the update contract.

### Failure Modes

Important failure modes reviewers should predict:

- A non-UTC customer schedules `0 9 * * *` and gets 9 AM UTC instead of 9 AM local.
- Daylight saving transitions drift because the worker no longer has the IANA timezone.
- The API response preview shows a different time contract from the worker.
- Every edit adds another active schedule.
- Deleting the "current" schedule only disables the newest schedule, leaving older active schedules behind.
- The same task sends multiple emails, runs multiple report jobs, or bills duplicate downstream work.
- Operations staff cannot tell whether a duplicate run came from retries or duplicate active schedules.

### Reviewer Thought Process

A strong reviewer should ask:

- Is timezone part of input validation only, or does it reach the worker?
- Does the API response describe the same contract the scheduler executes?
- Is this operation truly an upsert, or is it append-only?
- What invariant makes "one active task schedule per environment" true?
- Do tests assert the intended product behavior or encode the bug?
- What happens after the user edits the schedule three times?

The key move is to connect product language like "9 AM local" and "replace existing" to the actual persisted fields and worker queries.

### Better Implementation Direction

A safer implementation would:

1. Reuse `UpsertTaskScheduleService` unless there is a strong reason not to.
2. Require or default timezone explicitly to `UTC` and store that exact value.
3. Compute previews from the persisted cron and timezone, not a request-only timezone.
4. Use `friendlyId` or a stable deduplication key for task/environment replacement.
5. Wrap replacement in a transaction that deactivates old instances before registering the new one.
6. Add a partial unique index or equivalent lock for active task-scoped schedules.
7. Test that updating a schedule leaves exactly one active schedule and that the engine computes next run in the requested IANA timezone.

## Correctness Verdict Rubric

For each flaw, the verifier should mark the learner correct if their answer captures the core issue, even if they use different wording.

### Flaw 1 Rubric

Correct answers should mention:

- The API/SDK accepts or defaults a timezone as if cron is local wall-clock time.
- The service stores `timezone: "UTC"` on the schedule row.
- The schedule engine uses the stored row timezone, so execution differs from preview/API response.
- A better fix is to store and execute the same explicit timezone, or make the endpoint UTC-only with a clear contract.

Partially correct answers may mention only "timezone bug" or "cron interpreted wrong" without explaining the mismatch between response preview and worker execution.

Incorrect answers focus only on cron syntax validation or the fact that UTC exists as a default.

### Flaw 2 Rubric

Correct answers should mention:

- Update/replacement always creates a new active schedule with a fresh deduplication key.
- Replaced schedules are returned but not deactivated.
- The worker can register multiple active schedules for the same task/environment, causing duplicate runs.
- A better fix is transactional update/deactivation plus a uniqueness invariant for one active task-scoped schedule.

Partially correct answers may mention only "duplicate schedules" without tying it to update semantics and worker execution.

Incorrect answers focus only on retaining history; inactive history is fine, active duplicate schedules are the problem.

## Golden Answer Summary

The PR adds a useful task-scoped scheduling API, but it breaks two scheduler fundamentals. First, it accepts a user timezone and computes previews with that timezone while storing the schedule as UTC, so the worker fires at the wrong wall-clock time. Second, "update" and `replaceExisting` create another active schedule instead of replacing or deactivating the old one, so edits can double-fire the same task. The fix is to preserve timezone as a durable scheduler contract and to enforce one active task-scoped schedule per task/environment through the existing upsert service or a transactional replacement path.
