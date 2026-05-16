# TS-027: Novu Subscriber External-ID Lookup

## Metadata

- `id`: TS-027
- `source_repo`: [novuhq/novu](https://github.com/novuhq/novu)
- `repo_area`: subscriber repository, external subscriber identifiers, environment tenancy, subscriber preference APIs, inbox preference writes, cache keys, preference-change audit events
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 1,100-1,350
- `represented_diff_lines`: 1,344
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about external subscriber IDs, Novu environment boundaries, organization scoping, cache keys, preference document ownership, and actor/provenance modeling without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds first-class lookup and preference update support for subscribers by external subscriber ID.

Today several Novu APIs still require callers to know whether they are working with an external subscriber ID, an internal subscriber document ID, or a preference document ID. Product teams building customer preference centers usually know only their own user ID. This change adds a small "external subscriber" facade that can:

- fetch a subscriber profile by external subscriber ID,
- return a compact profile plus global preference summary,
- update global subscriber preferences by external subscriber ID,
- emit a preference audit event for downstream analytics,
- expose a matching JavaScript SDK helper,
- cache the read path to reduce repeated preference-center page loads.

The intent is to make customer preference-center integrations simpler without making app teams pass internal Novu IDs around.

## Existing Code Context

The real Novu codebase already has these relevant contracts:

- `libs/dal/src/repositories/subscriber/subscriber.entity.ts` models `subscriberId` as the external subscriber identifier and stores `_organizationId` plus `_environmentId` on every subscriber.
- `libs/dal/src/repositories/subscriber/subscriber.schema.ts` defines `unique_subscriber_per_environment` over `{ subscriberId, _environmentId }`, explicitly allowing the same external subscriber ID in different environments.
- `libs/dal/src/repositories/subscriber/subscriber.repository.ts` has `findBySubscriberId(environmentId, subscriberId)` and `searchByExternalSubscriberIds()` that scope by environment, and in the bulk path also organization.
- `apps/api/src/app/subscribers/usecases/get-subscriber/get-subscriber.usecase.ts` builds cache keys with both `_environmentId` and `subscriberId`.
- `apps/api/src/app/subscribers/usecases/search-by-external-subscriber-ids/search-by-external-subscriber-ids.use-case.ts` maps commands to `_environmentId`, `_organizationId`, and external subscriber IDs before calling the repository.
- `apps/api/src/app/subscribers/subscribersV1.controller.ts` routes existing subscriber reads and preference writes through `@UserSession() user`, passing `user.environmentId` and `user.organizationId` into commands.
- `apps/api/src/app/inbox/usecases/update-preferences/update-preferences.usecase.ts` resolves the external `subscriberId` into the internal subscriber `_id` before writing subscriber preference documents.
- `libs/dal/src/repositories/preferences/preferences.schema.ts` keys subscriber-global preferences by `_environmentId`, `_subscriberId`, `type`, and context hash.
- Novu also has an actor concept for notification payloads (`packages/shared/src/entities/actor/actor.interface.ts` and `IActorDto`), so "who performed this action" is a modeled product concern even when the exact preference audit entity is new in this PR.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.command.ts`
- `apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.ts`
- `apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.command.ts`
- `apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.ts`
- `apps/api/src/app/subscribers/subscribersV1.controller.ts`
- `libs/dal/src/repositories/subscriber/subscriber.repository.ts`
- `libs/dal/src/repositories/preferences/preference-audit.entity.ts`
- `libs/dal/src/repositories/preferences/preference-audit.repository.ts`
- `packages/js/src/subscribers/external-id.ts`
- `apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.spec.ts`
- `apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.spec.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on backend/API behavior, identity scoping, cache keys, preference write contracts, and tests.

## Diff

```diff
diff --git a/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.command.ts b/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.command.ts
new file mode 100644
index 0000000000..98ad1d2f4e
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.command.ts
@@ -0,0 +1,87 @@
+import { IsBoolean, IsDefined, IsOptional, IsString } from 'class-validator';
+import { EnvironmentCommand } from '@novu/application-generic';
+
+export class GetSubscriberByExternalIdCommand extends EnvironmentCommand {
+  @IsDefined()
+  @IsString()
+  readonly externalSubscriberId: string;
+
+  @IsOptional()
+  @IsBoolean()
+  readonly includePreferences?: boolean = false;
+
+  @IsOptional()
+  @IsBoolean()
+  readonly includeTopics?: boolean = false;
+
+  @IsOptional()
+  @IsBoolean()
+  readonly useCache?: boolean = true;
+
+  static forProfile(input: {
+    organizationId: string;
+    environmentId: string;
+    externalSubscriberId: string;
+    includePreferences?: boolean;
+    includeTopics?: boolean;
+  }) {
+    return GetSubscriberByExternalIdCommand.create({
+      organizationId: input.organizationId,
+      environmentId: input.environmentId,
+      externalSubscriberId: input.externalSubscriberId,
+      includePreferences: input.includePreferences ?? true,
+      includeTopics: input.includeTopics ?? false,
+      useCache: true,
+    });
+  }
+
+  static forPreferenceCenter(input: {
+    organizationId: string;
+    environmentId: string;
+    externalSubscriberId: string;
+  }) {
+    return GetSubscriberByExternalIdCommand.create({
+      organizationId: input.organizationId,
+      environmentId: input.environmentId,
+      externalSubscriberId: input.externalSubscriberId,
+      includePreferences: true,
+      includeTopics: false,
+      useCache: true,
+    });
+  }
+}
+
+export type ExternalSubscriberProfileDto = {
+  _id: string;
+  subscriberId: string;
+  email?: string;
+  phone?: string;
+  firstName?: string;
+  lastName?: string;
+  avatar?: string;
+  locale?: string;
+  timezone?: string;
+  data?: Record<string, unknown>;
+  preferences?: {
+    enabled: boolean;
+    channels: Record<string, { enabled?: boolean }>;
+    updatedAt?: string;
+  };
+  topics?: string[];
+};
+
+export type ExternalSubscriberCachePayload = {
+  subscriber: ExternalSubscriberProfileDto;
+  cachedAt: string;
+  expiresAt: string;
+};
+
+export function normalizeExternalSubscriberId(value: string): string {
+  return value.trim();
+}
+
+export function assertExternalSubscriberId(value: string) {
+  if (!normalizeExternalSubscriberId(value)) {
+    throw new Error('externalSubscriberId is required');
+  }
+}
diff --git a/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.ts b/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.ts
new file mode 100644
index 0000000000..52fc7ef534
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.ts
@@ -0,0 +1,190 @@
+import { Injectable, NotFoundException } from '@nestjs/common';
+import { CacheService, GetPreferences, InstrumentUsecase } from '@novu/application-generic';
+import {
+  PreferencesEntity,
+  PreferencesRepository,
+  SubscriberEntity,
+  SubscriberRepository,
+  TopicSubscribersRepository,
+} from '@novu/dal';
+import { PreferenceLevelEnum, PreferencesTypeEnum } from '@novu/shared';
+import {
+  ExternalSubscriberCachePayload,
+  ExternalSubscriberProfileDto,
+  GetSubscriberByExternalIdCommand,
+  normalizeExternalSubscriberId,
+} from './get-subscriber-by-external-id.command';
+
+const EXTERNAL_SUBSCRIBER_CACHE_TTL_SECONDS = 60;
+
+@Injectable()
+export class GetSubscriberByExternalId {
+  constructor(
+    private subscriberRepository: SubscriberRepository,
+    private preferencesRepository: PreferencesRepository,
+    private topicSubscribersRepository: TopicSubscribersRepository,
+    private cacheService: CacheService
+  ) {}
+
+  @InstrumentUsecase()
+  async execute(command: GetSubscriberByExternalIdCommand): Promise<ExternalSubscriberProfileDto> {
+    const externalSubscriberId = normalizeExternalSubscriberId(command.externalSubscriberId);
+    const cacheKey = this.buildCacheKey(externalSubscriberId);
+
+    if (command.useCache !== false) {
+      const cached = await this.cacheService.get<ExternalSubscriberCachePayload>(cacheKey);
+      if (cached?.subscriber) {
+        return cached.subscriber;
+      }
+    }
+
+    const subscriber = await this.subscriberRepository.findByExternalSubscriberId(externalSubscriberId);
+    if (!subscriber) {
+      throw new NotFoundException(`Subscriber '${externalSubscriberId}' was not found`);
+    }
+
+    const [globalPreference, topics] = await Promise.all([
+      command.includePreferences ? this.fetchGlobalPreference(command, subscriber) : Promise.resolve(undefined),
+      command.includeTopics ? this.fetchTopics(command, subscriber) : Promise.resolve(undefined),
+    ]);
+
+    const response = this.toProfile(subscriber, globalPreference, topics);
+
+    if (command.useCache !== false) {
+      await this.cacheService.set(
+        cacheKey,
+        {
+          subscriber: response,
+          cachedAt: new Date().toISOString(),
+          expiresAt: new Date(Date.now() + EXTERNAL_SUBSCRIBER_CACHE_TTL_SECONDS * 1000).toISOString(),
+        },
+        EXTERNAL_SUBSCRIBER_CACHE_TTL_SECONDS
+      );
+    }
+
+    return response;
+  }
+
+  private buildCacheKey(externalSubscriberId: string): string {
+    return `external-subscriber:${externalSubscriberId}`;
+  }
+
+  private async fetchGlobalPreference(
+    command: GetSubscriberByExternalIdCommand,
+    subscriber: SubscriberEntity
+  ): Promise<PreferencesEntity | undefined> {
+    return await this.preferencesRepository.findOne({
+      _environmentId: command.environmentId,
+      _organizationId: command.organizationId,
+      _subscriberId: subscriber._id,
+      type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+    });
+  }
+
+  private async fetchTopics(
+    command: GetSubscriberByExternalIdCommand,
+    subscriber: SubscriberEntity
+  ): Promise<string[]> {
+    return await this.topicSubscribersRepository._model.distinct('topicKey', {
+      _environmentId: command.environmentId,
+      _subscriberId: subscriber._id,
+    });
+  }
+
+  private toProfile(
+    subscriber: SubscriberEntity,
+    preference?: PreferencesEntity,
+    topics?: string[]
+  ): ExternalSubscriberProfileDto {
+    const channels = preference
+      ? GetPreferences.mapWorkflowPreferencesToChannelPreferences(preference.preferences || {})
+      : {};
+    const enabled = preference?.preferences?.all?.enabled ?? true;
+
+    return {
+      _id: subscriber._id,
+      subscriberId: subscriber.subscriberId,
+      email: subscriber.email,
+      phone: subscriber.phone,
+      firstName: subscriber.firstName,
+      lastName: subscriber.lastName,
+      avatar: subscriber.avatar,
+      locale: subscriber.locale,
+      timezone: subscriber.timezone,
+      data: subscriber.data,
+      ...(preference && {
+        preferences: {
+          enabled,
+          channels,
+          updatedAt: preference.updatedAt,
+        },
+      }),
+      ...(topics && { topics }),
+    };
+  }
+}
diff --git a/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.command.ts b/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.command.ts
new file mode 100644
index 0000000000..d39ab97575
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.command.ts
@@ -0,0 +1,130 @@
+import { Type } from 'class-transformer';
+import { IsBoolean, IsDefined, IsEnum, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
+import { EnvironmentWithUserCommand } from '@novu/application-generic';
+import { ChannelTypeEnum, IPreferenceChannels, PreferenceLevelEnum, Schedule } from '@novu/shared';
+
+export enum PreferenceWriteSourceEnum {
+  DASHBOARD = 'dashboard',
+  API = 'api',
+  INBOX = 'inbox',
+  PREFERENCE_CENTER = 'preference_center',
+}
+
+export class ExternalSubscriberChannelPreference {
+  @IsDefined()
+  @IsEnum(ChannelTypeEnum)
+  readonly type: ChannelTypeEnum;
+
+  @IsDefined()
+  @IsBoolean()
+  readonly enabled: boolean;
+}
+
+export class ExternalSubscriberAllPreference {
+  @IsOptional()
+  @IsBoolean()
+  readonly enabled?: boolean;
+
+  @IsOptional()
+  @IsObject()
+  readonly condition?: unknown;
+}
+
+export class UpdateExternalSubscriberPreferencesCommand extends EnvironmentWithUserCommand {
+  @IsDefined()
+  @IsString()
+  readonly externalSubscriberId: string;
+
+  @IsOptional()
+  @IsEnum(PreferenceLevelEnum)
+  readonly level?: PreferenceLevelEnum = PreferenceLevelEnum.GLOBAL;
+
+  @IsOptional()
+  @IsString()
+  readonly workflowIdOrIdentifier?: string;
+
+  @IsOptional()
+  @IsString()
+  readonly subscriptionIdentifier?: string;
+
+  @IsOptional()
+  @ValidateNested()
+  @Type(() => ExternalSubscriberChannelPreference)
+  readonly channel?: ExternalSubscriberChannelPreference;
+
+  @IsOptional()
+  @IsObject()
+  readonly channels?: IPreferenceChannels;
+
+  @IsOptional()
+  @ValidateNested()
+  @Type(() => ExternalSubscriberAllPreference)
+  readonly all?: ExternalSubscriberAllPreference;
+
+  @IsOptional()
+  readonly schedule?: Schedule;
+
+  @IsOptional()
+  @IsEnum(PreferenceWriteSourceEnum)
+  readonly source?: PreferenceWriteSourceEnum = PreferenceWriteSourceEnum.API;
+
+  @IsOptional()
+  @IsString()
+  readonly requestId?: string;
+}
+
+export type ExternalSubscriberPreferenceResult = {
+  subscriberId: string;
+  preference: {
+    enabled: boolean;
+    channels: Record<string, { enabled?: boolean }>;
+  };
+  audit: {
+    id: string;
+    actorType: string;
+    actorId: string;
+    source: PreferenceWriteSourceEnum;
+  };
+};
+
+export function toPreferenceChannelPatch(command: UpdateExternalSubscriberPreferencesCommand) {
+  return {
+    ...command.channels,
+    ...(command.channel && { [command.channel.type]: command.channel.enabled }),
+  };
+}
+
+export function describePreferenceWrite(command: UpdateExternalSubscriberPreferencesCommand) {
+  return {
+    environmentId: command.environmentId,
+    organizationId: command.organizationId,
+    externalSubscriberId: command.externalSubscriberId,
+    level: command.level ?? PreferenceLevelEnum.GLOBAL,
+    workflowIdOrIdentifier: command.workflowIdOrIdentifier,
+    subscriptionIdentifier: command.subscriptionIdentifier,
+    source: command.source ?? PreferenceWriteSourceEnum.API,
+    requestId: command.requestId,
+  };
+}
+
+export function shouldSendPreferenceWebhook(command: UpdateExternalSubscriberPreferencesCommand) {
+  return command.source !== PreferenceWriteSourceEnum.DASHBOARD;
+}
diff --git a/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.ts b/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.ts
new file mode 100644
index 0000000000..db1a74f7da
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.ts
@@ -0,0 +1,228 @@
+import { Injectable, NotFoundException } from '@nestjs/common';
+import {
+  GetPreferences,
+  Instrument,
+  InstrumentUsecase,
+  SendWebhookMessage,
+  UpsertPreferences,
+  UpsertSubscriberGlobalPreferencesCommand,
+  UpsertSubscriberWorkflowPreferencesCommand,
+} from '@novu/application-generic';
+import {
+  PreferenceAuditRepository,
+  PreferencesEntity,
+  PreferencesRepository,
+  SubscriberEntity,
+  SubscriberRepository,
+} from '@novu/dal';
+import {
+  ChannelTypeEnum,
+  PreferenceLevelEnum,
+  PreferencesTypeEnum,
+  WebhookEventEnum,
+  WebhookObjectTypeEnum,
+  WorkflowPreferencesPartial,
+} from '@novu/shared';
+import {
+  ExternalSubscriberPreferenceResult,
+  PreferenceWriteSourceEnum,
+  shouldSendPreferenceWebhook,
+  toPreferenceChannelPatch,
+  UpdateExternalSubscriberPreferencesCommand,
+} from './update-external-subscriber-preferences.command';
+
+@Injectable()
+export class UpdateExternalSubscriberPreferences {
+  constructor(
+    private subscriberRepository: SubscriberRepository,
+    private preferencesRepository: PreferencesRepository,
+    private upsertPreferences: UpsertPreferences,
+    private preferenceAuditRepository: PreferenceAuditRepository,
+    private sendWebhookMessage: SendWebhookMessage
+  ) {}
+
+  @InstrumentUsecase()
+  async execute(command: UpdateExternalSubscriberPreferencesCommand): Promise<ExternalSubscriberPreferenceResult> {
+    const subscriber = await this.resolveSubscriber(command);
+    const preferencePatch = this.buildPreferencePatch(command);
+
+    await this.writePreference(command, subscriber, preferencePatch);
+    const preference = await this.fetchUpdatedPreference(command, subscriber);
+    const audit = await this.recordAudit(command, subscriber, preference);
+
+    if (shouldSendPreferenceWebhook(command)) {
+      await this.sendWebhookMessage.execute({
+        eventType: WebhookEventEnum.PREFERENCE_UPDATED,
+        objectType: WebhookObjectTypeEnum.PREFERENCE,
+        organizationId: command.organizationId,
+        environmentId: command.environmentId,
+        payload: {
+          object: {
+            subscriberId: subscriber.subscriberId,
+            level: command.level ?? PreferenceLevelEnum.GLOBAL,
+            preferences: preference.preferences,
+            source: command.source ?? PreferenceWriteSourceEnum.API,
+          },
+          subscriberId: subscriber.subscriberId,
+        },
+      });
+    }
+
+    return {
+      subscriberId: subscriber.subscriberId,
+      preference: {
+        enabled: preference.preferences?.all?.enabled ?? true,
+        channels: GetPreferences.mapWorkflowPreferencesToChannelPreferences(preference.preferences || {}),
+      },
+      audit: {
+        id: audit._id,
+        actorType: audit.actorType,
+        actorId: audit.actorId,
+        source: audit.source,
+      },
+    };
+  }
+
+  private async resolveSubscriber(command: UpdateExternalSubscriberPreferencesCommand): Promise<SubscriberEntity> {
+    const subscriber = await this.subscriberRepository.findByExternalSubscriberId(command.externalSubscriberId);
+    if (!subscriber) {
+      throw new NotFoundException(`Subscriber '${command.externalSubscriberId}' was not found`);
+    }
+
+    return subscriber;
+  }
+
+  private buildPreferencePatch(command: UpdateExternalSubscriberPreferencesCommand): WorkflowPreferencesPartial {
+    const channelPatch = toPreferenceChannelPatch(command);
+    const channels = Object.entries(channelPatch).reduce((acc, [channel, enabled]) => {
+      acc[channel as ChannelTypeEnum] = { enabled };
+      return acc;
+    }, {} as WorkflowPreferencesPartial['channels']);
+
+    return {
+      ...(command.all && {
+        all: {
+          ...(command.all.enabled !== undefined && { enabled: command.all.enabled }),
+          ...(command.all.condition !== undefined && { condition: command.all.condition }),
+        },
+      }),
+      ...(channels && Object.keys(channels).length > 0 && { channels }),
+    };
+  }
+
+  @Instrument()
+  private async writePreference(
+    command: UpdateExternalSubscriberPreferencesCommand,
+    subscriber: SubscriberEntity,
+    preferences: WorkflowPreferencesPartial
+  ) {
+    if (command.level === PreferenceLevelEnum.TEMPLATE && command.workflowIdOrIdentifier) {
+      await this.upsertPreferences.upsertSubscriberWorkflowPreferences(
+        UpsertSubscriberWorkflowPreferencesCommand.create({
+          organizationId: command.organizationId,
+          environmentId: command.environmentId,
+          _subscriberId: subscriber._id,
+          templateId: command.workflowIdOrIdentifier,
+          preferences,
+          returnPreference: false,
+        })
+      );
+      return;
+    }
+
+    await this.upsertPreferences.upsertSubscriberGlobalPreferences(
+      UpsertSubscriberGlobalPreferencesCommand.create({
+        organizationId: command.organizationId,
+        environmentId: command.environmentId,
+        _subscriberId: subscriber._id,
+        preferences,
+        schedule: command.schedule,
+        returnPreference: false,
+      })
+    );
+  }
+
+  private async fetchUpdatedPreference(
+    command: UpdateExternalSubscriberPreferencesCommand,
+    subscriber: SubscriberEntity
+  ): Promise<PreferencesEntity> {
+    const type =
+      command.level === PreferenceLevelEnum.TEMPLATE
+        ? PreferencesTypeEnum.SUBSCRIBER_WORKFLOW
+        : PreferencesTypeEnum.SUBSCRIBER_GLOBAL;
+
+    const preference = await this.preferencesRepository.findOne({
+      _environmentId: command.environmentId,
+      _organizationId: command.organizationId,
+      _subscriberId: subscriber._id,
+      ...(command.workflowIdOrIdentifier && { _templateId: command.workflowIdOrIdentifier }),
+      type,
+    });
+
+    if (!preference) {
+      throw new NotFoundException('Preference was not stored');
+    }
+
+    return preference;
+  }
+
+  private async recordAudit(
+    command: UpdateExternalSubscriberPreferencesCommand,
+    subscriber: SubscriberEntity,
+    preference: PreferencesEntity
+  ) {
+    return await this.preferenceAuditRepository.create({
+      _environmentId: command.environmentId,
+      _organizationId: command.organizationId,
+      _subscriberId: subscriber._id,
+      _preferenceId: preference._id,
+      externalSubscriberId: subscriber.subscriberId,
+      actorType: 'dashboard_user',
+      actorId: command.userId,
+      source: command.source ?? PreferenceWriteSourceEnum.API,
+      requestId: command.requestId,
+      changes: {
+        all: command.all,
+        channel: command.channel,
+      },
+    });
+  }
+}
diff --git a/apps/api/src/app/subscribers/subscribersV1.controller.ts b/apps/api/src/app/subscribers/subscribersV1.controller.ts
index 4d6989a8d0..d40f7ed227 100644
--- a/apps/api/src/app/subscribers/subscribersV1.controller.ts
+++ b/apps/api/src/app/subscribers/subscribersV1.controller.ts
@@ -82,6 +82,22 @@ import { GetSubscriberPreferencesByLevelParams } from './params';
 import { BulkCreateSubscribersCommand } from './usecases/bulk-create-subscribers';
 import { BulkCreateSubscribers } from './usecases/bulk-create-subscribers/bulk-create-subscribers.usecase';
 import { ChatOauthCommand } from './usecases/chat-oauth/chat-oauth.command';
+import {
+  ExternalSubscriberProfileDto,
+  GetSubscriberByExternalIdCommand,
+} from './usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.command';
+import {
+  GetSubscriberByExternalId,
+} from './usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase';
+import {
+  ExternalSubscriberPreferenceResult,
+  PreferenceWriteSourceEnum,
+  UpdateExternalSubscriberPreferencesCommand,
+} from './usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.command';
+import {
+  UpdateExternalSubscriberPreferences,
+} from './usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase';
 import { ChatOauth } from './usecases/chat-oauth/chat-oauth.usecase';
 import { ChatOauthCallbackCommand } from './usecases/chat-oauth-callback/chat-oauth-callback.command';
 import { ResponseTypeEnum } from './usecases/chat-oauth-callback/chat-oauth-callback.result';
@@ -116,7 +132,9 @@ export class SubscribersV1Controller {
     private chatOauthCallbackUsecase: ChatOauthCallback,
     private chatOauthUsecase: ChatOauth,
     private deleteSubscriberCredentialsUsecase: DeleteSubscriberCredentials,
-    private markAllMessagesAsUsecase: MarkAllMessagesAs
+    private markAllMessagesAsUsecase: MarkAllMessagesAs,
+    private getSubscriberByExternalIdUsecase: GetSubscriberByExternalId,
+    private updateExternalSubscriberPreferencesUsecase: UpdateExternalSubscriberPreferences
   ) {}
 
   @Get('')
@@ -199,6 +217,103 @@ export class SubscribersV1Controller {
     );
   }
 
+  @Get('/external/:externalSubscriberId')
+  @ExternalApiAccessible()
+  @RequireAuthentication()
+  @ApiExcludeEndpoint()
+  @ApiOperation({
+    summary: 'Retrieve a subscriber by external subscriber id',
+    description: `Retrieve a subscriber by the customer-facing subscriber identifier. 
+      This endpoint is intended for preference-center integrations that do not know Novu internal IDs.`,
+  })
+  async getExternalSubscriber(
+    @UserSession() user: UserSessionData,
+    @Param('externalSubscriberId') externalSubscriberId: string,
+    @Query('includePreferences') includePreferences?: string,
+    @Query('includeTopics') includeTopics?: string
+  ): Promise<ExternalSubscriberProfileDto> {
+    return await this.getSubscriberByExternalIdUsecase.execute(
+      GetSubscriberByExternalIdCommand.create({
+        organizationId: user.organizationId,
+        environmentId: user.environmentId,
+        externalSubscriberId,
+        includePreferences: includePreferences !== 'false',
+        includeTopics: includeTopics === 'true',
+      })
+    );
+  }
+
+  @Patch('/external/:externalSubscriberId/preferences')
+  @ExternalApiAccessible()
+  @RequireAuthentication()
+  @ApiExcludeEndpoint()
+  @ApiOperation({
+    summary: 'Update subscriber preferences by external subscriber id',
+    description: `Update a subscriber's global preferences by the customer-facing subscriber identifier.
+      The endpoint is used by hosted preference centers and server-side customer preference pages.`,
+  })
+  async updateExternalSubscriberGlobalPreferences(
+    @UserSession() user: UserSessionData,
+    @Param('externalSubscriberId') externalSubscriberId: string,
+    @Body() body: UpdateSubscriberGlobalPreferencesRequestDto
+  ): Promise<ExternalSubscriberPreferenceResult> {
+    const channels = body.preferences?.reduce((acc, curr) => {
+      acc[curr.type] = curr.enabled;
+      return acc;
+    }, {} as IPreferenceChannels);
+
+    return await this.updateExternalSubscriberPreferencesUsecase.execute(
+      UpdateExternalSubscriberPreferencesCommand.create({
+        organizationId: user.organizationId,
+        environmentId: user.environmentId,
+        userId: user._id,
+        externalSubscriberId,
+        level: PreferenceLevelEnum.GLOBAL,
+        source: PreferenceWriteSourceEnum.PREFERENCE_CENTER,
+        channels,
+      })
+    );
+  }
+
+  @Patch('/external/:externalSubscriberId/preferences/:workflowId')
+  @ExternalApiAccessible()
+  @RequireAuthentication()
+  @ApiExcludeEndpoint()
+  @ApiOperation({
+    summary: 'Update workflow preferences by external subscriber id',
+    description: `Update a subscriber's workflow preferences by external subscriber id.`,
+  })
+  async updateExternalSubscriberWorkflowPreferences(
+    @UserSession() user: UserSessionData,
+    @Param('externalSubscriberId') externalSubscriberId: string,
+    @Param('workflowId') workflowId: string,
+    @Body() body: UpdateSubscriberPreferenceRequestDto
+  ): Promise<ExternalSubscriberPreferenceResult> {
+    return await this.updateExternalSubscriberPreferencesUsecase.execute(
+      UpdateExternalSubscriberPreferencesCommand.create({
+        organizationId: user.organizationId,
+        environmentId: user.environmentId,
+        userId: user._id,
+        externalSubscriberId,
+        workflowIdOrIdentifier: workflowId,
+        level: PreferenceLevelEnum.TEMPLATE,
+        source: PreferenceWriteSourceEnum.PREFERENCE_CENTER,
+        ...(body.channel && {
+          channel: {
+            type: body.channel.type,
+            enabled: body.channel.enabled,
+          },
+        }),
+      })
+    );
+  }
+
   @Post('/')
   @ExternalApiAccessible()
   @ApiExcludeEndpoint()
