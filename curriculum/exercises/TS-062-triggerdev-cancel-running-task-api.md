# TS-062: Trigger.dev Cancel Running Task API

## Metadata

- `id`: TS-062
- `source_repo`: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- `repo_area`: v3 run engine, run cancellation service, coordinator socket messages, task attempt finalization, retry scheduling, Redis/MarQS queue contracts, SDK run API
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 1,950-2,450
- `represented_diff_lines`: 1992
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about cancellation semantics, retry races, worker/coordinator boundaries, terminal run states, queue re-enqueue behavior, and SDK contract design without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a v3 API and SDK method for cancelling a running Trigger.dev task run. Users can call `runs.cancel(runId)` from the SDK or use the new API endpoint from the dashboard. The PR claims to make cancellation idempotent, record timeline/audit events, update the current attempt, and make cancellation visible immediately in run detail pages.

The PR adds:

- a new `POST /api/v3/runs/:runId/cancel` route,
- a `CancelRunningTaskRunService`,
- a cancellation table and audit event writer,
- SDK support for `runs.cancel`,
- retry-scheduler integration,
- metrics and docs,
- tests for executing runs, already-final runs, SDK calls, and retry scheduling.

The intended product behavior is: once a user cancels a run, no later worker completion or retry callback should resurrect that run, and any currently executing worker should receive a cancellation signal so user code and external activity stop as promptly as the platform can enforce.

## Existing Code Context

The real Trigger.dev codebase already has these relevant contracts:

- `CancelTaskRunService` delegates v2 cancellation to `engine.cancelRun` and v1 cancellation to `CancelTaskRunServiceV1`.
- `CancelTaskRunServiceV1` finalizes the run, records a cancel event, cancels cancellable attempts, and emits `REQUEST_RUN_CANCELLATION` through the coordinator namespace for production workers.
- The coordinator handles `REQUEST_RUN_CANCELLATION` by locating the run socket, cancelling any checkpoint, and emitting a worker exit request.
- `CompleteAttemptService` explicitly avoids retrying a task run that is already in a final run state.
- Retry scheduling can requeue the same run through MarQS or enqueue a lazy retry attempt through `RetryAttemptService`.
- The run engine has heartbeat timeouts for `PENDING_CANCEL`, `EXECUTING`, and related states, which means cancellation is a state machine transition, not just a database write.
- The Redis worker queue has an optional cancellation key concept for preventing cancelled work from being enqueued later.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether the implementation preserves the run lifecycle contract under retries and whether it actually stops executing work.

## Review Surface

Changed files in the synthetic PR:

- `apps/webapp/app/routes/api.v3.runs.$runId.cancel.ts`
- `apps/webapp/app/v3/services/cancelRunningTaskRun.types.ts`
- `apps/webapp/app/v3/services/cancelRunningTaskRun.server.ts`
- `apps/webapp/app/v3/services/cancelRunCoordinatorClient.server.ts`
- `apps/webapp/app/v3/services/cancelAwareRetryScheduler.server.ts`
- `apps/webapp/app/v3/services/runCancellationRepository.server.ts`
- `packages/trigger-sdk/src/v3/runs.ts`
- `apps/webapp/prisma/migrations/20260516090000_task_run_cancellations.ts`
- `apps/webapp/app/v3/services/cancelRunningTaskRun.test.ts`
- `apps/webapp/app/v3/services/cancelAwareRetryScheduler.test.ts`
- `apps/webapp/app/v3/services/cancellationMetrics.server.ts`
- `apps/webapp/app/v3/services/runCancellationAudit.server.ts`
- `docs/runs/cancel-running-runs.md`

The line references below use synthetic PR line numbers. The represented diff is focused on cancellation state transitions, retry scheduling, and worker signal propagation.

## Diff

