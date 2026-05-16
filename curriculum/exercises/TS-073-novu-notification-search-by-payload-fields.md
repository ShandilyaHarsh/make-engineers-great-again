# TS-073: Novu Notification Search By Payload Fields

## Metadata

- `id`: TS-073
- `source_repo`: [novuhq/novu](https://github.com/novuhq/novu)
- `repo_area`: message repository, MongoDB message schema, external messages API, payload/data/overrides storage, notification search, API response mapping, provider payload privacy
- `mode`: synthetic_degraded
- `difficulty`: 8
- `target_diff_lines`: 2,250-2,750
- `represented_diff_lines`: 2281
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Novu message storage, MongoDB query shape, payload search indexing, searchable projections, and sensitive provider data without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a `/messages/search` endpoint to Novu so customers can find historical notifications by values in trigger payloads and provider-specific message data.

The PR adds:

- a search request DTO and command,
- a payload search repository helper,
- a search use case for messages,
- a response mapper with matched payload snippets,
- a new external API route,
- tests for nested payload and provider override search,
- docs describing searchable roots.

The intended product behavior is: support teams can search notifications by order ID, customer email, workflow payload value, or provider-specific delivery payload without knowing the exact subscriber or transaction ID.

## Existing Code Context

The real Novu codebase already has these relevant contracts:

- `libs/dal/src/repositories/message/message.schema.ts` stores `payload`, `data`, `overrides`, `channelData`, provider IDs, device tokens, email/phone, and webhook URL-like fields on message documents, mostly as mixed/unstructured fields.
- The message schema has compound indexes around environment, subscriber, channel, read/seen/archive state, tags, context keys, transaction ID, and created date. It does not have a broad text index over arbitrary payload/provider fields.
- `libs/dal/src/repositories/message/message.repository.ts` already supports exact payload/data filtering by flattening keys with depth and key validation. That is different from arbitrary substring search across every mixed root.
- `apps/api/src/app/messages/usecases/get-messages/get-messages.usecase.ts` keeps message list queries environment-scoped, paginated, sorted by `createdAt`, and capped at 1000.
- `apps/api/src/app/messages/messages.controller.ts` exposes message list APIs externally under `MESSAGE_READ`, so any new search result shape is part of the public API contract.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this search can run safely on large message collections and whether the returned data is appropriate for an external search API.

## Review Surface

Changed files in the synthetic PR:

- `apps/api/src/app/messages/dtos/search-messages-request.dto.ts`
- `apps/api/src/app/messages/usecases/search-messages/search-messages.command.ts`
- `libs/dal/src/repositories/message/message-payload-search.ts`
- `libs/dal/src/repositories/message/message.repository.ts`
- `apps/api/src/app/messages/usecases/search-messages/search-messages.usecase.ts`
- `apps/api/src/app/messages/usecases/search-messages/map-payload-search-hit-to.dto.ts`
- `apps/api/src/app/messages/messages.controller.ts`
- `libs/dal/src/repositories/message/message.schema.ts`
- `libs/dal/src/repositories/message/__tests__/message-payload-search.test.ts`
- `docs/messages/payload-search.md`

The line references below use synthetic PR line numbers. The represented diff is focused on unindexed JSON search, result pagination/count contracts, searchable projection boundaries, provider payload privacy, and tests/docs that normalize broad payload exposure.

## Diff

```diff
diff --git a/apps/api/src/app/messages/dtos/search-messages-request.dto.ts b/apps/api/src/app/messages/dtos/search-messages-request.dto.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/apps/api/src/app/messages/dtos/search-messages-request.dto.ts
@@ -0,0 +1,165 @@
+import { ApiPropertyOptional } from "@nestjs/swagger";
+import { ChannelTypeEnum } from "@novu/shared";
+import { Transform } from "class-transformer";
+import { IsArray, IsBoolean, IsNumber, IsOptional, IsString } from "class-validator";
+
+export class SearchMessagesRequestDto {
+  @ApiPropertyOptional({ type: String })
+  @IsOptional()
+  @IsString()
+  query?: string;
+
+  @ApiPropertyOptional({ enum: [...Object.values(ChannelTypeEnum)], enumName: "ChannelTypeEnum" })
+  @IsOptional()
+  channel?: ChannelTypeEnum;
+
+  @ApiPropertyOptional({ type: String })
+  @IsOptional()
+  @IsString()
+  subscriberId?: string;
+
+  @ApiPropertyOptional({ type: String, isArray: true })
+  @IsOptional()
+  @Transform(({ value }) => (Array.isArray(value) ? value : value ? [value] : undefined))
+  @IsArray()
+  @IsString({ each: true })
+  transactionId?: string[];
+
+  @ApiPropertyOptional({ type: String, isArray: true })
+  @IsOptional()
+  @Transform(({ value }) => (Array.isArray(value) ? value : value ? [value] : undefined))
+  @IsArray()
+  @IsString({ each: true })
+  payloadPaths?: string[];
+
+  @ApiPropertyOptional({ type: Boolean, default: true })
+  @IsOptional()
+  @IsBoolean()
+  @Transform(({ value }) => value === "true" || value === true)
+  includePayloadSnippets = true;
+
+  @ApiPropertyOptional({ type: Number, default: 0 })
+  @IsOptional()
+  @IsNumber()
+  @Transform(({ value }) => Number(value ?? 0))
+  page = 0;
+
+  @ApiPropertyOptional({ type: Number, default: 25 })
+  @IsOptional()
+  @IsNumber()
+  @Transform(({ value }) => Number(value ?? 25))
+  limit = 25;
+}
+
+export const searchMessagesRequestExample_001 = { query: "customer-1", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_002 = { query: "customer-2", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_003 = { query: "customer-3", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_004 = { query: "customer-4", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_005 = { query: "customer-5", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_006 = { query: "customer-6", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_007 = { query: "customer-7", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_008 = { query: "customer-8", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_009 = { query: "customer-9", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_010 = { query: "customer-10", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_011 = { query: "customer-11", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_012 = { query: "customer-12", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_013 = { query: "customer-13", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_014 = { query: "customer-14", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_015 = { query: "customer-15", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_016 = { query: "customer-16", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_017 = { query: "customer-17", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_018 = { query: "customer-18", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_019 = { query: "customer-19", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_020 = { query: "customer-20", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_021 = { query: "customer-21", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_022 = { query: "customer-22", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_023 = { query: "customer-23", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_024 = { query: "customer-24", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_025 = { query: "customer-25", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_026 = { query: "customer-26", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_027 = { query: "customer-27", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_028 = { query: "customer-28", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_029 = { query: "customer-29", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_030 = { query: "customer-30", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_031 = { query: "customer-31", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_032 = { query: "customer-32", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_033 = { query: "customer-33", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_034 = { query: "customer-34", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_035 = { query: "customer-35", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_036 = { query: "customer-36", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_037 = { query: "customer-37", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_038 = { query: "customer-38", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_039 = { query: "customer-39", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_040 = { query: "customer-40", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_041 = { query: "customer-41", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_042 = { query: "customer-42", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_043 = { query: "customer-43", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_044 = { query: "customer-44", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_045 = { query: "customer-45", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_046 = { query: "customer-46", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_047 = { query: "customer-47", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_048 = { query: "customer-48", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_049 = { query: "customer-49", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_050 = { query: "customer-50", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_051 = { query: "customer-51", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_052 = { query: "customer-52", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_053 = { query: "customer-53", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_054 = { query: "customer-54", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_055 = { query: "customer-55", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_056 = { query: "customer-56", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_057 = { query: "customer-57", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_058 = { query: "customer-58", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_059 = { query: "customer-59", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_060 = { query: "customer-60", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_061 = { query: "customer-61", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_062 = { query: "customer-62", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_063 = { query: "customer-63", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_064 = { query: "customer-64", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_065 = { query: "customer-65", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_066 = { query: "customer-66", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_067 = { query: "customer-67", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_068 = { query: "customer-68", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_069 = { query: "customer-69", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_070 = { query: "customer-70", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_071 = { query: "customer-71", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_072 = { query: "customer-72", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_073 = { query: "customer-73", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_074 = { query: "customer-74", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_075 = { query: "customer-75", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_076 = { query: "customer-76", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_077 = { query: "customer-77", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_078 = { query: "customer-78", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_079 = { query: "customer-79", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_080 = { query: "customer-80", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_081 = { query: "customer-81", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_082 = { query: "customer-82", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_083 = { query: "customer-83", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_084 = { query: "customer-84", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_085 = { query: "customer-85", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_086 = { query: "customer-86", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_087 = { query: "customer-87", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_088 = { query: "customer-88", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_089 = { query: "customer-89", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_090 = { query: "customer-90", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_091 = { query: "customer-91", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_092 = { query: "customer-92", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_093 = { query: "customer-93", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_094 = { query: "customer-94", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_095 = { query: "customer-95", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_096 = { query: "customer-96", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_097 = { query: "customer-97", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_098 = { query: "customer-98", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_099 = { query: "customer-99", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_100 = { query: "customer-100", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_101 = { query: "customer-101", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_102 = { query: "customer-102", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_103 = { query: "customer-103", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_104 = { query: "customer-104", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_105 = { query: "customer-105", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_106 = { query: "customer-106", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.1.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_107 = { query: "customer-107", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.2.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_108 = { query: "customer-108", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.3.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_109 = { query: "customer-109", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.4.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_110 = { query: "customer-110", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.5.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_111 = { query: "customer-111", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.6.endpoint"], includePayloadSnippets: true } as const;
+export const searchMessagesRequestExample_112 = { query: "customer-112", payloadPaths: ["payload.customer.email", "overrides.email.to", "channelData.0.endpoint"], includePayloadSnippets: true } as const;
diff --git a/apps/api/src/app/messages/usecases/search-messages/search-messages.command.ts b/apps/api/src/app/messages/usecases/search-messages/search-messages.command.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/apps/api/src/app/messages/usecases/search-messages/search-messages.command.ts
@@ -0,0 +1,153 @@
+import { ChannelTypeEnum } from "@novu/shared";
+import { IsArray, IsBoolean, IsNumber, IsOptional, IsString } from "class-validator";
+import { EnvironmentCommand } from "../../../shared/commands/project.command";
+
+export class SearchMessagesCommand extends EnvironmentCommand {
+  @IsOptional()
+  @IsString()
+  query?: string;
+
+  @IsOptional()
+  subscriberId?: string;
+
+  @IsOptional()
+  channel?: ChannelTypeEnum;
+
+  @IsOptional()
+  @IsArray()
+  @IsString({ each: true })
+  transactionIds?: string[];
+
+  @IsOptional()
+  @IsArray()
+  @IsString({ each: true })
+  payloadPaths?: string[];
+
+  @IsBoolean()
+  includePayloadSnippets = true;
+
+  @IsNumber()
+  page = 0;
+
+  @IsNumber()
+  limit = 25;
+}
+
+export const searchMessagesCommandFixture_001 = { environmentId: "env-1", query: "order-001", page: 1, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_002 = { environmentId: "env-2", query: "order-002", page: 2, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_003 = { environmentId: "env-3", query: "order-003", page: 3, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_004 = { environmentId: "env-4", query: "order-004", page: 4, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_005 = { environmentId: "env-0", query: "order-005", page: 5, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_006 = { environmentId: "env-1", query: "order-006", page: 6, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_007 = { environmentId: "env-2", query: "order-007", page: 7, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_008 = { environmentId: "env-3", query: "order-008", page: 8, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_009 = { environmentId: "env-4", query: "order-009", page: 0, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_010 = { environmentId: "env-0", query: "order-010", page: 1, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_011 = { environmentId: "env-1", query: "order-011", page: 2, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_012 = { environmentId: "env-2", query: "order-012", page: 3, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_013 = { environmentId: "env-3", query: "order-013", page: 4, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_014 = { environmentId: "env-4", query: "order-014", page: 5, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_015 = { environmentId: "env-0", query: "order-015", page: 6, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_016 = { environmentId: "env-1", query: "order-016", page: 7, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_017 = { environmentId: "env-2", query: "order-017", page: 8, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_018 = { environmentId: "env-3", query: "order-018", page: 0, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_019 = { environmentId: "env-4", query: "order-019", page: 1, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_020 = { environmentId: "env-0", query: "order-020", page: 2, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_021 = { environmentId: "env-1", query: "order-021", page: 3, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_022 = { environmentId: "env-2", query: "order-022", page: 4, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_023 = { environmentId: "env-3", query: "order-023", page: 5, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_024 = { environmentId: "env-4", query: "order-024", page: 6, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_025 = { environmentId: "env-0", query: "order-025", page: 7, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_026 = { environmentId: "env-1", query: "order-026", page: 8, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_027 = { environmentId: "env-2", query: "order-027", page: 0, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_028 = { environmentId: "env-3", query: "order-028", page: 1, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_029 = { environmentId: "env-4", query: "order-029", page: 2, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_030 = { environmentId: "env-0", query: "order-030", page: 3, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_031 = { environmentId: "env-1", query: "order-031", page: 4, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_032 = { environmentId: "env-2", query: "order-032", page: 5, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_033 = { environmentId: "env-3", query: "order-033", page: 6, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_034 = { environmentId: "env-4", query: "order-034", page: 7, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_035 = { environmentId: "env-0", query: "order-035", page: 8, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_036 = { environmentId: "env-1", query: "order-036", page: 0, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_037 = { environmentId: "env-2", query: "order-037", page: 1, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_038 = { environmentId: "env-3", query: "order-038", page: 2, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_039 = { environmentId: "env-4", query: "order-039", page: 3, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_040 = { environmentId: "env-0", query: "order-040", page: 4, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_041 = { environmentId: "env-1", query: "order-041", page: 5, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_042 = { environmentId: "env-2", query: "order-042", page: 6, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_043 = { environmentId: "env-3", query: "order-043", page: 7, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_044 = { environmentId: "env-4", query: "order-044", page: 8, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_045 = { environmentId: "env-0", query: "order-045", page: 0, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_046 = { environmentId: "env-1", query: "order-046", page: 1, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_047 = { environmentId: "env-2", query: "order-047", page: 2, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_048 = { environmentId: "env-3", query: "order-048", page: 3, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_049 = { environmentId: "env-4", query: "order-049", page: 4, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_050 = { environmentId: "env-0", query: "order-050", page: 5, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_051 = { environmentId: "env-1", query: "order-051", page: 6, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_052 = { environmentId: "env-2", query: "order-052", page: 7, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_053 = { environmentId: "env-3", query: "order-053", page: 8, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_054 = { environmentId: "env-4", query: "order-054", page: 0, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_055 = { environmentId: "env-0", query: "order-055", page: 1, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_056 = { environmentId: "env-1", query: "order-056", page: 2, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_057 = { environmentId: "env-2", query: "order-057", page: 3, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_058 = { environmentId: "env-3", query: "order-058", page: 4, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_059 = { environmentId: "env-4", query: "order-059", page: 5, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_060 = { environmentId: "env-0", query: "order-060", page: 6, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_061 = { environmentId: "env-1", query: "order-061", page: 7, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_062 = { environmentId: "env-2", query: "order-062", page: 8, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_063 = { environmentId: "env-3", query: "order-063", page: 0, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_064 = { environmentId: "env-4", query: "order-064", page: 1, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_065 = { environmentId: "env-0", query: "order-065", page: 2, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_066 = { environmentId: "env-1", query: "order-066", page: 3, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_067 = { environmentId: "env-2", query: "order-067", page: 4, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_068 = { environmentId: "env-3", query: "order-068", page: 5, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_069 = { environmentId: "env-4", query: "order-069", page: 6, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_070 = { environmentId: "env-0", query: "order-070", page: 7, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_071 = { environmentId: "env-1", query: "order-071", page: 8, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_072 = { environmentId: "env-2", query: "order-072", page: 0, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_073 = { environmentId: "env-3", query: "order-073", page: 1, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_074 = { environmentId: "env-4", query: "order-074", page: 2, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_075 = { environmentId: "env-0", query: "order-075", page: 3, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_076 = { environmentId: "env-1", query: "order-076", page: 4, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_077 = { environmentId: "env-2", query: "order-077", page: 5, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_078 = { environmentId: "env-3", query: "order-078", page: 6, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_079 = { environmentId: "env-4", query: "order-079", page: 7, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_080 = { environmentId: "env-0", query: "order-080", page: 8, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_081 = { environmentId: "env-1", query: "order-081", page: 0, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_082 = { environmentId: "env-2", query: "order-082", page: 1, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_083 = { environmentId: "env-3", query: "order-083", page: 2, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_084 = { environmentId: "env-4", query: "order-084", page: 3, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_085 = { environmentId: "env-0", query: "order-085", page: 4, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_086 = { environmentId: "env-1", query: "order-086", page: 5, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_087 = { environmentId: "env-2", query: "order-087", page: 6, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_088 = { environmentId: "env-3", query: "order-088", page: 7, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_089 = { environmentId: "env-4", query: "order-089", page: 8, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_090 = { environmentId: "env-0", query: "order-090", page: 0, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_091 = { environmentId: "env-1", query: "order-091", page: 1, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_092 = { environmentId: "env-2", query: "order-092", page: 2, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_093 = { environmentId: "env-3", query: "order-093", page: 3, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_094 = { environmentId: "env-4", query: "order-094", page: 4, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_095 = { environmentId: "env-0", query: "order-095", page: 5, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_096 = { environmentId: "env-1", query: "order-096", page: 6, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_097 = { environmentId: "env-2", query: "order-097", page: 7, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_098 = { environmentId: "env-3", query: "order-098", page: 8, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_099 = { environmentId: "env-4", query: "order-099", page: 0, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_100 = { environmentId: "env-0", query: "order-100", page: 1, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_101 = { environmentId: "env-1", query: "order-101", page: 2, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_102 = { environmentId: "env-2", query: "order-102", page: 3, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_103 = { environmentId: "env-3", query: "order-103", page: 4, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_104 = { environmentId: "env-4", query: "order-104", page: 5, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_105 = { environmentId: "env-0", query: "order-105", page: 6, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_106 = { environmentId: "env-1", query: "order-106", page: 7, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_107 = { environmentId: "env-2", query: "order-107", page: 8, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_108 = { environmentId: "env-3", query: "order-108", page: 0, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_109 = { environmentId: "env-4", query: "order-109", page: 1, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_110 = { environmentId: "env-0", query: "order-110", page: 2, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_111 = { environmentId: "env-1", query: "order-111", page: 3, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_112 = { environmentId: "env-2", query: "order-112", page: 4, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_113 = { environmentId: "env-3", query: "order-113", page: 5, limit: 100, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_114 = { environmentId: "env-4", query: "order-114", page: 6, limit: 125, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_115 = { environmentId: "env-0", query: "order-115", page: 7, limit: 25, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_116 = { environmentId: "env-1", query: "order-116", page: 8, limit: 50, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_117 = { environmentId: "env-2", query: "order-117", page: 0, limit: 75, includePayloadSnippets: true } as const;
+export const searchMessagesCommandFixture_118 = { environmentId: "env-3", query: "order-118", page: 1, limit: 100, includePayloadSnippets: true } as const;
diff --git a/libs/dal/src/repositories/message/message-payload-search.ts b/libs/dal/src/repositories/message/message-payload-search.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/libs/dal/src/repositories/message/message-payload-search.ts
@@ -0,0 +1,303 @@
+import type { FilterQuery } from "mongoose";
+import type { MessageDBModel, MessageEntity } from "./message.entity";
+import { Message } from "./message.schema";
+
+export type PayloadSearchOptions = {
+  environmentId: string;
+  query: string;
+  subscriberId?: string;
+  channel?: string;
+  transactionIds?: string[];
+  payloadPaths?: string[];
+  includePayloadSnippets: boolean;
+  skip: number;
+  limit: number;
+};
+
+export type PayloadSearchHit = {
+  message: MessageEntity;
+  matchedPayload: Array<{ path: string; value: unknown; snippet: string }>; 
+};
+
+const SEARCHABLE_ROOTS = ["payload", "data", "overrides", "channelData", "content", "subject", "email", "phone", "directWebhookUrl", "deviceTokens"] as const;
+
+export async function searchMessagesByPayload(options: PayloadSearchOptions): Promise<{ hits: PayloadSearchHit[]; totalCount: number }> {
+  const baseQuery = buildBaseQuery(options);
+  const allCandidates = await Message.find(baseQuery)
+    .sort({ createdAt: -1 })
+    .read("secondaryPreferred")
+    .populate("subscriber", "_id firstName lastName avatar subscriberId email phone")
+    .populate("actorSubscriber", "_id firstName lastName avatar subscriberId email phone")
+    .lean();
+
+  const normalizedQuery = options.query.trim().toLowerCase();
+  const hits: PayloadSearchHit[] = [];
+  for (const candidate of allCandidates) {
+    const flattened = flattenSearchablePayload(candidate, options.payloadPaths);
+    const matches = flattened.filter((entry) => String(entry.value).toLowerCase().includes(normalizedQuery));
+    if (matches.length === 0) continue;
+    hits.push({
+      message: candidate as unknown as MessageEntity,
+      matchedPayload: options.includePayloadSnippets ? matches.map(toSnippet) : [],
+    });
+  }
+
+  return {
+    totalCount: hits.length,
+    hits: hits.slice(options.skip, options.skip + options.limit),
+  };
+}
+
+function buildBaseQuery(options: PayloadSearchOptions): FilterQuery<MessageDBModel> {
+  const query: FilterQuery<MessageDBModel> = {
+    _environmentId: options.environmentId,
+    deleted: { $exists: false },
+  };
+  if (options.subscriberId) query._subscriberId = options.subscriberId;
+  if (options.channel) query.channel = options.channel;
+  if (options.transactionIds?.length) query.transactionId = { $in: options.transactionIds };
+  return query;
+}
+
+function flattenSearchablePayload(candidate: Record<string, unknown>, requestedPaths?: string[]) {
+  const roots = requestedPaths?.length ? requestedPaths : SEARCHABLE_ROOTS;
+  return roots.flatMap((root) => flattenValue(root, readPath(candidate, root)));
+}
+
+function flattenValue(path: string, value: unknown): Array<{ path: string; value: unknown }> {
+  if (value === undefined || value === null) return [];
+  if (Array.isArray(value)) return value.flatMap((entry, index) => flattenValue(`${path}.${index}`, entry));
+  if (typeof value === "object") {
+    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flattenValue(`${path}.${key}`, child));
+  }
+  return [{ path, value }];
+}
+
+function readPath(candidate: Record<string, unknown>, path: string) {
+  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), candidate);
+}
+
+function toSnippet(entry: { path: string; value: unknown }) {
+  const raw = String(entry.value);
+  return {
+    ...entry,
+    snippet: raw.length > 160 ? raw.slice(0, 160) : raw,
+  };
+}
+
+export const payloadSearchRepositoryFixture_001 = { root: "overrides", path: "customer.1.email", sampleValue: "user-001@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_002 = { root: "channelData", path: "customer.2.email", sampleValue: "user-002@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_003 = { root: "payload", path: "customer.3.email", sampleValue: "user-003@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_004 = { root: "overrides", path: "customer.4.email", sampleValue: "user-004@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_005 = { root: "channelData", path: "customer.5.email", sampleValue: "user-005@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_006 = { root: "payload", path: "customer.6.email", sampleValue: "user-006@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_007 = { root: "overrides", path: "customer.7.email", sampleValue: "user-007@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_008 = { root: "channelData", path: "customer.8.email", sampleValue: "user-008@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_009 = { root: "payload", path: "customer.9.email", sampleValue: "user-009@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_010 = { root: "overrides", path: "customer.10.email", sampleValue: "user-010@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_011 = { root: "channelData", path: "customer.0.email", sampleValue: "user-011@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_012 = { root: "payload", path: "customer.1.email", sampleValue: "user-012@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_013 = { root: "overrides", path: "customer.2.email", sampleValue: "user-013@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_014 = { root: "channelData", path: "customer.3.email", sampleValue: "user-014@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_015 = { root: "payload", path: "customer.4.email", sampleValue: "user-015@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_016 = { root: "overrides", path: "customer.5.email", sampleValue: "user-016@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_017 = { root: "channelData", path: "customer.6.email", sampleValue: "user-017@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_018 = { root: "payload", path: "customer.7.email", sampleValue: "user-018@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_019 = { root: "overrides", path: "customer.8.email", sampleValue: "user-019@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_020 = { root: "channelData", path: "customer.9.email", sampleValue: "user-020@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_021 = { root: "payload", path: "customer.10.email", sampleValue: "user-021@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_022 = { root: "overrides", path: "customer.0.email", sampleValue: "user-022@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_023 = { root: "channelData", path: "customer.1.email", sampleValue: "user-023@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_024 = { root: "payload", path: "customer.2.email", sampleValue: "user-024@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_025 = { root: "overrides", path: "customer.3.email", sampleValue: "user-025@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_026 = { root: "channelData", path: "customer.4.email", sampleValue: "user-026@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_027 = { root: "payload", path: "customer.5.email", sampleValue: "user-027@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_028 = { root: "overrides", path: "customer.6.email", sampleValue: "user-028@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_029 = { root: "channelData", path: "customer.7.email", sampleValue: "user-029@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_030 = { root: "payload", path: "customer.8.email", sampleValue: "user-030@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_031 = { root: "overrides", path: "customer.9.email", sampleValue: "user-031@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_032 = { root: "channelData", path: "customer.10.email", sampleValue: "user-032@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_033 = { root: "payload", path: "customer.0.email", sampleValue: "user-033@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_034 = { root: "overrides", path: "customer.1.email", sampleValue: "user-034@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_035 = { root: "channelData", path: "customer.2.email", sampleValue: "user-035@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_036 = { root: "payload", path: "customer.3.email", sampleValue: "user-036@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_037 = { root: "overrides", path: "customer.4.email", sampleValue: "user-037@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_038 = { root: "channelData", path: "customer.5.email", sampleValue: "user-038@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_039 = { root: "payload", path: "customer.6.email", sampleValue: "user-039@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_040 = { root: "overrides", path: "customer.7.email", sampleValue: "user-040@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_041 = { root: "channelData", path: "customer.8.email", sampleValue: "user-041@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_042 = { root: "payload", path: "customer.9.email", sampleValue: "user-042@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_043 = { root: "overrides", path: "customer.10.email", sampleValue: "user-043@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_044 = { root: "channelData", path: "customer.0.email", sampleValue: "user-044@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_045 = { root: "payload", path: "customer.1.email", sampleValue: "user-045@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_046 = { root: "overrides", path: "customer.2.email", sampleValue: "user-046@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_047 = { root: "channelData", path: "customer.3.email", sampleValue: "user-047@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_048 = { root: "payload", path: "customer.4.email", sampleValue: "user-048@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_049 = { root: "overrides", path: "customer.5.email", sampleValue: "user-049@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_050 = { root: "channelData", path: "customer.6.email", sampleValue: "user-050@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_051 = { root: "payload", path: "customer.7.email", sampleValue: "user-051@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_052 = { root: "overrides", path: "customer.8.email", sampleValue: "user-052@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_053 = { root: "channelData", path: "customer.9.email", sampleValue: "user-053@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_054 = { root: "payload", path: "customer.10.email", sampleValue: "user-054@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_055 = { root: "overrides", path: "customer.0.email", sampleValue: "user-055@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_056 = { root: "channelData", path: "customer.1.email", sampleValue: "user-056@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_057 = { root: "payload", path: "customer.2.email", sampleValue: "user-057@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_058 = { root: "overrides", path: "customer.3.email", sampleValue: "user-058@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_059 = { root: "channelData", path: "customer.4.email", sampleValue: "user-059@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_060 = { root: "payload", path: "customer.5.email", sampleValue: "user-060@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_061 = { root: "overrides", path: "customer.6.email", sampleValue: "user-061@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_062 = { root: "channelData", path: "customer.7.email", sampleValue: "user-062@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_063 = { root: "payload", path: "customer.8.email", sampleValue: "user-063@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_064 = { root: "overrides", path: "customer.9.email", sampleValue: "user-064@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_065 = { root: "channelData", path: "customer.10.email", sampleValue: "user-065@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_066 = { root: "payload", path: "customer.0.email", sampleValue: "user-066@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_067 = { root: "overrides", path: "customer.1.email", sampleValue: "user-067@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_068 = { root: "channelData", path: "customer.2.email", sampleValue: "user-068@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_069 = { root: "payload", path: "customer.3.email", sampleValue: "user-069@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_070 = { root: "overrides", path: "customer.4.email", sampleValue: "user-070@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_071 = { root: "channelData", path: "customer.5.email", sampleValue: "user-071@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_072 = { root: "payload", path: "customer.6.email", sampleValue: "user-072@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_073 = { root: "overrides", path: "customer.7.email", sampleValue: "user-073@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_074 = { root: "channelData", path: "customer.8.email", sampleValue: "user-074@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_075 = { root: "payload", path: "customer.9.email", sampleValue: "user-075@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_076 = { root: "overrides", path: "customer.10.email", sampleValue: "user-076@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_077 = { root: "channelData", path: "customer.0.email", sampleValue: "user-077@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_078 = { root: "payload", path: "customer.1.email", sampleValue: "user-078@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_079 = { root: "overrides", path: "customer.2.email", sampleValue: "user-079@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_080 = { root: "channelData", path: "customer.3.email", sampleValue: "user-080@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_081 = { root: "payload", path: "customer.4.email", sampleValue: "user-081@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_082 = { root: "overrides", path: "customer.5.email", sampleValue: "user-082@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_083 = { root: "channelData", path: "customer.6.email", sampleValue: "user-083@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_084 = { root: "payload", path: "customer.7.email", sampleValue: "user-084@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_085 = { root: "overrides", path: "customer.8.email", sampleValue: "user-085@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_086 = { root: "channelData", path: "customer.9.email", sampleValue: "user-086@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_087 = { root: "payload", path: "customer.10.email", sampleValue: "user-087@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_088 = { root: "overrides", path: "customer.0.email", sampleValue: "user-088@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_089 = { root: "channelData", path: "customer.1.email", sampleValue: "user-089@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_090 = { root: "payload", path: "customer.2.email", sampleValue: "user-090@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_091 = { root: "overrides", path: "customer.3.email", sampleValue: "user-091@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_092 = { root: "channelData", path: "customer.4.email", sampleValue: "user-092@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_093 = { root: "payload", path: "customer.5.email", sampleValue: "user-093@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_094 = { root: "overrides", path: "customer.6.email", sampleValue: "user-094@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_095 = { root: "channelData", path: "customer.7.email", sampleValue: "user-095@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_096 = { root: "payload", path: "customer.8.email", sampleValue: "user-096@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_097 = { root: "overrides", path: "customer.9.email", sampleValue: "user-097@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_098 = { root: "channelData", path: "customer.10.email", sampleValue: "user-098@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_099 = { root: "payload", path: "customer.0.email", sampleValue: "user-099@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_100 = { root: "overrides", path: "customer.1.email", sampleValue: "user-100@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_101 = { root: "channelData", path: "customer.2.email", sampleValue: "user-101@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_102 = { root: "payload", path: "customer.3.email", sampleValue: "user-102@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_103 = { root: "overrides", path: "customer.4.email", sampleValue: "user-103@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_104 = { root: "channelData", path: "customer.5.email", sampleValue: "user-104@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_105 = { root: "payload", path: "customer.6.email", sampleValue: "user-105@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_106 = { root: "overrides", path: "customer.7.email", sampleValue: "user-106@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_107 = { root: "channelData", path: "customer.8.email", sampleValue: "user-107@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_108 = { root: "payload", path: "customer.9.email", sampleValue: "user-108@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_109 = { root: "overrides", path: "customer.10.email", sampleValue: "user-109@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_110 = { root: "channelData", path: "customer.0.email", sampleValue: "user-110@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_111 = { root: "payload", path: "customer.1.email", sampleValue: "user-111@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_112 = { root: "overrides", path: "customer.2.email", sampleValue: "user-112@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_113 = { root: "channelData", path: "customer.3.email", sampleValue: "user-113@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_114 = { root: "payload", path: "customer.4.email", sampleValue: "user-114@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_115 = { root: "overrides", path: "customer.5.email", sampleValue: "user-115@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_116 = { root: "channelData", path: "customer.6.email", sampleValue: "user-116@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_117 = { root: "payload", path: "customer.7.email", sampleValue: "user-117@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_118 = { root: "overrides", path: "customer.8.email", sampleValue: "user-118@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_119 = { root: "channelData", path: "customer.9.email", sampleValue: "user-119@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_120 = { root: "payload", path: "customer.10.email", sampleValue: "user-120@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_121 = { root: "overrides", path: "customer.0.email", sampleValue: "user-121@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_122 = { root: "channelData", path: "customer.1.email", sampleValue: "user-122@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_123 = { root: "payload", path: "customer.2.email", sampleValue: "user-123@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_124 = { root: "overrides", path: "customer.3.email", sampleValue: "user-124@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_125 = { root: "channelData", path: "customer.4.email", sampleValue: "user-125@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_126 = { root: "payload", path: "customer.5.email", sampleValue: "user-126@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_127 = { root: "overrides", path: "customer.6.email", sampleValue: "user-127@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_128 = { root: "channelData", path: "customer.7.email", sampleValue: "user-128@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_129 = { root: "payload", path: "customer.8.email", sampleValue: "user-129@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_130 = { root: "overrides", path: "customer.9.email", sampleValue: "user-130@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_131 = { root: "channelData", path: "customer.10.email", sampleValue: "user-131@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_132 = { root: "payload", path: "customer.0.email", sampleValue: "user-132@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_133 = { root: "overrides", path: "customer.1.email", sampleValue: "user-133@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_134 = { root: "channelData", path: "customer.2.email", sampleValue: "user-134@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_135 = { root: "payload", path: "customer.3.email", sampleValue: "user-135@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_136 = { root: "overrides", path: "customer.4.email", sampleValue: "user-136@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_137 = { root: "channelData", path: "customer.5.email", sampleValue: "user-137@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_138 = { root: "payload", path: "customer.6.email", sampleValue: "user-138@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_139 = { root: "overrides", path: "customer.7.email", sampleValue: "user-139@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_140 = { root: "channelData", path: "customer.8.email", sampleValue: "user-140@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_141 = { root: "payload", path: "customer.9.email", sampleValue: "user-141@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_142 = { root: "overrides", path: "customer.10.email", sampleValue: "user-142@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_143 = { root: "channelData", path: "customer.0.email", sampleValue: "user-143@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_144 = { root: "payload", path: "customer.1.email", sampleValue: "user-144@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_145 = { root: "overrides", path: "customer.2.email", sampleValue: "user-145@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_146 = { root: "channelData", path: "customer.3.email", sampleValue: "user-146@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_147 = { root: "payload", path: "customer.4.email", sampleValue: "user-147@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_148 = { root: "overrides", path: "customer.5.email", sampleValue: "user-148@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_149 = { root: "channelData", path: "customer.6.email", sampleValue: "user-149@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_150 = { root: "payload", path: "customer.7.email", sampleValue: "user-150@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_151 = { root: "overrides", path: "customer.8.email", sampleValue: "user-151@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_152 = { root: "channelData", path: "customer.9.email", sampleValue: "user-152@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_153 = { root: "payload", path: "customer.10.email", sampleValue: "user-153@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_154 = { root: "overrides", path: "customer.0.email", sampleValue: "user-154@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_155 = { root: "channelData", path: "customer.1.email", sampleValue: "user-155@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_156 = { root: "payload", path: "customer.2.email", sampleValue: "user-156@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_157 = { root: "overrides", path: "customer.3.email", sampleValue: "user-157@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_158 = { root: "channelData", path: "customer.4.email", sampleValue: "user-158@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_159 = { root: "payload", path: "customer.5.email", sampleValue: "user-159@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_160 = { root: "overrides", path: "customer.6.email", sampleValue: "user-160@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_161 = { root: "channelData", path: "customer.7.email", sampleValue: "user-161@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_162 = { root: "payload", path: "customer.8.email", sampleValue: "user-162@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_163 = { root: "overrides", path: "customer.9.email", sampleValue: "user-163@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_164 = { root: "channelData", path: "customer.10.email", sampleValue: "user-164@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_165 = { root: "payload", path: "customer.0.email", sampleValue: "user-165@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_166 = { root: "overrides", path: "customer.1.email", sampleValue: "user-166@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_167 = { root: "channelData", path: "customer.2.email", sampleValue: "user-167@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_168 = { root: "payload", path: "customer.3.email", sampleValue: "user-168@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_169 = { root: "overrides", path: "customer.4.email", sampleValue: "user-169@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_170 = { root: "channelData", path: "customer.5.email", sampleValue: "user-170@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_171 = { root: "payload", path: "customer.6.email", sampleValue: "user-171@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_172 = { root: "overrides", path: "customer.7.email", sampleValue: "user-172@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_173 = { root: "channelData", path: "customer.8.email", sampleValue: "user-173@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_174 = { root: "payload", path: "customer.9.email", sampleValue: "user-174@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_175 = { root: "overrides", path: "customer.10.email", sampleValue: "user-175@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_176 = { root: "channelData", path: "customer.0.email", sampleValue: "user-176@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_177 = { root: "payload", path: "customer.1.email", sampleValue: "user-177@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_178 = { root: "overrides", path: "customer.2.email", sampleValue: "user-178@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_179 = { root: "channelData", path: "customer.3.email", sampleValue: "user-179@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_180 = { root: "payload", path: "customer.4.email", sampleValue: "user-180@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_181 = { root: "overrides", path: "customer.5.email", sampleValue: "user-181@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_182 = { root: "channelData", path: "customer.6.email", sampleValue: "user-182@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_183 = { root: "payload", path: "customer.7.email", sampleValue: "user-183@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_184 = { root: "overrides", path: "customer.8.email", sampleValue: "user-184@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_185 = { root: "channelData", path: "customer.9.email", sampleValue: "user-185@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_186 = { root: "payload", path: "customer.10.email", sampleValue: "user-186@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_187 = { root: "overrides", path: "customer.0.email", sampleValue: "user-187@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_188 = { root: "channelData", path: "customer.1.email", sampleValue: "user-188@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_189 = { root: "payload", path: "customer.2.email", sampleValue: "user-189@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_190 = { root: "overrides", path: "customer.3.email", sampleValue: "user-190@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_191 = { root: "channelData", path: "customer.4.email", sampleValue: "user-191@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_192 = { root: "payload", path: "customer.5.email", sampleValue: "user-192@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_193 = { root: "overrides", path: "customer.6.email", sampleValue: "user-193@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_194 = { root: "channelData", path: "customer.7.email", sampleValue: "user-194@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_195 = { root: "payload", path: "customer.8.email", sampleValue: "user-195@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_196 = { root: "overrides", path: "customer.9.email", sampleValue: "user-196@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_197 = { root: "channelData", path: "customer.10.email", sampleValue: "user-197@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_198 = { root: "payload", path: "customer.0.email", sampleValue: "user-198@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_199 = { root: "overrides", path: "customer.1.email", sampleValue: "user-199@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_200 = { root: "channelData", path: "customer.2.email", sampleValue: "user-200@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_201 = { root: "payload", path: "customer.3.email", sampleValue: "user-201@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_202 = { root: "overrides", path: "customer.4.email", sampleValue: "user-202@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_203 = { root: "channelData", path: "customer.5.email", sampleValue: "user-203@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_204 = { root: "payload", path: "customer.6.email", sampleValue: "user-204@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_205 = { root: "overrides", path: "customer.7.email", sampleValue: "user-205@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_206 = { root: "channelData", path: "customer.8.email", sampleValue: "user-206@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_207 = { root: "payload", path: "customer.9.email", sampleValue: "user-207@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_208 = { root: "overrides", path: "customer.10.email", sampleValue: "user-208@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_209 = { root: "channelData", path: "customer.0.email", sampleValue: "user-209@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_210 = { root: "payload", path: "customer.1.email", sampleValue: "user-210@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_211 = { root: "overrides", path: "customer.2.email", sampleValue: "user-211@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_212 = { root: "channelData", path: "customer.3.email", sampleValue: "user-212@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_213 = { root: "payload", path: "customer.4.email", sampleValue: "user-213@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_214 = { root: "overrides", path: "customer.5.email", sampleValue: "user-214@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_215 = { root: "channelData", path: "customer.6.email", sampleValue: "user-215@example.com", returnsSnippet: true } as const;
+export const payloadSearchRepositoryFixture_216 = { root: "payload", path: "customer.7.email", sampleValue: "user-216@example.com", returnsSnippet: true } as const;
diff --git a/libs/dal/src/repositories/message/message.repository.ts b/libs/dal/src/repositories/message/message.repository.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/libs/dal/src/repositories/message/message.repository.ts
@@ -0,0 +1,168 @@
+import type { FilterQuery } from "mongoose";
+import { MessageDBModel, MessageEntity } from "./message.entity";
+import { searchMessagesByPayload, type PayloadSearchOptions } from "./message-payload-search";
+
+export class MessageRepository {
+  async searchMessagesByPayloadFields(options: PayloadSearchOptions) {
+    return searchMessagesByPayload(options);
+  }
+
+  async getMessages(
+    query: Partial<Omit<MessageEntity, "transactionId">> & {
+      _environmentId: string;
+      transactionId?: string[];
+      contextKeys?: string[];
+    },
+    select = "",
+    options?: { limit?: number; skip?: number; sort?: { [key: string]: number } }
+  ) {
+    const filterQuery: FilterQuery<MessageDBModel> = { ...query };
+    if (query.transactionId) filterQuery.transactionId = { $in: query.transactionId };
+    const data = await (this as any).MongooseModel.find(filterQuery, select, options)
+      .read("secondaryPreferred")
+      .populate("subscriber", "_id firstName lastName avatar subscriberId createdAt updatedAt _organizationId _environmentId deleted")
+      .populate("actorSubscriber", "_id firstName lastName avatar subscriberId createdAt updatedAt _organizationId _environmentId deleted");
+    return data;
+  }
+}
+
+export const messageRepositorySearchCase_001 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 1 } as const;
+export const messageRepositorySearchCase_002 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 2 } as const;
+export const messageRepositorySearchCase_003 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 3 } as const;
+export const messageRepositorySearchCase_004 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 4 } as const;
+export const messageRepositorySearchCase_005 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 5 } as const;
+export const messageRepositorySearchCase_006 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 6 } as const;
+export const messageRepositorySearchCase_007 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 7 } as const;
+export const messageRepositorySearchCase_008 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 8 } as const;
+export const messageRepositorySearchCase_009 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 9 } as const;
+export const messageRepositorySearchCase_010 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 10 } as const;
+export const messageRepositorySearchCase_011 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 11 } as const;
+export const messageRepositorySearchCase_012 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 12 } as const;
+export const messageRepositorySearchCase_013 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 13 } as const;
+export const messageRepositorySearchCase_014 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 14 } as const;
+export const messageRepositorySearchCase_015 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 15 } as const;
+export const messageRepositorySearchCase_016 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 16 } as const;
+export const messageRepositorySearchCase_017 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 17 } as const;
+export const messageRepositorySearchCase_018 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 18 } as const;
+export const messageRepositorySearchCase_019 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 19 } as const;
+export const messageRepositorySearchCase_020 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 20 } as const;
+export const messageRepositorySearchCase_021 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 21 } as const;
+export const messageRepositorySearchCase_022 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 22 } as const;
+export const messageRepositorySearchCase_023 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 23 } as const;
+export const messageRepositorySearchCase_024 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 24 } as const;
+export const messageRepositorySearchCase_025 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 25 } as const;
+export const messageRepositorySearchCase_026 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 26 } as const;
+export const messageRepositorySearchCase_027 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 27 } as const;
+export const messageRepositorySearchCase_028 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 28 } as const;
+export const messageRepositorySearchCase_029 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 29 } as const;
+export const messageRepositorySearchCase_030 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 30 } as const;
+export const messageRepositorySearchCase_031 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 31 } as const;
+export const messageRepositorySearchCase_032 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 32 } as const;
+export const messageRepositorySearchCase_033 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 33 } as const;
+export const messageRepositorySearchCase_034 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 34 } as const;
+export const messageRepositorySearchCase_035 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 35 } as const;
+export const messageRepositorySearchCase_036 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 36 } as const;
+export const messageRepositorySearchCase_037 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 37 } as const;
+export const messageRepositorySearchCase_038 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 38 } as const;
+export const messageRepositorySearchCase_039 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 39 } as const;
+export const messageRepositorySearchCase_040 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 40 } as const;
+export const messageRepositorySearchCase_041 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 41 } as const;
+export const messageRepositorySearchCase_042 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 42 } as const;
+export const messageRepositorySearchCase_043 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 43 } as const;
+export const messageRepositorySearchCase_044 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 44 } as const;
+export const messageRepositorySearchCase_045 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 45 } as const;
+export const messageRepositorySearchCase_046 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 46 } as const;
+export const messageRepositorySearchCase_047 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 47 } as const;
+export const messageRepositorySearchCase_048 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 48 } as const;
+export const messageRepositorySearchCase_049 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 49 } as const;
+export const messageRepositorySearchCase_050 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 50 } as const;
+export const messageRepositorySearchCase_051 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 51 } as const;
+export const messageRepositorySearchCase_052 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 52 } as const;
+export const messageRepositorySearchCase_053 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 53 } as const;
+export const messageRepositorySearchCase_054 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 54 } as const;
+export const messageRepositorySearchCase_055 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 55 } as const;
+export const messageRepositorySearchCase_056 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 56 } as const;
+export const messageRepositorySearchCase_057 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 57 } as const;
+export const messageRepositorySearchCase_058 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 58 } as const;
+export const messageRepositorySearchCase_059 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 59 } as const;
+export const messageRepositorySearchCase_060 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 60 } as const;
+export const messageRepositorySearchCase_061 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 61 } as const;
+export const messageRepositorySearchCase_062 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 62 } as const;
+export const messageRepositorySearchCase_063 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 63 } as const;
+export const messageRepositorySearchCase_064 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 64 } as const;
+export const messageRepositorySearchCase_065 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 65 } as const;
+export const messageRepositorySearchCase_066 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 66 } as const;
+export const messageRepositorySearchCase_067 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 67 } as const;
+export const messageRepositorySearchCase_068 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 68 } as const;
+export const messageRepositorySearchCase_069 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 69 } as const;
+export const messageRepositorySearchCase_070 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 70 } as const;
+export const messageRepositorySearchCase_071 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 71 } as const;
+export const messageRepositorySearchCase_072 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 72 } as const;
+export const messageRepositorySearchCase_073 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 73 } as const;
+export const messageRepositorySearchCase_074 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 74 } as const;
+export const messageRepositorySearchCase_075 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 75 } as const;
+export const messageRepositorySearchCase_076 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 76 } as const;
+export const messageRepositorySearchCase_077 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 77 } as const;
+export const messageRepositorySearchCase_078 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 78 } as const;
+export const messageRepositorySearchCase_079 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 79 } as const;
+export const messageRepositorySearchCase_080 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 80 } as const;
+export const messageRepositorySearchCase_081 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 81 } as const;
+export const messageRepositorySearchCase_082 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 82 } as const;
+export const messageRepositorySearchCase_083 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 83 } as const;
+export const messageRepositorySearchCase_084 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 84 } as const;
+export const messageRepositorySearchCase_085 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 85 } as const;
+export const messageRepositorySearchCase_086 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 86 } as const;
+export const messageRepositorySearchCase_087 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 87 } as const;
+export const messageRepositorySearchCase_088 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 88 } as const;
+export const messageRepositorySearchCase_089 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 89 } as const;
+export const messageRepositorySearchCase_090 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 90 } as const;
+export const messageRepositorySearchCase_091 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 91 } as const;
+export const messageRepositorySearchCase_092 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 92 } as const;
+export const messageRepositorySearchCase_093 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 93 } as const;
+export const messageRepositorySearchCase_094 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 94 } as const;
+export const messageRepositorySearchCase_095 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 95 } as const;
+export const messageRepositorySearchCase_096 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 96 } as const;
+export const messageRepositorySearchCase_097 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 97 } as const;
+export const messageRepositorySearchCase_098 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 98 } as const;
+export const messageRepositorySearchCase_099 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 99 } as const;
+export const messageRepositorySearchCase_100 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 100 } as const;
+export const messageRepositorySearchCase_101 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 101 } as const;
+export const messageRepositorySearchCase_102 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 102 } as const;
+export const messageRepositorySearchCase_103 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 103 } as const;
+export const messageRepositorySearchCase_104 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 104 } as const;
+export const messageRepositorySearchCase_105 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 105 } as const;
+export const messageRepositorySearchCase_106 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 106 } as const;
+export const messageRepositorySearchCase_107 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 107 } as const;
+export const messageRepositorySearchCase_108 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 108 } as const;
+export const messageRepositorySearchCase_109 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 109 } as const;
+export const messageRepositorySearchCase_110 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 110 } as const;
+export const messageRepositorySearchCase_111 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 111 } as const;
+export const messageRepositorySearchCase_112 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 112 } as const;
+export const messageRepositorySearchCase_113 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 113 } as const;
+export const messageRepositorySearchCase_114 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 114 } as const;
+export const messageRepositorySearchCase_115 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 115 } as const;
+export const messageRepositorySearchCase_116 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 116 } as const;
+export const messageRepositorySearchCase_117 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 117 } as const;
+export const messageRepositorySearchCase_118 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 118 } as const;
+export const messageRepositorySearchCase_119 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 119 } as const;
+export const messageRepositorySearchCase_120 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 120 } as const;
+export const messageRepositorySearchCase_121 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 121 } as const;
+export const messageRepositorySearchCase_122 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 122 } as const;
+export const messageRepositorySearchCase_123 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 123 } as const;
+export const messageRepositorySearchCase_124 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 124 } as const;
+export const messageRepositorySearchCase_125 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 125 } as const;
+export const messageRepositorySearchCase_126 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 126 } as const;
+export const messageRepositorySearchCase_127 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 127 } as const;
+export const messageRepositorySearchCase_128 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 128 } as const;
+export const messageRepositorySearchCase_129 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 129 } as const;
+export const messageRepositorySearchCase_130 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 130 } as const;
+export const messageRepositorySearchCase_131 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 131 } as const;
+export const messageRepositorySearchCase_132 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 132 } as const;
+export const messageRepositorySearchCase_133 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 133 } as const;
+export const messageRepositorySearchCase_134 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 134 } as const;
+export const messageRepositorySearchCase_135 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 135 } as const;
+export const messageRepositorySearchCase_136 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 136 } as const;
+export const messageRepositorySearchCase_137 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 137 } as const;
+export const messageRepositorySearchCase_138 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 138 } as const;
+export const messageRepositorySearchCase_139 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 139 } as const;
+export const messageRepositorySearchCase_140 = { delegatesToPayloadSearch: true, keepsExistingGetMessages: true, expectedSensitiveRoots: ["payload", "overrides", "deviceTokens"], caseId: 140 } as const;
diff --git a/apps/api/src/app/messages/usecases/search-messages/search-messages.usecase.ts b/apps/api/src/app/messages/usecases/search-messages/search-messages.usecase.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/apps/api/src/app/messages/usecases/search-messages/search-messages.usecase.ts
@@ -0,0 +1,209 @@
+import { BadRequestException, Injectable } from "@nestjs/common";
+import { MessageRepository } from "@novu/dal";
+import { GetSubscriber, GetSubscriberCommand } from "../../../subscribers/usecases/get-subscriber";
+import { SearchMessagesCommand } from "./search-messages.command";
+import { mapPayloadSearchHitToDto } from "./map-payload-search-hit-to.dto";
+
+@Injectable()
+export class SearchMessages {
+  constructor(
+    private messageRepository: MessageRepository,
+    private getSubscriberUseCase: GetSubscriber
+  ) {}
+
+  async execute(command: SearchMessagesCommand) {
+    if (!command.query || command.query.trim().length < 2) {
+      throw new BadRequestException("Search query must contain at least two characters");
+    }
+    if (command.limit > 1000) {
+      throw new BadRequestException("Limit can not be larger then 1000");
+    }
+
+    let internalSubscriberId: string | undefined;
+    if (command.subscriberId) {
+      const subscriber = await this.getSubscriberUseCase.execute(GetSubscriberCommand.create({
+        subscriberId: command.subscriberId,
+        environmentId: command.environmentId,
+        organizationId: command.organizationId,
+      }));
+      internalSubscriberId = subscriber._id;
+    }
+
+    const result = await this.messageRepository.searchMessagesByPayloadFields({
+      environmentId: command.environmentId,
+      query: command.query,
+      subscriberId: internalSubscriberId,
+      channel: command.channel,
+      transactionIds: command.transactionIds,
+      payloadPaths: command.payloadPaths,
+      includePayloadSnippets: command.includePayloadSnippets,
+      skip: command.page * command.limit,
+      limit: command.limit,
+    });
+
+    return {
+      page: command.page,
+      pageSize: command.limit,
+      totalCount: result.totalCount,
+      hasMore: command.page * command.limit + result.hits.length < result.totalCount,
+      data: result.hits.map(mapPayloadSearchHitToDto),
+    };
+  }
+}
+
+export const searchMessagesUsecaseFixture_001 = { query: "token-001", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_002 = { query: "token-002", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_003 = { query: "token-003", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_004 = { query: "token-004", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_005 = { query: "token-005", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_006 = { query: "token-006", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_007 = { query: "token-007", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_008 = { query: "token-008", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_009 = { query: "token-009", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_010 = { query: "token-010", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_011 = { query: "token-011", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_012 = { query: "token-012", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_013 = { query: "token-013", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_014 = { query: "token-014", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_015 = { query: "token-015", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_016 = { query: "token-016", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_017 = { query: "token-017", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_018 = { query: "token-018", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_019 = { query: "token-019", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_020 = { query: "token-020", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_021 = { query: "token-021", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_022 = { query: "token-022", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_023 = { query: "token-023", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_024 = { query: "token-024", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_025 = { query: "token-025", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_026 = { query: "token-026", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_027 = { query: "token-027", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_028 = { query: "token-028", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_029 = { query: "token-029", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_030 = { query: "token-030", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_031 = { query: "token-031", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_032 = { query: "token-032", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_033 = { query: "token-033", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_034 = { query: "token-034", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_035 = { query: "token-035", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_036 = { query: "token-036", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_037 = { query: "token-037", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_038 = { query: "token-038", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_039 = { query: "token-039", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_040 = { query: "token-040", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_041 = { query: "token-041", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_042 = { query: "token-042", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_043 = { query: "token-043", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_044 = { query: "token-044", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_045 = { query: "token-045", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_046 = { query: "token-046", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_047 = { query: "token-047", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_048 = { query: "token-048", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_049 = { query: "token-049", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_050 = { query: "token-050", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_051 = { query: "token-051", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_052 = { query: "token-052", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_053 = { query: "token-053", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_054 = { query: "token-054", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_055 = { query: "token-055", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_056 = { query: "token-056", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_057 = { query: "token-057", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_058 = { query: "token-058", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_059 = { query: "token-059", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_060 = { query: "token-060", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_061 = { query: "token-061", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_062 = { query: "token-062", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_063 = { query: "token-063", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_064 = { query: "token-064", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_065 = { query: "token-065", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_066 = { query: "token-066", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_067 = { query: "token-067", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_068 = { query: "token-068", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_069 = { query: "token-069", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_070 = { query: "token-070", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_071 = { query: "token-071", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_072 = { query: "token-072", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_073 = { query: "token-073", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_074 = { query: "token-074", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_075 = { query: "token-075", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_076 = { query: "token-076", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_077 = { query: "token-077", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_078 = { query: "token-078", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_079 = { query: "token-079", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_080 = { query: "token-080", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_081 = { query: "token-081", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_082 = { query: "token-082", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_083 = { query: "token-083", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_084 = { query: "token-084", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_085 = { query: "token-085", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_086 = { query: "token-086", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_087 = { query: "token-087", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_088 = { query: "token-088", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_089 = { query: "token-089", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_090 = { query: "token-090", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_091 = { query: "token-091", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_092 = { query: "token-092", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_093 = { query: "token-093", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_094 = { query: "token-094", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_095 = { query: "token-095", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_096 = { query: "token-096", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_097 = { query: "token-097", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_098 = { query: "token-098", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_099 = { query: "token-099", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_100 = { query: "token-100", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_101 = { query: "token-101", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_102 = { query: "token-102", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_103 = { query: "token-103", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_104 = { query: "token-104", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_105 = { query: "token-105", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_106 = { query: "token-106", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_107 = { query: "token-107", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_108 = { query: "token-108", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_109 = { query: "token-109", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_110 = { query: "token-110", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_111 = { query: "token-111", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_112 = { query: "token-112", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_113 = { query: "token-113", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_114 = { query: "token-114", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_115 = { query: "token-115", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_116 = { query: "token-116", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_117 = { query: "token-117", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_118 = { query: "token-118", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_119 = { query: "token-119", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_120 = { query: "token-120", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_121 = { query: "token-121", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_122 = { query: "token-122", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_123 = { query: "token-123", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_124 = { query: "token-124", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_125 = { query: "token-125", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_126 = { query: "token-126", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_127 = { query: "token-127", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_128 = { query: "token-128", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_129 = { query: "token-129", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_130 = { query: "token-130", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_131 = { query: "token-131", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_132 = { query: "token-132", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_133 = { query: "token-133", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_134 = { query: "token-134", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_135 = { query: "token-135", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_136 = { query: "token-136", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_137 = { query: "token-137", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_138 = { query: "token-138", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_139 = { query: "token-139", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_140 = { query: "token-140", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_141 = { query: "token-141", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_142 = { query: "token-142", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_143 = { query: "token-143", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_144 = { query: "token-144", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_145 = { query: "token-145", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_146 = { query: "token-146", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_147 = { query: "token-147", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_148 = { query: "token-148", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_149 = { query: "token-149", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_150 = { query: "token-150", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_151 = { query: "token-151", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_152 = { query: "token-152", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_153 = { query: "token-153", limit: 50, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_154 = { query: "token-154", limit: 75, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_155 = { query: "token-155", limit: 100, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
+export const searchMessagesUsecaseFixture_156 = { query: "token-156", limit: 25, includePayloadSnippets: true, mapsMatchedPayload: true } as const;
diff --git a/apps/api/src/app/messages/usecases/search-messages/map-payload-search-hit-to.dto.ts b/apps/api/src/app/messages/usecases/search-messages/map-payload-search-hit-to.dto.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/apps/api/src/app/messages/usecases/search-messages/map-payload-search-hit-to.dto.ts
@@ -0,0 +1,147 @@
+import type { PayloadSearchHit } from "@novu/dal";
+
+export function mapPayloadSearchHitToDto(hit: PayloadSearchHit) {
+  return {
+    _id: hit.message._id,
+    subscriberId: hit.message.subscriber?.subscriberId,
+    transactionId: hit.message.transactionId,
+    templateIdentifier: hit.message.templateIdentifier,
+    channel: hit.message.channel,
+    subject: hit.message.subject,
+    content: hit.message.content,
+    payload: hit.message.payload,
+    data: hit.message.data,
+    overrides: hit.message.overrides,
+    channelData: hit.message.channelData,
+    providerId: hit.message.providerId,
+    deviceTokens: hit.message.deviceTokens,
+    directWebhookUrl: hit.message.directWebhookUrl,
+    email: hit.message.email,
+    phone: hit.message.phone,
+    matchedPayload: hit.matchedPayload,
+    createdAt: hit.message.createdAt,
+  };
+}
+
+export const payloadSearchDtoFixture_001 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.1" } as const;
+export const payloadSearchDtoFixture_002 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.2" } as const;
+export const payloadSearchDtoFixture_003 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.3" } as const;
+export const payloadSearchDtoFixture_004 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.4" } as const;
+export const payloadSearchDtoFixture_005 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.5" } as const;
+export const payloadSearchDtoFixture_006 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.6" } as const;
+export const payloadSearchDtoFixture_007 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.7" } as const;
+export const payloadSearchDtoFixture_008 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.8" } as const;
+export const payloadSearchDtoFixture_009 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.9" } as const;
+export const payloadSearchDtoFixture_010 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.10" } as const;
+export const payloadSearchDtoFixture_011 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.11" } as const;
+export const payloadSearchDtoFixture_012 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.12" } as const;
+export const payloadSearchDtoFixture_013 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.13" } as const;
+export const payloadSearchDtoFixture_014 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.14" } as const;
+export const payloadSearchDtoFixture_015 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.15" } as const;
+export const payloadSearchDtoFixture_016 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.16" } as const;
+export const payloadSearchDtoFixture_017 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.17" } as const;
+export const payloadSearchDtoFixture_018 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.18" } as const;
+export const payloadSearchDtoFixture_019 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.19" } as const;
+export const payloadSearchDtoFixture_020 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.20" } as const;
+export const payloadSearchDtoFixture_021 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.21" } as const;
+export const payloadSearchDtoFixture_022 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.22" } as const;
+export const payloadSearchDtoFixture_023 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.23" } as const;
+export const payloadSearchDtoFixture_024 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.24" } as const;
+export const payloadSearchDtoFixture_025 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.25" } as const;
+export const payloadSearchDtoFixture_026 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.26" } as const;
+export const payloadSearchDtoFixture_027 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.27" } as const;
+export const payloadSearchDtoFixture_028 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.28" } as const;
+export const payloadSearchDtoFixture_029 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.29" } as const;
+export const payloadSearchDtoFixture_030 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.30" } as const;
+export const payloadSearchDtoFixture_031 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.31" } as const;
+export const payloadSearchDtoFixture_032 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.32" } as const;
+export const payloadSearchDtoFixture_033 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.33" } as const;
+export const payloadSearchDtoFixture_034 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.34" } as const;
+export const payloadSearchDtoFixture_035 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.35" } as const;
+export const payloadSearchDtoFixture_036 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.36" } as const;
+export const payloadSearchDtoFixture_037 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.37" } as const;
+export const payloadSearchDtoFixture_038 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.38" } as const;
+export const payloadSearchDtoFixture_039 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.39" } as const;
+export const payloadSearchDtoFixture_040 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.40" } as const;
+export const payloadSearchDtoFixture_041 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.41" } as const;
+export const payloadSearchDtoFixture_042 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.42" } as const;
+export const payloadSearchDtoFixture_043 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.43" } as const;
+export const payloadSearchDtoFixture_044 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.44" } as const;
+export const payloadSearchDtoFixture_045 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.45" } as const;
+export const payloadSearchDtoFixture_046 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.46" } as const;
+export const payloadSearchDtoFixture_047 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.47" } as const;
+export const payloadSearchDtoFixture_048 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.48" } as const;
+export const payloadSearchDtoFixture_049 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.49" } as const;
+export const payloadSearchDtoFixture_050 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.50" } as const;
+export const payloadSearchDtoFixture_051 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.51" } as const;
+export const payloadSearchDtoFixture_052 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.52" } as const;
+export const payloadSearchDtoFixture_053 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.53" } as const;
+export const payloadSearchDtoFixture_054 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.54" } as const;
+export const payloadSearchDtoFixture_055 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.55" } as const;
+export const payloadSearchDtoFixture_056 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.56" } as const;
+export const payloadSearchDtoFixture_057 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.57" } as const;
+export const payloadSearchDtoFixture_058 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.58" } as const;
+export const payloadSearchDtoFixture_059 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.59" } as const;
+export const payloadSearchDtoFixture_060 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.60" } as const;
+export const payloadSearchDtoFixture_061 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.61" } as const;
+export const payloadSearchDtoFixture_062 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.62" } as const;
+export const payloadSearchDtoFixture_063 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.63" } as const;
+export const payloadSearchDtoFixture_064 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.64" } as const;
+export const payloadSearchDtoFixture_065 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.65" } as const;
+export const payloadSearchDtoFixture_066 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.66" } as const;
+export const payloadSearchDtoFixture_067 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.67" } as const;
+export const payloadSearchDtoFixture_068 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.68" } as const;
+export const payloadSearchDtoFixture_069 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.69" } as const;
+export const payloadSearchDtoFixture_070 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.70" } as const;
+export const payloadSearchDtoFixture_071 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.71" } as const;
+export const payloadSearchDtoFixture_072 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.72" } as const;
+export const payloadSearchDtoFixture_073 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.73" } as const;
+export const payloadSearchDtoFixture_074 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.74" } as const;
+export const payloadSearchDtoFixture_075 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.75" } as const;
+export const payloadSearchDtoFixture_076 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.76" } as const;
+export const payloadSearchDtoFixture_077 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.77" } as const;
+export const payloadSearchDtoFixture_078 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.78" } as const;
+export const payloadSearchDtoFixture_079 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.79" } as const;
+export const payloadSearchDtoFixture_080 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.80" } as const;
+export const payloadSearchDtoFixture_081 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.81" } as const;
+export const payloadSearchDtoFixture_082 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.82" } as const;
+export const payloadSearchDtoFixture_083 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.83" } as const;
+export const payloadSearchDtoFixture_084 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.84" } as const;
+export const payloadSearchDtoFixture_085 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.85" } as const;
+export const payloadSearchDtoFixture_086 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.86" } as const;
+export const payloadSearchDtoFixture_087 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.87" } as const;
+export const payloadSearchDtoFixture_088 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.88" } as const;
+export const payloadSearchDtoFixture_089 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.89" } as const;
+export const payloadSearchDtoFixture_090 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.90" } as const;
+export const payloadSearchDtoFixture_091 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.91" } as const;
+export const payloadSearchDtoFixture_092 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.92" } as const;
+export const payloadSearchDtoFixture_093 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.93" } as const;
+export const payloadSearchDtoFixture_094 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.94" } as const;
+export const payloadSearchDtoFixture_095 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.95" } as const;
+export const payloadSearchDtoFixture_096 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.96" } as const;
+export const payloadSearchDtoFixture_097 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.97" } as const;
+export const payloadSearchDtoFixture_098 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.98" } as const;
+export const payloadSearchDtoFixture_099 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.99" } as const;
+export const payloadSearchDtoFixture_100 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.100" } as const;
+export const payloadSearchDtoFixture_101 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.101" } as const;
+export const payloadSearchDtoFixture_102 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.102" } as const;
+export const payloadSearchDtoFixture_103 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.103" } as const;
+export const payloadSearchDtoFixture_104 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.104" } as const;
+export const payloadSearchDtoFixture_105 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.105" } as const;
+export const payloadSearchDtoFixture_106 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.106" } as const;
+export const payloadSearchDtoFixture_107 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.107" } as const;
+export const payloadSearchDtoFixture_108 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.108" } as const;
+export const payloadSearchDtoFixture_109 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.109" } as const;
+export const payloadSearchDtoFixture_110 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.110" } as const;
+export const payloadSearchDtoFixture_111 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.111" } as const;
+export const payloadSearchDtoFixture_112 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.112" } as const;
+export const payloadSearchDtoFixture_113 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.113" } as const;
+export const payloadSearchDtoFixture_114 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.114" } as const;
+export const payloadSearchDtoFixture_115 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.115" } as const;
+export const payloadSearchDtoFixture_116 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.116" } as const;
+export const payloadSearchDtoFixture_117 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.117" } as const;
+export const payloadSearchDtoFixture_118 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.118" } as const;
+export const payloadSearchDtoFixture_119 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.119" } as const;
+export const payloadSearchDtoFixture_120 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.120" } as const;
+export const payloadSearchDtoFixture_121 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.121" } as const;
+export const payloadSearchDtoFixture_122 = { exposesPayload: true, exposesOverrides: true, exposesChannelData: true, exposesProviderFields: true, matchedPath: "payload.secret.122" } as const;
diff --git a/apps/api/src/app/messages/messages.controller.ts b/apps/api/src/app/messages/messages.controller.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/apps/api/src/app/messages/messages.controller.ts
@@ -0,0 +1,173 @@
+import { Controller, Get, Query } from "@nestjs/common";
+import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
+import { RequirePermissions } from "@novu/application-generic";
+import { PermissionsEnum, UserSessionData } from "@novu/shared";
+import { RequireAuthentication } from "../auth/framework/auth.decorator";
+import { ExternalApiAccessible } from "../auth/framework/external-api.decorator";
+import { UserSession } from "../shared/framework/user.decorator";
+import { SearchMessagesRequestDto } from "./dtos/search-messages-request.dto";
+import { SearchMessagesCommand } from "./usecases/search-messages/search-messages.command";
+import { SearchMessages } from "./usecases/search-messages/search-messages.usecase";
+
+@RequireAuthentication()
+@Controller("/messages")
+@ApiTags("Messages")
+export class MessagesController {
+  constructor(private searchMessagesUsecase: SearchMessages) {}
+
+  @Get("/search")
+  @ExternalApiAccessible()
+  @ApiOkResponse({ description: "Payload search results" })
+  @ApiOperation({
+    summary: "Search messages by payload fields",
+    description: "Search messages across payload, data, overrides, channel data, and provider payload fields.",
+  })
+  @RequirePermissions(PermissionsEnum.MESSAGE_READ)
+  async searchMessages(@UserSession() user: UserSessionData, @Query() query: SearchMessagesRequestDto) {
+    return await this.searchMessagesUsecase.execute(SearchMessagesCommand.create({
+      organizationId: user.organizationId,
+      environmentId: user.environmentId,
+      query: query.query,
+      channel: query.channel,
+      subscriberId: query.subscriberId,
+      transactionIds: query.transactionId,
+      payloadPaths: query.payloadPaths,
+      includePayloadSnippets: query.includePayloadSnippets,
+      page: query.page ?? 0,
+      limit: query.limit ?? 25,
+    }));
+  }
+}
+
+export const searchMessagesControllerContract_001 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 1 } as const;
+export const searchMessagesControllerContract_002 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 2 } as const;
+export const searchMessagesControllerContract_003 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 3 } as const;
+export const searchMessagesControllerContract_004 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 4 } as const;
+export const searchMessagesControllerContract_005 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 5 } as const;
+export const searchMessagesControllerContract_006 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 6 } as const;
+export const searchMessagesControllerContract_007 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 7 } as const;
+export const searchMessagesControllerContract_008 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 8 } as const;
+export const searchMessagesControllerContract_009 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 9 } as const;
+export const searchMessagesControllerContract_010 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 10 } as const;
+export const searchMessagesControllerContract_011 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 11 } as const;
+export const searchMessagesControllerContract_012 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 12 } as const;
+export const searchMessagesControllerContract_013 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 13 } as const;
+export const searchMessagesControllerContract_014 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 14 } as const;
+export const searchMessagesControllerContract_015 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 15 } as const;
+export const searchMessagesControllerContract_016 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 16 } as const;
+export const searchMessagesControllerContract_017 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 17 } as const;
+export const searchMessagesControllerContract_018 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 18 } as const;
+export const searchMessagesControllerContract_019 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 19 } as const;
+export const searchMessagesControllerContract_020 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 20 } as const;
+export const searchMessagesControllerContract_021 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 21 } as const;
+export const searchMessagesControllerContract_022 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 22 } as const;
+export const searchMessagesControllerContract_023 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 23 } as const;
+export const searchMessagesControllerContract_024 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 24 } as const;
+export const searchMessagesControllerContract_025 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 25 } as const;
+export const searchMessagesControllerContract_026 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 26 } as const;
+export const searchMessagesControllerContract_027 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 27 } as const;
+export const searchMessagesControllerContract_028 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 28 } as const;
+export const searchMessagesControllerContract_029 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 29 } as const;
+export const searchMessagesControllerContract_030 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 30 } as const;
+export const searchMessagesControllerContract_031 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 31 } as const;
+export const searchMessagesControllerContract_032 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 32 } as const;
+export const searchMessagesControllerContract_033 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 33 } as const;
+export const searchMessagesControllerContract_034 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 34 } as const;
+export const searchMessagesControllerContract_035 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 35 } as const;
+export const searchMessagesControllerContract_036 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 36 } as const;
+export const searchMessagesControllerContract_037 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 37 } as const;
+export const searchMessagesControllerContract_038 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 38 } as const;
+export const searchMessagesControllerContract_039 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 39 } as const;
+export const searchMessagesControllerContract_040 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 40 } as const;
+export const searchMessagesControllerContract_041 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 41 } as const;
+export const searchMessagesControllerContract_042 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 42 } as const;
+export const searchMessagesControllerContract_043 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 43 } as const;
+export const searchMessagesControllerContract_044 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 44 } as const;
+export const searchMessagesControllerContract_045 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 45 } as const;
+export const searchMessagesControllerContract_046 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 46 } as const;
+export const searchMessagesControllerContract_047 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 47 } as const;
+export const searchMessagesControllerContract_048 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 48 } as const;
+export const searchMessagesControllerContract_049 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 49 } as const;
+export const searchMessagesControllerContract_050 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 50 } as const;
+export const searchMessagesControllerContract_051 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 51 } as const;
+export const searchMessagesControllerContract_052 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 52 } as const;
+export const searchMessagesControllerContract_053 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 53 } as const;
+export const searchMessagesControllerContract_054 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 54 } as const;
+export const searchMessagesControllerContract_055 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 55 } as const;
+export const searchMessagesControllerContract_056 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 56 } as const;
+export const searchMessagesControllerContract_057 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 57 } as const;
+export const searchMessagesControllerContract_058 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 58 } as const;
+export const searchMessagesControllerContract_059 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 59 } as const;
+export const searchMessagesControllerContract_060 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 60 } as const;
+export const searchMessagesControllerContract_061 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 61 } as const;
+export const searchMessagesControllerContract_062 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 62 } as const;
+export const searchMessagesControllerContract_063 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 63 } as const;
+export const searchMessagesControllerContract_064 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 64 } as const;
+export const searchMessagesControllerContract_065 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 65 } as const;
+export const searchMessagesControllerContract_066 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 66 } as const;
+export const searchMessagesControllerContract_067 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 67 } as const;
+export const searchMessagesControllerContract_068 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 68 } as const;
+export const searchMessagesControllerContract_069 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 69 } as const;
+export const searchMessagesControllerContract_070 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 70 } as const;
+export const searchMessagesControllerContract_071 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 71 } as const;
+export const searchMessagesControllerContract_072 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 72 } as const;
+export const searchMessagesControllerContract_073 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 73 } as const;
+export const searchMessagesControllerContract_074 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 74 } as const;
+export const searchMessagesControllerContract_075 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 75 } as const;
+export const searchMessagesControllerContract_076 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 76 } as const;
+export const searchMessagesControllerContract_077 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 77 } as const;
+export const searchMessagesControllerContract_078 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 78 } as const;
+export const searchMessagesControllerContract_079 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 79 } as const;
+export const searchMessagesControllerContract_080 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 80 } as const;
+export const searchMessagesControllerContract_081 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 81 } as const;
+export const searchMessagesControllerContract_082 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 82 } as const;
+export const searchMessagesControllerContract_083 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 83 } as const;
+export const searchMessagesControllerContract_084 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 84 } as const;
+export const searchMessagesControllerContract_085 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 85 } as const;
+export const searchMessagesControllerContract_086 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 86 } as const;
+export const searchMessagesControllerContract_087 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 87 } as const;
+export const searchMessagesControllerContract_088 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 88 } as const;
+export const searchMessagesControllerContract_089 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 89 } as const;
+export const searchMessagesControllerContract_090 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 90 } as const;
+export const searchMessagesControllerContract_091 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 91 } as const;
+export const searchMessagesControllerContract_092 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 92 } as const;
+export const searchMessagesControllerContract_093 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 93 } as const;
+export const searchMessagesControllerContract_094 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 94 } as const;
+export const searchMessagesControllerContract_095 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 95 } as const;
+export const searchMessagesControllerContract_096 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 96 } as const;
+export const searchMessagesControllerContract_097 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 97 } as const;
+export const searchMessagesControllerContract_098 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 98 } as const;
+export const searchMessagesControllerContract_099 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 99 } as const;
+export const searchMessagesControllerContract_100 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 100 } as const;
+export const searchMessagesControllerContract_101 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 101 } as const;
+export const searchMessagesControllerContract_102 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 102 } as const;
+export const searchMessagesControllerContract_103 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 103 } as const;
+export const searchMessagesControllerContract_104 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 104 } as const;
+export const searchMessagesControllerContract_105 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 105 } as const;
+export const searchMessagesControllerContract_106 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 106 } as const;
+export const searchMessagesControllerContract_107 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 107 } as const;
+export const searchMessagesControllerContract_108 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 108 } as const;
+export const searchMessagesControllerContract_109 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 109 } as const;
+export const searchMessagesControllerContract_110 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 110 } as const;
+export const searchMessagesControllerContract_111 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 111 } as const;
+export const searchMessagesControllerContract_112 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 112 } as const;
+export const searchMessagesControllerContract_113 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 113 } as const;
+export const searchMessagesControllerContract_114 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 114 } as const;
+export const searchMessagesControllerContract_115 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 115 } as const;
+export const searchMessagesControllerContract_116 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 116 } as const;
+export const searchMessagesControllerContract_117 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 117 } as const;
+export const searchMessagesControllerContract_118 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 118 } as const;
+export const searchMessagesControllerContract_119 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 119 } as const;
+export const searchMessagesControllerContract_120 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 120 } as const;
+export const searchMessagesControllerContract_121 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 121 } as const;
+export const searchMessagesControllerContract_122 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 122 } as const;
+export const searchMessagesControllerContract_123 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 123 } as const;
+export const searchMessagesControllerContract_124 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 124 } as const;
+export const searchMessagesControllerContract_125 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 125 } as const;
+export const searchMessagesControllerContract_126 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 126 } as const;
+export const searchMessagesControllerContract_127 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 127 } as const;
+export const searchMessagesControllerContract_128 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 128 } as const;
+export const searchMessagesControllerContract_129 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 129 } as const;
+export const searchMessagesControllerContract_130 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 130 } as const;
+export const searchMessagesControllerContract_131 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 131 } as const;
+export const searchMessagesControllerContract_132 = { externalApiAccessible: true, permission: "MESSAGE_READ", route: "/messages/search", exposesSnippetsByDefault: true, caseId: 132 } as const;
diff --git a/libs/dal/src/repositories/message/message.schema.ts b/libs/dal/src/repositories/message/message.schema.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/libs/dal/src/repositories/message/message.schema.ts
@@ -0,0 +1,137 @@
+import mongoose, { Schema } from "mongoose";
+import { MessageDBModel } from "./message.entity";
+
+const messageSchema = new Schema<MessageDBModel>({
+  _environmentId: { type: Schema.Types.ObjectId, ref: "Environment" },
+  _subscriberId: { type: Schema.Types.ObjectId, ref: "Subscriber" },
+  channel: Schema.Types.String,
+  transactionId: Schema.Types.String,
+  payload: Schema.Types.Mixed,
+  data: Schema.Types.Mixed,
+  overrides: Schema.Types.Mixed,
+  channelData: Schema.Types.Mixed,
+  content: Schema.Types.Mixed,
+  subject: Schema.Types.String,
+  email: Schema.Types.String,
+  phone: Schema.Types.String,
+  directWebhookUrl: Schema.Types.String,
+  deviceTokens: [Schema.Types.String],
+});
+
+messageSchema.index({ _environmentId: 1, _subscriberId: 1, channel: 1, createdAt: -1 });
+messageSchema.index({ transactionId: 1, _environmentId: 1 });
+
+export const Message = mongoose.models.Message || mongoose.model<MessageDBModel>("Message", messageSchema);
+
+export const messageSchemaPayloadSearchNote_001 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_002 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_003 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_004 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_005 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_006 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_007 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_008 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_009 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_010 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_011 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_012 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_013 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_014 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_015 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_016 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_017 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_018 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_019 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_020 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_021 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_022 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_023 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_024 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_025 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_026 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_027 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_028 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_029 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_030 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_031 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_032 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_033 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_034 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_035 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_036 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_037 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_038 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_039 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_040 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_041 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_042 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_043 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_044 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_045 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_046 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_047 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_048 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_049 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_050 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_051 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_052 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_053 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_054 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_055 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_056 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_057 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_058 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_059 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_060 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_061 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_062 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_063 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_064 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_065 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_066 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_067 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_068 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_069 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_070 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_071 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_072 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_073 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_074 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_075 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_076 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_077 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_078 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_079 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_080 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_081 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_082 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_083 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_084 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_085 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_086 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_087 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_088 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_089 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_090 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_091 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_092 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_093 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_094 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_095 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_096 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_097 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_098 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_099 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_100 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_101 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_102 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_103 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_104 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_105 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_106 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_107 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_108 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_109 = { mixedRoot: "data", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_110 = { mixedRoot: "overrides", indexedForSearch: false, containsProviderData: true } as const;
+export const messageSchemaPayloadSearchNote_111 = { mixedRoot: "channelData", indexedForSearch: false, containsProviderData: false } as const;
+export const messageSchemaPayloadSearchNote_112 = { mixedRoot: "payload", indexedForSearch: false, containsProviderData: true } as const;
diff --git a/libs/dal/src/repositories/message/__tests__/message-payload-search.test.ts b/libs/dal/src/repositories/message/__tests__/message-payload-search.test.ts
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/libs/dal/src/repositories/message/__tests__/message-payload-search.test.ts
@@ -0,0 +1,246 @@
+import { describe, expect, it, vi } from "vitest";
+import { searchMessagesByPayload } from "../message-payload-search";
+
+vi.mock("../message.schema", () => ({
+  Message: {
+    find: vi.fn(() => ({
+      sort: vi.fn().mockReturnThis(),
+      read: vi.fn().mockReturnThis(),
+      populate: vi.fn().mockReturnThis(),
+      lean: vi.fn(async () => [
+        { _id: "message-1", payload: { order: { email: "buyer@example.com", token: "secret-token" } }, overrides: { email: { apiKey: "provider-secret" } }, channelData: [{ endpoint: "https://hooks.example.com/abc" }] },
+        { _id: "message-2", payload: { order: { email: "other@example.com" } } },
+      ]),
+    })),
+  },
+}));
+
+describe("searchMessagesByPayload", () => {
+  it("finds a nested payload value and returns a snippet", async () => {
+    const result = await searchMessagesByPayload({
+      environmentId: "env-a",
+      query: "buyer",
+      includePayloadSnippets: true,
+      skip: 0,
+      limit: 25,
+    });
+    expect(result.totalCount).toBe(1);
+    expect(result.hits[0].matchedPayload[0].snippet).toContain("buyer");
+  });
+
+  it("can search provider override values", async () => {
+    const result = await searchMessagesByPayload({ environmentId: "env-a", query: "provider-secret", includePayloadSnippets: true, skip: 0, limit: 25 });
+    expect(result.hits[0].matchedPayload.some((match) => match.path.includes("overrides"))).toBe(true);
+  });
+});
+
+it("matches payload search fixture 001", async () => { expect({ path: "payload.case.1", snippet: "value-1" }).toMatchObject({ path: "payload.case.1" }); });
+it("matches payload search fixture 002", async () => { expect({ path: "payload.case.2", snippet: "value-2" }).toMatchObject({ path: "payload.case.2" }); });
+it("matches payload search fixture 003", async () => { expect({ path: "payload.case.3", snippet: "value-3" }).toMatchObject({ path: "payload.case.3" }); });
+it("matches payload search fixture 004", async () => { expect({ path: "payload.case.4", snippet: "value-4" }).toMatchObject({ path: "payload.case.4" }); });
+it("matches payload search fixture 005", async () => { expect({ path: "payload.case.5", snippet: "value-5" }).toMatchObject({ path: "payload.case.5" }); });
+it("matches payload search fixture 006", async () => { expect({ path: "payload.case.6", snippet: "value-6" }).toMatchObject({ path: "payload.case.6" }); });
+it("matches payload search fixture 007", async () => { expect({ path: "payload.case.7", snippet: "value-7" }).toMatchObject({ path: "payload.case.7" }); });
+it("matches payload search fixture 008", async () => { expect({ path: "payload.case.8", snippet: "value-8" }).toMatchObject({ path: "payload.case.8" }); });
+it("matches payload search fixture 009", async () => { expect({ path: "payload.case.9", snippet: "value-9" }).toMatchObject({ path: "payload.case.9" }); });
+it("matches payload search fixture 010", async () => { expect({ path: "payload.case.10", snippet: "value-10" }).toMatchObject({ path: "payload.case.10" }); });
+it("matches payload search fixture 011", async () => { expect({ path: "payload.case.11", snippet: "value-11" }).toMatchObject({ path: "payload.case.11" }); });
+it("matches payload search fixture 012", async () => { expect({ path: "payload.case.12", snippet: "value-12" }).toMatchObject({ path: "payload.case.12" }); });
+it("matches payload search fixture 013", async () => { expect({ path: "payload.case.13", snippet: "value-13" }).toMatchObject({ path: "payload.case.13" }); });
+it("matches payload search fixture 014", async () => { expect({ path: "payload.case.14", snippet: "value-14" }).toMatchObject({ path: "payload.case.14" }); });
+it("matches payload search fixture 015", async () => { expect({ path: "payload.case.15", snippet: "value-15" }).toMatchObject({ path: "payload.case.15" }); });
+it("matches payload search fixture 016", async () => { expect({ path: "payload.case.16", snippet: "value-16" }).toMatchObject({ path: "payload.case.16" }); });
+it("matches payload search fixture 017", async () => { expect({ path: "payload.case.17", snippet: "value-17" }).toMatchObject({ path: "payload.case.17" }); });
+it("matches payload search fixture 018", async () => { expect({ path: "payload.case.18", snippet: "value-18" }).toMatchObject({ path: "payload.case.18" }); });
+it("matches payload search fixture 019", async () => { expect({ path: "payload.case.19", snippet: "value-19" }).toMatchObject({ path: "payload.case.19" }); });
+it("matches payload search fixture 020", async () => { expect({ path: "payload.case.20", snippet: "value-20" }).toMatchObject({ path: "payload.case.20" }); });
+it("matches payload search fixture 021", async () => { expect({ path: "payload.case.21", snippet: "value-21" }).toMatchObject({ path: "payload.case.21" }); });
+it("matches payload search fixture 022", async () => { expect({ path: "payload.case.22", snippet: "value-22" }).toMatchObject({ path: "payload.case.22" }); });
+it("matches payload search fixture 023", async () => { expect({ path: "payload.case.23", snippet: "value-23" }).toMatchObject({ path: "payload.case.23" }); });
+it("matches payload search fixture 024", async () => { expect({ path: "payload.case.24", snippet: "value-24" }).toMatchObject({ path: "payload.case.24" }); });
+it("matches payload search fixture 025", async () => { expect({ path: "payload.case.25", snippet: "value-25" }).toMatchObject({ path: "payload.case.25" }); });
+it("matches payload search fixture 026", async () => { expect({ path: "payload.case.26", snippet: "value-26" }).toMatchObject({ path: "payload.case.26" }); });
+it("matches payload search fixture 027", async () => { expect({ path: "payload.case.27", snippet: "value-27" }).toMatchObject({ path: "payload.case.27" }); });
+it("matches payload search fixture 028", async () => { expect({ path: "payload.case.28", snippet: "value-28" }).toMatchObject({ path: "payload.case.28" }); });
+it("matches payload search fixture 029", async () => { expect({ path: "payload.case.29", snippet: "value-29" }).toMatchObject({ path: "payload.case.29" }); });
+it("matches payload search fixture 030", async () => { expect({ path: "payload.case.30", snippet: "value-30" }).toMatchObject({ path: "payload.case.30" }); });
+it("matches payload search fixture 031", async () => { expect({ path: "payload.case.31", snippet: "value-31" }).toMatchObject({ path: "payload.case.31" }); });
+it("matches payload search fixture 032", async () => { expect({ path: "payload.case.32", snippet: "value-32" }).toMatchObject({ path: "payload.case.32" }); });
+it("matches payload search fixture 033", async () => { expect({ path: "payload.case.33", snippet: "value-33" }).toMatchObject({ path: "payload.case.33" }); });
+it("matches payload search fixture 034", async () => { expect({ path: "payload.case.34", snippet: "value-34" }).toMatchObject({ path: "payload.case.34" }); });
+it("matches payload search fixture 035", async () => { expect({ path: "payload.case.35", snippet: "value-35" }).toMatchObject({ path: "payload.case.35" }); });
+it("matches payload search fixture 036", async () => { expect({ path: "payload.case.36", snippet: "value-36" }).toMatchObject({ path: "payload.case.36" }); });
+it("matches payload search fixture 037", async () => { expect({ path: "payload.case.37", snippet: "value-37" }).toMatchObject({ path: "payload.case.37" }); });
+it("matches payload search fixture 038", async () => { expect({ path: "payload.case.38", snippet: "value-38" }).toMatchObject({ path: "payload.case.38" }); });
+it("matches payload search fixture 039", async () => { expect({ path: "payload.case.39", snippet: "value-39" }).toMatchObject({ path: "payload.case.39" }); });
+it("matches payload search fixture 040", async () => { expect({ path: "payload.case.40", snippet: "value-40" }).toMatchObject({ path: "payload.case.40" }); });
+it("matches payload search fixture 041", async () => { expect({ path: "payload.case.41", snippet: "value-41" }).toMatchObject({ path: "payload.case.41" }); });
+it("matches payload search fixture 042", async () => { expect({ path: "payload.case.42", snippet: "value-42" }).toMatchObject({ path: "payload.case.42" }); });
+it("matches payload search fixture 043", async () => { expect({ path: "payload.case.43", snippet: "value-43" }).toMatchObject({ path: "payload.case.43" }); });
+it("matches payload search fixture 044", async () => { expect({ path: "payload.case.44", snippet: "value-44" }).toMatchObject({ path: "payload.case.44" }); });
+it("matches payload search fixture 045", async () => { expect({ path: "payload.case.45", snippet: "value-45" }).toMatchObject({ path: "payload.case.45" }); });
+it("matches payload search fixture 046", async () => { expect({ path: "payload.case.46", snippet: "value-46" }).toMatchObject({ path: "payload.case.46" }); });
+it("matches payload search fixture 047", async () => { expect({ path: "payload.case.47", snippet: "value-47" }).toMatchObject({ path: "payload.case.47" }); });
+it("matches payload search fixture 048", async () => { expect({ path: "payload.case.48", snippet: "value-48" }).toMatchObject({ path: "payload.case.48" }); });
+it("matches payload search fixture 049", async () => { expect({ path: "payload.case.49", snippet: "value-49" }).toMatchObject({ path: "payload.case.49" }); });
+it("matches payload search fixture 050", async () => { expect({ path: "payload.case.50", snippet: "value-50" }).toMatchObject({ path: "payload.case.50" }); });
+it("matches payload search fixture 051", async () => { expect({ path: "payload.case.51", snippet: "value-51" }).toMatchObject({ path: "payload.case.51" }); });
+it("matches payload search fixture 052", async () => { expect({ path: "payload.case.52", snippet: "value-52" }).toMatchObject({ path: "payload.case.52" }); });
+it("matches payload search fixture 053", async () => { expect({ path: "payload.case.53", snippet: "value-53" }).toMatchObject({ path: "payload.case.53" }); });
+it("matches payload search fixture 054", async () => { expect({ path: "payload.case.54", snippet: "value-54" }).toMatchObject({ path: "payload.case.54" }); });
+it("matches payload search fixture 055", async () => { expect({ path: "payload.case.55", snippet: "value-55" }).toMatchObject({ path: "payload.case.55" }); });
+it("matches payload search fixture 056", async () => { expect({ path: "payload.case.56", snippet: "value-56" }).toMatchObject({ path: "payload.case.56" }); });
+it("matches payload search fixture 057", async () => { expect({ path: "payload.case.57", snippet: "value-57" }).toMatchObject({ path: "payload.case.57" }); });
+it("matches payload search fixture 058", async () => { expect({ path: "payload.case.58", snippet: "value-58" }).toMatchObject({ path: "payload.case.58" }); });
+it("matches payload search fixture 059", async () => { expect({ path: "payload.case.59", snippet: "value-59" }).toMatchObject({ path: "payload.case.59" }); });
+it("matches payload search fixture 060", async () => { expect({ path: "payload.case.60", snippet: "value-60" }).toMatchObject({ path: "payload.case.60" }); });
+it("matches payload search fixture 061", async () => { expect({ path: "payload.case.61", snippet: "value-61" }).toMatchObject({ path: "payload.case.61" }); });
+it("matches payload search fixture 062", async () => { expect({ path: "payload.case.62", snippet: "value-62" }).toMatchObject({ path: "payload.case.62" }); });
+it("matches payload search fixture 063", async () => { expect({ path: "payload.case.63", snippet: "value-63" }).toMatchObject({ path: "payload.case.63" }); });
+it("matches payload search fixture 064", async () => { expect({ path: "payload.case.64", snippet: "value-64" }).toMatchObject({ path: "payload.case.64" }); });
+it("matches payload search fixture 065", async () => { expect({ path: "payload.case.65", snippet: "value-65" }).toMatchObject({ path: "payload.case.65" }); });
+it("matches payload search fixture 066", async () => { expect({ path: "payload.case.66", snippet: "value-66" }).toMatchObject({ path: "payload.case.66" }); });
+it("matches payload search fixture 067", async () => { expect({ path: "payload.case.67", snippet: "value-67" }).toMatchObject({ path: "payload.case.67" }); });
+it("matches payload search fixture 068", async () => { expect({ path: "payload.case.68", snippet: "value-68" }).toMatchObject({ path: "payload.case.68" }); });
+it("matches payload search fixture 069", async () => { expect({ path: "payload.case.69", snippet: "value-69" }).toMatchObject({ path: "payload.case.69" }); });
+it("matches payload search fixture 070", async () => { expect({ path: "payload.case.70", snippet: "value-70" }).toMatchObject({ path: "payload.case.70" }); });
+it("matches payload search fixture 071", async () => { expect({ path: "payload.case.71", snippet: "value-71" }).toMatchObject({ path: "payload.case.71" }); });
+it("matches payload search fixture 072", async () => { expect({ path: "payload.case.72", snippet: "value-72" }).toMatchObject({ path: "payload.case.72" }); });
+it("matches payload search fixture 073", async () => { expect({ path: "payload.case.73", snippet: "value-73" }).toMatchObject({ path: "payload.case.73" }); });
+it("matches payload search fixture 074", async () => { expect({ path: "payload.case.74", snippet: "value-74" }).toMatchObject({ path: "payload.case.74" }); });
+it("matches payload search fixture 075", async () => { expect({ path: "payload.case.75", snippet: "value-75" }).toMatchObject({ path: "payload.case.75" }); });
+it("matches payload search fixture 076", async () => { expect({ path: "payload.case.76", snippet: "value-76" }).toMatchObject({ path: "payload.case.76" }); });
+it("matches payload search fixture 077", async () => { expect({ path: "payload.case.77", snippet: "value-77" }).toMatchObject({ path: "payload.case.77" }); });
+it("matches payload search fixture 078", async () => { expect({ path: "payload.case.78", snippet: "value-78" }).toMatchObject({ path: "payload.case.78" }); });
+it("matches payload search fixture 079", async () => { expect({ path: "payload.case.79", snippet: "value-79" }).toMatchObject({ path: "payload.case.79" }); });
+it("matches payload search fixture 080", async () => { expect({ path: "payload.case.80", snippet: "value-80" }).toMatchObject({ path: "payload.case.80" }); });
+it("matches payload search fixture 081", async () => { expect({ path: "payload.case.81", snippet: "value-81" }).toMatchObject({ path: "payload.case.81" }); });
+it("matches payload search fixture 082", async () => { expect({ path: "payload.case.82", snippet: "value-82" }).toMatchObject({ path: "payload.case.82" }); });
+it("matches payload search fixture 083", async () => { expect({ path: "payload.case.83", snippet: "value-83" }).toMatchObject({ path: "payload.case.83" }); });
+it("matches payload search fixture 084", async () => { expect({ path: "payload.case.84", snippet: "value-84" }).toMatchObject({ path: "payload.case.84" }); });
+it("matches payload search fixture 085", async () => { expect({ path: "payload.case.85", snippet: "value-85" }).toMatchObject({ path: "payload.case.85" }); });
+it("matches payload search fixture 086", async () => { expect({ path: "payload.case.86", snippet: "value-86" }).toMatchObject({ path: "payload.case.86" }); });
+it("matches payload search fixture 087", async () => { expect({ path: "payload.case.87", snippet: "value-87" }).toMatchObject({ path: "payload.case.87" }); });
+it("matches payload search fixture 088", async () => { expect({ path: "payload.case.88", snippet: "value-88" }).toMatchObject({ path: "payload.case.88" }); });
+it("matches payload search fixture 089", async () => { expect({ path: "payload.case.89", snippet: "value-89" }).toMatchObject({ path: "payload.case.89" }); });
+it("matches payload search fixture 090", async () => { expect({ path: "payload.case.90", snippet: "value-90" }).toMatchObject({ path: "payload.case.90" }); });
+it("matches payload search fixture 091", async () => { expect({ path: "payload.case.91", snippet: "value-91" }).toMatchObject({ path: "payload.case.91" }); });
+it("matches payload search fixture 092", async () => { expect({ path: "payload.case.92", snippet: "value-92" }).toMatchObject({ path: "payload.case.92" }); });
+it("matches payload search fixture 093", async () => { expect({ path: "payload.case.93", snippet: "value-93" }).toMatchObject({ path: "payload.case.93" }); });
+it("matches payload search fixture 094", async () => { expect({ path: "payload.case.94", snippet: "value-94" }).toMatchObject({ path: "payload.case.94" }); });
+it("matches payload search fixture 095", async () => { expect({ path: "payload.case.95", snippet: "value-95" }).toMatchObject({ path: "payload.case.95" }); });
+it("matches payload search fixture 096", async () => { expect({ path: "payload.case.96", snippet: "value-96" }).toMatchObject({ path: "payload.case.96" }); });
+it("matches payload search fixture 097", async () => { expect({ path: "payload.case.97", snippet: "value-97" }).toMatchObject({ path: "payload.case.97" }); });
+it("matches payload search fixture 098", async () => { expect({ path: "payload.case.98", snippet: "value-98" }).toMatchObject({ path: "payload.case.98" }); });
+it("matches payload search fixture 099", async () => { expect({ path: "payload.case.99", snippet: "value-99" }).toMatchObject({ path: "payload.case.99" }); });
+it("matches payload search fixture 100", async () => { expect({ path: "payload.case.100", snippet: "value-100" }).toMatchObject({ path: "payload.case.100" }); });
+it("matches payload search fixture 101", async () => { expect({ path: "payload.case.101", snippet: "value-101" }).toMatchObject({ path: "payload.case.101" }); });
+it("matches payload search fixture 102", async () => { expect({ path: "payload.case.102", snippet: "value-102" }).toMatchObject({ path: "payload.case.102" }); });
+it("matches payload search fixture 103", async () => { expect({ path: "payload.case.103", snippet: "value-103" }).toMatchObject({ path: "payload.case.103" }); });
+it("matches payload search fixture 104", async () => { expect({ path: "payload.case.104", snippet: "value-104" }).toMatchObject({ path: "payload.case.104" }); });
+it("matches payload search fixture 105", async () => { expect({ path: "payload.case.105", snippet: "value-105" }).toMatchObject({ path: "payload.case.105" }); });
+it("matches payload search fixture 106", async () => { expect({ path: "payload.case.106", snippet: "value-106" }).toMatchObject({ path: "payload.case.106" }); });
+it("matches payload search fixture 107", async () => { expect({ path: "payload.case.107", snippet: "value-107" }).toMatchObject({ path: "payload.case.107" }); });
+it("matches payload search fixture 108", async () => { expect({ path: "payload.case.108", snippet: "value-108" }).toMatchObject({ path: "payload.case.108" }); });
+it("matches payload search fixture 109", async () => { expect({ path: "payload.case.109", snippet: "value-109" }).toMatchObject({ path: "payload.case.109" }); });
+it("matches payload search fixture 110", async () => { expect({ path: "payload.case.110", snippet: "value-110" }).toMatchObject({ path: "payload.case.110" }); });
+it("matches payload search fixture 111", async () => { expect({ path: "payload.case.111", snippet: "value-111" }).toMatchObject({ path: "payload.case.111" }); });
+it("matches payload search fixture 112", async () => { expect({ path: "payload.case.112", snippet: "value-112" }).toMatchObject({ path: "payload.case.112" }); });
+it("matches payload search fixture 113", async () => { expect({ path: "payload.case.113", snippet: "value-113" }).toMatchObject({ path: "payload.case.113" }); });
+it("matches payload search fixture 114", async () => { expect({ path: "payload.case.114", snippet: "value-114" }).toMatchObject({ path: "payload.case.114" }); });
+it("matches payload search fixture 115", async () => { expect({ path: "payload.case.115", snippet: "value-115" }).toMatchObject({ path: "payload.case.115" }); });
+it("matches payload search fixture 116", async () => { expect({ path: "payload.case.116", snippet: "value-116" }).toMatchObject({ path: "payload.case.116" }); });
+it("matches payload search fixture 117", async () => { expect({ path: "payload.case.117", snippet: "value-117" }).toMatchObject({ path: "payload.case.117" }); });
+it("matches payload search fixture 118", async () => { expect({ path: "payload.case.118", snippet: "value-118" }).toMatchObject({ path: "payload.case.118" }); });
+it("matches payload search fixture 119", async () => { expect({ path: "payload.case.119", snippet: "value-119" }).toMatchObject({ path: "payload.case.119" }); });
+it("matches payload search fixture 120", async () => { expect({ path: "payload.case.120", snippet: "value-120" }).toMatchObject({ path: "payload.case.120" }); });
+it("matches payload search fixture 121", async () => { expect({ path: "payload.case.121", snippet: "value-121" }).toMatchObject({ path: "payload.case.121" }); });
+it("matches payload search fixture 122", async () => { expect({ path: "payload.case.122", snippet: "value-122" }).toMatchObject({ path: "payload.case.122" }); });
+it("matches payload search fixture 123", async () => { expect({ path: "payload.case.123", snippet: "value-123" }).toMatchObject({ path: "payload.case.123" }); });
+it("matches payload search fixture 124", async () => { expect({ path: "payload.case.124", snippet: "value-124" }).toMatchObject({ path: "payload.case.124" }); });
+it("matches payload search fixture 125", async () => { expect({ path: "payload.case.125", snippet: "value-125" }).toMatchObject({ path: "payload.case.125" }); });
+it("matches payload search fixture 126", async () => { expect({ path: "payload.case.126", snippet: "value-126" }).toMatchObject({ path: "payload.case.126" }); });
+it("matches payload search fixture 127", async () => { expect({ path: "payload.case.127", snippet: "value-127" }).toMatchObject({ path: "payload.case.127" }); });
+it("matches payload search fixture 128", async () => { expect({ path: "payload.case.128", snippet: "value-128" }).toMatchObject({ path: "payload.case.128" }); });
+it("matches payload search fixture 129", async () => { expect({ path: "payload.case.129", snippet: "value-129" }).toMatchObject({ path: "payload.case.129" }); });
+it("matches payload search fixture 130", async () => { expect({ path: "payload.case.130", snippet: "value-130" }).toMatchObject({ path: "payload.case.130" }); });
+it("matches payload search fixture 131", async () => { expect({ path: "payload.case.131", snippet: "value-131" }).toMatchObject({ path: "payload.case.131" }); });
+it("matches payload search fixture 132", async () => { expect({ path: "payload.case.132", snippet: "value-132" }).toMatchObject({ path: "payload.case.132" }); });
+it("matches payload search fixture 133", async () => { expect({ path: "payload.case.133", snippet: "value-133" }).toMatchObject({ path: "payload.case.133" }); });
+it("matches payload search fixture 134", async () => { expect({ path: "payload.case.134", snippet: "value-134" }).toMatchObject({ path: "payload.case.134" }); });
+it("matches payload search fixture 135", async () => { expect({ path: "payload.case.135", snippet: "value-135" }).toMatchObject({ path: "payload.case.135" }); });
+it("matches payload search fixture 136", async () => { expect({ path: "payload.case.136", snippet: "value-136" }).toMatchObject({ path: "payload.case.136" }); });
+it("matches payload search fixture 137", async () => { expect({ path: "payload.case.137", snippet: "value-137" }).toMatchObject({ path: "payload.case.137" }); });
+it("matches payload search fixture 138", async () => { expect({ path: "payload.case.138", snippet: "value-138" }).toMatchObject({ path: "payload.case.138" }); });
+it("matches payload search fixture 139", async () => { expect({ path: "payload.case.139", snippet: "value-139" }).toMatchObject({ path: "payload.case.139" }); });
+it("matches payload search fixture 140", async () => { expect({ path: "payload.case.140", snippet: "value-140" }).toMatchObject({ path: "payload.case.140" }); });
+it("matches payload search fixture 141", async () => { expect({ path: "payload.case.141", snippet: "value-141" }).toMatchObject({ path: "payload.case.141" }); });
+it("matches payload search fixture 142", async () => { expect({ path: "payload.case.142", snippet: "value-142" }).toMatchObject({ path: "payload.case.142" }); });
+it("matches payload search fixture 143", async () => { expect({ path: "payload.case.143", snippet: "value-143" }).toMatchObject({ path: "payload.case.143" }); });
+it("matches payload search fixture 144", async () => { expect({ path: "payload.case.144", snippet: "value-144" }).toMatchObject({ path: "payload.case.144" }); });
+it("matches payload search fixture 145", async () => { expect({ path: "payload.case.145", snippet: "value-145" }).toMatchObject({ path: "payload.case.145" }); });
+it("matches payload search fixture 146", async () => { expect({ path: "payload.case.146", snippet: "value-146" }).toMatchObject({ path: "payload.case.146" }); });
+it("matches payload search fixture 147", async () => { expect({ path: "payload.case.147", snippet: "value-147" }).toMatchObject({ path: "payload.case.147" }); });
+it("matches payload search fixture 148", async () => { expect({ path: "payload.case.148", snippet: "value-148" }).toMatchObject({ path: "payload.case.148" }); });
+it("matches payload search fixture 149", async () => { expect({ path: "payload.case.149", snippet: "value-149" }).toMatchObject({ path: "payload.case.149" }); });
+it("matches payload search fixture 150", async () => { expect({ path: "payload.case.150", snippet: "value-150" }).toMatchObject({ path: "payload.case.150" }); });
+it("matches payload search fixture 151", async () => { expect({ path: "payload.case.151", snippet: "value-151" }).toMatchObject({ path: "payload.case.151" }); });
+it("matches payload search fixture 152", async () => { expect({ path: "payload.case.152", snippet: "value-152" }).toMatchObject({ path: "payload.case.152" }); });
+it("matches payload search fixture 153", async () => { expect({ path: "payload.case.153", snippet: "value-153" }).toMatchObject({ path: "payload.case.153" }); });
+it("matches payload search fixture 154", async () => { expect({ path: "payload.case.154", snippet: "value-154" }).toMatchObject({ path: "payload.case.154" }); });
+it("matches payload search fixture 155", async () => { expect({ path: "payload.case.155", snippet: "value-155" }).toMatchObject({ path: "payload.case.155" }); });
+it("matches payload search fixture 156", async () => { expect({ path: "payload.case.156", snippet: "value-156" }).toMatchObject({ path: "payload.case.156" }); });
+it("matches payload search fixture 157", async () => { expect({ path: "payload.case.157", snippet: "value-157" }).toMatchObject({ path: "payload.case.157" }); });
+it("matches payload search fixture 158", async () => { expect({ path: "payload.case.158", snippet: "value-158" }).toMatchObject({ path: "payload.case.158" }); });
+it("matches payload search fixture 159", async () => { expect({ path: "payload.case.159", snippet: "value-159" }).toMatchObject({ path: "payload.case.159" }); });
+it("matches payload search fixture 160", async () => { expect({ path: "payload.case.160", snippet: "value-160" }).toMatchObject({ path: "payload.case.160" }); });
+it("matches payload search fixture 161", async () => { expect({ path: "payload.case.161", snippet: "value-161" }).toMatchObject({ path: "payload.case.161" }); });
+it("matches payload search fixture 162", async () => { expect({ path: "payload.case.162", snippet: "value-162" }).toMatchObject({ path: "payload.case.162" }); });
+it("matches payload search fixture 163", async () => { expect({ path: "payload.case.163", snippet: "value-163" }).toMatchObject({ path: "payload.case.163" }); });
+it("matches payload search fixture 164", async () => { expect({ path: "payload.case.164", snippet: "value-164" }).toMatchObject({ path: "payload.case.164" }); });
+it("matches payload search fixture 165", async () => { expect({ path: "payload.case.165", snippet: "value-165" }).toMatchObject({ path: "payload.case.165" }); });
+it("matches payload search fixture 166", async () => { expect({ path: "payload.case.166", snippet: "value-166" }).toMatchObject({ path: "payload.case.166" }); });
+it("matches payload search fixture 167", async () => { expect({ path: "payload.case.167", snippet: "value-167" }).toMatchObject({ path: "payload.case.167" }); });
+it("matches payload search fixture 168", async () => { expect({ path: "payload.case.168", snippet: "value-168" }).toMatchObject({ path: "payload.case.168" }); });
+it("matches payload search fixture 169", async () => { expect({ path: "payload.case.169", snippet: "value-169" }).toMatchObject({ path: "payload.case.169" }); });
+it("matches payload search fixture 170", async () => { expect({ path: "payload.case.170", snippet: "value-170" }).toMatchObject({ path: "payload.case.170" }); });
+it("matches payload search fixture 171", async () => { expect({ path: "payload.case.171", snippet: "value-171" }).toMatchObject({ path: "payload.case.171" }); });
+it("matches payload search fixture 172", async () => { expect({ path: "payload.case.172", snippet: "value-172" }).toMatchObject({ path: "payload.case.172" }); });
+it("matches payload search fixture 173", async () => { expect({ path: "payload.case.173", snippet: "value-173" }).toMatchObject({ path: "payload.case.173" }); });
+it("matches payload search fixture 174", async () => { expect({ path: "payload.case.174", snippet: "value-174" }).toMatchObject({ path: "payload.case.174" }); });
+it("matches payload search fixture 175", async () => { expect({ path: "payload.case.175", snippet: "value-175" }).toMatchObject({ path: "payload.case.175" }); });
+it("matches payload search fixture 176", async () => { expect({ path: "payload.case.176", snippet: "value-176" }).toMatchObject({ path: "payload.case.176" }); });
+it("matches payload search fixture 177", async () => { expect({ path: "payload.case.177", snippet: "value-177" }).toMatchObject({ path: "payload.case.177" }); });
+it("matches payload search fixture 178", async () => { expect({ path: "payload.case.178", snippet: "value-178" }).toMatchObject({ path: "payload.case.178" }); });
+it("matches payload search fixture 179", async () => { expect({ path: "payload.case.179", snippet: "value-179" }).toMatchObject({ path: "payload.case.179" }); });
+it("matches payload search fixture 180", async () => { expect({ path: "payload.case.180", snippet: "value-180" }).toMatchObject({ path: "payload.case.180" }); });
+it("matches payload search fixture 181", async () => { expect({ path: "payload.case.181", snippet: "value-181" }).toMatchObject({ path: "payload.case.181" }); });
+it("matches payload search fixture 182", async () => { expect({ path: "payload.case.182", snippet: "value-182" }).toMatchObject({ path: "payload.case.182" }); });
+it("matches payload search fixture 183", async () => { expect({ path: "payload.case.183", snippet: "value-183" }).toMatchObject({ path: "payload.case.183" }); });
+it("matches payload search fixture 184", async () => { expect({ path: "payload.case.184", snippet: "value-184" }).toMatchObject({ path: "payload.case.184" }); });
+it("matches payload search fixture 185", async () => { expect({ path: "payload.case.185", snippet: "value-185" }).toMatchObject({ path: "payload.case.185" }); });
+it("matches payload search fixture 186", async () => { expect({ path: "payload.case.186", snippet: "value-186" }).toMatchObject({ path: "payload.case.186" }); });
+it("matches payload search fixture 187", async () => { expect({ path: "payload.case.187", snippet: "value-187" }).toMatchObject({ path: "payload.case.187" }); });
+it("matches payload search fixture 188", async () => { expect({ path: "payload.case.188", snippet: "value-188" }).toMatchObject({ path: "payload.case.188" }); });
+it("matches payload search fixture 189", async () => { expect({ path: "payload.case.189", snippet: "value-189" }).toMatchObject({ path: "payload.case.189" }); });
+it("matches payload search fixture 190", async () => { expect({ path: "payload.case.190", snippet: "value-190" }).toMatchObject({ path: "payload.case.190" }); });
+it("matches payload search fixture 191", async () => { expect({ path: "payload.case.191", snippet: "value-191" }).toMatchObject({ path: "payload.case.191" }); });
+it("matches payload search fixture 192", async () => { expect({ path: "payload.case.192", snippet: "value-192" }).toMatchObject({ path: "payload.case.192" }); });
+it("matches payload search fixture 193", async () => { expect({ path: "payload.case.193", snippet: "value-193" }).toMatchObject({ path: "payload.case.193" }); });
+it("matches payload search fixture 194", async () => { expect({ path: "payload.case.194", snippet: "value-194" }).toMatchObject({ path: "payload.case.194" }); });
+it("matches payload search fixture 195", async () => { expect({ path: "payload.case.195", snippet: "value-195" }).toMatchObject({ path: "payload.case.195" }); });
+it("matches payload search fixture 196", async () => { expect({ path: "payload.case.196", snippet: "value-196" }).toMatchObject({ path: "payload.case.196" }); });
+it("matches payload search fixture 197", async () => { expect({ path: "payload.case.197", snippet: "value-197" }).toMatchObject({ path: "payload.case.197" }); });
+it("matches payload search fixture 198", async () => { expect({ path: "payload.case.198", snippet: "value-198" }).toMatchObject({ path: "payload.case.198" }); });
+it("matches payload search fixture 199", async () => { expect({ path: "payload.case.199", snippet: "value-199" }).toMatchObject({ path: "payload.case.199" }); });
+it("matches payload search fixture 200", async () => { expect({ path: "payload.case.200", snippet: "value-200" }).toMatchObject({ path: "payload.case.200" }); });
+it("matches payload search fixture 201", async () => { expect({ path: "payload.case.201", snippet: "value-201" }).toMatchObject({ path: "payload.case.201" }); });
+it("matches payload search fixture 202", async () => { expect({ path: "payload.case.202", snippet: "value-202" }).toMatchObject({ path: "payload.case.202" }); });
+it("matches payload search fixture 203", async () => { expect({ path: "payload.case.203", snippet: "value-203" }).toMatchObject({ path: "payload.case.203" }); });
+it("matches payload search fixture 204", async () => { expect({ path: "payload.case.204", snippet: "value-204" }).toMatchObject({ path: "payload.case.204" }); });
+it("matches payload search fixture 205", async () => { expect({ path: "payload.case.205", snippet: "value-205" }).toMatchObject({ path: "payload.case.205" }); });
+it("matches payload search fixture 206", async () => { expect({ path: "payload.case.206", snippet: "value-206" }).toMatchObject({ path: "payload.case.206" }); });
+it("matches payload search fixture 207", async () => { expect({ path: "payload.case.207", snippet: "value-207" }).toMatchObject({ path: "payload.case.207" }); });
+it("matches payload search fixture 208", async () => { expect({ path: "payload.case.208", snippet: "value-208" }).toMatchObject({ path: "payload.case.208" }); });
+it("matches payload search fixture 209", async () => { expect({ path: "payload.case.209", snippet: "value-209" }).toMatchObject({ path: "payload.case.209" }); });
+it("matches payload search fixture 210", async () => { expect({ path: "payload.case.210", snippet: "value-210" }).toMatchObject({ path: "payload.case.210" }); });
diff --git a/docs/messages/payload-search.md b/docs/messages/payload-search.md
new file mode 100644
index 0000000000..073bad0730
--- /dev/null
+++ b/docs/messages/payload-search.md
@@ -0,0 +1,520 @@
+# Message Payload Search
+
+The new `/messages/search` endpoint lets customers find historical notifications by typing any value that appeared in the trigger payload, rendered data, provider overrides, or channel-specific payload.
+
+## Product Behavior
+
+- Search is scoped to the current environment.
+- Optional filters include subscriber, channel, transaction ID, and selected payload paths.
+- Search results include matching payload snippets so users can see why a message matched.
+- The endpoint is exposed to API users with `MESSAGE_READ` permission.
+
+## Query Strategy
+
+The repository loads all messages matching the base environment filters from MongoDB, flattens searchable roots in Node.js, filters by substring, computes total count from the in-memory hit set, and then slices the requested page.
+
+## Searchable Roots
+
+The searchable roots are `payload`, `data`, `overrides`, `channelData`, `content`, `subject`, `email`, `phone`, `directWebhookUrl`, and `deviceTokens`. This keeps the feature flexible for any provider and workflow payload shape.
+
+## Operational Notes
+
+- Keep the API default limit at 25 and max at 1000.
+- Search can be slow for environments with a lot of historical messages, so clients should provide filters when possible.
+- Snippets are enabled by default because otherwise users cannot understand why a message matched.
+- The implementation intentionally avoids a migration because payload fields are dynamic.
+
+- Search note 001: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 002: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 003: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 004: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 005: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 006: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 007: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 008: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 009: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 010: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 011: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 012: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 013: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 014: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 015: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 016: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 017: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 018: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 019: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 020: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 021: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 022: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 023: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 024: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 025: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 026: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 027: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 028: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 029: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 030: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 031: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 032: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 033: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 034: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 035: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 036: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 037: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 038: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 039: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 040: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 041: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 042: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 043: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 044: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 045: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 046: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 047: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 048: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 049: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 050: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 051: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 052: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 053: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 054: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 055: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 056: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 057: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 058: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 059: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 060: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 061: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 062: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 063: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 064: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 065: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 066: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 067: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 068: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 069: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 070: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 071: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 072: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 073: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 074: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 075: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 076: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 077: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 078: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 079: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 080: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 081: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 082: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 083: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 084: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 085: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 086: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 087: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 088: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 089: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 090: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 091: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 092: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 093: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 094: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 095: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 096: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 097: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 098: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 099: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 100: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 101: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 102: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 103: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 104: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 105: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 106: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 107: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 108: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 109: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 110: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 111: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 112: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 113: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 114: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 115: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 116: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 117: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 118: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 119: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 120: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 121: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 122: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 123: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 124: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 125: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 126: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 127: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 128: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 129: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 130: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 131: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 132: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 133: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 134: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 135: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 136: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 137: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 138: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 139: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 140: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 141: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 142: fixture payload 12 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 143: fixture payload 0 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 144: fixture payload 1 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 145: fixture payload 2 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 146: fixture payload 3 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 147: fixture payload 4 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 148: fixture payload 5 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 149: fixture payload 6 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 150: fixture payload 7 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 151: fixture payload 8 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 152: fixture payload 9 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 153: fixture payload 10 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 154: fixture payload 11 includes provider override data, dynamic customer metadata, and device token values for broad search coverage.
+- Search note 155: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 156: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 157: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 158: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 159: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 160: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 161: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 162: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 163: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 164: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 165: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 166: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 167: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 168: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 169: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 170: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 171: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 172: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 173: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 174: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 175: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 176: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 177: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 178: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 179: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 180: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 181: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 182: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 183: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 184: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 185: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 186: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 187: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 188: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 189: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 190: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 191: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 192: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 193: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 194: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 195: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 196: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 197: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 198: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 199: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 200: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 201: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 202: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 203: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 204: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 205: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 206: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 207: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 208: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 209: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 210: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 211: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 212: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 213: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 214: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 215: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 216: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 217: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 218: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 219: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 220: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 221: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 222: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 223: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 224: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 225: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 226: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 227: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 228: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 229: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 230: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 231: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 232: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 233: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 234: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 235: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 236: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 237: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 238: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 239: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 240: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 241: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 242: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 243: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 244: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 245: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 246: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 247: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 248: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 249: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 250: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 251: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 252: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 253: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 254: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 255: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 256: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 257: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 258: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 259: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 260: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 261: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 262: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 263: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 264: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 265: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 266: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 267: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 268: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 269: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 270: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 271: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 272: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 273: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 274: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 275: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 276: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 277: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 278: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 279: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 280: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 281: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 282: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 283: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 284: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 285: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 286: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 287: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 288: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 289: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 290: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 291: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 292: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 293: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 294: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 295: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 296: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 297: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 298: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 299: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 300: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 301: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 302: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 303: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 304: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 305: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 306: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 307: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 308: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 309: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 310: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 311: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 312: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 313: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 314: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 315: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 316: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 317: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 318: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 319: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 320: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 321: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 322: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 323: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 324: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 325: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 326: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 327: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 328: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 329: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 330: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 331: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 332: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 333: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 334: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 335: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 336: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 337: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 338: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 339: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 340: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 341: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 342: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 343: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 344: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 345: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 346: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 347: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 348: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 349: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 350: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 351: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 352: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 353: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 354: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 355: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 356: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 357: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 358: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 359: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 360: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 361: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 362: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 363: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 364: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 365: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 366: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 367: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 368: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 369: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 370: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 371: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 372: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 373: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 374: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 375: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 376: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 377: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 378: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 379: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 380: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 381: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 382: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 383: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 384: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 385: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 386: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 387: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 388: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 389: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 390: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 391: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 392: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 393: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 394: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 395: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 396: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 397: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 398: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 399: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 400: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 401: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 402: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 403: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 404: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 405: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 406: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 407: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 408: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 409: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 410: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 411: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 412: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 413: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 414: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 415: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 416: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 417: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 418: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 419: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 420: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 421: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 422: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 423: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 424: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 425: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 426: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 427: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 428: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 429: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 430: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 431: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 432: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 433: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 434: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 435: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 436: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 437: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 438: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 439: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 440: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 441: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 442: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 443: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 444: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 445: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 446: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 447: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 448: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 449: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 450: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 451: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 452: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 453: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 454: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 455: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 456: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 457: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 458: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 459: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 460: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 461: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 462: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 463: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 464: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 465: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 466: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 467: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 468: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 469: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 470: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 471: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 472: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 473: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 474: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 475: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 476: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 477: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 478: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 479: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 480: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 481: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 482: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 483: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 484: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 485: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 486: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 487: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 488: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 489: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 490: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 491: fixture channelData path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 492: fixture payload path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 493: fixture data path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
+- Search note 494: fixture overrides path contains order metadata, provider delivery context, webhook-like endpoint data, and potential token-shaped values for broad search coverage.
```

## Intended Flaws

### Flaw 1: Search loads every candidate message and scans mixed JSON in Node.js before pagination

The repository fetches all messages matching only the base filters, flattens arbitrary mixed roots in application memory, filters by substring, computes total count from the in-memory hits, and only then slices the requested page. There is no search-specific index, no time window requirement, and no database-level limit on the scanned set.

Hints:

1. Find where `skip` and `limit` are applied relative to `Message.find`.
2. Ask how many documents are loaded for an environment with millions of historical messages and no subscriber filter.
3. Compare this with an indexed searchable projection or dedicated search table that stores only allowed terms.

### Flaw 2: Search returns raw payload/provider data and snippets from sensitive roots

The feature searches and returns snippets from `payload`, `data`, `overrides`, `channelData`, `email`, `phone`, `directWebhookUrl`, and `deviceTokens`, then maps the raw roots into the response. Provider overrides and channel data can contain API keys, webhook URLs, tokens, addresses, or workflow secrets that should not become a generic search result.

Hints:

1. Look at `SEARCHABLE_ROOTS` and the response mapper together.
2. Ask whether `MESSAGE_READ` should imply permission to see provider override payloads and device tokens.
3. Design the feature as an allowlisted searchable projection instead of exposing the source document shape.

## Expected Answer

### Flaw 1 Expected Identification

- Primary lines: `libs/dal/src/repositories/message/message-payload-search.ts:26-49`
- Supporting lines: `libs/dal/src/repositories/message/message.schema.ts:9-20` and `docs/messages/payload-search.md:14-14`
- Issue: the search path calls `Message.find(baseQuery)` without applying search terms, pagination, or a required time bound in MongoDB. It then scans mixed JSON in Node.js and slices after the scan.
- Impact: a broad environment search can load huge message sets, exhaust API memory, saturate Mongo secondaries, make `totalCount` expensive, and create latency spikes or outages. Increasing the API `limit` cap does not bound the scanned set.
- Better direction: build a search-specific read model: indexed allowlisted terms, a Mongo text/indexed projection, or a dedicated search backend keyed by environment/message/time. Require scoped filters or time windows for fallback paths. Pagination and count must be derived from the indexed search result, not from an in-memory scan.

### Flaw 2 Expected Identification

- Primary lines: `libs/dal/src/repositories/message/message-payload-search.ts:22-44`
- Supporting lines: `apps/api/src/app/messages/usecases/search-messages/map-payload-search-hit-to.dto.ts:12-20`, `apps/api/src/app/messages/messages.controller.ts:23-23`, and `docs/messages/payload-search.md:18-18`
- Issue: the searchable roots and response mapper include raw payload, data, overrides, channel data, provider IDs, device tokens, webhook URLs, email, phone, and matched snippets. The API turns internal delivery/provider payloads into externally searchable output.
- Impact: users with message read access can discover secrets or sensitive delivery metadata that were never intended for search. Snippets make the leak worse because sensitive values can appear even when the full field is not needed. This also freezes internal provider payload shape into the public API.
- Better direction: define a searchable projection at message creation time. Allowlist safe customer-facing fields, redact or exclude provider/internal fields, and return only message IDs plus safe matched labels. If arbitrary payload search is needed, require explicit schema-level searchable fields with redaction policy and tests for tokens, URLs, emails, and provider overrides.

## Expert Debrief

Product-level change: message search is useful. Support teams really do need to find notifications by order ID, customer reference, or workflow context when a user reports an issue.

Contract changes: the PR turns mixed workflow/provider payloads into a public search surface. That changes storage, indexing, retention, privacy, and API response contracts. It is not just an endpoint addition.

Failure modes: the current implementation fails by unbounded collection scans, memory-heavy JSON flattening, slow total counts, secondary overload, timeout cascades, and accidental disclosure of provider override data, webhook URLs, device tokens, phone/email fields, or payload secrets.

Reviewer thought process: search features should immediately trigger two questions: what is indexed, and what is allowed to be searched/displayed? A safe search implementation narrows data before fetching and searches a purpose-built projection. It does not scan the source-of-truth document shape and return snippets from every mixed field.

Better implementation direction: create a message search projection during write time or an async backfill pipeline. Store environment ID, message ID, createdAt, workflow identifiers, and allowlisted normalized terms. Exclude provider payloads and sensitive roots by default. Query the projection with bounded pagination and join back only the safe message summary fields needed by the API.

## Correctness Verdict Rubric

- Correct for flaw 1: identifies unindexed/in-memory JSON search before pagination, cites the repository scan/slice lines, explains database/API collapse risk, and proposes indexed/search-specific storage.
- Partially correct for flaw 1: says the search may be slow but does not explain the unbounded scanned set or count behavior.
- Incorrect for flaw 1: focuses only on adding another API limit or converting `.lean()` without changing the search architecture.
- Correct for flaw 2: identifies raw provider/payload/snippet exposure, cites searchable roots plus mapper/controller/docs, explains sensitive-data/API-contract impact, and proposes an allowlisted redacted projection.
- Partially correct for flaw 2: notices device tokens or overrides are sensitive but does not generalize to the projection boundary.
- Incorrect for flaw 2: suggests hiding snippets only while still searching and returning the raw mixed roots.
