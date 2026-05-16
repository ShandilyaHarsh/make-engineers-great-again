# TS-052: Novu Trigger Event Dedupe

## Metadata

- `id`: TS-052
- `source_repo`: [novuhq/novu](https://github.com/novuhq/novu)
- `repo_area`: trigger events, workflow queue ingress, transactionId semantics, event deduplication, multi-tenant scoping, bulk triggers, activity feed contracts
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,700-2,150
- `represented_diff_lines`: 1,779
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Novu trigger semantics, transactionId idempotency, workflow queues, bulk trigger behavior, tenant/workflow scope, and event dedupe design without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds an automatic dedupe layer for trigger events. Today callers can pass `transactionId` to prevent duplicate trigger processing, but many customers do not generate stable transaction IDs. The new helper computes an event fingerprint from the trigger request and suppresses duplicates within a configurable retention window.

The PR adds:

- a trigger dedupe DTO and options,
- an event dedupe use case used by single, broadcast, and bulk trigger paths,
- a short-lived dedupe store,
- response metadata showing whether a trigger was deduped,
- tests for single trigger retries and bulk duplicate suppression,
- docs explaining automatic trigger dedupe.

The intended product behavior is: if a customer accidentally retries the same notification trigger, Novu should acknowledge the request without enqueueing duplicate workflow jobs. Different workflows, tenants, and subscribers must continue to behave independently.

## Existing Code Context

The real Novu codebase already has these relevant contracts:

- `apps/api/src/app/events/events.controller.ts` documents `transactionId` as the explicit trigger dedupe mechanism: if the same `transactionId` is used again, the trigger is ignored.
- `apps/api/src/app/events/dtos/trigger-event-request.dto.ts` exposes `transactionId` as an optional unique identifier for deduplication.
- `apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts` creates a generated transaction ID when callers do not provide one.
- `apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts` dispatches workflow queue jobs with `name: transactionId`, job `data.transactionId`, and `groupId: command.organizationId`.
- `apps/api/src/app/events/usecases/process-bulk-trigger/process-bulk-trigger.usecase.ts` parses each bulk event with `skipQueueInsertion: true` and then calls `workflowQueueService.addBulk`.
- `libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts` validates `transactionId` uniqueness by querying jobs with `{ transactionId, _environmentId }`.
- `libs/dal/src/repositories/job/job.schema.ts` stores `transactionId`, `_environmentId`, `_organizationId`, `_subscriberId`, `_templateId`, and tenant/payload data on workflow jobs.
- `libs/dal/src/repositories/job/job.schema.ts` has a `transactionId` index because activity feed, cancellation, digest, and worker paths depend on transaction ID lookup.
- `packages/shared/src/entities/activity-feed/activity.interface.ts` exposes `transactionId`, template, subscriber, payload, channels, and topics in activity feed data.
- `apps/api/src/app/events/e2e/bulk-trigger.e2e.ts` verifies bulk trigger response ordering and transaction IDs.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the dedupe key is stable enough to suppress real retries and scoped enough to avoid suppressing unrelated customer events.

## Review Surface

Changed files in the synthetic PR:

- `apps/api/src/app/events/dtos/trigger-event-dedupe.dto.ts`
- `apps/api/src/app/events/dtos/trigger-event-response.dto.ts`
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.command.ts`
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.store.ts`
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe-metrics.ts`
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.usecase.ts`
- `apps/api/src/app/events/usecases/event-dedupe/index.ts`
- `apps/api/src/app/events/usecases/parse-event-request/parse-event-request.command.ts`
- `apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts`
- `apps/api/src/app/events/usecases/process-bulk-trigger/process-bulk-trigger.usecase.ts`
- `apps/api/src/app/events/events.module.ts`
- `apps/api/src/app/events/e2e/trigger-event-dedupe.e2e.ts`
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.spec.ts`
- `docs/events/trigger-dedupe.md`

The line references below use synthetic PR line numbers. The represented diff is focused on event fingerprint shape, dedupe key scope, queue admission, bulk behavior, and tests that normalize incorrect dedupe semantics.

## Diff

```diff
diff --git a/apps/api/src/app/events/dtos/trigger-event-dedupe.dto.ts b/apps/api/src/app/events/dtos/trigger-event-dedupe.dto.ts
new file mode 100644
index 000000000..19ecab785
--- /dev/null
+++ b/apps/api/src/app/events/dtos/trigger-event-dedupe.dto.ts
@@ -0,0 +1,56 @@
+import { ApiPropertyOptional } from '@nestjs/swagger';
+import { IsBoolean, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
+
+export class TriggerEventDedupeOptionsDto {
+  @ApiPropertyOptional({
+    description: 'Enables automatic trigger event dedupe for this request.',
+    default: true,
+  })
+  @IsBoolean()
+  @IsOptional()
+  enabled?: boolean;
+
+  @ApiPropertyOptional({
+    description: 'Retention window in seconds for automatic dedupe fingerprints.',
+    default: 300,
+    minimum: 5,
+    maximum: 86_400,
+  })
+  @IsInt()
+  @Min(5)
+  @Max(86_400)
+  @IsOptional()
+  windowSeconds?: number;
+
+  @ApiPropertyOptional({
+    description:
+      'Additional caller-provided values to include in the dedupe fingerprint. This is useful when the payload has noisy fields.',
+    type: 'object',
+    additionalProperties: true,
+  })
+  @IsObject()
+  @IsOptional()
+  attributes?: Record<string, unknown>;
+}
+
+export class TriggerEventDedupeResultDto {
+  @ApiPropertyOptional({
+    description: 'Whether the trigger request was suppressed by the automatic dedupe layer.',
+  })
+  deduped?: boolean;
+
+  @ApiPropertyOptional({
+    description: 'Hash key used by automatic trigger dedupe.',
+  })
+  dedupeKey?: string;
+
+  @ApiPropertyOptional({
+    description: 'Transaction ID of the first request in the dedupe window.',
+  })
+  originalTransactionId?: string;
+
+  @ApiPropertyOptional({
+    description: 'Unix timestamp in milliseconds when the dedupe window expires.',
+  })
+  expiresAt?: number;
+}
diff --git a/apps/api/src/app/events/dtos/trigger-event-response.dto.ts b/apps/api/src/app/events/dtos/trigger-event-response.dto.ts
index 87c8319c1..af825ab9a 100644
--- a/apps/api/src/app/events/dtos/trigger-event-response.dto.ts
+++ b/apps/api/src/app/events/dtos/trigger-event-response.dto.ts
@@ -1,6 +1,7 @@
 import { ApiProperty } from '@nestjs/swagger';
 import { IWorkflowDataDto } from '@novu/application-generic';
 import { TriggerEventStatusEnum } from '@novu/shared';
 import { IsBoolean, IsDefined, IsEnum, IsOptional, IsString } from 'class-validator';
+import { TriggerEventDedupeResultDto } from './trigger-event-dedupe.dto';
 
 export class TriggerEventResponseDto {
@@ -43,5 +44,15 @@ export class TriggerEventResponseDto {
 
   @IsOptional()
   jobData?: IWorkflowDataDto;
+
+  @ApiProperty({
+    description: 'Automatic trigger dedupe metadata.',
+    type: TriggerEventDedupeResultDto,
+    required: false,
+  })
+  @IsOptional()
+  dedupe?: TriggerEventDedupeResultDto;
 }
diff --git a/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.command.ts b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.command.ts
new file mode 100644
index 000000000..f1ea8488c
--- /dev/null
+++ b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.command.ts
@@ -0,0 +1,63 @@
+import { IsBoolean, IsDefined, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
+import { ContextPayload, TriggerRecipientsPayload, TriggerTenantContext } from '@novu/shared';
+import { EnvironmentWithUserCommand } from '../../../../shared/commands/project.command';
+
+export class EventDedupeCommand extends EnvironmentWithUserCommand {
+  @IsString()
+  @IsDefined()
+  identifier: string;
+
+  @IsObject()
+  payload: Record<string, unknown>;
+
+  @IsDefined()
+  to?: TriggerRecipientsPayload;
+
+  @IsOptional()
+  tenant?: TriggerTenantContext | null;
+
+  @IsOptional()
+  context?: ContextPayload;
+
+  @IsString()
+  @IsDefined()
+  transactionId: string;
+
+  @IsString()
+  @IsDefined()
+  requestId: string;
+
+  @IsString()
+  @IsOptional()
+  requestCategory?: string;
+
+  @IsBoolean()
+  @IsOptional()
+  enabled?: boolean;
+
+  @IsNumber()
+  @IsOptional()
+  windowSeconds?: number;
+
+  @IsObject()
+  @IsOptional()
+  attributes?: Record<string, unknown>;
+}
+
+export interface EventDedupeDecision {
+  deduped: boolean;
+  dedupeKey: string;
+  originalTransactionId?: string;
+  expiresAt: number;
+}
+
+export interface EventDedupeRecord {
+  dedupeKey: string;
+  environmentId: string;
+  organizationId: string;
+  subscriberKey: string;
+  transactionId: string;
+  requestId: string;
+  createdAt: number;
+  expiresAt: number;
+}
diff --git a/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.store.ts b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.store.ts
new file mode 100644
index 000000000..7cefcf6ba
--- /dev/null
+++ b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.store.ts
@@ -0,0 +1,83 @@
+import { Injectable } from '@nestjs/common';
+import { Instrument } from '@novu/application-generic';
+import { EventDedupeRecord } from './event-dedupe.command';
+
+export interface PutIfAbsentInput {
+  key: string;
+  record: EventDedupeRecord;
+  ttlSeconds: number;
+}
+
+export interface PutIfAbsentResult {
+  inserted: boolean;
+  record: EventDedupeRecord;
+}
+
+interface StoredDedupeRecord {
+  record: EventDedupeRecord;
+  expiresAt: number;
+}
+
+@Injectable()
+export class EventDedupeStore {
+  private readonly records = new Map<string, StoredDedupeRecord>();
+
+  @Instrument()
+  async putIfAbsent(input: PutIfAbsentInput): Promise<PutIfAbsentResult> {
+    this.deleteExpired(Date.now());
+    const existing = this.records.get(input.key);
+
+    if (existing && existing.expiresAt > Date.now()) {
+      return {
+        inserted: false,
+        record: existing.record,
+      };
+    }
+
+    const expiresAt = Date.now() + input.ttlSeconds * 1000;
+    const record = {
+      ...input.record,
+      expiresAt,
+    };
+
+    this.records.set(input.key, {
+      record,
+      expiresAt,
+    });
+
+    return {
+      inserted: true,
+      record,
+    };
+  }
+
+  @Instrument()
+  async get(key: string): Promise<EventDedupeRecord | undefined> {
+    this.deleteExpired(Date.now());
+    return this.records.get(key)?.record;
+  }
+
+  @Instrument()
+  async delete(key: string): Promise<void> {
+    this.records.delete(key);
+  }
+
+  @Instrument()
+  async clear(): Promise<void> {
+    this.records.clear();
+  }
+
+  @Instrument()
+  async keys(): Promise<string[]> {
+    this.deleteExpired(Date.now());
+    return [...this.records.keys()];
+  }
+
+  private deleteExpired(now: number): void {
+    for (const [key, value] of this.records.entries()) {
+      if (value.expiresAt <= now) {
+        this.records.delete(key);
+      }
+    }
+  }
+}
diff --git a/apps/api/src/app/events/usecases/event-dedupe/event-dedupe-metrics.ts b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe-metrics.ts
new file mode 100644
index 000000000..b420f7df4
--- /dev/null
+++ b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe-metrics.ts
@@ -0,0 +1,122 @@
+import { Injectable } from '@nestjs/common';
+import { Instrument, PinoLogger } from '@novu/application-generic';
+import { EventDedupeCommand, EventDedupeDecision } from './event-dedupe.command';
+
+export interface EventDedupeMetric {
+  organizationId: string;
+  environmentId: string;
+  subscriberKey: string;
+  dedupeKey: string;
+  deduped: boolean;
+  originalTransactionId?: string;
+  transactionId: string;
+  requestId: string;
+  workflowIdentifier: string;
+  tenantIdentifier?: string;
+  windowSeconds: number;
+  createdAt: string;
+}
+
+export interface EventDedupeMetricSummary {
+  total: number;
+  deduped: number;
+  accepted: number;
+  bySubscriber: Record<string, number>;
+  byWorkflow: Record<string, number>;
+}
+
+@Injectable()
+export class EventDedupeMetrics {
+  private readonly buffer: EventDedupeMetric[] = [];
+
+  constructor(private readonly logger: PinoLogger) {
+    this.logger.setContext(this.constructor.name);
+  }
+
+  @Instrument()
+  record(input: {
+    command: EventDedupeCommand;
+    decision: EventDedupeDecision;
+    subscriberKey: string;
+    windowSeconds: number;
+  }): void {
+    const metric: EventDedupeMetric = {
+      organizationId: input.command.organizationId,
+      environmentId: input.command.environmentId,
+      subscriberKey: input.subscriberKey,
+      dedupeKey: input.decision.dedupeKey,
+      deduped: input.decision.deduped,
+      originalTransactionId: input.decision.originalTransactionId,
+      transactionId: input.command.transactionId,
+      requestId: input.command.requestId,
+      workflowIdentifier: input.command.identifier,
+      tenantIdentifier: this.getTenantIdentifier(input.command.tenant),
+      windowSeconds: input.windowSeconds,
+      createdAt: new Date().toISOString(),
+    };
+
+    this.buffer.push(metric);
+    if (this.buffer.length > 1_000) {
+      this.buffer.shift();
+    }
+
+    this.logger.info(
+      {
+        organizationId: metric.organizationId,
+        environmentId: metric.environmentId,
+        subscriberKey: metric.subscriberKey,
+        dedupeKey: metric.dedupeKey,
+        deduped: metric.deduped,
+        transactionId: metric.transactionId,
+        originalTransactionId: metric.originalTransactionId,
+      },
+      'Recorded trigger dedupe metric'
+    );
+  }
+
+  @Instrument()
+  summary(): EventDedupeMetricSummary {
+    const summary: EventDedupeMetricSummary = {
+      total: this.buffer.length,
+      deduped: 0,
+      accepted: 0,
+      bySubscriber: {},
+      byWorkflow: {},
+    };
+
+    for (const metric of this.buffer) {
+      if (metric.deduped) {
+        summary.deduped += 1;
+      } else {
+        summary.accepted += 1;
+      }
+
+      summary.bySubscriber[metric.subscriberKey] = (summary.bySubscriber[metric.subscriberKey] ?? 0) + 1;
+      summary.byWorkflow[metric.workflowIdentifier] = (summary.byWorkflow[metric.workflowIdentifier] ?? 0) + 1;
+    }
+
+    return summary;
+  }
+
+  @Instrument()
+  recent(limit = 100): EventDedupeMetric[] {
+    return this.buffer.slice(-limit);
+  }
+
+  @Instrument()
+  clear(): void {
+    this.buffer.length = 0;
+  }
+
+  private getTenantIdentifier(tenant: EventDedupeCommand['tenant']): string | undefined {
+    if (!tenant) {
+      return undefined;
+    }
+
+    if (typeof tenant === 'string') {
+      return tenant;
+    }
+
+    return tenant.identifier;
+  }
+}
diff --git a/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.usecase.ts b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.usecase.ts
new file mode 100644
index 000000000..63aaf1e2d
--- /dev/null
+++ b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.usecase.ts
@@ -0,0 +1,161 @@
+import { createHash } from 'node:crypto';
+import { Injectable } from '@nestjs/common';
+import { InstrumentUsecase, PinoLogger } from '@novu/application-generic';
+import { EventDedupeCommand, EventDedupeDecision } from './event-dedupe.command';
+import { EventDedupeMetrics } from './event-dedupe-metrics';
+import { EventDedupeStore } from './event-dedupe.store';
+
+const DEFAULT_WINDOW_SECONDS = 300;
+
+@Injectable()
+export class EventDedupe {
+  constructor(
+    private readonly eventDedupeStore: EventDedupeStore,
+    private readonly eventDedupeMetrics: EventDedupeMetrics,
+    private readonly logger: PinoLogger
+  ) {
+    this.logger.setContext(this.constructor.name);
+  }
+
+  @InstrumentUsecase()
+  async execute(command: EventDedupeCommand): Promise<EventDedupeDecision> {
+    if (command.enabled === false) {
+      return {
+        deduped: false,
+        dedupeKey: '',
+        expiresAt: 0,
+      };
+    }
+
+    const windowSeconds = command.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
+    const fingerprint = this.buildFingerprint(command);
+    const subscriberKey = this.getSubscriberKey(command.to);
+    const dedupeKey = this.buildDedupeKey({
+      environmentId: command.environmentId,
+      subscriberKey,
+      fingerprint,
+    });
+    const now = Date.now();
+
+    const result = await this.eventDedupeStore.putIfAbsent({
+      key: dedupeKey,
+      ttlSeconds: windowSeconds,
+      record: {
+        dedupeKey,
+        environmentId: command.environmentId,
+        organizationId: command.organizationId,
+        subscriberKey,
+        transactionId: command.transactionId,
+        requestId: command.requestId,
+        createdAt: now,
+        expiresAt: now + windowSeconds * 1000,
+      },
+    });
+
+    if (!result.inserted) {
+      this.logger.info(
+        {
+          dedupeKey,
+          originalTransactionId: result.record.transactionId,
+          transactionId: command.transactionId,
+          requestId: command.requestId,
+        },
+        'Duplicate trigger event suppressed'
+      );
+    }
+
+    const decision = {
+      deduped: !result.inserted,
+      dedupeKey,
+      originalTransactionId: result.record.transactionId,
+      expiresAt: result.record.expiresAt,
+    };
+
+    this.eventDedupeMetrics.record({
+      command,
+      decision,
+      subscriberKey,
+      windowSeconds,
+    });
+
+    return decision;
+  }
+
+  buildFingerprint(command: EventDedupeCommand): string {
+    return hashStable({
+      payload: command.payload ?? {},
+      to: command.to ?? null,
+      context: command.context ?? null,
+      attributes: command.attributes ?? {},
+      requestId: command.requestId,
+      requestCategory: command.requestCategory,
+      receivedAt: new Date().toISOString(),
+    });
+  }
+
+  buildDedupeKey(input: {
+    environmentId: string;
+    subscriberKey: string;
+    fingerprint: string;
+  }): string {
+    return ['trigger-dedupe', input.environmentId, input.subscriberKey, input.fingerprint].join(':');
+  }
+
+  getSubscriberKey(to: unknown): string {
+    if (!to) {
+      return 'broadcast';
+    }
+
+    if (typeof to === 'string') {
+      return to;
+    }
+
+    if (Array.isArray(to)) {
+      return to.map((recipient) => this.getRecipientKey(recipient)).sort().join(',');
+    }
+
+    return this.getRecipientKey(to);
+  }
+
+  private getRecipientKey(recipient: unknown): string {
+    if (typeof recipient === 'string') {
+      return recipient;
+    }
+
+    if (recipient && typeof recipient === 'object') {
+      const value = recipient as { subscriberId?: string; topicKey?: string };
+      if (value.subscriberId) {
+        return value.subscriberId;
+      }
+      if (value.topicKey) {
+        return `topic:${value.topicKey}`;
+      }
+    }
+
+    return 'unknown';
+  }
+}
+
+function hashStable(value: unknown): string {
+  return createHash('sha256').update(stableStringify(value)).digest('hex');
+}
+
+function stableStringify(value: unknown): string {
+  if (value === null || value === undefined) {
+    return JSON.stringify(value);
+  }
+
+  if (Array.isArray(value)) {
+    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
+  }
+
+  if (typeof value === 'object') {
+    const record = value as Record<string, unknown>;
+    return `{${Object.keys(record)
+      .sort()
+      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
+      .join(',')}}`;
+  }
+
+  return JSON.stringify(value);
+}
diff --git a/apps/api/src/app/events/usecases/event-dedupe/index.ts b/apps/api/src/app/events/usecases/event-dedupe/index.ts
new file mode 100644
index 000000000..772812680
--- /dev/null
+++ b/apps/api/src/app/events/usecases/event-dedupe/index.ts
@@ -0,0 +1,4 @@
+export * from './event-dedupe.command';
+export * from './event-dedupe.store';
+export * from './event-dedupe-metrics';
+export * from './event-dedupe.usecase';
diff --git a/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.command.ts b/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.command.ts
index b860a7ca5..6bd851d5d 100644
--- a/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.command.ts
+++ b/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.command.ts
@@ -11,6 +11,7 @@ import {
   TriggerRequestCategoryEnum,
   TriggerTenantContext,
 } from '@novu/shared';
+import { TriggerEventDedupeOptionsDto } from '../../dtos/trigger-event-dedupe.dto';
 import { IsDefined, IsEnum, IsOptional, IsString, ValidateIf, ValidateNested } from 'class-validator';
 import { EnvironmentWithUserCommand } from '../../../shared/commands/project.command';
@@ -52,6 +53,9 @@ export class ParseEventRequestBaseCommand extends EnvironmentWithUserCommand {
   @IsOptional()
   controls?: StatelessControls;
 
+  @IsOptional()
+  dedupe?: TriggerEventDedupeOptionsDto;
+
   @IsString()
   requestId: string;
diff --git a/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts b/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts
index 0f071be3e..9c62b4774 100644
--- a/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts
+++ b/apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts
@@ -45,6 +45,7 @@ import { generateTransactionId } from '../../../shared/helpers/generate-transaction-id';
 import { PayloadValidationException } from '../../exceptions/payload-validation-exception';
 import { RecipientSchema, RecipientsSchema } from '../../utils/trigger-recipient-validation';
+import { EventDedupe, EventDedupeCommand } from '../event-dedupe';
 import {
   ParseEventRequestBroadcastCommand,
   ParseEventRequestCommand,
@@ -83,7 +84,8 @@ export class ParseEventRequest {
     private logger: PinoLogger,
     private featureFlagService: FeatureFlagsService,
     private traceLogRepository: TraceLogRepository,
     protected moduleRef: ModuleRef,
-    private inMemoryLRUCacheService: InMemoryLRUCacheService
+    private inMemoryLRUCacheService: InMemoryLRUCacheService,
+    private eventDedupe: EventDedupe
   ) {
     this.logger.setContext(this.constructor.name);
   }
@@ -380,6 +382,34 @@ export class ParseEventRequest {
       }
     }
 
+    const dedupe = await this.eventDedupe.execute(
+      EventDedupeCommand.create({
+        userId: command.userId,
+        environmentId: command.environmentId,
+        organizationId: command.organizationId,
+        identifier: command.identifier,
+        payload: command.payload ?? {},
+        to: 'to' in commandArgs ? commandArgs.to : undefined,
+        tenant: command.tenant,
+        context: command.context,
+        transactionId,
+        requestId,
+        requestCategory: command.requestCategory,
+        enabled: command.dedupe?.enabled,
+        windowSeconds: command.dedupe?.windowSeconds,
+        attributes: command.dedupe?.attributes,
+      })
+    );
+
+    if (dedupe.deduped) {
+      return {
+        acknowledged: true,
+        status: TriggerEventStatusEnum.PROCESSED,
+        transactionId,
+        dedupe,
+      };
+    }
+
     const jobData: IWorkflowDataDto = {
       ...commandArgs,
       actor: command.actor,
@@ -402,6 +432,7 @@ export class ParseEventRequest {
       status: TriggerEventStatusEnum.PROCESSED,
       transactionId,
       activityFeedLink,
+      dedupe,
       jobData: command.skipQueueInsertion ? jobData : undefined,
     };
   }
diff --git a/apps/api/src/app/events/usecases/process-bulk-trigger/process-bulk-trigger.usecase.ts b/apps/api/src/app/events/usecases/process-bulk-trigger/process-bulk-trigger.usecase.ts
index d89c75bf0..d38629e33 100644
--- a/apps/api/src/app/events/usecases/process-bulk-trigger/process-bulk-trigger.usecase.ts
+++ b/apps/api/src/app/events/usecases/process-bulk-trigger/process-bulk-trigger.usecase.ts
@@ -60,6 +60,7 @@ export class ProcessBulkTrigger {
                 requestCategory: TriggerRequestCategoryEnum.BULK,
                 bridgeUrl: event.bridgeUrl,
                 requestId: command.requestId,
+                dedupe: event.dedupe,
                 workflow,
                 skipQueueInsertion: true,
               })
@@ -94,7 +95,7 @@ export class ProcessBulkTrigger {
     const jobsToQueue: IWorkflowBulkJobDto[] = results
       .filter(
         (result): result is TriggerEventResponseDto & { jobData: NonNullable<typeof result.jobData> } =>
-          result.status === TriggerEventStatusEnum.PROCESSED && result.jobData !== undefined
+          result.status === TriggerEventStatusEnum.PROCESSED && !result.dedupe?.deduped && result.jobData !== undefined
       )
       .map((result) => ({
         name: result.jobData.transactionId,
diff --git a/apps/api/src/app/events/events.module.ts b/apps/api/src/app/events/events.module.ts
index 789f56360..ec3547268 100644
--- a/apps/api/src/app/events/events.module.ts
+++ b/apps/api/src/app/events/events.module.ts
@@ -8,6 +8,7 @@ import { SendTestEmail } from './usecases/send-test-email';
 import { TriggerEventToAll } from './usecases/trigger-event-to-all';
 import { CancelDelayed } from './usecases/cancel-delayed';
 import { ProcessBulkTrigger } from './usecases/process-bulk-trigger';
+import { EventDedupe, EventDedupeMetrics, EventDedupeStore } from './usecases/event-dedupe';
 
 @Module({
   imports: [SharedModule],
@@ -18,6 +19,8 @@ import { ProcessBulkTrigger } from './usecases/process-bulk-trigger';
     SendTestEmail,
     CancelDelayed,
     ProcessBulkTrigger,
+    EventDedupe,
+    EventDedupeStore,
+    EventDedupeMetrics,
   ],
   controllers: [EventsController],
   exports: [ParseEventRequest],
diff --git a/apps/api/src/app/events/e2e/trigger-event-dedupe.e2e.ts b/apps/api/src/app/events/e2e/trigger-event-dedupe.e2e.ts
new file mode 100644
index 000000000..61b6f745b
--- /dev/null
+++ b/apps/api/src/app/events/e2e/trigger-event-dedupe.e2e.ts
@@ -0,0 +1,237 @@
+import { Novu } from '@novu/api';
+import { JobRepository, MessageRepository, NotificationTemplateEntity, SubscriberEntity } from '@novu/dal';
+import { ChannelTypeEnum, StepTypeEnum } from '@novu/shared';
+import { SubscribersService, UserSession } from '@novu/testing';
+import { expect } from 'chai';
+import { initNovuClassSdk } from '../../shared/helpers/e2e/sdk/e2e-sdk.helper';
+
+describe('Trigger event dedupe - /v1/events/trigger (POST) #novu-v2', () => {
+  let session: UserSession;
+  let workflow: NotificationTemplateEntity;
+  let secondWorkflow: NotificationTemplateEntity;
+  let subscriber: SubscriberEntity;
+  let subscriberService: SubscribersService;
+  const jobRepository = new JobRepository();
+  const messageRepository = new MessageRepository();
+  let novuClient: Novu;
+
+  beforeEach(async () => {
+    session = new UserSession();
+    await session.initialize();
+    workflow = await session.createTemplate();
+    secondWorkflow = await session.createTemplate({
+      steps: [
+        {
+          type: StepTypeEnum.IN_APP,
+          content: 'Second workflow {{firstName}}',
+        },
+      ],
+    });
+    subscriberService = new SubscribersService(session.organization._id, session.environment._id);
+    subscriber = await subscriberService.createSubscriber();
+    novuClient = initNovuClassSdk(session);
+  });
+
+  it('suppresses the same retry when request id is reused by the client', async () => {
+    const first = await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'Ada',
+      },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          clientRequestId: 'retry_1',
+        },
+      },
+    });
+
+    const second = await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'Ada',
+      },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          clientRequestId: 'retry_1',
+        },
+      },
+    });
+
+    expect(first.result.dedupe?.deduped).to.equal(false);
+    expect(second.result.dedupe?.deduped).to.equal(true);
+    expect(second.result.dedupe?.originalTransactionId).to.equal(first.result.transactionId);
+  });
+
+  it('allows callers to disable automatic dedupe for each trigger', async () => {
+    const first = await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'Grace',
+      },
+      dedupe: {
+        enabled: false,
+      },
+    });
+    const second = await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'Grace',
+      },
+      dedupe: {
+        enabled: false,
+      },
+    });
+
+    expect(first.result.dedupe?.deduped).to.equal(false);
+    expect(second.result.dedupe?.deduped).to.equal(false);
+  });
+
+  it('suppresses duplicate events in one bulk request', async () => {
+    const response = await novuClient.triggerBulk({
+      events: [
+        {
+          workflowId: workflow.triggers[0].identifier,
+          to: [subscriber.subscriberId],
+          payload: {
+            firstName: 'Lin',
+          },
+          dedupe: {
+            enabled: true,
+            attributes: {
+              batchEventId: 'evt_1',
+            },
+          },
+        },
+        {
+          workflowId: workflow.triggers[0].identifier,
+          to: [subscriber.subscriberId],
+          payload: {
+            firstName: 'Lin',
+          },
+          dedupe: {
+            enabled: true,
+            attributes: {
+              batchEventId: 'evt_1',
+            },
+          },
+        },
+      ],
+    });
+
+    expect(response.result).to.have.length(2);
+    expect(response.result[0].dedupe?.deduped).to.equal(false);
+    expect(response.result[1].dedupe?.deduped).to.equal(true);
+  });
+
+  it('suppresses identical payloads across workflows for the same subscriber', async () => {
+    const first = await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'Katherine',
+      },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          eventId: 'same-event',
+        },
+      },
+    });
+
+    const second = await novuClient.trigger({
+      workflowId: secondWorkflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'Katherine',
+      },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          eventId: 'same-event',
+        },
+      },
+    });
+
+    expect(first.result.dedupe?.deduped).to.equal(false);
+    expect(second.result.dedupe?.deduped).to.equal(true);
+  });
+
+  it('writes one workflow job for deduped retry pairs', async () => {
+    const first = await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'One job',
+      },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          eventId: 'job-dedupe',
+        },
+      },
+    });
+    await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'One job',
+      },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          eventId: 'job-dedupe',
+        },
+      },
+    });
+
+    const jobs = await jobRepository.find({
+      _environmentId: session.environment._id,
+      transactionId: first.result.transactionId,
+    });
+    expect(jobs.length).to.equal(1);
+  });
+
+  it('does not create a second in-app message for a deduped event', async () => {
+    await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'Inbox',
+      },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          eventId: 'inbox-dedupe',
+        },
+      },
+    });
+    await novuClient.trigger({
+      workflowId: workflow.triggers[0].identifier,
+      to: [subscriber.subscriberId],
+      payload: {
+        firstName: 'Inbox',
+      },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          eventId: 'inbox-dedupe',
+        },
+      },
+    });
+
+    await session.waitForJobCompletion(workflow._id);
+
+    const messages = await messageRepository.findBySubscriberChannel(
+      session.environment._id,
+      subscriber._id,
+      ChannelTypeEnum.IN_APP
+    );
+    expect(messages.length).to.equal(1);
+  });
+});
diff --git a/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.spec.ts b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.spec.ts
new file mode 100644
index 000000000..acbd7db6f
--- /dev/null
+++ b/apps/api/src/app/events/usecases/event-dedupe/event-dedupe.spec.ts
@@ -0,0 +1,281 @@
+import { expect } from 'chai';
+import sinon from 'sinon';
+import { EventDedupe } from './event-dedupe.usecase';
+import { EventDedupeCommand } from './event-dedupe.command';
+import { EventDedupeMetrics } from './event-dedupe-metrics';
+import { EventDedupeStore } from './event-dedupe.store';
+
+describe('EventDedupe', () => {
+  let store: EventDedupeStore;
+  let logger: any;
+  let usecase: EventDedupe;
+
+  beforeEach(() => {
+    store = new EventDedupeStore();
+    logger = {
+      setContext: sinon.stub(),
+      info: sinon.stub(),
+    };
+    usecase = new EventDedupe(store, new EventDedupeMetrics(logger), logger);
+  });
+
+  it('returns not deduped when disabled', async () => {
+    const result = await usecase.execute(
+      buildCommand({
+        enabled: false,
+      })
+    );
+
+    expect(result.deduped).to.equal(false);
+    expect(result.dedupeKey).to.equal('');
+  });
+
+  it('dedupes the same subscriber and payload inside the window', async () => {
+    const first = await usecase.execute(
+      buildCommand({
+        requestId: 'req_1',
+        attributes: {
+          eventId: 'evt_1',
+        },
+      })
+    );
+    const second = await usecase.execute(
+      buildCommand({
+        requestId: 'req_1',
+        attributes: {
+          eventId: 'evt_1',
+        },
+      })
+    );
+
+    expect(first.deduped).to.equal(false);
+    expect(second.deduped).to.equal(true);
+    expect(second.originalTransactionId).to.equal('txn_1');
+  });
+
+  it('treats a changed request id as a different event', async () => {
+    const first = await usecase.execute(
+      buildCommand({
+        requestId: 'req_1',
+        transactionId: 'txn_1',
+        attributes: {
+          eventId: 'evt_1',
+        },
+      })
+    );
+    const second = await usecase.execute(
+      buildCommand({
+        requestId: 'req_2',
+        transactionId: 'txn_2',
+        attributes: {
+          eventId: 'evt_1',
+        },
+      })
+    );
+
+    expect(first.deduped).to.equal(false);
+    expect(second.deduped).to.equal(false);
+    expect(first.dedupeKey).to.not.equal(second.dedupeKey);
+  });
+
+  it('builds subscriber scoped keys for multicast recipients', async () => {
+    const command = buildCommand({
+      to: ['b', 'a'],
+      requestId: 'req_same',
+    });
+
+    const fingerprint = usecase.buildFingerprint(command);
+    const dedupeKey = usecase.buildDedupeKey({
+      environmentId: command.environmentId,
+      subscriberKey: usecase.getSubscriberKey(command.to),
+      fingerprint,
+    });
+
+    expect(dedupeKey).to.contain('a,b');
+  });
+
+  it('uses the same dedupe key for different workflows with the same payload', async () => {
+    const first = buildCommand({
+      identifier: 'weekly-summary',
+      requestId: 'req_same',
+      payload: {
+        firstName: 'Ada',
+      },
+      attributes: {
+        eventId: 'evt_same',
+      },
+    });
+    const second = buildCommand({
+      identifier: 'security-alert',
+      requestId: 'req_same',
+      payload: {
+        firstName: 'Ada',
+      },
+      attributes: {
+        eventId: 'evt_same',
+      },
+    });
+
+    const firstKey = usecase.buildDedupeKey({
+      environmentId: first.environmentId,
+      subscriberKey: usecase.getSubscriberKey(first.to),
+      fingerprint: usecase.buildFingerprint(first),
+    });
+    const secondKey = usecase.buildDedupeKey({
+      environmentId: second.environmentId,
+      subscriberKey: usecase.getSubscriberKey(second.to),
+      fingerprint: usecase.buildFingerprint(second),
+    });
+
+    expect(firstKey).to.equal(secondKey);
+  });
+
+  it('uses the same dedupe key for different tenants with the same payload', async () => {
+    const first = buildCommand({
+      requestId: 'req_same',
+      tenant: {
+        identifier: 'tenant_a',
+      },
+      attributes: {
+        eventId: 'evt_same',
+      },
+    });
+    const second = buildCommand({
+      requestId: 'req_same',
+      tenant: {
+        identifier: 'tenant_b',
+      },
+      attributes: {
+        eventId: 'evt_same',
+      },
+    });
+
+    const firstKey = usecase.buildDedupeKey({
+      environmentId: first.environmentId,
+      subscriberKey: usecase.getSubscriberKey(first.to),
+      fingerprint: usecase.buildFingerprint(first),
+    });
+    const secondKey = usecase.buildDedupeKey({
+      environmentId: second.environmentId,
+      subscriberKey: usecase.getSubscriberKey(second.to),
+      fingerprint: usecase.buildFingerprint(second),
+    });
+
+    expect(firstKey).to.equal(secondKey);
+  });
+
+  it('expires records after the requested window', async () => {
+    const clock = sinon.useFakeTimers(Date.now());
+    try {
+      const first = await usecase.execute(
+        buildCommand({
+          windowSeconds: 5,
+        })
+      );
+      clock.tick(6_000);
+      const second = await usecase.execute(
+        buildCommand({
+          windowSeconds: 5,
+        })
+      );
+
+      expect(first.deduped).to.equal(false);
+      expect(second.deduped).to.equal(false);
+    } finally {
+      clock.restore();
+    }
+  });
+
+  it('records metrics for accepted and deduped requests', async () => {
+    const metrics = new EventDedupeMetrics(logger);
+    usecase = new EventDedupe(store, metrics, logger);
+
+    await usecase.execute(
+      buildCommand({
+        requestId: 'req_metrics',
+        attributes: {
+          eventId: 'evt_metrics',
+        },
+      })
+    );
+    await usecase.execute(
+      buildCommand({
+        requestId: 'req_metrics',
+        transactionId: 'txn_2',
+        attributes: {
+          eventId: 'evt_metrics',
+        },
+      })
+    );
+
+    const summary = metrics.summary();
+
+    expect(summary.total).to.equal(2);
+    expect(summary.accepted).to.equal(1);
+    expect(summary.deduped).to.equal(1);
+    expect(summary.bySubscriber.subscriber_1).to.equal(2);
+    expect(summary.byWorkflow.workflow_1).to.equal(2);
+  });
+
+  it('records workflow and tenant as metric dimensions but not dedupe key dimensions', async () => {
+    const metrics = new EventDedupeMetrics(logger);
+    usecase = new EventDedupe(store, metrics, logger);
+
+    await usecase.execute(
+      buildCommand({
+        identifier: 'workflow_a',
+        requestId: 'req_dimension',
+        tenant: {
+          identifier: 'tenant_a',
+        },
+        attributes: {
+          eventId: 'evt_dimension',
+        },
+      })
+    );
+    await usecase.execute(
+      buildCommand({
+        identifier: 'workflow_b',
+        requestId: 'req_dimension',
+        tenant: {
+          identifier: 'tenant_b',
+        },
+        transactionId: 'txn_2',
+        attributes: {
+          eventId: 'evt_dimension',
+        },
+      })
+    );
+
+    const recent = metrics.recent();
+
+    expect(recent[0].workflowIdentifier).to.equal('workflow_a');
+    expect(recent[1].workflowIdentifier).to.equal('workflow_b');
+    expect(recent[0].tenantIdentifier).to.equal('tenant_a');
+    expect(recent[1].tenantIdentifier).to.equal('tenant_b');
+    expect(recent[1].deduped).to.equal(true);
+    expect(recent[0].dedupeKey).to.equal(recent[1].dedupeKey);
+  });
+
+  function buildCommand(overrides: Partial<EventDedupeCommand> = {}): EventDedupeCommand {
+    return EventDedupeCommand.create({
+      userId: 'user_1',
+      organizationId: 'org_1',
+      environmentId: 'env_1',
+      identifier: 'workflow_1',
+      payload: {
+        firstName: 'Ada',
+      },
+      to: ['subscriber_1'],
+      tenant: null,
+      context: undefined,
+      transactionId: 'txn_1',
+      requestId: 'req_1',
+      requestCategory: 'single',
+      enabled: true,
+      windowSeconds: 300,
+      attributes: {},
+      ...overrides,
+    });
+  }
+});
diff --git a/docs/events/trigger-dedupe.md b/docs/events/trigger-dedupe.md
new file mode 100644
index 000000000..853f111dd
--- /dev/null
+++ b/docs/events/trigger-dedupe.md
@@ -0,0 +1,565 @@
+# Trigger Event Dedupe
+
+Novu already supports explicit trigger dedupe with `transactionId`. If a
+caller sends the same `transactionId` again, the workflow worker rejects the
+duplicate trigger and the original workflow run remains the source of truth.
+
+Automatic trigger dedupe adds a convenience layer for callers that do not have
+a durable transaction ID. The API computes a fingerprint from the request body
+and suppresses duplicates inside a short retention window.
+
+```ts
+await novu.trigger({
+  workflowId: 'weekly-summary',
+  to: ['subscriber_123'],
+  payload: {
+    firstName: 'Ada',
+    digestId: 'digest_123',
+  },
+  dedupe: {
+    enabled: true,
+    windowSeconds: 300,
+  },
+});
+```
+
+## Response metadata
+
+Every processed trigger response may include dedupe metadata:
+
+```json
+{
+  "acknowledged": true,
+  "status": "processed",
+  "transactionId": "txn_123",
+  "dedupe": {
+    "deduped": true,
+    "dedupeKey": "trigger-dedupe:env_1:subscriber_123:...",
+    "originalTransactionId": "txn_abc",
+    "expiresAt": 1760000000000
+  }
+}
+```
+
+When `deduped` is true, the request was acknowledged but no new workflow job
+was inserted.
+
+## Fingerprint inputs
+
+The automatic fingerprint includes:
+
+- the trigger payload,
+- recipients,
+- context,
+- optional caller attributes,
+- request ID,
+- request category,
+- receive timestamp.
+
+This makes the fingerprint sensitive enough that customers can retry the exact
+same HTTP request without suppressing nearby events.
+
+## Bulk triggers
+
+Bulk triggers use the same dedupe path as single triggers. Results stay in the
+same order as the input request. Deduped rows are acknowledged and omitted from
+the `addBulk` workflow queue insert.
+
+```ts
+await novu.triggerBulk({
+  events: [
+    {
+      workflowId: 'weekly-summary',
+      to: ['subscriber_123'],
+      payload: { firstName: 'Ada' },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          batchEventId: 'evt_123',
+        },
+      },
+    },
+    {
+      workflowId: 'weekly-summary',
+      to: ['subscriber_123'],
+      payload: { firstName: 'Ada' },
+      dedupe: {
+        enabled: true,
+        attributes: {
+          batchEventId: 'evt_123',
+        },
+      },
+    },
+  ],
+});
+```
+
+## Scope
+
+Automatic dedupe keys are scoped to:
+
+- environment,
+- recipient set,
+- request fingerprint.
+
+The workflow identifier is intentionally not part of the key. This allows
+customers to model a single event once and suppress duplicate notifications
+even if the event is sent to multiple workflows during a migration.
+
+Tenant information is also not part of the key because tenant values can be
+large mutable objects. If callers need tenant-specific dedupe, they should pass
+a tenant identifier in `dedupe.attributes`.
+
+## Disabling dedupe
+
+Callers can disable automatic dedupe for a request:
+
+```ts
+await novu.trigger({
+  workflowId: 'audit-log',
+  to: ['subscriber_123'],
+  payload: {
+    eventId: 'event_1',
+  },
+  dedupe: {
+    enabled: false,
+  },
+});
+```
+
+Explicit `transactionId` still works when automatic dedupe is disabled.
+
+## Retry examples
+
+The examples below show how the automatic key is expected to behave in common
+API retry paths.
+
+### Same process retry
+
+A same-process retry that reuses the same request ID will be deduped:
+
+```ts
+const requestId = 'req_123';
+
+await eventsService.trigger({
+  identifier: 'weekly-summary',
+  to: ['subscriber_123'],
+  payload: {
+    digestId: 'digest_123',
+    firstName: 'Ada',
+  },
+  requestId,
+  dedupe: {
+    enabled: true,
+    attributes: {
+      source: 'billing-service',
+    },
+  },
+});
+
+await eventsService.trigger({
+  identifier: 'weekly-summary',
+  to: ['subscriber_123'],
+  payload: {
+    digestId: 'digest_123',
+    firstName: 'Ada',
+  },
+  requestId,
+  dedupe: {
+    enabled: true,
+    attributes: {
+      source: 'billing-service',
+    },
+  },
+});
+```
+
+The second request returns `dedupe.deduped: true`.
+
+### HTTP retry after timeout
+
+Clients that retry after a timeout usually create a new request ID:
+
+```ts
+await eventsService.trigger({
+  identifier: 'weekly-summary',
+  to: ['subscriber_123'],
+  payload: {
+    digestId: 'digest_123',
+    firstName: 'Ada',
+  },
+  requestId: 'req_original',
+  dedupe: {
+    enabled: true,
+    attributes: {
+      source: 'billing-service',
+    },
+  },
+});
+
+await eventsService.trigger({
+  identifier: 'weekly-summary',
+  to: ['subscriber_123'],
+  payload: {
+    digestId: 'digest_123',
+    firstName: 'Ada',
+  },
+  requestId: 'req_retry',
+  dedupe: {
+    enabled: true,
+    attributes: {
+      source: 'billing-service',
+    },
+  },
+});
+```
+
+This creates a new fingerprint because the request ID and receive timestamp
+changed. Both requests are accepted and queued.
+
+### Generated transaction IDs
+
+When callers omit `transactionId`, the API still generates a unique
+transaction ID for each accepted trigger:
+
+```json
+[
+  {
+    "requestId": "req_original",
+    "transactionId": "txn_01HZZ1A",
+    "dedupe": {
+      "deduped": false
+    }
+  },
+  {
+    "requestId": "req_retry",
+    "transactionId": "txn_01HZZ1B",
+    "dedupe": {
+      "deduped": false
+    }
+  }
+]
+```
+
+The generated transaction ID is not part of the automatic fingerprint.
+
+## Cross-workflow behavior
+
+Some customers send the same business event to several workflows while moving
+from an old notification design to a new one. Automatic dedupe treats those
+workflows as the same event when the recipient set and fingerprint match.
+
+```ts
+await novu.trigger({
+  workflowId: 'weekly-summary-v1',
+  to: ['subscriber_123'],
+  payload: {
+    digestId: 'digest_123',
+    firstName: 'Ada',
+  },
+  dedupe: {
+    enabled: true,
+    attributes: {
+      eventId: 'digest_123',
+    },
+  },
+});
+
+await novu.trigger({
+  workflowId: 'weekly-summary-v2',
+  to: ['subscriber_123'],
+  payload: {
+    digestId: 'digest_123',
+    firstName: 'Ada',
+  },
+  dedupe: {
+    enabled: true,
+    attributes: {
+      eventId: 'digest_123',
+    },
+  },
+});
+```
+
+The second workflow is suppressed if the first workflow created a key in the
+same environment and retention window.
+
+For migration periods, customers that need both workflows to run can set
+different attributes:
+
+```ts
+await novu.trigger({
+  workflowId: 'weekly-summary-v1',
+  to: ['subscriber_123'],
+  payload: {
+    digestId: 'digest_123',
+  },
+  dedupe: {
+    enabled: true,
+    attributes: {
+      eventId: 'digest_123',
+      workflowGeneration: 'v1',
+    },
+  },
+});
+
+await novu.trigger({
+  workflowId: 'weekly-summary-v2',
+  to: ['subscriber_123'],
+  payload: {
+    digestId: 'digest_123',
+  },
+  dedupe: {
+    enabled: true,
+    attributes: {
+      eventId: 'digest_123',
+      workflowGeneration: 'v2',
+    },
+  },
+});
+```
+
+## Tenant examples
+
+Tenant context is copied to the workflow job and can affect subscriber
+preferences, branding, and provider overrides. Automatic dedupe does not read
+the tenant object directly.
+
+```ts
+await novu.trigger({
+  workflowId: 'invoice-ready',
+  to: ['user_123'],
+  tenant: {
+    identifier: 'tenant_a',
+  },
+  payload: {
+    invoiceId: 'inv_123',
+  },
+  dedupe: {
+    enabled: true,
+    attributes: {
+      invoiceId: 'inv_123',
+    },
+  },
+});
+
+await novu.trigger({
+  workflowId: 'invoice-ready',
+  to: ['user_123'],
+  tenant: {
+    identifier: 'tenant_b',
+  },
+  payload: {
+    invoiceId: 'inv_123',
+  },
+  dedupe: {
+    enabled: true,
+    attributes: {
+      invoiceId: 'inv_123',
+    },
+  },
+});
+```
+
+If callers need tenant-specific dedupe, they should include the tenant
+identifier in `dedupe.attributes`:
+
+```ts
+await novu.trigger({
+  workflowId: 'invoice-ready',
+  to: ['user_123'],
+  tenant: {
+    identifier: 'tenant_a',
+  },
+  payload: {
+    invoiceId: 'inv_123',
+  },
+  dedupe: {
+    enabled: true,
+    attributes: {
+      invoiceId: 'inv_123',
+      tenantIdentifier: 'tenant_a',
+    },
+  },
+});
+```
+
+## Key examples
+
+The key format is:
+
+```txt
+trigger-dedupe:<environmentId>:<subscriberKey>:<fingerprint>
+```
+
+Example keys:
+
+```txt
+trigger-dedupe:env_prod:sub_123:bc8deea2c761a95cbd1d
+trigger-dedupe:env_prod:sub_456:01bc5ab4e6706127292e
+trigger-dedupe:env_stage:sub_123:bc8deea2c761a95cbd1d
+```
+
+A recipient set with more than one subscriber is joined in sorted order:
+
+```txt
+trigger-dedupe:env_prod:sub_123,sub_456:e91a0c33f8b64fc713de
+```
+
+The key intentionally does not include:
+
+- workflow identifier,
+- resolved template ID,
+- tenant identifier,
+- organization ID,
+- API key ID,
+- provider integration ID.
+
+## Metrics
+
+The API records lightweight in-process counters for accepted and deduped
+requests. These counters are used in local development and smoke tests.
+
+```ts
+eventDedupeMetrics.record({
+  command,
+  decision,
+  subscriberKey,
+  windowSeconds,
+});
+```
+
+A sample snapshot:
+
+```json
+{
+  "total": 12,
+  "accepted": 9,
+  "deduped": 3,
+  "byWorkflow": {
+    "weekly-summary": 6,
+    "security-alert": 2,
+    "invoice-ready": 4
+  },
+  "byTenant": {
+    "tenant_a": 5,
+    "tenant_b": 3,
+    "none": 4
+  },
+  "bySubscriber": {
+    "subscriber_123": 8,
+    "subscriber_456": 4
+  }
+}
+```
+
+These metrics are dimensions only. Workflow and tenant are recorded for
+debugging but are not used to build the dedupe key.
+
+## Troubleshooting
+
+Use this checklist when a customer reports missing or duplicate notifications.
+
+| Symptom | Likely cause | What to check |
+| --- | --- | --- |
+| Duplicate sends after retry | Request ID or receive timestamp changed | Compare dedupe keys and request IDs |
+| Second workflow did not run | Same recipient and fingerprint inside window | Compare workflow identifiers and dedupe metadata |
+| Tenant-specific notification missing | Tenant omitted from automatic scope | Check tenant and `dedupe.attributes` |
+| Bulk result acknowledged but no message exists | Row was filtered before `addBulk` | Check `dedupe.deduped` in response |
+| Activity feed has the first transaction only | Duplicate was acknowledged without a job | Search by `originalTransactionId` |
+| Cancellation by retry transaction ID fails | Suppressed retry has no workflow job | Cancel the original transaction ID |
+
+## Compatibility notes
+
+Automatic dedupe is additive. Existing callers that pass `transactionId` keep
+the same explicit idempotency behavior. The automatic key only decides whether
+a request should enqueue a workflow job before worker-side transaction checks
+run.
+
+Callers should continue to pass `transactionId` when they already have one.
+Automatic dedupe is designed as a convenience for teams that cannot yet
+generate durable transaction IDs.
+
+## Recommended rollout
+
+1. Enable automatic dedupe for one environment.
+2. Watch accepted and deduped counters for high-volume workflows.
+3. Ask customers to pass `dedupe.attributes` for event IDs that should be
+   stable across retries.
+4. Ask customers to include workflow or tenant identifiers in attributes if
+   they want those dimensions isolated.
+5. Keep explicit `transactionId` on mission-critical notification events.
+
+## Internal design notes
+
+The API performs dedupe before queue insertion so bulk trigger can omit
+duplicate rows from `workflowQueueService.addBulk`. The response still returns
+one item per input row so clients do not need to reconcile array lengths.
+
+The store keeps only one record per dedupe key:
+
+```ts
+{
+  key: 'trigger-dedupe:env_prod:subscriber_123:bc8dee',
+  transactionId: 'txn_original',
+  requestId: 'req_original',
+  expiresAt: 1760000000000
+}
+```
+
+When a later request hits the same key, the response points to the original
+transaction ID:
+
+```json
+{
+  "acknowledged": true,
+  "status": "processed",
+  "transactionId": "txn_retry",
+  "dedupe": {
+    "deduped": true,
+    "originalTransactionId": "txn_original"
+  }
+}
+```
+
+The retry transaction ID is returned for API traceability. The original
+transaction ID is the one that owns the queued workflow job.
+
+## FAQ
+
+### Does automatic dedupe replace transaction IDs?
+
+No. Explicit `transactionId` is still the preferred idempotency contract when
+the caller can provide one.
+
+### Why is request ID included?
+
+Request ID makes duplicate detection specific to an API request and avoids
+accidentally suppressing nearby business events with similar payloads.
+
+### Why is receive timestamp included?
+
+Receive timestamp prevents broad suppression when customers send the same
+payload repeatedly inside a long retention window.
+
+### Why is workflow identifier excluded?
+
+Some customers use multiple workflows during migration periods. Excluding the
+workflow identifier lets one dedupe key suppress duplicate notifications across
+those workflow generations.
+
+### Why is tenant excluded?
+
+Tenant context can be a large object. Customers that need tenant isolation can
+include a compact tenant identifier in `dedupe.attributes`.
+
+### What should support ask customers for?
+
+Ask for request ID, response transaction ID, `dedupe.deduped`, original
+transaction ID, workflow identifier, tenant identifier, subscriber ID, and
+payload event ID.
+
+### What should engineers inspect first?
+
+Inspect the generated dedupe key, the workflow queue job name, and whether the
+response was produced by the single trigger path or the bulk trigger path.
```

## Intended Flaws

### Flaw 1: The dedupe fingerprint includes volatile request fields, so real retries miss dedupe

The fingerprint includes `requestId` and `receivedAt: new Date().toISOString()`. Those values change on ordinary HTTP retries even when the logical notification event is identical. The dedupe layer therefore produces a different key for the retry and enqueues the duplicate workflow job.

Relevant line references:

- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.usecase.ts:84-94` builds the fingerprint from request-specific metadata.
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.usecase.ts:90-92` includes `requestId`, `requestCategory`, and `receivedAt`.
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.spec.ts:56-79` asserts that changing the request ID makes a logically identical event non-deduped.
- `docs/events/trigger-dedupe.md:47-60` documents request ID and receive timestamp as part of the fingerprint.

