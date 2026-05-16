# TS-006: Trigger.dev Labels For Task Runs

## Metadata

- `id`: TS-006
- `source_repo`: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- `repo_area`: task run schema, trigger service, attempt creation, run list presenters, ClickHouse run replication, public run API
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 602
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about run identity, attempt identity, filtering, retry behavior, and storage limits without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds labels to task runs.

Customers can attach labels such as `customer:acme`, `import`, `priority`, or `region:eu` when triggering a task. Labels appear in run list/detail responses and can be added later through a new API endpoint. The dashboard can filter runs by label.

The PR adds:

- a `labels` option to task trigger requests,
- labels on run attempts,
- label support in the run list and retrieve presenters,
- a `POST /api/v1/runs/:runId/labels` endpoint,
- ClickHouse replication so labels can be queried efficiently,
- tests for creating, listing, filtering, and adding labels.

## Existing Code Context

The real Trigger.dev codebase already has these relevant contracts:

- `internal-packages/database/prisma/schema.prisma` models `TaskRun` as the durable run and `TaskRunAttempt` as individual execution attempts for that run.
- `TaskRun` already has run-level tags: a `tags TaskRunTag[]` relation plus a denormalized `runTags String[]` column.
- `apps/webapp/app/models/taskRunTag.server.ts` defines `MAX_TAGS_PER_RUN = 10`.
- `apps/webapp/app/runEngine/validators/triggerTaskValidator.ts` rejects trigger requests that exceed the maximum run tag count.
- `apps/webapp/app/runEngine/services/triggerTask.server.ts` normalizes trigger request tags and passes them into the run engine as run-level data.
- `apps/webapp/app/routes/api.v1.runs.$runId.tags.ts` adds tags to a run by updating `TaskRun.runTags`, scoped by the authenticated runtime environment.
- `internal-packages/clickhouse/schema/004_create_task_runs_v2.sql` stores run tags in the `task_runs_v2.tags` array and adds a token bloom filter index for tag filtering.
- `apps/webapp/app/services/runsReplicationService.server.ts` replicates `run.runTags` into ClickHouse, and `clickhouseRunsRepository.server.ts` filters with `hasAny(tags, ...)`.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `internal-packages/database/prisma/schema.prisma`
- `internal-packages/database/prisma/migrations/20260502093000_add_task_run_labels/migration.sql`
- `internal-packages/clickhouse/schema/032_add_task_run_labels.sql`
- `packages/core/src/v3/schemas/tasks.ts`
- `apps/webapp/app/runEngine/types.ts`
- `apps/webapp/app/runEngine/validators/triggerTaskValidator.ts`
- `apps/webapp/app/runEngine/services/triggerTask.server.ts`
- `apps/webapp/app/v3/services/createTaskRunAttempt.server.ts`
- `apps/webapp/app/routes/api.v1.runs.$runId.labels.ts`
- `apps/webapp/app/presenters/v3/ApiRunListPresenter.server.ts`
- `apps/webapp/app/services/runsReplicationService.server.ts`
- `apps/webapp/app/services/runsRepository/clickhouseRunsRepository.server.ts`
- `apps/webapp/test/runLabels.test.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally focused on the backend/data contract and is over the 500-line threshold.

## Diff

```diff
diff --git a/internal-packages/database/prisma/schema.prisma b/internal-packages/database/prisma/schema.prisma
index 0d26f0fb11..7b1b47af9d 100644
--- a/internal-packages/database/prisma/schema.prisma
+++ b/internal-packages/database/prisma/schema.prisma
@@ -922,6 +922,7 @@ model TaskRun {
   attempts TaskRunAttempt[] @relation("attempts")
   tags     TaskRunTag[]
 
   /// Denormized column that holds the raw tags
   runTags String[]
+  labels  String[] @default([])
 
   /// Denormalized version of the background worker task
   taskVersion String?
@@ -1641,6 +1642,9 @@ model TaskRunAttempt {
   output     String?
   outputType String  @default("application/json")
 
+  /// User-provided labels copied from trigger options for dashboard filtering.
+  labels String[] @default([])
+
   dependencies      TaskRunDependency[]
   batchDependencies BatchTaskRun[]
 
@@ -1654,6 +1658,7 @@ model TaskRunAttempt {
 
   @@unique([taskRunId, number])
   @@index([taskRunId])
+  @@index([labels])
 }
diff --git a/internal-packages/database/prisma/migrations/20260502093000_add_task_run_labels/migration.sql b/internal-packages/database/prisma/migrations/20260502093000_add_task_run_labels/migration.sql
new file mode 100644
index 0000000000..de1f0a34e8
--- /dev/null
+++ b/internal-packages/database/prisma/migrations/20260502093000_add_task_run_labels/migration.sql
@@ -0,0 +1,38 @@
+-- Add labels to task runs and attempts.
+ALTER TABLE "TaskRun"
+  ADD COLUMN IF NOT EXISTS "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
+
+ALTER TABLE "TaskRunAttempt"
+  ADD COLUMN IF NOT EXISTS "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
+
+CREATE INDEX IF NOT EXISTS "TaskRun_labels_idx"
+  ON "TaskRun" USING GIN ("labels");
+
+CREATE INDEX IF NOT EXISTS "TaskRunAttempt_labels_idx"
+  ON "TaskRunAttempt" USING GIN ("labels");
+
+-- Backfill labels from existing run tags so the dashboard can use one filter UI.
+UPDATE "TaskRun"
+SET "labels" = "runTags"
+WHERE cardinality("labels") = 0
+  AND cardinality("runTags") > 0;
+
+-- Copy current run labels onto every existing attempt.
+UPDATE "TaskRunAttempt" a
+SET "labels" = r."labels"
+FROM "TaskRun" r
+WHERE a."taskRunId" = r."id"
+  AND cardinality(a."labels") = 0
+  AND cardinality(r."labels") > 0;
diff --git a/internal-packages/clickhouse/schema/032_add_task_run_labels.sql b/internal-packages/clickhouse/schema/032_add_task_run_labels.sql
new file mode 100644
index 0000000000..2d3b2c4c18
--- /dev/null
+++ b/internal-packages/clickhouse/schema/032_add_task_run_labels.sql
@@ -0,0 +1,28 @@
+-- +goose Up
+ALTER TABLE trigger_dev.task_runs_v2
+  ADD COLUMN IF NOT EXISTS labels Array(String) CODEC(ZSTD(1)) AFTER tags;
+
+ALTER TABLE trigger_dev.task_runs_v2
+  ADD INDEX IF NOT EXISTS idx_labels labels TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;
+
+-- Keep existing dashboards working by treating tags as labels until new writes arrive.
+ALTER TABLE trigger_dev.task_runs_v2
+  UPDATE labels = tags
+  WHERE length(labels) = 0
+    AND length(tags) > 0;
+
+-- +goose Down
+ALTER TABLE trigger_dev.task_runs_v2
+  DROP INDEX IF EXISTS idx_labels;
+
+ALTER TABLE trigger_dev.task_runs_v2
+  DROP COLUMN IF EXISTS labels;
diff --git a/packages/core/src/v3/schemas/tasks.ts b/packages/core/src/v3/schemas/tasks.ts
index 12f78176af..25011ae774 100644
--- a/packages/core/src/v3/schemas/tasks.ts
+++ b/packages/core/src/v3/schemas/tasks.ts
@@ -43,6 +43,15 @@ export const TriggerTaskOptions = z.object({
   tags: z
     .union([z.string(), z.array(z.string())])
     .optional(),
+  labels: z
+    .union([z.string(), z.array(z.string())])
+    .optional()
+    .describe(
+      "Labels are shown in the dashboard and can be used to filter runs."
+    ),
   delay: z.string().or(z.number()).optional(),
   ttl: z.string().or(z.number()).optional(),
   idempotencyKey: z.string().optional(),
@@ -91,6 +100,7 @@ export type TriggerTaskOptions = z.infer<typeof TriggerTaskOptions>
 export const BatchTriggerTaskOptions = TriggerTaskOptions.extend({
   idempotencyKey: z.never().optional(),
   idempotencyKeyOptions: z.never().optional(),
+  labels: z.union([z.string(), z.array(z.string())]).optional(),
 })
diff --git a/apps/webapp/app/runEngine/types.ts b/apps/webapp/app/runEngine/types.ts
index 9272dc9170..b337b67f20 100644
--- a/apps/webapp/app/runEngine/types.ts
+++ b/apps/webapp/app/runEngine/types.ts
@@ -79,6 +79,7 @@ export type TriggerTaskRequestBody = {
     queue?: {
       name?: string
     }
+    labels?: string[] | string
     tags?: string[] | string
     test?: boolean
     delay?: string | number
@@ -142,6 +143,7 @@ export type TriggerTaskValidator = {
   validateTags(params: TagValidationParams): ValidationResult
+  validateLabels(params: LabelValidationParams): ValidationResult
   validateMaxAttempts(params: MaxAttemptsValidationParams): ValidationResult
   validateParentRun(params: ParentRunValidationParams): ValidationResult
   validateEntitlement(params: EntitlementValidationParams): Promise<EntitlementValidationResult>
@@ -157,6 +159,10 @@ export type TagValidationParams = {
   tags?: string[] | string
 }
 
+export type LabelValidationParams = {
+  labels?: string[] | string
+}
+
 export type ValidationResult =
   | {
       ok: true
diff --git a/apps/webapp/app/runEngine/validators/triggerTaskValidator.ts b/apps/webapp/app/runEngine/validators/triggerTaskValidator.ts
index 83271ad2f4..5a87106329 100644
--- a/apps/webapp/app/runEngine/validators/triggerTaskValidator.ts
+++ b/apps/webapp/app/runEngine/validators/triggerTaskValidator.ts
@@ -6,6 +6,7 @@ import type {
   EntitlementValidationResult,
   MaxAttemptsValidationParams,
   ParentRunValidationParams,
+  LabelValidationParams,
   TagValidationParams,
   TriggerTaskValidator,
   ValidationResult,
@@ -35,6 +36,24 @@ export class DefaultTriggerTaskValidator implements TriggerTaskValidator {
 
     return { ok: true };
   }
+
+  validateLabels(params: LabelValidationParams): ValidationResult {
+    const { labels } = params;
+
+    if (!labels) {
+      return { ok: true };
+    }
+
+    const normalizedLabels =
+      typeof labels === "string" ? [labels] : labels;
+
+    if (normalizedLabels.some((label) => label.trim().length === 0)) {
+      return {
+        ok: false,
+        error: new ServiceValidationError("Labels cannot be empty."),
+      };
+    }
+
+    return { ok: true };
+  }
 
   async validateEntitlement(
     params: EntitlementValidationParams
diff --git a/apps/webapp/app/runEngine/services/triggerTask.server.ts b/apps/webapp/app/runEngine/services/triggerTask.server.ts
index 8319f893ce..73616ba8e2 100644
--- a/apps/webapp/app/runEngine/services/triggerTask.server.ts
+++ b/apps/webapp/app/runEngine/services/triggerTask.server.ts
@@ -123,6 +123,14 @@ export class RunEngineTriggerTaskService {
         throw tagValidation.error;
       }
 
+      const labelValidation = this.validator.validateLabels({
+        labels: body.options?.labels,
+      });
+
+      if (!labelValidation.ok) {
+        throw labelValidation.error;
+      }
+
       // Validate entitlement (unless skipChecks is enabled)
       let planType: string | undefined;
 
@@ -288,6 +296,13 @@ export class RunEngineTriggerTaskService {
           : []
       ).filter((tag) => tag.trim().length > 0);
 
+      const labels = (
+        body.options?.labels
+          ? typeof body.options.labels === "string"
+            ? [body.options.labels]
+            : body.options.labels
+          : []
+      ).filter((label) => label.trim().length > 0);
+
       const depth = parentRun ? parentRun.depth + 1 : 0;
 
       const workerQueueResult = await this.queueConcern.getWorkerQueue(
@@ -360,6 +375,7 @@ export class RunEngineTriggerTaskService {
                 maxAttempts: body.options?.maxAttempts,
                 taskEventStore: store,
                 ttl,
+                labels,
                 tags,
                 oneTimeUseToken: options.oneTimeUseToken,
                 parentTaskRunId: parentRun?.id,
diff --git a/apps/webapp/app/v3/services/createTaskRunAttempt.server.ts b/apps/webapp/app/v3/services/createTaskRunAttempt.server.ts
index 173e074915..c5f7f9a7e1 100644
--- a/apps/webapp/app/v3/services/createTaskRunAttempt.server.ts
+++ b/apps/webapp/app/v3/services/createTaskRunAttempt.server.ts
@@ -31,6 +31,7 @@ export type CreateTaskRunAttemptOptions = {
   taskRunId: string
   backgroundWorkerId: string
   backgroundWorkerTaskId: string
+  labels?: string[]
   queueId: string
   runtimeEnvironmentId: string
   isWarmStart?: boolean
@@ -174,6 +175,7 @@ export class CreateTaskRunAttemptService {
         taskRunId,
         backgroundWorkerId,
         backgroundWorkerTaskId,
+        labels,
         queueId,
         runtimeEnvironmentId,
       } = options;
@@ -239,6 +241,7 @@ export class CreateTaskRunAttemptService {
           runtimeEnvironmentId,
           queueId,
           status: "PENDING",
+          labels: labels ?? [],
         },
       });
 
@@ -261,6 +264,7 @@ export class CreateTaskRunAttemptService {
         attempt: {
           id: attempt.friendlyId,
           number: attempt.number,
+          labels: attempt.labels,
           status: attempt.status,
         },
       },
diff --git a/apps/webapp/app/routes/api.v1.runs.$runId.labels.ts b/apps/webapp/app/routes/api.v1.runs.$runId.labels.ts
new file mode 100644
index 0000000000..f55194a9ce
--- /dev/null
+++ b/apps/webapp/app/routes/api.v1.runs.$runId.labels.ts
@@ -0,0 +1,137 @@
+import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
+import { z } from "zod";
+import { prisma } from "~/db.server";
+import { authenticateApiRequest } from "~/services/apiAuth.server";
+import { logger } from "~/services/logger.server";
+
+const ParamsSchema = z.object({
+  runId: z.string(),
+});
+
+const BodySchema = z.object({
+  labels: z.union([z.string(), z.array(z.string())]),
+});
+
+const normalizeLabels = (input: string | string[]) => {
+  const labels = typeof input === "string" ? [input] : input;
+  const seen = new Set<string>();
+  const normalized: string[] = [];
+
+  for (const label of labels) {
+    const trimmed = label.trim();
+    if (!trimmed || seen.has(trimmed)) {
+      continue;
+    }
+
+    seen.add(trimmed);
+    normalized.push(trimmed);
+  }
+
+  return normalized;
+};
+
+export async function action({ request, params }: ActionFunctionArgs) {
+  if (request.method.toUpperCase() !== "POST") {
+    return json({ error: "Method Not Allowed" }, { status: 405 });
+  }
+
+  const authenticationResult = await authenticateApiRequest(request);
+  if (!authenticationResult) {
+    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
+  }
+
+  const parsedParams = ParamsSchema.safeParse(params);
+  if (!parsedParams.success) {
+    return json(
+      { error: "Invalid request parameters", issues: parsedParams.error.issues },
+      { status: 400 }
+    );
+  }
+
+  try {
+    const anyBody = await request.json();
+    const body = BodySchema.safeParse(anyBody);
+
+    if (!body.success) {
+      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
+    }
+
+    const labels = normalizeLabels(body.data.labels);
+
+    const run = await prisma.taskRun.findFirst({
+      where: {
+        friendlyId: parsedParams.data.runId,
+        runtimeEnvironmentId: authenticationResult.environment.id,
+      },
+      select: {
+        id: true,
+        labels: true,
+        attempts: {
+          orderBy: {
+            number: "desc",
+          },
+          take: 1,
+          select: {
+            id: true,
+            labels: true,
+          },
+        },
+      },
+    });
+
+    if (!run) {
+      return json({ error: "Run not found" }, { status: 404 });
+    }
+
+    const latestAttempt = run.attempts[0];
+    if (!latestAttempt) {
+      return json({ error: "Run has not started yet" }, { status: 409 });
+    }
+
+    const nextLabels = Array.from(
+      new Set([...(latestAttempt.labels ?? []), ...labels])
+    );
+
+    await prisma.taskRunAttempt.update({
+      where: {
+        id: latestAttempt.id,
+      },
+      data: {
+        labels: nextLabels,
+      },
+    });
+
+    await prisma.taskRun.update({
+      where: {
+        id: run.id,
+      },
+      data: {
+        labels: nextLabels,
+      },
+    });
+
+    return json(
+      {
+        labels: nextLabels,
+        message: `Successfully set ${labels.length} labels.`,
+      },
+      { status: 200 }
+    );
+  } catch (error) {
+    logger.error("Failed to add run labels", { error });
+    return json({ error: "Something went wrong, please try again." }, { status: 500 });
+  }
+}
diff --git a/apps/webapp/app/presenters/v3/ApiRunListPresenter.server.ts b/apps/webapp/app/presenters/v3/ApiRunListPresenter.server.ts
index 0e216a078e..1397fd2d28 100644
--- a/apps/webapp/app/presenters/v3/ApiRunListPresenter.server.ts
+++ b/apps/webapp/app/presenters/v3/ApiRunListPresenter.server.ts
@@ -46,6 +46,7 @@ type ApiRunListOptions = {
   statuses?: string[]
   tasks?: string[]
   tags?: string[]
+  labels?: string[]
   versions?: string[]
   from?: number
   to?: number
@@ -216,6 +217,10 @@ export class ApiRunListPresenter {
       if (searchParams["filter[tag]"]) {
         options.tags = searchParams["filter[tag]"];
       }
+
+      if (searchParams["filter[label]"]) {
+        options.labels = searchParams["filter[label]"];
+      }
 
       const { runs, pagination } = await runsRepository.listRuns({
         organizationId,
@@ -310,6 +315,7 @@ export class ApiRunListPresenter {
             env: {
               id: run.environment.id,
               name: run.environment.slug,
             },
             tags: run.tags,
+            labels: run.labels,
             costInCents: run.costInCents,
             baseCostInCents: run.baseCostInCents,
             durationMs: run.usageDurationMs,
diff --git a/apps/webapp/app/services/runsReplicationService.server.ts b/apps/webapp/app/services/runsReplicationService.server.ts
index 2c91df606d..2c14c8e723 100644
--- a/apps/webapp/app/services/runsReplicationService.server.ts
+++ b/apps/webapp/app/services/runsReplicationService.server.ts
@@ -846,6 +846,15 @@ export class RunsReplicationService {
       },
     });
 
+    const latestAttempt = await this.prisma.taskRunAttempt.findFirst({
+      where: {
+        taskRunId: run.id,
+      },
+      orderBy: {
+        number: "desc",
+      },
+    });
+
     const annotations = this.#parseAnnotations(run.annotations);
 
     // Return array matching TASK_RUN_COLUMNS order
@@ -900,6 +909,7 @@ export class RunsReplicationService {
       output, // output
       errorData, // error
       errorFingerprint, // error_fingerprint
       run.runTags ?? [], // tags
+      latestAttempt?.labels ?? [], // labels
       run.taskVersion ?? "", // task_version
       run.sdkVersion ?? "", // sdk_version
       run.cliVersion ?? "", // cli_version
diff --git a/apps/webapp/app/services/runsRepository/clickhouseRunsRepository.server.ts b/apps/webapp/app/services/runsRepository/clickhouseRunsRepository.server.ts
index 6c9817d980..c938af3519 100644
--- a/apps/webapp/app/services/runsRepository/clickhouseRunsRepository.server.ts
+++ b/apps/webapp/app/services/runsRepository/clickhouseRunsRepository.server.ts
@@ -52,6 +52,7 @@ export type ListRunsOptions = {
   versions?: string[]
   statuses?: string[]
   tags?: string[]
+  labels?: string[]
   queues?: string[]
   regions?: string[]
   period?: number
@@ -271,6 +272,10 @@ export class ClickHouseRunsRepository {
     queryBuilder.where("hasAny(tags, {tags: Array(String)})", { tags: options.tags });
   }
 
+  if (options.labels && options.labels.length > 0) {
+    queryBuilder.where("hasAny(labels, {labels: Array(String)})", { labels: options.labels });
+  }
+
   if (options.scheduleId) {
     queryBuilder.where("schedule_id = {scheduleId: String}", { scheduleId: options.scheduleId });
   }
@@ -514,6 +519,7 @@ export class ClickHouseRunsRepository {
       "ttl",
       "status",
       "tags",
+      "labels",
       "task_kind",
       "machine_preset",
       "created_at",
diff --git a/apps/webapp/test/runLabels.test.ts b/apps/webapp/test/runLabels.test.ts
new file mode 100644
index 0000000000..6d285c50a1
--- /dev/null
+++ b/apps/webapp/test/runLabels.test.ts
@@ -0,0 +1,173 @@
+import { describe, expect, it } from "vitest";
+import { DefaultTriggerTaskValidator } from "~/runEngine/validators/triggerTaskValidator";
+import { createTestRun, createTestRunAttempt } from "./helpers/runs";
+import { prisma } from "~/db.server";
+
+describe("run labels", () => {
+  it("accepts labels on trigger options", () => {
+    const validator = new DefaultTriggerTaskValidator();
+
+    const result = validator.validateLabels({
+      labels: ["customer:acme", "import"],
+    });
+
+    expect(result.ok).toBe(true);
+  });
+
+  it("rejects empty labels", () => {
+    const validator = new DefaultTriggerTaskValidator();
+
+    const result = validator.validateLabels({
+      labels: ["customer:acme", ""],
+    });
+
+    expect(result.ok).toBe(false);
+  });
+
+  it("stores labels on the current attempt", async () => {
+    const run = await createTestRun({
+      labels: ["customer:acme"],
+    });
+
+    const attempt = await createTestRunAttempt({
+      taskRunId: run.id,
+      labels: ["customer:acme"],
+    });
+
+    expect(attempt.labels).toEqual(["customer:acme"]);
+  });
+
+  it("adds labels through the run labels API", async () => {
+    const run = await createTestRun({
+      labels: [],
+    });
+    await createTestRunAttempt({
+      taskRunId: run.id,
+      labels: [],
+    });
+
+    await prisma.taskRun.update({
+      where: {
+        id: run.id,
+      },
+      data: {
+        labels: ["import"],
+      },
+    });
+
+    const attempt = await prisma.taskRunAttempt.findFirstOrThrow({
+      where: {
+        taskRunId: run.id,
+      },
+      orderBy: {
+        number: "desc",
+      },
+    });
+
+    await prisma.taskRunAttempt.update({
+      where: {
+        id: attempt.id,
+      },
+      data: {
+        labels: ["import"],
+      },
+    });
+
+    const updated = await prisma.taskRun.findUniqueOrThrow({
+      where: {
+        id: run.id,
+      },
+      include: {
+        attempts: true,
+      },
+    });
+
+    expect(updated.labels).toEqual(["import"]);
+    expect(updated.attempts[0].labels).toEqual(["import"]);
+  });
+
+  it("uses latest attempt labels for replication", async () => {
+    const run = await createTestRun({
+      labels: ["customer:acme"],
+    });
+
+    await createTestRunAttempt({
+      taskRunId: run.id,
+      number: 1,
+      labels: ["customer:acme"],
+    });
+
+    await createTestRunAttempt({
+      taskRunId: run.id,
+      number: 2,
+      labels: ["retry"],
+    });
+
+    const latestAttempt = await prisma.taskRunAttempt.findFirstOrThrow({
+      where: {
+        taskRunId: run.id,
+      },
+      orderBy: {
+        number: "desc",
+      },
+    });
+
+    expect(latestAttempt.labels).toEqual(["retry"]);
+  });
+});
```

## Intended Flaws

### Flaw 1: Labels Are Stored On Attempts Instead Of The Durable Run Contract

- `type`: `invariant_drift`
- `location`: `internal-packages/database/prisma/schema.prisma:1642-1659`, `apps/webapp/app/v3/services/createTaskRunAttempt.server.ts:31-264`, `apps/webapp/app/routes/api.v1.runs.$runId.labels.ts:58-115`, `apps/webapp/app/services/runsReplicationService.server.ts:846-910`, `apps/webapp/test/runLabels.test.ts:82-117`
- `learner_prompt`: Should labels belong to `TaskRunAttempt`, or to the task run?

Expected answer:

- `identify`: The PR makes labels an attempt-level concept and then tries to mirror latest-attempt labels back onto `TaskRun`. Trigger request labels describe the run the customer triggered, not a particular retry attempt. The labels API updates only the latest attempt and the denormalized run copy, while ClickHouse replication reads `latestAttempt?.labels`. A retry can therefore replace or drop labels even though the run identity did not change.
- `impact`: Run list filters become unstable across retries. A run can appear under `customer:acme` on attempt 1, disappear on attempt 2, and reappear if another API call updates the latest attempt. Replays, retries, parent/child views, realtime subscriptions, billing/debug reports, and ClickHouse analytics now disagree about the same run. The product teaches users that labels are run metadata, but the implementation stores them on transient execution attempts.
- `fix_direction`: Put labels on `TaskRun` as the source of truth, or better, reuse/extend the existing run-level tags contract (`TaskRun.runTags` and `TaskRunTag`) if labels are just another run filter. Attempt labels should exist only as explicit attempt-scoped diagnostics with a separate name and API. Replication and filtering should read from the durable run-level column/relation, not the latest attempt.

Hints:

1. Ask what object the user thinks they are labeling: the run or one retry attempt.
2. Follow one run through attempt 1, attempt 2, and ClickHouse replication.
3. The danger is the `latestAttempt?.labels` read and the API update to `taskRunAttempt`, not the existence of labels alone.

### Flaw 2: Label Count And Size Are Unbounded

- `type`: `performance_regression`
- `location`: `packages/core/src/v3/schemas/tasks.ts:43-101`, `apps/webapp/app/runEngine/validators/triggerTaskValidator.ts:36-59`, `apps/webapp/app/routes/api.v1.runs.$runId.labels.ts:10-29`, `internal-packages/clickhouse/schema/032_add_task_run_labels.sql:1-12`, `apps/webapp/test/runLabels.test.ts:5-23`
- `learner_prompt`: What protects the database, ClickHouse indexes, API responses, and dashboard filters from huge label payloads?

Expected answer:

- `identify`: The validators only reject empty labels. They do not cap label count, label length, total payload size, or normalized duplicates. The public API endpoint accepts arbitrary arrays of arbitrary strings and writes them into Postgres arrays, then replication indexes them in ClickHouse. Existing run tags already have `MAX_TAGS_PER_RUN = 10`, but labels do not reuse that limit or introduce a label-specific one.
- `impact`: A customer or bug can attach thousands of labels or very large strings to a run. That bloats Postgres rows, API responses, ClickHouse replication payloads, token bloom filter indexes, dashboard filter queries, and realtime payloads. It also creates cost and latency surprises in a high-volume task system where labels are copied into every listed run.
- `fix_direction`: Define explicit limits at the shared schema/service boundary: maximum labels per run, maximum label length, allowed characters or UTF-8 byte size, normalization rules, and dedupe behavior. Reuse the tag limit if labels are the same product concept. Add tests for too many labels, long labels, duplicate/case-normalized labels, API add-label limits, and trigger-time validation.

Hints:

1. Compare label validation with existing run tag validation.
2. Think like an ingestion reviewer: every label is replicated, indexed, queried, and returned.
3. The validator says "not empty" but never says "how many" or "how large."

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the run-versus-attempt modeling error. Answers that only say "there is duplicated data" are incomplete unless they explain why retries/latest attempts make labels unstable for a run-level product feature.

For flaw 2, a correct answer must identify the missing bounds on label count and size. Answers that only say "validate input" are incomplete unless they connect validation to storage, ClickHouse indexing, list APIs, and high-volume run ingestion.

### Product-Level Change

The PR tries to help users classify runs for filtering and analytics. That is a useful workflow: teams want to find all runs for a customer, import, region, or priority. But the product promise is "this run has these labels," not "this particular execution attempt currently has these labels."

### Changed Contracts

- Trigger request contract: `options.labels` becomes accepted input.
- Data contract: labels are added to both `TaskRun` and `TaskRunAttempt`.
- API contract: run list/detail responses and a new add-label endpoint expose labels.
- Analytics contract: ClickHouse gains a replicated `labels` array and filter support.
- Retry contract: attempts can now disagree about labels for the same run.
- Storage contract: labels become indexed, replicated, and returned without defined size limits.

### Failure Modes

A customer triggers a run with `customer:acme`. The first attempt fails. The retry attempt is created without labels, or with `retry` copied from a worker-local path. The run now vanishes from `filter[label]=customer:acme` even though it is still the same customer run.

Another customer accidentally sends 2,000 labels in a batch trigger. The app accepts it, Postgres stores it, ClickHouse indexes it, and every run list response now carries a huge array. A feature meant to make filtering easier becomes a storage and query-cost multiplier.

### Reviewer Thought Process

A strong reviewer starts by naming the domain object. Trigger.dev has runs and attempts; attempts are execution tries, while runs are the durable customer-facing unit. Labels used for filtering, analytics, API responses, and customer context should follow the run, not the latest attempt.

The second move is to compare with an existing similar feature. The codebase already has run tags, a maximum tag count, ClickHouse tag storage, and run-list filters. That existing contract is strong evidence that this PR should either reuse tags or deliberately explain why labels are different.

### Better Implementation Direction

Treat labels as bounded run-level metadata:

- Decide whether labels are just a renamed/expanded version of existing run tags.
- Store source-of-truth labels on `TaskRun` or the existing tag relation.
- Keep attempt-scoped labels separate and explicit if needed for retry diagnostics.
- Enforce shared limits at trigger-time and add-label-time.
- Replicate the run-level labels to ClickHouse.
- Add tests for retries preserving labels, replay semantics, API add-label limits, and high-cardinality rejection.

## Why This Case Exists

This case trains two everyday review instincts: put state on the durable object that owns the product contract, and bound every user-controlled field that gets indexed, replicated, filtered, or returned on hot paths.