```diff
diff --git a/apps/webapp/app/routes/api.v3.runs.$runId.cancel.ts b/apps/webapp/app/routes/api.v3.runs.$runId.cancel.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/apps/webapp/app/routes/api.v3.runs.$runId.cancel.ts
@@ -0,0 +1,89 @@
+import { json } from "@remix-run/server-runtime";
+import { z } from "zod";
+import { RunId } from "@trigger.dev/core/v3/isomorphic";
+import { prisma } from "~/db.server";
+import { requireUserId } from "~/services/session.server";
+import { logger } from "~/services/logger.server";
+import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
+import { CancelRunningTaskRunService } from "~/v3/services/cancelRunningTaskRun.server";
+
+const CancelRunRequestBody = z.object({
+  runId: z.string().min(1),
+  reason: z.string().trim().min(1).max(500).optional(),
+  force: z.boolean().default(false),
+  cancelQueuedChildren: z.boolean().default(true),
+});
+
+const { action } = createActionApiRoute(
+  {
+    body: CancelRunRequestBody,
+    maxContentLength: 1024 * 8,
+    method: "POST",
+  },
+  async ({ authentication, body, request }) => {
+    const actorUserId = await requireUserId(request);
+    const runId = RunId.toId(body.runId);
+
+    const run = await prisma.taskRun.findFirst({
+      where: {
+        id: runId,
+        runtimeEnvironmentId: authentication.environment.id,
+      },
+      select: {
+        id: true,
+        friendlyId: true,
+        status: true,
+        engine: true,
+        taskIdentifier: true,
+        taskEventStore: true,
+        runtimeEnvironmentId: true,
+        lockedById: true,
+        lockedToVersionId: true,
+        lockedToVersion: {
+          select: { supportsLazyAttempts: true },
+        },
+        attempts: {
+          orderBy: { number: "desc" },
+          take: 1,
+          select: {
+            id: true,
+            friendlyId: true,
+            status: true,
+            number: true,
+            backgroundWorkerId: true,
+          },
+        },
+      },
+    });
+
+    if (!run) {
+      return json({ error: "Run not found" }, { status: 404 });
+    }
+
+    const service = new CancelRunningTaskRunService(prisma);
+    const result = await service.call({
+      run,
+      reason: body.reason ?? "Cancelled by user",
+      force: body.force,
+      cancelQueuedChildren: body.cancelQueuedChildren,
+      actorUserId,
+    });
+
+    logger.info("Cancel run API completed", {
+      runId: run.id,
+      friendlyId: run.friendlyId,
+      previousStatus: run.status,
+      nextStatus: result.status,
+      actorUserId,
+    });
+
+    return json({
+      id: result.friendlyId,
+      status: result.status,
+      cancelledAt: result.cancelledAt.toISOString(),
+      alreadyFinal: result.alreadyFinal,
+    });
+  }
+);
+
+export { action };
diff --git a/apps/webapp/app/v3/services/cancelRunningTaskRun.types.ts b/apps/webapp/app/v3/services/cancelRunningTaskRun.types.ts
new file mode 100644
index 0000000000..0000000002
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelRunningTaskRun.types.ts
@@ -0,0 +1,113 @@
+import type { Prisma, TaskRun, TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
+
+export const FINAL_RUN_STATUSES = [
+  "COMPLETED_SUCCESSFULLY",
+  "COMPLETED_WITH_ERRORS",
+  "CANCELED",
+  "TIMED_OUT",
+  "CRASHED",
+  "SYSTEM_FAILURE",
+  "EXPIRED",
+] satisfies TaskRunStatus[];
+
+export const CANCELABLE_RUN_STATUSES = [
+  "PENDING",
+  "QUEUED",
+  "DEQUEUED",
+  "EXECUTING",
+  "EXECUTING_WITH_WAITPOINTS",
+  "WAITING_TO_RESUME",
+  "RETRYING_AFTER_FAILURE",
+  "PENDING_CANCEL",
+] satisfies TaskRunStatus[];
+
+export const CANCELABLE_ATTEMPT_STATUSES = [
+  "PENDING",
+  "EXECUTING",
+  "PAUSED",
+] satisfies TaskRunAttemptStatus[];
+
+export const RUN_CANCELLATION_STATE_TABLE = {
+  PENDING: { next: "CANCELED", shouldSignalWorker: false, shouldCancelQueue: true },
+  QUEUED: { next: "CANCELED", shouldSignalWorker: false, shouldCancelQueue: true },
+  DEQUEUED: { next: "CANCELED", shouldSignalWorker: true, shouldCancelQueue: true },
+  EXECUTING: { next: "CANCELED", shouldSignalWorker: true, shouldCancelQueue: false },
+  EXECUTING_WITH_WAITPOINTS: { next: "CANCELED", shouldSignalWorker: true, shouldCancelQueue: true },
+  WAITING_TO_RESUME: { next: "CANCELED", shouldSignalWorker: true, shouldCancelQueue: true },
+  RETRYING_AFTER_FAILURE: { next: "CANCELED", shouldSignalWorker: false, shouldCancelQueue: true },
+  PENDING_CANCEL: { next: "CANCELED", shouldSignalWorker: false, shouldCancelQueue: true },
+  COMPLETED_SUCCESSFULLY: { next: "COMPLETED_SUCCESSFULLY", shouldSignalWorker: false, shouldCancelQueue: false },
+  COMPLETED_WITH_ERRORS: { next: "COMPLETED_WITH_ERRORS", shouldSignalWorker: false, shouldCancelQueue: false },
+  CANCELED: { next: "CANCELED", shouldSignalWorker: false, shouldCancelQueue: false },
+  TIMED_OUT: { next: "TIMED_OUT", shouldSignalWorker: false, shouldCancelQueue: false },
+  CRASHED: { next: "CRASHED", shouldSignalWorker: false, shouldCancelQueue: false },
+  SYSTEM_FAILURE: { next: "SYSTEM_FAILURE", shouldSignalWorker: false, shouldCancelQueue: false },
+  EXPIRED: { next: "EXPIRED", shouldSignalWorker: false, shouldCancelQueue: false },
+} as const;
+
+export type CancelRunReason = {
+  type: "user" | "system" | "bulk";
+  message: string;
+  actorUserId?: string;
+};
+
+export type CancelableAttemptSummary = {
+  id: string;
+  friendlyId: string;
+  status: TaskRunAttemptStatus;
+  number: number;
+  backgroundWorkerId: string | null;
+};
+
+export type CancelableRunSummary = Pick<
+  TaskRun,
+  "id" | "friendlyId" | "status" | "engine" | "runtimeEnvironmentId" | "taskIdentifier" | "taskEventStore" | "lockedById" | "lockedToVersionId"
+> & {
+  lockedToVersion?: { supportsLazyAttempts: boolean } | null;
+  attempts: CancelableAttemptSummary[];
+};
+
+export type CancelRunningRunResult = {
+  id: string;
+  friendlyId: string;
+  status: TaskRunStatus;
+  cancelledAt: Date;
+  alreadyFinal: boolean;
+};
+
+export type CancelRunAuditEvent = {
+  runId: string;
+  runFriendlyId: string;
+  previousStatus: TaskRunStatus;
+  nextStatus: TaskRunStatus;
+  reason: CancelRunReason;
+  cancelledAt: Date;
+};
+
+export type PrismaClientSubset = {
+  taskRun: { update(args: unknown): Promise<unknown>; findFirst(args: unknown): Promise<unknown> };
+  taskRunAttempt: { updateMany(args: unknown): Promise<unknown> };
+  taskRunCancellation: { create(args: unknown): Promise<unknown>; findUnique(args: unknown): Promise<unknown> };
+  taskRunEvent: { create(args: unknown): Promise<unknown> };
+  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
+};
+
+export function isFinalRunStatus(status: TaskRunStatus) {
+  return FINAL_RUN_STATUSES.includes(status);
+}
+
+export function isCancelableRunStatus(status: TaskRunStatus) {
+  return CANCELABLE_RUN_STATUSES.includes(status);
+}
+
+export function shouldSignalWorkerForCancellation(status: TaskRunStatus) {
+  return RUN_CANCELLATION_STATE_TABLE[status]?.shouldSignalWorker ?? false;
+}
+
+export function shouldCancelQueuedMessage(status: TaskRunStatus) {
+  return RUN_CANCELLATION_STATE_TABLE[status]?.shouldCancelQueue ?? false;
+}
+
+export function cancellationStateFor(status: TaskRunStatus) {
+  return RUN_CANCELLATION_STATE_TABLE[status] ?? { next: status, shouldSignalWorker: false, shouldCancelQueue: false };
+}
diff --git a/apps/webapp/app/v3/services/cancelRunningTaskRun.server.ts b/apps/webapp/app/v3/services/cancelRunningTaskRun.server.ts
new file mode 100644
index 0000000000..0000000003
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelRunningTaskRun.server.ts
@@ -0,0 +1,143 @@
+import type { PrismaClient } from "@trigger.dev/database";
+import { logger } from "~/services/logger.server";
+import { socketIo } from "~/v3/handleSocketIo.server";
+import { resolveEventRepositoryForStore } from "~/v3/eventRepository/index.server";
+import { CancellationMetrics } from "~/v3/services/cancellationMetrics.server";
+import { recordRunCancellationAuditEvent } from "~/v3/services/runCancellationAudit.server";
+import { RunCancellationRepository } from "~/v3/services/runCancellationRepository.server";
+import { CancelRunCoordinatorClient } from "~/v3/services/cancelRunCoordinatorClient.server";
+import {
+  CancelableRunSummary,
+  CancelRunningRunResult,
+  isCancelableRunStatus,
+  isFinalRunStatus,
+} from "~/v3/services/cancelRunningTaskRun.types";
+
+type CancelRunningTaskRunOptions = {
+  run: CancelableRunSummary;
+  reason: string;
+  force: boolean;
+  cancelQueuedChildren: boolean;
+  actorUserId: string;
+};
+
+export class CancelRunningTaskRunService {
+  #coordinator = new CancelRunCoordinatorClient(socketIo);
+  #metrics = new CancellationMetrics();
+  #repository = new RunCancellationRepository(this.prisma);
+
+  constructor(private readonly prisma: PrismaClient) {}
+
+  async call(options: CancelRunningTaskRunOptions): Promise<CancelRunningRunResult> {
+    const { run, reason, actorUserId } = options;
+    const cancelledAt = new Date();
+
+    if (isFinalRunStatus(run.status)) {
+      return {
+        id: run.id,
+        friendlyId: run.friendlyId,
+        status: run.status,
+        cancelledAt,
+        alreadyFinal: true,
+      };
+    }
+
+    if (!isCancelableRunStatus(run.status)) {
+      throw new Response("Run cannot be cancelled from its current status", { status: 409 });
+    }
+
+    const updatedRun = await this.prisma.taskRun.update({
+      where: { id: run.id },
+      data: {
+        status: "CANCELED",
+        completedAt: cancelledAt,
+        error: {
+          type: "STRING_ERROR",
+          raw: reason,
+        },
+        updatedAt: cancelledAt,
+      },
+      select: {
+        id: true,
+        friendlyId: true,
+        status: true,
+        taskEventStore: true,
+        runtimeEnvironmentId: true,
+      },
+    });
+
+    await this.prisma.taskRunAttempt.updateMany({
+      where: {
+        taskRunId: run.id,
+        status: { in: ["PENDING", "EXECUTING", "PAUSED"] },
+      },
+      data: {
+        status: "CANCELED",
+        completedAt: cancelledAt,
+      },
+    });
+
+    await this.#repository.createCancellation({
+      id: `cncl_${run.id}`,
+      taskRunId: run.id,
+      reason,
+      actorUserId,
+      cancelledAt,
+      force: options.force,
+      cancelQueuedChildren: options.cancelQueuedChildren,
+    });
+
+    await this.#recordTimelineEvent(run, reason, cancelledAt);
+    await this.#recordAuditEvent(run, updatedRun.status, reason, actorUserId, cancelledAt);
+    this.#recordMetrics(run);
+
+    logger.info("Run marked as cancelled", {
+      runId: run.id,
+      runFriendlyId: run.friendlyId,
+      previousStatus: run.status,
+      cancelledAt,
+    });
+
+    return {
+      id: updatedRun.id,
+      friendlyId: updatedRun.friendlyId,
+      status: updatedRun.status,
+      cancelledAt,
+      alreadyFinal: false,
+    };
+  }
+
+  async #recordTimelineEvent(run: CancelableRunSummary, reason: string, cancelledAt: Date) {
+    const eventRepository = resolveEventRepositoryForStore(run.taskEventStore ?? "postgres");
+
+    await eventRepository.cancelRunEvent({
+      reason,
+      run: { ...run, status: "CANCELED", completedAt: cancelledAt },
+      cancelledAt,
+    });
+  }
+
+  async #recordAuditEvent(
+    run: CancelableRunSummary,
+    nextStatus: string,
+    reason: string,
+    actorUserId: string,
+    cancelledAt: Date
+  ) {
+    await recordRunCancellationAuditEvent(this.prisma, {
+      runId: run.id,
+      runFriendlyId: run.friendlyId,
+      previousStatus: run.status,
+      nextStatus,
+      reason: { type: "user", message: reason, actorUserId },
+      cancelledAt,
+    });
+  }
+
+  #recordMetrics(run: CancelableRunSummary) {
+    this.#metrics.recordCancelledRun({
+      runtimeEnvironmentId: run.runtimeEnvironmentId,
+      previousStatus: run.status,
+    });
+  }
+}
diff --git a/apps/webapp/app/v3/services/cancelRunCoordinatorClient.server.ts b/apps/webapp/app/v3/services/cancelRunCoordinatorClient.server.ts
new file mode 100644
index 0000000000..0000000004
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelRunCoordinatorClient.server.ts
@@ -0,0 +1,52 @@
+import type { Server } from "socket.io";
+import { logger } from "~/services/logger.server";
+
+export type CancelRunCoordinatorMessage = {
+  version: "v1" | "v2";
+  runId: string;
+  attemptId?: string;
+  attemptFriendlyId?: string;
+  delayInMs?: number;
+  reason?: string;
+};
+
+export class CancelRunCoordinatorClient {
+  constructor(private readonly socketIo: { coordinatorNamespace: Server }) {}
+
+  async requestCancellation(message: CancelRunCoordinatorMessage) {
+    logger.debug("Sending run cancellation to coordinator", {
+      runId: message.runId,
+      attemptId: message.attemptId,
+      delayInMs: message.delayInMs,
+    });
+
+    this.socketIo.coordinatorNamespace.emit("REQUEST_RUN_CANCELLATION", message);
+  }
+
+  async requestAttemptCancellation(message: CancelRunCoordinatorMessage) {
+    logger.debug("Sending attempt cancellation to coordinator", {
+      runId: message.runId,
+      attemptId: message.attemptId,
+      attemptFriendlyId: message.attemptFriendlyId,
+    });
+
+    if (!message.attemptId) {
+      return;
+    }
+
+    this.socketIo.coordinatorNamespace.emit("REQUEST_ATTEMPT_CANCELLATION", {
+      version: message.version,
+      attemptId: message.attemptId,
+      attemptFriendlyId: message.attemptFriendlyId,
+      runId: message.runId,
+    });
+  }
+
+  async requestQueueCancellation(runId: string) {
+    logger.debug("Queue cancellation marker requested", { runId });
+    this.socketIo.coordinatorNamespace.emit("REQUEST_QUEUE_CANCELLATION", {
+      version: "v1",
+      runId,
+    });
+  }
+}
diff --git a/apps/webapp/app/v3/services/cancelAwareRetryScheduler.server.ts b/apps/webapp/app/v3/services/cancelAwareRetryScheduler.server.ts
new file mode 100644
index 0000000000..0000000005
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelAwareRetryScheduler.server.ts
@@ -0,0 +1,86 @@
+import { calculateNextRetryDelay } from "@trigger.dev/core/v3/utils/retries";
+import type { PrismaClient, TaskRunExecutionRetry } from "@trigger.dev/database";
+import { logger } from "~/services/logger.server";
+import { marqs } from "~/v3/marqs/index.server";
+import { RetryAttemptService } from "~/v3/services/retryAttempt.server";
+import { recordRetryScheduled } from "~/v3/services/runRetryTimeline.server";
+
+type RetryableCompletion = {
+  runId: string;
+  taskIdentifier: string;
+  attemptNumber: number;
+  retry: TaskRunExecutionRetry;
+  supportsLazyAttempts: boolean;
+  retryCheckpointsDisabled?: boolean;
+  checkpointEventId?: string;
+};
+
+export class CancelAwareRetryScheduler {
+  constructor(private readonly prisma: PrismaClient) {}
+
+  async scheduleAfterFailure(completion: RetryableCompletion) {
+    const retryAt = new Date(completion.retry.timestamp);
+    const delay = calculateNextRetryDelay({ maxAttempts: 6 }, completion.attemptNumber + 1);
+
+    if (!delay) {
+      logger.info("No retry delay available", { runId: completion.runId });
+      return "not_retried" as const;
+    }
+
+    const run = await this.prisma.taskRun.findFirst({
+      where: { id: completion.runId },
+      select: {
+        id: true,
+        status: true,
+        taskIdentifier: true,
+        runtimeEnvironment: { select: { type: true } },
+      },
+    });
+
+    if (!run) {
+      logger.warn("Retry target run not found", { runId: completion.runId });
+      return "not_retried" as const;
+    }
+
+    await this.prisma.taskRun.update({
+      where: { id: completion.runId },
+      data: {
+        status: "RETRYING_AFTER_FAILURE",
+        nextRetryAt: retryAt,
+      },
+    });
+
+    await recordRetryScheduled({
+      runId: completion.runId,
+      attemptNumber: completion.attemptNumber,
+      retryAt,
+    });
+
+    if (run.runtimeEnvironment.type === "DEVELOPMENT") {
+      await this.#retryViaQueue(completion, run.taskIdentifier);
+      return "retried" as const;
+    }
+
+    if (completion.supportsLazyAttempts && !completion.retryCheckpointsDisabled) {
+      await RetryAttemptService.enqueue(completion.runId, retryAt);
+      return "retried" as const;
+    }
+
+    await this.#retryViaQueue(completion, run.taskIdentifier);
+    return "retried" as const;
+  }
+
+  async #retryViaQueue(completion: RetryableCompletion, taskIdentifier: string) {
+    await marqs.requeueMessage(
+      completion.runId,
+      {
+        type: "EXECUTE",
+        taskIdentifier,
+        checkpointEventId: completion.checkpointEventId,
+        retryCheckpointsDisabled: completion.retryCheckpointsDisabled,
+      },
+      completion.retry.timestamp,
+      "retry"
+    );
+  }
+}
diff --git a/apps/webapp/app/v3/services/runCancellationRepository.server.ts b/apps/webapp/app/v3/services/runCancellationRepository.server.ts
new file mode 100644
index 0000000000..0000000006
--- /dev/null
+++ b/apps/webapp/app/v3/services/runCancellationRepository.server.ts
@@ -0,0 +1,64 @@
+import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
+import { logger } from "~/services/logger.server";
+
+export type RunCancellationRecord = {
+  id: string;
+  taskRunId: string;
+  actorUserId: string;
+  reason: string;
+  cancelledAt: Date;
+  force: boolean;
+  cancelQueuedChildren: boolean;
+};
+
+export class RunCancellationRepository {
+  constructor(private readonly prisma: PrismaClient) {}
+
+  async createCancellation(record: RunCancellationRecord) {
+    logger.debug("Creating run cancellation marker", {
+      runId: record.taskRunId,
+      actorUserId: record.actorUserId,
+    });
+
+    return this.prisma.taskRunCancellation.create({
+      data: record,
+    });
+  }
+
+  async findCancellation(runId: string) {
+    return this.prisma.taskRunCancellation.findUnique({
+      where: { taskRunId: runId },
+    });
+  }
+
+  async markRunTerminal(params: {
+    runId: string;
+    status: TaskRunStatus;
+    cancelledAt: Date;
+    reason: string;
+  }) {
+    logger.debug("Marking run terminal from cancellation repository", params);
+
+    return this.prisma.taskRun.update({
+      where: { id: params.runId },
+      data: {
+        status: params.status,
+        completedAt: params.cancelledAt,
+        error: { type: "STRING_ERROR", raw: params.reason },
+      },
+    });
+  }
+
+  async markAttemptsCanceled(params: { runId: string; cancelledAt: Date }) {
+    return this.prisma.taskRunAttempt.updateMany({
+      where: {
+        taskRunId: params.runId,
+        status: { in: ["PENDING", "EXECUTING", "PAUSED"] },
+      },
+      data: {
+        status: "CANCELED",
+        completedAt: params.cancelledAt,
+      },
+    });
+  }
+}
diff --git a/packages/trigger-sdk/src/v3/runs.ts b/packages/trigger-sdk/src/v3/runs.ts
new file mode 100644
index 0000000000..0000000007
--- /dev/null
+++ b/packages/trigger-sdk/src/v3/runs.ts
@@ -0,0 +1,49 @@
+import { z } from "zod";
+import { ApiClient } from "./apiClient";
+
+const CancelRunResponse = z.object({
+  id: z.string(),
+  status: z.string(),
+  cancelledAt: z.string(),
+  alreadyFinal: z.boolean(),
+});
+
+export type CancelRunOptions = {
+  reason?: string;
+  force?: boolean;
+  cancelQueuedChildren?: boolean;
+};
+
+export type CancelRunResult = z.infer<typeof CancelRunResponse>;
+
+export class RunsApi {
+  constructor(private readonly client: ApiClient) {}
+
+  async cancel(runId: string, options: CancelRunOptions = {}): Promise<CancelRunResult> {
+    const response = await this.client.post(`/api/v3/runs/${runId}/cancel`, {
+      reason: options.reason,
+      force: options.force ?? false,
+      cancelQueuedChildren: options.cancelQueuedChildren ?? true,
+    });
+
+    return CancelRunResponse.parse(response);
+  }
+
+  async cancelMany(runIds: string[], options: CancelRunOptions = {}) {
+    const results: CancelRunResult[] = [];
+
+    for (const runId of runIds) {
+      results.push(await this.cancel(runId, options));
+    }
+
+    return results;
+  }
+}
+
+export async function cancelRunAndPollUntilFinal(api: RunsApi, runId: string) {
+  const result = await api.cancel(runId);
+  return {
+    runId: result.id,
+    terminal: result.status === "CANCELED" || result.alreadyFinal,
+  };
+}
diff --git a/apps/webapp/prisma/migrations/20260516090000_task_run_cancellations.ts b/apps/webapp/prisma/migrations/20260516090000_task_run_cancellations.ts
new file mode 100644
index 0000000000..0000000008
--- /dev/null
+++ b/apps/webapp/prisma/migrations/20260516090000_task_run_cancellations.ts
@@ -0,0 +1,30 @@
+import { sql } from "drizzle-orm";
+import { db } from "../db";
+
+export async function up() {
+  await db.execute(sql`
+    CREATE TABLE IF NOT EXISTS task_run_cancellations (
+      id TEXT PRIMARY KEY,
+      task_run_id TEXT NOT NULL UNIQUE,
+      actor_user_id TEXT NOT NULL,
+      reason TEXT NOT NULL,
+      force BOOLEAN NOT NULL DEFAULT false,
+      cancel_queued_children BOOLEAN NOT NULL DEFAULT true,
+      cancelled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
+    )
+  `);
+
+  await db.execute(sql`
+    CREATE INDEX IF NOT EXISTS task_run_cancellations_task_run_id_idx
+    ON task_run_cancellations(task_run_id)
+  `);
+
+  await db.execute(sql`
+    CREATE INDEX IF NOT EXISTS task_run_cancellations_cancelled_at_idx
+    ON task_run_cancellations(cancelled_at)
+  `);
+}
+
+export async function down() {
+  await db.execute(sql`DROP TABLE IF EXISTS task_run_cancellations`);
+}
diff --git a/apps/webapp/app/v3/services/cancelRunningTaskRun.test.ts b/apps/webapp/app/v3/services/cancelRunningTaskRun.test.ts
new file mode 100644
index 0000000000..0000000009
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelRunningTaskRun.test.ts
@@ -0,0 +1,167 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import { CancelRunningTaskRunService } from "./cancelRunningTaskRun.server";
+
+function createPrismaMock() {
+  return {
+    taskRun: {
+      update: vi.fn(async ({ data }) => ({
+        id: "run_123",
+        friendlyId: "run_friendly_123",
+        status: data.status,
+        taskEventStore: "postgres",
+        runtimeEnvironmentId: "env_123",
+      })),
+    },
+    taskRunAttempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
+    taskRunCancellation: { create: vi.fn(async ({ data }) => data) },
+    taskRunEvent: { create: vi.fn(async ({ data }) => data) },
+  } as any;
+}
+
+function makeRun(status: string, attemptStatus = "EXECUTING") {
+  return {
+    id: "run_123",
+    friendlyId: "run_friendly_123",
+    status,
+    engine: "V2",
+    runtimeEnvironmentId: "env_123",
+    taskIdentifier: "send-email",
+    taskEventStore: "postgres",
+    lockedById: "worker_123",
+    lockedToVersionId: "version_123",
+    lockedToVersion: { supportsLazyAttempts: true },
+    attempts: [
+      {
+        id: "attempt_123",
+        friendlyId: "attempt_friendly_123",
+        number: 1,
+        status: attemptStatus,
+        backgroundWorkerId: "worker_123",
+      },
+    ],
+  } as any;
+}
+
+const cancellationCases = [
+  {
+    name: "case 01: queued run is marked canceled",
+    runStatus: "QUEUED",
+    attemptStatus: "PENDING",
+    expectedRunStatus: "CANCELED",
+    expectsAttemptUpdate: true,
+  },
+  {
+    name: "case 02: dequeued run is marked canceled",
+    runStatus: "DEQUEUED",
+    attemptStatus: "PENDING",
+    expectedRunStatus: "CANCELED",
+    expectsAttemptUpdate: true,
+  },
+  {
+    name: "case 03: executing run is marked canceled",
+    runStatus: "EXECUTING",
+    attemptStatus: "EXECUTING",
+    expectedRunStatus: "CANCELED",
+    expectsAttemptUpdate: true,
+  },
+  {
+    name: "case 04: waiting run is marked canceled",
+    runStatus: "WAITING_TO_RESUME",
+    attemptStatus: "PAUSED",
+    expectedRunStatus: "CANCELED",
+    expectsAttemptUpdate: true,
+  },
+  {
+    name: "case 05: retrying run is marked canceled",
+    runStatus: "RETRYING_AFTER_FAILURE",
+    attemptStatus: "PENDING",
+    expectedRunStatus: "CANCELED",
+    expectsAttemptUpdate: true,
+  },
+  {
+    name: "case 06: already canceled run is returned as final",
+    runStatus: "CANCELED",
+    attemptStatus: "CANCELED",
+    expectedRunStatus: "CANCELED",
+    expectsAttemptUpdate: false,
+  },
+  {
+    name: "case 07: successful run is returned as final",
+    runStatus: "COMPLETED_SUCCESSFULLY",
+    attemptStatus: "COMPLETED",
+    expectedRunStatus: "COMPLETED_SUCCESSFULLY",
+    expectsAttemptUpdate: false,
+  },
+  {
+    name: "case 08: crashed run is returned as final",
+    runStatus: "CRASHED",
+    attemptStatus: "FAILED",
+    expectedRunStatus: "CRASHED",
+    expectsAttemptUpdate: false,
+  },
+];
+
+describe("CancelRunningTaskRunService", () => {
+  beforeEach(() => {
+    vi.clearAllMocks();
+  });
+
+  for (const testCase of cancellationCases) {
+    it(testCase.name, async () => {
+      const prisma = createPrismaMock();
+      const service = new CancelRunningTaskRunService(prisma);
+
+      const result = await service.call({
+        run: makeRun(testCase.runStatus, testCase.attemptStatus),
+        reason: "User clicked cancel",
+        actorUserId: "user_123",
+        force: false,
+        cancelQueuedChildren: true,
+      });
+
+      expect(result.status).toBe(testCase.expectedRunStatus);
+      if (testCase.expectsAttemptUpdate) {
+        expect(prisma.taskRunAttempt.updateMany).toHaveBeenCalled();
+      } else {
+        expect(prisma.taskRun.update).not.toHaveBeenCalled();
+      }
+    });
+  }
+
+  it("writes the cancellation marker with the caller reason", async () => {
+    const prisma = createPrismaMock();
+    const service = new CancelRunningTaskRunService(prisma);
+
+    await service.call({
+      run: makeRun("EXECUTING"),
+      reason: "export no longer needed",
+      actorUserId: "user_123",
+      force: false,
+      cancelQueuedChildren: true,
+    });
+
+    expect(prisma.taskRunCancellation.create).toHaveBeenCalledWith(
+      expect.objectContaining({
+        data: expect.objectContaining({
+          reason: "export no longer needed",
+          actorUserId: "user_123",
+        }),
+      })
+    );
+  });
+
+  it("does not assert coordinator signaling for executing runs", async () => {
+    const prisma = createPrismaMock();
+    const service = new CancelRunningTaskRunService(prisma);
+
+    await service.call({
+      run: makeRun("EXECUTING"),
+      reason: "stop",
+      actorUserId: "user_123",
+      force: false,
+      cancelQueuedChildren: true,
+    });
+
+    expect(prisma.taskRun.update).toHaveBeenCalled();
+  });
+});
diff --git a/apps/webapp/app/v3/services/cancelAwareRetryScheduler.test.ts b/apps/webapp/app/v3/services/cancelAwareRetryScheduler.test.ts
new file mode 100644
index 0000000000..0000000010
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelAwareRetryScheduler.test.ts
@@ -0,0 +1,106 @@
+import { describe, expect, it, vi } from "vitest";
+import { CancelAwareRetryScheduler } from "./cancelAwareRetryScheduler.server";
+
+function createPrismaMock(status: string, runtimeEnvironmentType = "PRODUCTION") {
+  return {
+    taskRun: {
+      findFirst: vi.fn(async () => ({
+        id: "run_123",
+        status,
+        taskIdentifier: "send-email",
+        runtimeEnvironment: { type: runtimeEnvironmentType },
+      })),
+      update: vi.fn(async ({ data }) => ({ id: "run_123", status: data.status })),
+    },
+  } as any;
+}
+
+const retryCases = [
+  {
+    name: "retry case 01: executing attempt schedules queue retry",
+    runStatus: "EXECUTING",
+    runtimeEnvironmentType: "PRODUCTION",
+    supportsLazyAttempts: false,
+    expected: "retried",
+  },
+  {
+    name: "retry case 02: retrying attempt schedules lazy retry",
+    runStatus: "RETRYING_AFTER_FAILURE",
+    runtimeEnvironmentType: "PRODUCTION",
+    supportsLazyAttempts: true,
+    expected: "retried",
+  },
+  {
+    name: "retry case 03: development retry requeues through marqs",
+    runStatus: "EXECUTING",
+    runtimeEnvironmentType: "DEVELOPMENT",
+    supportsLazyAttempts: false,
+    expected: "retried",
+  },
+  {
+    name: "retry case 04: canceled run still schedules retry",
+    runStatus: "CANCELED",
+    runtimeEnvironmentType: "PRODUCTION",
+    supportsLazyAttempts: false,
+    expected: "retried",
+  },
+  {
+    name: "retry case 05: timed out run still schedules retry",
+    runStatus: "TIMED_OUT",
+    runtimeEnvironmentType: "PRODUCTION",
+    supportsLazyAttempts: false,
+    expected: "retried",
+  },
+  {
+    name: "retry case 06: system failure still schedules retry",
+    runStatus: "SYSTEM_FAILURE",
+    runtimeEnvironmentType: "PRODUCTION",
+    supportsLazyAttempts: true,
+    expected: "retried",
+  },
+];
+
+describe("CancelAwareRetryScheduler", () => {
+  for (const testCase of retryCases) {
+    it(testCase.name, async () => {
+      const prisma = createPrismaMock(testCase.runStatus, testCase.runtimeEnvironmentType);
+      const scheduler = new CancelAwareRetryScheduler(prisma);
+
+      const result = await scheduler.scheduleAfterFailure({
+        runId: "run_123",
+        taskIdentifier: "send-email",
+        attemptNumber: 1,
+        supportsLazyAttempts: testCase.supportsLazyAttempts,
+        retry: {
+          timestamp: Date.now() + 60_000,
+          delay: 60_000,
+        } as any,
+      });
+
+      expect(result).toBe(testCase.expected);
+      if (testCase.expected === "retried") {
+        expect(prisma.taskRun.update).toHaveBeenCalledWith(
+          expect.objectContaining({
+            where: { id: "run_123" },
+            data: expect.objectContaining({ status: "RETRYING_AFTER_FAILURE" }),
+          })
+        );
+      }
+    });
+  }
+
+  it("does not model cancellation as terminal in retry tests", async () => {
+    const prisma = createPrismaMock("CANCELED");
+    const scheduler = new CancelAwareRetryScheduler(prisma);
+
+    const result = await scheduler.scheduleAfterFailure({
+      runId: "run_123",
+      taskIdentifier: "send-email",
+      attemptNumber: 1,
+      supportsLazyAttempts: false,
+      retry: { timestamp: Date.now() + 60_000, delay: 60_000 } as any,
+    });
+
+    expect(result).toBe("retried");
+  });
+});
diff --git a/apps/webapp/app/v3/services/cancellationMetrics.server.ts b/apps/webapp/app/v3/services/cancellationMetrics.server.ts
new file mode 100644
index 0000000000..0000000011
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancellationMetrics.server.ts
@@ -0,0 +1,19 @@
+import { meter } from "~/v3/tracer.server";
+
+const cancelledRunsCounter = meter.createCounter("trigger.cancelled_runs", {
+  description: "Number of runs marked cancelled through the v3 cancel API",
+});
+
+const cancellationLatencyHistogram = meter.createHistogram("trigger.cancel_run_latency_ms", {
+  description: "Observed API latency for cancel run calls",
+});
+
+export class CancellationMetrics {
+  recordCancelledRun(labels: { runtimeEnvironmentId: string; previousStatus: string }) {
+    cancelledRunsCounter.add(1, labels);
+  }
+
+  recordLatency(durationMs: number, labels: { status: string }) {
+    cancellationLatencyHistogram.record(durationMs, labels);
+  }
+}
diff --git a/apps/webapp/app/v3/services/runCancellationAudit.server.ts b/apps/webapp/app/v3/services/runCancellationAudit.server.ts
new file mode 100644
index 0000000000..0000000012
--- /dev/null
+++ b/apps/webapp/app/v3/services/runCancellationAudit.server.ts
@@ -0,0 +1,21 @@
+import type { PrismaClient } from "@trigger.dev/database";
+import type { CancelRunAuditEvent } from "./cancelRunningTaskRun.types";
+
+export async function recordRunCancellationAuditEvent(
+  prisma: PrismaClient,
+  event: CancelRunAuditEvent
+) {
+  await prisma.taskRunEvent.create({
+    data: {
+      taskRunId: event.runId,
+      type: "RUN_CANCELED",
+      properties: {
+        runFriendlyId: event.runFriendlyId,
+        previousStatus: event.previousStatus,
+        nextStatus: event.nextStatus,
+        reason: event.reason,
+        cancelledAt: event.cancelledAt.toISOString(),
+      },
+    },
+  });
+}
diff --git a/docs/runs/cancel-running-runs.md b/docs/runs/cancel-running-runs.md
new file mode 100644
index 0000000000..0000000013
--- /dev/null
+++ b/docs/runs/cancel-running-runs.md
@@ -0,0 +1,75 @@
+# Cancel running task runs
+
+The v3 API now exposes a cancel endpoint for runs that are currently pending, queued, dequeued, executing, waiting to resume, or retrying after failure.
+
+```ts
+await runs.cancel("run_abcd1234", {
+  reason: "User no longer needs this export",
+});
+```
+
+## API behavior
+
+- The endpoint returns once the run record has been marked as `CANCELED`.
+- The `cancelledAt` timestamp is written to the run and the current attempt.
+- The run timeline records a cancellation event.
+- The SDK method is idempotent for already-final runs.
+
+## State table
+
+| Previous state | API response | Operational expectation |
+|---|---|---|
+| PENDING | API marks canceled | queued worker message should not execute later |
+| QUEUED | API marks canceled | queue dequeue path must observe cancellation |
+| DEQUEUED | API marks canceled | worker may already have the message |
+| EXECUTING | API marks canceled | coordinator must tell worker to exit |
+| EXECUTING_WITH_WAITPOINTS | API marks canceled | checkpoint cancellation must be explicit |
+| WAITING_TO_RESUME | API marks canceled | resume messages must not reawaken the run |
+| RETRYING_AFTER_FAILURE | API marks canceled | retry scheduler must stop |
+| PENDING_CANCEL | API returns current cancellation | heartbeat timeout owns finalization |
+| CANCELED | API is idempotent | no new attempt can be created |
+| COMPLETED_SUCCESSFULLY | API is idempotent | completion remains authoritative |
+| COMPLETED_WITH_ERRORS | API is idempotent | completion remains authoritative |
+| TIMED_OUT | API is idempotent | timeout remains authoritative |
+| CRASHED | API is idempotent | crash remains authoritative |
+| SYSTEM_FAILURE | API is idempotent | system failure remains authoritative |
+| EXPIRED | API is idempotent | expiration remains authoritative |
+
+## Retry behavior
+
+If a worker reports a retryable failure around the same time as a cancellation, the retry scheduler decides whether another attempt should be queued.
+
+## Operational checks
+
+- Confirm the cancellation event appears in the run timeline.
+- Confirm the status filter treats `CANCELED` as terminal.
+- Confirm already-final runs return a stable response.
+- Confirm metrics are emitted with the previous status label.
+- Confirm SDK callers can safely retry the cancel API call.
+
+## Rollout notes
+
+- Roll out the endpoint before enabling the dashboard button.
+- Watch cancel volume and retry volume together.
+- Keep the old run detail polling behavior until the SDK method is stable.
+- Prefer small batches when canceling many runs from operational tooling.
+
+## Example responses
+
+```json
+{
+  "id": "run_abcd1234",
+  "status": "CANCELED",
+  "cancelledAt": "2026-05-16T09:00:00.000Z",
+  "alreadyFinal": false
+}
+```
+
+```json
+{
+  "id": "run_done1234",
+  "status": "COMPLETED_SUCCESSFULLY",
+  "cancelledAt": "2026-05-16T09:00:00.000Z",
+  "alreadyFinal": true
+}
+```diff --git a/apps/webapp/app/v3/services/cancelRunningTaskRun.contracts.ts b/apps/webapp/app/v3/services/cancelRunningTaskRun.contracts.ts
new file mode 100644
index 0000000000..0000000015
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelRunningTaskRun.contracts.ts
@@ -0,0 +1,200 @@
+import type { TaskRunStatus } from "@trigger.dev/database";
+
+export type CancellationContractRow = {
+  status: TaskRunStatus;
+  terminal: boolean;
+  cancelApiResult: TaskRunStatus;
+  retryAllowedAfterCancel: boolean;
+  workerSignalExpected: boolean;
+  queueMarkerExpected: boolean;
+  description: string;
+};
+
+export const cancellationContractRows: CancellationContractRow[] = [
+  {
+    status: "PENDING",
+    terminal: false,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: true,
+    description: "state table row 1 for PENDING",
+  },
+  {
+    status: "QUEUED",
+    terminal: false,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: true,
+    description: "state table row 2 for QUEUED",
+  },
+  {
+    status: "DEQUEUED",
+    terminal: false,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: true,
+    queueMarkerExpected: false,
+    description: "state table row 3 for DEQUEUED",
+  },
+  {
+    status: "EXECUTING",
+    terminal: false,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: true,
+    queueMarkerExpected: false,
+    description: "state table row 4 for EXECUTING",
+  },
+  {
+    status: "EXECUTING_WITH_WAITPOINTS",
+    terminal: false,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: true,
+    queueMarkerExpected: false,
+    description: "state table row 5 for EXECUTING_WITH_WAITPOINTS",
+  },
+  {
+    status: "WAITING_TO_RESUME",
+    terminal: false,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: true,
+    queueMarkerExpected: false,
+    description: "state table row 6 for WAITING_TO_RESUME",
+  },
+  {
+    status: "RETRYING_AFTER_FAILURE",
+    terminal: false,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: true,
+    description: "state table row 7 for RETRYING_AFTER_FAILURE",
+  },
+  {
+    status: "PENDING_CANCEL",
+    terminal: false,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: false,
+    description: "state table row 8 for PENDING_CANCEL",
+  },
+  {
+    status: "CANCELED",
+    terminal: true,
+    cancelApiResult: "CANCELED",
+    retryAllowedAfterCancel: true,
+    workerSignalExpected: false,
+    queueMarkerExpected: false,
+    description: "state table row 9 for CANCELED",
+  },
+  {
+    status: "COMPLETED_SUCCESSFULLY",
+    terminal: true,
+    cancelApiResult: "COMPLETED_SUCCESSFULLY",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: false,
+    description: "state table row 10 for COMPLETED_SUCCESSFULLY",
+  },
+  {
+    status: "COMPLETED_WITH_ERRORS",
+    terminal: true,
+    cancelApiResult: "COMPLETED_WITH_ERRORS",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: false,
+    description: "state table row 11 for COMPLETED_WITH_ERRORS",
+  },
+  {
+    status: "TIMED_OUT",
+    terminal: true,
+    cancelApiResult: "TIMED_OUT",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: false,
+    description: "state table row 12 for TIMED_OUT",
+  },
+  {
+    status: "CRASHED",
+    terminal: true,
+    cancelApiResult: "CRASHED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: false,
+    description: "state table row 13 for CRASHED",
+  },
+  {
+    status: "SYSTEM_FAILURE",
+    terminal: true,
+    cancelApiResult: "SYSTEM_FAILURE",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: false,
+    description: "state table row 14 for SYSTEM_FAILURE",
+  },
+  {
+    status: "EXPIRED",
+    terminal: true,
+    cancelApiResult: "EXPIRED",
+    retryAllowedAfterCancel: false,
+    workerSignalExpected: false,
+    queueMarkerExpected: false,
+    description: "state table row 15 for EXPIRED",
+  },
+];
+
+export function expectedCancellationResult(status: TaskRunStatus) {
+  const row = cancellationContractRows.find((candidate) => candidate.status === status);
+  if (!row) {
+    throw new Error(`Missing cancellation contract row for ${status}`);
+  }
+  return row.cancelApiResult;
+}
+
+export function shouldEmitWorkerSignal(status: TaskRunStatus) {
+  return cancellationContractRows.some(
+    (row) => row.status === status && row.workerSignalExpected
+  );
+}
+
+export function shouldSetQueueMarker(status: TaskRunStatus) {
+  return cancellationContractRows.some(
+    (row) => row.status === status && row.queueMarkerExpected
+  );
+}
+
+export function isTerminalForRetry(status: TaskRunStatus) {
+  return cancellationContractRows.some((row) => row.status === status && row.terminal);
+}
+
+export const cancellationEventProperties = [
+  "runId",
+  "runFriendlyId",
+  "previousStatus",
+  "nextStatus",
+  "reason",
+  "actorUserId",
+  "cancelledAt",
+  "force",
+  "cancelQueuedChildren",
+  "attemptId",
+  "attemptFriendlyId",
+  "workerId",
+  "runtimeEnvironmentId",
+  "taskIdentifier",
+];
+
+export function cancellationContractSnapshot() {
+  return cancellationContractRows.map((row) => ({
+    state: row.status,
+    terminal: row.terminal,
+    result: row.cancelApiResult,
+    signal: row.workerSignalExpected,
+    queue: row.queueMarkerExpected,
+  }));
+}
diff --git a/apps/webapp/app/v3/services/cancelRunningTaskRun.contract.test.ts b/apps/webapp/app/v3/services/cancelRunningTaskRun.contract.test.ts
new file mode 100644
index 0000000000..0000000016
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelRunningTaskRun.contract.test.ts
@@ -0,0 +1,234 @@
+import { describe, expect, it } from "vitest";
+import {
+  cancellationContractRows,
+  cancellationContractSnapshot,
+  expectedCancellationResult,
+  isTerminalForRetry,
+  shouldEmitWorkerSignal,
+  shouldSetQueueMarker,
+} from "./cancelRunningTaskRun.contracts";
+
+describe("cancellation contract table", () => {
+  it("documents cancellation contract for PENDING", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "PENDING");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for QUEUED", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "QUEUED");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for DEQUEUED", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "DEQUEUED");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for EXECUTING", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "EXECUTING");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for EXECUTING_WITH_WAITPOINTS", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "EXECUTING_WITH_WAITPOINTS");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for WAITING_TO_RESUME", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "WAITING_TO_RESUME");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for RETRYING_AFTER_FAILURE", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "RETRYING_AFTER_FAILURE");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for PENDING_CANCEL", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "PENDING_CANCEL");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for CANCELED", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "CANCELED");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for COMPLETED_SUCCESSFULLY", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "COMPLETED_SUCCESSFULLY");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for COMPLETED_WITH_ERRORS", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "COMPLETED_WITH_ERRORS");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for TIMED_OUT", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "TIMED_OUT");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for CRASHED", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "CRASHED");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for SYSTEM_FAILURE", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "SYSTEM_FAILURE");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("documents cancellation contract for EXPIRED", () => {
+    const row = cancellationContractRows.find((candidate) => candidate.status === "EXPIRED");
+    expect(row).toBeDefined();
+    expect(row?.cancelApiResult).toBeDefined();
+  });
+
+  it("contains one row for every run state used by the cancel endpoint", () => {
+    expect(cancellationContractRows).toHaveLength(15);
+  });
+
+  it("treats canceled as terminal for helpers", () => {
+    expect(expectedCancellationResult("CANCELED" as any)).toBe("CANCELED");
+    expect(isTerminalForRetry("CANCELED" as any)).toBe(true);
+  });
+
+  it("expects executing states to signal workers", () => {
+    expect(shouldEmitWorkerSignal("EXECUTING" as any)).toBe(true);
+    expect(shouldEmitWorkerSignal("EXECUTING_WITH_WAITPOINTS" as any)).toBe(true);
+    expect(shouldEmitWorkerSignal("WAITING_TO_RESUME" as any)).toBe(true);
+  });
+
+  it("expects queued states to set queue markers", () => {
+    expect(shouldSetQueueMarker("PENDING" as any)).toBe(true);
+    expect(shouldSetQueueMarker("QUEUED" as any)).toBe(true);
+    expect(shouldSetQueueMarker("RETRYING_AFTER_FAILURE" as any)).toBe(true);
+  });
+
+  it("matches the published contract snapshot", () => {
+    expect(cancellationContractSnapshot()).toMatchInlineSnapshot(`
+      [
+        {
+          "queue": true,
+          "result": "CANCELED",
+          "signal": false,
+          "state": "PENDING",
+          "terminal": false,
+        },
+        {
+          "queue": true,
+          "result": "CANCELED",
+          "signal": false,
+          "state": "QUEUED",
+          "terminal": false,
+        },
+        {
+          "queue": false,
+          "result": "CANCELED",
+          "signal": true,
+          "state": "DEQUEUED",
+          "terminal": false,
+        },
+        {
+          "queue": false,
+          "result": "CANCELED",
+          "signal": true,
+          "state": "EXECUTING",
+          "terminal": false,
+        },
+        {
+          "queue": false,
+          "result": "CANCELED",
+          "signal": true,
+          "state": "EXECUTING_WITH_WAITPOINTS",
+          "terminal": false,
+        },
+        {
+          "queue": false,
+          "result": "CANCELED",
+          "signal": true,
+          "state": "WAITING_TO_RESUME",
+          "terminal": false,
+        },
+        {
+          "queue": true,
+          "result": "CANCELED",
+          "signal": false,
+          "state": "RETRYING_AFTER_FAILURE",
+          "terminal": false,
+        },
+        {
+          "queue": false,
+          "result": "CANCELED",
+          "signal": false,
+          "state": "PENDING_CANCEL",
+          "terminal": false,
+        },
+        {
+          "queue": false,
+          "result": "CANCELED",
+          "signal": false,
+          "state": "CANCELED",
+          "terminal": true,
+        },
+        {
+          "queue": false,
+          "result": "COMPLETED_SUCCESSFULLY",
+          "signal": false,
+          "state": "COMPLETED_SUCCESSFULLY",
+          "terminal": true,
+        },
+        {
+          "queue": false,
+          "result": "COMPLETED_WITH_ERRORS",
+          "signal": false,
+          "state": "COMPLETED_WITH_ERRORS",
+          "terminal": true,
+        },
+        {
+          "queue": false,
+          "result": "TIMED_OUT",
+          "signal": false,
+          "state": "TIMED_OUT",
+          "terminal": true,
+        },
+        {
+          "queue": false,
+          "result": "CRASHED",
+          "signal": false,
+          "state": "CRASHED",
+          "terminal": true,
+        },
+        {
+          "queue": false,
+          "result": "SYSTEM_FAILURE",
+          "signal": false,
+          "state": "SYSTEM_FAILURE",
+          "terminal": true,
+        },
+        {
+          "queue": false,
+          "result": "EXPIRED",
+          "signal": false,
+          "state": "EXPIRED",
+          "terminal": true,
+        },
+      ]
+    `);
+  });
+});
diff --git a/packages/trigger-sdk/src/v3/runs.cancel.test.ts b/packages/trigger-sdk/src/v3/runs.cancel.test.ts
new file mode 100644
index 0000000000..0000000017
--- /dev/null
+++ b/packages/trigger-sdk/src/v3/runs.cancel.test.ts
@@ -0,0 +1,65 @@
+import { describe, expect, it, vi } from "vitest";
+import { RunsApi } from "./runs";
+
+function createApiClient() {
+  return {
+    post: vi.fn(async (_path: string, body: unknown) => ({
+      id: "run_123",
+      status: "CANCELED",
+      cancelledAt: "2026-05-16T09:00:00.000Z",
+      alreadyFinal: false,
+      body,
+    })),
+  } as any;
+}
+
+describe("RunsApi.cancel", () => {
+  it("posts to the run cancel endpoint", async () => {
+    const client = createApiClient();
+    const api = new RunsApi(client);
+
+    const result = await api.cancel("run_123", { reason: "no longer needed" });
+
+    expect(client.post).toHaveBeenCalledWith("/api/v3/runs/run_123/cancel", {
+      reason: "no longer needed",
+      force: false,
+      cancelQueuedChildren: true,
+    });
+    expect(result.status).toBe("CANCELED");
+  });
+
+  it("cancels runs sequentially for cancelMany", async () => {
+    const client = createApiClient();
+    const api = new RunsApi(client);
+
+    await api.cancelMany(["run_a", "run_b", "run_c"], { reason: "bulk stop" });
+
+    expect(client.post).toHaveBeenCalledTimes(3);
+  });
+
+  it("defaults to canceling queued children", async () => {
+    const client = createApiClient();
+    const api = new RunsApi(client);
+
+    await api.cancel("run_123");
+
+    expect(client.post).toHaveBeenCalledWith("/api/v3/runs/run_123/cancel", {
+      reason: undefined,
+      force: false,
+      cancelQueuedChildren: true,
+    });
+  });
+
+  it("passes force through for operational callers", async () => {
+    const client = createApiClient();
+    const api = new RunsApi(client);
+
+    await api.cancel("run_123", { force: true, cancelQueuedChildren: false });
+
+    expect(client.post).toHaveBeenCalledWith("/api/v3/runs/run_123/cancel", {
+      reason: undefined,
+      force: true,
+      cancelQueuedChildren: false,
+    });
+  });
+});
diff --git a/docs/runs/cancellation-operational-runbook.md b/docs/runs/cancellation-operational-runbook.md
new file mode 100644
index 0000000000..0000000018
--- /dev/null
+++ b/docs/runs/cancellation-operational-runbook.md
@@ -0,0 +1,148 @@
+# Cancel run operational runbook
+
+This runbook supports the v3 cancel-running-run API rollout. Use it when a user reports that a canceled run kept executing, retried, or produced external side effects after cancellation.
+
+## Required identifiers
+
+- Run friendly id
+- Internal run id
+- Latest attempt id
+- Runtime environment id
+- Worker id or coordinator socket id
+- Cancellation request timestamp
+- First retry or completion timestamp after cancellation
+
+## Investigation checklist
+
+### Check 1: API response
+
+- Inspect the run detail timeline for check 1.
+- Compare the previous status with the state transition contract for check 1.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 1.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 1.
+
+### Check 2: run state
+
+- Inspect the run detail timeline for check 2.
+- Compare the previous status with the state transition contract for check 2.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 2.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 2.
+
+### Check 3: attempt state
+
+- Inspect the run detail timeline for check 3.
+- Compare the previous status with the state transition contract for check 3.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 3.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 3.
+
+### Check 4: coordinator signal
+
+- Inspect the run detail timeline for check 4.
+- Compare the previous status with the state transition contract for check 4.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 4.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 4.
+
+### Check 5: queue marker
+
+- Inspect the run detail timeline for check 5.
+- Compare the previous status with the state transition contract for check 5.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 5.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 5.
+
+### Check 6: retry suppression
+
+- Inspect the run detail timeline for check 6.
+- Compare the previous status with the state transition contract for check 6.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 6.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 6.
+
+### Check 7: API response
+
+- Inspect the run detail timeline for check 7.
+- Compare the previous status with the state transition contract for check 7.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 7.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 7.
+
+### Check 8: run state
+
+- Inspect the run detail timeline for check 8.
+- Compare the previous status with the state transition contract for check 8.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 8.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 8.
+
+### Check 9: attempt state
+
+- Inspect the run detail timeline for check 9.
+- Compare the previous status with the state transition contract for check 9.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 9.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 9.
+
+### Check 10: coordinator signal
+
+- Inspect the run detail timeline for check 10.
+- Compare the previous status with the state transition contract for check 10.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 10.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 10.
+
+### Check 11: queue marker
+
+- Inspect the run detail timeline for check 11.
+- Compare the previous status with the state transition contract for check 11.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 11.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 11.
+
+### Check 12: retry suppression
+
+- Inspect the run detail timeline for check 12.
+- Compare the previous status with the state transition contract for check 12.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 12.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 12.
+
+### Check 13: API response
+
+- Inspect the run detail timeline for check 13.
+- Compare the previous status with the state transition contract for check 13.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 13.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 13.
+
+### Check 14: run state
+
+- Inspect the run detail timeline for check 14.
+- Compare the previous status with the state transition contract for check 14.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 14.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 14.
+
+### Check 15: attempt state
+
+- Inspect the run detail timeline for check 15.
+- Compare the previous status with the state transition contract for check 15.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 15.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 15.
+
+### Check 16: coordinator signal
+
+- Inspect the run detail timeline for check 16.
+- Compare the previous status with the state transition contract for check 16.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 16.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 16.
+
+### Check 17: queue marker
+
+- Inspect the run detail timeline for check 17.
+- Compare the previous status with the state transition contract for check 17.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 17.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 17.
+
+### Check 18: retry suppression
+
+- Inspect the run detail timeline for check 18.
+- Compare the previous status with the state transition contract for check 18.
+- Verify that retry activity after cancellation is explained by a new user action, not a stale attempt for check 18.
+- Capture the run friendly id, attempt id, environment id, and worker id for check 18.
+
+## Expected resolution notes
+
+- A cancellation that only changes the database row is an incomplete cancellation.
+- A retry scheduled after cancellation should be treated as a lifecycle bug unless it came from a fresh user action.
+- A worker that keeps executing after cancellation needs coordinator/runtime investigation.
+- A final run state moving back to an active state needs run-engine state-machine investigation.diff --git a/apps/webapp/app/v3/services/cancelRunningTaskRun.timeline.test.ts b/apps/webapp/app/v3/services/cancelRunningTaskRun.timeline.test.ts
new file mode 100644
index 0000000000..0000000019
--- /dev/null
+++ b/apps/webapp/app/v3/services/cancelRunningTaskRun.timeline.test.ts
@@ -0,0 +1,225 @@
+import { describe, expect, it } from "vitest";
+
+type TimelineEvent = {
+  name: string;
+  previousStatus: string;
+  nextStatus: string;
+  source: "api" | "worker" | "scheduler" | "coordinator";
+  shouldCreateAttempt: boolean;
+  shouldEmitWorkerSignal: boolean;
+  shouldRecordAuditEvent: boolean;
+};
+
+const timelineCases: TimelineEvent[] = [
+  {
+    name: "queued-cancel",
+    previousStatus: "QUEUED",
+    nextStatus: "CANCELED",
+    source: "api",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "dequeued-cancel",
+    previousStatus: "DEQUEUED",
+    nextStatus: "CANCELED",
+    source: "worker",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: true,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "executing-cancel",
+    previousStatus: "EXECUTING",
+    nextStatus: "CANCELED",
+    source: "scheduler",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: true,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "waitpoint-cancel",
+    previousStatus: "RETRYING_AFTER_FAILURE",
+    nextStatus: "CANCELED",
+    source: "coordinator",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: true,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "retrying-cancel",
+    previousStatus: "CANCELED",
+    nextStatus: "CANCELED",
+    source: "api",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "late-success-after-cancel",
+    previousStatus: "QUEUED",
+    nextStatus: "CANCELED",
+    source: "worker",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "late-failure-after-cancel",
+    previousStatus: "DEQUEUED",
+    nextStatus: "CANCELED",
+    source: "scheduler",
+    shouldCreateAttempt: true,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "lazy-retry-after-cancel",
+    previousStatus: "EXECUTING",
+    nextStatus: "CANCELED",
+    source: "coordinator",
+    shouldCreateAttempt: true,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "checkpoint-after-cancel",
+    previousStatus: "RETRYING_AFTER_FAILURE",
+    nextStatus: "CANCELED",
+    source: "api",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "resume-after-cancel",
+    previousStatus: "CANCELED",
+    nextStatus: "CANCELED",
+    source: "worker",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "bulk-cancel",
+    previousStatus: "QUEUED",
+    nextStatus: "CANCELED",
+    source: "scheduler",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "dev-disconnect-cancel",
+    previousStatus: "DEQUEUED",
+    nextStatus: "CANCELED",
+    source: "coordinator",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "heartbeat-timeout-cancel",
+    previousStatus: "EXECUTING",
+    nextStatus: "CANCELED",
+    source: "api",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "worker-crash-after-cancel",
+    previousStatus: "RETRYING_AFTER_FAILURE",
+    nextStatus: "CANCELED",
+    source: "worker",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: true,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "already-final-cancel",
+    previousStatus: "CANCELED",
+    nextStatus: "CANCELED",
+    source: "scheduler",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "sdk-retry-cancel",
+    previousStatus: "QUEUED",
+    nextStatus: "CANCELED",
+    source: "coordinator",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "dashboard-double-click",
+    previousStatus: "DEQUEUED",
+    nextStatus: "CANCELED",
+    source: "api",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "operator-force-cancel",
+    previousStatus: "EXECUTING",
+    nextStatus: "CANCELED",
+    source: "worker",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "queue-redelivery-cancel",
+    previousStatus: "RETRYING_AFTER_FAILURE",
+    nextStatus: "CANCELED",
+    source: "scheduler",
+    shouldCreateAttempt: false,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+  {
+    name: "marqs-nack-after-cancel",
+    previousStatus: "CANCELED",
+    nextStatus: "CANCELED",
+    source: "coordinator",
+    shouldCreateAttempt: true,
+    shouldEmitWorkerSignal: false,
+    shouldRecordAuditEvent: true,
+  },
+];
+
+describe("cancel run timeline contract", () => {
+  for (const event of timelineCases) {
+    it(`records ${event.name} with a coherent cancellation timeline`, () => {
+      expect(event.nextStatus).toBe("CANCELED");
+      expect(event.shouldRecordAuditEvent).toBe(true);
+    });
+  }
+
+  it("does not create attempts for normal cancellation cases", () => {
+    const normalCases = timelineCases.filter((event) => event.source !== "scheduler");
+    expect(normalCases.every((event) => !event.shouldCreateAttempt || event.previousStatus === "CANCELED")).toBe(true);
+  });
+
+  it("documents scheduler cases that require special review", () => {
+    const schedulerCases = timelineCases.filter((event) => event.source === "scheduler");
+    expect(schedulerCases.map((event) => event.name)).toEqual([
+      "executing-cancel",
+      "late-failure-after-cancel",
+      "checkpoint-after-cancel",
+      "already-final-cancel",
+      "queue-redelivery-cancel",
+    ]);
+  });
+
+  it("documents worker-signal cases separately from audit-only cases", () => {
+    const signalCases = timelineCases.filter((event) => event.shouldEmitWorkerSignal);
+    expect(signalCases.length).toBeGreaterThan(0);
+    expect(signalCases.every((event) => event.nextStatus === "CANCELED")).toBe(true);
+  });
+});
```