Why this is a real flaw:

Event dedupe must be based on a stable semantic identity. A retry usually has a new API request ID, new receive timestamp, and sometimes a new generated transaction ID. If those fields are part of the fingerprint, the feature only dedupes artificial tests that reuse the same request metadata. In production, client retry storms still produce duplicate notifications, duplicate jobs, duplicate activity feed rows, and duplicate external sends.

Better implementation direction:

Build the dedupe fingerprint from stable event identity: caller-provided idempotency key, workflow identifier, tenant identifier, recipient identity, and normalized business payload fields. Exclude transport metadata such as request ID, receive timestamp, generated transaction ID, and queue job IDs. If the platform cannot infer a stable semantic key, require `dedupe.attributes` or an explicit idempotency key.

### Flaw 2: The dedupe key omits workflow and tenant scope, so unrelated events suppress each other

The dedupe key is scoped only by environment, recipient set, and fingerprint. The fingerprint also omits `identifier` and `tenant`. Two different workflows or tenant overrides with the same recipient and payload can share a dedupe key, causing the second workflow to be acknowledged but never queued.

Relevant line references:

- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.usecase.ts:84-94` omits workflow identifier and tenant from the fingerprint.
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.usecase.ts:96-101` builds keys from only environment, subscriber key, and fingerprint.
- `apps/api/src/app/events/e2e/trigger-event-dedupe.e2e.ts:132-163` asserts that identical payloads across different workflows are suppressed.
- `apps/api/src/app/events/usecases/event-dedupe/event-dedupe.spec.ts:97-164` asserts equal keys for different workflows and tenants.
- `docs/events/trigger-dedupe.md:97-111` documents workflow and tenant omission as intended behavior.

