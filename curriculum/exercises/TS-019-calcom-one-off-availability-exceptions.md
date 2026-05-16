# TS-019: Cal.diy One-Off Availability Exceptions

## Metadata

- `id`: TS-019
- `source_repo`: [calcom/cal.diy](https://github.com/calcom/cal.diy)
- `repo_area`: schedule availability, date overrides, timezone conversion, Prisma schema, tRPC schedule routes, booking-slot calculation
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 900-1,150
- `represented_diff_lines`: 925
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about local dates, instants, timezone ownership, DST behavior, schedule defaults, migration rollout, and product-level availability semantics without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds one-off availability exceptions to schedules.

Users can already define weekly working hours and date overrides, but support regularly hears from customers who want a faster way to say "I am unavailable next Friday" or "I am available from 2-5 PM this one day" without editing the whole weekly schedule. This PR adds a new availability exception table, schedule-level exception mode, tRPC mutations to create/delete exceptions, and applies exceptions during slot generation.

The PR adds:

- a new `AvailabilityException` model and migration,
- a schedule-level `exceptionMode` field,
- an `AvailabilityExceptionService`,
- helpers that apply exceptions to computed date ranges,
- tRPC handlers for creating and deleting exceptions,
- schedule update/read integration,
- tests for unavailable and available exception days.

## Existing Code Context

The real Cal codebase already has these relevant contracts:

- `packages/prisma/schema.prisma` models `Schedule` with `timeZone` and `availability`, and models `Availability.date` as `DateTime? @db.Date` for date overrides.
- `packages/features/schedules/lib/date-ranges.ts` has `processWorkingHours`, `processDateOverride`, `buildDateRanges`, `intersect`, and `subtract`. It carries the organizer timezone through the conversion and has explicit logic for DST and travel schedules.
- `packages/features/schedules/services/ScheduleService.ts` accepts `dateOverrides` as `{ start: Date; end: Date }` and converts them into `Availability` rows.
- `packages/features/availability/lib/getUserAvailability.ts` returns `workingHours`, `dateOverrides`, and final `dateRanges` after applying schedule rules, out-of-office, busy times, and limits.
- `packages/features/schedules/lib/date-ranges.test.ts` has tests for date overrides in specific timezones, travel schedules, full-day unavailable overrides, and the case where the override's local date becomes the next day in UTC.
- `packages/lib/dayjs/timeZone.schema.ts` validates IANA timezone strings for schedule inputs.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/prisma/schema.prisma`
- `packages/prisma/migrations/20260516093000_add_availability_exceptions/migration.sql`
- `packages/features/schedules/services/AvailabilityExceptionService.ts`
- `packages/features/schedules/lib/apply-availability-exceptions.ts`
- `packages/features/availability/lib/getUserAvailability.ts`
- `packages/trpc/server/routers/viewer/availability/schedule/exception.schema.ts`
- `packages/trpc/server/routers/viewer/availability/schedule/createException.handler.ts`
- `packages/trpc/server/routers/viewer/availability/schedule/deleteException.handler.ts`
- `packages/trpc/server/routers/viewer/availability/schedule/_router.tsx`
- `packages/features/schedules/lib/apply-availability-exceptions.test.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on product semantics, timezone conversion, schedule defaults, and migration behavior.

## Diff

```diff
diff --git a/packages/prisma/schema.prisma b/packages/prisma/schema.prisma
index bcc62a985f..8492331db7 100644
--- a/packages/prisma/schema.prisma
+++ b/packages/prisma/schema.prisma
@@ -942,6 +942,13 @@ model Schedule {
   name                 String
   timeZone             String?
   availability         Availability[]
+  exceptionMode        AvailabilityExceptionMode @default(EXCEPTIONS_ONLY)
+  availabilityExceptions AvailabilityException[]
   Host                 Host[]
 
   @@index([userId])
 }
 
+enum AvailabilityExceptionMode {
+  EXCEPTIONS_ONLY
+  MERGE_WITH_WORKING_HOURS
+}
+
 model Availability {
   id          Int        @id @default(autoincrement())
   user        User?      @relation(fields: [userId], references: [id], onDelete: Cascade)
@@ -959,6 +966,34 @@ model Availability {
   @@index([scheduleId])
 }
 
+model AvailabilityException {
+  id          String   @id @default(cuid())
+  schedule    Schedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)
+  scheduleId  Int
+  userId      Int
+
+  localDate   String
+  startLocal  String?
+  endLocal    String?
+
+  type        AvailabilityExceptionType
+  reason      String?
+
+  createdAt   DateTime @default(now())
+  updatedAt   DateTime @updatedAt
+  deletedAt   DateTime?
+
+  @@index([scheduleId, localDate])
+  @@index([userId, localDate])
+}
+
+enum AvailabilityExceptionType {
+  AVAILABLE
+  UNAVAILABLE
+}
+
 model SelectedCalendar {
   id              String      @id @default(uuid())
   user            User        @relation(fields: [userId], references: [id], onDelete: Cascade)
diff --git a/packages/prisma/migrations/20260516093000_add_availability_exceptions/migration.sql b/packages/prisma/migrations/20260516093000_add_availability_exceptions/migration.sql
new file mode 100644
index 0000000000..e95cf623a1
--- /dev/null
+++ b/packages/prisma/migrations/20260516093000_add_availability_exceptions/migration.sql
@@ -0,0 +1,151 @@
+CREATE TYPE "AvailabilityExceptionMode" AS ENUM (
+  'EXCEPTIONS_ONLY',
+  'MERGE_WITH_WORKING_HOURS'
+);
+
+CREATE TYPE "AvailabilityExceptionType" AS ENUM (
+  'AVAILABLE',
+  'UNAVAILABLE'
+);
+
+ALTER TABLE "Schedule"
+  ADD COLUMN "exceptionMode" "AvailabilityExceptionMode" NOT NULL DEFAULT 'EXCEPTIONS_ONLY';
+
+CREATE TABLE "AvailabilityException" (
+  "id" TEXT NOT NULL,
+  "scheduleId" INTEGER NOT NULL,
+  "userId" INTEGER NOT NULL,
+  "localDate" TEXT NOT NULL,
+  "startLocal" TEXT,
+  "endLocal" TEXT,
+  "type" "AvailabilityExceptionType" NOT NULL,
+  "reason" TEXT,
+  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  "deletedAt" TIMESTAMP(3),
+  CONSTRAINT "AvailabilityException_pkey" PRIMARY KEY ("id")
+);
+
+ALTER TABLE "AvailabilityException"
+  ADD CONSTRAINT "AvailabilityException_scheduleId_fkey"
+  FOREIGN KEY ("scheduleId")
+  REFERENCES "Schedule"("id")
+  ON DELETE CASCADE
+  ON UPDATE CASCADE;
+
+CREATE INDEX "AvailabilityException_schedule_localDate_idx"
+  ON "AvailabilityException"("scheduleId", "localDate");
+
+CREATE INDEX "AvailabilityException_user_localDate_idx"
+  ON "AvailabilityException"("userId", "localDate");
+
+CREATE INDEX "AvailabilityException_deletedAt_idx"
+  ON "AvailabilityException"("deletedAt");
+
+UPDATE "Schedule"
+SET "exceptionMode" = 'EXCEPTIONS_ONLY'
+WHERE "exceptionMode" IS NULL;
+
+-- Backfill a blank exception row for every existing schedule so the new
+-- exception list can render without a special empty state.
+INSERT INTO "AvailabilityException" (
+  "id",
+  "scheduleId",
+  "userId",
+  "localDate",
+  "startLocal",
+  "endLocal",
+  "type",
+  "reason",
+  "createdAt",
+  "updatedAt"
+)
+SELECT
+  CONCAT('exc_', "Schedule"."id", '_bootstrap'),
+  "Schedule"."id",
+  "Schedule"."userId",
+  TO_CHAR(NOW(), 'YYYY-MM-DD'),
+  NULL,
+  NULL,
+  'UNAVAILABLE',
+  'Created during availability exception migration',
+  NOW(),
+  NOW()
+FROM "Schedule";
+
+-- Existing schedules now use exceptions as the primary source of availability.
+-- Product wants users to explicitly opt back into weekly hours when they next
+-- edit their schedule.
+UPDATE "Schedule"
+SET "exceptionMode" = 'EXCEPTIONS_ONLY';
+
+-- Rollback:
+--
+-- DROP TABLE "AvailabilityException";
+-- ALTER TABLE "Schedule" DROP COLUMN "exceptionMode";
+-- DROP TYPE "AvailabilityExceptionType";
+-- DROP TYPE "AvailabilityExceptionMode";
+--
+-- Operational notes:
+--
+-- 1. This migration is additive except for the schedule default above.
+-- 2. Exception rows are scoped to a schedule. Deleting a schedule removes its
+--    exception rows.
+-- 3. The localDate string stores the calendar day selected by the user.
+-- 4. startLocal/endLocal store HH:mm strings for partial-day exceptions.
+-- 5. A NULL startLocal/endLocal pair means the exception applies to the full
+--    local day.
+-- 6. deletedAt is used by the API so support can inspect recently removed
+--    exceptions while the schedule remains active.
+-- 7. Dashboard analytics can group by userId and localDate.
+-- 8. The first version does not support recurring exceptions.
+-- 9. The first version does not support team-managed exceptions.
+-- 10. The first version does not support exception approval flows.
+--
+-- Sample rows:
+--
+-- id: exc_abc
+-- scheduleId: 42
+-- userId: 10
+-- localDate: 2026-06-01
+-- startLocal: 14:00
+-- endLocal: 17:00
+-- type: AVAILABLE
+--
+-- id: exc_def
+-- scheduleId: 42
+-- userId: 10
+-- localDate: 2026-06-07
+-- startLocal: NULL
+-- endLocal: NULL
+-- type: UNAVAILABLE
+--
+-- Keeping localDate as TEXT avoids timezone conversion in Prisma and makes the
+-- API payload match the form value from the date picker.
+--
+-- End of migration.
diff --git a/packages/features/schedules/services/AvailabilityExceptionService.ts b/packages/features/schedules/services/AvailabilityExceptionService.ts
new file mode 100644
index 0000000000..2acb244f22
--- /dev/null
+++ b/packages/features/schedules/services/AvailabilityExceptionService.ts
@@ -0,0 +1,250 @@
+import dayjs from "@calcom/dayjs";
+import { hasEditPermissionForUserID } from "@calcom/lib/hasEditPermissionForUser";
+import { HttpError } from "@calcom/lib/http-error";
+import type { PrismaClient } from "@calcom/prisma";
+import type { AvailabilityException, AvailabilityExceptionType } from "@calcom/prisma/client";
+
+export type CreateAvailabilityExceptionInput = {
+  scheduleId: number;
+  localDate: string;
+  startLocal?: string | null;
+  endLocal?: string | null;
+  type: AvailabilityExceptionType;
+  reason?: string | null;
+};
+
+export type DeleteAvailabilityExceptionInput = {
+  scheduleId: number;
+  exceptionId: string;
+};
+
+export type AvailabilityExceptionDTO = Pick<
+  AvailabilityException,
+  | "id"
+  | "scheduleId"
+  | "userId"
+  | "localDate"
+  | "startLocal"
+  | "endLocal"
+  | "type"
+  | "reason"
+  | "createdAt"
+  | "updatedAt"
+>;
+
+type Actor = {
+  id: number;
+  defaultScheduleId: number | null;
+  timeZone: string;
+};
+
+export class AvailabilityExceptionService {
+  constructor(private readonly prisma: PrismaClient) {}
+
+  async create({
+    input,
+    actor,
+  }: {
+    input: CreateAvailabilityExceptionInput;
+    actor: Actor;
+  }): Promise<AvailabilityExceptionDTO> {
+    const schedule = await this.prisma.schedule.findUnique({
+      where: {
+        id: input.scheduleId,
+      },
+      select: {
+        id: true,
+        userId: true,
+        timeZone: true,
+      },
+    });
+
+    if (!schedule) {
+      throw new HttpError({
+        statusCode: 404,
+        message: "Schedule not found",
+      });
+    }
+
+    if (schedule.userId !== actor.id) {
+      const canEdit = await hasEditPermissionForUserID({
+        ctx: {
+          user: actor,
+        },
+        input: {
+          memberId: schedule.userId,
+        },
+      });
+      if (!canEdit) {
+        throw new HttpError({
+          statusCode: 401,
+          message: "Unauthorized",
+        });
+      }
+    }
+
+    this.validateLocalDate(input.localDate);
+    this.validateLocalTime(input.startLocal);
+    this.validateLocalTime(input.endLocal);
+
+    if (input.startLocal && input.endLocal && input.startLocal >= input.endLocal) {
+      throw new HttpError({
+        statusCode: 400,
+        message: "Start time must be before end time",
+      });
+    }
+
+    const exception = await this.prisma.availabilityException.create({
+      data: {
+        scheduleId: schedule.id,
+        userId: schedule.userId,
+        localDate: input.localDate,
+        startLocal: input.startLocal ?? null,
+        endLocal: input.endLocal ?? null,
+        type: input.type,
+        reason: input.reason ?? null,
+      },
+      select: exceptionSelect,
+    });
+
+    return exception;
+  }
+
+  async delete({
+    input,
+    actor,
+  }: {
+    input: DeleteAvailabilityExceptionInput;
+    actor: Actor;
+  }): Promise<{ id: string }> {
+    const exception = await this.prisma.availabilityException.findFirst({
+      where: {
+        id: input.exceptionId,
+        scheduleId: input.scheduleId,
+        deletedAt: null,
+      },
+      select: {
+        id: true,
+        schedule: {
+          select: {
+            userId: true,
+          },
+        },
+      },
+    });
+
+    if (!exception) {
+      throw new HttpError({
+        statusCode: 404,
+        message: "Exception not found",
+      });
+    }
+
+    if (exception.schedule.userId !== actor.id) {
+      const canEdit = await hasEditPermissionForUserID({
+        ctx: {
+          user: actor,
+        },
+        input: {
+          memberId: exception.schedule.userId,
+        },
+      });
+      if (!canEdit) {
+        throw new HttpError({
+          statusCode: 401,
+          message: "Unauthorized",
+        });
+      }
+    }
+
+    await this.prisma.availabilityException.update({
+      where: {
+        id: exception.id,
+      },
+      data: {
+        deletedAt: new Date(),
+      },
+    });
+
+    return { id: exception.id };
+  }
+
+  async listForSchedule({
+    scheduleId,
+    dateFrom,
+    dateTo,
+  }: {
+    scheduleId: number;
+    dateFrom: Date;
+    dateTo: Date;
+  }): Promise<AvailabilityExceptionDTO[]> {
+    const from = dayjs(dateFrom).format("YYYY-MM-DD");
+    const to = dayjs(dateTo).format("YYYY-MM-DD");
+
+    return this.prisma.availabilityException.findMany({
+      where: {
+        scheduleId,
+        deletedAt: null,
+        localDate: {
+          gte: from,
+          lte: to,
+        },
+      },
+      select: exceptionSelect,
+      orderBy: [
+        {
+          localDate: "asc",
+        },
+        {
+          startLocal: "asc",
+        },
+      ],
+    });
+  }
+
+  private validateLocalDate(localDate: string) {
+    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
+      throw new HttpError({
+        statusCode: 400,
+        message: "Invalid exception date",
+      });
+    }
+    if (!dayjs(localDate).isValid()) {
+      throw new HttpError({
+        statusCode: 400,
+        message: "Invalid exception date",
+      });
+    }
+  }
+
+  private validateLocalTime(value?: string | null) {
+    if (!value) {
+      return;
+    }
+    if (!/^\d{2}:\d{2}$/.test(value)) {
+      throw new HttpError({
+        statusCode: 400,
+        message: "Invalid exception time",
+      });
+    }
+    const [hour, minute] = value.split(":").map(Number);
+    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
+      throw new HttpError({
+        statusCode: 400,
+        message: "Invalid exception time",
+      });
+    }
+  }
+}
+
+const exceptionSelect = {
+  id: true,
+  scheduleId: true,
+  userId: true,
+  localDate: true,
+  startLocal: true,
+  endLocal: true,
+  type: true,
+  reason: true,
+  createdAt: true,
+  updatedAt: true,
+} as const;
diff --git a/packages/features/schedules/lib/apply-availability-exceptions.ts b/packages/features/schedules/lib/apply-availability-exceptions.ts
new file mode 100644
index 0000000000..3126d255c4
--- /dev/null
+++ b/packages/features/schedules/lib/apply-availability-exceptions.ts
@@ -0,0 +1,223 @@
+import dayjs from "@calcom/dayjs";
+import type { DateRange } from "@calcom/features/schedules/lib/date-ranges";
+import { subtract } from "@calcom/features/schedules/lib/date-ranges";
+import type { AvailabilityExceptionType } from "@calcom/prisma/client";
+
+export type AvailabilityExceptionInput = {
+  id: string;
+  localDate: string;
+  startLocal: string | null;
+  endLocal: string | null;
+  type: AvailabilityExceptionType;
+};
+
+export type ApplyAvailabilityExceptionsOptions = {
+  dateRanges: DateRange[];
+  exceptions: AvailabilityExceptionInput[];
+  timeZone: string;
+  mode: "EXCEPTIONS_ONLY" | "MERGE_WITH_WORKING_HOURS";
+};
+
+export function applyAvailabilityExceptions({
+  dateRanges,
+  exceptions,
+  timeZone,
+  mode,
+}: ApplyAvailabilityExceptionsOptions): DateRange[] {
+  const exceptionRanges = exceptions.map((exception) => exceptionToDateRange(exception, timeZone));
+  const unavailableRanges = exceptionRanges.filter((entry) => entry.type === "UNAVAILABLE").map((entry) => entry.range);
+  const availableRanges = exceptionRanges.filter((entry) => entry.type === "AVAILABLE").map((entry) => entry.range);
+
+  if (mode === "EXCEPTIONS_ONLY") {
+    return subtract(availableRanges, unavailableRanges);
+  }
+
+  return subtract([...dateRanges, ...availableRanges], unavailableRanges);
+}
+
+function exceptionToDateRange(exception: AvailabilityExceptionInput, timeZone: string): {
+  type: AvailabilityExceptionType;
+  range: DateRange;
+} {
+  const start = parseExceptionStart(exception, timeZone);
+  const end = parseExceptionEnd(exception, timeZone, start);
+  return {
+    type: exception.type,
+    range: {
+      start,
+      end,
+    },
+  };
+}
+
+function parseExceptionStart(exception: AvailabilityExceptionInput, timeZone: string) {
+  const startLocal = exception.startLocal ?? "00:00";
+  const [hour, minute] = startLocal.split(":").map(Number);
+  return dayjs(exception.localDate).hour(hour).minute(minute).second(0).millisecond(0).tz(timeZone);
+}
+
+function parseExceptionEnd(exception: AvailabilityExceptionInput, timeZone: string, start: dayjs.Dayjs) {
+  const endLocal = exception.endLocal ?? "23:59";
+  const [hour, minute] = endLocal.split(":").map(Number);
+  let end = dayjs(exception.localDate).hour(hour).minute(minute).second(0).millisecond(0).tz(timeZone);
+  if (!end.isAfter(start)) {
+    end = end.add(1, "day");
+  }
+  if (end.hour() === 23 && end.minute() === 59) {
+    end = end.add(1, "minute");
+  }
+  return end;
+}
+
+export function groupExceptionsByLocalDate(exceptions: AvailabilityExceptionInput[]) {
+  return exceptions.reduce<Record<string, AvailabilityExceptionInput[]>>((acc, exception) => {
+    acc[exception.localDate] = acc[exception.localDate] ?? [];
+    acc[exception.localDate].push(exception);
+    return acc;
+  }, {});
+}
+
+export function getExceptionDateRangeFilter(dateFrom: Date, dateTo: Date) {
+  return {
+    from: dayjs(dateFrom).format("YYYY-MM-DD"),
+    to: dayjs(dateTo).format("YYYY-MM-DD"),
+  };
+}
+
+export function hasExceptionForDay(exceptions: AvailabilityExceptionInput[], date: Date) {
+  const key = dayjs(date).format("YYYY-MM-DD");
+  return exceptions.some((exception) => exception.localDate === key);
+}
+
+export function summarizeExceptions(exceptions: AvailabilityExceptionInput[]) {
+  const summary = {
+    available: 0,
+    unavailable: 0,
+    fullDay: 0,
+    partialDay: 0,
+  };
+
+  for (const exception of exceptions) {
+    if (exception.type === "AVAILABLE") {
+      summary.available++;
+    } else {
+      summary.unavailable++;
+    }
+    if (!exception.startLocal && !exception.endLocal) {
+      summary.fullDay++;
+    } else {
+      summary.partialDay++;
+    }
+  }
+
+  return summary;
+}
+
+export function normalizeExceptionPayload(input: {
+  localDate: string;
+  startLocal?: string | null;
+  endLocal?: string | null;
+  type: AvailabilityExceptionType;
+}) {
+  return {
+    localDate: input.localDate.trim(),
+    startLocal: input.startLocal?.trim() || null,
+    endLocal: input.endLocal?.trim() || null,
+    type: input.type,
+  };
+}
diff --git a/packages/features/availability/lib/getUserAvailability.ts b/packages/features/availability/lib/getUserAvailability.ts
index c527101b44..d50f36e0df 100644
--- a/packages/features/availability/lib/getUserAvailability.ts
+++ b/packages/features/availability/lib/getUserAvailability.ts
@@ -12,6 +12,8 @@ import {
 } from "@calcom/features/busyTimes/lib/getBusyTimesFromLimits";
 import { getBusyTimesService } from "@calcom/features/di/containers/BusyTimes";
 import type { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
+import { applyAvailabilityExceptions } from "@calcom/features/schedules/lib/apply-availability-exceptions";
+import { AvailabilityExceptionService } from "@calcom/features/schedules/services/AvailabilityExceptionService";
 import type { PrismaHolidayRepository } from "@calcom/features/holidays/repositories/PrismaHolidayRepository";
 import type { PrismaOOORepository } from "@calcom/features/ooo/repositories/PrismaOOORepository";
 import type { IRedisService } from "@calcom/features/redis/IRedisService";
@@ -125,6 +127,8 @@ export type GetUserAvailabilityInitialData = {
       timeZone: string | null;
       id: number;
     }[];
+    availabilityExceptions?: { id: string; localDate: string; startLocal: string | null; endLocal: string | null; type: "AVAILABLE" | "UNAVAILABLE" }[];
+    exceptionMode?: "EXCEPTIONS_ONLY" | "MERGE_WITH_WORKING_HOURS";
     credentials: CredentialForCalendarService[];
     allSelectedCalendars: SelectedCalendar[];
     userLevelSelectedCalendars: SelectedCalendar[];
@@ -333,6 +337,21 @@ export class UserAvailabilityService {
       schedule = detectedSchedule;
     }
 
+    const exceptionService = new AvailabilityExceptionService(prisma);
+    const availabilityExceptions =
+      initialData?.user?.availabilityExceptions ??
+      (schedule?.id
+        ? await exceptionService.listForSchedule({
+            scheduleId: schedule.id,
+            dateFrom: dateFrom.toDate(),
+            dateTo: dateTo.toDate(),
+          })
+        : []);
+
+    const exceptionMode =
+      initialData?.user?.exceptionMode ??
+      (schedule && "exceptionMode" in schedule ? schedule.exceptionMode : "EXCEPTIONS_ONLY");
+
     const { dateRanges: originalDateRanges, oooExcludedDateRanges: originalOooExcludedDateRanges } =
       buildDateRanges({
         availability,
@@ -344,6 +363,15 @@ export class UserAvailabilityService {
         outOfOffice: outOfOfficeData,
       });
 
+    const dateRanges = applyAvailabilityExceptions({
+      dateRanges: originalDateRanges,
+      exceptions: availabilityExceptions,
+      timeZone: finalTimezone,
+      mode: exceptionMode,
+    });
+    const oooExcludedDateRanges = applyAvailabilityExceptions({
+      dateRanges: originalOooExcludedDateRanges,
+      exceptions: availabilityExceptions,
+      timeZone: finalTimezone,
+      mode: exceptionMode,
+    });
+
-    const dateRanges = originalDateRanges;
-    const oooExcludedDateRanges = originalOooExcludedDateRanges;
     const busy = await this._getBusyTimes({
       user,
       eventType,
diff --git a/packages/trpc/server/routers/viewer/availability/schedule/exception.schema.ts b/packages/trpc/server/routers/viewer/availability/schedule/exception.schema.ts
new file mode 100644
index 0000000000..368a045848
--- /dev/null
+++ b/packages/trpc/server/routers/viewer/availability/schedule/exception.schema.ts
@@ -0,0 +1,78 @@
+import { z } from "zod";
+
+export const ZCreateAvailabilityExceptionInputSchema = z.object({
+  scheduleId: z.number(),
+  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
+  startLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
+  endLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
+  type: z.enum(["AVAILABLE", "UNAVAILABLE"]),
+  reason: z.string().max(200).nullable().optional(),
+});
+
+export type TCreateAvailabilityExceptionInputSchema = z.infer<
+  typeof ZCreateAvailabilityExceptionInputSchema
+>;
+
+export const ZDeleteAvailabilityExceptionInputSchema = z.object({
+  scheduleId: z.number(),
+  exceptionId: z.string(),
+});
+
+export type TDeleteAvailabilityExceptionInputSchema = z.infer<
+  typeof ZDeleteAvailabilityExceptionInputSchema
+>;
+
+export const ZListAvailabilityExceptionInputSchema = z.object({
+  scheduleId: z.number(),
+  dateFrom: z.date(),
+  dateTo: z.date(),
+});
+
+export type TListAvailabilityExceptionInputSchema = z.infer<
+  typeof ZListAvailabilityExceptionInputSchema
+>;
diff --git a/packages/trpc/server/routers/viewer/availability/schedule/createException.handler.ts b/packages/trpc/server/routers/viewer/availability/schedule/createException.handler.ts
new file mode 100644
index 0000000000..8d09144871
--- /dev/null
+++ b/packages/trpc/server/routers/viewer/availability/schedule/createException.handler.ts
@@ -0,0 +1,49 @@
+import { AvailabilityExceptionService } from "@calcom/features/schedules/services/AvailabilityExceptionService";
+import { prisma } from "@calcom/prisma";
+import type { TrpcSessionUser } from "@calcom/trpc/server/types";
+
+import type { TCreateAvailabilityExceptionInputSchema } from "./exception.schema";
+
+type User = NonNullable<TrpcSessionUser>;
+type CreateOptions = {
+  ctx: {
+    user: {
+      id: User["id"];
+      defaultScheduleId: User["defaultScheduleId"];
+      timeZone: User["timeZone"];
+    };
+  };
+  input: TCreateAvailabilityExceptionInputSchema;
+};
+
+export const createExceptionHandler = async ({ input, ctx }: CreateOptions) => {
+  const service = new AvailabilityExceptionService(prisma);
+  return service.create({
+    input,
+    actor: ctx.user,
+  });
+};
diff --git a/packages/trpc/server/routers/viewer/availability/schedule/deleteException.handler.ts b/packages/trpc/server/routers/viewer/availability/schedule/deleteException.handler.ts
new file mode 100644
index 0000000000..c85fbcdbb9
--- /dev/null
+++ b/packages/trpc/server/routers/viewer/availability/schedule/deleteException.handler.ts
@@ -0,0 +1,44 @@
+import { AvailabilityExceptionService } from "@calcom/features/schedules/services/AvailabilityExceptionService";
+import { prisma } from "@calcom/prisma";
+import type { TrpcSessionUser } from "@calcom/trpc/server/types";
+
+import type { TDeleteAvailabilityExceptionInputSchema } from "./exception.schema";
+
+type User = NonNullable<TrpcSessionUser>;
+type DeleteOptions = {
+  ctx: {
+    user: {
+      id: User["id"];
+      defaultScheduleId: User["defaultScheduleId"];
+      timeZone: User["timeZone"];
+    };
+  };
+  input: TDeleteAvailabilityExceptionInputSchema;
+};
+
+export const deleteExceptionHandler = async ({ input, ctx }: DeleteOptions) => {
+  const service = new AvailabilityExceptionService(prisma);
+  return service.delete({
+    input,
+    actor: ctx.user,
+  });
+};
diff --git a/packages/trpc/server/routers/viewer/availability/schedule/_router.tsx b/packages/trpc/server/routers/viewer/availability/schedule/_router.tsx
index 1dbed84391..d1c2cd55dc 100644
--- a/packages/trpc/server/routers/viewer/availability/schedule/_router.tsx
+++ b/packages/trpc/server/routers/viewer/availability/schedule/_router.tsx
@@ -1,6 +1,9 @@
 import { router, authedProcedure } from "@calcom/trpc/server/trpc";
+import { createExceptionHandler } from "./createException.handler";
+import { deleteExceptionHandler } from "./deleteException.handler";
 import { createHandler } from "./create.handler";
 import { ZCreateInputSchema } from "./create.schema";
+import { ZCreateAvailabilityExceptionInputSchema, ZDeleteAvailabilityExceptionInputSchema } from "./exception.schema";
 import { deleteHandler } from "./delete.handler";
 import { ZDeleteInputSchema } from "./delete.schema";
 import { duplicateHandler } from "./duplicate.handler";
@@ -26,6 +29,12 @@ export const scheduleRouter = router({
   update: authedProcedure.input(ZUpdateInputSchema).mutation(updateHandler),
   delete: authedProcedure.input(ZDeleteInputSchema).mutation(deleteHandler),
   duplicate: authedProcedure.input(ZDuplicateInputSchema).mutation(duplicateHandler),
+  createException: authedProcedure
+    .input(ZCreateAvailabilityExceptionInputSchema)
+    .mutation(createExceptionHandler),
+  deleteException: authedProcedure
+    .input(ZDeleteAvailabilityExceptionInputSchema)
+    .mutation(deleteExceptionHandler),
   bulkUpdateDefaultAvailability: authedProcedure
     .input(ZBulkUpdateDefaultAvailabilityInputSchema)
     .mutation(bulkUpdateDefaultAvailabilityHandler),
diff --git a/packages/features/schedules/lib/apply-availability-exceptions.test.ts b/packages/features/schedules/lib/apply-availability-exceptions.test.ts
new file mode 100644
index 0000000000..e9b5e876bb
--- /dev/null
+++ b/packages/features/schedules/lib/apply-availability-exceptions.test.ts
@@ -0,0 +1,246 @@
+import dayjs from "@calcom/dayjs";
+import { describe, expect, it } from "vitest";
+
+import { applyAvailabilityExceptions, getExceptionDateRangeFilter } from "./apply-availability-exceptions";
+
+describe("applyAvailabilityExceptions", () => {
+  it("removes a full unavailable day from weekly working hours", () => {
+    const timeZone = "Europe/London";
+    const dateRanges = [
+      {
+        start: dayjs.utc("2026-06-10T08:00:00Z").tz(timeZone),
+        end: dayjs.utc("2026-06-10T17:00:00Z").tz(timeZone),
+      },
+    ];
+
+    const result = applyAvailabilityExceptions({
+      dateRanges,
+      timeZone,
+      mode: "MERGE_WITH_WORKING_HOURS",
+      exceptions: [
+        {
+          id: "exc_1",
+          localDate: "2026-06-10",
+          startLocal: null,
+          endLocal: null,
+          type: "UNAVAILABLE",
+        },
+      ],
+    });
+
+    expect(result).toEqual([]);
+  });
+
+  it("adds a partial available exception when using exception-only mode", () => {
+    const timeZone = "America/New_York";
+    const result = applyAvailabilityExceptions({
+      dateRanges: [],
+      timeZone,
+      mode: "EXCEPTIONS_ONLY",
+      exceptions: [
+        {
+          id: "exc_1",
+          localDate: "2026-06-10",
+          startLocal: "14:00",
+          endLocal: "17:00",
+          type: "AVAILABLE",
+        },
+      ],
+    });
+
+    expect(result).toEqual([
+      {
+        start: dayjs("2026-06-10T14:00:00").tz(timeZone),
+        end: dayjs("2026-06-10T17:00:00").tz(timeZone),
+      },
+    ]);
+  });
+
+  it("uses exception-only mode for schedules without exceptions", () => {
+    const timeZone = "America/New_York";
+    const dateRanges = [
+      {
+        start: dayjs.utc("2026-06-10T13:00:00Z").tz(timeZone),
+        end: dayjs.utc("2026-06-10T21:00:00Z").tz(timeZone),
+      },
+    ];
+
+    const result = applyAvailabilityExceptions({
+      dateRanges,
+      timeZone,
+      mode: "EXCEPTIONS_ONLY",
+      exceptions: [],
+    });
+
+    expect(result).toEqual([]);
+  });
+
+  it("supports partial unavailable windows inside working hours", () => {
+    const timeZone = "America/New_York";
+    const dateRanges = [
+      {
+        start: dayjs.utc("2026-06-10T13:00:00Z").tz(timeZone),
+        end: dayjs.utc("2026-06-10T21:00:00Z").tz(timeZone),
+      },
+    ];
+
+    const result = applyAvailabilityExceptions({
+      dateRanges,
+      timeZone,
+      mode: "MERGE_WITH_WORKING_HOURS",
+      exceptions: [
+        {
+          id: "exc_1",
+          localDate: "2026-06-10",
+          startLocal: "12:00",
+          endLocal: "13:00",
+          type: "UNAVAILABLE",
+        },
+      ],
+    });
+
+    expect(result).toEqual([
+      {
+        start: dayjs.utc("2026-06-10T13:00:00Z").tz(timeZone),
+        end: dayjs("2026-06-10T12:00:00").tz(timeZone),
+      },
+      {
+        start: dayjs("2026-06-10T13:00:00").tz(timeZone),
+        end: dayjs.utc("2026-06-10T21:00:00Z").tz(timeZone),
+      },
+    ]);
+  });
+
+  it("builds the exception lookup range from server dates", () => {
+    const filter = getExceptionDateRangeFilter(
+      new Date("2026-06-10T23:00:00.000Z"),
+      new Date("2026-06-11T23:00:00.000Z")
+    );
+
+    expect(filter).toEqual({
+      from: "2026-06-10",
+      to: "2026-06-11",
+    });
+  });
+
+  it("handles a full-day exception ending at midnight", () => {
+    const timeZone = "Europe/Berlin";
+    const result = applyAvailabilityExceptions({
+      dateRanges: [],
+      timeZone,
+      mode: "EXCEPTIONS_ONLY",
+      exceptions: [
+        {
+          id: "exc_1",
+          localDate: "2026-10-25",
+          startLocal: null,
+          endLocal: null,
+          type: "AVAILABLE",
+        },
+      ],
+    });
+
+    expect(result[0].start.format("YYYY-MM-DD")).toBe("2026-10-25");
+    expect(result[0].end.format("YYYY-MM-DD")).toBe("2026-10-26");
+  });
+});
```

## Intended Flaws

### Flaw 1: Exceptions Store Local Calendar Dates Without A Timezone Contract

- `type`: `time_zone_contract`
- `location`: `packages/prisma/schema.prisma:968-981`, `packages/prisma/migrations/20260516093000_add_availability_exceptions/migration.sql:14-24`, `packages/features/schedules/services/AvailabilityExceptionService.ts:157-182`, `packages/features/schedules/lib/apply-availability-exceptions.ts:33-63`, `packages/features/schedules/lib/apply-availability-exceptions.test.ts:36-56`
- `learner_prompt`: When a user picks "June 10, 2-5 PM", what timezone owns that local date and local time?

Expected answer:

- `identify`: The new table stores `localDate`, `startLocal`, and `endLocal` as strings, but it does not store the timezone/version that made those strings meaningful. Reads query `localDate` by formatting server-side `dateFrom`/`dateTo`, and `parseExceptionStart` parses `dayjs(exception.localDate).hour(...).tz(timeZone)` instead of constructing the selected wall-clock time in the schedule timezone. This bypasses the existing `processDateOverride`/`buildDateRanges` timezone handling and ignores travel-schedule behavior.
- `impact`: Exceptions will shift or disappear near UTC day boundaries and DST transitions. A New York user's "June 10 unavailable" can be looked up as June 9 or June 11 depending on the server/input range. A travel schedule can apply the exception to the wrong timezone because the stored row has no timezone provenance. Customers will see slots on days they blocked or lose slots on days they opened.
- `fix_direction`: Give the exception an explicit time contract. Either store canonical UTC start/end instants plus the source IANA timezone and local date used for display, or model it exactly like existing date overrides with schedule-owned timezone conversion. Query by UTC range overlap, not by server-formatted localDate strings. If travel schedules affect exceptions, document and implement that precedence with tests around DST and UTC boundary cases.

Hints:

1. Compare `parseExceptionStart` to the existing `processDateOverride`.
2. A `YYYY-MM-DD` string is not enough once users and servers live in different timezones.
3. The lookup range is formatted from server dates, not the schedule's local calendar.

### Flaw 2: The Migration Makes Existing Schedules Exception-Only

- `type`: `migration_rollout`
- `location`: `packages/prisma/schema.prisma:948-949`, `packages/prisma/migrations/20260516093000_add_availability_exceptions/migration.sql:10-12`, `packages/prisma/migrations/20260516093000_add_availability_exceptions/migration.sql:42-69`, `packages/features/availability/lib/getUserAvailability.ts:347-354`, `packages/features/schedules/lib/apply-availability-exceptions.ts:20-28`, `packages/features/schedules/lib/apply-availability-exceptions.test.ts:58-78`
- `learner_prompt`: What happens to every existing schedule that has working hours but no user-created exception?

Expected answer:

- `identify`: The schema defaults `Schedule.exceptionMode` to `EXCEPTIONS_ONLY`, the migration sets every existing schedule to `EXCEPTIONS_ONLY`, and it even inserts a full-day `UNAVAILABLE` bootstrap exception for every schedule. `applyAvailabilityExceptions` returns only available exceptions in that mode, so a schedule with normal weekly working hours and no available exceptions returns no availability.
- `impact`: This is a production outage. Existing users' booking pages can go empty immediately after deploy. Existing event types that rely on weekly schedules stop offering slots until users edit their schedules. The bootstrap unavailable row makes the blast radius worse because the system now has explicit blocking data that users never created.
- `fix_direction`: Make the migration additive and compatibility-preserving. Default existing schedules to `MERGE_WITH_WORKING_HOURS`, do not backfill synthetic unavailable exceptions, and gate the new exception-only behavior behind an explicit user action or feature flag. Ship a dual-read/dual-write or shadow-read phase if needed, then migrate semantics only after telemetry proves no schedules would become empty.

Hints:

1. Defaults in migrations are product behavior, not just schema trivia.
2. Look at what `EXCEPTIONS_ONLY` does when `exceptions` is empty.
3. A backfill row with `UNAVAILABLE` is not an empty-state helper in a scheduling system.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that the exception's local date/time has no stable timezone contract and that the parsing/query path bypasses the existing date-override conversion rules. Answers that only say "strings are bad" are incomplete.

For flaw 2, a correct answer must identify the deploy-time behavior change for existing schedules. Answers that only say "default seems wrong" are incomplete unless they explain why users lose bookable slots.

### Product-Level Change

The PR tries to let users make one-off changes to availability without editing their weekly schedule. That is a real product need, but it is also one of the easiest areas to break because scheduling systems are mostly contracts around local time.

### Changed Contracts

- Data contract: exceptions become a new schedule-owned availability input.
- Time contract: selected local dates and times must map to bookable UTC instants.
- Availability contract: final date ranges now depend on `exceptionMode`.
- Migration contract: existing schedules now receive a new default behavior.
- API contract: clients can create and delete exception rows independently of schedule updates.

### Failure Modes

A London user blocks June 10, but a request range arrives from an attendee in Pacific time. The service formats the UTC range to localDate strings without using the schedule timezone, so the exception is not loaded and slots remain visible.

An existing customer has a weekday 9-5 schedule and no exceptions. After deploy, their schedule is `EXCEPTIONS_ONLY`; there are no available exceptions, so their booking page shows no slots. Support sees a bootstrap unavailable exception the user never created.

### Reviewer Thought Process

A strong reviewer sees `localDate` and asks, "Local to whom?" Then they trace the flow from storage, through query range, through conversion to `DateRange`, into slot generation. If that flow changes which timezone owns the wall-clock date, it is a correctness bug.

The same reviewer treats schema defaults as rollout behavior. A default that is safe for new rows can still be catastrophic for old rows if the application reads it immediately.

### Better Implementation Direction

- Store exceptions as UTC instants plus source timezone and local display date, or reuse the existing date-override conversion model.
- Validate timezone with the existing `timeZoneSchema`.
- Query exceptions by overlap against canonical instants, not string comparison on local dates.
- Preserve existing weekly schedule behavior by defaulting old schedules to merge mode.
- Do not create synthetic unavailable rows during migration.
- Add tests for New York/Pacific boundary, Europe DST transition, travel schedules, existing schedule with no exceptions, and rollout compatibility.

## Why This Case Exists

This case teaches that "just add a one-off date" is never just a date in a scheduling product. The reviewer has to protect product semantics across storage, parsing, query boundaries, and rollout defaults.