## Intended Flaws

### Flaw 1: Cancellation can be undone by the retry scheduler

- `type`: retry_semantics_bug
- `location`: `apps/webapp/app/v3/services/cancelAwareRetryScheduler.server.ts:42-78` and `apps/webapp/app/v3/services/cancelAwareRetryScheduler.test.ts:81-94`
- `learner_prompt`: Does a cancelled run remain terminal if an in-flight worker reports a retryable failure after the user cancels?

#### Expected Answer

- `identify`: The retry scheduler reads the run and then unconditionally updates it to `RETRYING_AFTER_FAILURE` and requeues work. It never treats `CANCELED`, `TIMED_OUT`, or other final states as blockers, never checks the cancellation table, and never performs the retry decision under the same lock or transaction as the terminal-state transition. The test matrix even blesses retrying when the current status is `CANCELED`.
- `impact`: A user can cancel an executing run, see `CANCELED` in the UI, and then the late failure callback from the old attempt can schedule a new attempt. That creates impossible timelines, duplicate external side effects, billing/usage confusion, and a cancellation API users cannot trust.
- `fix_direction`: Make cancellation and retry scheduling use the run engine's terminal-state transition rules. The retry path should acquire the same run lock or use an atomic conditional update that refuses to move any final state, especially `CANCELED` and `PENDING_CANCEL`, into `RETRYING_AFTER_FAILURE`. A durable cancellation marker or state version should be checked in the retry transaction before requeueing MarQS or lazy attempts.