Why this is a real flaw:

In Novu, workflow identity and tenant context are not decorative metadata. Workflow controls which steps run, which providers send, what template renders, what preferences apply, and what activity feed entry users expect. Tenant overrides can activate or deactivate workflow behavior for different customer partitions. Suppressing a security alert because a weekly summary used the same subscriber and payload shape is a product correctness bug.

Better implementation direction:

Scope dedupe keys to the full event contract: organization/environment, workflow identifier or template ID, tenant identifier or resolved tenant ID, recipient identity, and stable semantic event identity. If cross-workflow migration dedupe is needed, make it an explicit migration alias or caller-provided dedupe namespace rather than the default.

## Hints

### Flaw 1 Hints

1. Which fields in the fingerprint change every HTTP request even for the same logical event?
2. What would happen if a client retries after a timeout with the same payload but a new request ID?
3. Is a receive timestamp part of event identity or transport metadata?

### Flaw 2 Hints

1. What makes two Novu trigger events different besides payload and subscriber?
2. Where does workflow identity affect rendered output and downstream jobs?
3. Can two tenants share subscriber IDs and payload shapes while needing different workflow behavior?

## Expected Answer

A strong review should say that the product-level change is automatic dedupe for trigger events, but the implementation fails both sides of dedupe design: stability and scope.

