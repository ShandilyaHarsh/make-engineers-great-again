# TS-047: Cal.com Historical Calendar Sync Backfill

## Metadata

- `id`: TS-047
- `source_repo`: [calcom/cal.diy](https://github.com/calcom/cal.diy)
- `repo_area`: calendar subscription sync, calendar cache, provider pagination, Trigger.dev jobs, selected calendar state, availability correctness
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,600-1,950
- `represented_diff_lines`: 1800
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Cal.com calendar sync, provider rate limits, selected-calendar state, cache reads, Trigger.dev queues, and availability correctness without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a historical calendar sync backfill for users who enable calendar subscription cache after they already have many selected calendars. Today, calendar subscription sync only fills cache from webhook events and the first subscription fetch. The new backfill should scan historical provider events, populate `CalendarCacheEvent`, and mark selected calendars ready for cached availability reads.

The PR adds:

- a backfill run table,
- new selected-calendar backfill status fields,
- a Trigger.dev task to start backfills for a user,
- a Trigger.dev task to process one historical event,
- an API endpoint for admins to start backfills,
- tests for enqueueing and failure handling,
- an operations guide for support.

The intended product behavior is: once a user is backfilled, Cal.com can answer availability from the calendar cache without missing busy events, while avoiding provider API throttling for Google and Microsoft calendars.

## Existing Code Context

The real Cal.com codebase already has these relevant contracts:

- `packages/features/calendars/lib/tasker/trigger/config.ts` defines a shared `calendarsQueue` with a concurrency limit and retry policy for calendar jobs.
- `packages/features/calendars/lib/tasker/trigger/schema.ts` currently uses a small calendar task schema around `userId`.
- `packages/features/calendars/lib/tasker/CalendarsTaskService.ts` ensures default calendars through the existing calendar task path instead of running ad hoc work inline.
- `packages/features/calendars/lib/CalendarManager.ts` resolves credentials, selected calendars, and calendar services. Calendar service failures are represented per credential or thrown by provider calls.
- `packages/features/calendars/lib/getCalendarsEvents.ts` fetches availability from providers across selected calendars. It uses provider calendar services and respects selected-calendar filtering, but it is not a historical backfill system.
- `packages/features/calendar-subscription/lib/CalendarSubscriptionService.ts` fetches provider subscription events, updates `syncToken`, `syncedAt`, and sync error fields, then caches and syncs those events.
- `packages/features/calendar-subscription/adapters/GoogleCalendarSubscription.adapter.ts` fetches events through Google pagination and stores the returned `nextSyncToken`. Initial sync is intentionally bounded to the configured cache horizon.
- `packages/features/calendar-subscription/adapters/Office365CalendarSubscription.adapter.ts` uses Microsoft delta links as the sync token and paginates through delta responses.
- `packages/features/calendar-subscription/lib/cache/CalendarCacheWrapper.ts` serves availability from cache only for selected calendars with both `syncToken` and `syncSubscribedAt`; calendars missing either field fall back to the original provider.
- `packages/features/calendar-subscription/lib/cache/CalendarCacheEventService.ts` upserts busy events into `CalendarCacheEvent` and deletes free/cancelled events.
- `packages/features/selectedCalendar/repositories/SelectedCalendarRepository.ts` centralizes selected-calendar sync and subscription updates, including `updateSyncStatus` and `updateSubscription`.
- `packages/prisma/schema.prisma` already has `Credential.invalid`, `SelectedCalendar.syncToken`, `SelectedCalendar.syncedAt`, `SelectedCalendar.syncErrorAt`, `SelectedCalendar.syncSubscribedAt`, `CalendarCache`, and `CalendarCacheEvent`.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the backfill respects provider and queue boundaries, and whether the selected-calendar state transitions make cache availability truthful.

## Review Surface

Changed files in the synthetic PR:

- `packages/prisma/migrations/20260516_historical_calendar_backfill/migration.sql`
- `packages/prisma/schema.prisma`
- `packages/features/calendar-subscription/lib/backfill/types.ts`
- `packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillRepository.ts`
- `packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillTasker.ts`
- `packages/features/calendar-subscription/lib/backfill/trigger/config.ts`
- `packages/features/calendar-subscription/lib/backfill/trigger/start-user-calendar-backfill.ts`
- `packages/features/calendar-subscription/lib/backfill/trigger/backfill-calendar-event.ts`
- `packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillService.ts`
- `apps/web/app/api/calendar-cache/backfill/route.ts`
- `packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillService.test.ts`
- `packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillTasker.test.ts`
- `docs/operations/historical-calendar-backfill.md`

The line references below use synthetic PR line numbers. The represented diff is focused on historical provider reads, Trigger.dev fan-out, selected-calendar sync state, calendar cache readiness, and tests that normalize unsafe operational behavior.

## Diff

```diff
diff --git a/packages/prisma/migrations/20260516_historical_calendar_backfill/migration.sql b/packages/prisma/migrations/20260516_historical_calendar_backfill/migration.sql
new file mode 100644
index 0000000000..3c4139b650
--- /dev/null
+++ b/packages/prisma/migrations/20260516_historical_calendar_backfill/migration.sql
@@ -0,0 +1,93 @@
+-- Historical calendar cache backfill.
+-- This records admin-triggered runs and gives support enough state to inspect
+-- calendar cache population for selected calendars.
+
+CREATE TYPE "CalendarBackfillRunStatus" AS ENUM (
+  'pending',
+  'listing_events',
+  'events_enqueued',
+  'processing_events',
+  'completed',
+  'failed'
+);
+
+CREATE TYPE "CalendarBackfillEventStatus" AS ENUM (
+  'queued',
+  'processed',
+  'skipped',
+  'failed'
+);
+
+CREATE TABLE "CalendarBackfillRun" (
+  "id" TEXT NOT NULL,
+  "userId" INTEGER NOT NULL,
+  "requestedById" INTEGER,
+  "credentialId" INTEGER,
+  "integration" TEXT NOT NULL,
+  "selectedCalendarId" TEXT,
+  "dateFrom" TIMESTAMP(3) NOT NULL,
+  "dateTo" TIMESTAMP(3) NOT NULL,
+  "status" "CalendarBackfillRunStatus" NOT NULL DEFAULT 'pending',
+  "eventsDiscovered" INTEGER NOT NULL DEFAULT 0,
+  "eventsQueued" INTEGER NOT NULL DEFAULT 0,
+  "eventsProcessed" INTEGER NOT NULL DEFAULT 0,
+  "eventsFailed" INTEGER NOT NULL DEFAULT 0,
+  "lastProviderPageToken" TEXT,
+  "lastProviderSyncToken" TEXT,
+  "error" TEXT,
+  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  "startedAt" TIMESTAMP(3),
+  "completedAt" TIMESTAMP(3),
+  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  CONSTRAINT "CalendarBackfillRun_pkey" PRIMARY KEY ("id")
+);
+
+CREATE TABLE "CalendarBackfillEvent" (
+  "id" TEXT NOT NULL,
+  "runId" TEXT NOT NULL,
+  "selectedCalendarId" TEXT NOT NULL,
+  "externalId" TEXT NOT NULL,
+  "externalEtag" TEXT,
+  "status" "CalendarBackfillEventStatus" NOT NULL DEFAULT 'queued',
+  "payload" JSONB NOT NULL,
+  "error" TEXT,
+  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  "processedAt" TIMESTAMP(3),
+  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  CONSTRAINT "CalendarBackfillEvent_pkey" PRIMARY KEY ("id")
+);
+
+ALTER TABLE "SelectedCalendar"
+ADD COLUMN "historicalBackfillStatus" TEXT NOT NULL DEFAULT 'idle',
+ADD COLUMN "historicalBackfillStartedAt" TIMESTAMP(3),
+ADD COLUMN "historicalBackfilledAt" TIMESTAMP(3),
+ADD COLUMN "historicalBackfillError" TEXT;
+
+ALTER TABLE "CalendarBackfillRun"
+ADD CONSTRAINT "CalendarBackfillRun_userId_fkey"
+FOREIGN KEY ("userId") REFERENCES "users"("id")
+ON DELETE CASCADE ON UPDATE CASCADE;
+
+ALTER TABLE "CalendarBackfillRun"
+ADD CONSTRAINT "CalendarBackfillRun_requestedById_fkey"
+FOREIGN KEY ("requestedById") REFERENCES "users"("id")
+ON DELETE SET NULL ON UPDATE CASCADE;
+
+ALTER TABLE "CalendarBackfillRun"
+ADD CONSTRAINT "CalendarBackfillRun_credentialId_fkey"
+FOREIGN KEY ("credentialId") REFERENCES "Credential"("id")
+ON DELETE SET NULL ON UPDATE CASCADE;
+
+ALTER TABLE "CalendarBackfillRun"
+ADD CONSTRAINT "CalendarBackfillRun_selectedCalendarId_fkey"
+FOREIGN KEY ("selectedCalendarId") REFERENCES "SelectedCalendar"("id")
+ON DELETE SET NULL ON UPDATE CASCADE;
+
+ALTER TABLE "CalendarBackfillEvent"
+ADD CONSTRAINT "CalendarBackfillEvent_runId_fkey"
+FOREIGN KEY ("runId") REFERENCES "CalendarBackfillRun"("id")
+ON DELETE CASCADE ON UPDATE CASCADE;
+
+ALTER TABLE "CalendarBackfillEvent"
+ADD CONSTRAINT "CalendarBackfillEvent_selectedCalendarId_fkey"
+FOREIGN KEY ("selectedCalendarId") REFERENCES "SelectedCalendar"("id")
+ON DELETE CASCADE ON UPDATE CASCADE;
+
+CREATE INDEX "CalendarBackfillRun_user_status_idx" ON "CalendarBackfillRun"("userId", "status");
+CREATE INDEX "CalendarBackfillRun_calendar_idx" ON "CalendarBackfillRun"("selectedCalendarId");
+CREATE INDEX "CalendarBackfillEvent_run_status_idx" ON "CalendarBackfillEvent"("runId", "status");
+CREATE UNIQUE INDEX "CalendarBackfillEvent_run_external_unique"
+ON "CalendarBackfillEvent"("runId", "selectedCalendarId", "externalId");
diff --git a/packages/prisma/schema.prisma b/packages/prisma/schema.prisma
index 23f86f5321..a769536a10 100644
--- a/packages/prisma/schema.prisma
+++ b/packages/prisma/schema.prisma
@@ -1004,6 +1004,11 @@ model SelectedCalendar {
   syncedAt                 DateTime?
   syncErrorAt              DateTime?
   syncErrorCount           Int?      @default(0)
+  historicalBackfillStatus    String    @default("idle")
+  historicalBackfillStartedAt DateTime?
+  historicalBackfilledAt      DateTime?
+  historicalBackfillError     String?
+  backfillEvents              CalendarBackfillEvent[]
 
   delegationCredential   DelegationCredential? @relation(fields: [delegationCredentialId], references: [id], onDelete: Cascade)
   delegationCredentialId String?
@@ -2803,6 +2808,83 @@ model CalendarCacheEvent {
   @@index([selectedCalendarId, iCalUID])
 }
 
+enum CalendarBackfillRunStatus {
+  pending
+  listing_events
+  events_enqueued
+  processing_events
+  completed
+  failed
+}
+
+enum CalendarBackfillEventStatus {
+  queued
+  processed
+  skipped
+  failed
+}
+
+model CalendarBackfillRun {
+  id                    String                    @id @default(uuid())
+  userId                Int
+  requestedById          Int?
+  credentialId           Int?
+  integration            String
+  selectedCalendarId     String?
+  dateFrom               DateTime
+  dateTo                 DateTime
+  status                 CalendarBackfillRunStatus @default(pending)
+  eventsDiscovered       Int                       @default(0)
+  eventsQueued           Int                       @default(0)
+  eventsProcessed        Int                       @default(0)
+  eventsFailed           Int                       @default(0)
+  lastProviderPageToken  String?
+  lastProviderSyncToken  String?
+  error                  String?
+  createdAt              DateTime                  @default(now())
+  startedAt              DateTime?
+  completedAt            DateTime?
+  updatedAt              DateTime                  @updatedAt
+
+  user             User              @relation(fields: [userId], references: [id], onDelete: Cascade)
+  requestedBy      User?             @relation(fields: [requestedById], references: [id], onDelete: SetNull)
+  credential       Credential?       @relation(fields: [credentialId], references: [id], onDelete: SetNull)
+  selectedCalendar SelectedCalendar? @relation(fields: [selectedCalendarId], references: [id], onDelete: SetNull)
+  events           CalendarBackfillEvent[]
+
+  @@index([userId, status])
+  @@index([selectedCalendarId])
+}
+
+model CalendarBackfillEvent {
+  id                 String                     @id @default(uuid())
+  runId              String
+  selectedCalendarId String
+  externalId         String
+  externalEtag       String?
+  status             CalendarBackfillEventStatus @default(queued)
+  payload            Json
+  error              String?
+  queuedAt           DateTime                   @default(now())
+  processedAt        DateTime?
+  updatedAt          DateTime                   @updatedAt
+
+  run              CalendarBackfillRun @relation(fields: [runId], references: [id], onDelete: Cascade)
+  selectedCalendar SelectedCalendar    @relation(fields: [selectedCalendarId], references: [id], onDelete: Cascade)
+
+  @@unique([runId, selectedCalendarId, externalId])
+  @@index([runId, status])
+}
+
 model IntegrationAttributeSync {
   id             String @id @default(uuid())
   organizationId Int
diff --git a/packages/features/calendar-subscription/lib/backfill/types.ts b/packages/features/calendar-subscription/lib/backfill/types.ts
new file mode 100644
index 0000000000..2d1f8e457c
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/types.ts
@@ -0,0 +1,132 @@
+import type { CalendarSubscriptionProvider } from "@calcom/features/calendar-subscription/adapters/AdaptersFactory";
+import type { CalendarSubscriptionEventItem } from "@calcom/features/calendar-subscription/lib/CalendarSubscriptionPort.interface";
+import type { SelectedCalendar } from "@calcom/prisma/client";
+
+export type HistoricalBackfillRange = {
+  dateFrom: Date;
+  dateTo: Date;
+};
+
+export type HistoricalBackfillStatus =
+  | "pending"
+  | "listing_events"
+  | "events_enqueued"
+  | "processing_events"
+  | "completed"
+  | "failed";
+
+export type HistoricalBackfillEventStatus = "queued" | "processed" | "skipped" | "failed";
+
+export type HistoricalBackfillRequest = {
+  userId: number;
+  requestedById?: number | null;
+  integration?: CalendarSubscriptionProvider;
+  credentialId?: number;
+  selectedCalendarId?: string;
+  monthsBack?: number;
+  dryRun?: boolean;
+  reason?: string;
+};
+
+export type HistoricalBackfillRun = {
+  id: string;
+  userId: number;
+  requestedById: number | null;
+  credentialId: number | null;
+  integration: string;
+  selectedCalendarId: string | null;
+  dateFrom: Date;
+  dateTo: Date;
+  status: HistoricalBackfillStatus;
+  eventsDiscovered: number;
+  eventsQueued: number;
+  eventsProcessed: number;
+  eventsFailed: number;
+  lastProviderPageToken: string | null;
+  lastProviderSyncToken: string | null;
+  error: string | null;
+  createdAt: Date;
+  startedAt: Date | null;
+  completedAt: Date | null;
+  updatedAt: Date;
+};
+
+export type HistoricalBackfillEventRecord = {
+  id: string;
+  runId: string;
+  selectedCalendarId: string;
+  externalId: string;
+  externalEtag: string | null;
+  status: HistoricalBackfillEventStatus;
+  payload: CalendarSubscriptionEventItem;
+  error: string | null;
+  queuedAt: Date;
+  processedAt: Date | null;
+  updatedAt: Date;
+};
+
+export type SelectedCalendarForBackfill = Pick<
+  SelectedCalendar,
+  | "id"
+  | "userId"
+  | "integration"
+  | "externalId"
+  | "credentialId"
+  | "delegationCredentialId"
+  | "syncToken"
+  | "syncSubscribedAt"
+  | "syncedAt"
+  | "syncErrorAt"
+  | "syncErrorCount"
+  | "historicalBackfillStatus"
+  | "historicalBackfillStartedAt"
+  | "historicalBackfilledAt"
+  | "historicalBackfillError"
+>;
+
+export type ProviderHistoricalPage = {
+  provider: CalendarSubscriptionProvider;
+  selectedCalendarId: string;
+  events: CalendarSubscriptionEventItem[];
+  nextPageToken: string | null;
+  nextSyncToken: string | null;
+  exhausted: boolean;
+};
+
+export type ProviderHistoricalFetchInput = {
+  selectedCalendar: SelectedCalendarForBackfill;
+  dateFrom: Date;
+  dateTo: Date;
+  pageToken?: string | null;
+};
+
+export type ProviderHistoricalAdapter = {
+  provider: CalendarSubscriptionProvider;
+  listHistoricalEvents(input: ProviderHistoricalFetchInput): Promise<ProviderHistoricalPage>;
+};
+
+export type EnqueueBackfillEventInput = {
+  runId: string;
+  selectedCalendarId: string;
+  provider: CalendarSubscriptionProvider;
+  event: CalendarSubscriptionEventItem;
+  syncToken: string | null;
+  requestedById: number | null;
+};
+
+export type StartBackfillTaskPayload = {
+  userId: number;
+  requestedById?: number | null;
+  integration?: CalendarSubscriptionProvider;
+  credentialId?: number;
+  selectedCalendarId?: string;
+  monthsBack?: number;
+  dryRun?: boolean;
+  reason?: string;
+};
+
+export type BackfillCalendarEventTaskPayload = EnqueueBackfillEventInput & {
+  eventId: string;
+  queuedAt: string;
+};
+
+export type HistoricalBackfillSummary = {
+  runIds: string[];
+  calendarsConsidered: number;
+  calendarsStarted: number;
+  eventsDiscovered: number;
+  eventsQueued: number;
+  dryRun: boolean;
+};
diff --git a/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillRepository.ts b/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillRepository.ts
new file mode 100644
index 0000000000..53fb455ad3
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillRepository.ts
@@ -0,0 +1,169 @@
+import type { PrismaClient } from "@calcom/prisma";
+import type { Prisma } from "@calcom/prisma/client";
+
+import type {
+  HistoricalBackfillEventRecord,
+  HistoricalBackfillEventStatus,
+  HistoricalBackfillRequest,
+  HistoricalBackfillRun,
+  HistoricalBackfillStatus,
+} from "./types";
+
+export class HistoricalCalendarBackfillRepository {
+  constructor(private prisma: PrismaClient) {}
+
+  async findEligibleSelectedCalendars(request: HistoricalBackfillRequest) {
+    return this.prisma.selectedCalendar.findMany({
+      where: {
+        userId: request.userId,
+        eventTypeId: null,
+        id: request.selectedCalendarId,
+        integration: request.integration,
+        credentialId: request.credentialId,
+        credential: {
+          invalid: {
+            not: true,
+          },
+        },
+      },
+      orderBy: [
+        {
+          integration: "asc",
+        },
+        {
+          externalId: "asc",
+        },
+      ],
+    });
+  }
+
+  async createRun(input: {
+    request: HistoricalBackfillRequest;
+    integration: string;
+    selectedCalendarId: string;
+    credentialId: number | null;
+    dateFrom: Date;
+    dateTo: Date;
+  }): Promise<HistoricalBackfillRun> {
+    return this.prisma.calendarBackfillRun.create({
+      data: {
+        userId: input.request.userId,
+        requestedById: input.request.requestedById ?? null,
+        integration: input.integration,
+        selectedCalendarId: input.selectedCalendarId,
+        credentialId: input.credentialId,
+        dateFrom: input.dateFrom,
+        dateTo: input.dateTo,
+        status: "pending",
+      },
+    }) as Promise<HistoricalBackfillRun>;
+  }
+
+  async updateRunStatus(
+    runId: string,
+    status: HistoricalBackfillStatus,
+    extra: Partial<
+      Pick<
+        HistoricalBackfillRun,
+        | "eventsDiscovered"
+        | "eventsQueued"
+        | "eventsProcessed"
+        | "eventsFailed"
+        | "lastProviderPageToken"
+        | "lastProviderSyncToken"
+        | "error"
+        | "startedAt"
+        | "completedAt"
+      >
+    > = {}
+  ): Promise<HistoricalBackfillRun> {
+    const data: Prisma.CalendarBackfillRunUpdateInput = {
+      status,
+      eventsDiscovered: extra.eventsDiscovered,
+      eventsQueued: extra.eventsQueued,
+      eventsProcessed: extra.eventsProcessed,
+      eventsFailed: extra.eventsFailed,
+      lastProviderPageToken: extra.lastProviderPageToken,
+      lastProviderSyncToken: extra.lastProviderSyncToken,
+      error: extra.error,
+      startedAt: extra.startedAt,
+      completedAt: extra.completedAt,
+    };
+
+    return this.prisma.calendarBackfillRun.update({
+      where: {
+        id: runId,
+      },
+      data,
+    }) as Promise<HistoricalBackfillRun>;
+  }
+
+  async incrementRunCounters(
+    runId: string,
+    counters: {
+      discovered?: number;
+      queued?: number;
+      processed?: number;
+      failed?: number;
+    }
+  ) {
+    return this.prisma.calendarBackfillRun.update({
+      where: {
+        id: runId,
+      },
+      data: {
+        eventsDiscovered: counters.discovered ? { increment: counters.discovered } : undefined,
+        eventsQueued: counters.queued ? { increment: counters.queued } : undefined,
+        eventsProcessed: counters.processed ? { increment: counters.processed } : undefined,
+        eventsFailed: counters.failed ? { increment: counters.failed } : undefined,
+      },
+    });
+  }
+
+  async createBackfillEvent(input: {
+    runId: string;
+    selectedCalendarId: string;
+    externalId: string;
+    externalEtag: string | null;
+    payload: Prisma.InputJsonValue;
+  }): Promise<HistoricalBackfillEventRecord> {
+    return this.prisma.calendarBackfillEvent.upsert({
+      where: {
+        runId_selectedCalendarId_externalId: {
+          runId: input.runId,
+          selectedCalendarId: input.selectedCalendarId,
+          externalId: input.externalId,
+        },
+      },
+      update: {
+        externalEtag: input.externalEtag,
+        payload: input.payload,
+        status: "queued",
+        error: null,
+        queuedAt: new Date(),
+      },
+      create: {
+        runId: input.runId,
+        selectedCalendarId: input.selectedCalendarId,
+        externalId: input.externalId,
+        externalEtag: input.externalEtag,
+        payload: input.payload,
+      },
+    }) as Promise<HistoricalBackfillEventRecord>;
+  }
+
+  async updateBackfillEvent(
+    id: string,
+    status: HistoricalBackfillEventStatus,
+    error?: string | null
+  ): Promise<HistoricalBackfillEventRecord> {
+    return this.prisma.calendarBackfillEvent.update({
+      where: {
+        id,
+      },
+      data: {
+        status,
+        error: error ?? null,
+        processedAt: status === "processed" || status === "skipped" ? new Date() : undefined,
+      },
+    }) as Promise<HistoricalBackfillEventRecord>;
+  }
+
+  async findRun(runId: string) {
+    return this.prisma.calendarBackfillRun.findUnique({
+      where: {
+        id: runId,
+      },
+      include: {
+        selectedCalendar: true,
+      },
+    });
+  }
+}
diff --git a/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillTasker.ts b/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillTasker.ts
new file mode 100644
index 0000000000..67fc02125c
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillTasker.ts
@@ -0,0 +1,122 @@
+import type { TriggerOptions } from "@trigger.dev/sdk";
+
+import logger from "@calcom/lib/logger";
+
+import type {
+  BackfillCalendarEventTaskPayload,
+  EnqueueBackfillEventInput,
+  StartBackfillTaskPayload,
+} from "./types";
+
+const log = logger.getSubLogger({ prefix: ["HistoricalCalendarBackfillTasker"] });
+
+export class HistoricalCalendarBackfillTasker {
+  async startUserBackfill(payload: StartBackfillTaskPayload, options?: TriggerOptions) {
+    const { startUserCalendarBackfill } = await import("./trigger/start-user-calendar-backfill");
+    const handle = await startUserCalendarBackfill.trigger(payload, {
+      ...options,
+      idempotencyKey: options?.idempotencyKey ?? this.startKey(payload),
+    });
+
+    log.info("historical calendar backfill scheduled", {
+      userId: payload.userId,
+      selectedCalendarId: payload.selectedCalendarId,
+      integration: payload.integration,
+      runId: handle.id,
+    });
+
+    return handle.id;
+  }
+
+  async enqueueEvent(input: EnqueueBackfillEventInput, options?: TriggerOptions) {
+    const { backfillCalendarEvent } = await import("./trigger/backfill-calendar-event");
+    const payload: BackfillCalendarEventTaskPayload = {
+      ...input,
+      eventId: input.event.id,
+      queuedAt: new Date().toISOString(),
+    };
+
+    const handle = await backfillCalendarEvent.trigger(payload, {
+      ...options,
+      idempotencyKey:
+        options?.idempotencyKey ??
+        `calendar-backfill-event:${input.runId}:${input.selectedCalendarId}:${input.event.id}`,
+    });
+
+    log.debug("historical calendar event queued", {
+      runId: input.runId,
+      selectedCalendarId: input.selectedCalendarId,
+      eventId: input.event.id,
+      triggerRunId: handle.id,
+    });
+
+    return handle.id;
+  }
+
+  async enqueueEvents(inputs: EnqueueBackfillEventInput[]) {
+    const handles = await Promise.all(
+      inputs.map((input) =>
+        this.enqueueEvent(input, {
+          tags: [
+            `user:${input.event.organizerId ?? "unknown"}`,
+            `calendar:${input.selectedCalendarId}`,
+            `provider:${input.provider}`,
+          ],
+        })
+      )
+    );
+
+    log.info("historical calendar event batch queued", {
+      count: handles.length,
+      runIds: [...new Set(inputs.map((input) => input.runId))],
+    });
+
+    return handles;
+  }
+
+  private startKey(payload: StartBackfillTaskPayload) {
+    const calendarPart = payload.selectedCalendarId ?? "all";
+    const providerPart = payload.integration ?? "all";
+    const credentialPart = payload.credentialId ?? "all";
+    return `calendar-backfill-start:${payload.userId}:${providerPart}:${credentialPart}:${calendarPart}`;
+  }
+}
diff --git a/packages/features/calendar-subscription/lib/backfill/trigger/config.ts b/packages/features/calendar-subscription/lib/backfill/trigger/config.ts
new file mode 100644
index 0000000000..78b1c5b33e
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/trigger/config.ts
@@ -0,0 +1,67 @@
+import { queue, type schemaTask } from "@trigger.dev/sdk";
+
+export const historicalCalendarBackfillQueue = queue({
+  name: "historical-calendar-backfill",
+  concurrencyLimit: 25,
+});
+
+export const historicalCalendarEventQueue = queue({
+  name: "historical-calendar-backfill-events",
+  concurrencyLimit: 100,
+});
+
+export const historicalCalendarBackfillConfig = {
+  queue: historicalCalendarBackfillQueue,
+  machine: "small-1x",
+  retry: {
+    maxAttempts: 3,
+    minTimeoutInMs: 60_000,
+    maxTimeoutInMs: 300_000,
+    factor: 2,
+    randomize: true,
+  },
+} satisfies Partial<Parameters<typeof schemaTask>[0]>;
+
+export const historicalCalendarEventConfig = {
+  queue: historicalCalendarEventQueue,
+  machine: "small-1x",
+  retry: {
+    maxAttempts: 2,
+    minTimeoutInMs: 10_000,
+    maxTimeoutInMs: 60_000,
+    factor: 2,
+    randomize: true,
+  },
+} satisfies Partial<Parameters<typeof schemaTask>[0]>;
+
+export const backfillLimits = {
+  defaultMonthsBack: 12,
+  maxMonthsBack: 24,
+  providerPageSize: 250,
+  maxCalendarsPerUserRun: 100,
+};
diff --git a/packages/features/calendar-subscription/lib/backfill/trigger/start-user-calendar-backfill.ts b/packages/features/calendar-subscription/lib/backfill/trigger/start-user-calendar-backfill.ts
new file mode 100644
index 0000000000..f8ac29966e
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/trigger/start-user-calendar-backfill.ts
@@ -0,0 +1,83 @@
+import { schemaTask } from "@trigger.dev/sdk";
+import { z } from "zod";
+
+import { AdaptersFactory } from "@calcom/features/calendar-subscription/adapters/AdaptersFactory";
+import { CalendarCacheEventRepository } from "@calcom/features/calendar-subscription/lib/cache/CalendarCacheEventRepository";
+import { CalendarCacheEventService } from "@calcom/features/calendar-subscription/lib/cache/CalendarCacheEventService";
+import { prisma } from "@calcom/prisma";
+
+import { HistoricalCalendarBackfillRepository } from "../HistoricalCalendarBackfillRepository";
+import { HistoricalCalendarBackfillService } from "../HistoricalCalendarBackfillService";
+import { HistoricalCalendarBackfillTasker } from "../HistoricalCalendarBackfillTasker";
+import { historicalCalendarBackfillConfig } from "./config";
+
+export const startBackfillSchema = z.object({
+  userId: z.number(),
+  requestedById: z.number().nullish(),
+  integration: z.enum(["google_calendar", "office365_calendar"]).optional(),
+  credentialId: z.number().optional(),
+  selectedCalendarId: z.string().optional(),
+  monthsBack: z.number().int().positive().max(24).optional(),
+  dryRun: z.boolean().optional(),
+  reason: z.string().optional(),
+});
+
+export const startUserCalendarBackfill = schemaTask({
+  id: "calendar-subscription.historical-backfill.start-user",
+  schema: startBackfillSchema,
+  ...historicalCalendarBackfillConfig,
+  run: async (payload) => {
+    const repository = new HistoricalCalendarBackfillRepository(prisma);
+    const cacheEventService = new CalendarCacheEventService({
+      calendarCacheEventRepository: new CalendarCacheEventRepository(prisma),
+    });
+    const service = new HistoricalCalendarBackfillService({
+      prisma,
+      adapterFactory: new AdaptersFactory(),
+      repository,
+      cacheEventService,
+      tasker: new HistoricalCalendarBackfillTasker(),
+    });
+
+    return service.startForUser(payload);
+  },
+});
diff --git a/packages/features/calendar-subscription/lib/backfill/trigger/backfill-calendar-event.ts b/packages/features/calendar-subscription/lib/backfill/trigger/backfill-calendar-event.ts
new file mode 100644
index 0000000000..e32b88a1a0
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/trigger/backfill-calendar-event.ts
@@ -0,0 +1,151 @@
+import { schemaTask } from "@trigger.dev/sdk";
+import { z } from "zod";
+
+import { CalendarCacheEventRepository } from "@calcom/features/calendar-subscription/lib/cache/CalendarCacheEventRepository";
+import { CalendarCacheEventService } from "@calcom/features/calendar-subscription/lib/cache/CalendarCacheEventService";
+import { prisma } from "@calcom/prisma";
+
+import { HistoricalCalendarBackfillRepository } from "../HistoricalCalendarBackfillRepository";
+import { historicalCalendarEventConfig } from "./config";
+
+const historicalEventSchema = z.object({
+  runId: z.string(),
+  selectedCalendarId: z.string(),
+  provider: z.enum(["google_calendar", "office365_calendar"]),
+  syncToken: z.string().nullable(),
+  requestedById: z.number().nullable(),
+  eventId: z.string(),
+  queuedAt: z.string(),
+  event: z.object({
+    id: z.string(),
+    iCalUID: z.string().nullable(),
+    start: z.coerce.date(),
+    end: z.coerce.date(),
+    busy: z.boolean(),
+    etag: z.string().nullable(),
+    summary: z.string().nullable(),
+    description: z.string().nullable(),
+    location: z.string().nullable(),
+    kind: z.string(),
+    status: z.string(),
+    isAllDay: z.boolean(),
+    timeZone: z.string().nullable(),
+    recurringEventId: z.string().nullable(),
+    originalStartDate: z.coerce.date().nullable(),
+    createdAt: z.coerce.date().nullable(),
+    updatedAt: z.coerce.date().nullable(),
+    organizerId: z.number().optional(),
+  }),
+});
+
+export const backfillCalendarEvent = schemaTask({
+  id: "calendar-subscription.historical-backfill.event",
+  schema: historicalEventSchema,
+  ...historicalCalendarEventConfig,
+  run: async (payload) => {
+    const repository = new HistoricalCalendarBackfillRepository(prisma);
+    const cacheEventService = new CalendarCacheEventService({
+      calendarCacheEventRepository: new CalendarCacheEventRepository(prisma),
+    });
+
+    const run = await repository.findRun(payload.runId);
+    if (!run || !run.selectedCalendar) {
+      return {
+        skipped: true,
+        reason: "run-or-calendar-missing",
+      };
+    }
+
+    try {
+      await cacheEventService.handleEvents(run.selectedCalendar, [payload.event]);
+
+      await prisma.selectedCalendar.update({
+        where: {
+          id: payload.selectedCalendarId,
+        },
+        data: {
+          syncToken: payload.syncToken,
+          syncedAt: new Date(),
+          syncErrorAt: null,
+          syncErrorCount: 0,
+          syncSubscribedAt: run.selectedCalendar.syncSubscribedAt ?? new Date(),
+          historicalBackfillStatus: "completed",
+          historicalBackfilledAt: new Date(),
+          historicalBackfillError: null,
+        },
+      });
+
+      await repository.updateBackfillEvent(payload.eventId, "processed");
+      await repository.incrementRunCounters(payload.runId, {
+        processed: 1,
+      });
+
+      return {
+        processed: true,
+        eventId: payload.event.id,
+      };
+    } catch (error) {
+      const message = error instanceof Error ? error.message : "unknown calendar backfill event error";
+
+      await prisma.selectedCalendar.update({
+        where: {
+          id: payload.selectedCalendarId,
+        },
+        data: {
+          syncErrorAt: new Date(),
+          syncErrorCount: {
+            increment: 1,
+          },
+          historicalBackfillStatus: "failed",
+          historicalBackfillError: message,
+        },
+      });
+
+      await repository.updateBackfillEvent(payload.eventId, "failed", message);
+      await repository.incrementRunCounters(payload.runId, {
+        failed: 1,
+      });
+
+      throw error;
+    }
+  },
+});
diff --git a/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillService.ts b/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillService.ts
new file mode 100644
index 0000000000..b4ad9721c7
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillService.ts
@@ -0,0 +1,381 @@
+import dayjs from "@calcom/dayjs";
+import type { AdapterFactory } from "@calcom/features/calendar-subscription/adapters/AdaptersFactory";
+import type { CalendarSubscriptionProvider } from "@calcom/features/calendar-subscription/adapters/AdaptersFactory";
+import type { CalendarSubscriptionEventItem } from "@calcom/features/calendar-subscription/lib/CalendarSubscriptionPort.interface";
+import type { CalendarCacheEventService } from "@calcom/features/calendar-subscription/lib/cache/CalendarCacheEventService";
+import logger from "@calcom/lib/logger";
+import type { PrismaClient } from "@calcom/prisma";
+import type { SelectedCalendar } from "@calcom/prisma/client";
+
+import type { HistoricalCalendarBackfillRepository } from "./HistoricalCalendarBackfillRepository";
+import type { HistoricalCalendarBackfillTasker } from "./HistoricalCalendarBackfillTasker";
+import type {
+  EnqueueBackfillEventInput,
+  HistoricalBackfillRequest,
+  HistoricalBackfillSummary,
+  ProviderHistoricalAdapter,
+  ProviderHistoricalFetchInput,
+  ProviderHistoricalPage,
+  SelectedCalendarForBackfill,
+} from "./types";
+import { backfillLimits } from "./trigger/config";
+
+const log = logger.getSubLogger({ prefix: ["HistoricalCalendarBackfillService"] });
+
+type Deps = {
+  prisma: PrismaClient;
+  adapterFactory: AdapterFactory;
+  repository: HistoricalCalendarBackfillRepository;
+  cacheEventService: CalendarCacheEventService;
+  tasker: HistoricalCalendarBackfillTasker;
+};
+
+type CalendarWithCredential = SelectedCalendar & {
+  credential?: {
+    id: number;
+    type: string;
+    key: unknown;
+    userId: number | null;
+    invalid: boolean | null;
+  } | null;
+};
+
+export class HistoricalCalendarBackfillService {
+  constructor(private deps: Deps) {}
+
+  async startForUser(request: HistoricalBackfillRequest): Promise<HistoricalBackfillSummary> {
+    const range = this.buildRange(request.monthsBack);
+    const selectedCalendars = await this.deps.repository.findEligibleSelectedCalendars(request);
+    const calendars = selectedCalendars.slice(0, backfillLimits.maxCalendarsPerUserRun);
+    const summary: HistoricalBackfillSummary = {
+      runIds: [],
+      calendarsConsidered: selectedCalendars.length,
+      calendarsStarted: 0,
+      eventsDiscovered: 0,
+      eventsQueued: 0,
+      dryRun: !!request.dryRun,
+    };
+
+    for (const selectedCalendar of calendars) {
+      const calendar = selectedCalendar as CalendarWithCredential;
+      if (!calendar.credentialId && !calendar.delegationCredentialId) {
+        log.info("historical backfill skipped calendar without credential", {
+          selectedCalendarId: selectedCalendar.id,
+        });
+        continue;
+      }
+
+      const provider = selectedCalendar.integration as CalendarSubscriptionProvider;
+      const run = await this.deps.repository.createRun({
+        request,
+        integration: provider,
+        selectedCalendarId: selectedCalendar.id,
+        credentialId: selectedCalendar.credentialId ?? null,
+        dateFrom: range.dateFrom,
+        dateTo: range.dateTo,
+      });
+
+      summary.runIds.push(run.id);
+      summary.calendarsStarted += 1;
+
+      await this.deps.repository.updateRunStatus(run.id, "listing_events", {
+        startedAt: new Date(),
+      });
+
+      await this.markCalendarBackfillStarted(selectedCalendar.id);
+
+      try {
+        const result = await this.listAndQueueCalendarEvents({
+          runId: run.id,
+          requestedById: request.requestedById ?? null,
+          provider,
+          selectedCalendar: selectedCalendar as SelectedCalendarForBackfill,
+          dateFrom: range.dateFrom,
+          dateTo: range.dateTo,
+          dryRun: !!request.dryRun,
+        });
+
+        summary.eventsDiscovered += result.discovered;
+        summary.eventsQueued += result.queued;
+
+        await this.deps.repository.updateRunStatus(run.id, "completed", {
+          eventsDiscovered: result.discovered,
+          eventsQueued: result.queued,
+          lastProviderPageToken: result.lastPageToken,
+          lastProviderSyncToken: result.lastSyncToken,
+          completedAt: new Date(),
+        });
+
+        await this.markCalendarBackfillReady({
+          selectedCalendarId: selectedCalendar.id,
+          syncToken: result.lastSyncToken ?? selectedCalendar.syncToken,
+        });
+      } catch (error) {
+        const message = error instanceof Error ? error.message : "unknown historical backfill error";
+        await this.deps.repository.updateRunStatus(run.id, "failed", {
+          error: message,
+          completedAt: new Date(),
+        });
+        await this.markCalendarBackfillFailed(selectedCalendar.id, message);
+      }
+    }
+
+    return summary;
+  }
+
+  private async listAndQueueCalendarEvents(input: {
+    runId: string;
+    requestedById: number | null;
+    provider: CalendarSubscriptionProvider;
+    selectedCalendar: SelectedCalendarForBackfill;
+    dateFrom: Date;
+    dateTo: Date;
+    dryRun: boolean;
+  }): Promise<{
+    discovered: number;
+    queued: number;
+    lastPageToken: string | null;
+    lastSyncToken: string | null;
+  }> {
+    const adapter = this.createHistoricalAdapter(input.provider);
+    let pageToken: string | null = null;
+    let lastSyncToken: string | null = input.selectedCalendar.syncToken ?? null;
+    let discovered = 0;
+    let queued = 0;
+
+    do {
+      const page = await adapter.listHistoricalEvents({
+        selectedCalendar: input.selectedCalendar,
+        dateFrom: input.dateFrom,
+        dateTo: input.dateTo,
+        pageToken,
+      });
+
+      discovered += page.events.length;
+      lastSyncToken = page.nextSyncToken ?? lastSyncToken;
+      pageToken = page.nextPageToken;
+
+      const validEvents = page.events.filter((event) => typeof event.id === "string" && event.id.length > 0);
+      const eventInputs = validEvents.map<EnqueueBackfillEventInput>((event) => ({
+        runId: input.runId,
+        selectedCalendarId: input.selectedCalendar.id,
+        provider: input.provider,
+        event,
+        syncToken: lastSyncToken,
+        requestedById: input.requestedById,
+      }));
+
+      if (!input.dryRun) {
+        await Promise.all(
+          eventInputs.map(async (eventInput) => {
+            const record = await this.deps.repository.createBackfillEvent({
+              runId: eventInput.runId,
+              selectedCalendarId: eventInput.selectedCalendarId,
+              externalId: eventInput.event.id,
+              externalEtag: eventInput.event.etag ?? null,
+              payload: eventInput.event,
+            });
+
+            await this.deps.tasker.enqueueEvent({
+              ...eventInput,
+              event: {
+                ...eventInput.event,
+                id: record.id,
+              },
+            });
+          })
+        );
+      }
+
+      queued += eventInputs.length;
+
+      await this.deps.repository.updateRunStatus(input.runId, "events_enqueued", {
+        eventsDiscovered: discovered,
+        eventsQueued: queued,
+        lastProviderPageToken: pageToken,
+        lastProviderSyncToken: lastSyncToken,
+      });
+    } while (pageToken);
+
+    return {
+      discovered,
+      queued,
+      lastPageToken: pageToken,
+      lastSyncToken,
+    };
+  }
+
+  private createHistoricalAdapter(provider: CalendarSubscriptionProvider): ProviderHistoricalAdapter {
+    const subscriptionAdapter = this.deps.adapterFactory.get(provider);
+
+    return {
+      provider,
+      listHistoricalEvents: async (input: ProviderHistoricalFetchInput): Promise<ProviderHistoricalPage> => {
+        const selectedCalendar = {
+          ...input.selectedCalendar,
+          syncToken: input.pageToken ?? null,
+        } as SelectedCalendar;
+
+        const page = await subscriptionAdapter.fetchEvents(selectedCalendar, {
+          id: input.selectedCalendar.credentialId ?? -1,
+          type: provider,
+          key: {},
+          userId: input.selectedCalendar.userId,
+        });
+
+        const events = page.items.filter((event) => {
+          const start = dayjs(event.start);
+          return start.isAfter(dayjs(input.dateFrom)) && start.isBefore(dayjs(input.dateTo));
+        });
+
+        return {
+          provider,
+          selectedCalendarId: input.selectedCalendar.id,
+          events,
+          nextPageToken: page.syncToken === input.pageToken ? null : page.syncToken,
+          nextSyncToken: page.syncToken,
+          exhausted: !page.syncToken,
+        };
+      },
+    };
+  }
+
+  private buildRange(monthsBack = backfillLimits.defaultMonthsBack) {
+    const boundedMonths = Math.min(monthsBack, backfillLimits.maxMonthsBack);
+    const now = dayjs().endOf("day");
+    return {
+      dateFrom: now.subtract(boundedMonths, "month").startOf("day").toDate(),
+      dateTo: now.toDate(),
+    };
+  }
+
+  private async markCalendarBackfillStarted(selectedCalendarId: string) {
+    await this.deps.prisma.selectedCalendar.update({
+      where: {
+        id: selectedCalendarId,
+      },
+      data: {
+        historicalBackfillStatus: "listing_events",
+        historicalBackfillStartedAt: new Date(),
+        historicalBackfillError: null,
+      },
+    });
+  }
+
+  private async markCalendarBackfillReady(input: { selectedCalendarId: string; syncToken: string | null }) {
+    await this.deps.prisma.selectedCalendar.update({
+      where: {
+        id: input.selectedCalendarId,
+      },
+      data: {
+        syncToken: input.syncToken,
+        syncedAt: new Date(),
+        syncErrorAt: null,
+        syncErrorCount: 0,
+        syncSubscribedAt: new Date(),
+        historicalBackfillStatus: "completed",
+        historicalBackfilledAt: new Date(),
+        historicalBackfillError: null,
+      },
+    });
+  }
+
+  private async markCalendarBackfillFailed(selectedCalendarId: string, message: string) {
+    await this.deps.prisma.selectedCalendar.update({
+      where: {
+        id: selectedCalendarId,
+      },
+      data: {
+        syncErrorAt: new Date(),
+        syncErrorCount: {
+          increment: 1,
+        },
+        historicalBackfillStatus: "failed",
+        historicalBackfillError: message,
+      },
+    });
+  }
+
+  async processEventDirectlyForSupport(input: {
+    selectedCalendar: SelectedCalendar;
+    event: CalendarSubscriptionEventItem;
+  }) {
+    await this.deps.cacheEventService.handleEvents(input.selectedCalendar, [input.event]);
+  }
+}
diff --git a/apps/web/app/api/calendar-cache/backfill/route.ts b/apps/web/app/api/calendar-cache/backfill/route.ts
new file mode 100644
index 0000000000..68ef79a15c
--- /dev/null
+++ b/apps/web/app/api/calendar-cache/backfill/route.ts
@@ -0,0 +1,119 @@
+import { NextResponse } from "next/server";
+import { z } from "zod";
+
+import { HistoricalCalendarBackfillTasker } from "@calcom/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillTasker";
+import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
+import { prisma } from "@calcom/prisma";
+
+const bodySchema = z.object({
+  userId: z.number(),
+  integration: z.enum(["google_calendar", "office365_calendar"]).optional(),
+  credentialId: z.number().optional(),
+  selectedCalendarId: z.string().optional(),
+  monthsBack: z.number().int().positive().max(24).optional(),
+  dryRun: z.boolean().optional(),
+  reason: z.string().min(3).optional(),
+});
+
+export async function POST(request: Request) {
+  const session = await getServerSession();
+  if (!session?.user?.id) {
+    return NextResponse.json(
+      {
+        error: "Unauthorized",
+      },
+      {
+        status: 401,
+      }
+    );
+  }
+
+  const admin = await prisma.membership.findFirst({
+    where: {
+      userId: session.user.id,
+      role: "ADMIN",
+      accepted: true,
+    },
+    select: {
+      id: true,
+      teamId: true,
+    },
+  });
+
+  if (!admin) {
+    return NextResponse.json(
+      {
+        error: "Only admins can start calendar cache backfills",
+      },
+      {
+        status: 403,
+      }
+    );
+  }
+
+  const parsed = bodySchema.safeParse(await request.json());
+  if (!parsed.success) {
+    return NextResponse.json(
+      {
+        error: "Invalid request",
+        issues: parsed.error.issues,
+      },
+      {
+        status: 400,
+      }
+    );
+  }
+
+  const target = await prisma.user.findUnique({
+    where: {
+      id: parsed.data.userId,
+    },
+    select: {
+      id: true,
+      teams: {
+        where: {
+          teamId: admin.teamId,
+          accepted: true,
+        },
+        select: {
+          id: true,
+        },
+      },
+    },
+  });
+
+  if (!target || target.teams.length === 0) {
+    return NextResponse.json(
+      {
+        error: "Target user is not in the admin team",
+      },
+      {
+        status: 404,
+      }
+    );
+  }
+
+  const tasker = new HistoricalCalendarBackfillTasker();
+  const runId = await tasker.startUserBackfill({
+    ...parsed.data,
+    requestedById: session.user.id,
+  });
+
+  return NextResponse.json({
+    runId,
+    status: "scheduled",
+  });
+}
diff --git a/packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillService.test.ts b/packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillService.test.ts
new file mode 100644
index 0000000000..ca1f911abd
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillService.test.ts
@@ -0,0 +1,300 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+
+import { HistoricalCalendarBackfillService } from "../HistoricalCalendarBackfillService";
+
+const makeEvent = (id: string, start = "2026-04-10T10:00:00.000Z") => ({
+  id,
+  iCalUID: `${id}@google.com`,
+  start: new Date(start),
+  end: new Date("2026-04-10T11:00:00.000Z"),
+  busy: true,
+  etag: `etag-${id}`,
+  summary: `Busy ${id}`,
+  description: null,
+  location: null,
+  kind: "calendar#event",
+  status: "confirmed",
+  isAllDay: false,
+  timeZone: "UTC",
+  recurringEventId: null,
+  originalStartDate: null,
+  createdAt: new Date("2026-03-01T00:00:00.000Z"),
+  updatedAt: new Date("2026-03-02T00:00:00.000Z"),
+});
+
+const selectedCalendar = {
+  id: "selected-calendar-1",
+  userId: 101,
+  integration: "google_calendar",
+  externalId: "primary",
+  credentialId: 9,
+  delegationCredentialId: null,
+  syncToken: null,
+  syncSubscribedAt: null,
+  syncedAt: null,
+  syncErrorAt: null,
+  syncErrorCount: 0,
+  historicalBackfillStatus: "idle",
+  historicalBackfillStartedAt: null,
+  historicalBackfilledAt: null,
+  historicalBackfillError: null,
+};
+
+describe("HistoricalCalendarBackfillService", () => {
+  let repository: any;
+  let tasker: any;
+  let prisma: any;
+  let adapter: any;
+  let service: HistoricalCalendarBackfillService;
+
+  beforeEach(() => {
+    repository = {
+      findEligibleSelectedCalendars: vi.fn().mockResolvedValue([selectedCalendar]),
+      createRun: vi.fn().mockResolvedValue({
+        id: "run_1",
+        userId: 101,
+      }),
+      updateRunStatus: vi.fn().mockResolvedValue({}),
+      createBackfillEvent: vi.fn(async ({ externalId }: { externalId: string }) => ({
+        id: `event-row-${externalId}`,
+        externalId,
+      })),
+      incrementRunCounters: vi.fn().mockResolvedValue({}),
+      updateBackfillEvent: vi.fn().mockResolvedValue({}),
+    };
+    tasker = {
+      enqueueEvent: vi.fn().mockResolvedValue("trigger-run"),
+    };
+    prisma = {
+      selectedCalendar: {
+        update: vi.fn().mockResolvedValue({}),
+      },
+    };
+    adapter = {
+      fetchEvents: vi.fn().mockResolvedValue({
+        provider: "google_calendar",
+        syncToken: "sync-token-1",
+        items: [makeEvent("a"), makeEvent("b"), makeEvent("c")],
+      }),
+    };
+    service = new HistoricalCalendarBackfillService({
+      prisma,
+      adapterFactory: {
+        get: vi.fn().mockReturnValue(adapter),
+      } as any,
+      repository,
+      cacheEventService: {
+        handleEvents: vi.fn().mockResolvedValue(undefined),
+      } as any,
+      tasker,
+    });
+  });
+
+  it("creates a run and queues every provider event", async () => {
+    const result = await service.startForUser({
+      userId: 101,
+      requestedById: 1,
+      integration: "google_calendar",
+      monthsBack: 12,
+    });
+
+    expect(result.runIds).toEqual(["run_1"]);
+    expect(result.calendarsConsidered).toBe(1);
+    expect(result.eventsDiscovered).toBe(3);
+    expect(result.eventsQueued).toBe(3);
+    expect(tasker.enqueueEvent).toHaveBeenCalledTimes(3);
+    expect(tasker.enqueueEvent).toHaveBeenNthCalledWith(
+      1,
+      expect.objectContaining({
+        runId: "run_1",
+        selectedCalendarId: "selected-calendar-1",
+        provider: "google_calendar",
+        syncToken: "sync-token-1",
+      })
+    );
+  });
+
+  it("marks the selected calendar ready after enqueueing events", async () => {
+    await service.startForUser({
+      userId: 101,
+      requestedById: 1,
+      integration: "google_calendar",
+    });
+
+    expect(repository.updateRunStatus).toHaveBeenCalledWith(
+      "run_1",
+      "completed",
+      expect.objectContaining({
+        eventsDiscovered: 3,
+        eventsQueued: 3,
+        lastProviderSyncToken: "sync-token-1",
+      })
+    );
+    expect(prisma.selectedCalendar.update).toHaveBeenLastCalledWith({
+      where: {
+        id: "selected-calendar-1",
+      },
+      data: expect.objectContaining({
+        syncToken: "sync-token-1",
+        syncSubscribedAt: expect.any(Date),
+        syncedAt: expect.any(Date),
+        historicalBackfillStatus: "completed",
+      }),
+    });
+  });
+
+  it("stores failed list errors on the selected calendar", async () => {
+    adapter.fetchEvents.mockRejectedValue(new Error("provider throttled"));
+
+    const result = await service.startForUser({
+      userId: 101,
+      requestedById: 1,
+      integration: "google_calendar",
+    });
+
+    expect(result.eventsQueued).toBe(0);
+    expect(repository.updateRunStatus).toHaveBeenCalledWith(
+      "run_1",
+      "failed",
+      expect.objectContaining({
+        error: "provider throttled",
+      })
+    );
+    expect(prisma.selectedCalendar.update).toHaveBeenLastCalledWith({
+      where: {
+        id: "selected-calendar-1",
+      },
+      data: expect.objectContaining({
+        historicalBackfillStatus: "failed",
+        historicalBackfillError: "provider throttled",
+      }),
+    });
+  });
+
+  it("supports dry run without queueing trigger jobs", async () => {
+    const result = await service.startForUser({
+      userId: 101,
+      dryRun: true,
+      integration: "google_calendar",
+    });
+
+    expect(result.dryRun).toBe(true);
+    expect(result.eventsDiscovered).toBe(3);
+    expect(result.eventsQueued).toBe(3);
+    expect(repository.createBackfillEvent).not.toHaveBeenCalled();
+    expect(tasker.enqueueEvent).not.toHaveBeenCalled();
+  });
+
+  it("tracks multiple calendars independently", async () => {
+    repository.findEligibleSelectedCalendars.mockResolvedValue([
+      selectedCalendar,
+      {
+        ...selectedCalendar,
+        id: "selected-calendar-2",
+        externalId: "work",
+      },
+    ]);
+
+    const result = await service.startForUser({
+      userId: 101,
+      integration: "google_calendar",
+    });
+
+    expect(result.calendarsStarted).toBe(2);
+    expect(result.eventsQueued).toBe(6);
+    expect(repository.createRun).toHaveBeenCalledTimes(2);
+    expect(tasker.enqueueEvent).toHaveBeenCalledTimes(6);
+  });
+});
diff --git a/packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillTasker.test.ts b/packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillTasker.test.ts
new file mode 100644
index 0000000000..2fa0c5a35f
--- /dev/null
+++ b/packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillTasker.test.ts
@@ -0,0 +1,213 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+
+import { HistoricalCalendarBackfillTasker } from "../HistoricalCalendarBackfillTasker";
+
+vi.mock("../trigger/start-user-calendar-backfill", () => ({
+  startUserCalendarBackfill: {
+    trigger: vi.fn().mockResolvedValue({
+      id: "start-trigger-run",
+    }),
+  },
+}));
+
+vi.mock("../trigger/backfill-calendar-event", () => ({
+  backfillCalendarEvent: {
+    trigger: vi.fn().mockResolvedValue({
+      id: "event-trigger-run",
+    }),
+  },
+}));
+
+const event = {
+  id: "provider-event-1",
+  iCalUID: "provider-event-1@google.com",
+  start: new Date("2026-04-10T10:00:00.000Z"),
+  end: new Date("2026-04-10T11:00:00.000Z"),
+  busy: true,
+  etag: "etag-provider-event-1",
+  summary: "Busy",
+  description: null,
+  location: null,
+  kind: "calendar#event",
+  status: "confirmed",
+  isAllDay: false,
+  timeZone: "UTC",
+  recurringEventId: null,
+  originalStartDate: null,
+  createdAt: new Date("2026-04-01T00:00:00.000Z"),
+  updatedAt: new Date("2026-04-02T00:00:00.000Z"),
+};
+
+describe("HistoricalCalendarBackfillTasker", () => {
+  beforeEach(() => {
+    vi.clearAllMocks();
+  });
+
+  it("starts a user backfill with a stable idempotency key", async () => {
+    const { startUserCalendarBackfill } = await import("../trigger/start-user-calendar-backfill");
+    const tasker = new HistoricalCalendarBackfillTasker();
+
+    const runId = await tasker.startUserBackfill({
+      userId: 101,
+      requestedById: 1,
+      integration: "google_calendar",
+      selectedCalendarId: "selected-calendar-1",
+      monthsBack: 12,
+    });
+
+    expect(runId).toBe("start-trigger-run");
+    expect(startUserCalendarBackfill.trigger).toHaveBeenCalledWith(
+      expect.objectContaining({
+        userId: 101,
+        selectedCalendarId: "selected-calendar-1",
+      }),
+      expect.objectContaining({
+        idempotencyKey:
+          "calendar-backfill-start:101:google_calendar:all:selected-calendar-1",
+      })
+    );
+  });
+
+  it("queues one trigger run for every historical event", async () => {
+    const { backfillCalendarEvent } = await import("../trigger/backfill-calendar-event");
+    const tasker = new HistoricalCalendarBackfillTasker();
+
+    const handles = await tasker.enqueueEvents([
+      {
+        runId: "run_1",
+        selectedCalendarId: "selected-calendar-1",
+        provider: "google_calendar",
+        syncToken: "sync-token-1",
+        requestedById: 1,
+        event: {
+          ...event,
+          id: "event-a",
+        },
+      },
+      {
+        runId: "run_1",
+        selectedCalendarId: "selected-calendar-1",
+        provider: "google_calendar",
+        syncToken: "sync-token-1",
+        requestedById: 1,
+        event: {
+          ...event,
+          id: "event-b",
+        },
+      },
+      {
+        runId: "run_1",
+        selectedCalendarId: "selected-calendar-1",
+        provider: "google_calendar",
+        syncToken: "sync-token-1",
+        requestedById: 1,
+        event: {
+          ...event,
+          id: "event-c",
+        },
+      },
+    ]);
+
+    expect(handles).toEqual(["event-trigger-run", "event-trigger-run", "event-trigger-run"]);
+    expect(backfillCalendarEvent.trigger).toHaveBeenCalledTimes(3);
+    expect(backfillCalendarEvent.trigger).toHaveBeenNthCalledWith(
+      3,
+      expect.objectContaining({
+        eventId: "event-c",
+        runId: "run_1",
+      }),
+      expect.objectContaining({
+        idempotencyKey: "calendar-backfill-event:run_1:selected-calendar-1:event-c",
+      })
+    );
+  });
+
+  it("lets callers override Trigger.dev options", async () => {
+    const { backfillCalendarEvent } = await import("../trigger/backfill-calendar-event");
+    const tasker = new HistoricalCalendarBackfillTasker();
+
+    await tasker.enqueueEvent(
+      {
+        runId: "run_1",
+        selectedCalendarId: "selected-calendar-1",
+        provider: "google_calendar",
+        syncToken: "sync-token-1",
+        requestedById: 1,
+        event,
+      },
+      {
+        idempotencyKey: "custom-key",
+        delay: "10m",
+      }
+    );
+
+    expect(backfillCalendarEvent.trigger).toHaveBeenCalledWith(
+      expect.objectContaining({
+        eventId: "provider-event-1",
+      }),
+      expect.objectContaining({
+        idempotencyKey: "custom-key",
+        delay: "10m",
+      })
+    );
+  });
+});
diff --git a/docs/operations/historical-calendar-backfill.md b/docs/operations/historical-calendar-backfill.md
new file mode 100644
index 0000000000..6f5e9a4c83
--- /dev/null
+++ b/docs/operations/historical-calendar-backfill.md
@@ -0,0 +1,164 @@
+# Historical Calendar Backfill
+
+Historical calendar backfill lets support populate the calendar subscription
+cache for users who enabled cache after selecting calendars. It is intended for
+Google Calendar and Microsoft 365 calendars.
+
+## When to run it
+
+Run a backfill when:
+
+- the user has calendar subscription cache enabled,
+- selected calendars were created before the cache feature was enabled,
+- availability appears to hit provider APIs instead of the cache,
+- support needs historical busy events to be loaded for a user,
+- the user has reconnected a calendar and wants cache to warm quickly.
+
+Do not use it to repair invalid credentials. Reconnect the calendar first.
+
+## API
+
+```bash
+curl -X POST "$WEBAPP_URL/api/calendar-cache/backfill" \
+  -H "content-type: application/json" \
+  -d '{
+    "userId": 101,
+    "integration": "google_calendar",
+    "monthsBack": 12,
+    "reason": "support requested cache warmup"
+  }'
+```
+
+The endpoint schedules the Trigger.dev starter task and returns a run id.
+
+## What the job does
+
+For every selected calendar in scope, the job:
+
+1. creates a `CalendarBackfillRun`,
+2. lists historical provider events,
+3. writes a `CalendarBackfillEvent` row for each provider event,
+4. queues one Trigger.dev event job for each provider event,
+5. marks the selected calendar as completed,
+6. sets `syncToken`, `syncedAt`, and `syncSubscribedAt`,
+7. lets event jobs populate `CalendarCacheEvent`.
+
+The completion state means the listing pass finished and the jobs were queued.
+Individual event failures are tracked in `CalendarBackfillEvent`.
+
+## Operational checks
+
+Check run status:
+
+```sql
+SELECT id,
+       "userId",
+       "selectedCalendarId",
+       status,
+       "eventsDiscovered",
+       "eventsQueued",
+       "eventsProcessed",
+       "eventsFailed",
+       "lastProviderSyncToken",
+       error
+FROM "CalendarBackfillRun"
+WHERE id = '<run-id>';
+```
+
+Check event failures:
+
+```sql
+SELECT id, "externalId", status, error
+FROM "CalendarBackfillEvent"
+WHERE "runId" = '<run-id>'
+ORDER BY "queuedAt" DESC
+LIMIT 50;
+```
+
+Check selected calendar readiness:
+
+```sql
+SELECT id,
+       "syncToken",
+       "syncSubscribedAt",
+       "syncedAt",
+       "historicalBackfillStatus",
+       "historicalBackfilledAt",
+       "historicalBackfillError"
+FROM "SelectedCalendar"
+WHERE id = '<selected-calendar-id>';
+```
+
+If `syncToken` and `syncSubscribedAt` are set, the cache wrapper is allowed to
+serve availability from `CalendarCacheEvent`.
+
+## Provider load
+
+The backfill uses Trigger.dev queues:
+
+- starter task concurrency: 25,
+- event task concurrency: 100,
+- event task retry attempts: 2.
+
+A large calendar can create thousands of event jobs. This is expected. If a
+provider throttles requests, Trigger.dev retries the failing event job.
+
+## Failure handling
+
+If listing events fails, the selected calendar is marked failed and the support
+operator should retry later.
+
+If individual event jobs fail after the listing pass, the selected calendar may
+still show as completed. Inspect `CalendarBackfillEvent` to find the failed
+events, then retry the run.
+
+## Manual retry
+
+To retry a failed selected calendar, run the endpoint again with the same
+selected calendar id:
+
+```bash
+curl -X POST "$WEBAPP_URL/api/calendar-cache/backfill" \
+  -H "content-type: application/json" \
+  -d '{
+    "userId": 101,
+    "selectedCalendarId": "selected-calendar-id",
+    "monthsBack": 12,
+    "reason": "retry failed historical event jobs"
+  }'
+```
+
+The new run reuses provider sync state from the selected calendar. If the old
+sync token is no longer accepted by the provider, reconnect the calendar.
+
+## Support notes
+
+When debugging availability after a backfill, collect:
+
+- user id,
+- selected calendar id,
+- credential id,
+- integration,
+- run id,
+- provider error message,
+- number of queued events,
+- number of failed events,
+- whether `syncToken` and `syncSubscribedAt` are set,
+- whether `CalendarCacheEvent` has rows for the requested availability window.
+
+If availability looks stale, compare the requested slot range with cached
+events:
+
+```sql
+SELECT "externalId", start, "end", status
+FROM "CalendarCacheEvent"
+WHERE "selectedCalendarId" = '<selected-calendar-id>'
+  AND start < '<slot-end>'
+  AND "end" > '<slot-start>';
+```
+
+If no rows are present but the selected calendar has `syncToken` and
+`syncSubscribedAt`, run another backfill and check event job failures.
```