### Flaw 1 Hints

1. Start with state-machine ownership. Which code path is allowed to move a terminal run back into an active status?
2. Inspect the retry scheduler, not only the cancel endpoint. What happens if completion and cancellation race?
3. The revealing evidence is the test matrix case that expects a run with status `CANCELED` to still return `retried`.

### Flaw 2: The API marks the database but never signals the running worker

- `type`: ownership_boundary_violation
- `location`: `apps/webapp/app/v3/services/cancelRunningTaskRun.server.ts:48-117` and `apps/webapp/app/v3/services/cancelRunCoordinatorClient.server.ts:14-52`
- `learner_prompt`: Does the cancel operation cross the platform boundary from persisted run state to the worker that is currently executing user code?

#### Expected Answer

- `identify`: The service constructs `CancelRunCoordinatorClient` but never calls it. It updates the run, marks attempts `CANCELED`, writes audit/timeline data, and returns success without emitting `REQUEST_RUN_CANCELLATION`, `REQUEST_ATTEMPT_CANCELLATION`, a queue cancellation key, or any SDK/runtime cancellation signal. The test suite also only asserts DB writes.
- `impact`: The dashboard says the run is cancelled while the worker may continue executing user code, sending emails, charging cards, writing files, or waiting on external APIs. When the worker later reports completion or failure, the platform has to reconcile a fake terminal DB state against real work that never stopped.
- `fix_direction`: Reuse or extend the existing cancellation service/run-engine path. A cancel should enter `PENDING_CANCEL` or atomically finalize only when the worker is known dead; otherwise it must notify the coordinator/socket, cancel checkpoints, set queue cancellation keys for delayed work, propagate an AbortSignal or runtime cancellation message to user code where supported, and only finalize according to the engine's lifecycle rules.

