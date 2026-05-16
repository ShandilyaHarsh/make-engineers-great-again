# TS-041: Trigger.dev Retryable Run Completion Callbacks

## Metadata

- `id`: TS-041
- `source_repo`: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- `repo_area`: task run finalization, Redis workers, callback delivery, project API config, Prisma run/callback models, API tests
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1450
- `flaw_count`: 2

## PR Description Shown To Learner

This PR adds retryable run completion callbacks.

Customers can now configure a project callback URL that receives an HTTP POST whenever a task run reaches a final state. This is meant for teams that need to advance their own state machines after Trigger.dev finishes work, for example marking an import as complete, unlocking a workflow step, or recording the output of an async job.

The callback sender is backed by a Redis worker and retries failed deliveries. The PR adds a project API for creating callbacks, a finalization hook that enqueues callback deliveries, signed callback payloads, and tests for successful delivery, transient retry, and invalid-callback failures.

## Existing Code Context

The real Trigger.dev codebase already has these relevant contracts:

- `apps/webapp/app/v3/services/completeAttempt.server.ts` delegates final run state changes to `FinalizeTaskRunService`.
- `apps/webapp/app/v3/services/finalizeTaskRun.server.ts` acknowledges the run queue message, updates the task run to a final status, resumes dependent parents, finalizes batch state, and enqueues task-run alerts for failed runs.
- `apps/webapp/app/v3/services/alerts/performTaskRunAlerts.server.ts` finds alert channels and creates alert delivery work.
- `apps/webapp/app/v3/services/alerts/deliverAlert.server.ts` sends alert webhooks through a worker and marks alert rows as sent only after delivery.
- `apps/webapp/app/v3/alertsWorker.server.ts` uses `@trigger.dev/redis-worker` with worker-level retries.
- `packages/core/src/v3/utils/retries.ts` and realtime stream upload code treat retryable HTTP statuses narrowly, such as `408`, `429`, and `5xx`, rather than every `4xx`.
- Trigger.dev already has idempotency concepts for task triggering and batch triggering; repeated requests with the same idempotency key should not create duplicate run-side effects.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `internal-packages/database/prisma/schema.prisma`
- `apps/webapp/app/v3/services/finalizeTaskRun.server.ts`
- `apps/webapp/app/v3/services/completionCallbacks/performRunCompletionCallbacks.server.ts`
- `apps/webapp/app/v3/services/completionCallbacks/deliverRunCompletionCallback.server.ts`
- `apps/webapp/app/v3/completionCallbacksWorker.server.ts`
- `apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.ts`
- `apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.$callbackId.ts`
- `apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.$callbackId.deliveries.ts`
- `packages/core/src/v3/schemas/runCompletionCallbacks.ts`
- `apps/webapp/test/runCompletionCallbacks.test.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally a full-stack backend PR: data model, finalization integration, queue worker, delivery code, API contract, and tests.

## Diff

```diff
diff --git a/internal-packages/database/prisma/schema.prisma b/internal-packages/database/prisma/schema.prisma
index 6bdb82f640..311c5e2401 100644
--- a/internal-packages/database/prisma/schema.prisma
+++ b/internal-packages/database/prisma/schema.prisma
@@ -456,6 +456,8 @@ model Project {
   alertChannels                  ProjectAlertChannel[]
   alerts                         ProjectAlert[]
   alertStorages                  ProjectAlertStorage[]
+  completionCallbacks            ProjectCompletionCallback[]
+  completionCallbackDeliveries   TaskRunCompletionCallbackDelivery[]
 
   @@index([organizationId])
   @@index([externalRef])
@@ -984,6 +986,7 @@ model TaskRun {
   attempts                      TaskRunAttempt[]
   waits                         Waitpoint[]
   alerts                        ProjectAlert[]
+  completionCallbackDeliveries  TaskRunCompletionCallbackDelivery[]
 
   @@index([runtimeEnvironmentId, status])
   @@index([runtimeEnvironmentId, taskIdentifier])
@@ -2384,6 +2387,76 @@ model ProjectAlertStorage {
   @@unique([alertChannelId, alertType, storageId])
 }
 
+model ProjectCompletionCallback {
+  id             String   @id @default(cuid())
+  friendlyId     String   @unique
+  projectId      String
+  project        Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
+  environmentId  String?
+  environment    RuntimeEnvironment? @relation(fields: [environmentId], references: [id], onDelete: Cascade)
+
+  name           String
+  url            String
+  secret         String
+  enabled        Boolean  @default(true)
+  eventTypes     RunCompletionCallbackEventType[]
+  createdAt      DateTime @default(now())
+  updatedAt      DateTime @updatedAt
+
+  deliveries     TaskRunCompletionCallbackDelivery[]
+
+  @@index([projectId, enabled])
+  @@index([environmentId, enabled])
+}
+
+model TaskRunCompletionCallbackDelivery {
+  id            String   @id @default(cuid())
+  friendlyId    String   @unique
+  projectId     String
+  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
+  callbackId    String
+  callback      ProjectCompletionCallback @relation(fields: [callbackId], references: [id], onDelete: Cascade)
+  taskRunId     String
+  taskRun       TaskRun  @relation(fields: [taskRunId], references: [id], onDelete: Cascade)
+  eventType     RunCompletionCallbackEventType
+  status        RunCompletionCallbackDeliveryStatus @default(PENDING)
+  attemptCount  Int      @default(0)
+  lastStatus    Int?
+  lastError     String?
+  deliveredAt   DateTime?
+  createdAt     DateTime @default(now())
+  updatedAt     DateTime @updatedAt
+
+  @@index([projectId, status])
+  @@index([taskRunId])
+  @@index([callbackId, status])
+}
+
+enum RunCompletionCallbackEventType {
+  RUN_COMPLETED
+  RUN_FAILED
+  RUN_CANCELED
+}
+
+enum RunCompletionCallbackDeliveryStatus {
+  PENDING
+  SENDING
+  DELIVERED
+  FAILED_RETRYABLE
+  FAILED_PERMANENT
+}
+
 model RuntimeEnvironmentSession {
   id               String             @id @default(cuid())
   friendlyId       String             @unique
diff --git a/apps/webapp/app/v3/services/finalizeTaskRun.server.ts b/apps/webapp/app/v3/services/finalizeTaskRun.server.ts
index 31fca6ab0a..222c41dd89 100644
--- a/apps/webapp/app/v3/services/finalizeTaskRun.server.ts
+++ b/apps/webapp/app/v3/services/finalizeTaskRun.server.ts
@@ -15,6 +15,7 @@ import { ResumeBatchRunService } from "./resumeBatchRun.server";
 import { ResumeDependentParentsService } from "./resumeDependentParents.server";
 import { PerformTaskRunAlertsService } from "./alerts/performTaskRunAlerts.server";
+import { PerformRunCompletionCallbacksService } from "./completionCallbacks/performRunCompletionCallbacks.server";
 
 type BaseInput = {
   id: string;
@@ -139,6 +140,16 @@ export class FinalizeTaskRunService extends BaseService {
       });
     }
 
+    try {
+      await PerformRunCompletionCallbacksService.enqueue(run.id);
+    } catch (completionCallbackError) {
+      logger.error("FinalizeTaskRunService: Failed to enqueue run completion callbacks", {
+        runId: run.id,
+        status: run.status,
+        error: completionCallbackError,
+      });
+    }
+
     //enqueue alert
     if (isFailedRunStatus(run.status)) {
       await PerformTaskRunAlertsService.enqueue(run.id);
diff --git a/apps/webapp/app/v3/services/completionCallbacks/performRunCompletionCallbacks.server.ts b/apps/webapp/app/v3/services/completionCallbacks/performRunCompletionCallbacks.server.ts
new file mode 100644
index 0000000000..481137fbd0
--- /dev/null
+++ b/apps/webapp/app/v3/services/completionCallbacks/performRunCompletionCallbacks.server.ts
@@ -0,0 +1,264 @@
+import {
+  type Prisma,
+  type ProjectCompletionCallback,
+  type RunCompletionCallbackEventType,
+  type TaskRun,
+} from "@trigger.dev/database";
+import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
+import { completionCallbacksWorker } from "~/v3/completionCallbacksWorker.server";
+import { logger } from "~/services/logger.server";
+import { BaseService } from "../baseService.server";
+
+type FoundRun = Prisma.TaskRunGetPayload<{
+  include: {
+    runtimeEnvironment: {
+      include: {
+        parentEnvironment: true;
+      };
+    };
+    lockedBy: true;
+    lockedToVersion: true;
+    batch: true;
+  };
+}>;
+
+export class PerformRunCompletionCallbacksService extends BaseService {
+  public async call(runId: string) {
+    const run = await this._prisma.taskRun.findFirst({
+      where: { id: runId },
+      include: {
+        runtimeEnvironment: {
+          include: {
+            parentEnvironment: true,
+          },
+        },
+        lockedBy: true,
+        lockedToVersion: true,
+        batch: true,
+      },
+    });
+
+    if (!run) {
+      logger.warn("[RunCompletionCallbacks] Run not found", { runId });
+      return;
+    }
+
+    const eventType = this.#eventTypeFromRun(run);
+    if (!eventType) {
+      logger.debug("[RunCompletionCallbacks] Run is not in a callback-supported final state", {
+        runId: run.id,
+        status: run.status,
+      });
+      return;
+    }
+
+    const parentEnvironmentType =
+      run.runtimeEnvironment.parentEnvironment?.type ?? run.runtimeEnvironment.type;
+
+    const callbacks = await this._prisma.projectCompletionCallback.findMany({
+      where: {
+        projectId: run.projectId,
+        enabled: true,
+        eventTypes: {
+          has: eventType,
+        },
+        OR: [
+          { environmentId: null },
+          { environmentId: run.runtimeEnvironmentId },
+          {
+            environment: {
+              type: parentEnvironmentType,
+            },
+          },
+        ],
+      },
+      orderBy: {
+        createdAt: "asc",
+      },
+    });
+
+    if (callbacks.length === 0) {
+      return;
+    }
+
+    for (const callback of callbacks) {
+      await this.#createAndSendDelivery(callback, run, eventType);
+    }
+  }
+
+  async #createAndSendDelivery(
+    callback: ProjectCompletionCallback,
+    run: FoundRun,
+    eventType: RunCompletionCallbackEventType
+  ) {
+    const delivery = await this._prisma.taskRunCompletionCallbackDelivery.create({
+      data: {
+        friendlyId: generateFriendlyId("rcd"),
+        projectId: run.projectId,
+        callbackId: callback.id,
+        taskRunId: run.id,
+        eventType,
+        status: "PENDING",
+      },
+      select: {
+        id: true,
+        friendlyId: true,
+      },
+    });
+
+    await DeliverRunCompletionCallbackService.enqueue(delivery.id);
+  }
+
+  #eventTypeFromRun(run: TaskRun): RunCompletionCallbackEventType | undefined {
+    switch (run.status) {
+      case "COMPLETED_SUCCESSFULLY":
+        return "RUN_COMPLETED";
+      case "COMPLETED_WITH_ERRORS":
+      case "SYSTEM_FAILURE":
+      case "CRASHED":
+      case "TIMED_OUT":
+      case "INTERRUPTED":
+      case "EXPIRED":
+        return "RUN_FAILED";
+      case "CANCELED":
+        return "RUN_CANCELED";
+      default:
+        return undefined;
+    }
+  }
+
+  static async enqueue(runId: string, runAt?: Date) {
+    return await completionCallbacksWorker.enqueue({
+      id: `performRunCompletionCallbacks:${runId}:${Date.now()}`,
+      job: "v3.performRunCompletionCallbacks",
+      payload: { runId },
+      availableAt: runAt,
+    });
+  }
+}
+
+class DeliverRunCompletionCallbackService {
+  static async enqueue(deliveryId: string, runAt?: Date) {
+    return await completionCallbacksWorker.enqueue({
+      id: `deliverRunCompletionCallback:${deliveryId}:${Date.now()}`,
+      job: "v3.deliverRunCompletionCallback",
+      payload: { deliveryId },
+      availableAt: runAt,
+    });
+  }
+}
diff --git a/apps/webapp/app/v3/services/completionCallbacks/deliverRunCompletionCallback.server.ts b/apps/webapp/app/v3/services/completionCallbacks/deliverRunCompletionCallback.server.ts
new file mode 100644
index 0000000000..b6df878bc1
--- /dev/null
+++ b/apps/webapp/app/v3/services/completionCallbacks/deliverRunCompletionCallback.server.ts
@@ -0,0 +1,426 @@
+import { RunCompletionCallbackDeliveryStatus } from "@trigger.dev/database";
+import { subtle } from "crypto";
+import { env } from "~/env.server";
+import { decryptSecret } from "~/services/secrets/secretStore.server";
+import { logger } from "~/services/logger.server";
+import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
+import { CURRENT_API_VERSION } from "~/api/versions";
+import { v3RunPath } from "~/utils/pathBuilder";
+import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
+import { BaseService } from "../baseService.server";
+
+type FoundDelivery = Awaited<ReturnType<DeliverRunCompletionCallbackService["#findDelivery"]>>;
+
+class RetryableCallbackError extends Error {
+  constructor(
+    message: string,
+    public readonly status?: number,
+    public readonly responseBody?: string
+  ) {
+    super(message);
+    this.name = "RetryableCallbackError";
+  }
+}
+
+export class DeliverRunCompletionCallbackService extends BaseService {
+  public async call(deliveryId: string) {
+    const delivery = await this.#findDelivery(deliveryId);
+
+    if (!delivery) {
+      logger.warn("[RunCompletionCallback] Delivery not found", { deliveryId });
+      return;
+    }
+
+    if (!delivery.callback.enabled) {
+      await this.#markPermanentFailure(delivery.id, "callback_disabled");
+      return;
+    }
+
+    if (delivery.status === "DELIVERED") {
+      logger.debug("[RunCompletionCallback] Delivery already sent", {
+        deliveryId: delivery.id,
+      });
+      return;
+    }
+
+    await this._prisma.taskRunCompletionCallbackDelivery.update({
+      where: { id: delivery.id },
+      data: {
+        status: "SENDING",
+        attemptCount: {
+          increment: 1,
+        },
+      },
+    });
+
+    const payload = this.#buildPayload(delivery);
+    const rawPayload = JSON.stringify(payload);
+    const signature = await this.#signPayload(rawPayload, delivery.callback.secret);
+
+    try {
+      const response = await fetch(delivery.callback.url, {
+        method: "POST",
+        headers: {
+          "content-type": "application/json",
+          "user-agent": "Trigger.dev Run Completion Callback",
+          "x-trigger-signature-hmacsha256": signature,
+          "x-trigger-callback-id": delivery.callback.friendlyId,
+          "x-trigger-callback-delivery-id": delivery.friendlyId,
+          "x-trigger-callback-attempt": String(delivery.attemptCount + 1),
+          "x-trigger-callback-created-at": new Date().toISOString(),
+        },
+        body: rawPayload,
+        signal: AbortSignal.timeout(10_000),
+      });
+
+      if (!response.ok) {
+        const responseBody = await response.text().catch(() => "");
+        throw new RetryableCallbackError(
+          `Callback failed with ${response.status}`,
+          response.status,
+          responseBody
+        );
+      }
+
+      await this._prisma.taskRunCompletionCallbackDelivery.update({
+        where: { id: delivery.id },
+        data: {
+          status: "DELIVERED",
+          deliveredAt: new Date(),
+          lastStatus: response.status,
+          lastError: null,
+        },
+      });
+    } catch (error) {
+      await this.#recordRetryableFailure(delivery.id, error);
+      throw error;
+    }
+  }
+
+  async #findDelivery(deliveryId: string) {
+    return await this._prisma.taskRunCompletionCallbackDelivery.findFirst({
+      where: { id: deliveryId },
+      include: {
+        callback: true,
+        taskRun: {
+          include: {
+            runtimeEnvironment: {
+              include: {
+                project: {
+                  include: {
+                    organization: true,
+                  },
+                },
+              },
+            },
+            lockedBy: true,
+            lockedToVersion: true,
+            batch: true,
+          },
+        },
+      },
+    });
+  }
+
+  #buildPayload(delivery: NonNullable<FoundDelivery>) {
+    const run = delivery.taskRun;
+    const environment = run.runtimeEnvironment;
+    const project = environment.project;
+    const organization = project.organization;
+    const presenter = new ApiRetrieveRunPresenter(CURRENT_API_VERSION);
+
+    return {
+      id: generateFriendlyId("rce"),
+      created: new Date().toISOString(),
+      type: this.#publicEventType(delivery.eventType),
+      object: {
+        run: {
+          id: run.friendlyId,
+          number: run.number,
+          status: presenter.apiStatusFromRunStatus(run.status),
+          taskIdentifier: run.taskIdentifier,
+          createdAt: run.createdAt,
+          startedAt: run.startedAt ?? undefined,
+          completedAt: run.completedAt ?? undefined,
+          idempotencyKey: run.idempotencyKey ?? undefined,
+          tags: run.runTags,
+          output: run.output,
+          outputType: run.outputType,
+          error: run.error,
+          dashboardUrl: `${env.APP_ORIGIN}${v3RunPath(
+            organization,
+            project,
+            environment,
+            run
+          )}`,
+        },
+        task: {
+          id: run.taskIdentifier,
+          filePath: run.lockedBy?.filePath ?? "Unknown",
+          exportName: run.lockedBy?.exportName ?? "Unknown",
+          version: run.lockedToVersion?.version ?? "Unknown",
+        },
+        batch: run.batch
+          ? {
+              id: run.batch.friendlyId,
+            }
+          : undefined,
+        environment: {
+          id: environment.id,
+          type: environment.type,
+          slug: environment.slug,
+          branchName: environment.branchName ?? undefined,
+        },
+        organization: {
+          id: organization.id,
+          slug: organization.slug,
+          name: organization.title,
+        },
+        project: {
+          id: project.id,
+          ref: project.externalRef,
+          slug: project.slug,
+          name: project.name,
+        },
+      },
+    };
+  }
+
+  #publicEventType(eventType: NonNullable<FoundDelivery>["eventType"]) {
+    switch (eventType) {
+      case "RUN_COMPLETED":
+        return "run.completed";
+      case "RUN_FAILED":
+        return "run.failed";
+      case "RUN_CANCELED":
+        return "run.canceled";
+    }
+  }
+
+  async #signPayload(rawPayload: string, encryptedSecret: string) {
+    const secret = await decryptSecret(env.ENCRYPTION_KEY, encryptedSecret);
+    const hashPayload = Buffer.from(rawPayload, "utf-8");
+    const hmacSecret = Buffer.from(secret, "utf-8");
+    const key = await subtle.importKey(
+      "raw",
+      hmacSecret,
+      { name: "HMAC", hash: "SHA-256" },
+      false,
+      ["sign"]
+    );
+    const signature = await subtle.sign("HMAC", key, hashPayload);
+
+    return Buffer.from(signature).toString("hex");
+  }
+
+  async #recordRetryableFailure(deliveryId: string, error: unknown) {
+    const status = error instanceof RetryableCallbackError ? error.status : undefined;
+    const responseBody = error instanceof RetryableCallbackError ? error.responseBody : undefined;
+
+    await this._prisma.taskRunCompletionCallbackDelivery.update({
+      where: { id: deliveryId },
+      data: {
+        status: "FAILED_RETRYABLE",
+        lastStatus: status,
+        lastError: this.#formatError(error, responseBody),
+      },
+    });
+  }
+
+  async #markPermanentFailure(deliveryId: string, reason: string) {
+    await this._prisma.taskRunCompletionCallbackDelivery.update({
+      where: { id: deliveryId },
+      data: {
+        status: "FAILED_PERMANENT",
+        lastError: reason,
+      },
+    });
+  }
+
+  #formatError(error: unknown, responseBody?: string) {
+    if (error instanceof Error) {
+      return responseBody ? `${error.message}: ${responseBody.slice(0, 500)}` : error.message;
+    }
+
+    return String(error);
+  }
+
+  static async enqueue(deliveryId: string, runAt?: Date) {
+    return await completionCallbacksWorker.enqueue({
+      id: `deliverRunCompletionCallback:${deliveryId}:${Date.now()}`,
+      job: "v3.deliverRunCompletionCallback",
+      payload: { deliveryId },
+      availableAt: runAt,
+    });
+  }
+}
diff --git a/apps/webapp/app/v3/completionCallbacksWorker.server.ts b/apps/webapp/app/v3/completionCallbacksWorker.server.ts
new file mode 100644
index 0000000000..c64adcf270
--- /dev/null
+++ b/apps/webapp/app/v3/completionCallbacksWorker.server.ts
@@ -0,0 +1,144 @@
+import { Logger } from "@trigger.dev/core/logger";
+import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
+import { z } from "zod";
+import { env } from "~/env.server";
+import { logger } from "~/services/logger.server";
+import { singleton } from "~/utils/singleton";
+import { DeliverRunCompletionCallbackService } from "./services/completionCallbacks/deliverRunCompletionCallback.server";
+import { PerformRunCompletionCallbacksService } from "./services/completionCallbacks/performRunCompletionCallbacks.server";
+
+function initializeWorker() {
+  const redisOptions = {
+    keyPrefix: "run-completion-callbacks:",
+    host: env.ALERTS_WORKER_REDIS_HOST,
+    port: env.ALERTS_WORKER_REDIS_PORT,
+    username: env.ALERTS_WORKER_REDIS_USERNAME,
+    password: env.ALERTS_WORKER_REDIS_PASSWORD,
+    enableAutoPipelining: true,
+    ...(env.ALERTS_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
+  };
+
+  logger.debug("[RunCompletionCallbacks] Initializing worker", {
+    host: env.ALERTS_WORKER_REDIS_HOST,
+  });
+
+  const worker = new RedisWorker({
+    name: "run-completion-callbacks-worker",
+    redisOptions,
+    catalog: {
+      "v3.performRunCompletionCallbacks": {
+        schema: z.object({
+          runId: z.string(),
+        }),
+        visibilityTimeoutMs: 60_000,
+        retry: {
+          maxAttempts: 5,
+          minTimeoutInMs: 1_000,
+          maxTimeoutInMs: 60_000,
+        },
+        logErrors: true,
+      },
+      "v3.deliverRunCompletionCallback": {
+        schema: z.object({
+          deliveryId: z.string(),
+        }),
+        visibilityTimeoutMs: 30_000,
+        retry: {
+          maxAttempts: 5,
+          minTimeoutInMs: 1_000,
+          maxTimeoutInMs: 60_000,
+        },
+        logErrors: true,
+      },
+    },
+    concurrency: {
+      workers: env.ALERTS_WORKER_CONCURRENCY_WORKERS,
+      tasksPerWorker: env.ALERTS_WORKER_CONCURRENCY_TASKS_PER_WORKER,
+      limit: env.ALERTS_WORKER_CONCURRENCY_LIMIT,
+    },
+    pollIntervalMs: env.ALERTS_WORKER_POLL_INTERVAL,
+    immediatePollIntervalMs: env.ALERTS_WORKER_IMMEDIATE_POLL_INTERVAL,
+    shutdownTimeoutMs: env.ALERTS_WORKER_SHUTDOWN_TIMEOUT_MS,
+    logger: new Logger("RunCompletionCallbacksWorker", env.ALERTS_WORKER_LOG_LEVEL),
+    jobs: {
+      "v3.performRunCompletionCallbacks": async ({ payload }) => {
+        const service = new PerformRunCompletionCallbacksService();
+        await service.call(payload.runId);
+      },
+      "v3.deliverRunCompletionCallback": async ({ payload }) => {
+        const service = new DeliverRunCompletionCallbackService();
+        await service.call(payload.deliveryId);
+      },
+    },
+  });
+
+  if (env.ALERTS_WORKER_ENABLED === "true") {
+    logger.debug("[RunCompletionCallbacks] Starting worker", {
+      pollInterval: env.ALERTS_WORKER_POLL_INTERVAL,
+      immediatePollInterval: env.ALERTS_WORKER_IMMEDIATE_POLL_INTERVAL,
+      workers: env.ALERTS_WORKER_CONCURRENCY_WORKERS,
+      tasksPerWorker: env.ALERTS_WORKER_CONCURRENCY_TASKS_PER_WORKER,
+      concurrencyLimit: env.ALERTS_WORKER_CONCURRENCY_LIMIT,
+    });
+    worker.start();
+  }
+
+  return worker;
+}
+
+export const completionCallbacksWorker = singleton(
+  "completionCallbacksWorker",
+  initializeWorker
+);
diff --git a/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.ts b/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.ts
new file mode 100644
index 0000000000..e1538d19f8
--- /dev/null
+++ b/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.ts
@@ -0,0 +1,248 @@
+import { json } from "@remix-run/server-runtime";
+import { z } from "zod";
+import { prisma } from "~/db.server";
+import { createActionApiRoute, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
+import { encryptSecret } from "~/services/secrets/secretStore.server";
+import { env } from "~/env.server";
+import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
+import {
+  CreateRunCompletionCallbackBody,
+  RunCompletionCallbackPresenter,
+} from "@trigger.dev/core/v3/runCompletionCallbacks";
+
+const ParamsSchema = z.object({
+  projectRef: z.string(),
+});
+
+async function findProject(projectRef: string, environmentId: string) {
+  return await prisma.project.findFirst({
+    where: {
+      externalRef: projectRef,
+      environments: {
+        some: {
+          id: environmentId,
+        },
+      },
+    },
+    include: {
+      environments: true,
+    },
+  });
+}
+
+export const loader = createLoaderApiRoute(
+  {
+    params: ParamsSchema,
+    allowJWT: true,
+    corsStrategy: "all",
+    findResource: async (params, auth) => {
+      return await findProject(params.projectRef, auth.environment.id);
+    },
+    authorization: {
+      action: "read",
+      resource: (project) => ({ type: "projects", id: project.externalRef }),
+    },
+  },
+  async ({ resource }) => {
+    const callbacks = await prisma.projectCompletionCallback.findMany({
+      where: {
+        projectId: resource.id,
+      },
+      orderBy: {
+        createdAt: "desc",
+      },
+    });
+
+    return json({
+      data: callbacks.map((callback) => RunCompletionCallbackPresenter.present(callback)),
+    });
+  }
+);
+
+const { action } = createActionApiRoute(
+  {
+    params: ParamsSchema,
+    body: CreateRunCompletionCallbackBody,
+    allowJWT: true,
+    corsStrategy: "all",
+    method: "POST",
+    findResource: async (params, auth) => {
+      return await findProject(params.projectRef, auth.environment.id);
+    },
+    authorization: {
+      action: "write",
+      resource: (params) => ({ type: "projects", id: params.projectRef }),
+    },
+  },
+  async ({ body, authentication, resource }) => {
+    const encryptedSecret = await encryptSecret(
+      env.ENCRYPTION_KEY,
+      body.secret ?? crypto.randomUUID()
+    );
+
+    const callback = await prisma.projectCompletionCallback.create({
+      data: {
+        friendlyId: generateFriendlyId("rcc"),
+        projectId: resource!.id,
+        environmentId: body.environmentId ?? authentication.environment.id,
+        name: body.name,
+        url: body.url,
+        secret: encryptedSecret,
+        enabled: body.enabled ?? true,
+        eventTypes: body.eventTypes,
+      },
+    });
+
+    return json(
+      {
+        data: RunCompletionCallbackPresenter.present(callback),
+      },
+      { status: 201 }
+    );
+  }
+);
+
+export { action };
diff --git a/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.$callbackId.ts b/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.$callbackId.ts
new file mode 100644
index 0000000000..da19630b18
--- /dev/null
+++ b/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.$callbackId.ts
@@ -0,0 +1,304 @@
+import { json } from "@remix-run/server-runtime";
+import { z } from "zod";
+import { prisma } from "~/db.server";
+import {
+  createActionApiRoute,
+  createLoaderApiRoute,
+} from "~/services/routeBuilders/apiBuilder.server";
+import { encryptSecret } from "~/services/secrets/secretStore.server";
+import { env } from "~/env.server";
+import {
+  RunCompletionCallbackEventType,
+  RunCompletionCallbackPresenter,
+} from "@trigger.dev/core/v3/runCompletionCallbacks";
+
+const ParamsSchema = z.object({
+  projectRef: z.string(),
+  callbackId: z.string(),
+});
+
+const UpdateRunCompletionCallbackBody = z.object({
+  name: z.string().min(1).max(120).optional(),
+  url: z.string().url().optional(),
+  secret: z.string().min(16).max(2048).optional(),
+  enabled: z.boolean().optional(),
+  environmentId: z.string().nullable().optional(),
+  eventTypes: z.array(RunCompletionCallbackEventType).min(1).max(3).optional(),
+});
+
+async function findProject(projectRef: string, environmentId: string) {
+  return await prisma.project.findFirst({
+    where: {
+      externalRef: projectRef,
+      environments: {
+        some: {
+          id: environmentId,
+        },
+      },
+    },
+    include: {
+      environments: true,
+    },
+  });
+}
+
+async function findCallback({
+  projectRef,
+  environmentId,
+  callbackId,
+}: {
+  projectRef: string;
+  environmentId: string;
+  callbackId: string;
+}) {
+  const project = await findProject(projectRef, environmentId);
+  if (!project) {
+    return;
+  }
+
+  const callback = await prisma.projectCompletionCallback.findFirst({
+    where: {
+      friendlyId: callbackId,
+      projectId: project.id,
+    },
+  });
+
+  if (!callback) {
+    return;
+  }
+
+  return {
+    project,
+    callback,
+  };
+}
+
+export const loader = createLoaderApiRoute(
+  {
+    params: ParamsSchema,
+    allowJWT: true,
+    corsStrategy: "all",
+    findResource: async (params, auth) => {
+      return await findCallback({
+        projectRef: params.projectRef,
+        callbackId: params.callbackId,
+        environmentId: auth.environment.id,
+      });
+    },
+    authorization: {
+      action: "read",
+      resource: (resource) => ({ type: "projects", id: resource.project.externalRef }),
+    },
+  },
+  async ({ resource }) => {
+    return json({
+      data: RunCompletionCallbackPresenter.present(resource.callback),
+    });
+  }
+);
+
+const { action: patchAction } = createActionApiRoute(
+  {
+    params: ParamsSchema,
+    body: UpdateRunCompletionCallbackBody,
+    allowJWT: true,
+    corsStrategy: "all",
+    method: "PATCH",
+    findResource: async (params, auth) => {
+      return await findCallback({
+        projectRef: params.projectRef,
+        callbackId: params.callbackId,
+        environmentId: auth.environment.id,
+      });
+    },
+    authorization: {
+      action: "write",
+      resource: (params) => ({ type: "projects", id: params.projectRef }),
+    },
+  },
+  async ({ body, resource }) => {
+    const encryptedSecret = body.secret
+      ? await encryptSecret(env.ENCRYPTION_KEY, body.secret)
+      : undefined;
+
+    const callback = await prisma.projectCompletionCallback.update({
+      where: {
+        id: resource!.callback.id,
+      },
+      data: {
+        name: body.name,
+        url: body.url,
+        secret: encryptedSecret,
+        enabled: body.enabled,
+        environmentId: body.environmentId === undefined ? undefined : body.environmentId,
+        eventTypes: body.eventTypes,
+      },
+    });
+
+    return json({
+      data: RunCompletionCallbackPresenter.present(callback),
+    });
+  }
+);
+
+const DeleteBody = z.object({
+  reason: z.string().max(250).optional(),
+});
+
+const { action: deleteAction } = createActionApiRoute(
+  {
+    params: ParamsSchema,
+    body: DeleteBody,
+    allowJWT: true,
+    corsStrategy: "all",
+    method: "DELETE",
+    findResource: async (params, auth) => {
+      return await findCallback({
+        projectRef: params.projectRef,
+        callbackId: params.callbackId,
+        environmentId: auth.environment.id,
+      });
+    },
+    authorization: {
+      action: "write",
+      resource: (params) => ({ type: "projects", id: params.projectRef }),
+    },
+  },
+  async ({ resource, body }) => {
+    await prisma.projectCompletionCallback.update({
+      where: {
+        id: resource!.callback.id,
+      },
+      data: {
+        enabled: false,
+      },
+    });
+
+    return json({
+      deleted: true,
+      reason: body.reason,
+    });
+  }
+);
+
+export async function action(args: Parameters<typeof patchAction>[0]) {
+  switch (args.request.method.toUpperCase()) {
+    case "PATCH":
+      return patchAction(args);
+    case "DELETE":
+      return deleteAction(args);
+    default:
+      return json(
+        { error: "Method not allowed" },
+        { status: 405, headers: { Allow: "PATCH, DELETE" } }
+      );
+  }
+}
diff --git a/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.$callbackId.deliveries.ts b/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.$callbackId.deliveries.ts
new file mode 100644
index 0000000000..9520e30eac
--- /dev/null
+++ b/apps/webapp/app/routes/api.v3.projects.$projectRef.completion-callbacks.$callbackId.deliveries.ts
@@ -0,0 +1,258 @@
+import { json } from "@remix-run/server-runtime";
+import { z } from "zod";
+import { prisma } from "~/db.server";
+import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
+
+const ParamsSchema = z.object({
+  projectRef: z.string(),
+  callbackId: z.string(),
+});
+
+const SearchParamsSchema = z.object({
+  status: z
+    .enum(["PENDING", "SENDING", "DELIVERED", "FAILED_RETRYABLE", "FAILED_PERMANENT"])
+    .optional(),
+  runId: z.string().optional(),
+  cursor: z.string().optional(),
+  limit: z.coerce.number().int().min(1).max(100).default(25),
+});
+
+async function findProject(projectRef: string, environmentId: string) {
+  return await prisma.project.findFirst({
+    where: {
+      externalRef: projectRef,
+      environments: {
+        some: {
+          id: environmentId,
+        },
+      },
+    },
+  });
+}
+
+async function findCallback({
+  projectRef,
+  environmentId,
+  callbackId,
+}: {
+  projectRef: string;
+  environmentId: string;
+  callbackId: string;
+}) {
+  const project = await findProject(projectRef, environmentId);
+  if (!project) {
+    return;
+  }
+
+  const callback = await prisma.projectCompletionCallback.findFirst({
+    where: {
+      friendlyId: callbackId,
+      projectId: project.id,
+    },
+  });
+
+  if (!callback) {
+    return;
+  }
+
+  return {
+    project,
+    callback,
+  };
+}
+
+export const loader = createLoaderApiRoute(
+  {
+    params: ParamsSchema,
+    searchParams: SearchParamsSchema,
+    allowJWT: true,
+    corsStrategy: "all",
+    findResource: async (params, auth) => {
+      return await findCallback({
+        projectRef: params.projectRef,
+        callbackId: params.callbackId,
+        environmentId: auth.environment.id,
+      });
+    },
+    authorization: {
+      action: "read",
+      resource: (resource) => ({ type: "projects", id: resource.project.externalRef }),
+    },
+  },
+  async ({ resource, searchParams }) => {
+    const take = searchParams.limit + 1;
+    const deliveries = await prisma.taskRunCompletionCallbackDelivery.findMany({
+      where: {
+        projectId: resource.project.id,
+        callbackId: resource.callback.id,
+        status: searchParams.status,
+        taskRun: searchParams.runId
+          ? {
+              friendlyId: searchParams.runId,
+            }
+          : undefined,
+      },
+      include: {
+        taskRun: {
+          select: {
+            friendlyId: true,
+            taskIdentifier: true,
+            status: true,
+            completedAt: true,
+          },
+        },
+      },
+      orderBy: {
+        createdAt: "desc",
+      },
+      cursor: searchParams.cursor
+        ? {
+            friendlyId: searchParams.cursor,
+          }
+        : undefined,
+      skip: searchParams.cursor ? 1 : 0,
+      take,
+    });
+
+    const hasMore = deliveries.length > searchParams.limit;
+    const page = hasMore ? deliveries.slice(0, searchParams.limit) : deliveries;
+    const nextCursor = hasMore ? page[page.length - 1]?.friendlyId : undefined;
+
+    return json({
+      data: page.map((delivery) => ({
+        id: delivery.friendlyId,
+        callbackId: resource.callback.friendlyId,
+        run: {
+          id: delivery.taskRun.friendlyId,
+          taskIdentifier: delivery.taskRun.taskIdentifier,
+          status: delivery.taskRun.status,
+          completedAt: delivery.taskRun.completedAt,
+        },
+        eventType: delivery.eventType,
+        status: delivery.status,
+        attemptCount: delivery.attemptCount,
+        lastStatus: delivery.lastStatus,
+        lastError: delivery.lastError,
+        deliveredAt: delivery.deliveredAt,
+        createdAt: delivery.createdAt,
+        updatedAt: delivery.updatedAt,
+      })),
+      pagination: {
+        hasMore,
+        nextCursor,
+      },
+    });
+  }
+);
diff --git a/packages/core/src/v3/schemas/runCompletionCallbacks.ts b/packages/core/src/v3/schemas/runCompletionCallbacks.ts
new file mode 100644
index 0000000000..5dc57bfcc4
--- /dev/null
+++ b/packages/core/src/v3/schemas/runCompletionCallbacks.ts
@@ -0,0 +1,188 @@
+import { z } from "zod";
+
+export const RunCompletionCallbackEventType = z.enum([
+  "RUN_COMPLETED",
+  "RUN_FAILED",
+  "RUN_CANCELED",
+]);
+
+export const CreateRunCompletionCallbackBody = z.object({
+  name: z.string().min(1).max(120),
+  url: z.string().url(),
+  secret: z.string().min(16).max(2048).optional(),
+  enabled: z.boolean().optional(),
+  environmentId: z.string().optional(),
+  eventTypes: z.array(RunCompletionCallbackEventType).min(1).max(3),
+});
+
+export const RunCompletionCallbackResponse = z.object({
+  id: z.string(),
+  name: z.string(),
+  url: z.string(),
+  enabled: z.boolean(),
+  environmentId: z.string().nullable(),
+  eventTypes: z.array(RunCompletionCallbackEventType),
+  createdAt: z.string(),
+  updatedAt: z.string(),
+});
+
+export const RunCompletionCallbackDeliveryResponse = z.object({
+  id: z.string(),
+  callbackId: z.string(),
+  run: z.object({
+    id: z.string(),
+    taskIdentifier: z.string(),
+    status: z.string(),
+    completedAt: z.string().or(z.date()).nullable(),
+  }),
+  eventType: RunCompletionCallbackEventType,
+  status: z.enum([
+    "PENDING",
+    "SENDING",
+    "DELIVERED",
+    "FAILED_RETRYABLE",
+    "FAILED_PERMANENT",
+  ]),
+  attemptCount: z.number(),
+  lastStatus: z.number().nullable(),
+  lastError: z.string().nullable(),
+  deliveredAt: z.string().or(z.date()).nullable(),
+  createdAt: z.string().or(z.date()),
+  updatedAt: z.string().or(z.date()),
+});
+
+export const RunCompletionCallbackDeliveryListResponse = z.object({
+  data: z.array(RunCompletionCallbackDeliveryResponse),
+  pagination: z.object({
+    hasMore: z.boolean(),
+    nextCursor: z.string().optional(),
+  }),
+});
+
+export const RunCompletionCallbackHeaders = z.object({
+  "x-trigger-signature-hmacsha256": z.string(),
+  "x-trigger-callback-id": z.string(),
+  "x-trigger-callback-delivery-id": z.string(),
+  "x-trigger-callback-attempt": z.string(),
+  "x-trigger-callback-created-at": z.string(),
+  "user-agent": z.literal("Trigger.dev Run Completion Callback"),
+  "content-type": z.literal("application/json"),
+  "x-trigger-project-ref": z.string().optional(),
+  "x-trigger-environment": z.string().optional(),
+  "x-trigger-run-id": z.string().optional(),
+  "x-trigger-run-status": z.string().optional(),
+  "x-trigger-event-type": z.string().optional(),
+});
+
+export const RunCompletionCallbackErrorResponse = z.object({
+  error: z.string(),
+  code: z
+    .enum([
+      "callback_not_found",
+      "callback_disabled",
+      "callback_delivery_not_found",
+      "callback_delivery_failed",
+    ])
+    .optional(),
+});
+
+export class RunCompletionCallbackPresenter {
+  static present(callback: {
+    friendlyId: string;
+    name: string;
+    url: string;
+    enabled: boolean;
+    environmentId: string | null;
+    eventTypes: string[];
+    createdAt: Date;
+    updatedAt: Date;
+  }) {
+    return {
+      id: callback.friendlyId,
+      name: callback.name,
+      url: callback.url,
+      enabled: callback.enabled,
+      environmentId: callback.environmentId,
+      eventTypes: callback.eventTypes,
+      createdAt: callback.createdAt.toISOString(),
+      updatedAt: callback.updatedAt.toISOString(),
+    };
+  }
+}
+
+export const RunCompletionCallbackDeliveryPayload = z.object({
+  id: z.string(),
+  created: z.string(),
+  type: z.enum(["run.completed", "run.failed", "run.canceled"]),
+  object: z.object({
+    run: z.object({
+      id: z.string(),
+      number: z.number(),
+      status: z.string(),
+      taskIdentifier: z.string(),
+      createdAt: z.string().or(z.date()),
+      startedAt: z.string().or(z.date()).optional(),
+      completedAt: z.string().or(z.date()).optional(),
+      idempotencyKey: z.string().optional(),
+      tags: z.array(z.string()).default([]),
+      output: z.unknown().optional(),
+      outputType: z.string().nullable().optional(),
+      error: z.unknown().optional(),
+      dashboardUrl: z.string(),
+    }),
+    task: z.object({
+      id: z.string(),
+      filePath: z.string(),
+      exportName: z.string(),
+      version: z.string(),
+    }),
+    batch: z
+      .object({
+        id: z.string(),
+      })
+      .optional(),
+    environment: z.object({
+      id: z.string(),
+      type: z.string(),
+      slug: z.string(),
+      branchName: z.string().optional(),
+    }),
+    organization: z.object({
+      id: z.string(),
+      slug: z.string(),
+      name: z.string(),
+    }),
+    project: z.object({
+      id: z.string(),
+      ref: z.string(),
+      slug: z.string(),
+      name: z.string(),
+    }),
+  }),
+});
diff --git a/apps/webapp/test/runCompletionCallbacks.test.ts b/apps/webapp/test/runCompletionCallbacks.test.ts
new file mode 100644
index 0000000000..1173cbd0cb
--- /dev/null
+++ b/apps/webapp/test/runCompletionCallbacks.test.ts
@@ -0,0 +1,254 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import { prisma } from "~/db.server";
+import { FinalizeTaskRunService } from "~/v3/services/finalizeTaskRun.server";
+import { DeliverRunCompletionCallbackService } from "~/v3/services/completionCallbacks/deliverRunCompletionCallback.server";
+import { PerformRunCompletionCallbacksService } from "~/v3/services/completionCallbacks/performRunCompletionCallbacks.server";
+import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
+
+const fetchMock = vi.fn();
+vi.stubGlobal("fetch", fetchMock);
+
+describe("run completion callbacks", () => {
+  beforeEach(() => {
+    fetchMock.mockReset();
+  });
+
+  it("creates callback deliveries when a run completes", async () => {
+    const { run, callback } = await seedRunWithCallback({
+      status: "EXECUTING",
+      eventTypes: ["RUN_COMPLETED"],
+    });
+
+    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 204 }));
+
+    await new FinalizeTaskRunService().call({
+      id: run.id,
+      status: "COMPLETED_SUCCESSFULLY",
+      completedAt: new Date(),
+    });
+
+    await new PerformRunCompletionCallbacksService().call(run.id);
+
+    const delivery = await prisma.taskRunCompletionCallbackDelivery.findFirstOrThrow({
+      where: {
+        taskRunId: run.id,
+        callbackId: callback.id,
+      },
+    });
+
+    await new DeliverRunCompletionCallbackService().call(delivery.id);
+
+    expect(fetchMock).toHaveBeenCalledTimes(1);
+    expect(fetchMock.mock.calls[0][0]).toBe(callback.url);
+    expect(fetchMock.mock.calls[0][1].headers["x-trigger-signature-hmacsha256"]).toBeDefined();
+  });
+
+  it("retries a callback that returns 500", async () => {
+    const { run, callback } = await seedRunWithCallback({
+      status: "COMPLETED_SUCCESSFULLY",
+      eventTypes: ["RUN_COMPLETED"],
+    });
+
+    const delivery = await createDelivery(run.id, callback.id, "RUN_COMPLETED");
+
+    fetchMock
+      .mockResolvedValueOnce(new Response("temporary", { status: 500 }))
+      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
+
+    await expect(new DeliverRunCompletionCallbackService().call(delivery.id)).rejects.toThrow();
+    await new DeliverRunCompletionCallbackService().call(delivery.id);
+
+    const updated = await prisma.taskRunCompletionCallbackDelivery.findFirstOrThrow({
+      where: { id: delivery.id },
+    });
+
+    expect(fetchMock).toHaveBeenCalledTimes(2);
+    expect(updated.status).toBe("DELIVERED");
+  });
+
+  it("retries a callback that returns 401 so customers can fix auth headers", async () => {
+    const { run, callback } = await seedRunWithCallback({
+      status: "COMPLETED_SUCCESSFULLY",
+      eventTypes: ["RUN_COMPLETED"],
+    });
+
+    const delivery = await createDelivery(run.id, callback.id, "RUN_COMPLETED");
+
+    fetchMock
+      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
+      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
+
+    await expect(new DeliverRunCompletionCallbackService().call(delivery.id)).rejects.toThrow();
+    await new DeliverRunCompletionCallbackService().call(delivery.id);
+
+    expect(fetchMock).toHaveBeenCalledTimes(2);
+  });
+
+  it("sends a failed callback for failed final statuses", async () => {
+    const { run, callback } = await seedRunWithCallback({
+      status: "COMPLETED_WITH_ERRORS",
+      eventTypes: ["RUN_FAILED"],
+    });
+
+    const delivery = await createDelivery(run.id, callback.id, "RUN_FAILED");
+
+    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
+
+    await new DeliverRunCompletionCallbackService().call(delivery.id);
+
+    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
+    expect(body.type).toBe("run.failed");
+  });
+
+  async function seedRunWithCallback({
+    status,
+    eventTypes,
+  }: {
+    status: string;
+    eventTypes: string[];
+  }) {
+    const organization = await prisma.organization.create({
+      data: {
+        title: "Acme",
+        slug: generateFriendlyId("org"),
+      },
+    });
+    const project = await prisma.project.create({
+      data: {
+        name: "Acme Project",
+        slug: generateFriendlyId("proj"),
+        externalRef: generateFriendlyId("ref"),
+        organizationId: organization.id,
+      },
+    });
+    const environment = await prisma.runtimeEnvironment.create({
+      data: {
+        slug: "prod",
+        type: "PRODUCTION",
+        apiKey: generateFriendlyId("key"),
+        shortcode: "prod",
+        projectId: project.id,
+        organizationId: organization.id,
+      },
+    });
+    const run = await prisma.taskRun.create({
+      data: {
+        friendlyId: generateFriendlyId("run"),
+        number: 1,
+        status,
+        taskIdentifier: "sync-customer",
+        projectId: project.id,
+        runtimeEnvironmentId: environment.id,
+        createdAt: new Date(),
+      },
+    });
+    const callback = await prisma.projectCompletionCallback.create({
+      data: {
+        friendlyId: generateFriendlyId("rcc"),
+        projectId: project.id,
+        environmentId: environment.id,
+        name: "Completion callback",
+        url: "https://customer.example.com/trigger-callback",
+        secret: "encrypted-secret",
+        enabled: true,
+        eventTypes,
+      },
+    });
+
+    return { organization, project, environment, run, callback };
+  }
+
+  async function createDelivery(
+    taskRunId: string,
+    callbackId: string,
+    eventType: "RUN_COMPLETED" | "RUN_FAILED" | "RUN_CANCELED"
+  ) {
+    const run = await prisma.taskRun.findFirstOrThrow({
+      where: { id: taskRunId },
+    });
+
+    return await prisma.taskRunCompletionCallbackDelivery.create({
+      data: {
+        friendlyId: generateFriendlyId("rcd"),
+        projectId: run.projectId,
+        taskRunId,
+        callbackId,
+        eventType,
+        status: "PENDING",
+      },
+    });
+  }
+});
```

## Intended Flaws

### Flaw 1: Callback Delivery Is Retried Without A Stable Idempotency Contract

- `type`: `idempotency_gap`
- `location`: `apps/webapp/app/v3/services/completionCallbacks/performRunCompletionCallbacks.server.ts:83-124`, `apps/webapp/app/v3/services/completionCallbacks/deliverRunCompletionCallback.server.ts:80-156`
- `learner_prompt`: What happens if finalization, delivery, or the customer endpoint is retried after the customer already observed the callback?

Expected answer:

- `identify`: The PR creates a fresh `TaskRunCompletionCallbackDelivery` every time the finalization callback worker runs, enqueues jobs with `Date.now()` in their IDs, generates a new payload `id` for every delivery attempt, and does not send a stable idempotency key or event ID. A timeout after the customer processes the callback will be retried as a new external side effect with no reliable way for the receiver to dedupe it.
- `impact`: Customers will use completion callbacks to advance their own systems. Duplicate callbacks can mark an import complete twice, double-charge a workflow, release a lock twice, or fan out duplicate jobs. The bug is especially likely around the exact failure modes retries are meant to handle: network timeout, worker crash after send but before marking delivered, finalize service re-entry, or queue visibility timeout. The delivery table records attempts, but it does not enforce one delivery command per `(callback, run, eventType)`, and the external contract lacks a stable key.
- `fix_direction`: Create an outbox-style delivery row exactly once per `(callbackId, taskRunId, eventType)` using a unique constraint and idempotent upsert. Use a stable `eventId`/`deliveryId` across retries and send it in headers such as `x-trigger-event-id` and `Idempotency-Key`. Queue IDs should be deterministic. Mark delivery state from that one row, and make retry attempts increment on the same command rather than creating new externally distinct events.

Hints:

1. Look for the identifier the customer can use to dedupe callback deliveries.
2. Compare the internal delivery row ID with the event ID in the payload and the worker enqueue IDs.
3. `generateFriendlyId("rce")` runs inside payload construction, and `Date.now()` is part of both enqueue IDs.

### Flaw 2: Permanent Customer Errors Are Retried Like Transient Infrastructure Failures

- `type`: `retry_semantics_bug`
- `location`: `apps/webapp/app/v3/services/completionCallbacks/deliverRunCompletionCallback.server.ts:80-134`, `apps/webapp/app/v3/completionCallbacksWorker.server.ts:35-55`, `apps/webapp/test/runCompletionCallbacks.test.ts:54-74`
- `learner_prompt`: Does the callback retry policy distinguish retryable failures from permanent customer configuration errors?

Expected answer:

- `identify`: The delivery service throws `RetryableCallbackError` for every non-2xx response, and the Redis worker retries the job up to five times. That includes `400`, `401`, `403`, `404`, and `422`, which usually mean the URL, secret, route, auth, or payload contract is wrong. The test explicitly blesses retrying `401`.
- `impact`: A bad customer configuration can generate repeated traffic and log noise without any chance of success. At scale, many invalid callback URLs become queue amplification. Retries can also hide the real customer-facing state: a permanent failure sits in `FAILED_RETRYABLE`, consumes worker capacity, and delays actionable feedback. Worse, retrying `401/403` encourages customers to believe they can fix credentials mid-flight, while the event contract may already have been attempted multiple times.
- `fix_direction`: Classify failures before throwing to the worker. Retry network errors, timeouts, `408`, `409` when safe, `425`, `429` with `Retry-After`, and `5xx`. Mark most `4xx` as `FAILED_PERMANENT` without throwing, store the response body/status for diagnostics, and surface configuration health to the project. Keep retry budgets explicit per callback and per project.

Hints:

1. Search for the first branch that handles `!response.ok`.
2. Compare this logic with Trigger.dev retry helpers that only retry selected status codes.
3. The test saying `401` should retry is not a reassurance; it is evidence of the wrong contract being encoded.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the missing stable idempotency contract across retries, not only that duplicate database rows can be created. The important production concern is the external side effect being replayed without a receiver-visible stable key.

For flaw 2, a correct answer must identify that all non-2xx responses are retried and explain why permanent `4xx` responses should usually be terminal. Answers that merely suggest "add exponential backoff" miss the main issue.

### Product-Level Change

The PR tries to add customer-facing run completion callbacks. That is a powerful product feature because it turns Trigger.dev runs into integration points for customer workflows. It also means Trigger.dev is now sending commands into customer systems, not just updating its own dashboard.

### Changed Contracts

- Data contract: new callback configuration and delivery tables.
- Run finalization contract: finalizing a task run now creates external callback work.
- Queue contract: callback delivery is now retried by a Redis worker.
- HTTP callback contract: customers receive signed payloads and are expected to interpret them as run completion events.
- Idempotency contract: the callback event must be dedupe-safe because retries are part of the product promise.
- Retry contract: status codes now decide whether queue retries are useful or harmful.

### Failure Modes

The scary case is "send succeeded but acknowledgement failed." The customer's endpoint may update its database, then the network times out before Trigger.dev sees the response. The worker retries. In this PR, the next attempt can carry a new event ID and no idempotency key, so the customer sees another distinct completion event.

The second failure mode is a configuration error. If a callback URL is wrong or the customer secret is rotated, every terminal run can enqueue callback work that retries several times. That is not reliability; it is repeated known failure.

### Reviewer Thought Process

A strong reviewer starts from the boundary: this PR crosses from internal state updates into external side effects. Once a system promises retries for external side effects, the reviewer should immediately ask, "What is the stable command identity?" Then they should trace the command from finalization to database row to queue job to HTTP headers to receiver payload.

The next question is, "Which failures are worth retrying?" Retry code that treats all errors equally is often worse than no retry code, because it can amplify permanent failures. The reviewer should inspect tests for what they encode as acceptable behavior; the `401` retry test is a red flag.

### Better Implementation Direction

The safer design is an outbox:

- Create one delivery command with a unique key `(callbackId, taskRunId, eventType)`.
- Store a stable `eventId` and use it in the payload and headers.
- Enqueue delivery using a deterministic queue ID.
- Treat retry attempts as updates to the same delivery row.
- Classify retryability explicitly.
- Mark permanent `4xx` as terminal with diagnostics and never throw them back to the worker retry loop.
- Emit metrics for permanent failures, transient retries, and duplicate suppression.

## Why This Case Exists

Retry logic is where plausible code becomes dangerous. This exercise trains the learner to review not just whether a retry exists, but whether the retry preserves the meaning of the operation. World-class reviewers protect external side effects with stable command identity and careful retry classification.