## Intended Flaws

### Flaw 1: Historical backfill fans out one job per provider event without a provider-aware rate limit

The PR introduces a starter job that lists historical provider events and then schedules one Trigger.dev job for every event. The event queue has high global concurrency, and the fan-out is done with `Promise.all` per provider page. There is no bounded per-credential or per-provider worker, no token bucket, and no use of provider `Retry-After` or delta pagination as the pacing primitive.

Relevant line references:

- `packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillTasker.ts:56-74` queues all event jobs with `Promise.all` and no provider or credential limiter.
- `packages/features/calendar-subscription/lib/backfill/trigger/config.ts:8-28` creates a global event queue with concurrency 100 rather than limiting per provider, user, credential, or calendar.
- `packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillService.ts:126-188` maps every event in each provider page to an event job and enqueues the whole page concurrently.
- `packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillTasker.test.ts:71-122` asserts that the tasker creates one Trigger.dev run per event.
- `docs/operations/historical-calendar-backfill.md:95-109` documents thousands of event jobs as expected and delegates throttling to generic task retries.

Why this is a real flaw:

Calendar providers throttle by application, tenant, user, credential, calendar, and endpoint. A 12-month historical scan can produce thousands of events per selected calendar, and a single user can have many selected calendars. Trigger.dev queue concurrency is not the same thing as respecting provider quotas. Retrying after throttling can make the load burstier because the system keeps scheduling work faster than the provider can accept it. The result is provider 429s, delayed availability, noisy retries, and potentially invalidated credentials or degraded live booking flows.

