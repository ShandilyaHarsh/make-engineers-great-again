# TS-042: Novu Digest Flush Worker Per Subscriber

## Metadata

- `id`: TS-042
- `source_repo`: [novuhq/novu](https://github.com/novuhq/novu)
- `repo_area`: digest jobs, worker queues, delayed job flushing, job repository queries, digest event payloads, subscriber concurrency, background job observability
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,450-1,850
- `represented_diff_lines`: 1741
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about digest semantics, job locking, window ownership, payload sizing, queue throughput, repository indexes, and worker failure modes without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a dedicated digest flush worker that can flush due digest windows per subscriber instead of waiting for the normal delayed job path to pick up each digest master.

Today digest events are merged into a delayed digest master, and the digest step builds its `digest.events` payload when that job runs. Customers with high event volume have asked for a background flush path that can find due digest masters, collect their merged followers, persist the events on the master job, and enqueue the next workflow step in a more predictable cadence.

The PR adds:

- a `digest-flush` worker and processor,
- a per-subscriber Redis lock around flush execution,
- repository helpers to find due digest masters and merged followers,
- persisted `digest.flush` metadata on jobs,
- execution details for flush start/success/skip/failure,
- tests for multi-workflow subscribers, lock contention, large windows, and retry behavior,
- docs for operating the digest flush worker.

The intended product behavior is: one subscriber can have many digest windows across workflows, and the worker should flush eligible windows without duplicate sends, without delaying unrelated windows, and without building unsafe payloads.

## Existing Code Context

The real Novu codebase already has these relevant contracts:

- `apps/worker/src/app/workflow/usecases/add-job/merge-or-create-digest.usecase.ts` decides whether a digest job becomes the delayed master or merges into an existing delayed digest. Followers are marked `MERGED` and point at the master through `_mergedDigestId`.
- `libs/dal/src/repositories/job/job.repository.ts` contains `getExistingDelayedJobWithTheSameDigestValue(...)`, `markJobAsDigestMaster(...)`, and `updateAllChildJobStatus(...)`. Digest ownership is scoped by environment, subscriber, template/workflow, and digest value.
- `libs/dal/src/repositories/job/job.schema.ts` stores `digest.digestKey`, `digest.digestValue`, and `digest.events`, and has a partial unique index guarding one delayed digest master for a digest key/value/workflow/subscriber.
- `apps/worker/src/app/workflow/usecases/send-message/digest/digest.usecase.ts` builds events either from `_mergedDigestId` followers or from the backward-compatible `findJobsToDigest(...)` path, then writes `digest.events` to jobs.
- `apps/worker/src/app/workflow/usecases/send-message/digest/get-digest-events-regular.usecase.ts` derives the regular digest lookback window from the digest metadata, then filters trigger jobs by digest key/value.
- `libs/application-generic/src/utils/digest.ts` exposes `getJobDigest(...)`, which reads `digestKey` and the matching payload value. Digest grouping is not just subscriber-level; the digest key/value is part of the contract.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the worker preserves digest ownership, concurrency, and payload safety.

## Review Surface

Changed files in the synthetic PR:

- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.command.ts`
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.ts`
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.ts`
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.worker.ts`
- `apps/worker/src/app/workflow/usecases/digest-flush/index.ts`
- `apps/worker/src/app/workflow/workflow.module.ts`
- `libs/dal/src/repositories/job/job.entity.ts`
- `libs/dal/src/repositories/job/job.repository.ts`
- `libs/dal/src/repositories/job/job.schema.ts`
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.spec.ts`
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.spec.ts`
- `apps/api/src/app/events/e2e/digest-flush.e2e.ts`
- `docs/workers/digest-flush-worker.md`

The line references below use synthetic PR line numbers. The represented diff is focused on lock ownership, window scoping, payload size, repository contracts, queue behavior, and tests that encode the wrong worker semantics.

## Diff

```diff
diff --git a/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.command.ts b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.command.ts
new file mode 100644
index 0000000000..01a2ef3255
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.command.ts
@@ -0,0 +1,103 @@
+import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
+
+export class DigestFlushCommand {
+  @IsString()
+  environmentId: string;
+
+  @IsString()
+  organizationId: string;
+
+  @IsOptional()
+  @IsString()
+  subscriberId?: string;
+
+  @IsOptional()
+  @IsString()
+  templateId?: string;
+
+  @IsOptional()
+  @IsString()
+  digestKey?: string;
+
+  @IsOptional()
+  @IsString()
+  digestValue?: string;
+
+  @IsOptional()
+  @IsInt()
+  @Min(1)
+  @Max(500)
+  limit?: number;
+
+  @IsOptional()
+  @IsBoolean()
+  dryRun?: boolean;
+
+  static create(data: {
+    environmentId: string;
+    organizationId: string;
+    subscriberId?: string;
+    templateId?: string;
+    digestKey?: string;
+    digestValue?: string;
+    limit?: number;
+    dryRun?: boolean;
+  }) {
+    const command = new DigestFlushCommand();
+    command.environmentId = data.environmentId;
+    command.organizationId = data.organizationId;
+    command.subscriberId = data.subscriberId;
+    command.templateId = data.templateId;
+    command.digestKey = data.digestKey;
+    command.digestValue = data.digestValue;
+    command.limit = data.limit;
+    command.dryRun = data.dryRun;
+
+    return command;
+  }
+}
+
+export type DigestFlushWindow = {
+  masterJobId: string;
+  notificationId: string;
+  environmentId: string;
+  organizationId: string;
+  subscriberId: string;
+  templateId: string;
+  digestKey?: string;
+  digestValue?: string;
+  dueAt: Date;
+};
+
+export type DigestFlushResult = {
+  scanned: number;
+  lockedSubscribers: number;
+  flushed: number;
+  skipped: number;
+  failed: number;
+  windows: Array<{
+    masterJobId: string;
+    subscriberId: string;
+    templateId: string;
+    digestKey?: string;
+    digestValue?: string;
+    eventCount: number;
+    status: 'flushed' | 'skipped' | 'failed';
+    reason?: string;
+  }>;
+};
+
+export type DigestFlushWorkerPayload = {
+  environmentId: string;
+  organizationId: string;
+  subscriberId?: string;
+  templateId?: string;
+  requestedAt: string;
+  cursor?: string;
+};
+
+export type DigestFlushMetrics = {
+  environmentId: string;
+  organizationId: string;
+  subscriberId: string;
+  templateId: string;
+  digestKey?: string;
+  digestValue?: string;
+  eventCount: number;
+  followerCount: number;
+  durationMs: number;
+  status: string;
+};
diff --git a/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.ts b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.ts
new file mode 100644
index 0000000000..30a3bda91a
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.ts
@@ -0,0 +1,148 @@
+import { Inject, Injectable, Logger } from '@nestjs/common';
+import { CacheService } from '@novu/application-generic';
+import { DigestFlushWindow } from './digest-flush.command';
+
+const LOCK_TTL_SECONDS = 90;
+const LOCK_CONTEXT = 'DigestFlushLock';
+
+type LockArgs = {
+  environmentId: string;
+  organizationId: string;
+  subscriberId: string;
+};
+
+type LockResult<T> = {
+  acquired: boolean;
+  key: string;
+  value?: T;
+};
+
+@Injectable()
+export class DigestFlushLockService {
+  constructor(
+    @Inject(CacheService)
+    private readonly cacheService: CacheService
+  ) {}
+
+  buildSubscriberFlushLockKey(args: LockArgs) {
+    return [
+      'digest-flush',
+      args.organizationId,
+      args.environmentId,
+      args.subscriberId,
+    ].join(':');
+  }
+
+  buildWindowLogFields(window: DigestFlushWindow) {
+    return {
+      masterJobId: window.masterJobId,
+      subscriberId: window.subscriberId,
+      templateId: window.templateId,
+      digestKey: window.digestKey,
+      digestValue: window.digestValue,
+    };
+  }
+
+  async withSubscriberFlushLock<T>(
+    args: LockArgs,
+    run: () => Promise<T>
+  ): Promise<LockResult<T>> {
+    const key = this.buildSubscriberFlushLockKey(args);
+    const token = `${Date.now()}:${Math.random()}`;
+    const acquired = await this.cacheService.set(key, token, {
+      ttl: LOCK_TTL_SECONDS,
+      NX: true,
+    });
+
+    if (!acquired) {
+      Logger.debug(`Digest flush lock is already held for subscriber ${args.subscriberId}`, LOCK_CONTEXT);
+
+      return {
+        acquired: false,
+        key,
+      };
+    }
+
+    try {
+      const value = await run();
+
+      return {
+        acquired: true,
+        key,
+        value,
+      };
+    } finally {
+      const currentToken = await this.cacheService.get(key);
+      if (currentToken === token) {
+        await this.cacheService.del(key);
+      }
+    }
+  }
+
+  async withWindowLog<T>(window: DigestFlushWindow, run: () => Promise<T>) {
+    const startedAt = Date.now();
+    Logger.debug(
+      {
+        ...this.buildWindowLogFields(window),
+        dueAt: window.dueAt.toISOString(),
+      },
+      'Starting digest flush window'
+    );
+
+    try {
+      const result = await run();
+      Logger.debug(
+        {
+          ...this.buildWindowLogFields(window),
+          durationMs: Date.now() - startedAt,
+        },
+        'Finished digest flush window'
+      );
+
+      return result;
+    } catch (error) {
+      Logger.error(
+        {
+          err: error,
+          ...this.buildWindowLogFields(window),
+          durationMs: Date.now() - startedAt,
+        },
+        'Failed digest flush window'
+      );
+      throw error;
+    }
+  }
+
+  groupBySubscriber(windows: DigestFlushWindow[]) {
+    const grouped = new Map<string, DigestFlushWindow[]>();
+
+    for (const window of windows) {
+      const existing = grouped.get(window.subscriberId) ?? [];
+      existing.push(window);
+      grouped.set(window.subscriberId, existing);
+    }
+
+    for (const subscriberWindows of grouped.values()) {
+      subscriberWindows.sort((a, b) => {
+        const dueDiff = a.dueAt.getTime() - b.dueAt.getTime();
+        if (dueDiff !== 0) {
+          return dueDiff;
+        }
+
+        return a.masterJobId.localeCompare(b.masterJobId);
+      });
+    }
+
+    return grouped;
+  }
+
+  describeSkippedSubscriber(args: LockArgs) {
+    return {
+      subscriberId: args.subscriberId,
+      reason: 'subscriber digest flush already running',
+    };
+  }
+}
diff --git a/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.ts b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.ts
new file mode 100644
index 0000000000..6d1dfc5d01
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.ts
@@ -0,0 +1,296 @@
+import { Injectable, Logger } from '@nestjs/common';
+import {
+  CreateExecutionDetails,
+  CreateExecutionDetailsCommand,
+  DetailEnum,
+  ExecutionDetailsSourceEnum,
+  ExecutionDetailsStatusEnum,
+  InstrumentUsecase,
+} from '@novu/application-generic';
+import { JobEntity, JobRepository, JobStatusEnum } from '@novu/dal';
+import { StepTypeEnum } from '@novu/shared';
+import {
+  DigestFlushCommand,
+  DigestFlushMetrics,
+  DigestFlushResult,
+  DigestFlushWindow,
+} from './digest-flush.command';
+import { DigestFlushLockService } from './digest-flush-lock.service';
+
+const DEFAULT_FLUSH_LIMIT = 100;
+const LOG_CONTEXT = 'DigestFlush';
+
+type FlushWindowResult = DigestFlushResult['windows'][number];
+
+@Injectable()
+export class DigestFlush {
+  constructor(
+    private readonly jobRepository: JobRepository,
+    private readonly lockService: DigestFlushLockService,
+    private readonly createExecutionDetails: CreateExecutionDetails
+  ) {}
+
+  @InstrumentUsecase()
+  async execute(command: DigestFlushCommand): Promise<DigestFlushResult> {
+    const dueWindows = await this.jobRepository.findDueDigestMasters({
+      environmentId: command.environmentId,
+      organizationId: command.organizationId,
+      subscriberId: command.subscriberId,
+      templateId: command.templateId,
+      digestKey: command.digestKey,
+      digestValue: command.digestValue,
+      limit: command.limit ?? DEFAULT_FLUSH_LIMIT,
+      now: new Date(),
+    });
+
+    const windows = dueWindows.map((job) => this.toWindow(job));
+    const windowsBySubscriber = this.lockService.groupBySubscriber(windows);
+    const results: FlushWindowResult[] = [];
+    let lockedSubscribers = 0;
+    let skipped = 0;
+    let failed = 0;
+
+    await Promise.all(
+      Array.from(windowsBySubscriber.entries()).map(async ([subscriberId, subscriberWindows]) => {
+        const lock = await this.lockService.withSubscriberFlushLock(
+          {
+            organizationId: command.organizationId,
+            environmentId: command.environmentId,
+            subscriberId,
+          },
+          async () => {
+            lockedSubscribers += 1;
+            const subscriberResults: FlushWindowResult[] = [];
+
+            for (const window of subscriberWindows) {
+              const result = await this.lockService.withWindowLog(window, async () => {
+                return this.flushWindow(command, window);
+              });
+              subscriberResults.push(result);
+            }
+
+            return subscriberResults;
+          }
+        );
+
+        if (!lock.acquired) {
+          skipped += subscriberWindows.length;
+          results.push(
+            ...subscriberWindows.map((window) => ({
+              masterJobId: window.masterJobId,
+              subscriberId: window.subscriberId,
+              templateId: window.templateId,
+              digestKey: window.digestKey,
+              digestValue: window.digestValue,
+              eventCount: 0,
+              status: 'skipped' as const,
+              reason: 'subscriber digest flush already running',
+            }))
+          );
+          return;
+        }
+
+        const subscriberResults = lock.value ?? [];
+        failed += subscriberResults.filter((result) => result.status === 'failed').length;
+        skipped += subscriberResults.filter((result) => result.status === 'skipped').length;
+        results.push(...subscriberResults);
+      })
+    );
+
+    return {
+      scanned: windows.length,
+      lockedSubscribers,
+      flushed: results.filter((result) => result.status === 'flushed').length,
+      skipped,
+      failed,
+      windows: results,
+    };
+  }
+
+  private async flushWindow(command: DigestFlushCommand, window: DigestFlushWindow): Promise<FlushWindowResult> {
+    const startedAt = Date.now();
+    const master = await this.jobRepository.findOne({
+      _environmentId: command.environmentId,
+      _organizationId: command.organizationId,
+      _id: window.masterJobId,
+      status: JobStatusEnum.DELAYED,
+      type: StepTypeEnum.DIGEST,
+    });
+
+    if (!master) {
+      await this.recordExecution(window, ExecutionDetailsStatusEnum.FAILED, 'Digest master is no longer delayed');
+
+      return {
+        masterJobId: window.masterJobId,
+        subscriberId: window.subscriberId,
+        templateId: window.templateId,
+        digestKey: window.digestKey,
+        digestValue: window.digestValue,
+        eventCount: 0,
+        status: 'failed',
+        reason: 'Digest master is no longer delayed',
+      };
+    }
+
+    const followers = await this.jobRepository.findMergedDigestFollowersForFlush({
+      environmentId: command.environmentId,
+      organizationId: command.organizationId,
+      masterJobId: master._id,
+      subscriberId: master._subscriberId,
+    });
+
+    const events = this.buildDigestEvents(master, followers);
+    await this.recordExecution(window, ExecutionDetailsStatusEnum.SUCCESS, `Digest flush prepared ${events.length} events`);
+
+    if (command.dryRun) {
+      return {
+        masterJobId: window.masterJobId,
+        subscriberId: window.subscriberId,
+        templateId: window.templateId,
+        digestKey: window.digestKey,
+        digestValue: window.digestValue,
+        eventCount: events.length,
+        status: 'skipped',
+        reason: 'dry run',
+      };
+    }
+
+    await this.jobRepository.persistDigestFlush({
+      environmentId: command.environmentId,
+      organizationId: command.organizationId,
+      masterJobId: master._id,
+      eventPayloads: events,
+      followerJobIds: followers.map((job) => job._id),
+      flushedAt: new Date(),
+    });
+
+    await this.jobRepository.enqueueNextJobsForFlushedDigest({
+      environmentId: command.environmentId,
+      organizationId: command.organizationId,
+      masterJobId: master._id,
+      transactionId: master.transactionId,
+    });
+
+    this.reportMetrics({
+      environmentId: command.environmentId,
+      organizationId: command.organizationId,
+      subscriberId: window.subscriberId,
+      templateId: window.templateId,
+      digestKey: window.digestKey,
+      digestValue: window.digestValue,
+      eventCount: events.length,
+      followerCount: followers.length,
+      durationMs: Date.now() - startedAt,
+      status: 'flushed',
+    });
+
+    return {
+      masterJobId: window.masterJobId,
+      subscriberId: window.subscriberId,
+      templateId: window.templateId,
+      digestKey: window.digestKey,
+      digestValue: window.digestValue,
+      eventCount: events.length,
+      status: 'flushed',
+    };
+  }
+
+  private buildDigestEvents(master: JobEntity, followers: JobEntity[]) {
+    const ordered = [master, ...followers].sort((a, b) => {
+      const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
+      if (createdDiff !== 0) {
+        return createdDiff;
+      }
+
+      return a._id.localeCompare(b._id);
+    });
+
+    return ordered.map((job) => ({
+      payload: job.payload,
+      transactionId: job.transactionId,
+      jobId: job._id,
+      notificationId: job._notificationId,
+      createdAt: job.createdAt,
+    }));
+  }
+
+  private toWindow(job: JobEntity): DigestFlushWindow {
+    return {
+      masterJobId: job._id,
+      notificationId: job._notificationId,
+      environmentId: job._environmentId,
+      organizationId: job._organizationId,
+      subscriberId: job._subscriberId,
+      templateId: job._templateId,
+      digestKey: job.digest?.digestKey,
+      digestValue: job.digest?.digestValue,
+      dueAt: new Date(job.digest?.flush?.dueAt ?? job.updatedAt),
+    };
+  }
+
+  private async recordExecution(window: DigestFlushWindow, status: ExecutionDetailsStatusEnum, message: string) {
+    await this.createExecutionDetails.execute(
+      CreateExecutionDetailsCommand.create({
+        _environmentId: window.environmentId,
+        _organizationId: window.organizationId,
+        _notificationId: window.notificationId,
+        _jobId: window.masterJobId,
+        detail: DetailEnum.DIGEST_TRIGGERED_EVENTS,
+        source: ExecutionDetailsSourceEnum.INTERNAL,
+        status,
+        raw: JSON.stringify({
+          message,
+          subscriberId: window.subscriberId,
+          templateId: window.templateId,
+          digestKey: window.digestKey,
+          digestValue: window.digestValue,
+        }),
+        isTest: false,
+        isRetry: false,
+      })
+    );
+  }
+
+  private reportMetrics(metrics: DigestFlushMetrics) {
+    Logger.log(
+      {
+        environmentId: metrics.environmentId,
+        organizationId: metrics.organizationId,
+        subscriberId: metrics.subscriberId,
+        templateId: metrics.templateId,
+        digestKey: metrics.digestKey,
+        digestValue: metrics.digestValue,
+        eventCount: metrics.eventCount,
+        followerCount: metrics.followerCount,
+        durationMs: metrics.durationMs,
+        status: metrics.status,
+      },
+      LOG_CONTEXT
+    );
+  }
+}
diff --git a/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.worker.ts b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.worker.ts
new file mode 100644
index 0000000000..1e07ef583a
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.worker.ts
@@ -0,0 +1,141 @@
+import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
+import { BullMqService, WorkerBaseService } from '@novu/application-generic';
+import { DigestFlushCommand, DigestFlushWorkerPayload } from './digest-flush.command';
+import { DigestFlush } from './digest-flush.usecase';
+
+const QUEUE_NAME = 'digest-flush';
+const LOG_CONTEXT = 'DigestFlushWorker';
+
+@Injectable()
+export class DigestFlushWorker extends WorkerBaseService implements OnModuleInit, OnModuleDestroy {
+  constructor(
+    private readonly bullMqService: BullMqService,
+    private readonly digestFlush: DigestFlush
+  ) {
+    super();
+  }
+
+  async onModuleInit() {
+    await this.bullMqService.createWorker<DigestFlushWorkerPayload>(
+      QUEUE_NAME,
+      async (job) => {
+        const payload = job.data;
+        Logger.debug(
+          {
+            jobId: job.id,
+            environmentId: payload.environmentId,
+            organizationId: payload.organizationId,
+            subscriberId: payload.subscriberId,
+            templateId: payload.templateId,
+          },
+          'Starting digest flush worker job'
+        );
+
+        const result = await this.digestFlush.execute(
+          DigestFlushCommand.create({
+            environmentId: payload.environmentId,
+            organizationId: payload.organizationId,
+            subscriberId: payload.subscriberId,
+            templateId: payload.templateId,
+            limit: 100,
+          })
+        );
+
+        Logger.log(
+          {
+            jobId: job.id,
+            scanned: result.scanned,
+            flushed: result.flushed,
+            skipped: result.skipped,
+            failed: result.failed,
+          },
+          LOG_CONTEXT
+        );
+
+        return result;
+      },
+      {
+        concurrency: 20,
+        lockDuration: 120000,
+        settings: {
+          backoffStrategy: 'exponential',
+        },
+      }
+    );
+  }
+
+  async enqueue(payload: DigestFlushWorkerPayload) {
+    return this.bullMqService.add(QUEUE_NAME, payload, {
+      jobId: [
+        'digest-flush',
+        payload.organizationId,
+        payload.environmentId,
+        payload.subscriberId ?? 'all-subscribers',
+        payload.templateId ?? 'all-workflows',
+        payload.requestedAt,
+      ].join(':'),
+      attempts: 3,
+      removeOnComplete: 1000,
+      removeOnFail: 5000,
+      backoff: {
+        type: 'exponential',
+        delay: 5000,
+      },
+    });
+  }
+
+  async scheduleRecurringFlush(environmentId: string, organizationId: string) {
+    return this.bullMqService.add(
+      QUEUE_NAME,
+      {
+        environmentId,
+        organizationId,
+        requestedAt: new Date().toISOString(),
+      },
+      {
+        repeat: {
+          every: 30000,
+        },
+        jobId: ['digest-flush-recurring', organizationId, environmentId].join(':'),
+        removeOnComplete: true,
+        removeOnFail: 1000,
+      }
+    );
+  }
+
+  async onModuleDestroy() {
+    await this.bullMqService.closeWorker(QUEUE_NAME);
+  }
+}
diff --git a/apps/worker/src/app/workflow/usecases/digest-flush/index.ts b/apps/worker/src/app/workflow/usecases/digest-flush/index.ts
new file mode 100644
index 0000000000..ef7b83c83b
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/digest-flush/index.ts
@@ -0,0 +1,4 @@
+export * from './digest-flush.command';
+export * from './digest-flush-lock.service';
+export * from './digest-flush.usecase';
+export * from './digest-flush.worker';
diff --git a/apps/worker/src/app/workflow/workflow.module.ts b/apps/worker/src/app/workflow/workflow.module.ts
index b48c29fdc1..c1d84a5f10 100644
--- a/apps/worker/src/app/workflow/workflow.module.ts
+++ b/apps/worker/src/app/workflow/workflow.module.ts
@@ -41,6 +41,11 @@ import { QueueNextJob } from './usecases/queue-next-job';
 import { RunJob } from './usecases/run-job';
 import { SendMessage } from './usecases/send-message';
+import {
+  DigestFlush,
+  DigestFlushLockService,
+  DigestFlushWorker,
+} from './usecases/digest-flush';
 import { StoreSubscriberJobs } from './usecases/store-subscriber-jobs';
 import { SubscriberJobBound } from './usecases/subscriber-job-bound';
 import { UpdateJobStatus } from './usecases/update-job-status';
@@ -117,6 +122,9 @@ const USE_CASES = [
   QueueNextJob,
   RunJob,
   SendMessage,
+  DigestFlush,
+  DigestFlushLockService,
+  DigestFlushWorker,
   StoreSubscriberJobs,
   SubscriberJobBound,
   UpdateJobStatus,
diff --git a/libs/dal/src/repositories/job/job.entity.ts b/libs/dal/src/repositories/job/job.entity.ts
index 2a7a032244..674c284bb1 100644
--- a/libs/dal/src/repositories/job/job.entity.ts
+++ b/libs/dal/src/repositories/job/job.entity.ts
@@ -43,6 +43,17 @@ export class JobEntity {
   digest?: IWorkflowStepMetadata & {
     events?: any[];
+    flush?: {
+      dueAt?: string;
+      flushedAt?: string;
+      status?: 'pending' | 'flushed' | 'failed' | 'skipped';
+      eventCount?: number;
+      followerCount?: number;
+      lastError?: string;
+      workerId?: string;
+    };
   };
   type?: StepTypeEnum;
   _actorId?: string;
diff --git a/libs/dal/src/repositories/job/job.schema.ts b/libs/dal/src/repositories/job/job.schema.ts
index 8e96e0d214..cf3bb875a2 100644
--- a/libs/dal/src/repositories/job/job.schema.ts
+++ b/libs/dal/src/repositories/job/job.schema.ts
@@ -118,6 +118,32 @@ const jobSchema = new Schema<JobDBModel>(
         },
       },
+      flush: {
+        dueAt: {
+          type: Schema.Types.Date,
+        },
+        flushedAt: {
+          type: Schema.Types.Date,
+        },
+        status: {
+          type: Schema.Types.String,
+          enum: ['pending', 'flushed', 'failed', 'skipped'],
+        },
+        eventCount: {
+          type: Schema.Types.Number,
+        },
+        followerCount: {
+          type: Schema.Types.Number,
+        },
+        lastError: {
+          type: Schema.Types.String,
+        },
+        workerId: {
+          type: Schema.Types.String,
+        },
+      },
     },
     type: {
       type: Schema.Types.String,
@@ -438,4 +464,17 @@ jobSchema.index(
   }
 );
 
+jobSchema.index(
+  {
+    _environmentId: 1,
+    _organizationId: 1,
+    _subscriberId: 1,
+    'digest.flush.dueAt': 1,
+    'digest.flush.status': 1,
+  },
+  {
+    name: 'Digest flush worker due windows by subscriber',
+    partialFilterExpression: { type: 'digest', status: 'delayed' },
+  }
+);
+
 export const Job = (mongoose.models.Job as mongoose.Model<JobDBModel>) || mongoose.model<JobDBModel>('Job', jobSchema);
diff --git a/libs/dal/src/repositories/job/job.repository.ts b/libs/dal/src/repositories/job/job.repository.ts
index 59bf3bcb7e..bdab10d2c2 100644
--- a/libs/dal/src/repositories/job/job.repository.ts
+++ b/libs/dal/src/repositories/job/job.repository.ts
@@ -29,6 +29,43 @@ export interface IDelayOrDigestJobResult {
   activeNotificationId?: string;
 }
 
+export type FindDueDigestMastersArgs = {
+  environmentId: string;
+  organizationId: string;
+  subscriberId?: string;
+  templateId?: string;
+  digestKey?: string;
+  digestValue?: string;
+  now: Date;
+  limit: number;
+};
+
+export type FindMergedDigestFollowersForFlushArgs = {
+  environmentId: string;
+  organizationId: string;
+  masterJobId: string;
+  subscriberId: string;
+};
+
+export type PersistDigestFlushArgs = {
+  environmentId: string;
+  organizationId: string;
+  masterJobId: string;
+  eventPayloads: Array<Record<string, unknown>>;
+  followerJobIds: string[];
+  flushedAt: Date;
+};
+
+export type EnqueueNextJobsForFlushedDigestArgs = {
+  environmentId: string;
+  organizationId: string;
+  masterJobId: string;
+  transactionId: string;
+};
+
 export class JobRepository extends BaseRepository<JobDBModel, JobEntity, EnforceEnvOrOrgIds> {
   constructor() {
     super(Job, JobEntity);
@@ -299,6 +336,152 @@ export class JobRepository extends BaseRepository<JobDBModel, JobEntity, EnforceE
 
     return updatedJobs;
   }
+
+  public async findDueDigestMasters(args: FindDueDigestMastersArgs): Promise<JobEntity[]> {
+    const query: Record<string, unknown> = {
+      _environmentId: this.convertStringToObjectId(args.environmentId),
+      _organizationId: this.convertStringToObjectId(args.organizationId),
+      status: JobStatusEnum.DELAYED,
+      type: StepTypeEnum.DIGEST,
+      _mergedDigestId: null,
+      $or: [
+        { 'digest.flush.status': { $exists: false } },
+        { 'digest.flush.status': 'pending' },
+        { 'digest.flush.status': 'failed' },
+      ],
+      'digest.flush.dueAt': {
+        $lte: args.now,
+      },
+    };
+
+    if (args.subscriberId) {
+      query._subscriberId = this.convertStringToObjectId(args.subscriberId);
+    }
+
+    if (args.templateId) {
+      query._templateId = this.convertStringToObjectId(args.templateId);
+    }
+
+    if (args.digestKey) {
+      query['digest.digestKey'] = args.digestKey;
+    }
+
+    if (args.digestValue) {
+      query['digest.digestValue'] = args.digestValue;
+    }
+
+    const jobs = await this.MongooseModel.find(query)
+      .sort({
+        _subscriberId: 1,
+        'digest.flush.dueAt': 1,
+        createdAt: 1,
+      })
+      .limit(args.limit)
+      .lean()
+      .exec();
+
+    return jobs.map((job) => this.mapEntity(job));
+  }
+
+  public async findMergedDigestFollowersForFlush(
+    args: FindMergedDigestFollowersForFlushArgs
+  ): Promise<JobEntity[]> {
+    const followers = await this.MongooseModel.find({
+      _environmentId: this.convertStringToObjectId(args.environmentId),
+      _organizationId: this.convertStringToObjectId(args.organizationId),
+      _subscriberId: this.convertStringToObjectId(args.subscriberId),
+      _mergedDigestId: this.convertStringToObjectId(args.masterJobId),
+      status: JobStatusEnum.MERGED,
+      type: StepTypeEnum.DIGEST,
+    })
+      .sort({ createdAt: 1 })
+      .lean()
+      .exec();
+
+    return followers.map((job) => this.mapEntity(job));
+  }
+
+  public async persistDigestFlush(args: PersistDigestFlushArgs): Promise<void> {
+    await this.MongooseModel.updateOne(
+      {
+        _environmentId: this.convertStringToObjectId(args.environmentId),
+        _organizationId: this.convertStringToObjectId(args.organizationId),
+        _id: this.convertStringToObjectId(args.masterJobId),
+        status: JobStatusEnum.DELAYED,
+        type: StepTypeEnum.DIGEST,
+      },
+      {
+        $set: {
+          'digest.events': args.eventPayloads,
+          'digest.flush.status': 'flushed',
+          'digest.flush.flushedAt': args.flushedAt,
+          'digest.flush.eventCount': args.eventPayloads.length,
+          'digest.flush.followerCount': args.followerJobIds.length,
+        },
+      }
+    );
+
+    if (args.followerJobIds.length === 0) {
+      return;
+    }
+
+    await this.MongooseModel.updateMany(
+      {
+        _environmentId: this.convertStringToObjectId(args.environmentId),
+        _organizationId: this.convertStringToObjectId(args.organizationId),
+        _id: {
+          $in: args.followerJobIds.map((id) => this.convertStringToObjectId(id)),
+        },
+      },
+      {
+        $set: {
+          'digest.flush.status': 'flushed',
+          'digest.flush.flushedAt': args.flushedAt,
+        },
+      }
+    );
+  }
+
+  public async enqueueNextJobsForFlushedDigest(args: EnqueueNextJobsForFlushedDigestArgs): Promise<void> {
+    const nextJobs = await this.MongooseModel.find({
+      _environmentId: this.convertStringToObjectId(args.environmentId),
+      _organizationId: this.convertStringToObjectId(args.organizationId),
+      transactionId: args.transactionId,
+      status: JobStatusEnum.PENDING,
+      _parentId: this.convertStringToObjectId(args.masterJobId),
+    })
+      .select('_id')
+      .lean()
+      .exec();
+
+    if (nextJobs.length === 0) {
+      return;
+    }
+
+    await this.MongooseModel.updateMany(
+      {
+        _environmentId: this.convertStringToObjectId(args.environmentId),
+        _organizationId: this.convertStringToObjectId(args.organizationId),
+        _id: {
+          $in: nextJobs.map((job) => job._id),
+        },
+      },
+      {
+        $set: {
+          status: JobStatusEnum.QUEUED,
+        },
+      }
+    );
+  }
 
   public async cancelPendingJobs({
     _environmentId,
diff --git a/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.spec.ts b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.spec.ts
new file mode 100644
index 0000000000..56fd89f45f
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.spec.ts
@@ -0,0 +1,215 @@
+import { DigestFlushLockService } from './digest-flush-lock.service';
+
+function createCache() {
+  const values = new Map<string, string>();
+  return {
+    values,
+    set: jest.fn(async (key: string, value: string, options: { ttl: number; NX?: boolean }) => {
+      if (options.NX && values.has(key)) {
+        return false;
+      }
+      values.set(key, value);
+      return true;
+    }),
+    get: jest.fn(async (key: string) => values.get(key)),
+    del: jest.fn(async (key: string) => {
+      values.delete(key);
+    }),
+  };
+}
+
+function createWindow(overrides: Partial<any> = {}) {
+  return {
+    masterJobId: overrides.masterJobId ?? 'job-master-a',
+    notificationId: overrides.notificationId ?? 'notification-a',
+    environmentId: overrides.environmentId ?? 'env-a',
+    organizationId: overrides.organizationId ?? 'org-a',
+    subscriberId: overrides.subscriberId ?? 'subscriber-a',
+    templateId: overrides.templateId ?? 'workflow-a',
+    digestKey: overrides.digestKey ?? 'teamId',
+    digestValue: overrides.digestValue ?? 'team-a',
+    dueAt: overrides.dueAt ?? new Date('2026-01-01T00:00:00.000Z'),
+  };
+}
+
+describe('DigestFlushLockService', () => {
+  it('builds one lock key for all windows belonging to a subscriber', () => {
+    const service = new DigestFlushLockService(createCache() as any);
+
+    expect(
+      service.buildSubscriberFlushLockKey({
+        organizationId: 'org-a',
+        environmentId: 'env-a',
+        subscriberId: 'subscriber-a',
+      })
+    ).toBe('digest-flush:org-a:env-a:subscriber-a');
+  });
+
+  it('groups every workflow for a subscriber behind the same lock', () => {
+    const service = new DigestFlushLockService(createCache() as any);
+    const grouped = service.groupBySubscriber([
+      createWindow({ masterJobId: 'job-a', subscriberId: 'subscriber-a', templateId: 'workflow-a' }),
+      createWindow({ masterJobId: 'job-b', subscriberId: 'subscriber-a', templateId: 'workflow-b' }),
+      createWindow({ masterJobId: 'job-c', subscriberId: 'subscriber-a', templateId: 'workflow-c' }),
+      createWindow({ masterJobId: 'job-d', subscriberId: 'subscriber-b', templateId: 'workflow-a' }),
+    ]);
+
+    expect(grouped.get('subscriber-a')?.map((window) => window.templateId)).toEqual([
+      'workflow-a',
+      'workflow-b',
+      'workflow-c',
+    ]);
+    expect(grouped.get('subscriber-b')?.map((window) => window.templateId)).toEqual(['workflow-a']);
+  });
+
+  it('sorts subscriber windows by due date before flushing', () => {
+    const service = new DigestFlushLockService(createCache() as any);
+    const grouped = service.groupBySubscriber([
+      createWindow({
+        masterJobId: 'job-c',
+        templateId: 'workflow-c',
+        dueAt: new Date('2026-01-01T00:00:30.000Z'),
+      }),
+      createWindow({
+        masterJobId: 'job-a',
+        templateId: 'workflow-a',
+        dueAt: new Date('2026-01-01T00:00:00.000Z'),
+      }),
+      createWindow({
+        masterJobId: 'job-b',
+        templateId: 'workflow-b',
+        dueAt: new Date('2026-01-01T00:00:10.000Z'),
+      }),
+    ]);
+
+    expect(grouped.get('subscriber-a')?.map((window) => window.masterJobId)).toEqual(['job-a', 'job-b', 'job-c']);
+  });
+
+  it('skips a second worker while a subscriber lock is active', async () => {
+    const cache = createCache();
+    const service = new DigestFlushLockService(cache as any);
+    let release!: () => void;
+    const blocked = new Promise<void>((resolve) => {
+      release = resolve;
+    });
+
+    const first = service.withSubscriberFlushLock(
+      {
+        organizationId: 'org-a',
+        environmentId: 'env-a',
+        subscriberId: 'subscriber-a',
+      },
+      async () => {
+        await blocked;
+        return 'done';
+      }
+    );
+
+    const second = await service.withSubscriberFlushLock(
+      {
+        organizationId: 'org-a',
+        environmentId: 'env-a',
+        subscriberId: 'subscriber-a',
+      },
+      async () => 'should not run'
+    );
+
+    release();
+    const firstResult = await first;
+
+    expect(firstResult.acquired).toBe(true);
+    expect(second.acquired).toBe(false);
+    expect(second.key).toBe('digest-flush:org-a:env-a:subscriber-a');
+  });
+
+  it('allows a different subscriber to flush concurrently', async () => {
+    const cache = createCache();
+    const service = new DigestFlushLockService(cache as any);
+
+    const [first, second] = await Promise.all([
+      service.withSubscriberFlushLock(
+        {
+          organizationId: 'org-a',
+          environmentId: 'env-a',
+          subscriberId: 'subscriber-a',
+        },
+        async () => 'a'
+      ),
+      service.withSubscriberFlushLock(
+        {
+          organizationId: 'org-a',
+          environmentId: 'env-a',
+          subscriberId: 'subscriber-b',
+        },
+        async () => 'b'
+      ),
+    ]);
+
+    expect(first.acquired).toBe(true);
+    expect(second.acquired).toBe(true);
+  });
+});
diff --git a/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.spec.ts b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.spec.ts
new file mode 100644
index 0000000000..5169ae895e
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.spec.ts
@@ -0,0 +1,401 @@
+import { DigestFlushCommand } from './digest-flush.command';
+import { DigestFlush } from './digest-flush.usecase';
+
+function createJob(overrides: Partial<any> = {}) {
+  return {
+    _id: overrides._id ?? 'job-master-a',
+    _environmentId: overrides._environmentId ?? 'env-a',
+    _organizationId: overrides._organizationId ?? 'org-a',
+    _subscriberId: overrides._subscriberId ?? 'subscriber-a',
+    _templateId: overrides._templateId ?? 'workflow-a',
+    _notificationId: overrides._notificationId ?? 'notification-a',
+    _mergedDigestId: overrides._mergedDigestId ?? null,
+    transactionId: overrides.transactionId ?? 'transaction-a',
+    status: overrides.status ?? 'delayed',
+    type: overrides.type ?? 'digest',
+    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
+    updatedAt: overrides.updatedAt ?? '2026-01-01T00:01:00.000Z',
+    payload: overrides.payload ?? { eventId: overrides._id ?? 'job-master-a' },
+    digest: {
+      digestKey: overrides.digestKey ?? 'teamId',
+      digestValue: overrides.digestValue ?? 'team-a',
+      flush: {
+        dueAt: overrides.dueAt ?? '2026-01-01T00:01:00.000Z',
+      },
+      ...(overrides.digest ?? {}),
+    },
+    ...overrides,
+  };
+}
+
+function createRepository(overrides: Partial<any> = {}) {
+  return {
+    findDueDigestMasters: jest.fn(),
+    findMergedDigestFollowersForFlush: jest.fn(),
+    persistDigestFlush: jest.fn(),
+    enqueueNextJobsForFlushedDigest: jest.fn(),
+    findOne: jest.fn(),
+    ...overrides,
+  };
+}
+
+function createLockService() {
+  return {
+    groupBySubscriber: jest.fn((windows) => {
+      const grouped = new Map<string, any[]>();
+      for (const window of windows) {
+        grouped.set(window.subscriberId, [...(grouped.get(window.subscriberId) ?? []), window]);
+      }
+      return grouped;
+    }),
+    withSubscriberFlushLock: jest.fn(async (_args, run) => ({
+      acquired: true,
+      key: 'lock',
+      value: await run(),
+    })),
+    withWindowLog: jest.fn(async (_window, run) => run()),
+  };
+}
+
+function createExecutionDetails() {
+  return {
+    execute: jest.fn(async () => undefined),
+  };
+}
+
+describe('DigestFlush', () => {
+  it('flushes every due digest window for a subscriber serially under one lock', async () => {
+    const masterA = createJob({ _id: 'job-master-a', _templateId: 'workflow-a', transactionId: 'transaction-a' });
+    const masterB = createJob({ _id: 'job-master-b', _templateId: 'workflow-b', transactionId: 'transaction-b' });
+    const repo = createRepository();
+    repo.findDueDigestMasters.mockResolvedValue([masterA, masterB]);
+    repo.findOne.mockImplementation(async (query) => {
+      if (query._id === 'job-master-a') return masterA;
+      if (query._id === 'job-master-b') return masterB;
+      return null;
+    });
+    repo.findMergedDigestFollowersForFlush.mockResolvedValue([]);
+    const lock = createLockService();
+    const usecase = new DigestFlush(repo as any, lock as any, createExecutionDetails() as any);
+
+    const result = await usecase.execute(
+      DigestFlushCommand.create({
+        environmentId: 'env-a',
+        organizationId: 'org-a',
+      })
+    );
+
+    expect(result.flushed).toBe(2);
+    expect(lock.withSubscriberFlushLock).toHaveBeenCalledTimes(1);
+    expect(lock.withSubscriberFlushLock).toHaveBeenCalledWith(
+      {
+        organizationId: 'org-a',
+        environmentId: 'env-a',
+        subscriberId: 'subscriber-a',
+      },
+      expect.any(Function)
+    );
+    expect(repo.persistDigestFlush).toHaveBeenNthCalledWith(
+      1,
+      expect.objectContaining({
+        masterJobId: 'job-master-a',
+      })
+    );
+    expect(repo.persistDigestFlush).toHaveBeenNthCalledWith(
+      2,
+      expect.objectContaining({
+        masterJobId: 'job-master-b',
+      })
+    );
+  });
+
+  it('skips all windows for a subscriber when the subscriber lock is held', async () => {
+    const masterA = createJob({ _id: 'job-master-a', _templateId: 'workflow-a' });
+    const masterB = createJob({ _id: 'job-master-b', _templateId: 'workflow-b' });
+    const repo = createRepository();
+    repo.findDueDigestMasters.mockResolvedValue([masterA, masterB]);
+    const lock = createLockService();
+    lock.withSubscriberFlushLock.mockResolvedValue({
+      acquired: false,
+      key: 'digest-flush:org-a:env-a:subscriber-a',
+    });
+    const usecase = new DigestFlush(repo as any, lock as any, createExecutionDetails() as any);
+
+    const result = await usecase.execute(
+      DigestFlushCommand.create({
+        environmentId: 'env-a',
+        organizationId: 'org-a',
+      })
+    );
+
+    expect(result.flushed).toBe(0);
+    expect(result.skipped).toBe(2);
+    expect(result.windows.map((window) => window.templateId)).toEqual(['workflow-a', 'workflow-b']);
+    expect(repo.persistDigestFlush).not.toHaveBeenCalled();
+  });
+
+  it('persists the master payload and all follower payloads in one digest events array', async () => {
+    const master = createJob({ _id: 'job-master-a', payload: { eventId: 'master' } });
+    const followers = Array.from({ length: 4 }, (_, index) =>
+      createJob({
+        _id: `job-follower-${index}`,
+        _mergedDigestId: 'job-master-a',
+        status: 'merged',
+        payload: { eventId: `follower-${index}` },
+        createdAt: `2026-01-01T00:00:0${index}.000Z`,
+      })
+    );
+    const repo = createRepository();
+    repo.findDueDigestMasters.mockResolvedValue([master]);
+    repo.findOne.mockResolvedValue(master);
+    repo.findMergedDigestFollowersForFlush.mockResolvedValue(followers);
+    const usecase = new DigestFlush(repo as any, createLockService() as any, createExecutionDetails() as any);
+
+    const result = await usecase.execute(
+      DigestFlushCommand.create({
+        environmentId: 'env-a',
+        organizationId: 'org-a',
+      })
+    );
+
+    expect(result.windows[0].eventCount).toBe(5);
+    expect(repo.persistDigestFlush).toHaveBeenCalledWith(
+      expect.objectContaining({
+        masterJobId: 'job-master-a',
+        eventPayloads: expect.arrayContaining([
+          expect.objectContaining({ payload: { eventId: 'master' } }),
+          expect.objectContaining({ payload: { eventId: 'follower-0' } }),
+          expect.objectContaining({ payload: { eventId: 'follower-1' } }),
+          expect.objectContaining({ payload: { eventId: 'follower-2' } }),
+          expect.objectContaining({ payload: { eventId: 'follower-3' } }),
+        ]),
+      })
+    );
+  });
+
+  it('allows a very large digest window to flush in a single payload', async () => {
+    const master = createJob({ _id: 'job-master-a', payload: { eventId: 'master' } });
+    const followers = Array.from({ length: 5000 }, (_, index) =>
+      createJob({
+        _id: `job-follower-${index}`,
+        _mergedDigestId: 'job-master-a',
+        status: 'merged',
+        payload: {
+          eventId: `follower-${index}`,
+          body: 'large-notification-body'.repeat(20),
+        },
+        createdAt: new Date(2026, 0, 1, 0, 0, index % 60).toISOString(),
+      })
+    );
+    const repo = createRepository();
+    repo.findDueDigestMasters.mockResolvedValue([master]);
+    repo.findOne.mockResolvedValue(master);
+    repo.findMergedDigestFollowersForFlush.mockResolvedValue(followers);
+    const usecase = new DigestFlush(repo as any, createLockService() as any, createExecutionDetails() as any);
+
+    const result = await usecase.execute(
+      DigestFlushCommand.create({
+        environmentId: 'env-a',
+        organizationId: 'org-a',
+      })
+    );
+
+    expect(result.flushed).toBe(1);
+    expect(result.windows[0].eventCount).toBe(5001);
+    expect(repo.persistDigestFlush).toHaveBeenCalledWith(
+      expect.objectContaining({
+        eventPayloads: expect.arrayContaining([
+          expect.objectContaining({ payload: { eventId: 'master' } }),
+          expect.objectContaining({ payload: expect.objectContaining({ eventId: 'follower-4999' }) }),
+        ]),
+      })
+    );
+  });
+
+  it('does not split a digest window when followers have multiple digest keys', async () => {
+    const master = createJob({
+      _id: 'job-master-a',
+      digestKey: 'teamId',
+      digestValue: 'team-a',
+      payload: { teamId: 'team-a', eventId: 'master' },
+    });
+    const followers = [
+      createJob({
+        _id: 'job-follower-a',
+        _mergedDigestId: 'job-master-a',
+        status: 'merged',
+        digestKey: 'teamId',
+        digestValue: 'team-a',
+        payload: { teamId: 'team-a', eventId: 'a' },
+      }),
+      createJob({
+        _id: 'job-follower-b',
+        _mergedDigestId: 'job-master-a',
+        status: 'merged',
+        digestKey: 'teamId',
+        digestValue: 'team-a',
+        payload: { teamId: 'team-a', eventId: 'b' },
+      }),
+    ];
+    const repo = createRepository();
+    repo.findDueDigestMasters.mockResolvedValue([master]);
+    repo.findOne.mockResolvedValue(master);
+    repo.findMergedDigestFollowersForFlush.mockResolvedValue(followers);
+    const usecase = new DigestFlush(repo as any, createLockService() as any, createExecutionDetails() as any);
+
+    await usecase.execute(
+      DigestFlushCommand.create({
+        environmentId: 'env-a',
+        organizationId: 'org-a',
+      })
+    );
+
+    expect(repo.persistDigestFlush).toHaveBeenCalledWith(
+      expect.objectContaining({
+        eventPayloads: expect.arrayContaining([
+          expect.objectContaining({ payload: expect.objectContaining({ eventId: 'master' }) }),
+          expect.objectContaining({ payload: expect.objectContaining({ eventId: 'a' }) }),
+          expect.objectContaining({ payload: expect.objectContaining({ eventId: 'b' }) }),
+        ]),
+      })
+    );
+  });
+});
diff --git a/apps/api/src/app/events/e2e/digest-flush.e2e.ts b/apps/api/src/app/events/e2e/digest-flush.e2e.ts
new file mode 100644
index 0000000000..c0a70e114a
--- /dev/null
+++ b/apps/api/src/app/events/e2e/digest-flush.e2e.ts
@@ -0,0 +1,302 @@
+import { expect } from 'chai';
+import { JobRepository, JobStatusEnum } from '@novu/dal';
+import { DigestTypeEnum, DigestUnitEnum, StepTypeEnum } from '@novu/shared';
+import { DigestFlush, DigestFlushCommand } from '../../../../worker/src/app/workflow/usecases/digest-flush';
+import { createEvent, createSubscriber, createWorkflow, seedEnvironment } from '../helpers';
+
+describe('Digest flush worker e2e', () => {
+  let jobRepository: JobRepository;
+  let digestFlush: DigestFlush;
+
+  beforeEach(async () => {
+    jobRepository = new JobRepository();
+    digestFlush = global.resolve(DigestFlush);
+  });
+
+  it('flushes two workflows for the same subscriber from one worker pass', async () => {
+    const { environment, organization } = await seedEnvironment();
+    const subscriber = await createSubscriber(environment._id, {
+      subscriberId: 'subscriber-a',
+      email: 'subscriber-a@example.com',
+    });
+    const workflowA = await createWorkflow(environment._id, {
+      identifier: 'comments-digest',
+      steps: [
+        {
+          type: StepTypeEnum.DIGEST,
+          metadata: {
+            type: DigestTypeEnum.REGULAR,
+            amount: 5,
+            unit: DigestUnitEnum.MINUTES,
+            digestKey: 'postId',
+          },
+        },
+        {
+          type: StepTypeEnum.EMAIL,
+          content: 'comments digest',
+        },
+      ],
+    });
+    const workflowB = await createWorkflow(environment._id, {
+      identifier: 'mentions-digest',
+      steps: [
+        {
+          type: StepTypeEnum.DIGEST,
+          metadata: {
+            type: DigestTypeEnum.REGULAR,
+            amount: 5,
+            unit: DigestUnitEnum.MINUTES,
+            digestKey: 'teamId',
+          },
+        },
+        {
+          type: StepTypeEnum.EMAIL,
+          content: 'mentions digest',
+        },
+      ],
+    });
+
+    await createEvent(environment, subscriber, workflowA, {
+      transactionId: 'transaction-a',
+      payload: { postId: 'post-a', body: 'first comment' },
+    });
+    await createEvent(environment, subscriber, workflowB, {
+      transactionId: 'transaction-b',
+      payload: { teamId: 'team-a', body: 'first mention' },
+    });
+
+    await jobRepository.update(
+      {
+        _environmentId: environment._id,
+        _subscriberId: subscriber._id,
+        type: StepTypeEnum.DIGEST,
+        status: JobStatusEnum.DELAYED,
+      },
+      {
+        $set: {
+          'digest.flush.dueAt': new Date(Date.now() - 1000),
+          'digest.flush.status': 'pending',
+        },
+      }
+    );
+
+    const result = await digestFlush.execute(
+      DigestFlushCommand.create({
+        environmentId: environment._id,
+        organizationId: organization._id,
+        subscriberId: subscriber._id,
+      })
+    );
+
+    expect(result.scanned).to.equal(2);
+    expect(result.flushed).to.equal(2);
+    expect(result.lockedSubscribers).to.equal(1);
+
+    const masters = await jobRepository.find({
+      _environmentId: environment._id,
+      _subscriberId: subscriber._id,
+      type: StepTypeEnum.DIGEST,
+      status: JobStatusEnum.DELAYED,
+    });
+
+    expect(masters.map((job) => job.digest?.flush?.status)).to.deep.equal(['flushed', 'flushed']);
+  });
+
+  it('flushes a single digest with thousands of merged followers', async () => {
+    const { environment, organization } = await seedEnvironment();
+    const subscriber = await createSubscriber(environment._id, {
+      subscriberId: 'subscriber-large-window',
+      email: 'large-window@example.com',
+    });
+    const workflow = await createWorkflow(environment._id, {
+      identifier: 'large-digest',
+      steps: [
+        {
+          type: StepTypeEnum.DIGEST,
+          metadata: {
+            type: DigestTypeEnum.REGULAR,
+            amount: 30,
+            unit: DigestUnitEnum.MINUTES,
+            digestKey: 'teamId',
+          },
+        },
+        {
+          type: StepTypeEnum.EMAIL,
+          content: 'large digest',
+        },
+      ],
+    });
+
+    for (let index = 0; index < 2500; index += 1) {
+      await createEvent(environment, subscriber, workflow, {
+        transactionId: `transaction-${index}`,
+        payload: {
+          teamId: 'team-a',
+          eventId: `event-${index}`,
+          body: 'A digestable event body that is intentionally realistic in size.',
+        },
+      });
+    }
+
+    const master = await jobRepository.findOne({
+      _environmentId: environment._id,
+      _subscriberId: subscriber._id,
+      type: StepTypeEnum.DIGEST,
+      status: JobStatusEnum.DELAYED,
+      _mergedDigestId: null,
+    });
+    expect(master).to.exist;
+
+    await jobRepository.updateOne(
+      {
+        _environmentId: environment._id,
+        _id: master!._id,
+      },
+      {
+        $set: {
+          'digest.flush.dueAt': new Date(Date.now() - 1000),
+          'digest.flush.status': 'pending',
+        },
+      }
+    );
+
+    const result = await digestFlush.execute(
+      DigestFlushCommand.create({
+        environmentId: environment._id,
+        organizationId: organization._id,
+        subscriberId: subscriber._id,
+      })
+    );
+
+    expect(result.flushed).to.equal(1);
+    expect(result.windows[0].eventCount).to.equal(2500);
+
+    const updatedMaster = await jobRepository.findOne({
+      _environmentId: environment._id,
+      _id: master!._id,
+    });
+
+    expect(updatedMaster?.digest?.events).to.have.length(2500);
+    expect(updatedMaster?.digest?.flush?.eventCount).to.equal(2500);
+  });
+
+  it('does not flush a window that is not due yet', async () => {
+    const { environment, organization } = await seedEnvironment();
+    const subscriber = await createSubscriber(environment._id, {
+      subscriberId: 'subscriber-future',
+      email: 'future@example.com',
+    });
+    const workflow = await createWorkflow(environment._id, {
+      identifier: 'future-digest',
+      steps: [
+        {
+          type: StepTypeEnum.DIGEST,
+          metadata: {
+            type: DigestTypeEnum.REGULAR,
+            amount: 30,
+            unit: DigestUnitEnum.MINUTES,
+          },
+        },
+      ],
+    });
+
+    await createEvent(environment, subscriber, workflow, {
+      transactionId: 'transaction-future',
+      payload: { body: 'not due' },
+    });
+
+    await jobRepository.update(
+      {
+        _environmentId: environment._id,
+        _subscriberId: subscriber._id,
+        type: StepTypeEnum.DIGEST,
+      },
+      {
+        $set: {
+          'digest.flush.dueAt': new Date(Date.now() + 60_000),
+          'digest.flush.status': 'pending',
+        },
+      }
+    );
+
+    const result = await digestFlush.execute(
+      DigestFlushCommand.create({
+        environmentId: environment._id,
+        organizationId: organization._id,
+        subscriberId: subscriber._id,
+      })
+    );
+
+    expect(result.scanned).to.equal(0);
+    expect(result.flushed).to.equal(0);
+  });
+});
diff --git a/docs/workers/digest-flush-worker.md b/docs/workers/digest-flush-worker.md
new file mode 100644
index 0000000000..80d83d1e52
--- /dev/null
+++ b/docs/workers/digest-flush-worker.md
@@ -0,0 +1,249 @@
+# Digest flush worker
+
+The digest flush worker scans due digest masters and persists the final
+`digest.events` payload before queueing the next workflow step.
+
+## Why this worker exists
+
+A digest step can receive many events during its time window. The normal workflow
+path stores one delayed digest master and merges later events into that master.
+The flush worker lets us collect those merged events on a predictable cadence.
+
+## Queue
+
+The worker consumes the `digest-flush` queue.
+
+```ts
+await digestFlushWorker.enqueue({
+  environmentId,
+  organizationId,
+  subscriberId,
+  requestedAt: new Date().toISOString(),
+});
+```
+
+Recurring flush jobs are scheduled per environment. Operators can also enqueue a
+subscriber-specific job when debugging a delayed digest.
+
+## Locking
+
+Only one flush is allowed per subscriber at a time. The lock key is:
+
+```txt
+digest-flush:{organizationId}:{environmentId}:{subscriberId}
+```
+
+If two workers pick up due digest windows for the same subscriber, the second
+worker skips every window for that subscriber. A later recurring scan will pick
+them up again.
+
+This keeps the implementation simple and avoids two workers writing
+`digest.events` for the same subscriber concurrently.
+
+## Window order
+
+Windows are grouped by subscriber and sorted by due time. A worker flushes all
+due windows for the subscriber before releasing the subscriber lock.
+
+For example, if a subscriber has due digests for `comments`, `mentions`, and
+`weekly-summary`, the worker flushes them in due-time order under the same lock.
+
+## Payload shape
+
+The persisted payload is an array of event records:
+
+```json
+[
+  {
+    "payload": {
+      "teamId": "team-a",
+      "body": "first event"
+    },
+    "transactionId": "transaction-a",
+    "jobId": "job-a",
+    "notificationId": "notification-a",
+    "createdAt": "2026-01-01T00:00:00.000Z"
+  }
+]
+```
+
+The master event appears first, followed by merged follower events ordered by
+creation time.
+
+## Large windows
+
+The worker stores all merged follower events in the master job's `digest.events`
+array. It does not split windows. Templates that render digest summaries can use
+`digest.events.length` to show the total count.
+
+Applications that expect very large digests should keep the rendered template
+short and avoid rendering every event as a full paragraph.
+
+## Failure handling
+
+Worker jobs retry three times with exponential backoff. A failed window remains
+eligible for the next scan because `digest.flush.status` can be `failed`.
+
+## Operating notes
+
+Watch these metrics:
+
+- `digest_flush.scanned`
+- `digest_flush.flushed`
+- `digest_flush.skipped`
+- `digest_flush.failed`
+- `digest_flush.event_count`
+
+A high skipped count usually means the same subscriber has many windows due at
+the same time.
+
+## Manual recovery
+
+To replay a subscriber:
+
+```ts
+await digestFlush.execute(
+  DigestFlushCommand.create({
+    environmentId,
+    organizationId,
+    subscriberId,
+    limit: 100,
+  })
+);
+```
+
+Use `dryRun: true` to inspect windows without writing `digest.events`.
```

## Intended Flaws

### Flaw 1: The worker uses a subscriber-wide lock that serializes unrelated digest windows

The PR treats the subscriber as the entire concurrency boundary. That is broader than the digest contract, which is scoped by workflow/template, digest key/value, and the active digest window.

Relevant line references:

- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.ts:27-34` builds a lock key from only organization, environment, and subscriber.
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.ts:116-134` groups all due windows by subscriber before sorting them.
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.ts:53-79` acquires one subscriber lock and flushes every workflow window for that subscriber inside that single lock.
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush-lock.service.spec.ts:48-61` encodes the behavior that three workflows for one subscriber share the same lock group.
- `docs/workers/digest-flush-worker.md:30-41` documents subscriber-level locking as the worker contract.

Why this is a real flaw:

Digest ownership is not just "subscriber". A subscriber can have separate digest windows for comments, mentions, alerts, and weekly summaries. A slow or giant digest for one workflow should not hold up unrelated due windows for the same subscriber. With this lock shape, one hot workflow serializes all other workflows for that subscriber, causing avoidable latency and confusing skipped-window retries.

Better implementation direction:

Lock at the digest window boundary: environment, subscriber, workflow/template, digest key, digest value, and master digest id or window id. The worker can still prevent duplicate writes for the same digest master while allowing unrelated windows for the same subscriber to flush concurrently. The repository index and lock key should express the same ownership model.

### Flaw 2: The worker builds and persists unbounded digest payloads

The PR collects all merged follower jobs and writes all payloads into one `digest.events` array without a maximum event count, byte budget, or split/continuation contract.

Relevant line references:

- `libs/dal/src/repositories/job/job.repository.ts:386-400` returns every merged follower for a master without a limit or projection budget.
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.ts:198-215` builds one event object per master/follower and never checks count or payload size.
- `libs/dal/src/repositories/job/job.repository.ts:404-421` persists the entire event array to `digest.events` in one update.
- `apps/worker/src/app/workflow/usecases/digest-flush/digest-flush.usecase.spec.ts:176-213` asserts that 5,001 events should flush as a single payload.
- `docs/workers/digest-flush-worker.md:75-80` says the worker stores all merged follower events and does not split windows.

Why this is a real flaw:

Digest windows are customer-controlled by event volume and configured time. A high-volume subscriber can create thousands of follower jobs. Writing every payload into one job document can exceed document limits, slow rendering, increase memory pressure, create huge execution-detail/log records, and make retries repeat expensive work. The worker needs backpressure and payload boundaries before it becomes a production-safe ingestion path.

Better implementation direction:

Define flush thresholds: maximum events, maximum serialized bytes, maximum render payload, and possibly maximum window age. Flush in chunks or store event references/counts instead of full payloads. If the product needs "all events", use a continuation/cursor contract and render summaries by default. Tests should cover threshold boundaries and retry-safe partial flushes.

## Hints

### Flaw 1 Hints

1. What fields define a digest group in the existing code: only subscriber, or also workflow and digest key/value?
2. Imagine a subscriber has one massive weekly digest and one small password-alert digest due at the same time. Which one waits?
3. Compare the lock key with the unique delayed-digest index in the existing schema. Do they describe the same ownership boundary?

### Flaw 2 Hints

1. Where does the PR decide how many follower jobs can be loaded for one digest master?
2. What happens when every event payload is large and the digest window contains thousands of events?
3. Is there a contract for chunking, truncating, summarizing, or resuming a partially flushed digest?

## Expected Answer

A strong review should say that the product-level change is a dedicated worker for flushing due digest windows. The idea is reasonable, but the implementation weakens two core background-job fundamentals: precise lock ownership and bounded work.

For flaw 1, the learner should identify that the worker locks per subscriber and runs unrelated workflow windows under the same lock. The impact is artificial serialization, skipped windows, and latency for unrelated digests. The fix is to lock per digest window or digest master, using workflow/template plus digest key/value in the lock and repository query contract.

For flaw 2, the learner should identify that the worker reads and writes an unbounded number of event payloads. The impact is oversized job documents, memory pressure, slow rendering, repeated expensive retries, and possible data loss or stuck windows when the payload exceeds storage limits. The fix is explicit thresholds, chunking, event references, and retry-safe continuation.

The best answers cite both worker code and tests/docs. The tests are especially important because they make the flawed behavior look intentional.

## Expert Debrief

At the product level, this PR tries to make digest delivery more predictable by moving flush work into a dedicated worker. That can be a good change. But workers need two things to be safe: the correct unit of ownership and a bounded amount of work per job.

The changed contract is not "subscriber has digests". It is "a digest master owns a window for a workflow and digest key/value for a subscriber." The existing code already hints at that: delayed digest masters are found by template, environment, subscriber, and digest value; the schema has a unique partial index around the digest grouping fields. A lock that ignores workflow and digest key/value is easier to write, but it creates a false bottleneck.

The failure modes are very practical:

- One subscriber's large digest blocks small urgent digests from other workflows.
- Recurring scans report skipped windows even though there is no duplicate risk for those windows.
- A single high-volume digest writes thousands of full payloads into one job document.
- A retry repeats the same large read and write, amplifying load.
- Rendering and execution-detail logging inherit a payload shape that can grow without a product cap.

The reviewer thought process should be: first identify the domain ownership key. Then compare the lock key, repository query, unique index, and tests. If those disagree, concurrency bugs are usually nearby. Next, estimate the maximum work a job can do. If the maximum is "whatever the customer sent", the worker is not production-safe yet.

The better implementation is to lock and flush per digest master/window, not per subscriber. Keep a small concurrency guard for exactly the window being mutated. Add event-count and byte thresholds, and choose a product contract for overflow: chunked flush, references plus count, summary-only rendering, or continuation windows. Then make tests assert the boundaries rather than celebrating huge single-payload flushes.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: subscriber-wide locking that serializes unrelated digest windows, and unbounded digest payload collection/persistence. It explains latency/skipped-window impact and payload/storage/retry risk, and suggests window-scoped locks plus explicit thresholds/chunking.
- `partial`: The answer finds one flaw completely and gestures at concurrency or large payload concerns without tying them to the digest ownership contract.
- `miss`: The answer focuses on naming, worker registration, or missing small error handling while missing lock granularity and bounded-work fundamentals.
