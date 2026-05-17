# TS-008: Novu Subscriber Channel Preference Overrides

## Metadata

- `id`: TS-008
- `source_repo`: [novuhq/novu](https://github.com/novuhq/novu)
- `repo_area`: subscriber preferences API, preference merge use case, preferences schema, external SDK DTOs, subscriber preference e2e coverage
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 602
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about preference precedence, workflow-level overrides, optimistic concurrency, and API contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds subscriber channel preference overrides.

Customers can now set channel defaults for a subscriber, for example disabling `sms` globally while leaving `email`, `in_app`, `chat`, and `push` enabled. The API also returns the current preference version so clients can refresh their local state after an update.

The PR adds:

- a new `PATCH /v2/subscribers/:subscriberId/preferences/channels` endpoint,
- a `channelOverrides` response field for global and workflow preferences,
- merge logic that applies subscriber channel overrides when preferences are read,
- persistence for a `version` number on preference records,
- SDK DTOs and API tests for global channel defaults and workflow preferences.

## Existing Code Context

The real Novu codebase already has these relevant contracts:

- `libs/dal/src/repositories/preferences/preferences.schema.ts` stores preferences by type. There is one subscriber-global preference per subscriber/context and one subscriber-workflow preference per subscriber/workflow/context.
- `libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts` documents the merge precedence: workflow resource preferences, workflow user preferences, subscriber global preferences, then subscriber workflow preferences.
- `apps/api/src/app/subscribers-v2/usecases/update-subscriber-preferences/update-subscriber-preferences.usecase.ts` chooses `PreferenceLevelEnum.GLOBAL` when no workflow id is provided and `PreferenceLevelEnum.TEMPLATE` when a workflow id is provided.
- `apps/api/src/app/inbox/usecases/update-preferences/update-preferences.usecase.ts` stores channel preferences through `UpsertPreferences`.
- `libs/application-generic/src/usecases/upsert-preferences/upsert-preferences.usecase.ts` keeps global and workflow subscriber preference rows separate and merges partial channel updates into existing preference documents.
- `GetSubscriberPreference` reads all relevant preference rows and uses `MergePreferences` before returning workflow-level channel preferences.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `libs/dal/src/repositories/preferences/preferences.entity.ts`
- `libs/dal/src/repositories/preferences/preferences.schema.ts`
- `packages/shared/src/entities/subscriber-preference/subscriber-preference.interface.ts`
- `libs/application-generic/src/usecases/merge-preferences/merge-preferences.command.ts`
- `libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts`
- `apps/api/src/app/subscribers-v2/dtos/channel-preference-overrides.dto.ts`
- `apps/api/src/app/subscribers-v2/subscribers.controller.ts`
- `apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.command.ts`
- `apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.usecase.ts`
- `apps/api/src/app/subscribers-v2/subscribers.module.ts`
- `libs/internal-sdk/src/models/components/channelpreferenceoverrides.ts`
- `apps/api/src/app/subscribers-v2/e2e/channel-preference-overrides.e2e.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally focused on API, merge semantics, persistence, SDK type surface, and tests.

## Diff

```diff
diff --git a/libs/dal/src/repositories/preferences/preferences.entity.ts b/libs/dal/src/repositories/preferences/preferences.entity.ts
index 2a1df5da90..e19fa82819 100644
--- a/libs/dal/src/repositories/preferences/preferences.entity.ts
+++ b/libs/dal/src/repositories/preferences/preferences.entity.ts
@@ -35,6 +35,10 @@ export class PreferencesEntity {
 
   schedule?: Schedule;
 
+  channelOverrides?: WorkflowPreferencesPartial['channels'];
+
+  version?: number;
+
   contextKeys?: string[];
 
   contextKeysHash?: string;
diff --git a/libs/dal/src/repositories/preferences/preferences.schema.ts b/libs/dal/src/repositories/preferences/preferences.schema.ts
index 392316ee6a..6b2c710aae 100644
--- a/libs/dal/src/repositories/preferences/preferences.schema.ts
+++ b/libs/dal/src/repositories/preferences/preferences.schema.ts
@@ -70,6 +70,34 @@ const preferencesSchema = new Schema<PreferencesDBModel>(
       },
     },
     schedule: Schema.Types.Mixed,
+    channelOverrides: {
+      [ChannelTypeEnum.EMAIL]: {
+        enabled: {
+          type: Schema.Types.Boolean,
+        },
+      },
+      [ChannelTypeEnum.SMS]: {
+        enabled: {
+          type: Schema.Types.Boolean,
+        },
+      },
+      [ChannelTypeEnum.IN_APP]: {
+        enabled: {
+          type: Schema.Types.Boolean,
+        },
+      },
+      [ChannelTypeEnum.CHAT]: {
+        enabled: {
+          type: Schema.Types.Boolean,
+        },
+      },
+      [ChannelTypeEnum.PUSH]: {
+        enabled: {
+          type: Schema.Types.Boolean,
+        },
+      },
+    },
+    version: {
+      type: Schema.Types.Number,
+      default: 1,
+    },
     contextKeys: {
       type: [Schema.Types.String],
       default: undefined,
@@ -231,6 +259,13 @@ preferencesSchema.index({
   deleted: 1,
 });
 
+preferencesSchema.index({
+  _environmentId: 1,
+  _organizationId: 1,
+  _subscriberId: 1,
+  version: 1,
+});
+
 export const Preferences =
   (mongoose.models.Preferences as mongoose.Model<PreferencesDBModel>) ||
   mongoose.model<PreferencesDBModel>('Preferences', preferencesSchema);
diff --git a/packages/shared/src/entities/subscriber-preference/subscriber-preference.interface.ts b/packages/shared/src/entities/subscriber-preference/subscriber-preference.interface.ts
index 7b9c159255..779f759b25 100644
--- a/packages/shared/src/entities/subscriber-preference/subscriber-preference.interface.ts
+++ b/packages/shared/src/entities/subscriber-preference/subscriber-preference.interface.ts
@@ -21,6 +21,8 @@ interface IPreferenceResponse {
   overrides: IPreferenceOverride[];
   schedule?: Schedule;
   updatedAt?: string;
+  channelOverrides?: IPreferenceChannels;
+  version?: number;
 }
diff --git a/libs/application-generic/src/usecases/merge-preferences/merge-preferences.command.ts b/libs/application-generic/src/usecases/merge-preferences/merge-preferences.command.ts
index a6d70b71e5..39e24711fb 100644
--- a/libs/application-generic/src/usecases/merge-preferences/merge-preferences.command.ts
+++ b/libs/application-generic/src/usecases/merge-preferences/merge-preferences.command.ts
@@ -1,5 +1,5 @@
 import { PreferencesEntity } from '@novu/dal';
-import { WorkflowPreferences } from '@novu/shared';
+import { WorkflowPreferences, WorkflowPreferencesPartial } from '@novu/shared';
 import { EnvironmentCommand } from '../../commands';
 
 export class MergePreferencesCommand extends EnvironmentCommand {
@@ -13,4 +13,6 @@ export class MergePreferencesCommand extends EnvironmentCommand {
    * If true, subscriber preferences will be excluded from the merge calculation.
    */
   excludeSubscriberPreferences?: boolean;
+
+  subscriberChannelOverrides?: WorkflowPreferencesPartial['channels'];
 }
diff --git a/libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts b/libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts
index 2aef25f5ca..9042f25192 100644
--- a/libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts
+++ b/libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts
@@ -45,10 +45,28 @@ export class MergePreferences {
       (preference) => preference !== undefined
     );
 
+    const subscriberChannelOverridePreference =
+      command.subscriberChannelOverrides !== undefined
+        ? ({
+            type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+            preferences: {
+              channels: command.subscriberChannelOverrides,
+            },
+          } as PreferencesEntity & { preferences: WorkflowPreferences })
+        : undefined;
+
     const isWorkflowPreferenceReadonly = workflowPreferences.some((preference) => preference.preferences.all?.readOnly);
     const shouldExcludeSubscriberPreferences = command.excludeSubscriberPreferences || isWorkflowPreferenceReadonly;
 
     const preferencesList = [
       ...workflowPreferences,
       ...(shouldExcludeSubscriberPreferences ? [] : subscriberPreferences),
+      /*
+       * Apply subscriber channel overrides last so the subscriber's channel defaults
+       * are always reflected in workflow preference reads.
+       */
+      ...(subscriberChannelOverridePreference && !shouldExcludeSubscriberPreferences
+        ? [subscriberChannelOverridePreference]
+        : []),
     ];
 
     const normalizedPreferencesList = preferencesList.map((preference) =>
@@ -67,6 +85,7 @@ export class MergePreferences {
       [PreferencesTypeEnum.USER_WORKFLOW]: command.workflowUserPreference?.preferences || null,
       [PreferencesTypeEnum.SUBSCRIBER_GLOBAL]: command.subscriberGlobalPreference?.preferences || null,
       [PreferencesTypeEnum.SUBSCRIBER_WORKFLOW]: command.subscriberWorkflowPreference?.preferences || null,
+      channelOverrides: command.subscriberChannelOverrides || null,
     };
 
     return {
diff --git a/apps/api/src/app/subscribers-v2/dtos/channel-preference-overrides.dto.ts b/apps/api/src/app/subscribers-v2/dtos/channel-preference-overrides.dto.ts
new file mode 100644
index 0000000000..d40bf46165
--- /dev/null
+++ b/apps/api/src/app/subscribers-v2/dtos/channel-preference-overrides.dto.ts
@@ -0,0 +1,105 @@
+import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
+import { IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
+import { Type } from 'class-transformer';
+
+class ChannelOverrideDto {
+  @ApiProperty({
+    description: 'Whether this channel should be enabled by default for the subscriber',
+    type: Boolean,
+  })
+  @IsBoolean()
+  enabled: boolean;
+}
+
+export class SubscriberChannelOverridesDto {
+  @ApiPropertyOptional({ type: ChannelOverrideDto })
+  @IsOptional()
+  @ValidateNested()
+  @Type(() => ChannelOverrideDto)
+  email?: ChannelOverrideDto;
+
+  @ApiPropertyOptional({ type: ChannelOverrideDto })
+  @IsOptional()
+  @ValidateNested()
+  @Type(() => ChannelOverrideDto)
+  sms?: ChannelOverrideDto;
+
+  @ApiPropertyOptional({ type: ChannelOverrideDto })
+  @IsOptional()
+  @ValidateNested()
+  @Type(() => ChannelOverrideDto)
+  in_app?: ChannelOverrideDto;
+
+  @ApiPropertyOptional({ type: ChannelOverrideDto })
+  @IsOptional()
+  @ValidateNested()
+  @Type(() => ChannelOverrideDto)
+  chat?: ChannelOverrideDto;
+
+  @ApiPropertyOptional({ type: ChannelOverrideDto })
+  @IsOptional()
+  @ValidateNested()
+  @Type(() => ChannelOverrideDto)
+  push?: ChannelOverrideDto;
+}
+
+export class UpdateSubscriberChannelOverridesDto {
+  @ApiProperty({
+    description: 'Subscriber channel default overrides',
+    type: SubscriberChannelOverridesDto,
+  })
+  @ValidateNested()
+  @Type(() => SubscriberChannelOverridesDto)
+  channels: SubscriberChannelOverridesDto;
+
+  @ApiPropertyOptional({
+    description: 'Optional workflow id. If provided, the response returns this workflow after global defaults are applied.',
+  })
+  @IsOptional()
+  @IsString()
+  workflowId?: string;
+}
+
+export class SubscriberChannelOverridesResponseDto {
+  @ApiProperty({ type: SubscriberChannelOverridesDto })
+  channels: SubscriberChannelOverridesDto;
+
+  @ApiProperty({
+    description: 'Current preference document version after the write',
+    type: Number,
+  })
+  version: number;
+}
diff --git a/apps/api/src/app/subscribers-v2/subscribers.controller.ts b/apps/api/src/app/subscribers-v2/subscribers.controller.ts
index 5e26d4a7ec..8c90350b7f 100644
--- a/apps/api/src/app/subscribers-v2/subscribers.controller.ts
+++ b/apps/api/src/app/subscribers-v2/subscribers.controller.ts
@@ -68,6 +68,10 @@ import { BulkUpdateSubscriberPreferencesDto } from './dtos/bulk-update-subscriber
 import { GetSubscriberPreferencesDto } from './dtos/get-subscriber-preferences.dto';
 import { GetSubscriberPreferencesRequestDto } from './dtos/get-subscriber-preferences-request.dto';
+import {
+  SubscriberChannelOverridesResponseDto,
+  UpdateSubscriberChannelOverridesDto,
+} from './dtos/channel-preference-overrides.dto';
 import { GetSubscriberPreferencesCommand } from './usecases/get-subscriber-preferences/get-subscriber-preferences.command';
 import { GetSubscriberPreferences } from './usecases/get-subscriber-preferences/get-subscriber-preferences.usecase';
+import { UpdateSubscriberChannelOverrides } from './usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.usecase';
 import { UpdateSubscriberPreferencesCommand } from './usecases/update-subscriber-preferences/update-subscriber-preferences.command';
 import { UpdateSubscriberPreferences } from './usecases/update-subscriber-preferences/update-subscriber-preferences.usecase';
@@ -112,6 +116,7 @@ export class SubscribersController {
     private getSubscriberPreferencesUsecase: GetSubscriberPreferences,
     private updateSubscriberPreferencesUsecase: UpdateSubscriberPreferences,
+    private updateSubscriberChannelOverridesUsecase: UpdateSubscriberChannelOverrides,
   ) {}
 
@@ -407,6 +412,38 @@ export class SubscribersController {
       })
     );
   }
+
+  @Patch('/:subscriberId/preferences/channels')
+  @ExternalApiAccessible()
+  @ApiOperation({
+    summary: 'Update subscriber channel defaults',
+    description: `Update subscriber-wide channel defaults. These defaults are applied when reading global and workflow preferences.`,
+  })
+  @ApiParam({ name: 'subscriberId', description: 'The identifier of the subscriber', type: String })
+  @ApiResponse(SubscriberChannelOverridesResponseDto)
+  @SdkGroupName('Subscribers.Preferences')
+  @SdkMethodName('updateChannelOverrides')
+  @RequirePermissions(PermissionsEnum.SUBSCRIBER_WRITE)
+  async updateSubscriberChannelOverrides(
+    @UserSession() user: UserSessionData,
+    @Param('subscriberId') subscriberId: string,
+    @Body() body: UpdateSubscriberChannelOverridesDto
+  ): Promise<SubscriberChannelOverridesResponseDto> {
+    return await this.updateSubscriberChannelOverridesUsecase.execute(
+      UpdateSubscriberChannelOverridesCommand.create({
+        environmentId: user.environmentId,
+        organizationId: user.organizationId,
+        subscriberId,
+        workflowIdOrInternalId: body.workflowId,
+        channels: body.channels,
+      })
+    );
+  }
 
   @Get('/:subscriberId/subscriptions')
   @ExternalApiAccessible()
diff --git a/apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.command.ts b/apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.command.ts
new file mode 100644
index 0000000000..234fd6eb85
--- /dev/null
+++ b/apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.command.ts
@@ -0,0 +1,27 @@
+import { EnvironmentWithSubscriber } from '@novu/application-generic';
+import { IPreferenceChannels } from '@novu/shared';
+
+export class UpdateSubscriberChannelOverridesCommand extends EnvironmentWithSubscriber {
+  subscriberId: string;
+
+  workflowIdOrInternalId?: string;
+
+  channels: {
+    email?: { enabled: boolean };
+    sms?: { enabled: boolean };
+    in_app?: { enabled: boolean };
+    chat?: { enabled: boolean };
+    push?: { enabled: boolean };
+  };
+
+  get flattenedChannels(): IPreferenceChannels {
+    return Object.entries(this.channels ?? {}).reduce((acc, [channel, value]) => {
+      if (value?.enabled === undefined) return acc;
+      return {
+        ...acc,
+        [channel]: value.enabled,
+      };
+    }, {} as IPreferenceChannels);
+  }
+}
diff --git a/apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.usecase.ts b/apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.usecase.ts
new file mode 100644
index 0000000000..4aa82912ce
--- /dev/null
+++ b/apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.usecase.ts
@@ -0,0 +1,166 @@
+import { Injectable, NotFoundException } from '@nestjs/common';
+import { GetWorkflowByIdsCommand, GetWorkflowByIdsUseCase } from '@novu/application-generic';
+import { PreferencesEntity, PreferencesRepository, SubscriberRepository } from '@novu/dal';
+import { PreferencesTypeEnum, WorkflowPreferencesPartial } from '@novu/shared';
+import { UpdateSubscriberChannelOverridesCommand } from './update-subscriber-channel-overrides.command';
+
+@Injectable()
+export class UpdateSubscriberChannelOverrides {
+  constructor(
+    private subscriberRepository: SubscriberRepository,
+    private preferencesRepository: PreferencesRepository,
+    private getWorkflowByIdsUseCase: GetWorkflowByIdsUseCase
+  ) {}
+
+  async execute(command: UpdateSubscriberChannelOverridesCommand): Promise<{
+    channels: NonNullable<PreferencesEntity['channelOverrides']>;
+    version: number;
+  }> {
+    const subscriber = await this.subscriberRepository.findBySubscriberId(
+      command.environmentId,
+      command.subscriberId,
+      true,
+      '_id'
+    );
+
+    if (!subscriber) {
+      throw new NotFoundException(`Subscriber with id: ${command.subscriberId} not found`);
+    }
+
+    const workflowId = command.workflowIdOrInternalId
+      ? (
+          await this.getWorkflowByIdsUseCase.execute(
+            GetWorkflowByIdsCommand.create({
+              environmentId: command.environmentId,
+              organizationId: command.organizationId,
+              workflowIdOrInternalId: command.workflowIdOrInternalId,
+            })
+          )
+        )._id
+      : undefined;
+
+    const preference = await this.findOrCreateGlobalPreference(command, subscriber._id);
+    const nextOverrides = this.mergeOverrides(preference.channelOverrides, command.flattenedChannels);
+    const nextPreferences = this.mergePreferences(preference.preferences, command.flattenedChannels);
+
+    await this.preferencesRepository.update(
+      {
+        _id: preference._id,
+        _environmentId: command.environmentId,
+      },
+      {
+        $set: {
+          channelOverrides: nextOverrides,
+          preferences: nextPreferences,
+          version: (preference.version ?? 1) + 1,
+        },
+      }
+    );
+
+    if (workflowId) {
+      await this.updateWorkflowPreferencePreview(command, subscriber._id, workflowId, nextOverrides);
+    }
+
+    return {
+      channels: nextOverrides,
+      version: (preference.version ?? 1) + 1,
+    };
+  }
+
+  private async findOrCreateGlobalPreference(
+    command: UpdateSubscriberChannelOverridesCommand,
+    subscriberId: string
+  ): Promise<PreferencesEntity> {
+    const existing = await this.preferencesRepository.findOne({
+      _environmentId: command.environmentId,
+      _organizationId: command.organizationId,
+      _subscriberId: subscriberId,
+      type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+    });
+
+    if (existing) {
+      return existing;
+    }
+
+    return await this.preferencesRepository.create({
+      _environmentId: command.environmentId,
+      _organizationId: command.organizationId,
+      _subscriberId: subscriberId,
+      type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+      preferences: {
+        channels: {},
+      },
+      channelOverrides: {},
+      version: 1,
+    });
+  }
+
+  private mergeOverrides(
+    current: PreferencesEntity['channelOverrides'] | undefined,
+    incoming: Record<string, boolean>
+  ) {
+    return Object.entries(incoming).reduce(
+      (acc, [channel, enabled]) => ({
+        ...acc,
+        [channel]: {
+          enabled,
+        },
+      }),
+      { ...(current ?? {}) }
+    );
+  }
+
+  private mergePreferences(
+    current: WorkflowPreferencesPartial | undefined,
+    incoming: Record<string, boolean>
+  ): WorkflowPreferencesPartial {
+    const channels = Object.entries(incoming).reduce(
+      (acc, [channel, enabled]) => ({
+        ...acc,
+        [channel]: {
+          enabled,
+        },
+      }),
+      { ...(current?.channels ?? {}) }
+    );
+
+    return {
+      ...current,
+      channels,
+    };
+  }
+
+  private async updateWorkflowPreferencePreview(
+    command: UpdateSubscriberChannelOverridesCommand,
+    subscriberId: string,
+    workflowId: string,
+    channelOverrides: NonNullable<PreferencesEntity['channelOverrides']>
+  ) {
+    const workflowPreference = await this.preferencesRepository.findOne({
+      _environmentId: command.environmentId,
+      _organizationId: command.organizationId,
+      _subscriberId: subscriberId,
+      _templateId: workflowId,
+      type: PreferencesTypeEnum.SUBSCRIBER_WORKFLOW,
+    });
+
+    if (!workflowPreference) {
+      return;
+    }
+
+    await this.preferencesRepository.update(
+      {
+        _id: workflowPreference._id,
+        _environmentId: command.environmentId,
+      },
+      {
+        $set: {
+          channelOverrides,
+          version: (workflowPreference.version ?? 1) + 1,
+        },
+      }
+    );
+  }
+}
diff --git a/apps/api/src/app/subscribers-v2/subscribers.module.ts b/apps/api/src/app/subscribers-v2/subscribers.module.ts
index 66acf64a92..b6bd7c3264 100644
--- a/apps/api/src/app/subscribers-v2/subscribers.module.ts
+++ b/apps/api/src/app/subscribers-v2/subscribers.module.ts
@@ -43,6 +43,7 @@ import { GetSubscriberPreferences } from './usecases/get-subscriber-preferences/
 import { UpdateSubscriberPreferences } from './usecases/update-subscriber-preferences/update-subscriber-preferences.usecase';
+import { UpdateSubscriberChannelOverrides } from './usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.usecase';
 
 @Module({
@@ -56,6 +57,7 @@ import { UpdateSubscriberPreferences } from './usecases/update-subscriber-prefere
     GetSubscriberPreferences,
     UpdateSubscriberPreferences,
+    UpdateSubscriberChannelOverrides,
   ],
 })
 export class SubscribersV2Module {}
diff --git a/libs/internal-sdk/src/models/components/channelpreferenceoverrides.ts b/libs/internal-sdk/src/models/components/channelpreferenceoverrides.ts
new file mode 100644
index 0000000000..403cf7063a
--- /dev/null
+++ b/libs/internal-sdk/src/models/components/channelpreferenceoverrides.ts
@@ -0,0 +1,46 @@
+export type ChannelOverride = {
+  enabled: boolean;
+};
+
+export type SubscriberChannelOverrides = {
+  email?: ChannelOverride;
+  sms?: ChannelOverride;
+  in_app?: ChannelOverride;
+  chat?: ChannelOverride;
+  push?: ChannelOverride;
+};
+
+export type UpdateSubscriberChannelOverridesRequest = {
+  channels: SubscriberChannelOverrides;
+  workflowId?: string;
+};
+
+export type UpdateSubscriberChannelOverridesResponse = {
+  channels: SubscriberChannelOverrides;
+  version: number;
+};
diff --git a/apps/api/src/app/subscribers-v2/e2e/channel-preference-overrides.e2e.ts b/apps/api/src/app/subscribers-v2/e2e/channel-preference-overrides.e2e.ts
new file mode 100644
index 0000000000..60537ef79e
--- /dev/null
+++ b/apps/api/src/app/subscribers-v2/e2e/channel-preference-overrides.e2e.ts
@@ -0,0 +1,157 @@
+import { expect } from 'chai';
+import { createNovuClient, createSubscriber, createWorkflow } from '../../../shared/e2e';
+
+describe('Subscriber channel preference overrides - /v2/subscribers/:subscriberId/preferences/channels (PATCH)', () => {
+  it('applies subscriber channel overrides to workflow preferences', async () => {
+    const novuClient = createNovuClient();
+    const subscriber = await createSubscriber();
+    const workflow = await createWorkflow({
+      channels: ['email', 'sms'],
+    });
+
+    await novuClient.subscribers.preferences.update(
+      {
+        workflowId: workflow.workflowId,
+        channels: {
+          email: true,
+          sms: true,
+        },
+      },
+      subscriber.subscriberId
+    );
+
+    const response = await novuClient.subscribers.preferences.updateChannelOverrides(
+      {
+        workflowId: workflow.workflowId,
+        channels: {
+          email: { enabled: false },
+        },
+      },
+      subscriber.subscriberId
+    );
+
+    expect(response.version).to.equal(2);
+    expect(response.channels.email.enabled).to.equal(false);
+
+    const preferences = await novuClient.subscribers.preferences.list({
+      subscriberId: subscriber.subscriberId,
+    });
+
+    const workflowPreference = preferences.workflows.find(
+      (preference) => preference.workflow.identifier === workflow.workflowId
+    );
+
+    expect(workflowPreference?.channels.email).to.equal(false);
+    expect(workflowPreference?.channels.sms).to.equal(true);
+  });
+
+  it('increments the version after every channel override update', async () => {
+    const novuClient = createNovuClient();
+    const subscriber = await createSubscriber();
+
+    const first = await novuClient.subscribers.preferences.updateChannelOverrides(
+      {
+        channels: {
+          email: { enabled: false },
+        },
+      },
+      subscriber.subscriberId
+    );
+
+    const second = await novuClient.subscribers.preferences.updateChannelOverrides(
+      {
+        channels: {
+          sms: { enabled: false },
+        },
+      },
+      subscriber.subscriberId
+    );
+
+    expect(first.version).to.equal(2);
+    expect(second.version).to.equal(3);
+    expect(second.channels.email.enabled).to.equal(false);
+    expect(second.channels.sms.enabled).to.equal(false);
+  });
+});
```

## Intended Flaws

### Flaw 1: Global Channel Defaults Override Workflow-Specific Subscriber Preferences

- `type`: `invariant_drift`
- `location`: `libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts:45-85`, `apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.usecase.ts:38-151`, `apps/api/src/app/subscribers-v2/e2e/channel-preference-overrides.e2e.ts:5-43`
- `learner_prompt`: Does the new merge order preserve the distinction between subscriber-global defaults and workflow-specific preferences?

Expected answer:

- `identify`: The PR applies `subscriberChannelOverrides` after all subscriber preferences in `MergePreferences`. Because the merge is last-writer-wins, a subscriber-global channel default now overrides an explicit subscriber-workflow preference. The new e2e test even locks in that behavior: a workflow-specific `email: true` is changed to `false` after the global channel override is applied.
- `impact`: Users can no longer reliably opt into or out of a channel for a specific workflow. A subscriber who disables SMS globally but enables SMS for `security-alerts` may stop receiving that critical workflow. Conversely, a global enable can revive a channel that was intentionally disabled for a noisy workflow. Support will see preferences that look correctly saved but are ignored during delivery because the read model applies the wrong precedence.
- `fix_direction`: Define and preserve a clear precedence model. Subscriber-global channel defaults should provide fallback values only when no workflow-specific subscriber preference exists for that channel. Explicit subscriber-workflow preferences should win over subscriber-global defaults, unless the workflow is read-only/critical or a documented resource-level override applies. Add tests for global default plus workflow opt-in and workflow opt-out cases.

Hints:

1. Compare the new merge order with the existing `MergePreferences` contract in `libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts`.
2. Follow one channel where global says `false` and workflow-specific subscriber preference says `true`.
3. Inspect how `preferencesList` is ordered before `MergePreferences`. Which source wins if the same channel appears twice?

### Flaw 2: Preference Updates Expose Versions But Do Not Use Optimistic Concurrency

- `type`: `consistency_gap`
- `location`: `apps/api/src/app/subscribers-v2/dtos/channel-preference-overrides.dto.ts:45-70`, `apps/api/src/app/subscribers-v2/usecases/update-subscriber-channel-overrides/update-subscriber-channel-overrides.usecase.ts:38-65`, `apps/api/src/app/subscribers-v2/e2e/channel-preference-overrides.e2e.ts:45-72`
- `learner_prompt`: Can two clients safely update subscriber channel overrides from stale preference screens?

Expected answer:

- `identify`: The API returns a `version`, but the request does not accept an expected version or `If-Match`/ETag value. The use case reads the current preference, merges the incoming channels in application code, and writes with only `_id` and `_environmentId` in the update filter. Two clients can read version 2, make different edits, and both writes will succeed; the later write can overwrite fields or report a version derived from stale state.
- `impact`: Preference screens are often open in multiple browser tabs, embedded inboxes, mobile apps, and customer support tools. Without optimistic concurrency, a user can disable SMS in one client while another client saves an older view and silently re-enables it. Because preferences affect notification delivery, lost updates can create missed alerts, unwanted messages, and hard-to-debug support tickets.
- `fix_direction`: Treat `version` as a real concurrency contract. Require `If-Match` or `expectedVersion` on writes, include `{ _id, _environmentId, version: expectedVersion }` in the update filter, atomically increment the version, and return `409 Conflict` with the latest representation when the version does not match. Add concurrent-write tests for disjoint channel edits and stale full-object saves.

Hints:

1. A response `version` is only useful if the next write proves which version it edited.
2. Look at the update filter, not only the response DTO.
3. Model two browser tabs saving different channel changes from the same starting state. What should the stored preference preserve?

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the precedence regression. Answers that only say "merge logic is confusing" are incomplete unless they explain that subscriber-global defaults are applied after and override subscriber-workflow preferences.

For flaw 2, a correct answer must identify the optimistic-concurrency gap. Answers that only say "there is a version field" are incomplete; the version must participate in the write contract.

### Product-Level Change

The PR tries to let customers manage subscriber-wide channel defaults. That is a real product need: users often want to disable SMS globally while still receiving important workflow-specific messages. Preferences are not just settings UI; they directly decide whether notifications are delivered.

### Changed Contracts

- API contract: a new channel override endpoint mutates subscriber preferences.
- Read contract: global and workflow preference responses now include `channelOverrides` and `version`.
- Merge contract: channel defaults become part of preference resolution.
- Delivery contract: resolved channel preferences determine which workflow steps can send.
- Concurrency contract: clients are encouraged to use a returned version, but writes do not enforce it.

### Failure Modes

A subscriber disables SMS globally, then explicitly enables SMS for fraud alerts. The new merge path applies the global SMS override last, so fraud alerts stop sending SMS even though the workflow preference row says SMS is enabled.

A subscriber has the preferences panel open in two tabs. Tab A disables email. Tab B, still showing the old version, disables SMS. Both requests succeed. Depending on which write lands last and which fields were included, email can be silently re-enabled or the returned version can be misleading.

### Reviewer Thought Process

A strong reviewer starts with the preference hierarchy. The important question is not whether the endpoint saves a boolean; it is which source wins when template defaults, workflow overrides, subscriber global defaults, and subscriber workflow settings disagree.

The second move is to inspect the write contract. Preferences are user-facing mutable state. If the PR introduces a `version`, the reviewer should ask whether it is decorative or enforced. The update query is the evidence.

### Better Implementation Direction

- Keep subscriber-global channel defaults as fallback values.
- Preserve explicit subscriber-workflow preferences as higher precedence.
- Model override reasons in the response so users can see which source won.
- Require `If-Match` or `expectedVersion` for mutable preference writes.
- Perform conditional atomic updates and return `409 Conflict` on stale writes.
- Add tests for global default plus workflow-specific opt-in/out and concurrent stale writes.

## Why This Case Exists

This case trains a reviewer to find bugs in product semantics rather than syntax. Preference systems are all about precedence and state ownership. A reviewer should ask "which source wins?" and "what happens when two clients save at the same time?"
