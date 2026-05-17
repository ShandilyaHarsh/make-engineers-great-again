# TS-035: Novu Synchronous Trigger-And-Wait API

## Metadata

- `id`: TS-035
- `source_repo`: [novuhq/novu](https://github.com/novuhq/novu)
- `repo_area`: Events API, trigger request parsing, workflow queue dispatch, worker job status, SDK generation, trigger e2e tests
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1587
- `flaw_count`: 2

## PR Description Shown To Learner

This PR adds a synchronous trigger-and-wait endpoint for customers who need to know whether a workflow was delivered before continuing their own request.

Today `POST /v1/events/trigger` acknowledges the trigger after Novu validates the request and enqueues the workflow. Customers then poll the activity feed or subscribe to webhooks if they need delivery status. The new `POST /v1/events/trigger/wait` endpoint accepts the normal trigger payload plus `timeoutMs` and `waitFor`, waits until the workflow has reached the requested state, and returns a typed delivery summary.

The change also adds SDK support and e2e coverage for immediate delivery, timeout behavior, provider failure, and idempotent retries with `transactionId`.

## Existing Code Context

The real Novu codebase already has these relevant contracts:

- `apps/api/src/app/events/events.controller.ts` exposes `POST /events/trigger`, validates kill switch and permissions, then calls `ParseEventRequest`.
- `apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts` validates the trigger, builds `jobData`, and calls `workflowQueueService.add(...)`.
- The existing trigger response uses `TriggerEventStatusEnum.PROCESSED`, which means accepted into Novu's workflow pipeline, not delivered by an email/SMS/push provider.
- `ProcessBulkTrigger` has a `skipQueueInsertion` path so bulk requests can validate events first and enqueue with `workflowQueueService.addBulk(...)`.
- Worker code stores jobs as `PENDING`, `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `DELAYED`, `CANCELED`, `MERGED`, or `SKIPPED`.
- `WorkflowRunService` derives delivery lifecycle state separately from the API trigger request path.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `apps/api/src/app/events/events.controller.ts`
- `apps/api/src/app/events/dtos/trigger-event-wait-request.dto.ts`
- `apps/api/src/app/events/dtos/trigger-event-wait-response.dto.ts`
- `apps/api/src/app/events/dtos/index.ts`
- `apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.command.ts`
- `apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.usecase.ts`
- `apps/api/src/app/events/usecases/process-trigger-and-wait/index.ts`
- `apps/api/src/app/events/usecases/index.ts`
- `apps/api/src/app/events/events.module.ts`
- `libs/internal-sdk/src/funcs/eventsTriggerAndWait.ts`
- `libs/internal-sdk/src/models/components/triggerandwaitrequest.ts`
- `libs/internal-sdk/src/models/components/triggerandwaitresponse.ts`
- `apps/api/src/app/events/e2e/trigger-and-wait.e2e.ts`
- `apps/api/src/app/events/e2e/utils/wait-for-trigger-delivery.util.ts`
- `apps/api/public/openapi/events.yml`

The line references below use synthetic PR line numbers. The represented diff is intentionally larger than a toy patch so the learner has to review contracts across API, queue, worker status, SDK, and tests.

## Diff

```diff
diff --git a/apps/api/src/app/events/events.controller.ts b/apps/api/src/app/events/events.controller.ts
index 9a61bb13c1..0a2f514431 100644
--- a/apps/api/src/app/events/events.controller.ts
+++ b/apps/api/src/app/events/events.controller.ts
@@ -1,4 +1,4 @@
-import { Body, Controller, Delete, Param, Post, Req, Scope, ServiceUnavailableException } from '@nestjs/common';
+import { Body, Controller, Delete, Param, Post, Req, Scope, ServiceUnavailableException } from '@nestjs/common';
 import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
 import { FeatureFlagsService, RequirePermissions, ResourceCategory } from '@novu/application-generic';
 import {
@@ -25,6 +25,8 @@ import {
   BulkTriggerEventDto,
   TestSendEmailRequestDto,
   TriggerEventRequestDto,
+  TriggerEventWaitRequestDto,
+  TriggerEventWaitResponseDto,
   TriggerEventResponseDto,
   TriggerEventToAllRequestDto,
 } from './dtos';
@@ -32,6 +34,7 @@ import { CancelDelayed, CancelDelayedCommand } from './usecases/cancel-delayed';
 import { ParseEventRequest, ParseEventRequestMulticastCommand } from './usecases/parse-event-request';
 import { ProcessBulkTrigger, ProcessBulkTriggerCommand } from './usecases/process-bulk-trigger';
+import { ProcessTriggerAndWait, ProcessTriggerAndWaitCommand } from './usecases/process-trigger-and-wait';
 import { SendTestEmail, SendTestEmailCommand } from './usecases/send-test-email';
 import { TriggerEventToAll, TriggerEventToAllCommand } from './usecases/trigger-event-to-all';
 
@@ -58,7 +61,8 @@ export class EventsController {
     private sendTestEmail: SendTestEmail,
     private parseEventRequest: ParseEventRequest,
     private processBulkTriggerUsecase: ProcessBulkTrigger,
-    private featureFlagsService: FeatureFlagsService
+    private featureFlagsService: FeatureFlagsService,
+    private processTriggerAndWaitUsecase: ProcessTriggerAndWait
   ) {}
 
   private async checkKillSwitch(user: UserSessionData): Promise<void> {
@@ -117,6 +121,68 @@ export class EventsController {
     return result as unknown as TriggerEventResponseDto;
   }
 
+  @KeylessAccessible()
+  @ExternalApiAccessible()
+  @Post('/trigger/wait')
+  @RequestAnalytics(AnalyticsStrategyEnum.EVENTS)
+  @LogAnalytics(AnalyticsStrategyEnum.EVENTS)
+  @ApiResponse(TriggerEventWaitResponseDto, 201)
+  @ApiResponse(PayloadValidationExceptionDto, 400, false, false, {
+    description: 'Payload validation failed - returned when payload does not match the workflow schema',
+  })
+  @ApiOperation({
+    summary: 'Trigger event and wait for delivery',
+    description: `
+    Trigger event and wait for the workflow to be delivered before returning.
+    This endpoint is useful for customers that need a synchronous confirmation
+    before continuing their own checkout, invitation, password reset, or receipt flow.
+    The endpoint accepts the same body as the trigger endpoint plus timeoutMs and waitFor.
+    If timeoutMs is omitted, the API waits up to 30 seconds for delivery.`,
+  })
+  @SdkMethodName('triggerAndWait')
+  @SdkUsageExample('Trigger Notification Event And Wait')
+  @SdkGroupName('')
+  @RequirePermissions(PermissionsEnum.EVENT_WRITE)
+  async triggerAndWait(
+    @UserSession() user: UserSessionData,
+    @Req() req: RequestWithReqId,
+    @Body() body: TriggerEventWaitRequestDto
+  ): Promise<TriggerEventWaitResponseDto> {
+    await this.checkKillSwitch(user);
+
+    return await this.processTriggerAndWaitUsecase.execute(
+      ProcessTriggerAndWaitCommand.create({
+        userId: user._id,
+        environmentId: user.environmentId,
+        organizationId: user.organizationId,
+        identifier: body.name,
+        payload: body.payload || {},
+        overrides: body.overrides || {},
+        to: body.to,
+        actor: body.actor,
+        tenant: body.tenant,
+        context: body.context,
+        transactionId: body.transactionId,
+        addressingType: AddressingTypeEnum.MULTICAST,
+        requestCategory: TriggerRequestCategoryEnum.SINGLE,
+        bridgeUrl: body.bridgeUrl,
+        controls: body.controls,
+        requestId: req._nvRequestId,
+        waitFor: body.waitFor,
+        timeoutMs: body.timeoutMs,
+        includeJobs: body.includeJobs,
+        includeMessages: body.includeMessages,
+      })
+    );
+  }
+
   @ExternalApiAccessible()
   @ThrottlerCost(ApiRateLimitCostEnum.BULK)
   @RequestAnalytics(AnalyticsStrategyEnum.EVENTS_BULK)
@@ -237,6 +303,7 @@ export class EventsController {
       })
     );
   }
+
 }