Better implementation direction:

Model backfill as a bounded provider operation. Store cursor state and process pages through a per-provider and per-credential limiter. Use a token bucket or lease table keyed by provider and credential, honor provider retry metadata, and batch cache writes per page instead of scheduling one job per event. The queue should represent controlled page work, not unbounded event fan-out.

### Flaw 2: Failed or unfinished backfills mark selected calendars ready for cached availability

The PR sets `syncToken`, `syncSubscribedAt`, `syncedAt`, and `historicalBackfillStatus: "completed"` after provider events are listed and event jobs are queued. It also lets individual event jobs set the selected calendar to completed after processing a single event. In Cal.com's existing cache wrapper, a selected calendar with both `syncToken` and `syncSubscribedAt` is served from cache, so the calendar can become cache-ready before the historical events are actually present.

Relevant line references:

- `packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillService.ts:91-110` marks the run completed and calls `markCalendarBackfillReady` immediately after enqueueing jobs.
- `packages/features/calendar-subscription/lib/backfill/HistoricalCalendarBackfillService.ts:265-280` writes `syncToken`, `syncedAt`, and `syncSubscribedAt` as readiness state even though queued event jobs may still fail.
- `packages/features/calendar-subscription/lib/backfill/trigger/backfill-calendar-event.ts:52-73` marks the selected calendar completed after processing a single event.
- `packages/features/calendar-subscription/lib/backfill/__tests__/HistoricalCalendarBackfillService.test.ts:117-142` asserts that enqueue completion is enough to mark the selected calendar cache-ready.
- `docs/operations/historical-calendar-backfill.md:34-44` describes completion as listing and queueing, while also setting the fields that the cache wrapper uses for reads.