### Flaw 2 Hints

1. A database status is not the same thing as a distributed cancellation. Ask what process is still running after this API returns.
2. Look for whether the new service reuses the existing coordinator cancellation contract already present in Trigger.dev.
3. The client wrapper exists, but no path invokes `requestCancellation` or `requestAttemptCancellation` before returning success.

## Expected Answer

A strong answer should identify both flaws and explain them as lifecycle-contract bugs, not style issues.

For flaw 1, the learner should point to `CancelAwareRetryScheduler.scheduleAfterFailure` and the test matrix that expects retry after a `CANCELED` status. The important idea is that retry is also a state transition. If cancellation is terminal, retry must be unable to resurrect it, even when a stale attempt reports later.

For flaw 2, the learner should point to `CancelRunningTaskRunService.call`. The important idea is that Trigger.dev is a distributed execution platform. The API cannot claim cancellation by only writing Postgres rows. It has to signal the coordinator/worker/runtime and prevent delayed queue messages from executing.

A good fix answer should mention both atomic terminal-state protection and worker cancellation propagation. It should not propose merely adding another UI refresh, another log line, or a test that waits longer.

## Expert Debrief

### Product-Level Change

The PR tries to ship user-visible cancellation for running task runs. Product-wise, this is a trust feature: users click cancel because they believe the platform will stop future attempts and stop the current work as much as possible.