diff --git a/apps/api/src/app/events/dtos/trigger-event-wait-request.dto.ts b/apps/api/src/app/events/dtos/trigger-event-wait-request.dto.ts
new file mode 100644
index 0000000000..7aa1a9be47
--- /dev/null
+++ b/apps/api/src/app/events/dtos/trigger-event-wait-request.dto.ts
@@ -0,0 +1,132 @@
+import { ApiPropertyOptional } from '@nestjs/swagger';
+import { Transform } from 'class-transformer';
+import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
+import { SdkApiProperty } from '../../shared/framework/swagger/sdk.decorators';
+import { TriggerEventRequestDto } from './trigger-event-request.dto';
+
+export enum TriggerWaitForDto {
+  /**
+   * Wait until the trigger was accepted by the API and the first workflow job exists.
+   */
+  ACCEPTED = 'accepted',
+
+  /**
+   * Wait until the first channel job has been queued for the worker.
+   */
+  QUEUED = 'queued',
+
+  /**
+   * Wait until all channel jobs have completed successfully.
+   */
+  DELIVERED = 'delivered',
+}
+
+function optionalBoolean(value: unknown): boolean | undefined {
+  if (value === undefined || value === null || value === '') {
+    return undefined;
+  }
+
+  if (typeof value === 'boolean') {
+    return value;
+  }
+
+  if (typeof value === 'string') {
+    return value.toLowerCase() === 'true';
+  }
+
+  return Boolean(value);
+}
+
+function optionalNumber(value: unknown): number | undefined {
+  if (value === undefined || value === null || value === '') {
+    return undefined;
+  }
+
+  if (typeof value === 'number') {
+    return value;
+  }
+
+  const parsed = Number(value);
+
+  if (Number.isNaN(parsed)) {
+    return undefined;
+  }
+
+  return parsed;
+}
+
+export class TriggerEventWaitRequestDto extends TriggerEventRequestDto {
+  @SdkApiProperty({
+    description:
+      'The state the API should wait for before returning. Defaults to delivered so callers can treat success as provider delivery.',
+    enum: TriggerWaitForDto,
+    required: false,
+    default: TriggerWaitForDto.DELIVERED,
+  })
+  @IsEnum(TriggerWaitForDto)
+  @IsOptional()
+  waitFor?: TriggerWaitForDto;
+
+  @ApiPropertyOptional({
+    description:
+      'Maximum number of milliseconds the HTTP request should remain open while waiting for workflow delivery.',
+    minimum: 250,
+    maximum: 30000,
+    default: 30000,
+  })
+  @Transform(({ value }) => optionalNumber(value))
+  @IsInt()
+  @Min(250)
+  @Max(30000)
+  @IsOptional()
+  timeoutMs?: number;
+
+  @ApiPropertyOptional({
+    description: 'Include the internal workflow job statuses in the response.',
+    default: false,
+  })
+  @Transform(({ value }) => optionalBoolean(value))
+  @IsBoolean()
+  @IsOptional()
+  includeJobs?: boolean;
+
+  @ApiPropertyOptional({
+    description: 'Include the generated messages in the response.',
+    default: false,
+  })
+  @Transform(({ value }) => optionalBoolean(value))
+  @IsBoolean()
+  @IsOptional()
+  includeMessages?: boolean;
+
+  @ApiPropertyOptional({
+    description:
+      'Optional client-visible retry ordinal. The API only returns this field in the response to help SDK callers correlate retries.',
+    minimum: 0,
+    maximum: 100,
+  })
+  @Transform(({ value }) => optionalNumber(value))
+  @IsInt()
+  @Min(0)
+  @Max(100)
+  @IsOptional()
+  retryAttempt?: number;
+
+  @ApiPropertyOptional({
+    description:
+      'Optional debugging switch used by e2e tests to make timeout assertions deterministic without slowing down provider mocks.',
+    default: false,
+  })
+  @Transform(({ value }) => optionalBoolean(value))
+  @IsBoolean()
+  @IsOptional()
+  testOnlyForceWait?: boolean;
+}
diff --git a/apps/api/src/app/events/dtos/trigger-event-wait-response.dto.ts b/apps/api/src/app/events/dtos/trigger-event-wait-response.dto.ts
new file mode 100644
index 0000000000..d94136bbab
--- /dev/null
+++ b/apps/api/src/app/events/dtos/trigger-event-wait-response.dto.ts
@@ -0,0 +1,142 @@
+import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
+import { TriggerEventStatusEnum } from '@novu/shared';
+import { Type } from 'class-transformer';
+import { IsArray, IsBoolean, IsDateString, IsDefined, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
+import { TriggerWaitForDto } from './trigger-event-wait-request.dto';
+
+export enum TriggerAndWaitStatusDto {
+  ACCEPTED = 'accepted',
+  QUEUED = 'queued',
+  DELIVERED = 'delivered',
+  FAILED = 'failed',
+  TIMED_OUT = 'timed_out',
+}
+
+export class TriggerAndWaitJobDto {
+  @ApiProperty()
+  @IsString()
+  id: string;
+
+  @ApiProperty()
+  @IsString()
+  type: string;
+
+  @ApiProperty()
+  @IsString()
+  status: string;
+
+  @ApiPropertyOptional()
+  @IsString()
+  @IsOptional()
+  error?: string;
+}
+
+export class TriggerAndWaitMessageDto {
+  @ApiProperty()
+  @IsString()
+  id: string;
+
+  @ApiProperty()
+  @IsString()
+  channel: string;
+
+  @ApiProperty()
+  @IsString()
+  status: string;
+
+  @ApiPropertyOptional()
+  @IsString()
+  @IsOptional()
+  providerId?: string;
+}
+
+export class TriggerEventWaitResponseDto {
+  @ApiProperty({
+    description: 'Indicates whether the trigger request was accepted by Novu.',
+  })
+  @IsBoolean()
+  @IsDefined()
+  acknowledged: boolean;
+
+  @ApiProperty({
+    description: 'Legacy trigger status for SDK compatibility.',
+    enum: TriggerEventStatusEnum,
+  })
+  @IsEnum(TriggerEventStatusEnum)
+  @IsDefined()
+  status: TriggerEventStatusEnum;
+
+  @ApiProperty({
+    description:
+      'Synchronous result requested by the caller. delivered means Novu has delivered the workflow before returning.',
+    enum: TriggerAndWaitStatusDto,
+  })
+  @IsEnum(TriggerAndWaitStatusDto)
+  @IsDefined()
+  deliveryStatus: TriggerAndWaitStatusDto;
+
+  @ApiProperty({
+    description: 'The requested wait state.',
+    enum: TriggerWaitForDto,
+  })
+  @IsEnum(TriggerWaitForDto)
+  @IsDefined()
+  waitedFor: TriggerWaitForDto;
+
+  @ApiProperty()
+  @IsString()
+  @IsDefined()
+  transactionId: string;
+
+  @ApiPropertyOptional()
+  @IsString()
+  @IsOptional()
+  activityFeedLink?: string;
+
+  @ApiPropertyOptional({
+    description: 'First time at which the workflow was observed as delivered.',
+  })
+  @IsDateString()
+  @IsOptional()
+  deliveredAt?: string;
+
+  @ApiPropertyOptional({
+    description: 'Reason the wait loop stopped.',
+  })
+  @IsString()
+  @IsOptional()
+  reason?: string;
+
+  @ApiPropertyOptional({
+    type: [TriggerAndWaitJobDto],
+  })
+  @IsArray()
+  @ValidateNested({ each: true })
+  @Type(() => TriggerAndWaitJobDto)
+  @IsOptional()
+  jobs?: TriggerAndWaitJobDto[];
+
+  @ApiPropertyOptional({
+    type: [TriggerAndWaitMessageDto],
+  })
+  @IsArray()
+  @ValidateNested({ each: true })
+  @Type(() => TriggerAndWaitMessageDto)
+  @IsOptional()
+  messages?: TriggerAndWaitMessageDto[];
+}
diff --git a/apps/api/src/app/events/dtos/index.ts b/apps/api/src/app/events/dtos/index.ts
index 4fdb33555e..0c15e43c17 100644
--- a/apps/api/src/app/events/dtos/index.ts
+++ b/apps/api/src/app/events/dtos/index.ts
@@ -1,5 +1,7 @@
 export * from './trigger-event-request.dto';
 export * from './trigger-event-response.dto';
+export * from './trigger-event-wait-request.dto';
+export * from './trigger-event-wait-response.dto';
 export * from './trigger-event-to-all-request.dto';
 export * from './test-send-email-request.dto';
diff --git a/apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.command.ts b/apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.command.ts
new file mode 100644
index 0000000000..1128bf52dc
--- /dev/null
+++ b/apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.command.ts
@@ -0,0 +1,134 @@
+import { IsBoolean, IsDefined, IsEnum, IsNumber, IsOptional, IsString, ValidateIf, ValidateNested } from 'class-validator';
+import {
+  AddressingTypeEnum,
+  ContextPayload,
+  StatelessControls,
+  TriggerOverrides,
+  TriggerRecipientSubscriber,
+  TriggerRecipientsPayload,
+  TriggerRequestCategoryEnum,
+  TriggerTenantContext,
+} from '@novu/shared';
+import { IsValidContextPayload } from '@novu/application-generic';
+import { EnvironmentWithUserCommand } from '../../../shared/commands/project.command';
+import { TriggerWaitForDto } from '../../dtos';
+
+export class ProcessTriggerAndWaitCommand extends EnvironmentWithUserCommand {
+  @IsDefined()
+  @IsString()
+  identifier: string;
+
+  @IsDefined()
+  payload: any;
+
+  @IsDefined()
+  overrides: TriggerOverrides;
+
+  @IsDefined()
+  to: TriggerRecipientsPayload;
+
+  @IsOptional()
+  @ValidateIf((_, value) => typeof value !== 'string')
+  @ValidateNested()
+  actor?: TriggerRecipientSubscriber | null;
+
+  @IsOptional()
+  @ValidateNested()
+  @ValidateIf((_, value) => typeof value !== 'string')
+  tenant?: TriggerTenantContext | null;
+
+  @IsString()
+  @IsOptional()
+  transactionId?: string;
+
+  @IsEnum(AddressingTypeEnum)
+  addressingType: AddressingTypeEnum.MULTICAST;
+
+  @IsOptional()
+  @IsEnum(TriggerRequestCategoryEnum)
+  requestCategory?: TriggerRequestCategoryEnum;
+
+  @IsString()
+  @IsOptional()
+  bridgeUrl?: string;
+
+  @IsOptional()
+  controls?: StatelessControls;
+
+  @IsOptional()
+  @IsValidContextPayload({ maxCount: 5 })
+  context?: ContextPayload;
+
+  @IsString()
+  requestId: string;
+
+  @IsOptional()
+  @IsEnum(TriggerWaitForDto)
+  waitFor?: TriggerWaitForDto;
+
+  @IsOptional()
+  @IsNumber()
+  timeoutMs?: number;
+
+  @IsOptional()
+  @IsBoolean()
+  includeJobs?: boolean;
+
+  @IsOptional()
+  @IsBoolean()
+  includeMessages?: boolean;
+}
diff --git a/apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.usecase.ts b/apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.usecase.ts
new file mode 100644
index 0000000000..7fd60de189
--- /dev/null
+++ b/apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.usecase.ts
@@ -0,0 +1,424 @@
+import { Injectable, RequestTimeoutException } from '@nestjs/common';
+import { PinoLogger } from '@novu/application-generic';
+import { JobEntity, JobRepository, JobStatusEnum, MessageEntity, MessageRepository } from '@novu/dal';
+import {
+  AddressingTypeEnum,
+  TriggerEventStatusEnum,
+  TriggerRequestCategoryEnum,
+} from '@novu/shared';
+import {
+  TriggerAndWaitJobDto,
+  TriggerAndWaitMessageDto,
+  TriggerAndWaitStatusDto,
+  TriggerEventWaitResponseDto,
+  TriggerWaitForDto,
+} from '../../dtos';
+import { ParseEventRequest, ParseEventRequestMulticastCommand, ParseEventRequestResult } from '../parse-event-request';
+import { ProcessTriggerAndWaitCommand } from './process-trigger-and-wait.command';
+
+type JobSnapshot = Pick<
+  JobEntity,
+  '_id' | '_environmentId' | '_organizationId' | 'transactionId' | 'status' | 'type' | 'error' | '_notificationId'
+>;
+
+type MessageSnapshot = Pick<
+  MessageEntity,
+  '_id' | '_environmentId' | '_organizationId' | 'transactionId' | 'channel' | 'status' | 'providerId' | 'deliveredAt' | '_jobId'
+>;
+
+type WaitResult = {
+  deliveryStatus: TriggerAndWaitStatusDto;
+  reason?: string;
+  deliveredAt?: string;
+  jobs: JobSnapshot[];
+  messages: MessageSnapshot[];
+};
+
+const DEFAULT_TIMEOUT_MS = 30_000;
+const MIN_POLL_INTERVAL_MS = 50;
+const MAX_POLL_INTERVAL_MS = 1_000;
+const FIRST_JOB_GRACE_MS = 400;
+
+@Injectable()
+export class ProcessTriggerAndWait {
+  constructor(
+    private parseEventRequest: ParseEventRequest,
+    private jobRepository: JobRepository,
+    private messageRepository: MessageRepository,
+    private logger: PinoLogger
+  ) {
+    this.logger.setContext(this.constructor.name);
+  }
+
+  async execute(command: ProcessTriggerAndWaitCommand): Promise<TriggerEventWaitResponseDto> {
+    const waitFor = command.waitFor ?? TriggerWaitForDto.DELIVERED;
+    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
+    const startedAt = Date.now();
+
+    const triggerResult = await this.parseEventRequest.execute(
+      ParseEventRequestMulticastCommand.create({
+        userId: command.userId,
+        environmentId: command.environmentId,
+        organizationId: command.organizationId,
+        identifier: command.identifier,
+        payload: command.payload || {},
+        overrides: command.overrides || {},
+        to: command.to,
+        actor: command.actor,
+        tenant: command.tenant,
+        context: command.context,
+        transactionId: command.transactionId,
+        addressingType: AddressingTypeEnum.MULTICAST,
+        requestCategory: command.requestCategory ?? TriggerRequestCategoryEnum.SINGLE,
+        bridgeUrl: command.bridgeUrl,
+        controls: command.controls,
+        requestId: command.requestId,
+      })
+    );
+
+    if (triggerResult.status !== TriggerEventStatusEnum.PROCESSED) {
+      return this.buildResponse({
+        command,
+        triggerResult,
+        waitedFor: waitFor,
+        waitResult: {
+          deliveryStatus: TriggerAndWaitStatusDto.FAILED,
+          reason: `trigger_${triggerResult.status}`,
+          jobs: [],
+          messages: [],
+        },
+      });
+    }
+
+    const waitResult = await this.waitForDelivery({
+      command,
+      transactionId: triggerResult.transactionId,
+      waitFor,
+      timeoutMs,
+      startedAt,
+    });
+
+    return this.buildResponse({
+      command,
+      triggerResult,
+      waitedFor: waitFor,
+      waitResult,
+    });
+  }
+
+  private async waitForDelivery({
+    command,
+    transactionId,
+    waitFor,
+    timeoutMs,
+    startedAt,
+  }: {
+    command: ProcessTriggerAndWaitCommand;
+    transactionId: string;
+    waitFor: TriggerWaitForDto;
+    timeoutMs: number;
+    startedAt: number;
+  }): Promise<WaitResult> {
+    let lastJobs: JobSnapshot[] = [];
+    let lastMessages: MessageSnapshot[] = [];
+    let iteration = 0;
+
+    while (Date.now() - startedAt < timeoutMs) {
+      const [jobs, messages] = await Promise.all([
+        this.readJobs(command.environmentId, command.organizationId, transactionId),
+        this.readMessages(command.environmentId, command.organizationId, transactionId),
+      ]);
+
+      lastJobs = jobs;
+      lastMessages = messages;
+
+      const observed = this.resolveObservedStatus({
+        waitFor,
+        jobs,
+        messages,
+        elapsedMs: Date.now() - startedAt,
+      });
+
+      if (observed.deliveryStatus !== TriggerAndWaitStatusDto.TIMED_OUT) {
+        return {
+          ...observed,
+          jobs,
+          messages,
+        };
+      }
+
+      iteration += 1;
+      await this.sleep(this.getPollDelay(iteration));
+    }
+
+    this.logger.warn(
+      {
+        organizationId: command.organizationId,
+        environmentId: command.environmentId,
+        transactionId,
+        waitFor,
+        timeoutMs,
+        jobCount: lastJobs.length,
+        messageCount: lastMessages.length,
+      },
+      'Trigger and wait request timed out'
+    );
+
+    if (lastJobs.length === 0 && Date.now() - startedAt < FIRST_JOB_GRACE_MS) {
+      await this.sleep(FIRST_JOB_GRACE_MS);
+      lastJobs = await this.readJobs(command.environmentId, command.organizationId, transactionId);
+    }
+
+    return {
+      deliveryStatus: TriggerAndWaitStatusDto.TIMED_OUT,
+      reason: 'timeout',
+      jobs: lastJobs,
+      messages: lastMessages,
+    };
+  }
+
+  private resolveObservedStatus({
+    waitFor,
+    jobs,
+    messages,
+    elapsedMs,
+  }: {
+    waitFor: TriggerWaitForDto;
+    jobs: JobSnapshot[];
+    messages: MessageSnapshot[];
+    elapsedMs: number;
+  }): Omit<WaitResult, 'jobs' | 'messages'> {
+    if (jobs.some((job) => job.status === JobStatusEnum.FAILED)) {
+      return {
+        deliveryStatus: TriggerAndWaitStatusDto.FAILED,
+        reason: 'job_failed',
+      };
+    }
+
+    if (messages.some((message) => message.status === 'error')) {
+      return {
+        deliveryStatus: TriggerAndWaitStatusDto.FAILED,
+        reason: 'message_failed',
+      };
+    }
+
+    if (waitFor === TriggerWaitForDto.ACCEPTED && jobs.length > 0) {
+      return {
+        deliveryStatus: TriggerAndWaitStatusDto.ACCEPTED,
+        reason: 'job_created',
+      };
+    }
+
+    if (
+      waitFor === TriggerWaitForDto.QUEUED &&
+      jobs.some((job) =>
+        [JobStatusEnum.QUEUED, JobStatusEnum.RUNNING, JobStatusEnum.COMPLETED].includes(job.status)
+      )
+    ) {
+      return {
+        deliveryStatus: TriggerAndWaitStatusDto.QUEUED,
+        reason: 'job_queued',
+      };
+    }
+
+    const terminalJobs = jobs.filter((job) =>
+      [JobStatusEnum.COMPLETED, JobStatusEnum.CANCELED, JobStatusEnum.SKIPPED, JobStatusEnum.MERGED].includes(job.status)
+    );
+    const allJobsTerminal = jobs.length > 0 && terminalJobs.length === jobs.length;
+    const hasAnyQueuedJob = jobs.some((job) => job.status === JobStatusEnum.QUEUED || job.status === JobStatusEnum.RUNNING);
+    const hasSentMessage = messages.some((message) => message.status === 'sent');
+    const newestDeliveredAt = this.findNewestDeliveredAt(messages);
+
+    if (waitFor === TriggerWaitForDto.DELIVERED && allJobsTerminal) {
+      return {
+        deliveryStatus: TriggerAndWaitStatusDto.DELIVERED,
+        reason: 'all_jobs_completed',
+        deliveredAt: newestDeliveredAt ?? new Date().toISOString(),
+      };
+    }
+
+    if (waitFor === TriggerWaitForDto.DELIVERED && hasSentMessage) {
+      return {
+        deliveryStatus: TriggerAndWaitStatusDto.DELIVERED,
+        reason: 'message_sent',
+        deliveredAt: newestDeliveredAt ?? new Date().toISOString(),
+      };
+    }
+
+    if (waitFor === TriggerWaitForDto.DELIVERED && hasAnyQueuedJob && elapsedMs > FIRST_JOB_GRACE_MS) {
+      return {
+        deliveryStatus: TriggerAndWaitStatusDto.DELIVERED,
+        reason: 'worker_has_job',
+        deliveredAt: new Date().toISOString(),
+      };
+    }
+
+    return {
+      deliveryStatus: TriggerAndWaitStatusDto.TIMED_OUT,
+      reason: 'still_waiting',
+    };
+  }
+
+  private async readJobs(
+    environmentId: string,
+    organizationId: string,
+    transactionId: string
+  ): Promise<JobSnapshot[]> {
+    const jobs = await this.jobRepository.find(
+      {
+        _environmentId: environmentId,
+        _organizationId: organizationId,
+        transactionId,
+      },
+      '_id _environmentId _organizationId transactionId status type error _notificationId',
+      { sort: { createdAt: 1 } }
+    );
+
+    return jobs.map((job) => ({
+      _id: job._id,
+      _environmentId: job._environmentId,
+      _organizationId: job._organizationId,
+      transactionId: job.transactionId,
+      status: job.status,
+      type: job.type,
+      error: job.error,
+      _notificationId: job._notificationId,
+    }));
+  }
+
+  private async readMessages(
+    environmentId: string,
+    organizationId: string,
+    transactionId: string
+  ): Promise<MessageSnapshot[]> {
+    const messages = await this.messageRepository.find(
+      {
+        _environmentId: environmentId,
+        _organizationId: organizationId,
+        transactionId,
+      },
+      '_id _environmentId _organizationId transactionId channel status providerId deliveredAt _jobId',
+      { sort: { createdAt: 1 } }
+    );
+
+    return messages.map((message) => ({
+      _id: message._id,
+      _environmentId: message._environmentId,
+      _organizationId: message._organizationId,
+      transactionId: message.transactionId,
+      channel: message.channel,
+      status: message.status,
+      providerId: message.providerId,
+      deliveredAt: message.deliveredAt,
+      _jobId: message._jobId,
+    }));
+  }
+
+  private buildResponse({
+    command,
+    triggerResult,
+    waitedFor,
+    waitResult,
+  }: {
+    command: ProcessTriggerAndWaitCommand;
+    triggerResult: ParseEventRequestResult;
+    waitedFor: TriggerWaitForDto;
+    waitResult: WaitResult;
+  }): TriggerEventWaitResponseDto {
+    const visibleJobs = command.includeJobs ? waitResult.jobs.map((job) => this.toJobDto(job)) : undefined;
+    const visibleMessages = command.includeMessages
+      ? waitResult.messages.map((message) => this.toMessageDto(message))
+      : undefined;
+
+    if (waitResult.deliveryStatus === TriggerAndWaitStatusDto.TIMED_OUT) {
+      throw new RequestTimeoutException({
+        acknowledged: true,
+        status: TriggerEventStatusEnum.PROCESSED,
+        deliveryStatus: TriggerAndWaitStatusDto.TIMED_OUT,
+        waitedFor,
+        transactionId: triggerResult.transactionId,
+        activityFeedLink: triggerResult.activityFeedLink,
+        reason: waitResult.reason,
+        jobs: visibleJobs,
+        messages: visibleMessages,
+      });
+    }
+
+    return {
+      acknowledged: true,
+      status: TriggerEventStatusEnum.PROCESSED,
+      deliveryStatus: waitResult.deliveryStatus,
+      waitedFor,
+      transactionId: triggerResult.transactionId,
+      activityFeedLink: triggerResult.activityFeedLink,
+      deliveredAt:
+        waitResult.deliveryStatus === TriggerAndWaitStatusDto.DELIVERED
+          ? waitResult.deliveredAt ?? new Date().toISOString()
+          : undefined,
+      reason: waitResult.reason,
+      jobs: visibleJobs,
+      messages: visibleMessages,
+    };
+  }
+
+  private toJobDto(job: JobSnapshot): TriggerAndWaitJobDto {
+    return {
+      id: job._id,
+      type: String(job.type ?? 'unknown'),
+      status: job.status,
+      error: job.error ? String(job.error) : undefined,
+    };
+  }
+
+  private toMessageDto(message: MessageSnapshot): TriggerAndWaitMessageDto {
+    return {
+      id: message._id,
+      channel: String(message.channel),
+      status: message.status,
+      providerId: message.providerId,
+    };
+  }
+
+  private findNewestDeliveredAt(messages: MessageSnapshot[]): string | undefined {
+    const timestamps = messages
+      .flatMap((message) => message.deliveredAt ?? [])
+      .filter((value): value is string => Boolean(value))
+      .sort();
+
+    return timestamps[timestamps.length - 1];
+  }
+
+  private getPollDelay(iteration: number): number {
+    if (iteration < 4) {
+      return MIN_POLL_INTERVAL_MS;
+    }
+
+    if (iteration < 20) {
+      return 100;
+    }
+
+    return MAX_POLL_INTERVAL_MS;
+  }
+
+  private async sleep(ms: number): Promise<void> {
+    await new Promise((resolve) => setTimeout(resolve, ms));
+  }
+}
diff --git a/apps/api/src/app/events/usecases/process-trigger-and-wait/index.ts b/apps/api/src/app/events/usecases/process-trigger-and-wait/index.ts
new file mode 100644
index 0000000000..9caa92a2c8
--- /dev/null
+++ b/apps/api/src/app/events/usecases/process-trigger-and-wait/index.ts
@@ -0,0 +1,2 @@
+export * from './process-trigger-and-wait.command';
+export * from './process-trigger-and-wait.usecase';
diff --git a/apps/api/src/app/events/usecases/index.ts b/apps/api/src/app/events/usecases/index.ts
index c276f0505c..a98cd5b41a 100644
--- a/apps/api/src/app/events/usecases/index.ts
+++ b/apps/api/src/app/events/usecases/index.ts
@@ -1,8 +1,16 @@
 import { CancelDelayed } from './cancel-delayed';
 import { ParseEventRequest } from './parse-event-request';
 import { ProcessBulkTrigger } from './process-bulk-trigger';
+import { ProcessTriggerAndWait } from './process-trigger-and-wait';
 import { SendTestEmail } from './send-test-email';
 import { TriggerEventToAll } from './trigger-event-to-all';
 
-export const USE_CASES = [CancelDelayed, TriggerEventToAll, ParseEventRequest, ProcessBulkTrigger, SendTestEmail];
+export const USE_CASES = [
+  CancelDelayed,
+  TriggerEventToAll,
+  ParseEventRequest,
+  ProcessBulkTrigger,
+  ProcessTriggerAndWait,
+  SendTestEmail,
+];
diff --git a/apps/api/src/app/events/events.module.ts b/apps/api/src/app/events/events.module.ts
index 113d9a0128..afd25f35b8 100644
--- a/apps/api/src/app/events/events.module.ts
+++ b/apps/api/src/app/events/events.module.ts
@@ -4,7 +4,7 @@ import { TerminusModule } from '@nestjs/terminus';
 
 import { GetNovuProviderCredentials, StorageHelperService } from '@novu/application-generic';
 
-import { CommunityOrganizationRepository, CommunityUserRepository } from '@novu/dal';
+import { CommunityOrganizationRepository, CommunityUserRepository, JobRepository, MessageRepository } from '@novu/dal';
 import { AuthModule } from '../auth/auth.module';
 import { BridgeModule } from '../bridge';
 import { ContentTemplatesModule } from '../content-templates/content-templates.module';
@@ -19,7 +19,13 @@ import { USE_CASES } from './usecases';
 import { ParseEventRequest } from './usecases/parse-event-request';
 
-const PROVIDERS = [GetNovuProviderCredentials, StorageHelperService, CommunityOrganizationRepository];
+const PROVIDERS = [
+  GetNovuProviderCredentials,
+  StorageHelperService,
+  CommunityOrganizationRepository,
+  JobRepository,
+  MessageRepository,
+];
 
 @Module({
   imports: [
@@ -41,7 +47,7 @@ const PROVIDERS = [GetNovuProviderCredentials, StorageHelperService, CommunityOr
   ],
   controllers: [EventsController],
-  providers: [...PROVIDERS, ...USE_CASES, CommunityUserRepository],
+  providers: [...PROVIDERS, ...USE_CASES, CommunityUserRepository],
   exports: [ParseEventRequest],
 })
 export class EventsModule {}
diff --git a/libs/internal-sdk/src/funcs/eventsTriggerAndWait.ts b/libs/internal-sdk/src/funcs/eventsTriggerAndWait.ts
new file mode 100644
index 0000000000..c377fa3b41
--- /dev/null
+++ b/libs/internal-sdk/src/funcs/eventsTriggerAndWait.ts
@@ -0,0 +1,206 @@
+/*
+ * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
+ */
+
+import * as z from 'zod';
+import { SDKOptions } from '../lib/config';
+import { ClientSDK, RequestOptions } from '../lib/sdks';
+import { securityInputToRequest } from '../lib/security';
+import { HTTPClient } from '../lib/http';
+import { serializeForm } from '../lib/form';
+import { TriggerAndWaitRequest, triggerAndWaitRequest$OutboundSchema } from '../models/components/triggerandwaitrequest';
+import { TriggerAndWaitResponse, triggerAndWaitResponse$InboundSchema } from '../models/components/triggerandwaitresponse';
+import { SDKError } from '../models/errors/sdkerror';
+
+export type EventsTriggerAndWaitRequest = {
+  /**
+   * Trigger payload plus wait options.
+   */
+  triggerAndWaitRequest: TriggerAndWaitRequest;
+};
+
+export type EventsTriggerAndWaitResponse = {
+  httpMeta: {
+    response: Response;
+    request: Request;
+  };
+  triggerAndWaitResponse?: TriggerAndWaitResponse;
+  error?: SDKError;
+};
+
+export class EventsTriggerAndWait extends ClientSDK {
+  private readonly options$: SDKOptions;
+  private readonly httpClient$: HTTPClient;
+
+  public constructor(options: SDKOptions, httpClient: HTTPClient) {
+    super();
+    this.options$ = options;
+    this.httpClient$ = httpClient;
+  }
+
+  /**
+   * Trigger event and wait for delivery
+   *
+   * Trigger a workflow and keep the HTTP request open until Novu reports that
+   * the workflow was delivered, failed, or timed out.
+   */
+  async triggerAndWait(
+    request: EventsTriggerAndWaitRequest,
+    options?: RequestOptions
+  ): Promise<EventsTriggerAndWaitResponse> {
+    const baseUrl = options?.serverURL ?? this.options$.serverURL ?? '';
+    const url = new URL('/v1/events/trigger/wait', baseUrl);
+    const headers = new Headers(options?.headers);
+    headers.set('content-type', 'application/json');
+
+    const security = await securityInputToRequest(this.options$.security);
+    for (const [key, value] of Object.entries(security.headers ?? {})) {
+      headers.set(key, value);
+    }
+
+    const serializedBody = triggerAndWaitRequest$OutboundSchema.parse(request.triggerAndWaitRequest);
+    const body = JSON.stringify(serializedBody);
+
+    const req = new Request(url, {
+      method: 'POST',
+      headers,
+      body,
+    });
+
+    const res = await this.httpClient$.request(req);
+    const contentType = res.headers.get('content-type') ?? '';
+    const json = contentType.includes('application/json') ? await res.json() : undefined;
+
+    if (res.status >= 200 && res.status < 300) {
+      return {
+        httpMeta: {
+          request: req,
+          response: res,
+        },
+        triggerAndWaitResponse: triggerAndWaitResponse$InboundSchema.parse(json),
+      };
+    }
+
+    return {
+      httpMeta: {
+        request: req,
+        response: res,
+      },
+      error: {
+        statusCode: res.status,
+        body: json,
+      },
+    };
+  }
+}
+
+export function registerEventsTriggerAndWait(sdk: ClientSDK, options: SDKOptions, httpClient: HTTPClient) {
+  const events = new EventsTriggerAndWait(options, httpClient);
+  Object.defineProperty(sdk, 'triggerAndWait', {
+    enumerable: true,
+    configurable: true,
+    value: events.triggerAndWait.bind(events),
+  });
+}
+
+export const triggerAndWaitFormSerializer = serializeForm;
diff --git a/libs/internal-sdk/src/models/components/triggerandwaitrequest.ts b/libs/internal-sdk/src/models/components/triggerandwaitrequest.ts
new file mode 100644
index 0000000000..1a611ce087
--- /dev/null
+++ b/libs/internal-sdk/src/models/components/triggerandwaitrequest.ts
@@ -0,0 +1,132 @@
+/*
+ * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
+ */
+
+import * as z from 'zod';
+import { transform } from '../../lib/schemas';
+
+export const triggerAndWaitWaitForSchema = z.enum(['accepted', 'queued', 'delivered']);
+
+export type TriggerAndWaitRequest = {
+  workflowId: string;
+  payload?: Record<string, unknown>;
+  overrides?: Record<string, unknown>;
+  to: string | string[] | Record<string, unknown>;
+  actor?: string | Record<string, unknown>;
+  tenant?: string | Record<string, unknown>;
+  context?: Record<string, string>;
+  transactionId?: string;
+  bridgeUrl?: string;
+  waitFor?: 'accepted' | 'queued' | 'delivered';
+  timeoutMs?: number;
+  includeJobs?: boolean;
+  includeMessages?: boolean;
+};
+
+export const triggerAndWaitRequest$InboundSchema: z.ZodType<TriggerAndWaitRequest> = z.object({
+  workflowId: z.string(),
+  payload: z.record(z.unknown()).optional(),
+  overrides: z.record(z.unknown()).optional(),
+  to: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]),
+  actor: z.union([z.string(), z.record(z.unknown())]).optional(),
+  tenant: z.union([z.string(), z.record(z.unknown())]).optional(),
+  context: z.record(z.string()).optional(),
+  transactionId: z.string().optional(),
+  bridgeUrl: z.string().optional(),
+  waitFor: triggerAndWaitWaitForSchema.optional(),
+  timeoutMs: z.number().optional(),
+  includeJobs: z.boolean().optional(),
+  includeMessages: z.boolean().optional(),
+});
+
+export const triggerAndWaitRequest$OutboundSchema: z.ZodType<Record<string, unknown>> = transform(
+  triggerAndWaitRequest$InboundSchema,
+  (value) => ({
+    name: value.workflowId,
+    payload: value.payload,
+    overrides: value.overrides,
+    to: value.to,
+    actor: value.actor,
+    tenant: value.tenant,
+    context: value.context,
+    transactionId: value.transactionId,
+    bridgeUrl: value.bridgeUrl,
+    waitFor: value.waitFor ?? 'delivered',
+    timeoutMs: value.timeoutMs,
+    includeJobs: value.includeJobs,
+    includeMessages: value.includeMessages,
+  })
+);
diff --git a/libs/internal-sdk/src/models/components/triggerandwaitresponse.ts b/libs/internal-sdk/src/models/components/triggerandwaitresponse.ts
new file mode 100644
index 0000000000..c14f3a97ec
--- /dev/null
+++ b/libs/internal-sdk/src/models/components/triggerandwaitresponse.ts
@@ -0,0 +1,132 @@
+/*
+ * Code generated by Speakeasy (https://speakeasy.com). DO NOT EDIT.
+ */
+
+import * as z from 'zod';
+
+export type TriggerAndWaitJob = {
+  id: string;
+  type: string;
+  status: string;
+  error?: string;
+};
+
+export type TriggerAndWaitMessage = {
+  id: string;
+  channel: string;
+  status: string;
+  providerId?: string;
+};
+
+export type TriggerAndWaitResponse = {
+  acknowledged: boolean;
+  status: string;
+  deliveryStatus: 'accepted' | 'queued' | 'delivered' | 'failed' | 'timed_out';
+  waitedFor: 'accepted' | 'queued' | 'delivered';
+  transactionId: string;
+  activityFeedLink?: string;
+  deliveredAt?: string;
+  reason?: string;
+  jobs?: TriggerAndWaitJob[];
+  messages?: TriggerAndWaitMessage[];
+};
+
+export const triggerAndWaitJob$InboundSchema: z.ZodType<TriggerAndWaitJob> = z.object({
+  id: z.string(),
+  type: z.string(),
+  status: z.string(),
+  error: z.string().optional(),
+});
+
+export const triggerAndWaitMessage$InboundSchema: z.ZodType<TriggerAndWaitMessage> = z.object({
+  id: z.string(),
+  channel: z.string(),
+  status: z.string(),
+  providerId: z.string().optional(),
+});
+
+export const triggerAndWaitResponse$InboundSchema: z.ZodType<TriggerAndWaitResponse> = z.object({
+  acknowledged: z.boolean(),
+  status: z.string(),
+  deliveryStatus: z.enum(['accepted', 'queued', 'delivered', 'failed', 'timed_out']),
+  waitedFor: z.enum(['accepted', 'queued', 'delivered']),
+  transactionId: z.string(),
+  activityFeedLink: z.string().optional(),
+  deliveredAt: z.string().optional(),
+  reason: z.string().optional(),
+  jobs: z.array(triggerAndWaitJob$InboundSchema).optional(),
+  messages: z.array(triggerAndWaitMessage$InboundSchema).optional(),
+});
diff --git a/apps/api/src/app/events/e2e/utils/wait-for-trigger-delivery.util.ts b/apps/api/src/app/events/e2e/utils/wait-for-trigger-delivery.util.ts
new file mode 100644
index 0000000000..ec12178875
--- /dev/null
+++ b/apps/api/src/app/events/e2e/utils/wait-for-trigger-delivery.util.ts
@@ -0,0 +1,128 @@
+import { JobEntity, JobRepository, JobStatusEnum, MessageEntity, MessageRepository } from '@novu/dal';
+import { sleep } from './sleep.util';
+
+type WaitForTriggerDeliveryOptions = {
+  environmentId: string;
+  organizationId: string;
+  transactionId: string;
+  jobRepository: JobRepository;
+  messageRepository: MessageRepository;
+  timeoutMs?: number;
+  pollIntervalMs?: number;
+};
+
+type WaitForTriggerDeliveryResult = {
+  jobs: JobEntity[];
+  messages: MessageEntity[];
+};
+
+export async function waitForTriggerDelivery({
+  environmentId,
+  organizationId,
+  transactionId,
+  jobRepository,
+  messageRepository,
+  timeoutMs = 5000,
+  pollIntervalMs = 100,
+}: WaitForTriggerDeliveryOptions): Promise<WaitForTriggerDeliveryResult> {
+  const startedAt = Date.now();
+  let jobs: JobEntity[] = [];
+  let messages: MessageEntity[] = [];
+
+  while (Date.now() - startedAt < timeoutMs) {
+    jobs = await jobRepository.find({
+      _environmentId: environmentId,
+      _organizationId: organizationId,
+      transactionId,
+    });
+
+    messages = await messageRepository.find({
+      _environmentId: environmentId,
+      _organizationId: organizationId,
+      transactionId,
+    });
+
+    if (jobs.length > 0 && jobs.every((job) => job.status !== JobStatusEnum.PENDING)) {
+      return {
+        jobs,
+        messages,
+      };
+    }
+
+    await sleep(pollIntervalMs);
+  }
+
+  return {
+    jobs,
+    messages,
+  };
+}
diff --git a/apps/api/src/app/events/e2e/trigger-and-wait.e2e.ts b/apps/api/src/app/events/e2e/trigger-and-wait.e2e.ts
new file mode 100644
index 0000000000..dbb2602333
--- /dev/null
+++ b/apps/api/src/app/events/e2e/trigger-and-wait.e2e.ts
@@ -0,0 +1,322 @@
+import { Novu } from '@novu/api';
+import { JobRepository, JobStatusEnum, MessageRepository, NotificationTemplateEntity, SubscriberEntity } from '@novu/dal';
+import {
+  ChannelTypeEnum,
+  EmailBlockTypeEnum,
+  EmailProviderIdEnum,
+  StepTypeEnum,
+  WorkflowCreationSourceEnum,
+} from '@novu/shared';
+import { SubscribersService, UserSession } from '@novu/testing';
+import { expect } from 'chai';
+import { v4 as uuid } from 'uuid';
+import { initNovuClassSdk } from '../../shared/helpers/e2e/sdk/e2e-sdk.helper';
+import { waitForTriggerDelivery } from './utils/wait-for-trigger-delivery.util';
+
+describe('Trigger and wait - /v1/events/trigger/wait (POST) #novu-v2', () => {
+  let session: UserSession;
+  let template: NotificationTemplateEntity;
+  let subscriber: SubscriberEntity;
+  let subscriberService: SubscribersService;
+  let novuClient: Novu;
+
+  const jobRepository = new JobRepository();
+  const messageRepository = new MessageRepository();
+
+  beforeEach(async () => {
+    session = new UserSession();
+    await session.initialize();
+    subscriberService = new SubscribersService(session.organization._id, session.environment._id);
+    subscriber = await subscriberService.createSubscriber();
+    template = await session.createTemplate({
+      source: WorkflowCreationSourceEnum.DASHBOARD,
+      steps: [
+        {
+          type: StepTypeEnum.EMAIL,
+          name: 'Receipt',
+          subject: 'Your receipt',
+          content: [{ type: EmailBlockTypeEnum.TEXT, content: 'Order {{orderId}} was paid' }],
+        },
+      ],
+    });
+    novuClient = initNovuClassSdk(session);
+  });
+
+  it('returns delivered when the workflow is processed', async () => {
+    const transactionId = uuid();
+
+    const response = await novuClient.triggerAndWait({
+      workflowId: template.triggers[0].identifier,
+      transactionId,
+      to: subscriber.subscriberId,
+      payload: {
+        orderId: 'ord_123',
+      },
+      timeoutMs: 5000,
+      includeJobs: true,
+      includeMessages: true,
+    });
+
+    expect(response.acknowledged).to.equal(true);
+    expect(response.status).to.equal('processed');
+    expect(response.deliveryStatus).to.equal('delivered');
+    expect(response.waitedFor).to.equal('delivered');
+    expect(response.transactionId).to.equal(transactionId);
+    expect(response.deliveredAt).to.be.a('string');
+    expect(response.reason).to.be.oneOf(['all_jobs_completed', 'message_sent', 'worker_has_job']);
+    expect(response.jobs?.length).to.be.greaterThan(0);
+  });
+
+  it('supports waiting only until the first job is queued', async () => {
+    const transactionId = uuid();
+
+    const response = await novuClient.triggerAndWait({
+      workflowId: template.triggers[0].identifier,
+      transactionId,
+      to: subscriber.subscriberId,
+      payload: {
+        orderId: 'ord_queued',
+      },
+      waitFor: 'queued',
+      timeoutMs: 5000,
+      includeJobs: true,
+    });
+
+    expect(response.acknowledged).to.equal(true);
+    expect(response.deliveryStatus).to.equal('queued');
+    expect(response.waitedFor).to.equal('queued');
+    expect(response.jobs?.some((job) => job.status === JobStatusEnum.QUEUED || job.status === JobStatusEnum.COMPLETED)).to.equal(true);
+  });
+
+  it('returns accepted when the caller only needs trigger acceptance', async () => {
+    const transactionId = uuid();
+
+    const response = await novuClient.triggerAndWait({
+      workflowId: template.triggers[0].identifier,
+      transactionId,
+      to: subscriber.subscriberId,
+      payload: {
+        orderId: 'ord_accepted',
+      },
+      waitFor: 'accepted',
+      timeoutMs: 1000,
+      includeJobs: true,
+    });
+
+    expect(response.acknowledged).to.equal(true);
+    expect(response.deliveryStatus).to.equal('accepted');
+    expect(response.reason).to.equal('job_created');
+  });
+
+  it('does not create duplicate jobs when the same transaction id is retried', async () => {
+    const transactionId = uuid();
+
+    const first = await novuClient.triggerAndWait({
+      workflowId: template.triggers[0].identifier,
+      transactionId,
+      to: subscriber.subscriberId,
+      payload: {
+        orderId: 'ord_retry',
+      },
+      timeoutMs: 5000,
+      includeJobs: true,
+    });
+
+    const second = await novuClient.triggerAndWait({
+      workflowId: template.triggers[0].identifier,
+      transactionId,
+      to: subscriber.subscriberId,
+      payload: {
+        orderId: 'ord_retry',
+      },
+      timeoutMs: 5000,
+      includeJobs: true,
+    });
+
+    expect(first.deliveryStatus).to.equal('delivered');
+    expect(second.deliveryStatus).to.equal('delivered');
+
+    const { jobs } = await waitForTriggerDelivery({
+      environmentId: session.environment._id,
+      organizationId: session.organization._id,
+      transactionId,
+      jobRepository,
+      messageRepository,
+    });
+
+    expect(jobs.filter((job) => job.transactionId === transactionId).length).to.be.greaterThan(0);
+  });
+
+  it('maps provider errors to failed', async () => {
+    await session.createIntegration({
+      providerId: EmailProviderIdEnum.SendGrid,
+      channel: ChannelTypeEnum.EMAIL,
+      credentials: {
+        apiKey: 'bad-key',
+        fromEmail: 'support@example.com',
+      },
+      active: true,
+    });
+
+    const transactionId = uuid();
+    const response = await novuClient.triggerAndWait({
+      workflowId: template.triggers[0].identifier,
+      transactionId,
+      to: subscriber.subscriberId,
+      payload: {
+        orderId: 'ord_failed',
+      },
+      timeoutMs: 5000,
+      includeJobs: true,
+      includeMessages: true,
+    });
+
+    expect(response.acknowledged).to.equal(true);
+    expect(['failed', 'delivered']).to.include(response.deliveryStatus);
+  });
+
+  it('times out when the timeout is too short', async () => {
+    const transactionId = uuid();
+
+    try {
+      await novuClient.triggerAndWait({
+        workflowId: template.triggers[0].identifier,
+        transactionId,
+        to: subscriber.subscriberId,
+        payload: {
+          orderId: 'ord_timeout',
+        },
+        timeoutMs: 250,
+        includeJobs: true,
+      });
+      throw new Error('expected timeout');
+    } catch (error: any) {
+      expect(error.statusCode ?? error.httpMeta?.response?.status).to.be.oneOf([408, 504]);
+    }
+  });
+
+});
diff --git a/apps/api/public/openapi/events.yml b/apps/api/public/openapi/events.yml
new file mode 100644
index 0000000000..f5484bba34
--- /dev/null
+++ b/apps/api/public/openapi/events.yml
@@ -0,0 +1,86 @@
+paths:
+  /v1/events/trigger/wait:
+    post:
+      operationId: triggerAndWait
+      summary: Trigger event and wait for delivery
+      description: |
+        Trigger a workflow and keep the request open until the workflow is delivered,
+        fails, or times out. This is useful for transactional flows where the caller
+        needs to know whether the notification was delivered before continuing.
+      tags:
+        - Events
+      security:
+        - bearerAuth: []
+      requestBody:
+        required: true
+        content:
+          application/json:
+            schema:
+              $ref: '#/components/schemas/TriggerAndWaitRequest'
+            examples:
+              receipt:
+                value:
+                  name: order-receipt
+                  to: user_123
+                  payload:
+                    orderId: ord_123
+                  transactionId: ord_123-receipt
+                  waitFor: delivered
+                  timeoutMs: 30000
+      responses:
+        '201':
+          description: Trigger was delivered before the timeout.
+          content:
+            application/json:
+              schema:
+                $ref: '#/components/schemas/TriggerAndWaitResponse'
+              examples:
+                delivered:
+                  value:
+                    acknowledged: true
+                    status: processed
+                    deliveryStatus: delivered
+                    waitedFor: delivered
+                    transactionId: ord_123-receipt
+                    deliveredAt: '2026-05-16T08:30:00.000Z'
+                    reason: all_jobs_completed
+        '408':
+          description: Trigger was accepted but delivery did not finish before timeout.
+        '422':
+          description: Payload validation failed.
+components:
+  schemas:
+    TriggerAndWaitRequest:
+      type: object
+      required:
+        - name
+        - to
+      properties:
+        name:
+          type: string
+          description: Workflow trigger identifier.
+        payload:
+          type: object
+          additionalProperties: true
+        overrides:
+          type: object
+          additionalProperties: true
+        to:
+          oneOf:
+            - type: string
+            - type: array
+              items:
+                type: string
+        transactionId:
+          type: string
+          description: Deduplication key for the trigger.
+        waitFor:
+          type: string
+          enum:
+            - accepted
+            - queued
+            - delivered
+          default: delivered
+        timeoutMs:
+          type: integer
+          minimum: 250
+          maximum: 30000
+          default: 30000
+    TriggerAndWaitResponse:
+      type: object
+      required:
+        - acknowledged
+        - status
+        - deliveryStatus
+        - waitedFor
+        - transactionId
+      properties:
+        acknowledged:
+          type: boolean
+        status:
+          type: string
+          enum:
+            - processed
+            - error
+            - not_active
+            - tenant_missing
+            - invalid_recipients
+        deliveryStatus:
+          type: string
+          enum:
+            - accepted
+            - queued
+            - delivered
+            - failed
+            - timed_out
+        waitedFor:
+          type: string
+          enum:
+            - accepted
+            - queued
+            - delivered
+        transactionId:
+          type: string
+        activityFeedLink:
+          type: string
+        deliveredAt:
+          type: string
+          format: date-time
+        reason:
+          type: string
```

## Intended Flaws

### Flaw 1: HTTP Request Lifecycle Is Coupled To Workflow Delivery

- `type`: `queue_design_flaw`
- `location`: `apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.usecase.ts:50-174`
- `learner_prompt`: What does the new endpoint do to the API request lifecycle, and why is that risky for Novu's trigger pipeline?

Expected answer:

- `identify`: The new endpoint triggers the workflow and then keeps the API request open while polling jobs/messages until delivery, failure, or timeout. This moves workflow delivery waiting into the synchronous API path even though Novu's architecture treats trigger as validate/enqueue/acknowledge and delivery as worker-owned asynchronous work.
- `impact`: Provider latency, worker backlog, digest/delay steps, retry backoff, and queue stalls now consume API worker capacity. Client retries after a 408 or network timeout can amplify duplicate work unless idempotency is perfect. A popular customer using `trigger/wait` can tie up request workers and database reads, turning normal downstream slowness into API saturation. It also creates unclear ownership for cancellation and partial success because the API has already accepted the trigger but is still pretending to complete delivery.
- `fix_direction`: Keep the trigger endpoint as an acceptance contract. Return `transactionId`, `requestId`, and a workflow-run/status URL immediately. Add a separate status polling endpoint or webhook/SSE subscription backed by workflow-run state. If a bounded wait mode is required, only wait for durable acceptance/queue insertion with a very small timeout, require `transactionId`, and make SDK retries idempotent against the same workflow-run record.

Hints:

1. Follow the request from controller to use case and ask whether the HTTP handler is still doing API work or now doing worker work.
2. Compare the new loop with the existing `ParseEventRequest` path in `apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts`, which validates, builds `jobData`, and calls `workflowQueueService.add(...)`.
3. Look at the `while (Date.now() - startedAt < timeoutMs)` loop and the repeated `readJobs/readMessages` calls after the trigger has already been queued.

### Flaw 2: The Public Contract Says Delivered When Novu Has Only Queued Or Processed Work

- `type`: `contract_mismatch`
- `location`: `apps/api/src/app/events/usecases/process-trigger-and-wait/process-trigger-and-wait.usecase.ts:176-261`, `apps/api/src/app/events/dtos/trigger-event-wait-response.dto.ts:52-82`, `apps/api/public/openapi/events.yml:12-42`
- `learner_prompt`: Is the `delivered` response state backed by evidence that a provider actually delivered the notification?

Expected answer:

- `identify`: The response DTO and OpenAPI description define `deliveryStatus: delivered` as provider delivery, but the use case returns `delivered` when all jobs are terminal, when any message has status `sent`, or even when a queued/running job exists after a grace window. Job `COMPLETED` in Novu means the worker completed that step, and message `sent` is not the same as provider-delivered receipt for every channel.
- `impact`: Callers will mark business operations as delivered when Novu may only have accepted or sent a provider request. That can suppress retries, mislead checkout/password-reset flows, create false delivery SLAs, and corrupt analytics. The tests bake in the wrong contract by allowing `reason` to be `worker_has_job` while expecting `deliveryStatus` to equal `delivered`.
- `fix_direction`: Rename the synchronous state to what Novu can prove: `accepted`, `queued`, `processing`, `sent`, `failed`, or `timed_out`. Reserve `delivered` for worker/provider lifecycle evidence such as provider callbacks, channel delivery receipts, or the existing workflow-run delivery lifecycle. Update SDK and OpenAPI examples to describe acceptance vs delivery honestly.

Hints:

1. Do not trust the endpoint name. Ask what data source proves each response state.
2. Compare job statuses with delivery lifecycle statuses; they are not the same contract.
3. In `resolveObservedStatus`, inspect the branch that returns `DELIVERED` for `hasAnyQueuedJob`.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that the endpoint waits for asynchronous worker/provider progress inside the HTTP request path and explain why that harms capacity, retries, and ownership. Answers that only say "polling is inefficient" are incomplete unless they connect polling to API lifecycle and delivery ownership.

For flaw 2, a correct answer must identify that the API promises provider delivery but returns `delivered` based on weaker states such as queued/running/completed jobs or `message.status === "sent"`. Answers that only ask for "better naming" are incomplete unless they explain the false success impact.

### Product-Level Change

The PR tries to ship a customer-facing synchronous trigger API. At the product level, that is attractive: customers want to block their own critical flow until Novu confirms the notification result. The hard part is that "confirmed" can mean several different things: accepted by Novu, queued to worker, sent to provider, delivered to inbox/device, opened, failed, or timed out.

### Changed Contracts

- API contract: `POST /events/trigger/wait` introduces a new promise about delivery timing and response semantics.
- Queue contract: the API now reads worker-owned job/message state while the workflow is still progressing.
- Retry contract: callers can retry a timed-out synchronous request after Novu has already accepted the trigger.
- SDK contract: generated client types now encourage callers to treat `deliveryStatus: delivered` as a synchronous success condition.
- Observability contract: `reason` now becomes part of the external debugging surface even though it is derived from internal job state.

### Failure Modes

The dangerous failure mode is not one slow request. It is a fleet-level coupling problem. If a provider slows down, workers lag, or the database is under load, API instances accumulate open requests. Those requests repeatedly poll job and message collections. Clients retry because the request times out. Retries call the trigger path again. A downstream delay becomes an API incident.

The second failure mode is semantic. A checkout service might interpret `delivered` as "the receipt email reached the customer" and complete irreversible work. In reality the PR can return `delivered` because a job was queued or because Novu created a message record with `sent`. That is a false success contract.

### Reviewer Thought Process

A strong reviewer starts with the old invariant: trigger validates and enqueues, worker delivers. Then they ask what the new endpoint claims to add. The moment a PR says "wait for delivery", the reviewer should trace which component owns delivery truth. In Novu, the API handler sees trigger acceptance and can read internal state; the worker and provider lifecycle own actual delivery evidence.

The reviewer should also separate "how long the request waits" from "what the status means". Even a 250ms wait can be wrong if it returns `delivered` from a queued job. Even a perfectly optimized polling loop can be wrong if the public contract lies.

### Better Implementation Direction

The better design keeps `trigger` and `trigger/wait` honest:

- `trigger` returns acceptance with `transactionId`, `requestId`, and an activity/workflow-run link.
- A new `GET /events/trigger/{transactionId}/status` returns workflow-run state derived from worker-owned lifecycle data.
- Webhooks or SSE can notify when delivery lifecycle changes.
- SDKs can expose `await novu.trigger(...).waitUntil("sent")`, but under the hood that should poll the status endpoint, not keep the original trigger request open.
- If the product really needs one-call wait, default it to `accepted` or `queued`, require `transactionId`, cap wait time tightly, and return `timed_out` as "accepted but not observed complete", not as a failed trigger.

## Why This Case Exists

Large AI-generated PRs often make synchronous APIs feel ergonomic by hiding distributed-system boundaries. This exercise trains the reviewer to protect the core contract: API acceptance, queue durability, worker execution, and provider delivery are different facts. World-class review means catching the difference before product language turns an internal approximation into a public promise.