diff --git a/libs/dal/src/repositories/subscriber/subscriber.repository.ts b/libs/dal/src/repositories/subscriber/subscriber.repository.ts
index 786fa5c9cd..ced5e90ad5 100644
--- a/libs/dal/src/repositories/subscriber/subscriber.repository.ts
+++ b/libs/dal/src/repositories/subscriber/subscriber.repository.ts
@@ -20,6 +20,52 @@ export class SubscriberRepository extends BaseRepository<SubscriberDBModel, Subsc
     );
   }
 
+  async findByExternalSubscriberId(
+    externalSubscriberId: string,
+    secondaryRead = false,
+    select?: string
+  ): Promise<SubscriberEntity | null> {
+    return await this.findOne(
+      {
+        subscriberId: externalSubscriberId,
+      },
+      select,
+      { readPreference: secondaryRead ? 'secondaryPreferred' : 'primary' }
+    );
+  }
+
   async bulkCreateSubscribers(
     subscribers: ISubscribersDefine[],
     environmentId: EnvironmentId,
@@ -87,6 +133,33 @@ export class SubscriberRepository extends BaseRepository<SubscriberDBModel, Subsc
     });
   }
 
   async searchSubscribers(
     environmentId: string,
     subscriberIds: string[] = [],
diff --git a/libs/dal/src/repositories/preferences/preference-audit.entity.ts b/libs/dal/src/repositories/preferences/preference-audit.entity.ts
new file mode 100644
index 0000000000..70a474cdcb
--- /dev/null
+++ b/libs/dal/src/repositories/preferences/preference-audit.entity.ts
@@ -0,0 +1,98 @@
+import type { ChangePropsValueType } from '../../types';
+import type { EnvironmentId } from '../environment';
+import type { OrganizationId } from '../organization';
+import type { SubscriberId } from '../subscriber';
+import { PreferenceWriteSourceEnum } from '../../../apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.command';
+
+export type PreferenceAuditDBModel = ChangePropsValueType<
+  PreferenceAuditEntity,
+  '_environmentId' | '_organizationId' | '_subscriberId' | '_preferenceId'
+>;
+
+export class PreferenceAuditEntity {
+  _id: string;
+
+  _environmentId: EnvironmentId;
+
+  _organizationId: OrganizationId;
+
+  _subscriberId: SubscriberId;
+
+  _preferenceId: string;
+
+  externalSubscriberId: string;
+
+  actorType: string;
+
+  actorId: string;
+
+  source: PreferenceWriteSourceEnum;
+
+  requestId?: string;
+
+  changes: {
+    all?: {
+      enabled?: boolean;
+      condition?: unknown;
+    };
+    channel?: {
+      type: string;
+      enabled: boolean;
+    };
+  };
+
+  createdAt?: string;
+
+  updatedAt?: string;
+}
+
+export enum PreferenceAuditActorType {
+  DASHBOARD_USER = 'dashboard_user',
+  API_KEY = 'api_key',
+  SUBSCRIBER = 'subscriber',
+  SYSTEM = 'system',
+}
+
+export type PreferenceAuditCreateInput = Pick<
+  PreferenceAuditEntity,
+  | '_environmentId'
+  | '_organizationId'
+  | '_subscriberId'
+  | '_preferenceId'
+  | 'externalSubscriberId'
+  | 'actorType'
+  | 'actorId'
+  | 'source'
+  | 'requestId'
+  | 'changes'
+>;
+
+export function isSubscriberPreferenceAudit(entity: PreferenceAuditEntity) {
+  return entity.actorType === PreferenceAuditActorType.SUBSCRIBER;
+}
diff --git a/libs/dal/src/repositories/preferences/preference-audit.repository.ts b/libs/dal/src/repositories/preferences/preference-audit.repository.ts
new file mode 100644
index 0000000000..32b86b476d
--- /dev/null
+++ b/libs/dal/src/repositories/preferences/preference-audit.repository.ts
@@ -0,0 +1,182 @@
+import mongoose, { Schema } from 'mongoose';
+import { FilterQuery } from 'mongoose';
+import { BaseRepository } from '../base-repository';
+import type { EnforceEnvOrOrgIds } from '../../types/enforce';
+import {
+  PreferenceAuditActorType,
+  PreferenceAuditDBModel,
+  PreferenceAuditEntity,
+  PreferenceAuditCreateInput,
+} from './preference-audit.entity';
+
+const preferenceAuditSchema = new Schema<PreferenceAuditDBModel>(
+  {
+    _environmentId: {
+      type: Schema.Types.ObjectId,
+      ref: 'Environment',
+      required: true,
+    },
+    _organizationId: {
+      type: Schema.Types.ObjectId,
+      ref: 'Organization',
+      required: true,
+    },
+    _subscriberId: {
+      type: Schema.Types.ObjectId,
+      ref: 'Subscriber',
+      required: true,
+    },
+    _preferenceId: {
+      type: Schema.Types.ObjectId,
+      ref: 'Preferences',
+      required: true,
+    },
+    externalSubscriberId: {
+      type: Schema.Types.String,
+      required: true,
+    },
+    actorType: {
+      type: Schema.Types.String,
+      enum: Object.values(PreferenceAuditActorType),
+      required: true,
+    },
+    actorId: {
+      type: Schema.Types.String,
+      required: true,
+    },
+    source: {
+      type: Schema.Types.String,
+      required: true,
+    },
+    requestId: {
+      type: Schema.Types.String,
+      required: false,
+    },
+    changes: {
+      type: Schema.Types.Mixed,
+      required: true,
+    },
+  },
+  {
+    timestamps: true,
+    minimize: false,
+  }
+);
+
+preferenceAuditSchema.index({
+  _environmentId: 1,
+  _subscriberId: 1,
+  createdAt: -1,
+});
+
+preferenceAuditSchema.index({
+  _organizationId: 1,
+  externalSubscriberId: 1,
+  createdAt: -1,
+});
+
+preferenceAuditSchema.index({
+  actorType: 1,
+  actorId: 1,
+  createdAt: -1,
+});
+
+export const PreferenceAudit =
+  (mongoose.models.PreferenceAudit as mongoose.Model<PreferenceAuditDBModel>) ||
+  mongoose.model<PreferenceAuditDBModel>('PreferenceAudit', preferenceAuditSchema);
+
+type PreferenceAuditQuery = FilterQuery<PreferenceAuditDBModel> & EnforceEnvOrOrgIds;
+
+export class PreferenceAuditRepository extends BaseRepository<
+  PreferenceAuditDBModel,
+  PreferenceAuditEntity,
+  EnforceEnvOrOrgIds
+> {
+  constructor() {
+    super(PreferenceAudit, PreferenceAuditEntity);
+  }
+
+  async append(input: PreferenceAuditCreateInput): Promise<PreferenceAuditEntity> {
+    return await this.create(input);
+  }
+
+  async listForSubscriber(input: {
+    environmentId: string;
+    organizationId: string;
+    externalSubscriberId: string;
+    limit?: number;
+  }): Promise<PreferenceAuditEntity[]> {
+    return await this.find(
+      {
+        _environmentId: input.environmentId,
+        _organizationId: input.organizationId,
+        externalSubscriberId: input.externalSubscriberId,
+      },
+      undefined,
+      {
+        sort: { createdAt: -1 },
+        limit: input.limit ?? 25,
+      }
+    );
+  }
+
+  async listForActor(input: {
+    environmentId: string;
+    organizationId: string;
+    actorType: PreferenceAuditActorType;
+    actorId: string;
+    limit?: number;
+  }): Promise<PreferenceAuditEntity[]> {
+    const query: PreferenceAuditQuery = {
+      _environmentId: input.environmentId,
+      _organizationId: input.organizationId,
+      actorType: input.actorType,
+      actorId: input.actorId,
+    };
+
+    return await this.find(query, undefined, {
+      sort: { createdAt: -1 },
+      limit: input.limit ?? 50,
+    });
+  }
+
+  async lastPreferenceChange(input: {
+    environmentId: string;
+    organizationId: string;
+    subscriberId: string;
+  }): Promise<PreferenceAuditEntity | null> {
+    const rows = await this.find(
+      {
+        _environmentId: input.environmentId,
+        _organizationId: input.organizationId,
+        _subscriberId: input.subscriberId,
+      },
+      undefined,
+      {
+        sort: { createdAt: -1 },
+        limit: 1,
+      }
+    );
+
+    return rows[0] ?? null;
+  }
+}
diff --git a/packages/js/src/subscribers/external-id.ts b/packages/js/src/subscribers/external-id.ts
new file mode 100644
index 0000000000..d7a8e2eadd
--- /dev/null
+++ b/packages/js/src/subscribers/external-id.ts
@@ -0,0 +1,168 @@
+import { ChannelTypeEnum } from '@novu/shared';
+import type { NovuOptions } from '../novu';
+
+type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
+
+export type ExternalSubscriberProfile = {
+  _id: string;
+  subscriberId: string;
+  email?: string;
+  phone?: string;
+  firstName?: string;
+  lastName?: string;
+  avatar?: string;
+  locale?: string;
+  timezone?: string;
+  data?: Record<string, unknown>;
+  preferences?: {
+    enabled: boolean;
+    channels: Record<string, { enabled?: boolean }>;
+    updatedAt?: string;
+  };
+  topics?: string[];
+};
+
+export type UpdateExternalSubscriberPreferencesRequest = {
+  all?: {
+    enabled?: boolean;
+    condition?: unknown;
+  };
+  channel?: {
+    type: ChannelTypeEnum;
+    enabled: boolean;
+  };
+  preferences?: Array<{
+    type: ChannelTypeEnum;
+    enabled: boolean;
+  }>;
+};
+
+export class ExternalSubscriberClient {
+  private fetcher: Fetcher;
+  private options: NovuOptions;
+
+  constructor(options: NovuOptions, fetcher: Fetcher) {
+    this.options = options;
+    this.fetcher = fetcher;
+  }
+
+  async get(externalSubscriberId: string, options?: { includePreferences?: boolean; includeTopics?: boolean }) {
+    const params = new URLSearchParams();
+    if (options?.includePreferences !== undefined) {
+      params.set('includePreferences', String(options.includePreferences));
+    }
+    if (options?.includeTopics !== undefined) {
+      params.set('includeTopics', String(options.includeTopics));
+    }
+
+    const suffix = params.toString() ? `?${params.toString()}` : '';
+    const response = await this.fetcher(`/subscribers/external/${encodeURIComponent(externalSubscriberId)}${suffix}`, {
+      method: 'GET',
+    });
+
+    return this.handleResponse<ExternalSubscriberProfile>(response);
+  }
+
+  async getPreferencePreview(externalSubscriberId: string) {
+    const response = await this.fetcher(
+      `/subscribers/external/${encodeURIComponent(externalSubscriberId)}/preferences/preview`,
+      {
+        method: 'GET',
+      }
+    );
+
+    return this.handleResponse<{
+      subscriberId: string;
+      email?: string;
+      preferences?: ExternalSubscriberProfile['preferences'];
+      canEdit: boolean;
+    }>(response);
+  }
+
+  async updateGlobalPreferences(
+    externalSubscriberId: string,
+    body: UpdateExternalSubscriberPreferencesRequest
+  ) {
+    const response = await this.fetcher(
+      `/subscribers/external/${encodeURIComponent(externalSubscriberId)}/preferences`,
+      {
+        method: 'PATCH',
+        headers: {
+          'Content-Type': 'application/json',
+        },
+        body: JSON.stringify(body),
+      }
+    );
+
+    return this.handleResponse(response);
+  }
+
+  async updateWorkflowPreferences(
+    externalSubscriberId: string,
+    workflowId: string,
+    body: UpdateExternalSubscriberPreferencesRequest
+  ) {
+    const response = await this.fetcher(
+      `/subscribers/external/${encodeURIComponent(externalSubscriberId)}/preferences/${encodeURIComponent(workflowId)}`,
+      {
+        method: 'PATCH',
+        headers: {
+          'Content-Type': 'application/json',
+        },
+        body: JSON.stringify(body),
+      }
+    );
+
+    return this.handleResponse(response);
+  }
+
+  async disableAll(externalSubscriberId: string) {
+    const response = await this.fetcher(
+      `/subscribers/external/${encodeURIComponent(externalSubscriberId)}/preferences/disable-all`,
+      {
+        method: 'POST',
+      }
+    );
+
+    return this.handleResponse(response);
+  }
+
+  private async handleResponse<T = unknown>(response: Response): Promise<T> {
+    if (response.ok) {
+      return (await response.json()) as T;
+    }
+
+    const body = await response.text();
+    throw new Error(`Novu external subscriber request failed: ${response.status} ${body}`);
+  }
+}
+
+export function createExternalSubscriberClient(options: NovuOptions, fetcher: Fetcher) {
+  return new ExternalSubscriberClient(options, fetcher);
+}
+
+export function normalizeExternalSubscriberPath(externalSubscriberId: string) {
+  return encodeURIComponent(externalSubscriberId.trim());
+}
+
+export function isPreferenceCenterWrite(input: UpdateExternalSubscriberPreferencesRequest) {
+  return Boolean(input.all || input.channel || input.preferences?.length);
+}
diff --git a/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.spec.ts b/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.spec.ts
new file mode 100644
index 0000000000..b3b6f09276
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.spec.ts
@@ -0,0 +1,190 @@
+import { GetSubscriberByExternalId } from './get-subscriber-by-external-id.usecase';
+import { GetSubscriberByExternalIdCommand } from './get-subscriber-by-external-id.command';
+import { PreferencesTypeEnum } from '@novu/shared';
+
+describe('GetSubscriberByExternalId', () => {
+  const subscriberRepository = {
+    findByExternalSubscriberId: jest.fn(),
+  };
+  const preferencesRepository = {
+    findOne: jest.fn(),
+  };
+  const topicSubscribersRepository = {
+    _model: {
+      distinct: jest.fn(),
+    },
+  };
+  const cacheService = {
+    get: jest.fn(),
+    set: jest.fn(),
+  };
+
+  const usecase = new GetSubscriberByExternalId(
+    subscriberRepository as any,
+    preferencesRepository as any,
+    topicSubscribersRepository as any,
+    cacheService as any
+  );
+
+  beforeEach(() => {
+    jest.clearAllMocks();
+  });
+
+  it('returns a subscriber profile and global preferences by external id', async () => {
+    subscriberRepository.findByExternalSubscriberId.mockResolvedValue({
+      _id: 'internal-sub-1',
+      _environmentId: 'env-prod',
+      _organizationId: 'org-1',
+      subscriberId: 'user-123',
+      email: 'ada@example.com',
+      firstName: 'Ada',
+      lastName: 'Lovelace',
+      data: { plan: 'pro' },
+    });
+    preferencesRepository.findOne.mockResolvedValue({
+      _id: 'pref-1',
+      _subscriberId: 'internal-sub-1',
+      type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+      preferences: {
+        all: { enabled: true },
+        channels: {
+          email: { enabled: false },
+        },
+      },
+      updatedAt: '2026-01-01T00:00:00.000Z',
+    });
+
+    const result = await usecase.execute(
+      GetSubscriberByExternalIdCommand.create({
+        organizationId: 'org-1',
+        environmentId: 'env-prod',
+        externalSubscriberId: 'user-123',
+        includePreferences: true,
+      })
+    );
+
+    expect(result.subscriberId).toBe('user-123');
+    expect(result.preferences?.channels.email.enabled).toBe(false);
+    expect(subscriberRepository.findByExternalSubscriberId).toHaveBeenCalledWith('user-123');
+    expect(preferencesRepository.findOne).toHaveBeenCalledWith({
+      _environmentId: 'env-prod',
+      _organizationId: 'org-1',
+      _subscriberId: 'internal-sub-1',
+      type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+    });
+  });
+
+  it('caches profile reads by external subscriber id', async () => {
+    subscriberRepository.findByExternalSubscriberId.mockResolvedValue({
+      _id: 'internal-sub-1',
+      _environmentId: 'env-prod',
+      _organizationId: 'org-1',
+      subscriberId: 'user-123',
+    });
+    preferencesRepository.findOne.mockResolvedValue(undefined);
+
+    await usecase.execute(
+      GetSubscriberByExternalIdCommand.create({
+        organizationId: 'org-1',
+        environmentId: 'env-prod',
+        externalSubscriberId: 'user-123',
+        includePreferences: false,
+      })
+    );
+
+    expect(cacheService.set).toHaveBeenCalledWith(
+      'external-subscriber:user-123',
+      expect.objectContaining({
+        subscriber: expect.objectContaining({
+          subscriberId: 'user-123',
+        }),
+      }),
+      60
+    );
+  });
+});
diff --git a/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.spec.ts b/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.spec.ts
new file mode 100644
index 0000000000..c2cc0e1bb5
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.spec.ts
@@ -0,0 +1,190 @@
+import { PreferenceLevelEnum, PreferencesTypeEnum } from '@novu/shared';
+import { UpdateExternalSubscriberPreferences } from './update-external-subscriber-preferences.usecase';
+import {
+  PreferenceWriteSourceEnum,
+  UpdateExternalSubscriberPreferencesCommand,
+} from './update-external-subscriber-preferences.command';
+
+describe('UpdateExternalSubscriberPreferences', () => {
+  const subscriberRepository = {
+    findByExternalSubscriberId: jest.fn(),
+  };
+  const preferencesRepository = {
+    findOne: jest.fn(),
+  };
+  const upsertPreferences = {
+    upsertSubscriberGlobalPreferences: jest.fn(),
+    upsertSubscriberWorkflowPreferences: jest.fn(),
+  };
+  const preferenceAuditRepository = {
+    create: jest.fn(),
+  };
+  const sendWebhookMessage = {
+    execute: jest.fn(),
+  };
+
+  const usecase = new UpdateExternalSubscriberPreferences(
+    subscriberRepository as any,
+    preferencesRepository as any,
+    upsertPreferences as any,
+    preferenceAuditRepository as any,
+    sendWebhookMessage as any
+  );
+
+  beforeEach(() => {
+    jest.clearAllMocks();
+    subscriberRepository.findByExternalSubscriberId.mockResolvedValue({
+      _id: 'internal-sub-1',
+      _environmentId: 'env-prod',
+      _organizationId: 'org-1',
+      subscriberId: 'user-123',
+    });
+    preferencesRepository.findOne.mockResolvedValue({
+      _id: 'pref-1',
+      _subscriberId: 'internal-sub-1',
+      type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+      preferences: {
+        all: { enabled: true },
+        channels: {
+          email: { enabled: false },
+        },
+      },
+    });
+    preferenceAuditRepository.create.mockResolvedValue({
+      _id: 'audit-1',
+      actorType: 'dashboard_user',
+      actorId: 'dashboard-user-1',
+      source: PreferenceWriteSourceEnum.PREFERENCE_CENTER,
+    });
+  });
+
+  it('updates global preferences by external subscriber id', async () => {
+    const result = await usecase.execute(
+      UpdateExternalSubscriberPreferencesCommand.create({
+        organizationId: 'org-1',
+        environmentId: 'env-prod',
+        userId: 'dashboard-user-1',
+        externalSubscriberId: 'user-123',
+        level: PreferenceLevelEnum.GLOBAL,
+        source: PreferenceWriteSourceEnum.PREFERENCE_CENTER,
+        channel: {
+          type: 'email',
+          enabled: false,
+        },
+      })
+    );
+
+    expect(subscriberRepository.findByExternalSubscriberId).toHaveBeenCalledWith('user-123');
+    expect(upsertPreferences.upsertSubscriberGlobalPreferences).toHaveBeenCalledWith(
+      expect.objectContaining({
+        organizationId: 'org-1',
+        environmentId: 'env-prod',
+        _subscriberId: 'internal-sub-1',
+        preferences: {
+          channels: {
+            email: { enabled: false },
+          },
+        },
+      })
+    );
+    expect(result.preference.channels.email.enabled).toBe(false);
+  });
+
+  it('writes an audit event for preference center changes', async () => {
+    await usecase.execute(
+      UpdateExternalSubscriberPreferencesCommand.create({
+        organizationId: 'org-1',
+        environmentId: 'env-prod',
+        userId: 'dashboard-user-1',
+        externalSubscriberId: 'user-123',
+        level: PreferenceLevelEnum.GLOBAL,
+        source: PreferenceWriteSourceEnum.PREFERENCE_CENTER,
+        all: { enabled: false },
+      })
+    );
+
+    expect(preferenceAuditRepository.create).toHaveBeenCalledWith(
+      expect.objectContaining({
+        _environmentId: 'env-prod',
+        _organizationId: 'org-1',
+        _subscriberId: 'internal-sub-1',
+        _preferenceId: 'pref-1',
+        externalSubscriberId: 'user-123',
+        actorType: 'dashboard_user',
+        actorId: 'dashboard-user-1',
+        source: PreferenceWriteSourceEnum.PREFERENCE_CENTER,
+      })
+    );
+  });
+});
```

## Intended Flaws

### Flaw 1: External Subscriber ID Is Treated As Globally Unique

- `type`: `tenant_boundary_leak`
- `location`: `libs/dal/src/repositories/subscriber/subscriber.repository.ts:20-35`, `apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.ts:28-40`, `apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.ts:63-65`, `apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.ts:80-88`, `apps/api/src/app/subscribers/usecases/get-subscriber-by-external-id/get-subscriber-by-external-id.usecase.spec.ts:68-89`
- `learner_prompt`: In Novu, is a customer-facing `subscriberId` unique globally, or only inside an environment?

Expected answer:

- `identify`: The new repository methods look up subscribers by `subscriberId` alone. The read and write use cases pass `organizationId` and `environmentId` through the command, but the actual subscriber lookup ignores both. The profile cache key is also only `external-subscriber:${externalSubscriberId}`, so even a correctly scoped later query could be polluted by another environment's cached profile.
- `impact`: The same external ID can exist in multiple Novu environments. A production preference-center request for `user-123` can return a subscriber from a development environment, another organization, or whichever document Mongo finds first. Preference writes can then update the wrong subscriber's global or workflow preferences. The cache makes the leak sticky across requests and can serve one tenant's subscriber profile to another tenant using the same external ID.
- `fix_direction`: Treat external subscriber ID as a compound identity. The repository should expose `findBySubscriberId(environmentId, subscriberId)` or a new method that requires `_environmentId` and preferably `_organizationId`. Cache keys must include environment and subscriber ID, for example `subscriber:${environmentId}:${externalSubscriberId}` or the existing `buildSubscriberKey` helper. Tests should create the same external subscriber ID in two environments and assert reads, preference fetches, preference writes, and cached responses remain isolated.

Hints:

1. Search for the existing unique index and existing repository lookup for subscribers.
2. Follow the command fields into the actual Mongo query. Passing `environmentId` through a command does not matter if the repository ignores it.
3. The cache key repeats the same mistake as the query: it has the external ID but no environment or organization boundary.

### Flaw 2: Preference Writes Record The Dashboard User As The Actor For Subscriber-Origin Changes

- `type`: `actor_context_mismatch`
- `location`: `apps/api/src/app/subscribers/subscribersV1.controller.ts:241-265`, `apps/api/src/app/subscribers/subscribersV1.controller.ts:277-304`, `apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.ts:151-170`, `libs/dal/src/repositories/preferences/preference-audit.entity.ts:46-63`, `apps/api/src/app/subscribers/usecases/update-external-subscriber-preferences/update-external-subscriber-preferences.usecase.spec.ts:75-105`
- `learner_prompt`: If a customer changes their own notification preferences through a preference center, who should the product record as the actor?

Expected answer:

- `identify`: The endpoint labels writes as `PreferenceWriteSourceEnum.PREFERENCE_CENTER`, but the command only carries `userId` from `@UserSession()`. The audit event always records `actorType: 'dashboard_user'` and `actorId: command.userId`. That means subscriber-origin preference changes are attributed to the dashboard/API-key user that authenticated the request rather than the subscriber whose explicit preference was changed.
- `impact`: Preference audit history becomes misleading. Support, analytics, compliance exports, and webhooks cannot distinguish "subscriber opted out" from "admin or integration changed the subscriber's preference." If support impersonation or hosted preference-center flows are added later, the product cannot answer who made the decision, and automated systems may suppress or re-enable notifications based on the wrong provenance. This also hides abuse: a backend job can change subscriber preferences while audit rows claim a dashboard user did it.
- `fix_direction`: Model actor context separately from authentication context. For subscriber-facing preference-center writes, record `actorType: 'subscriber'`, `actorId: subscriber._id` or the external subscriber ID, and keep the API key/dashboard user as `performedBy`, `authenticatedBy`, or `impersonatedBy` only when relevant. Dashboard admin writes should use an explicit dashboard actor and should be a separate command or include an explicit `actor` object. Tests should cover subscriber self-service, dashboard admin edits, and impersonation/support edits.

Hints:

1. Authentication answers "which credential was allowed to call the API"; actor context answers "who made this product decision."
2. The command source says `PREFERENCE_CENTER`, but the audit row says `dashboard_user`.
3. A good fix is not to drop audit. It is to carry two identities when needed: the subscriber actor and the authenticated service/dashboard actor.

## Expert Debrief

### Product-Level Change

The PR is trying to make Novu easier to integrate into customer-facing preference centers. That is a valuable product direction: application teams usually know their own user IDs, not Novu internal subscriber IDs or preference document IDs.

The hidden risk is that "external ID" sounds globally meaningful, while Novu's data model says it is only meaningful inside an environment. A reviewer should immediately ask what the lookup key really identifies and what boundary it must be paired with.

### Changed Contracts

- Subscriber lookup contract: callers can fetch subscriber profile and preference summary by external subscriber ID.
- Repository contract: a new lookup method claims to resolve external subscriber IDs directly.
- Cache contract: subscriber profile reads become cached behind a new key.
- Preference write contract: callers can mutate subscriber preferences without first resolving the internal subscriber ID themselves.
- Audit/provenance contract: preference changes now emit a durable audit row with an actor and source.
- SDK contract: customer apps receive an external-subscriber facade that hides the internal Novu ID model.

### Failure Modes

- Two environments both contain `subscriberId = "user-123"` and the new route returns whichever document Mongo finds first.
- Production preference-center pages display a development subscriber's profile or preference state.
- A preference write updates the wrong internal subscriber because resolution was not scoped by environment.
- Cache entries created in one environment are returned in another environment because the cache key omits the environment.
- Audit history says a dashboard user changed preferences when the subscriber actually opted out.
- Compliance or support workflows cannot distinguish self-service opt-outs from admin edits.
- Future support impersonation becomes untraceable because the data model has only one actor field.

### Reviewer Thought Process

A strong reviewer would not start with the controller. They would first classify the identifier:

1. What does `subscriberId` mean in this codebase?
2. Where is uniqueness enforced?
3. Do existing lookups use more than the ID?

The schema and repository answer those questions. The unique index is `{ subscriberId, _environmentId }`, and the existing `findBySubscriberId()` requires an environment. That makes the new global repository method suspicious even before reading the rest of the PR.

For the second flaw, the reviewer should separate authentication from product authorship. The API may be authenticated by an API key or dashboard user, but the product event can still be "subscriber changed their own preference." High-quality systems preserve both identities when both matter.

### Better Implementation Direction

For subscriber lookup:

- remove unscoped `findByExternalSubscriberId()` and `findManyByExternalSubscriberIds()`,
- use `findBySubscriberId(environmentId, externalSubscriberId)` or add a method that requires `_environmentId` and `_organizationId`,
- build cache keys with the same compound identity as the database contract,
- include environment and organization checks in profile, topics, preferences, and write resolution,
- add tests with duplicate external subscriber IDs across two environments and two organizations.

For preference writes:

- introduce an explicit actor object in the command, for example `{ type: 'subscriber', subscriberId, externalSubscriberId }`,
- keep authentication context separately as `authenticatedBy` or `performedBy`,
- make dashboard/admin preference edits a deliberate source with a dashboard actor,
- represent support impersonation as subscriber actor plus `impersonatedBy`,
- include actor/source in webhooks and audit rows so downstream consumers can reason about provenance.

## Correctness Verdict Rubric

- Full credit for flaw 1: The answer identifies that external subscriber ID is only environment-scoped, cites the unscoped repository lookup or cache key, explains cross-environment/cross-tenant profile reads and preference writes, and proposes compound environment plus subscriber identity for queries and cache keys.
- Partial credit for flaw 1: The answer says "missing tenant filter" but does not connect it to Novu's actual unique index, cache pollution, or preference writes.
- No credit for flaw 1: The answer focuses on naming, DTO shape, or missing pagination without identifying the identity boundary.

- Full credit for flaw 2: The answer identifies that preference-center writes are attributed to the dashboard/API user instead of the subscriber actor, explains audit/provenance/compliance impact, and proposes separate actor and authenticated-by contexts.
- Partial credit for flaw 2: The answer notices audit rows are confusing but only suggests renaming `dashboard_user` or logging more data.
- No credit for flaw 2: The answer treats `userId` from the session as always the correct actor because it authenticated the request.

## Golden Answer Summary

The PR makes external subscriber ID lookup and preference updates convenient, but it breaks two core contracts. First, `subscriberId` is not global in Novu; it must be paired with the environment, and cache keys must follow the same boundary. Second, preference-center writes need subscriber actor provenance, not just the dashboard/API user that authenticated the request. A correct implementation would resolve subscribers by compound environment identity and model preference actors explicitly so self-service, admin, API, and impersonated writes remain distinguishable.