### Changed Contracts

- API contract: `POST /api/v3/runs/:runId/cancel` now promises a terminal user action.
- SDK contract: `runs.cancel(runId)` exposes that action programmatically.
- Run-state contract: active states can transition toward cancellation, but final states must not return to active execution.
- Queue contract: retry and delayed execution must observe cancellation.
- Worker/coordinator contract: executing workers must be told to exit or abort.
- Observability contract: timeline, audit, and metrics should describe what actually happened, not just what the database row says.

### Failure Modes

The dangerous production sequence is small but brutal:

1. A run is executing and the user clicks cancel.
2. The new service writes `CANCELED` and returns success.
3. The worker keeps running because it was never signaled.
4. The old attempt reports a retryable failure.
5. The retry scheduler updates the run to `RETRYING_AFTER_FAILURE` and requeues it.
6. A run the user cancelled now executes again.

That is the exact kind of bug large AI-generated PRs hide: every individual file looks plausible, but the system contract is broken between files.

### Reviewer Thought Process

A world-class reviewer would not start by asking whether the route parses JSON correctly. They would map the lifecycle:

- What are all states before and after cancellation?
- Which component owns terminal transitions?
- What else can move the same run after this write?
- Does the currently running worker know anything happened?
- Do delayed queue messages and lazy retries observe the same cancellation fact?
- Do tests cover the race that matters, or only the happy-path API response?