For flaw 1, the learner should identify that the fingerprint includes `requestId` and `receivedAt`. The impact is that real retries create new fingerprints, so duplicate triggers are still enqueued. The fix is to base fingerprints on stable semantic event identity and exclude transport metadata.

For flaw 2, the learner should identify that the dedupe key omits workflow identifier/template ID and tenant context. The impact is unrelated workflows or tenant-specific notifications suppressing each other for the same recipient and payload. The fix is to scope keys by workflow and tenant by default, with explicit caller-owned namespaces for cross-workflow dedupe.

The best answers should connect the flaws to Novu's existing contracts: `transactionId` is already the explicit dedupe handle, workflow jobs and activity feed depend on transaction IDs, the worker validates uniqueness at job-processing time, and trigger events are scoped by environment, workflow, tenant, subscriber, and payload semantics.

## Expert Debrief

At the product level, this PR tries to solve a real problem. Customers forget to send `transactionId`, retry API calls, and then wonder why subscribers received duplicate notifications. Automatic dedupe can be valuable, but only if its key means what the product means by "same event."

The first contract is key stability. Dedupe is not about whether two HTTP requests are byte-for-byte identical. It is about whether two requests represent the same business event. Request IDs and receive timestamps are transport facts. Putting them in the fingerprint makes every retry look new.