Why this is a real flaw:

`CalendarCacheWrapper` treats `syncToken && syncSubscribedAt` as permission to read availability from `CalendarCacheEvent`. If those fields are set before the cache contains a complete window, booking availability can miss busy events. That is a product correctness bug, not just an operations visibility issue: users can be double-booked because Cal.com trusts an incomplete cache instead of falling back to the provider. The tests and docs normalize this by saying event failures are inspected later even though availability has already switched paths.

Better implementation direction:

Use an explicit sync state machine. A selected calendar should remain in a fallback-to-provider state while backfill is `pending`, `listing`, `processing`, or `failed`. Only mark cache-readable after all pages are processed, event writes are complete, failure counts are acceptable, and the cache horizon is known. Keep `syncSubscribedAt` tied to webhook subscription readiness and introduce a separate `cacheReadyAt` or `historicalCacheReadyAt` contract if needed.

## Hints

### Flaw 1 Hints

1. What is the difference between a global queue concurrency limit and a provider quota?
2. How many jobs does this PR create for a calendar with 8,000 historical events?
3. Which code path honors Google or Microsoft retry metadata before scheduling more work?

### Flaw 2 Hints

1. What does `CalendarCacheWrapper` use to decide whether to read from cache?
2. Does this PR wait for all event jobs to finish before setting those fields?
3. What happens to availability if cache-readiness is true but `CalendarCacheEvent` is incomplete?