The key review move is to inspect both sides of the boundary: the database state machine and the process that is currently executing user code. Cancellation is only real when both are handled.

### Better Implementation Direction

The better implementation should be built around the existing run-engine cancellation path rather than a separate service that hand-writes statuses. The service should request cancellation through the engine, acquire the run lock or use an atomic conditional transition, emit coordinator messages for executing attempts, cancel checkpoints, mark delayed queue work with a cancellation key, and make retry scheduling refuse terminal or cancellation-pending runs in the same transaction that enqueues retry work.

Tests should include the race: cancel succeeds, then an old attempt completion with retry arrives, and no retry is scheduled. A second test should assert that an executing production run emits `REQUEST_RUN_CANCELLATION` or the equivalent engine cancellation message before the API reports success.

## Correctness Verdict Rubric

- `correct`: The answer identifies both the retry resurrection bug and the missing worker/coordinator signal, explains production impact, and proposes atomic terminal-state protection plus cancellation propagation.
- `partial`: The answer finds one intended flaw clearly, or vaguely mentions races/cancellation propagation without tying it to the relevant diff lines and contracts.
- `incorrect`: The answer focuses on superficial concerns such as route shape, SDK ergonomics, missing UI state, or logging while missing the lifecycle and distributed-execution failures.

## Why This Trains Engineering Judgment

Cancellation is a deceptively hard backend feature because it sounds like a button but behaves like a distributed protocol. This exercise trains the reviewer to protect terminal states, inspect retry paths, and separate persisted intent from actual worker behavior. That is a core skill for reviewing large PRs in systems with queues, long-running work, and external side effects.
