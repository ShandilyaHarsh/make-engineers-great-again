# TS-063: Novu Global Unsubscribe Endpoint

## Metadata

- `id`: TS-063
- `source_repo`: [novuhq/novu](https://github.com/novuhq/novu)
- `repo_area`: subscriber global preferences, preference merge/upsert use cases, inbox preference updates, email unsubscribe link rendering, worker send-time preference evaluation, queued notification jobs, public subscriber token handling
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 2,000-2,450
- `represented_diff_lines`: 2398
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about unsubscribe semantics, send-time preference checks, queued notification jobs, token scope, replay risk, and Novu preference merge rules without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a public global unsubscribe endpoint for Novu email links. A subscriber can click a link, preview the unsubscribe page, and submit a one-click global opt-out for all non-critical channels. The PR claims that future sends respect the opt-out, queued jobs are handled through a preference snapshot, and the endpoint is safe to expose publicly because unsubscribe tokens identify the subscriber.

The PR adds:

- a global unsubscribe token service,
- public preview and submit endpoints,
- a global unsubscribe use case and repository,
- a cache marker for fast reads,
- an email renderer replacement for `{{global_unsubscribe_url}}`,
- a preference snapshot captured when notification jobs are created,
- a worker-side preference guard that can use the snapshot,
- tests for token decoding, unsubscribe writes, worker preference behavior, and docs.

The intended product behavior is: after a subscriber opts out globally, no non-critical notification should be delivered to that subscriber, including delayed or queued jobs that have not reached the provider yet. The unsubscribe token should only authorize the intended subscriber/environment/scope and should be revocable or naturally expire.

## Existing Code Context

The real Novu codebase already has these relevant contracts:

- Subscriber preferences are stored with `PreferencesTypeEnum.SUBSCRIBER_GLOBAL`, `SUBSCRIBER_WORKFLOW`, and related types.
- `UpsertPreferences.upsertSubscriberGlobalPreferences` updates subscriber global preferences and removes conflicting subscriber workflow channel preferences for updated channels.
- `MergePreferences` combines workflow resource/user preferences with subscriber global/workflow preferences, while respecting read-only workflow preferences.
- The inbox `UpdatePreferences` use case resolves the subscriber and workflow before upserting preferences and emitting preference webhooks.
- Worker `SendMessage.evaluateChannelPreference` normally evaluates subscriber/template preference at send time before provider delivery.
- `CreateNotificationJobs` builds one job per step, and `RunJob` later passes job data to `SendMessage`; delayed/digest jobs may execute after the original trigger request.
- Stateless workflow preferences can be serialized into jobs, but stored workflows use database preference reads.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether global unsubscribe is enforced at the correct time and whether the public token is appropriately scoped.

## Review Surface

Changed files in the synthetic PR:

- `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.dto.ts`
- `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.ts`
- `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.repository.ts`
- `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.cache.ts`
- `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.usecase.ts`
- `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.controller.ts`
- `apps/api/src/app/environments-v1/usecases/output-renderers/email-unsubscribe-link-renderer.ts`
- `libs/application-generic/src/usecases/create-notification-jobs/create-notification-jobs-preference-snapshot.ts`
- `apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.ts`
- `libs/dal/src/repositories/preferences/preferences-global-unsubscribe.migration.ts`
- `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.usecase.spec.ts`
- `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.spec.ts`
- `apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.spec.ts`
- `apps/worker/src/app/workflow/usecases/send-message/global-unsubscribe-send-matrix.spec.ts`
- `docs/platform/global-unsubscribe.md`

The line references below use synthetic PR line numbers. The represented diff is focused on token scope, preference write semantics, queued jobs, and send-time enforcement.

## Diff

```diff
diff --git a/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.dto.ts b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.dto.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.dto.ts
@@ -0,0 +1,53 @@
+import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
+import { ChannelTypeEnum } from "@novu/shared";
+
+export class GlobalUnsubscribeRequestDto {
+  @IsString()
+  token: string;
+
+  @IsOptional()
+  @IsString()
+  @MaxLength(500)
+  reason?: string;
+
+  @IsOptional()
+  @IsBoolean()
+  unsubscribeAllChannels?: boolean;
+}
+
+export class GlobalUnsubscribePreviewDto {
+  subscriberId: string;
+  environmentId: string;
+  email?: string;
+  channels: ChannelTypeEnum[];
+  alreadyUnsubscribed: boolean;
+}
+
+export class GlobalUnsubscribeResponseDto {
+  subscriberId: string;
+  environmentId: string;
+  channels: ChannelTypeEnum[];
+  unsubscribedAt: string;
+  preferenceVersion: number;
+  alreadyUnsubscribed: boolean;
+}
+
+export type GlobalUnsubscribeChannel = {
+  channel: ChannelTypeEnum;
+  enabled: false;
+};
+
+export const DEFAULT_GLOBAL_UNSUBSCRIBE_CHANNELS = [
+  ChannelTypeEnum.EMAIL,
+  ChannelTypeEnum.SMS,
+  ChannelTypeEnum.IN_APP,
+  ChannelTypeEnum.CHAT,
+  ChannelTypeEnum.PUSH,
+];
+
+export function toDisabledChannelMap(channels: ChannelTypeEnum[]) {
+  return channels.reduce<Record<string, { enabled: boolean }>>((acc, channel) => {
+    acc[channel] = { enabled: false };
+    return acc;
+  }, {});
+}
diff --git a/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.ts b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.ts
new file mode 100644
index 0000000000..0000000002
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.ts
@@ -0,0 +1,50 @@
+import { Injectable, BadRequestException } from "@nestjs/common";
+
+export type GlobalUnsubscribeTokenPayload = {
+  environmentId: string;
+  subscriberId: string;
+  email?: string;
+  issuedAt?: string;
+  workflowId?: string;
+  channel?: string;
+};
+
+@Injectable()
+export class GlobalUnsubscribeTokenService {
+  encode(payload: GlobalUnsubscribeTokenPayload): string {
+    const serialized = JSON.stringify({
+      environmentId: payload.environmentId,
+      subscriberId: payload.subscriberId,
+      email: payload.email,
+      issuedAt: payload.issuedAt ?? new Date().toISOString(),
+    });
+
+    return Buffer.from(serialized, "utf8").toString("base64url");
+  }
+
+  decode(token: string): GlobalUnsubscribeTokenPayload {
+    try {
+      const decoded = Buffer.from(token, "base64url").toString("utf8");
+      const payload = JSON.parse(decoded);
+
+      if (!payload.environmentId || !payload.subscriberId) {
+        throw new BadRequestException("Invalid unsubscribe token");
+      }
+
+      return {
+        environmentId: payload.environmentId,
+        subscriberId: payload.subscriberId,
+        email: payload.email,
+        issuedAt: payload.issuedAt,
+      };
+    } catch (error) {
+      if (error instanceof BadRequestException) throw error;
+      throw new BadRequestException("Invalid unsubscribe token");
+    }
+  }
+
+  buildEmailLink(baseUrl: string, payload: GlobalUnsubscribeTokenPayload) {
+    const token = this.encode(payload);
+    return `${baseUrl.replace(/\/$/, "")}/unsubscribe/global?token=${token}`;
+  }
+}
diff --git a/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.repository.ts b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.repository.ts
new file mode 100644
index 0000000000..0000000003
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.repository.ts
@@ -0,0 +1,56 @@
+import { Injectable } from "@nestjs/common";
+import { PreferencesRepository, SubscriberRepository } from "@novu/dal";
+import { PreferencesTypeEnum } from "@novu/shared";
+
+@Injectable()
+export class GlobalUnsubscribeRepository {
+  constructor(
+    private preferencesRepository: PreferencesRepository,
+    private subscriberRepository: SubscriberRepository
+  ) {}
+
+  async findSubscriber(environmentId: string, subscriberId: string) {
+    return this.subscriberRepository.findBySubscriberId(
+      environmentId,
+      subscriberId,
+      false,
+      "_id subscriberId email firstName lastName"
+    );
+  }
+
+  async getGlobalPreference(environmentId: string, subscriberInternalId: string) {
+    return this.preferencesRepository.findOne({
+      _environmentId: environmentId,
+      _subscriberId: subscriberInternalId,
+      type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+    });
+  }
+
+  async upsertGlobalUnsubscribe(params: {
+    organizationId: string;
+    environmentId: string;
+    subscriberInternalId: string;
+    channels: Record<string, { enabled: boolean }>;
+    reason?: string;
+    unsubscribedAt: Date;
+  }) {
+    return this.preferencesRepository.update(
+      {
+        _organizationId: params.organizationId,
+        _environmentId: params.environmentId,
+        _subscriberId: params.subscriberInternalId,
+        type: PreferencesTypeEnum.SUBSCRIBER_GLOBAL,
+      },
+      {
+        $set: {
+          "preferences.all.enabled": false,
+          "preferences.channels": params.channels,
+          "metadata.globalUnsubscribeReason": params.reason,
+          "metadata.globalUnsubscribedAt": params.unsubscribedAt,
+        },
+        $inc: { preferenceVersion: 1 },
+      },
+      { upsert: true, new: true }
+    );
+  }
+}
diff --git a/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.cache.ts b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.cache.ts
new file mode 100644
index 0000000000..0000000004
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.cache.ts
@@ -0,0 +1,32 @@
+import { Injectable } from "@nestjs/common";
+import { CacheService } from "@novu/application-generic";
+
+const GLOBAL_UNSUBSCRIBE_CACHE_TTL_SECONDS = 60;
+
+@Injectable()
+export class GlobalUnsubscribeCache {
+  constructor(private cacheService: CacheService) {}
+
+  private key(environmentId: string, subscriberId: string) {
+    return `global-unsubscribe:${environmentId}:${subscriberId}`;
+  }
+
+  async markUnsubscribed(environmentId: string, subscriberId: string) {
+    await this.cacheService.set(
+      this.key(environmentId, subscriberId),
+      JSON.stringify({ unsubscribed: true, seenAt: new Date().toISOString() }),
+      GLOBAL_UNSUBSCRIBE_CACHE_TTL_SECONDS
+    );
+  }
+
+  async isUnsubscribed(environmentId: string, subscriberId: string) {
+    const value = await this.cacheService.get(this.key(environmentId, subscriberId));
+    if (!value) return false;
+    const parsed = JSON.parse(value);
+    return parsed.unsubscribed === true;
+  }
+
+  async invalidate(environmentId: string, subscriberId: string) {
+    await this.cacheService.del(this.key(environmentId, subscriberId));
+  }
+}
diff --git a/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.usecase.ts b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.usecase.ts
new file mode 100644
index 0000000000..0000000005
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.usecase.ts
@@ -0,0 +1,84 @@
+import { Injectable, NotFoundException } from "@nestjs/common";
+import { ChannelTypeEnum } from "@novu/shared";
+import { GlobalUnsubscribeCache } from "./global-unsubscribe.cache";
+import { GlobalUnsubscribeRepository } from "./global-unsubscribe.repository";
+import { GlobalUnsubscribeTokenService } from "./global-unsubscribe-token.service";
+import { DEFAULT_GLOBAL_UNSUBSCRIBE_CHANNELS, toDisabledChannelMap } from "./global-unsubscribe.dto";
+
+export type GlobalUnsubscribeCommand = {
+  token: string;
+  organizationId: string;
+  environmentId?: string;
+  reason?: string;
+  unsubscribeAllChannels?: boolean;
+};
+
+@Injectable()
+export class GlobalUnsubscribeUsecase {
+  constructor(
+    private tokenService: GlobalUnsubscribeTokenService,
+    private repository: GlobalUnsubscribeRepository,
+    private cache: GlobalUnsubscribeCache
+  ) {}
+
+  async execute(command: GlobalUnsubscribeCommand) {
+    const payload = this.tokenService.decode(command.token);
+    const environmentId = command.environmentId ?? payload.environmentId;
+
+    const subscriber = await this.repository.findSubscriber(environmentId, payload.subscriberId);
+    if (!subscriber) {
+      throw new NotFoundException("Subscriber not found");
+    }
+
+    const channels = this.channelsFor(command.unsubscribeAllChannels);
+    const currentPreference = await this.repository.getGlobalPreference(environmentId, subscriber._id);
+    const alreadyUnsubscribed = currentPreference?.preferences?.all?.enabled === false;
+    const unsubscribedAt = new Date();
+
+    const preference = await this.repository.upsertGlobalUnsubscribe({
+      organizationId: command.organizationId,
+      environmentId,
+      subscriberInternalId: subscriber._id,
+      channels: toDisabledChannelMap(channels),
+      reason: command.reason,
+      unsubscribedAt,
+    });
+
+    await this.cache.markUnsubscribed(environmentId, subscriber.subscriberId);
+
+    return {
+      subscriberId: subscriber.subscriberId,
+      environmentId,
+      channels,
+      unsubscribedAt: unsubscribedAt.toISOString(),
+      preferenceVersion: preference?.preferenceVersion ?? 1,
+      alreadyUnsubscribed,
+    };
+  }
+
+  async preview(token: string) {
+    const payload = this.tokenService.decode(token);
+    const subscriber = await this.repository.findSubscriber(payload.environmentId, payload.subscriberId);
+    if (!subscriber) {
+      throw new NotFoundException("Subscriber not found");
+    }
+
+    const preference = await this.repository.getGlobalPreference(payload.environmentId, subscriber._id);
+
+    return {
+      subscriberId: subscriber.subscriberId,
+      environmentId: payload.environmentId,
+      email: subscriber.email,
+      channels: DEFAULT_GLOBAL_UNSUBSCRIBE_CHANNELS,
+      alreadyUnsubscribed: preference?.preferences?.all?.enabled === false,
+    };
+  }
+
+  private channelsFor(unsubscribeAllChannels = true): ChannelTypeEnum[] {
+    if (unsubscribeAllChannels) {
+      return DEFAULT_GLOBAL_UNSUBSCRIBE_CHANNELS;
+    }
+
+    return [ChannelTypeEnum.EMAIL];
+  }
+}
diff --git a/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.controller.ts b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.controller.ts
new file mode 100644
index 0000000000..0000000006
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.controller.ts
@@ -0,0 +1,27 @@
+import { Body, Controller, Get, Post, Query } from "@nestjs/common";
+import { ApiTags } from "@nestjs/swagger";
+import { UserSession } from "../../shared/framework/user.decorator";
+import { GlobalUnsubscribeRequestDto } from "./global-unsubscribe.dto";
+import { GlobalUnsubscribeUsecase } from "./global-unsubscribe.usecase";
+
+@Controller("unsubscribe")
+@ApiTags("Unsubscribe")
+export class GlobalUnsubscribeController {
+  constructor(private globalUnsubscribeUsecase: GlobalUnsubscribeUsecase) {}
+
+  @Get("global/preview")
+  async preview(@Query("token") token: string) {
+    return this.globalUnsubscribeUsecase.preview(token);
+  }
+
+  @Post("global")
+  async unsubscribe(@UserSession() user: any, @Body() body: GlobalUnsubscribeRequestDto) {
+    return this.globalUnsubscribeUsecase.execute({
+      token: body.token,
+      organizationId: user.organizationId,
+      environmentId: user.environmentId,
+      reason: body.reason,
+      unsubscribeAllChannels: body.unsubscribeAllChannels,
+    });
+  }
+}
diff --git a/apps/api/src/app/environments-v1/usecases/output-renderers/email-unsubscribe-link-renderer.ts b/apps/api/src/app/environments-v1/usecases/output-renderers/email-unsubscribe-link-renderer.ts
new file mode 100644
index 0000000000..0000000007
--- /dev/null
+++ b/apps/api/src/app/environments-v1/usecases/output-renderers/email-unsubscribe-link-renderer.ts
@@ -0,0 +1,23 @@
+import { Injectable } from "@nestjs/common";
+import { GlobalUnsubscribeTokenService } from "../../subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service";
+
+@Injectable()
+export class EmailUnsubscribeLinkRenderer {
+  constructor(private tokenService: GlobalUnsubscribeTokenService) {}
+
+  render(params: {
+    baseUrl: string;
+    environmentId: string;
+    subscriberId: string;
+    email?: string;
+    body: string;
+  }) {
+    const unsubscribeUrl = this.tokenService.buildEmailLink(params.baseUrl, {
+      environmentId: params.environmentId,
+      subscriberId: params.subscriberId,
+      email: params.email,
+    });
+
+    return params.body.replaceAll("{{global_unsubscribe_url}}", unsubscribeUrl);
+  }
+}
diff --git a/libs/application-generic/src/usecases/create-notification-jobs/create-notification-jobs-preference-snapshot.ts b/libs/application-generic/src/usecases/create-notification-jobs/create-notification-jobs-preference-snapshot.ts
new file mode 100644
index 0000000000..0000000008
--- /dev/null
+++ b/libs/application-generic/src/usecases/create-notification-jobs/create-notification-jobs-preference-snapshot.ts
@@ -0,0 +1,36 @@
+import { Injectable } from "@nestjs/common";
+import { GetSubscriberGlobalPreference } from "apps/api/src/app/subscribers/usecases/get-subscriber-global-preference";
+
+@Injectable()
+export class CreateNotificationJobsPreferenceSnapshot {
+  constructor(private getSubscriberGlobalPreference: GetSubscriberGlobalPreference) {}
+
+  async buildSnapshot(command: {
+    organizationId: string;
+    environmentId: string;
+    subscriberId: string;
+    contextKeys?: string[];
+  }) {
+    const { preference } = await this.getSubscriberGlobalPreference.execute({
+      organizationId: command.organizationId,
+      environmentId: command.environmentId,
+      subscriberId: command.subscriberId,
+      includeInactiveChannels: true,
+      contextKeys: command.contextKeys,
+    } as any);
+
+    return {
+      capturedAt: new Date().toISOString(),
+      enabled: preference.enabled,
+      channels: preference.channels,
+      schedule: preference.schedule,
+    };
+  }
+
+  applyToJob(job: any, snapshot: Awaited<ReturnType<CreateNotificationJobsPreferenceSnapshot["buildSnapshot"]>>) {
+    return {
+      ...job,
+      preferenceSnapshot: snapshot,
+    };
+  }
+}
diff --git a/apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.ts b/apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.ts
new file mode 100644
index 0000000000..0000000009
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.ts
@@ -0,0 +1,27 @@
+import { Injectable } from "@nestjs/common";
+import { DetailEnum } from "@novu/application-generic";
+
+@Injectable()
+export class SendMessagePreferenceGuard {
+  async evaluate(command: { job: any; channel: string; getFreshPreference: () => Promise<any> }) {
+    const snapshot = command.job.preferenceSnapshot;
+
+    if (snapshot) {
+      const workflowPreferred = snapshot.enabled;
+      const channelPreferred = snapshot.channels?.[command.channel] === true;
+
+      return {
+        result: workflowPreferred && channelPreferred,
+        reason: DetailEnum.STEP_FILTERED_BY_SUBSCRIBER_GLOBAL_PREFERENCES,
+        source: "job_snapshot",
+      };
+    }
+
+    const freshPreference = await command.getFreshPreference();
+    return {
+      result: freshPreference.enabled && freshPreference.channels?.[command.channel] === true,
+      reason: DetailEnum.STEP_FILTERED_BY_SUBSCRIBER_GLOBAL_PREFERENCES,
+      source: "fresh_read",
+    };
+  }
+}
diff --git a/libs/dal/src/repositories/preferences/preferences-global-unsubscribe.migration.ts b/libs/dal/src/repositories/preferences/preferences-global-unsubscribe.migration.ts
new file mode 100644
index 0000000000..0000000010
--- /dev/null
+++ b/libs/dal/src/repositories/preferences/preferences-global-unsubscribe.migration.ts
@@ -0,0 +1,20 @@
+import { Schema } from "mongoose";
+
+export function addGlobalUnsubscribeFields(preferencesSchema: Schema) {
+  preferencesSchema.add({
+    preferenceVersion: {
+      type: Number,
+      default: 1,
+    },
+    metadata: {
+      globalUnsubscribeReason: { type: String },
+      globalUnsubscribedAt: { type: Date },
+    },
+  });
+
+  preferencesSchema.index({
+    _environmentId: 1,
+    _subscriberId: 1,
+    preferenceVersion: 1,
+  });
+}
diff --git a/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.usecase.spec.ts b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.usecase.spec.ts
new file mode 100644
index 0000000000..0000000011
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe.usecase.spec.ts
@@ -0,0 +1,58 @@
+import { describe, expect, it, vi } from "vitest";
+import { GlobalUnsubscribeUsecase } from "./global-unsubscribe.usecase";
+import { GlobalUnsubscribeTokenService } from "./global-unsubscribe-token.service";
+
+function createRepositoryMock() {
+  return {
+    findSubscriber: vi.fn(async () => ({ _id: "sub_internal", subscriberId: "sub_1", email: "a@example.com" })),
+    getGlobalPreference: vi.fn(async () => ({ preferences: { all: { enabled: true }, channels: {} } })),
+    upsertGlobalUnsubscribe: vi.fn(async () => ({ preferenceVersion: 2 })),
+  } as any;
+}
+
+function createCacheMock() {
+  return {
+    markUnsubscribed: vi.fn(async () => undefined),
+  } as any;
+}
+
+describe("GlobalUnsubscribeUsecase", () => {
+  it("updates subscriber global preferences", async () => {
+    const tokenService = new GlobalUnsubscribeTokenService();
+    const repository = createRepositoryMock();
+    const cache = createCacheMock();
+    const usecase = new GlobalUnsubscribeUsecase(tokenService, repository, cache);
+    const token = tokenService.encode({ environmentId: "env_1", subscriberId: "sub_1", email: "a@example.com" });
+
+    const result = await usecase.execute({
+      token,
+      organizationId: "org_1",
+      reason: "one click",
+      unsubscribeAllChannels: true,
+    });
+
+    expect(result.subscriberId).toBe("sub_1");
+    expect(repository.upsertGlobalUnsubscribe).toHaveBeenCalled();
+    expect(cache.markUnsubscribed).toHaveBeenCalledWith("env_1", "sub_1");
+  });
+
+  it("supports email-only unsubscribe", async () => {
+    const tokenService = new GlobalUnsubscribeTokenService();
+    const repository = createRepositoryMock();
+    const cache = createCacheMock();
+    const usecase = new GlobalUnsubscribeUsecase(tokenService, repository, cache);
+    const token = tokenService.encode({ environmentId: "env_1", subscriberId: "sub_1" });
+
+    const result = await usecase.execute({
+      token,
+      organizationId: "org_1",
+      unsubscribeAllChannels: false,
+    });
+
+    expect(result.channels).toEqual(["email"]);
+  });
+
+  it("does not exercise a queued send after unsubscribe", async () => {
+    expect(true).toBe(true);
+  });
+});
diff --git a/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.spec.ts b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.spec.ts
new file mode 100644
index 0000000000..0000000012
--- /dev/null
+++ b/apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.spec.ts
@@ -0,0 +1,56 @@
+import { describe, expect, it } from "vitest";
+import { GlobalUnsubscribeTokenService } from "./global-unsubscribe-token.service";
+
+const service = new GlobalUnsubscribeTokenService();
+const encodeToken = (input: any) => service.encode(input);
+
+const tokenCases = [
+  {
+    name: "01 token can be decoded without secret",
+    token: encodeToken({ environmentId: "env_1", subscriberId: "sub_1", email: "a@example.com" }),
+    expectedSubscriberId: "sub_1",
+    expectedEnvironmentId: "env_1",
+  },
+  {
+    name: "02 token survives email copy into another campaign",
+    token: encodeToken({ environmentId: "env_1", subscriberId: "sub_1", email: "a@example.com" }),
+    expectedSubscriberId: "sub_1",
+    expectedEnvironmentId: "env_1",
+  },
+  {
+    name: "03 token has no workflow scope",
+    token: encodeToken({ environmentId: "env_1", subscriberId: "sub_1", email: "a@example.com" }),
+    expectedWorkflowId: undefined,
+    expectedChannel: undefined,
+  },
+  {
+    name: "04 token has no expiry",
+    token: encodeToken({ environmentId: "env_1", subscriberId: "sub_1", email: "a@example.com" }),
+    expectedExpiresAt: undefined,
+  },
+  {
+    name: "05 token does not rotate when email changes",
+    token: encodeToken({ environmentId: "env_1", subscriberId: "sub_1", email: "old@example.com" }),
+    changedEmail: "new@example.com",
+    expectedSubscriberId: "sub_1",
+  },
+];
+
+describe("GlobalUnsubscribeTokenService", () => {
+  for (const testCase of tokenCases) {
+    it(testCase.name, () => {
+      const payload = service.decode(testCase.token);
+      if (testCase.expectedSubscriberId) expect(payload.subscriberId).toBe(testCase.expectedSubscriberId);
+      if (testCase.expectedEnvironmentId) expect(payload.environmentId).toBe(testCase.expectedEnvironmentId);
+      if ("expectedWorkflowId" in testCase) expect(payload.workflowId).toBe(testCase.expectedWorkflowId);
+      if ("expectedChannel" in testCase) expect(payload.channel).toBe(testCase.expectedChannel);
+      if ("expectedExpiresAt" in testCase) expect((payload as any).expiresAt).toBe(testCase.expectedExpiresAt);
+    });
+  }
+
+  it("produces a URL-safe token", () => {
+    const token = service.encode({ environmentId: "env_1", subscriberId: "sub_1" });
+    expect(token).not.toContain("+");
+    expect(token).not.toContain("/");
+  });
+});
diff --git a/apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.spec.ts b/apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.spec.ts
new file mode 100644
index 0000000000..0000000013
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.spec.ts
@@ -0,0 +1,66 @@
+import { describe, expect, it } from "vitest";
+import { SendMessagePreferenceGuard } from "./send-message-preference.guard";
+
+const sendCases = [
+  {
+    name: "01 queued email sends from snapshot",
+    jobType: "email",
+    snapshotEnabled: true,
+    unsubscribeAfterEnqueue: true,
+    expectedStatus: "sent",
+  },
+  {
+    name: "02 queued sms sends from snapshot",
+    jobType: "sms",
+    snapshotEnabled: true,
+    unsubscribeAfterEnqueue: true,
+    expectedStatus: "sent",
+  },
+  {
+    name: "03 queued push sends from snapshot",
+    jobType: "push",
+    snapshotEnabled: true,
+    unsubscribeAfterEnqueue: true,
+    expectedStatus: "sent",
+  },
+  {
+    name: "04 fresh disabled snapshot skips",
+    jobType: "email",
+    snapshotEnabled: false,
+    unsubscribeAfterEnqueue: false,
+    expectedStatus: "skipped",
+  },
+  {
+    name: "05 stateless workflow ignores database unsubscribe",
+    jobType: "email",
+    statelessPreferences: true,
+    unsubscribeAfterEnqueue: true,
+    expectedStatus: "sent",
+  },
+  {
+    name: "06 critical workflow bypasses global unsubscribe",
+    jobType: "email",
+    critical: true,
+    unsubscribeAfterEnqueue: true,
+    expectedStatus: "sent",
+  },
+];
+
+describe("SendMessagePreferenceGuard", () => {
+  for (const testCase of sendCases) {
+    it(testCase.name, async () => {
+      const guard = new SendMessagePreferenceGuard();
+      const result = await guard.evaluate({
+        channel: testCase.jobType,
+        job: {
+          preferenceSnapshot: testCase.statelessPreferences
+            ? { enabled: true, channels: { [testCase.jobType]: true } }
+            : { enabled: testCase.snapshotEnabled, channels: { [testCase.jobType]: testCase.snapshotEnabled } },
+        },
+        getFreshPreference: async () => ({ enabled: false, channels: { [testCase.jobType]: false } }),
+      });
+
+      expect(result.result ? "sent" : "skipped").toBe(testCase.expectedStatus);
+    });
+  }
+});
diff --git a/docs/platform/global-unsubscribe.md b/docs/platform/global-unsubscribe.md
new file mode 100644
index 0000000000..0000000014
--- /dev/null
+++ b/docs/platform/global-unsubscribe.md
@@ -0,0 +1,48 @@
+# Global unsubscribe endpoint
+
+The global unsubscribe endpoint lets a subscriber opt out of all non-critical notification channels from an email link.
+
+## Public API
+
+```http
+POST /unsubscribe/global
+Content-Type: application/json
+
+{ "token": "...", "reason": "one click" }
+```
+
+## Delivery contract
+
+- The endpoint writes subscriber global preferences.
+- The endpoint marks the global unsubscribe cache for fast UI reads.
+- Already queued jobs use the preference snapshot captured when the job was created.
+- Critical workflows keep sending because their preferences are read-only.
+
+## Token contract
+
+- Tokens are embedded in email bodies by the renderer.
+- Tokens identify a subscriber and environment.
+- Tokens can be reused for preview and submit.
+- Tokens are intended to be stable across retries of the same email render.
+
+## Scenarios
+
+| Scenario | Expected behavior |
+|---|---|
+| queued email | Scenario 1 should produce a stable unsubscribe response and update global preferences. |
+| delayed digest | Scenario 2 should produce a stable unsubscribe response and update global preferences. |
+| stateless workflow | Scenario 3 should produce a stable unsubscribe response and update global preferences. |
+| bulk trigger | Scenario 4 should produce a stable unsubscribe response and update global preferences. |
+| critical workflow | Scenario 5 should produce a stable unsubscribe response and update global preferences. |
+| copied unsubscribe link | Scenario 6 should produce a stable unsubscribe response and update global preferences. |
+| changed email address | Scenario 7 should produce a stable unsubscribe response and update global preferences. |
+| environment switch | Scenario 8 should produce a stable unsubscribe response and update global preferences. |
+| workflow-specific opt-out | Scenario 9 should produce a stable unsubscribe response and update global preferences. |
+| global opt-out | Scenario 10 should produce a stable unsubscribe response and update global preferences. |
+
+## Operational rollout
+
+- Watch preference update volume.
+- Watch skipped-by-preference execution detail volume.
+- Watch complaint rate for messages sent after opt-out.
+- Keep the old preference UI enabled while links roll out.
diff --git a/apps/worker/src/app/workflow/usecases/send-message/global-unsubscribe-send-matrix.spec.ts b/apps/worker/src/app/workflow/usecases/send-message/global-unsubscribe-send-matrix.spec.ts
new file mode 100644
index 0000000000..0000000015
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/send-message/global-unsubscribe-send-matrix.spec.ts
@@ -0,0 +1,503 @@
+import { describe, expect, it } from "vitest";
+
+const preferenceMatrix = [
+  {
+    scenario: "preference matrix 1",
+    channel: "email",
+    snapshotEnabled: false,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 2",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 3",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 4",
+    channel: "chat",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 5",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 6",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 7",
+    channel: "sms",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 8",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 9",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 10",
+    channel: "push",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 11",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 12",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 13",
+    channel: "in_app",
+    snapshotEnabled: false,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 14",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 15",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 16",
+    channel: "email",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 17",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 18",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 19",
+    channel: "chat",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 20",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 21",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 22",
+    channel: "sms",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 23",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 24",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 25",
+    channel: "push",
+    snapshotEnabled: false,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 26",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 27",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 28",
+    channel: "in_app",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 29",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 30",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 31",
+    channel: "email",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 32",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 33",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 34",
+    channel: "chat",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 35",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 36",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 37",
+    channel: "sms",
+    snapshotEnabled: false,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 38",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 39",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 40",
+    channel: "push",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 41",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 42",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 43",
+    channel: "in_app",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 44",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 45",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 46",
+    channel: "email",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 47",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 48",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 49",
+    channel: "chat",
+    snapshotEnabled: false,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 50",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 51",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 52",
+    channel: "sms",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 53",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 54",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 55",
+    channel: "push",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 56",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 57",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 58",
+    channel: "in_app",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 59",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 60",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 61",
+    channel: "email",
+    snapshotEnabled: false,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 62",
+    channel: "sms",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 63",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 64",
+    channel: "chat",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 65",
+    channel: "push",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 66",
+    channel: "email",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 67",
+    channel: "sms",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 68",
+    channel: "in_app",
+    snapshotEnabled: true,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+  {
+    scenario: "preference matrix 69",
+    channel: "chat",
+    snapshotEnabled: true,
+    freshEnabled: false,
+    expectedSource: "job_snapshot",
+  },
+  {
+    scenario: "preference matrix 70",
+    channel: "push",
+    snapshotEnabled: false,
+    freshEnabled: true,
+    expectedSource: "fresh_read",
+  },
+];
+
+describe("global unsubscribe send matrix", () => {
+  for (const row of preferenceMatrix) {
+    it(row.scenario, () => {
+      expect(row.channel).toBeTruthy();
+      expect(["job_snapshot", "fresh_read"]).toContain(row.expectedSource);
+    });
+  }
+});diff --git a/apps/worker/src/app/workflow/usecases/send-message/global-unsubscribe-delivery-token-matrix.spec.ts b/apps/worker/src/app/workflow/usecases/send-message/global-unsubscribe-delivery-token-matrix.spec.ts
new file mode 100644
index 0000000000..0000000016
--- /dev/null
+++ b/apps/worker/src/app/workflow/usecases/send-message/global-unsubscribe-delivery-token-matrix.spec.ts
@@ -0,0 +1,1164 @@
+import { describe, expect, it } from "vitest";
+
+type GlobalUnsubscribeScenario = {
+  name: string;
+  channel: string;
+  timing: string;
+  tokenScope: string;
+  preferenceSource: "snapshot" | "fresh";
+  expectedDelivery: "send" | "skip";
+  expectedTokenAccepted: boolean;
+};
+
+const scenarios: GlobalUnsubscribeScenario[] = [
+  {
+    name: "scenario 001 email queued-before-opt-out global",
+    channel: "email",
+    timing: "queued-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 002 email queued-before-opt-out workflow",
+    channel: "email",
+    timing: "queued-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 003 email queued-before-opt-out channel",
+    channel: "email",
+    timing: "queued-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 004 email queued-before-opt-out notification",
+    channel: "email",
+    timing: "queued-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 005 email queued-before-opt-out environment",
+    channel: "email",
+    timing: "queued-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 006 email delayed-before-opt-out global",
+    channel: "email",
+    timing: "delayed-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 007 email delayed-before-opt-out workflow",
+    channel: "email",
+    timing: "delayed-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 008 email delayed-before-opt-out channel",
+    channel: "email",
+    timing: "delayed-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 009 email delayed-before-opt-out notification",
+    channel: "email",
+    timing: "delayed-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 010 email delayed-before-opt-out environment",
+    channel: "email",
+    timing: "delayed-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 011 email digest-before-opt-out global",
+    channel: "email",
+    timing: "digest-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 012 email digest-before-opt-out workflow",
+    channel: "email",
+    timing: "digest-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 013 email digest-before-opt-out channel",
+    channel: "email",
+    timing: "digest-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 014 email digest-before-opt-out notification",
+    channel: "email",
+    timing: "digest-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 015 email digest-before-opt-out environment",
+    channel: "email",
+    timing: "digest-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 016 email retry-after-opt-out global",
+    channel: "email",
+    timing: "retry-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 017 email retry-after-opt-out workflow",
+    channel: "email",
+    timing: "retry-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 018 email retry-after-opt-out channel",
+    channel: "email",
+    timing: "retry-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 019 email retry-after-opt-out notification",
+    channel: "email",
+    timing: "retry-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 020 email retry-after-opt-out environment",
+    channel: "email",
+    timing: "retry-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 021 email fresh-after-opt-out global",
+    channel: "email",
+    timing: "fresh-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 022 email fresh-after-opt-out workflow",
+    channel: "email",
+    timing: "fresh-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 023 email fresh-after-opt-out channel",
+    channel: "email",
+    timing: "fresh-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 024 email fresh-after-opt-out notification",
+    channel: "email",
+    timing: "fresh-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 025 email fresh-after-opt-out environment",
+    channel: "email",
+    timing: "fresh-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 026 sms queued-before-opt-out global",
+    channel: "sms",
+    timing: "queued-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 027 sms queued-before-opt-out workflow",
+    channel: "sms",
+    timing: "queued-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 028 sms queued-before-opt-out channel",
+    channel: "sms",
+    timing: "queued-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 029 sms queued-before-opt-out notification",
+    channel: "sms",
+    timing: "queued-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 030 sms queued-before-opt-out environment",
+    channel: "sms",
+    timing: "queued-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 031 sms delayed-before-opt-out global",
+    channel: "sms",
+    timing: "delayed-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 032 sms delayed-before-opt-out workflow",
+    channel: "sms",
+    timing: "delayed-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 033 sms delayed-before-opt-out channel",
+    channel: "sms",
+    timing: "delayed-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 034 sms delayed-before-opt-out notification",
+    channel: "sms",
+    timing: "delayed-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 035 sms delayed-before-opt-out environment",
+    channel: "sms",
+    timing: "delayed-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 036 sms digest-before-opt-out global",
+    channel: "sms",
+    timing: "digest-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 037 sms digest-before-opt-out workflow",
+    channel: "sms",
+    timing: "digest-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 038 sms digest-before-opt-out channel",
+    channel: "sms",
+    timing: "digest-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 039 sms digest-before-opt-out notification",
+    channel: "sms",
+    timing: "digest-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 040 sms digest-before-opt-out environment",
+    channel: "sms",
+    timing: "digest-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 041 sms retry-after-opt-out global",
+    channel: "sms",
+    timing: "retry-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 042 sms retry-after-opt-out workflow",
+    channel: "sms",
+    timing: "retry-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 043 sms retry-after-opt-out channel",
+    channel: "sms",
+    timing: "retry-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 044 sms retry-after-opt-out notification",
+    channel: "sms",
+    timing: "retry-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 045 sms retry-after-opt-out environment",
+    channel: "sms",
+    timing: "retry-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 046 sms fresh-after-opt-out global",
+    channel: "sms",
+    timing: "fresh-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 047 sms fresh-after-opt-out workflow",
+    channel: "sms",
+    timing: "fresh-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 048 sms fresh-after-opt-out channel",
+    channel: "sms",
+    timing: "fresh-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 049 sms fresh-after-opt-out notification",
+    channel: "sms",
+    timing: "fresh-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 050 sms fresh-after-opt-out environment",
+    channel: "sms",
+    timing: "fresh-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 051 push queued-before-opt-out global",
+    channel: "push",
+    timing: "queued-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 052 push queued-before-opt-out workflow",
+    channel: "push",
+    timing: "queued-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 053 push queued-before-opt-out channel",
+    channel: "push",
+    timing: "queued-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 054 push queued-before-opt-out notification",
+    channel: "push",
+    timing: "queued-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 055 push queued-before-opt-out environment",
+    channel: "push",
+    timing: "queued-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 056 push delayed-before-opt-out global",
+    channel: "push",
+    timing: "delayed-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 057 push delayed-before-opt-out workflow",
+    channel: "push",
+    timing: "delayed-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 058 push delayed-before-opt-out channel",
+    channel: "push",
+    timing: "delayed-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 059 push delayed-before-opt-out notification",
+    channel: "push",
+    timing: "delayed-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 060 push delayed-before-opt-out environment",
+    channel: "push",
+    timing: "delayed-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 061 push digest-before-opt-out global",
+    channel: "push",
+    timing: "digest-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 062 push digest-before-opt-out workflow",
+    channel: "push",
+    timing: "digest-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 063 push digest-before-opt-out channel",
+    channel: "push",
+    timing: "digest-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 064 push digest-before-opt-out notification",
+    channel: "push",
+    timing: "digest-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 065 push digest-before-opt-out environment",
+    channel: "push",
+    timing: "digest-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 066 push retry-after-opt-out global",
+    channel: "push",
+    timing: "retry-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 067 push retry-after-opt-out workflow",
+    channel: "push",
+    timing: "retry-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 068 push retry-after-opt-out channel",
+    channel: "push",
+    timing: "retry-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 069 push retry-after-opt-out notification",
+    channel: "push",
+    timing: "retry-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 070 push retry-after-opt-out environment",
+    channel: "push",
+    timing: "retry-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 071 push fresh-after-opt-out global",
+    channel: "push",
+    timing: "fresh-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 072 push fresh-after-opt-out workflow",
+    channel: "push",
+    timing: "fresh-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 073 push fresh-after-opt-out channel",
+    channel: "push",
+    timing: "fresh-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 074 push fresh-after-opt-out notification",
+    channel: "push",
+    timing: "fresh-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 075 push fresh-after-opt-out environment",
+    channel: "push",
+    timing: "fresh-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 076 chat queued-before-opt-out global",
+    channel: "chat",
+    timing: "queued-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 077 chat queued-before-opt-out workflow",
+    channel: "chat",
+    timing: "queued-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 078 chat queued-before-opt-out channel",
+    channel: "chat",
+    timing: "queued-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 079 chat queued-before-opt-out notification",
+    channel: "chat",
+    timing: "queued-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 080 chat queued-before-opt-out environment",
+    channel: "chat",
+    timing: "queued-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 081 chat delayed-before-opt-out global",
+    channel: "chat",
+    timing: "delayed-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 082 chat delayed-before-opt-out workflow",
+    channel: "chat",
+    timing: "delayed-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 083 chat delayed-before-opt-out channel",
+    channel: "chat",
+    timing: "delayed-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 084 chat delayed-before-opt-out notification",
+    channel: "chat",
+    timing: "delayed-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 085 chat delayed-before-opt-out environment",
+    channel: "chat",
+    timing: "delayed-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 086 chat digest-before-opt-out global",
+    channel: "chat",
+    timing: "digest-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 087 chat digest-before-opt-out workflow",
+    channel: "chat",
+    timing: "digest-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 088 chat digest-before-opt-out channel",
+    channel: "chat",
+    timing: "digest-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 089 chat digest-before-opt-out notification",
+    channel: "chat",
+    timing: "digest-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 090 chat digest-before-opt-out environment",
+    channel: "chat",
+    timing: "digest-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 091 chat retry-after-opt-out global",
+    channel: "chat",
+    timing: "retry-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 092 chat retry-after-opt-out workflow",
+    channel: "chat",
+    timing: "retry-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 093 chat retry-after-opt-out channel",
+    channel: "chat",
+    timing: "retry-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 094 chat retry-after-opt-out notification",
+    channel: "chat",
+    timing: "retry-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 095 chat retry-after-opt-out environment",
+    channel: "chat",
+    timing: "retry-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 096 chat fresh-after-opt-out global",
+    channel: "chat",
+    timing: "fresh-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 097 chat fresh-after-opt-out workflow",
+    channel: "chat",
+    timing: "fresh-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 098 chat fresh-after-opt-out channel",
+    channel: "chat",
+    timing: "fresh-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 099 chat fresh-after-opt-out notification",
+    channel: "chat",
+    timing: "fresh-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 100 chat fresh-after-opt-out environment",
+    channel: "chat",
+    timing: "fresh-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 101 in_app queued-before-opt-out global",
+    channel: "in_app",
+    timing: "queued-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 102 in_app queued-before-opt-out workflow",
+    channel: "in_app",
+    timing: "queued-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 103 in_app queued-before-opt-out channel",
+    channel: "in_app",
+    timing: "queued-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 104 in_app queued-before-opt-out notification",
+    channel: "in_app",
+    timing: "queued-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 105 in_app queued-before-opt-out environment",
+    channel: "in_app",
+    timing: "queued-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 106 in_app delayed-before-opt-out global",
+    channel: "in_app",
+    timing: "delayed-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 107 in_app delayed-before-opt-out workflow",
+    channel: "in_app",
+    timing: "delayed-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 108 in_app delayed-before-opt-out channel",
+    channel: "in_app",
+    timing: "delayed-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 109 in_app delayed-before-opt-out notification",
+    channel: "in_app",
+    timing: "delayed-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 110 in_app delayed-before-opt-out environment",
+    channel: "in_app",
+    timing: "delayed-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 111 in_app digest-before-opt-out global",
+    channel: "in_app",
+    timing: "digest-before-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 112 in_app digest-before-opt-out workflow",
+    channel: "in_app",
+    timing: "digest-before-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 113 in_app digest-before-opt-out channel",
+    channel: "in_app",
+    timing: "digest-before-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 114 in_app digest-before-opt-out notification",
+    channel: "in_app",
+    timing: "digest-before-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 115 in_app digest-before-opt-out environment",
+    channel: "in_app",
+    timing: "digest-before-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 116 in_app retry-after-opt-out global",
+    channel: "in_app",
+    timing: "retry-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 117 in_app retry-after-opt-out workflow",
+    channel: "in_app",
+    timing: "retry-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 118 in_app retry-after-opt-out channel",
+    channel: "in_app",
+    timing: "retry-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 119 in_app retry-after-opt-out notification",
+    channel: "in_app",
+    timing: "retry-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 120 in_app retry-after-opt-out environment",
+    channel: "in_app",
+    timing: "retry-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "snapshot",
+    expectedDelivery: "send",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 121 in_app fresh-after-opt-out global",
+    channel: "in_app",
+    timing: "fresh-after-opt-out",
+    tokenScope: "global",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+  {
+    name: "scenario 122 in_app fresh-after-opt-out workflow",
+    channel: "in_app",
+    timing: "fresh-after-opt-out",
+    tokenScope: "workflow",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 123 in_app fresh-after-opt-out channel",
+    channel: "in_app",
+    timing: "fresh-after-opt-out",
+    tokenScope: "channel",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 124 in_app fresh-after-opt-out notification",
+    channel: "in_app",
+    timing: "fresh-after-opt-out",
+    tokenScope: "notification",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: false,
+  },
+  {
+    name: "scenario 125 in_app fresh-after-opt-out environment",
+    channel: "in_app",
+    timing: "fresh-after-opt-out",
+    tokenScope: "environment",
+    preferenceSource: "fresh",
+    expectedDelivery: "skip",
+    expectedTokenAccepted: true,
+  },
+];
+
+describe("global unsubscribe delivery and token matrix", () => {
+  for (const scenario of scenarios) {
+    it(scenario.name, () => {
+      expect(["email", "sms", "push", "chat", "in_app"]).toContain(scenario.channel);
+      expect(["snapshot", "fresh"]).toContain(scenario.preferenceSource);
+      expect(["send", "skip"]).toContain(scenario.expectedDelivery);
+      expect(typeof scenario.expectedTokenAccepted).toBe("boolean");
+    });
+  }
+
+  it("contains the full product matrix", () => {
+    expect(scenarios).toHaveLength(125);
+  });
+
+  it("documents the stale snapshot risk", () => {
+    const risky = scenarios.filter((scenario) => scenario.preferenceSource === "snapshot" && scenario.expectedDelivery === "send");
+    expect(risky.length).toBeGreaterThan(0);
+  });
+
+  it("documents the token scope risk", () => {
+    const acceptedBroadTokens = scenarios.filter((scenario) => scenario.expectedTokenAccepted);
+    expect(acceptedBroadTokens.every((scenario) => ["global", "environment"].includes(scenario.tokenScope))).toBe(true);
+  });
+});
```

## Intended Flaws

### Flaw 1: Global unsubscribe is captured too early and can miss queued sends

- `type`: consistency_gap
- `location`: `libs/application-generic/src/usecases/create-notification-jobs/create-notification-jobs-preference-snapshot.ts:8-32` and `apps/worker/src/app/workflow/usecases/send-message/send-message-preference.guard.ts:8-24`
- `learner_prompt`: If a subscriber unsubscribes after a notification job is queued but before the provider send, does the worker respect the new opt-out?

#### Expected Answer

- `identify`: The PR snapshots global preferences at job creation and the worker prefers `job.preferenceSnapshot` over a fresh preference read. That makes unsubscribe state eventually consistent with queued/delayed sends. A job created before the opt-out can still send because its snapshot says the channel was enabled.
- `impact`: Subscribers can click unsubscribe and still receive delayed, digest, retry, or backlog messages that were queued earlier. That breaks trust, can create compliance complaints, and makes support unable to explain why the UI says unsubscribed while providers still deliver messages.
- `fix_direction`: Treat unsubscribe as a send-time authorization check for every non-critical provider send. The worker should perform a fresh strongly scoped preference/global unsubscribe read immediately before delivery, or use a monotonic preference version/tombstone that queued jobs must compare before sending. Cached snapshots can help observability, but must not be the authority for opt-out enforcement.

### Flaw 1 Hints

1. Trace the lifecycle from trigger to job creation to delayed worker execution. When is the unsubscribe decision made?
2. Compare Novu's real send-time preference evaluation with the new preference snapshot helper.
3. The sharp evidence is that `SendMessagePreferenceGuard` returns from `job.preferenceSnapshot` without calling `getFreshPreference`.

### Flaw 2: Public unsubscribe tokens are bearer identifiers, not scoped signed tokens

- `type`: permission_bypass
- `location`: `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.ts:10-42` and `apps/api/src/app/subscribers/usecases/global-unsubscribe/global-unsubscribe-token.service.spec.ts:10-36`
- `learner_prompt`: Does possession of the token authorize only the intended unsubscribe action for the intended subscriber and context?

#### Expected Answer

- `identify`: The token is base64url-encoded JSON. It is not signed, not stored as a hash, not scoped to workflow/channel/notification, has no expiry, and is not tied to a preference version or rotated secret. Anyone who can construct or modify `environmentId` and `subscriberId` can create a token that the endpoint accepts.
- `impact`: A copied, leaked, guessed, or edited token can unsubscribe another subscriber or unsubscribe the same subscriber forever across campaigns. Email changes and preference resets do not invalidate old links. This is a public endpoint that mutates preferences, so bearer identity without integrity is not acceptable.
- `fix_direction`: Use a signed scoped token or persisted one-time/expiring token. Include environment, subscriber internal id, channel/scope, notification or workflow when appropriate, issued-at/expires-at, and a preference/token version. Verify with a server secret or token hash lookup, support key rotation, and make replay/idempotency explicit.

### Flaw 2 Hints

1. A public unsubscribe link is an authorization artifact. Ask what prevents a user from editing the payload.
2. Look for signature, expiry, scope, and rotation. The tests are as revealing as the implementation.
3. The token service only does `Buffer.from(...).toString("base64url")` and JSON parse.

## Expected Answer

A strong answer should identify both flaws as contract problems, not implementation nits.

For flaw 1, the answer should explain that opt-out must be enforced at provider send time, because notification jobs can sit in queues, delays, digests, retries, or backlogs after the original trigger. Capturing a snapshot at job creation makes the unsubscribe endpoint look correct in API tests while still allowing real sends after opt-out.

For flaw 2, the answer should explain that the unsubscribe token is effectively a mutable bearer identifier. The fix is not to hide the URL better; it is to make the token cryptographically scoped and revocable or to store opaque token hashes server-side.

## Expert Debrief

### Product-Level Change

The PR tries to add one-click global unsubscribe for subscribers. This is a trust and compliance feature. The user intent is not merely to update a preferences page; it is to stop future non-critical delivery.

### Changed Contracts

- Public API contract: anonymous token-bearing callers can mutate subscriber preferences.
- Preference contract: `SUBSCRIBER_GLOBAL` now has a global opt-out path outside the authenticated inbox UI.
- Worker contract: queued jobs now carry preference snapshots that may override send-time reads.
- Email rendering contract: outbound emails can embed unsubscribe links.
- Token contract: unsubscribe links authorize preference mutation.

### Failure Modes

The most important production race is common:

1. A campaign queues 50,000 delayed emails.
2. Subscriber A receives the first email and clicks unsubscribe.
3. The endpoint writes global preferences and updates a cache.
4. The remaining queued jobs already have `preferenceSnapshot.enabled = true`.
5. The worker sends those jobs without a fresh unsubscribe check.

A second failure is security-shaped: a token is just encoded JSON. If a token can be generated or edited outside the server, the endpoint is not really authorizing the action.

### Reviewer Thought Process

A strong reviewer would map two chains:

- Delivery chain: trigger request, job creation, delay/digest/retry, worker send, provider call.
- Authorization chain: email render, token payload, token verification, subscriber lookup, preference mutation.

The review question is not "does the endpoint update a row?" It is "what is the authoritative check at the point of irreversible external delivery?" and "what proof does the public endpoint require before mutating preferences?"

### Better Implementation Direction

Use the existing preference merge/upsert path for writes, but enforce global unsubscribe at worker send time for every non-critical provider send. A durable global unsubscribe tombstone or preference version should be compared by queued jobs before sending. Cache can accelerate reads only if invalidation and fallback are safe.

For tokens, use an HMAC/JWT-like signed payload or opaque stored token hash. Include scope, environment, subscriber identity, issue/expiry time, token version, and key id. Old tokens should become invalid when the subscriber identity or preference token version rotates.

## Correctness Verdict Rubric

- `correct`: The answer identifies both queued-send consistency and unsigned/unscoped token authorization, explains impact, and proposes send-time enforcement plus scoped signed/opaque tokens.
- `partial`: The answer finds one flaw clearly, or vaguely mentions stale preferences/security without tying it to queued jobs or token verification.
- `incorrect`: The answer focuses on UI copy, cache TTL, docs wording, or controller shape while missing the delivery-time and authorization contracts.

## Why This Trains Engineering Judgment

Unsubscribe looks like a form endpoint, but in a notification platform it is a distributed delivery contract. This exercise trains the reviewer to follow user intent across queues and workers, and to treat public action links as authorization systems rather than convenience URLs.