## Expected Answer

A strong review should say that the product-level change is a historical calendar cache backfill, but the implementation confuses scheduling work with completing synchronization.

For flaw 1, the learner should identify that the backfill lists provider events and creates one Trigger.dev job per event with high global concurrency and no provider-aware limiter. The impact is provider API throttling, retry storms, delayed backfills, noisy calendar operations, and possible harm to live availability checks. The fix is bounded page-level work with per-provider/per-credential rate limiting, cursor persistence, retry-after handling, and batched cache writes.

For flaw 2, the learner should identify that selected calendars are marked cache-ready after event jobs are queued, not after the cache is complete. The impact is stale or incomplete cached availability, which can hide busy events and double-book users. The fix is a sync state machine that keeps availability on the provider path until listing, processing, and cache writes have all completed successfully.

The best answers should connect the flaws to Cal.com's existing contracts: calendar tasks already have queue discipline, provider adapters page and store sync tokens, selected calendar sync fields drive cache reads, and cache correctness is a booking correctness boundary.

## Expert Debrief

At the product level, this PR is trying to make calendar cache adoption safer. That is the right problem. The review question is whether the implementation keeps the system truthful while doing a large amount of provider work.

The first contract is operational pacing. A queue is not a quota model. It only limits how many jobs the worker runs at once. A provider quota is usually scoped differently: app, tenant, user, credential, calendar, endpoint, or time window. Backfilling historical events has to be page-oriented and provider-aware. One job per event looks scalable because it is easy to parallelize, but it creates the exact pressure provider APIs punish.

