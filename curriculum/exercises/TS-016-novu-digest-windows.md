# TS-016: Novu Digest Windows

## Metadata

- `id`: TS-016
- `source_repo`: [novuhq/novu](https://github.com/novuhq/novu)
- `repo_area`: digest jobs, job DAL indexes, subscriber timezone, worker scheduling, workflow trigger pipeline, digest e2e coverage
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 1100
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about digest semantics, due-job polling, Mongo index shape, subscriber time zones, DST, and queue fairness without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds digest windows for grouped notifications.

Customers using digest steps want to group events into named windows, for example "send my comment digest at 9 AM in the subscriber's local time." Instead of only delaying a single digest job, the PR creates reusable digest-window records, appends triggered events to the current open window, and adds a worker that flushes due windows into existing Novu digest jobs.

The PR adds:

- a `DigestWindow` DAL entity and schema,
- repository helpers to find or create an open digest window,
- worker logic to poll due windows and enqueue a digest job,
- trigger pipeline integration so digest steps append events into windows,
- a workflow module provider for the worker,
- tests for merging events into a window and flushing a due digest.

## Existing Code Context

The real Novu codebase already has these relevant contracts:

- `libs/dal/src/repositories/job/job.schema.ts` stores workflow jobs and documents the hot digest queries next to their indexes. Digest jobs already use compound indexes that start with subscriber/workflow/type/status and include `createdAt` or `updatedAt` when those fields are part of the query.
- `libs/dal/src/repositories/job/job.repository.ts` has digest-specific helpers such as `getExistingDelayedJobWithTheSameDigestValue`, `findJobsToDigest`, and `updateAllChildJobStatus`. These queries are scoped by environment/subscriber/workflow/status/type.
- `apps/worker/src/app/workflow/usecases/add-job/merge-or-create-digest.usecase.ts` decides whether a digest job becomes the delayed master job, is merged into an existing digest, or is skipped.
- `libs/application-generic/src/services/calculate-delay/timed-digest-delay.service.ts` calculates timed digest delays using `date-fns-tz` and accepts an IANA timezone.
- `packages/js/src/session/session.ts` sends a browser-detected IANA timezone during inbox session initialization when the subscriber did not provide one.
- `libs/dal/src/repositories/subscriber/subscriber.schema.ts` already persists `timezone` on subscriber records.
- `apps/worker/src/app/workflow/usecases/run-job/run-job.usecase.ts` extends jobs to the next subscriber schedule using UTC instants plus timezone-aware formatting in execution details.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `libs/dal/src/repositories/digest-window/digest-window.entity.ts`
- `libs/dal/src/repositories/digest-window/digest-window.schema.ts`
- `libs/dal/src/repositories/digest-window/digest-window.repository.ts`
- `libs/dal/src/repositories/digest-window/index.ts`
- `libs/dal/src/repositories/index.ts`
- `libs/application-generic/src/services/digest-windows/digest-window.service.ts`
- `apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.command.ts`
- `apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.usecase.ts`
- `apps/worker/src/app/workflow/workflow.module.ts`
- `libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts`
- `apps/api/src/app/events/e2e/digest-windows.e2e.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally focused on storage contract, worker query shape, time semantics, and reviewer reasoning around background jobs.

## Diff

```diff
diff --git a/libs/dal/src/repositories/digest-window/digest-window.entity.ts b/libs/dal/src/repositories/digest-window/digest-window.entity.ts
new file mode 100644
index 0000000000..d8bce1567a
--- /dev/null
+++ b/libs/dal/src/repositories/digest-window/digest-window.entity.ts
@@ -0,0 +1,88 @@
+import type { ChangePropsValueType } from '../../types';
+import type { EnvironmentId } from '../environment';
+import type { OrganizationId } from '../organization';
+
+export enum DigestWindowStatusEnum {
+  OPEN = 'open',
+  PENDING = 'pending',
+  PROCESSING = 'processing',
+  FLUSHED = 'flushed',
+  FAILED = 'failed',
+}
+
+export type DigestWindowEvent = {
+  transactionId: string;
+  jobId: string;
+  payload: Record<string, unknown>;
+  overrides?: Record<string, unknown>;
+  createdAt: string;
+};
+
+export type DigestWindowDefinition = {
+  digestKey?: string;
+  digestValue?: string | number;
+  amount: number;
+  unit: string;
+  atTime?: string;
+  weekDays?: string[];
+  monthDays?: number[];
+};
+
+export class DigestWindowEntity {
+  _id: string;
+
+  _organizationId: OrganizationId;
+
+  _environmentId: EnvironmentId;
+
+  _templateId: string;
+
+  _subscriberId: string;
+
+  subscriberId: string;
+
+  stepId: string;
+
+  digestKey?: string;
+
+  digestValue?: string;
+
+  definition: DigestWindowDefinition;
+
+  status: DigestWindowStatusEnum;
+
+  windowStartLocal: string;
+
+  windowEndLocal: string;
+
+  nextFlushAt: Date;
+
+  eventCount: number;
+
+  events: DigestWindowEvent[];
+
+  lockedAt?: Date;
+
+  lockedBy?: string;
+
+  flushedAt?: Date;
+
+  flushJobId?: string;
+
+  lastError?: string;
+
+  createdAt: string;
+
+  updatedAt: string;
+}
+
+export type DigestWindowDBModel = ChangePropsValueType<
+  DigestWindowEntity,
+  '_environmentId' | '_organizationId' | '_subscriberId'
+>;
diff --git a/libs/dal/src/repositories/digest-window/digest-window.schema.ts b/libs/dal/src/repositories/digest-window/digest-window.schema.ts
new file mode 100644
index 0000000000..27e82e7ab0
--- /dev/null
+++ b/libs/dal/src/repositories/digest-window/digest-window.schema.ts
@@ -0,0 +1,147 @@
+import mongoose, { Schema } from 'mongoose';
+import { schemaOptions } from '../schema-default.options';
+import { DigestWindowDBModel, DigestWindowStatusEnum } from './digest-window.entity';
+
+const digestWindowSchema = new Schema<DigestWindowDBModel>(
+  {
+    _organizationId: {
+      type: Schema.Types.ObjectId,
+      ref: 'Organization',
+      required: true,
+    },
+    _environmentId: {
+      type: Schema.Types.ObjectId,
+      ref: 'Environment',
+      required: true,
+    },
+    _templateId: {
+      type: Schema.Types.ObjectId,
+      ref: 'NotificationTemplate',
+      required: true,
+    },
+    _subscriberId: {
+      type: Schema.Types.ObjectId,
+      ref: 'Subscriber',
+      required: true,
+    },
+    subscriberId: {
+      type: Schema.Types.String,
+      required: true,
+    },
+    stepId: {
+      type: Schema.Types.String,
+      required: true,
+    },
+    digestKey: {
+      type: Schema.Types.String,
+    },
+    digestValue: {
+      type: Schema.Types.String,
+    },
+    definition: {
+      amount: Schema.Types.Number,
+      unit: Schema.Types.String,
+      atTime: Schema.Types.String,
+      weekDays: [Schema.Types.String],
+      monthDays: [Schema.Types.Number],
+    },
+    status: {
+      type: Schema.Types.String,
+      enum: Object.values(DigestWindowStatusEnum),
+      default: DigestWindowStatusEnum.OPEN,
+    },
+    windowStartLocal: {
+      type: Schema.Types.String,
+      required: true,
+    },
+    windowEndLocal: {
+      type: Schema.Types.String,
+      required: true,
+    },
+    nextFlushAt: {
+      type: Schema.Types.Date,
+      required: true,
+    },
+    eventCount: {
+      type: Schema.Types.Number,
+      default: 0,
+    },
+    events: [
+      {
+        transactionId: Schema.Types.String,
+        jobId: Schema.Types.String,
+        payload: Schema.Types.Mixed,
+        overrides: Schema.Types.Mixed,
+        createdAt: Schema.Types.String,
+      },
+    ],
+    lockedAt: Schema.Types.Date,
+    lockedBy: Schema.Types.String,
+    flushedAt: Schema.Types.Date,
+    flushJobId: Schema.Types.String,
+    lastError: Schema.Types.String,
+  },
+  schemaOptions
+);
+
+/*
+ * Used by DigestWindowRepository.findOrCreateOpenWindow().
+ * Query:
+ * {
+ *   _environmentId,
+ *   _templateId,
+ *   _subscriberId,
+ *   stepId,
+ *   digestKey,
+ *   digestValue,
+ *   windowStartLocal,
+ *   status: DigestWindowStatusEnum.OPEN
+ * }
+ */
+digestWindowSchema.index(
+  {
+    _environmentId: 1,
+    _templateId: 1,
+    _subscriberId: 1,
+    stepId: 1,
+    digestKey: 1,
+    digestValue: 1,
+    windowStartLocal: 1,
+  },
+  {
+    name: 'unique_open_digest_window',
+    unique: true,
+    partialFilterExpression: {
+      status: DigestWindowStatusEnum.OPEN,
+    },
+  }
+);
+
+/*
+ * Used by dashboard support tools to inspect a subscriber's active windows.
+ */
+digestWindowSchema.index({
+  _environmentId: 1,
+  _subscriberId: 1,
+  status: 1,
+  updatedAt: -1,
+});
+
+/*
+ * Used by ProcessDigestWindows to poll pending windows.
+ * Query:
+ * {
+ *   status: DigestWindowStatusEnum.PENDING,
+ *   nextFlushAt: { $lte: now },
+ *   _environmentId: environmentId
+ * }
+ */
+digestWindowSchema.index({
+  status: 1,
+  _subscriberId: 1,
+});
+
+digestWindowSchema.index({
+  _templateId: 1,
+  stepId: 1,
+  digestValue: 1,
+});
+
+digestWindowSchema.index({ createdAt: 1 });
+
+export const DigestWindow =
+  (mongoose.models.DigestWindow as mongoose.Model<DigestWindowDBModel>) ||
+  mongoose.model<DigestWindowDBModel>('DigestWindow', digestWindowSchema);
diff --git a/libs/dal/src/repositories/digest-window/digest-window.repository.ts b/libs/dal/src/repositories/digest-window/digest-window.repository.ts
new file mode 100644
index 0000000000..e38f12bbfd
--- /dev/null
+++ b/libs/dal/src/repositories/digest-window/digest-window.repository.ts
@@ -0,0 +1,205 @@
+import type { FilterQuery } from 'mongoose';
+import { DalException } from '../../shared';
+import type { EnforceEnvOrOrgIds } from '../../types';
+import { BaseRepository } from '../base-repository';
+import {
+  DigestWindowEntity,
+  DigestWindowEvent,
+  DigestWindowStatusEnum,
+  DigestWindowDBModel,
+} from './digest-window.entity';
+import { DigestWindow } from './digest-window.schema';
+
+export type FindOrCreateDigestWindowCommand = {
+  _organizationId: string;
+  _environmentId: string;
+  _templateId: string;
+  _subscriberId: string;
+  subscriberId: string;
+  stepId: string;
+  digestKey?: string;
+  digestValue?: string | number;
+  windowStartLocal: string;
+  windowEndLocal: string;
+  nextFlushAt: Date;
+  definition: DigestWindowEntity['definition'];
+};
+
+export class DigestWindowRepository extends BaseRepository<
+  DigestWindowDBModel,
+  DigestWindowEntity,
+  EnforceEnvOrOrgIds
+> {
+  constructor() {
+    super(DigestWindow, DigestWindowEntity);
+  }
+
+  async findOrCreateOpenWindow(command: FindOrCreateDigestWindowCommand): Promise<DigestWindowEntity> {
+    const digestValue = command.digestValue === undefined ? undefined : String(command.digestValue);
+
+    const query = {
+      _environmentId: this.convertStringToObjectId(command._environmentId),
+      _templateId: this.convertStringToObjectId(command._templateId),
+      _subscriberId: this.convertStringToObjectId(command._subscriberId),
+      stepId: command.stepId,
+      digestKey: command.digestKey,
+      digestValue,
+      windowStartLocal: command.windowStartLocal,
+      status: DigestWindowStatusEnum.OPEN,
+    };
+
+    const update = {
+      $setOnInsert: {
+        _organizationId: this.convertStringToObjectId(command._organizationId),
+        _environmentId: this.convertStringToObjectId(command._environmentId),
+        _templateId: this.convertStringToObjectId(command._templateId),
+        _subscriberId: this.convertStringToObjectId(command._subscriberId),
+        subscriberId: command.subscriberId,
+        stepId: command.stepId,
+        digestKey: command.digestKey,
+        digestValue,
+        definition: command.definition,
+        status: DigestWindowStatusEnum.OPEN,
+        windowStartLocal: command.windowStartLocal,
+        windowEndLocal: command.windowEndLocal,
+        nextFlushAt: command.nextFlushAt,
+        eventCount: 0,
+        events: [],
+      },
+    };
+
+    const window = await this.MongooseModel.findOneAndUpdate(query, update, {
+      new: true,
+      upsert: true,
+      setDefaultsOnInsert: true,
+    });
+
+    return this.mapEntity(window);
+  }
+
+  async appendEvent({
+    _environmentId,
+    windowId,
+    event,
+  }: {
+    _environmentId: string;
+    windowId: string;
+    event: DigestWindowEvent;
+  }): Promise<DigestWindowEntity> {
+    const updated = await this.MongooseModel.findOneAndUpdate(
+      {
+        _environmentId: this.convertStringToObjectId(_environmentId),
+        _id: this.convertStringToObjectId(windowId),
+        status: DigestWindowStatusEnum.OPEN,
+      },
+      {
+        $push: {
+          events: event,
+        },
+        $inc: {
+          eventCount: 1,
+        },
+      },
+      { new: true }
+    );
+
+    if (!updated) {
+      throw new DalException(`Digest window ${windowId} is not open in environment ${_environmentId}`);
+    }
+
+    return this.mapEntity(updated);
+  }
+
+  async closeWindowForFlush({
+    _environmentId,
+    windowId,
+  }: {
+    _environmentId: string;
+    windowId: string;
+  }): Promise<void> {
+    await this.MongooseModel.updateOne(
+      {
+        _environmentId: this.convertStringToObjectId(_environmentId),
+        _id: this.convertStringToObjectId(windowId),
+        status: DigestWindowStatusEnum.OPEN,
+      },
+      {
+        $set: {
+          status: DigestWindowStatusEnum.PENDING,
+        },
+      }
+    );
+  }
+
+  async findDueWindows({
+    _environmentId,
+    now,
+    limit,
+  }: {
+    _environmentId: string;
+    now: Date;
+    limit: number;
+  }): Promise<DigestWindowEntity[]> {
+    const query: FilterQuery<DigestWindowDBModel> = {
+      _environmentId: this.convertStringToObjectId(_environmentId),
+      status: DigestWindowStatusEnum.PENDING,
+      nextFlushAt: {
+        $lte: now,
+      },
+    };
+
+    const rows = await this.MongooseModel.find(query)
+      .sort({ nextFlushAt: 1, createdAt: 1 })
+      .limit(limit)
+      .lean()
+      .exec();
+
+    return rows.map((row) => this.mapEntity(row));
+  }
+
+  async claimWindow({
+    _environmentId,
+    windowId,
+    workerId,
+  }: {
+    _environmentId: string;
+    windowId: string;
+    workerId: string;
+  }): Promise<DigestWindowEntity | null> {
+    const claimed = await this.MongooseModel.findOneAndUpdate(
+      {
+        _environmentId: this.convertStringToObjectId(_environmentId),
+        _id: this.convertStringToObjectId(windowId),
+        status: DigestWindowStatusEnum.PENDING,
+      },
+      {
+        $set: {
+          status: DigestWindowStatusEnum.PROCESSING,
+          lockedAt: new Date(),
+          lockedBy: workerId,
+        },
+      },
+      { new: true }
+    );
+
+    return claimed ? this.mapEntity(claimed) : null;
+  }
+
+  async markFlushed({
+    _environmentId,
+    windowId,
+    jobId,
+  }: {
+    _environmentId: string;
+    windowId: string;
+    jobId: string;
+  }): Promise<void> {
+    await this.MongooseModel.updateOne(
+      {
+        _environmentId: this.convertStringToObjectId(_environmentId),
+        _id: this.convertStringToObjectId(windowId),
+      },
+      {
+        $set: {
+          status: DigestWindowStatusEnum.FLUSHED,
+          flushedAt: new Date(),
+          flushJobId: jobId,
+        },
+      }
+    );
+  }
+
+  async markFailed({ _environmentId, windowId, error }: { _environmentId: string; windowId: string; error: Error }) {
+    await this.MongooseModel.updateOne(
+      {
+        _environmentId: this.convertStringToObjectId(_environmentId),
+        _id: this.convertStringToObjectId(windowId),
+      },
+      {
+        $set: {
+          status: DigestWindowStatusEnum.FAILED,
+          lastError: error.message,
+        },
+      }
+    );
+  }
+}
diff --git a/libs/dal/src/repositories/digest-window/index.ts b/libs/dal/src/repositories/digest-window/index.ts
new file mode 100644
index 0000000000..8a2d0de903
--- /dev/null
+++ b/libs/dal/src/repositories/digest-window/index.ts
@@ -0,0 +1,3 @@
+export * from './digest-window.entity';
+export * from './digest-window.repository';
+export * from './digest-window.schema';
diff --git a/libs/dal/src/repositories/index.ts b/libs/dal/src/repositories/index.ts
index 9914fd839a..64f96b520e 100644
--- a/libs/dal/src/repositories/index.ts
+++ b/libs/dal/src/repositories/index.ts
@@ -8,6 +8,7 @@ export * from './control-values';
 export * from './conversation';
 export * from './domain';
 export * from './domain-route';
+export * from './digest-window';
 export * from './environment';
 export * from './execution-details';
 export * from './feed';
diff --git a/libs/application-generic/src/services/digest-windows/digest-window.service.ts b/libs/application-generic/src/services/digest-windows/digest-window.service.ts
new file mode 100644
index 0000000000..9d9fe17316
--- /dev/null
+++ b/libs/application-generic/src/services/digest-windows/digest-window.service.ts
@@ -0,0 +1,205 @@
+import { Injectable, Logger } from '@nestjs/common';
+import { DigestWindowEntity, DigestWindowRepository } from '@novu/dal';
+import { DigestTypeEnum, DigestUnitEnum, IDigestRegularMetadata, IDigestTimedMetadata, StepTypeEnum } from '@novu/shared';
+import { addDays, addHours, addMinutes, addMonths, addWeeks, format } from 'date-fns';
+import { getNestedValue } from '../../utils';
+
+type BuildWindowCommand = {
+  organizationId: string;
+  environmentId: string;
+  templateId: string;
+  subscriberId: string;
+  subscriberInternalId: string;
+  subscriberTimezone?: string;
+  stepId: string;
+  metadata: IDigestRegularMetadata | IDigestTimedMetadata;
+  payload: Record<string, unknown>;
+  overrides?: Record<string, unknown>;
+  transactionId: string;
+  jobId: string;
+};
+
+type WindowBounds = {
+  windowStartLocal: string;
+  windowEndLocal: string;
+  nextFlushAt: Date;
+};
+
+@Injectable()
+export class DigestWindowService {
+  private readonly logger = new Logger(DigestWindowService.name);
+
+  constructor(private digestWindowRepository: DigestWindowRepository) {}
+
+  async addEvent(command: BuildWindowCommand): Promise<DigestWindowEntity> {
+    if (!this.isWindowedDigest(command.metadata)) {
+      throw new Error('Digest window service can only process windowed digest metadata');
+    }
+
+    const bounds = this.buildWindowBounds(command.metadata, command.subscriberTimezone);
+    const digestKey = command.metadata.digestKey;
+    const digestValue = digestKey ? getNestedValue(command.payload, digestKey) : undefined;
+
+    const window = await this.digestWindowRepository.findOrCreateOpenWindow({
+      _organizationId: command.organizationId,
+      _environmentId: command.environmentId,
+      _templateId: command.templateId,
+      _subscriberId: command.subscriberInternalId,
+      subscriberId: command.subscriberId,
+      stepId: command.stepId,
+      digestKey,
+      digestValue,
+      windowStartLocal: bounds.windowStartLocal,
+      windowEndLocal: bounds.windowEndLocal,
+      nextFlushAt: bounds.nextFlushAt,
+      definition: {
+        amount: command.metadata.amount,
+        unit: command.metadata.unit,
+        atTime: 'timed' in command.metadata ? command.metadata.timed?.atTime : undefined,
+        weekDays: 'timed' in command.metadata ? command.metadata.timed?.weekDays : undefined,
+        monthDays: 'timed' in command.metadata ? command.metadata.timed?.monthDays : undefined,
+        digestKey,
+        digestValue,
+      },
+    });
+
+    const updated = await this.digestWindowRepository.appendEvent({
+      _environmentId: command.environmentId,
+      windowId: window._id,
+      event: {
+        transactionId: command.transactionId,
+        jobId: command.jobId,
+        payload: command.payload,
+        overrides: command.overrides,
+        createdAt: new Date().toISOString(),
+      },
+    });
+
+    if (updated.nextFlushAt.getTime() <= Date.now()) {
+      await this.digestWindowRepository.closeWindowForFlush({
+        _environmentId: command.environmentId,
+        windowId: updated._id,
+      });
+    }
+
+    this.logger.debug(
+      {
+        windowId: updated._id,
+        eventCount: updated.eventCount,
+        nextFlushAt: updated.nextFlushAt,
+        windowStartLocal: updated.windowStartLocal,
+      },
+      'Digest event appended to window'
+    );
+
+    return updated;
+  }
+
+  private isWindowedDigest(metadata: IDigestRegularMetadata | IDigestTimedMetadata): boolean {
+    return metadata.type === DigestTypeEnum.REGULAR || metadata.type === DigestTypeEnum.TIMED;
+  }
+
+  private buildWindowBounds(
+    metadata: IDigestRegularMetadata | IDigestTimedMetadata,
+    subscriberTimezone?: string
+  ): WindowBounds {
+    const now = new Date();
+    const start = new Date(now);
+    let end: Date;
+
+    switch (metadata.unit) {
+      case DigestUnitEnum.MINUTES:
+        end = addMinutes(start, metadata.amount);
+        break;
+      case DigestUnitEnum.HOURS:
+        end = addHours(start, metadata.amount);
+        break;
+      case DigestUnitEnum.DAYS:
+        end = addDays(start, metadata.amount);
+        break;
+      case DigestUnitEnum.WEEKS:
+        end = addWeeks(start, metadata.amount);
+        break;
+      case DigestUnitEnum.MONTHS:
+        end = addMonths(start, metadata.amount);
+        break;
+      default:
+        end = addMinutes(start, metadata.amount);
+    }
+
+    if (metadata.type === DigestTypeEnum.TIMED && metadata.timed?.atTime) {
+      const localEnd = this.replaceLocalTime(end, metadata.timed.atTime, subscriberTimezone);
+      return {
+        windowStartLocal: format(start, 'yyyy-MM-dd HH:mm:ss'),
+        windowEndLocal: format(localEnd, 'yyyy-MM-dd HH:mm:ss'),
+        nextFlushAt: new Date(format(localEnd, "yyyy-MM-dd'T'HH:mm:ss")),
+      };
+    }
+
+    return {
+      windowStartLocal: format(start, 'yyyy-MM-dd HH:mm:ss'),
+      windowEndLocal: format(end, 'yyyy-MM-dd HH:mm:ss'),
+      nextFlushAt: new Date(format(end, "yyyy-MM-dd'T'HH:mm:ss")),
+    };
+  }
+
+  private replaceLocalTime(date: Date, atTime: string, subscriberTimezone?: string): Date {
+    const [hours = '0', minutes = '0', seconds = '0'] = atTime.split(':');
+    const next = new Date(date);
+    next.setHours(Number(hours));
+    next.setMinutes(Number(minutes));
+    next.setSeconds(Number(seconds));
+    next.setMilliseconds(0);
+
+    if (subscriberTimezone) {
+      this.logger.debug(
+        {
+          subscriberTimezone,
+          localDate: format(next, 'yyyy-MM-dd HH:mm:ss'),
+        },
+        'Calculated subscriber-local digest window time'
+      );
+    }
+
+    return next;
+  }
+}
diff --git a/apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.command.ts b/apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.command.ts
new file mode 100644
index 0000000000..db66d89fed
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.command.ts
@@ -0,0 +1,26 @@
+import { EnvironmentCommand } from '@novu/application-generic';
+
+export class ProcessDigestWindowsCommand extends EnvironmentCommand {
+  organizationId: string;
+
+  userId: string;
+
+  limit?: number;
+
+  workerId?: string;
+
+  static create(data: ProcessDigestWindowsCommand) {
+    const command = new ProcessDigestWindowsCommand();
+    Object.assign(command, data);
+    return command;
+  }
+}
diff --git a/apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.usecase.ts b/apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.usecase.ts
new file mode 100644
index 0000000000..45ef4b144b
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.usecase.ts
@@ -0,0 +1,181 @@
+import { Injectable, Logger } from '@nestjs/common';
+import {
+  AddJob,
+  AddJobCommand,
+  CreateExecutionDetails,
+  CreateExecutionDetailsCommand,
+  DetailEnum,
+  InstrumentUsecase,
+} from '@novu/application-generic';
+import { DigestWindowEntity, DigestWindowRepository, JobRepository, NotificationRepository } from '@novu/dal';
+import {
+  ExecutionDetailsSourceEnum,
+  ExecutionDetailsStatusEnum,
+  JobStatusEnum,
+  StepTypeEnum,
+} from '@novu/shared';
+import { ProcessDigestWindowsCommand } from './process-digest-windows.command';
+
+@Injectable()
+export class ProcessDigestWindows {
+  private readonly logger = new Logger(ProcessDigestWindows.name);
+
+  constructor(
+    private digestWindowRepository: DigestWindowRepository,
+    private notificationRepository: NotificationRepository,
+    private jobRepository: JobRepository,
+    private addJob: AddJob,
+    private createExecutionDetails: CreateExecutionDetails
+  ) {}
+
+  @InstrumentUsecase()
+  async execute(command: ProcessDigestWindowsCommand): Promise<{ processed: number; failed: number }> {
+    const windows = await this.digestWindowRepository.findDueWindows({
+      _environmentId: command.environmentId,
+      now: new Date(),
+      limit: command.limit ?? 100,
+    });
+
+    let processed = 0;
+    let failed = 0;
+
+    for (const window of windows) {
+      const claimed = await this.digestWindowRepository.claimWindow({
+        _environmentId: command.environmentId,
+        windowId: window._id,
+        workerId: command.workerId ?? 'workflow-worker',
+      });
+
+      if (!claimed) {
+        continue;
+      }
+
+      try {
+        await this.flushWindow(command, claimed);
+        processed += 1;
+      } catch (error) {
+        failed += 1;
+        await this.digestWindowRepository.markFailed({
+          _environmentId: command.environmentId,
+          windowId: claimed._id,
+          error: error as Error,
+        });
+      }
+    }
+
+    return { processed, failed };
+  }
+
+  private async flushWindow(command: ProcessDigestWindowsCommand, window: DigestWindowEntity): Promise<void> {
+    if (window.events.length === 0) {
+      await this.digestWindowRepository.markFlushed({
+        _environmentId: command.environmentId,
+        windowId: window._id,
+        jobId: 'empty-window',
+      });
+      return;
+    }
+
+    const representativeEvent = window.events[0];
+    const notification = await this.notificationRepository.findOne({
+      _environmentId: command.environmentId,
+      transactionId: representativeEvent.transactionId,
+    });
+
+    if (!notification) {
+      throw new Error(`Unable to find notification for digest window ${window._id}`);
+    }
+
+    const job = await this.jobRepository.findOne({
+      _environmentId: command.environmentId,
+      _id: representativeEvent.jobId,
+    });
+
+    if (!job) {
+      throw new Error(`Unable to find representative job for digest window ${window._id}`);
+    }
+
+    const payload = {
+      ...representativeEvent.payload,
+      digest: {
+        eventCount: window.eventCount,
+        events: window.events.map((event) => ({
+          transactionId: event.transactionId,
+          payload: event.payload,
+          createdAt: event.createdAt,
+        })),
+        window: {
+          id: window._id,
+          startedAt: window.windowStartLocal,
+          endedAt: window.windowEndLocal,
+        },
+      },
+    };
+
+    const nextJob = await this.addJob.execute(
+      AddJobCommand.create({
+        environmentId: command.environmentId,
+        organizationId: command.organizationId,
+        userId: command.userId,
+        jobId: job._id,
+        job: {
+          ...job,
+          payload,
+          status: JobStatusEnum.PENDING,
+          type: StepTypeEnum.DIGEST,
+          digest: {
+            ...job.digest,
+            events: window.events.map((event) => event.payload),
+          },
+        },
+      })
+    );
+
+    await this.digestWindowRepository.markFlushed({
+      _environmentId: command.environmentId,
+      windowId: window._id,
+      jobId: nextJob?.jobId ?? job._id,
+    });
+
+    await this.createExecutionDetails.execute(
+      CreateExecutionDetailsCommand.create({
+        ...CreateExecutionDetailsCommand.getDetailsFromJob(job),
+        detail: DetailEnum.DIGEST_TRIGGERED,
+        source: ExecutionDetailsSourceEnum.INTERNAL,
+        status: ExecutionDetailsStatusEnum.SUCCESS,
+        isTest: false,
+        isRetry: false,
+        raw: JSON.stringify({
+          digestWindowId: window._id,
+          eventCount: window.eventCount,
+          windowStartLocal: window.windowStartLocal,
+          windowEndLocal: window.windowEndLocal,
+          nextFlushAt: window.nextFlushAt,
+        }),
+      })
+    );
+
+    this.logger.log(
+      {
+        digestWindowId: window._id,
+        jobId: job._id,
+        eventCount: window.eventCount,
+      },
+      'Digest window flushed'
+    );
+  }
+}
diff --git a/apps/worker/src/app/workflow/usecases/process-digest-windows/index.ts b/apps/worker/src/app/workflow/usecases/process-digest-windows/index.ts
new file mode 100644
index 0000000000..ea5c2683ba
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/process-digest-windows/index.ts
@@ -0,0 +1,2 @@
+export * from './process-digest-windows.command';
+export * from './process-digest-windows.usecase';
diff --git a/apps/worker/src/app/workflow/workflow.module.ts b/apps/worker/src/app/workflow/workflow.module.ts
index e2d066cc4d..a6a4e39820 100644
--- a/apps/worker/src/app/workflow/workflow.module.ts
+++ b/apps/worker/src/app/workflow/workflow.module.ts
@@ -42,6 +42,7 @@ import { RunJob } from './usecases/run-job';
 import { SendMessage } from './usecases/send-message';
 import { StoreSubscriberJobs } from './usecases/store-subscriber-jobs';
 import { SubscriberJobBound } from './usecases/subscriber-job-bound';
+import { ProcessDigestWindows } from './usecases/process-digest-windows';
 
 @Module({
   imports: [
@@ -118,6 +119,7 @@ import { SubscriberJobBound } from './usecases/subscriber-job-bound';
     StoreSubscriberJobs,
     SubscriberJobBound,
     RunJob,
+    ProcessDigestWindows,
     SendMessage,
   ],
   exports: [
@@ -131,6 +133,7 @@ import { SubscriberJobBound } from './usecases/subscriber-job-bound';
     StoreSubscriberJobs,
     SubscriberJobBound,
     RunJob,
+    ProcessDigestWindows,
     SendMessage,
   ],
 })
diff --git a/libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts b/libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts
index 942bb8c998..e6f1c33553 100644
--- a/libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts
+++ b/libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts
@@ -20,6 +20,7 @@ import { WorkflowRunService } from '../../services/workflow-run.service';
 import { CreateNotificationJobs } from '../create-notification-jobs';
 import { SendWebhookMessage } from '../send-webhook-message';
 import { TriggerEventCommand } from './trigger-event.command';
+import { DigestWindowService } from '../../services/digest-windows/digest-window.service';
 
 @Injectable()
 export class TriggerEvent {
@@ -42,7 +43,8 @@ export class TriggerEvent {
     private createNotificationJobs: CreateNotificationJobs,
     private workflowRunService: WorkflowRunService,
     private sendWebhookMessage: SendWebhookMessage,
-    private jobRepository: JobRepository
+    private jobRepository: JobRepository,
+    private digestWindowService: DigestWindowService
   ) {}
 
   async execute(command: TriggerEventCommand): Promise<void> {
@@ -384,6 +386,61 @@ export class TriggerEvent {
       await this.workflowRunService.createWorkflowRun(notification);
     }
 
+    await this.addEventsToDigestWindows({
+      command,
+      jobs,
+      subscriber,
+    });
+
     await this.sendWebhookMessage.execute({
       organizationId: command.organizationId,
       environmentId: command.environmentId,
@@ -402,6 +459,70 @@ export class TriggerEvent {
       rawData: command,
     });
   }
+
+  private async addEventsToDigestWindows({
+    command,
+    jobs,
+    subscriber,
+  }: {
+    command: TriggerEventCommand;
+    jobs: JobEntity[];
+    subscriber: SubscriberEntity;
+  }): Promise<void> {
+    const digestJobs = jobs.filter((job) => job.type === StepTypeEnum.DIGEST && job.digest);
+
+    for (const job of digestJobs) {
+      const metadata = job.digest as IDigestRegularMetadata | IDigestTimedMetadata;
+      const isWindowed =
+        metadata.type === DigestTypeEnum.REGULAR ||
+        metadata.type === DigestTypeEnum.TIMED ||
+        Boolean(metadata.digestKey);
+
+      if (!isWindowed) {
+        continue;
+      }
+
+      await this.digestWindowService.addEvent({
+        organizationId: command.organizationId,
+        environmentId: command.environmentId,
+        templateId: job._templateId,
+        subscriberId: subscriber.subscriberId,
+        subscriberInternalId: subscriber._id,
+        subscriberTimezone: subscriber.timezone,
+        stepId: job.step?._id,
+        metadata,
+        payload: job.payload,
+        overrides: job.overrides,
+        transactionId: job.transactionId,
+        jobId: job._id,
+      });
+
+      await this.jobRepository.updateOne(
+        {
+          _environmentId: command.environmentId,
+          _id: job._id,
+        },
+        {
+          $set: {
+            status: JobStatusEnum.MERGED,
+          },
+        }
+      );
+    }
+  }
 }
diff --git a/apps/api/src/app/events/e2e/digest-windows.e2e.ts b/apps/api/src/app/events/e2e/digest-windows.e2e.ts
new file mode 100644
index 0000000000..5902879e4c
--- /dev/null
+++ b/apps/api/src/app/events/e2e/digest-windows.e2e.ts
@@ -0,0 +1,170 @@
+import { expect } from 'chai';
+import { UserSession } from '@novu/testing';
+import { DigestWindowRepository } from '@novu/dal';
+import { DigestTypeEnum, DigestUnitEnum, StepTypeEnum } from '@novu/shared';
+describe('Digest windows', () => {
+  let session: UserSession;
+  let digestWindowRepository: DigestWindowRepository;
+  beforeEach(async () => {
+    session = new UserSession();
+    await session.initialize();
+    digestWindowRepository = session.testServer.getService(DigestWindowRepository);
+  });
+  it('merges events into a subscriber digest window', async () => {
+    const subscriber = await session.createSubscriber({
+      subscriberId: 'window-user-1',
+      email: 'window-user-1@example.com',
+      timezone: 'America/New_York',
+    });
+    const template = await session.createTemplate({
+      name: 'Digest window workflow',
+      steps: [
+        {
+          type: StepTypeEnum.DIGEST,
+          content: '',
+          metadata: {
+            type: DigestTypeEnum.REGULAR,
+            amount: 1,
+            unit: DigestUnitEnum.HOURS,
+            digestKey: 'postId',
+          },
+        },
+        {
+          type: StepTypeEnum.EMAIL,
+          content: 'You have {{digest.eventCount}} new events',
+          subject: 'Digest',
+        },
+      ],
+    });
+    await session.triggerEvent(template.triggers[0].identifier, {
+      to: subscriber.subscriberId,
+      payload: {
+        postId: 'post-1',
+        comment: 'first',
+      },
+    });
+
+    await session.triggerEvent(template.triggers[0].identifier, {
+      to: subscriber.subscriberId,
+      payload: {
+        postId: 'post-1',
+        comment: 'second',
+      },
+    });
+
+    const windows = await digestWindowRepository.find({
+      _environmentId: session.environment._id,
+      _subscriberId: subscriber._id,
+      digestValue: 'post-1',
+    });
+
+    expect(windows).to.have.length(1);
+    expect(windows[0].eventCount).to.equal(2);
+    expect(windows[0].windowStartLocal).to.match(/^\d{4}-\d{2}-\d{2}/);
+    expect(windows[0].nextFlushAt).to.be.instanceOf(Date);
+  });
+
+  it('uses local time strings for timed digest windows', async () => {
+    const subscriber = await session.createSubscriber({
+      subscriberId: 'window-user-3',
+      email: 'window-user-3@example.com',
+      timezone: 'Europe/Berlin',
+    });
+
+    const created = await digestWindowRepository.findOrCreateOpenWindow({
+      _organizationId: session.organization._id,
+      _environmentId: session.environment._id,
+      _templateId: session.template._id,
+      _subscriberId: subscriber._id,
+      subscriberId: subscriber.subscriberId,
+      stepId: 'digest-step',
+      digestKey: 'postId',
+      digestValue: 'post-3',
+      windowStartLocal: '2026-03-29 01:30:00',
+      windowEndLocal: '2026-03-29 02:30:00',
+      nextFlushAt: new Date('2026-03-29T02:30:00'),
+      definition: {
+        amount: 1,
+        unit: DigestUnitEnum.HOURS,
+        atTime: '02:30:00',
+        digestKey: 'postId',
+        digestValue: 'post-3',
+      },
+    });
+
+    expect(created.windowEndLocal).to.equal('2026-03-29 02:30:00');
+    expect(created.nextFlushAt).to.be.instanceOf(Date);
+  });
+});
```

## Intended Flaws

### Flaw 1: Due-Window Worker Query Is Not Matched By The Index

- `type`: `database_indexing`
- `location`: `libs/dal/src/repositories/digest-window/digest-window.schema.ts:104-133`, `libs/dal/src/repositories/digest-window/digest-window.repository.ts:115-139`, `apps/worker/src/app/workflow/usecases/process-digest-windows/process-digest-windows.usecase.ts:26-67`
- `learner_prompt`: When the worker runs every few seconds in a large environment, which index will serve the exact due-window poll?

Expected answer:

- `identify`: `findDueWindows` filters by `_environmentId`, `status: PENDING`, and `nextFlushAt <= now`, then sorts by `nextFlushAt` and `createdAt`. The schema comment even documents that query, but the index added for it is `{ status: 1, _subscriberId: 1 }`. That index does not include `_environmentId` or `nextFlushAt`, so it cannot efficiently serve the hot polling query or the due-time sort.
- `impact`: Under load, the worker scans pending windows across the collection, then filters by environment and due time. A single large tenant or backlog can slow every poll, increase Mongo CPU, delay digest delivery, and create fairness problems where windows that are actually due wait behind unrelated pending rows. The code looks small, but it creates a recurring background query on the hottest path.
- `fix_direction`: Add a query-shaped index, ideally a partial index for pending windows, such as `{ _environmentId: 1, status: 1, nextFlushAt: 1, createdAt: 1 }` or `{ _organizationId: 1, _environmentId: 1, status: 1, nextFlushAt: 1, createdAt: 1 }` depending on sharding/scoping. Keep the worker query and index comment in lockstep, verify with an explain plan, and consider atomic `findOneAndUpdate` claiming ordered by the same index instead of fetching a batch then claiming each row.

Hints:

1. Read the comment above the index and the actual `findDueWindows` filter side by side.
2. A due-job worker usually needs the due timestamp in the leading compound index.
3. If the query sorts by `nextFlushAt`, ask whether the database can satisfy that sort from the index.

### Flaw 2: Digest Windows Store Local Time Without A Timezone Contract

- `type`: `time_contract`
- `location`: `libs/dal/src/repositories/digest-window/digest-window.entity.ts:42-48`, `libs/dal/src/repositories/digest-window/digest-window.schema.ts:54-67`, `libs/application-generic/src/services/digest-windows/digest-window.service.ts:83-158`, `apps/api/src/app/events/e2e/digest-windows.e2e.ts:141-169`
- `learner_prompt`: What happens to "9 AM in the subscriber's local time" across DST changes, server-region moves, or subscriber timezone edits?

Expected answer:

- `identify`: The storage contract keeps `windowStartLocal` and `windowEndLocal` as bare strings and computes `nextFlushAt` with `new Date(format(localEnd, "yyyy-MM-dd'T'HH:mm:ss"))`. The subscriber timezone is only logged; it is not persisted on the window or used to convert local wall-clock time to a canonical UTC instant. Tests assert local strings, including a DST edge in Berlin, but do not assert the correct UTC instant or timezone provenance.
- `impact`: The same digest window can flush at different instants depending on the server timezone. Around DST transitions, local times may be nonexistent or ambiguous, so a "02:30" digest can be skipped, delayed, or sent twice. If a subscriber changes timezone after a window is created, support cannot tell which timezone governed the existing window. Multi-region workers may disagree about whether a window is due.
- `fix_direction`: Persist canonical UTC instants such as `windowStartAt`, `windowEndAt`, and `nextFlushAt`, plus the IANA timezone used to calculate them, for example `timeZone: 'Europe/Berlin'`. Use `fromZonedTime`/`toZonedTime` or the existing timed-digest delay service to convert wall-clock rules to UTC. Store the rule separately from the computed instants so future windows can be recalculated while existing windows remain stable.

Hints:

1. A string like `2026-03-29 02:30:00` does not say which timezone created it.
2. Look at the real timed digest service: it uses `date-fns-tz`, but this new service does not.
3. The test picks a DST date but only checks that a string was stored.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that the background worker's due-window query is not supported by the new index. Answers that only say "add more indexes" are incomplete unless they name the exact query shape and why `nextFlushAt` and `_environmentId` matter.

For flaw 2, a correct answer must identify that the feature stores local wall-clock strings without the timezone/provenance needed to compute stable UTC due times. Answers that only say "timezones are hard" are incomplete unless they connect the storage shape to DST, server timezone, or multi-region worker behavior.

### Product-Level Change

The PR tries to make Novu digest steps group events into reusable time windows and flush those windows later. Product-wise, this is valuable because customers think in windows like "hourly per post" or "daily at 9 AM for this subscriber."

### Changed Contracts

- DAL contract: new `DigestWindow` collection stores digest grouping state.
- Trigger contract: digest jobs can be marked merged into a window instead of progressing normally.
- Worker contract: a polling worker owns pending windows and enqueues digest work.
- Time contract: digest definitions now promise local-time delivery windows.
- Observability contract: execution details and support tooling depend on window metadata.

### Failure Modes

A customer has 3 million pending digest windows across environments. The worker polls every few seconds. Because the index is `{ status, _subscriberId }`, Mongo scans pending rows and sorts by due time in memory. Digest delivery starts lagging, and one busy environment affects others.

A subscriber in Berlin has a digest set for `02:30` on March 29, 2026, the DST jump day. The stored local string has no timezone. A worker in UTC, a worker in US Pacific time, and a support script can interpret the same string differently. The system cannot prove what "due" means.

### Reviewer Thought Process

A strong reviewer treats background polling queries as production hot paths. Find the exact query, sort, and claim operation; then check whether the index has the same leading fields. Comments above indexes are useful only if the actual index matches the comment.

For time features, the reviewer asks what is persisted as the source of truth. Local display strings are not instants. If the product says "subscriber local time," the stored data needs the UTC instant and the IANA timezone used to derive it.

### Better Implementation Direction

- Store windows with `windowStartAt`, `windowEndAt`, `nextFlushAt`, and `timeZone`.
- Keep local formatted strings as derived presentation data, not the scheduling contract.
- Use timezone-aware conversion for timed digests and add DST tests that assert exact UTC instants.
- Add a partial pending-window index matching the worker query.
- Prefer atomic due-window claiming ordered by the same index.
- Add an explain-plan or repository-level test that protects the index/query contract.
- Track per-environment backlog metrics so digest-window lag is visible before customers notice.

## Why This Case Exists

This case teaches that background systems fail at the contracts between code paths: the worker query versus the index, and the product's wall-clock promise versus the data model. Both flaws are easy to miss in a large PR because the feature appears to work in happy-path tests.