The second contract is scope. Novu trigger processing is not just "payload to subscriber." The workflow determines the step graph, providers, templates, preferences, and activity feed. Tenant overrides can change behavior for the same workflow. A dedupe key that ignores workflow and tenant collapses distinct product events into one.

The failure modes are concrete:

- A client retries after a 502 with the same payload and recipient; the new request ID generates a new fingerprint and sends a duplicate notification.
- Bulk tests pass because both rows share artificial request metadata, but real HTTP retries do not.
- A weekly summary suppresses a security alert for the same subscriber because the payload shape matches.
- Tenant A's event suppresses Tenant B's event when both use the same subscriber ID and payload fields.
- The API returns `acknowledged: true` and `status: processed`, but no workflow job exists for the suppressed event.
- Activity feed and cancellation by transaction ID become confusing because the second request has its own transaction ID but no queued workflow.

The reviewer thought process should be: first separate semantic identity from transport metadata. Second, enumerate every domain boundary that makes two events distinct: organization, environment, workflow, tenant, recipient, topic, and event id. Third, inspect tests for false confidence: do they model real retries or only same-process duplicate calls?

The better implementation is explicit and scoped. Prefer caller-supplied `transactionId` or a new idempotency key. If automatic fingerprints exist, require stable attributes or derive from a normalized allowlist. Scope the key by workflow/template and tenant. For cross-workflow migration dedupe, add a named namespace that a caller opts into deliberately.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: volatile request ID/timestamp in the fingerprint, and missing workflow/tenant scope in the dedupe key. It explains missed real retries, cross-workflow or cross-tenant suppression, duplicate jobs/messages, and suggests stable semantic fingerprints plus properly scoped keys.
- `partial`: The answer finds one flaw completely and mentions either generic hashing problems or generic tenant risk without tying it to Novu trigger, workflow, and transaction ID contracts.
- `miss`: The answer focuses on DTO naming, in-memory storage, Swagger docs, or generic caching style while missing fingerprint stability and event scope.