The second contract is cache readiness. In the existing system, `syncToken` and `syncSubscribedAt` are not decorative fields. They decide whether availability reads use the cache or go to the provider. Setting them after enqueueing work changes the product behavior before the data is actually present. That can make availability wrong while all dashboards say the backfill completed.

The failure modes are concrete:

- A user with many calendars schedules tens of thousands of event jobs and gets provider-throttled.
- Retries amplify throttling because event jobs retry independently.
- Live booking availability slows down because the same provider credentials are under backfill pressure.
- A selected calendar gets `syncToken` and `syncSubscribedAt` before its historical events are written.
- The cache wrapper reads an incomplete cache and misses busy events.
- Support sees a completed backfill run while individual event rows failed later.

The reviewer thought process should be: first identify the unit of work and ask whether it matches the external system's contract. Provider APIs usually want bounded pages and pacing, not unbounded fan-out. Second, identify which fields are used as product contracts. If a field changes read behavior, it must be written only when the system is genuinely ready for that behavior.

The better implementation is a durable backfill state machine. Persist provider cursors and process pages through a per-provider/per-credential limiter. Cache writes should be batched and tracked by page or window. Selected calendars should expose separate states for subscribed, backfilling, cache-ready, and failed. Availability should fall back to live provider reads until the cache has a verified complete window.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: unbounded one-job-per-event fan-out without provider-aware rate limiting, and cache-readiness fields being set before the backfill is actually complete. It explains throttling/retry storms, live availability degradation, incomplete cache reads, and suggests bounded page processing plus a real sync/cache state machine.
- `partial`: The answer finds one flaw completely and mentions either generic queue overload or stale cache state without tying it to provider quotas and Cal.com's `syncToken`/`syncSubscribedAt` cache-read contract.
- `miss`: The answer focuses on API auth, naming, missing validation, or general background-job complexity while missing provider pacing and selected-calendar readiness semantics.
