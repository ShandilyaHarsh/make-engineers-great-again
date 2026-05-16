# TS-002: Cal.diy Bulk Availability Preview For Event Types

## Metadata

- `id`: TS-002
- `source_repo`: [calcom/cal.diy](https://github.com/calcom/cal.diy)
- `repo_area`: v2 slots API, availability calculation, schedules, booking busy-time queries, public slot output contract
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 1032
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about availability invariants, privacy boundaries, and API response contracts without reducing credit.

## PR Description Shown To Learner

This PR adds a bulk availability preview endpoint for partners that need to show available slots for several event types in one request.

Today a partner has to call the slots endpoint once per event type. That is slow for marketplace pages, support-routing pages, and onboarding flows that compare multiple meeting types. The new endpoint accepts:

- an array of event type ids,
- a start/end time range,
- the booker timezone,
- an optional duration override,
- an optional `includeBusyDetails` flag for debugging why slots are unavailable.

It returns grouped slots for each event type and, when requested, busy intervals that explain which bookings blocked the returned window.

## Existing Code Context

The real Cal.diy codebase already has these relevant contracts:

- `packages/trpc/server/routers/viewer/slots/getSchedule.handler.ts` delegates slot reads to `getAvailableSlotsService().getAvailableSlots`.
- `packages/trpc/server/routers/viewer/slots/util.ts` implements `AvailableSlotsService`, which resolves event types, qualified team hosts, watchlist-blocked hosts, user availability, reserved slots, restriction schedules, period limits, seats, and output date grouping.
- `packages/features/availability/lib/getUserAvailability.ts` calculates availability through schedules, date overrides, travel schedules, out-of-office days, holidays, booking limits, duration limits, selected calendars, current seats, and `BusyTimesService`.
- `packages/features/busyTimes/services/getBusyTimes.ts` treats a user as busy when they own or attend an accepted booking, applies buffers, handles seated events, excludes the original reschedule booking, and fetches connected-calendar busy times.
- `packages/features/bookings/repositories/BookingRepository.ts` has `findAllExistingBookingsForEventTypeBetween`, including accepted organizer/attendee bookings and pending confirmation bookings that should block slots when configured.
- `apps/api/v2/src/modules/slots/slots-2024-09-04/services/slots.service.ts` already transforms v2 input and calls the shared available-slots service instead of reimplementing availability math in the API layer.
- `apps/api/v2/src/modules/slots/slots-2024-09-04/services/slots-output.service.ts` shapes the public v2 response and avoids exposing booking titles, attendee emails, or organizer emails in normal availability responses.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `apps/api/v2/src/modules/slots/slots-2024-09-04/inputs/bulk-availability-preview.input.ts`
- `apps/api/v2/src/modules/slots/slots-2024-09-04/outputs/bulk-availability-preview.output.ts`
- `apps/api/v2/src/modules/slots/slots-2024-09-04/slots.repository.ts`
- `apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.ts`
- `apps/api/v2/src/modules/slots/slots-2024-09-04/services/slots.service.ts`
- `apps/api/v2/src/modules/slots/slots-2024-09-04/controllers/slots.controller.ts`
- `apps/api/v2/src/modules/slots/slots-2024-09-04/slots.module.ts`
- `apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.spec.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally a full-stack backend PR: input contract, output contract, repository changes, service logic, controller route, module wiring, and tests.

## Diff

```diff
diff --git a/apps/api/v2/src/modules/slots/slots-2024-09-04/inputs/bulk-availability-preview.input.ts b/apps/api/v2/src/modules/slots/slots-2024-09-04/inputs/bulk-availability-preview.input.ts
new file mode 100644
index 0000000000..d8adad9011
--- /dev/null
+++ b/apps/api/v2/src/modules/slots/slots-2024-09-04/inputs/bulk-availability-preview.input.ts
@@ -0,0 +1,87 @@
+import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
+import { Transform, Type } from "class-transformer";
+import {
+  ArrayMaxSize,
+  ArrayMinSize,
+  IsArray,
+  IsBoolean,
+  IsDateString,
+  IsInt,
+  IsOptional,
+  IsString,
+  Max,
+  Min,
+  ValidateNested,
+} from "class-validator";
+
+export class BulkAvailabilityPreviewEventTypeInput {
+  @ApiProperty({
+    description: "Event type id to preview.",
+    example: 42,
+  })
+  @IsInt()
+  @Min(1)
+  eventTypeId!: number;
+
+  @ApiPropertyOptional({
+    description: "Optional display label returned next to this preview result.",
+    example: "Sales intro",
+  })
+  @IsOptional()
+  @IsString()
+  label?: string;
+
+  @ApiPropertyOptional({
+    description: "Duration override in minutes. If omitted, the event type duration is used.",
+    example: 30,
+  })
+  @IsOptional()
+  @IsInt()
+  @Min(5)
+  @Max(480)
+  duration?: number;
+}
+
+export class BulkAvailabilityPreviewInput_2024_09_04 {
+  @ApiProperty({
+    description: "Event types to preview in one request.",
+    type: [BulkAvailabilityPreviewEventTypeInput],
+  })
+  @IsArray()
+  @ArrayMinSize(1)
+  @ArrayMaxSize(20)
+  @ValidateNested({ each: true })
+  @Type(() => BulkAvailabilityPreviewEventTypeInput)
+  eventTypes!: BulkAvailabilityPreviewEventTypeInput[];
+
+  @ApiProperty({
+    description: "Range start as an ISO date string.",
+    example: "2026-01-12T00:00:00.000Z",
+  })
+  @IsDateString()
+  start!: string;
+
+  @ApiProperty({
+    description: "Range end as an ISO date string.",
+    example: "2026-01-19T00:00:00.000Z",
+  })
+  @IsDateString()
+  end!: string;
+
+  @ApiProperty({
+    description: "Booker timezone used to group slots by local date.",
+    example: "America/New_York",
+  })
+  @IsString()
+  timeZone!: string;
+
+  @ApiPropertyOptional({
+    description: "When true, include blocked intervals that explain why windows were not available.",
+    default: false,
+  })
+  @IsOptional()
+  @Transform(({ value }) => value === true || value === "true")
+  @IsBoolean()
+  includeBusyDetails?: boolean;
+
+  @ApiPropertyOptional({
+    description: "Return at most this many slots per event type.",
+    default: 50,
+  })
+  @IsOptional()
+  @IsInt()
+  @Min(1)
+  @Max(250)
+  limit?: number;
+}
diff --git a/apps/api/v2/src/modules/slots/slots-2024-09-04/outputs/bulk-availability-preview.output.ts b/apps/api/v2/src/modules/slots/slots-2024-09-04/outputs/bulk-availability-preview.output.ts
new file mode 100644
index 0000000000..fe2cfa7892
--- /dev/null
+++ b/apps/api/v2/src/modules/slots/slots-2024-09-04/outputs/bulk-availability-preview.output.ts
@@ -0,0 +1,100 @@
+import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
+
+export class BulkAvailabilitySlot_2024_09_04 {
+  @ApiProperty({
+    description: "Slot start time in the requested timezone.",
+    example: "2026-01-12T09:00:00.000-05:00",
+  })
+  start!: string;
+
+  @ApiProperty({
+    description: "Slot end time in the requested timezone.",
+    example: "2026-01-12T09:30:00.000-05:00",
+  })
+  end!: string;
+}
+
+export class BulkAvailabilityBusyDetail_2024_09_04 {
+  @ApiProperty({
+    description: "Busy interval start time in the requested timezone.",
+    example: "2026-01-12T10:00:00.000-05:00",
+  })
+  start!: string;
+
+  @ApiProperty({
+    description: "Busy interval end time in the requested timezone.",
+    example: "2026-01-12T10:30:00.000-05:00",
+  })
+  end!: string;
+
+  @ApiPropertyOptional({
+    description: "Booking title that caused the interval to be unavailable.",
+    example: "Board call",
+  })
+  title?: string | null;
+
+  @ApiPropertyOptional({
+    description: "Organizer email for the blocking booking.",
+    example: "founder@example.com",
+  })
+  organizerEmail?: string | null;
+
+  @ApiPropertyOptional({
+    description: "Attendee emails for the blocking booking.",
+    example: ["customer@example.com"],
+  })
+  attendeeEmails?: string[];
+
+  @ApiPropertyOptional({
+    description: "Internal source string used by the availability debugger.",
+    example: "eventType-42-booking-123",
+  })
+  source?: string;
+}
+
+export class BulkAvailabilityPreviewResult_2024_09_04 {
+  @ApiProperty({
+    description: "Event type id from the request.",
+    example: 42,
+  })
+  eventTypeId!: number;
+
+  @ApiPropertyOptional({
+    description: "Optional label from the request.",
+    example: "Sales intro",
+  })
+  label?: string;
+
+  @ApiProperty({
+    description: "Event type title.",
+    example: "Sales intro",
+  })
+  title!: string;
+
+  @ApiProperty({
+    description: "Event type owner id.",
+    example: 19,
+  })
+  ownerId!: number;
+
+  @ApiProperty({
+    description: "Available slots grouped by local date.",
+    type: "object",
+  })
+  slots!: Record<string, BulkAvailabilitySlot_2024_09_04[]>;
+
+  @ApiPropertyOptional({
+    description: "Busy intervals used to remove candidate slots.",
+    type: [BulkAvailabilityBusyDetail_2024_09_04],
+  })
+  busyDetails?: BulkAvailabilityBusyDetail_2024_09_04[];
+}
+
+export class BulkAvailabilityPreviewOutput_2024_09_04 {
+  @ApiProperty({
+    description: "Preview timezone used for grouping.",
+    example: "America/New_York",
+  })
+  timeZone!: string;
+
+  @ApiProperty({
+    description: "Preview results, one per event type.",
+    type: [BulkAvailabilityPreviewResult_2024_09_04],
+  })
+  data!: BulkAvailabilityPreviewResult_2024_09_04[];
+}
diff --git a/apps/api/v2/src/modules/slots/slots-2024-09-04/slots.repository.ts b/apps/api/v2/src/modules/slots/slots-2024-09-04/slots.repository.ts
index 5c0a39bd21..ce1cb1db12 100644
--- a/apps/api/v2/src/modules/slots/slots-2024-09-04/slots.repository.ts
+++ b/apps/api/v2/src/modules/slots/slots-2024-09-04/slots.repository.ts
@@ -1,9 +1,10 @@
 import { Injectable } from "@nestjs/common";
 import { DateTime } from "luxon";
 
 import { PrismaReadService } from "@/modules/prisma/prisma-read.service";
 import { PrismaWriteService } from "@/modules/prisma/prisma-write.service";
 
 import { BookingStatus } from "@calcom/prisma/enums";
+import type { Prisma } from "@calcom/prisma/client";
 
 @Injectable()
 export class SlotsRepository_2024_09_04 {
@@ -83,4 +84,150 @@ export class SlotsRepository_2024_09_04 {
 
     return overlappingSlot;
   }
+
+  async findEventTypesForBulkAvailabilityPreview(eventTypeIds: number[]) {
+    return this.prismaReadService.prisma.eventType.findMany({
+      where: {
+        id: {
+          in: eventTypeIds,
+        },
+      },
+      select: {
+        id: true,
+        title: true,
+        length: true,
+        userId: true,
+        teamId: true,
+        schedulingType: true,
+        beforeEventBuffer: true,
+        afterEventBuffer: true,
+        slotInterval: true,
+        timeZone: true,
+        periodType: true,
+        minimumBookingNotice: true,
+        hideOrganizerEmail: true,
+        hideCalendarEventDetails: true,
+        schedule: {
+          select: {
+            id: true,
+            timeZone: true,
+            availability: {
+              select: {
+                days: true,
+                startTime: true,
+                endTime: true,
+                date: true,
+              },
+            },
+          },
+        },
+        availability: {
+          select: {
+            days: true,
+            startTime: true,
+            endTime: true,
+            date: true,
+          },
+        },
+        users: {
+          select: {
+            id: true,
+            email: true,
+            name: true,
+            username: true,
+            timeZone: true,
+            defaultScheduleId: true,
+            schedules: {
+              select: {
+                id: true,
+                timeZone: true,
+                availability: {
+                  select: {
+                    days: true,
+                    startTime: true,
+                    endTime: true,
+                    date: true,
+                  },
+                },
+              },
+            },
+          },
+        },
+        hosts: {
+          select: {
+            isFixed: true,
+            user: {
+              select: {
+                id: true,
+                email: true,
+                name: true,
+                username: true,
+                timeZone: true,
+                defaultScheduleId: true,
+                schedules: {
+                  select: {
+                    id: true,
+                    timeZone: true,
+                    availability: {
+                      select: {
+                        days: true,
+                        startTime: true,
+                        endTime: true,
+                        date: true,
+                      },
+                    },
+                  },
+                },
+              },
+            },
+            schedule: {
+              select: {
+                id: true,
+                timeZone: true,
+                availability: {
+                  select: {
+                    days: true,
+                    startTime: true,
+                    endTime: true,
+                    date: true,
+                  },
+                },
+              },
+            },
+          },
+        },
+      },
+    });
+  }
+
+  async findBlockingBookingsForBulkAvailabilityPreview({
+    eventTypeIds,
+    userIds,
+    start,
+    end,
+  }: {
+    eventTypeIds: number[];
+    userIds: number[];
+    start: Date;
+    end: Date;
+  }) {
+    const where: Prisma.BookingWhereInput = {
+      OR: [
+        {
+          eventTypeId: {
+            in: eventTypeIds,
+          },
+        },
+        {
+          userId: {
+            in: userIds,
+          },
+        },
+        {
+          attendees: {
+            some: {
+              email: {
+                in: await this.findEmailsForUserIds(userIds),
+              },
+            },
+          },
+        },
+      ],
+      status: BookingStatus.ACCEPTED,
+      startTime: {
+        lte: end,
+      },
+      endTime: {
+        gte: start,
+      },
+    };
+
+    return this.prismaReadService.prisma.booking.findMany({
+      where,
+      select: {
+        id: true,
+        uid: true,
+        title: true,
+        startTime: true,
+        endTime: true,
+        userId: true,
+        user: {
+          select: {
+            id: true,
+            email: true,
+            name: true,
+          },
+        },
+        attendees: {
+          select: {
+            email: true,
+          },
+        },
+        eventType: {
+          select: {
+            id: true,
+            beforeEventBuffer: true,
+            afterEventBuffer: true,
+            hideOrganizerEmail: true,
+            hideCalendarEventDetails: true,
+          },
+        },
+      },
+      orderBy: {
+        startTime: "asc",
+      },
+    });
+  }
+
+  private async findEmailsForUserIds(userIds: number[]) {
+    const users = await this.prismaReadService.prisma.user.findMany({
+      where: {
+        id: {
+          in: userIds,
+        },
+      },
+      select: {
+        email: true,
+      },
+    });
+
+    return users.map((user) => user.email);
+  }
 }
diff --git a/apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.ts b/apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.ts
new file mode 100644
index 0000000000..cd23cd3018
--- /dev/null
+++ b/apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.ts
@@ -0,0 +1,250 @@
+import { Injectable, NotFoundException } from "@nestjs/common";
+import { DateTime, Interval } from "luxon";
+
+import type { BulkAvailabilityPreviewInput_2024_09_04 } from "../inputs/bulk-availability-preview.input";
+import type {
+  BulkAvailabilityBusyDetail_2024_09_04,
+  BulkAvailabilityPreviewOutput_2024_09_04,
+  BulkAvailabilityPreviewResult_2024_09_04,
+  BulkAvailabilitySlot_2024_09_04,
+} from "../outputs/bulk-availability-preview.output";
+import { SlotsRepository_2024_09_04 } from "../slots.repository";
+
+type PreviewEventType = Awaited<
+  ReturnType<SlotsRepository_2024_09_04["findEventTypesForBulkAvailabilityPreview"]>
+>[number];
+
+type BlockingBooking = Awaited<
+  ReturnType<SlotsRepository_2024_09_04["findBlockingBookingsForBulkAvailabilityPreview"]>
+>[number];
+
+type HostForPreview = {
+  id: number;
+  email: string;
+  name: string | null;
+  timeZone: string;
+  schedule?: {
+    timeZone: string | null;
+    availability: {
+      days: number[];
+      startTime: Date;
+      endTime: Date;
+      date: Date | null;
+    }[];
+  } | null;
+};
+
+@Injectable()
+export class BulkAvailabilityPreviewService_2024_09_04 {
+  constructor(private readonly slotsRepository: SlotsRepository_2024_09_04) {}
+
+  async getBulkAvailabilityPreview(
+    input: BulkAvailabilityPreviewInput_2024_09_04
+  ): Promise<BulkAvailabilityPreviewOutput_2024_09_04> {
+    const eventTypeIds = [...new Set(input.eventTypes.map((eventType) => eventType.eventTypeId))];
+    const eventTypes = await this.slotsRepository.findEventTypesForBulkAvailabilityPreview(eventTypeIds);
+
+    if (eventTypes.length !== eventTypeIds.length) {
+      const foundIds = new Set(eventTypes.map((eventType) => eventType.id));
+      const missingIds = eventTypeIds.filter((eventTypeId) => !foundIds.has(eventTypeId));
+      throw new NotFoundException(`Event types not found: ${missingIds.join(", ")}`);
+    }
+
+    const userIds = [...new Set(eventTypes.flatMap((eventType) => this.getHosts(eventType).map((host) => host.id)))];
+    const start = DateTime.fromISO(input.start, { zone: "utc" });
+    const end = DateTime.fromISO(input.end, { zone: "utc" });
+    const blockingBookings = await this.slotsRepository.findBlockingBookingsForBulkAvailabilityPreview({
+      eventTypeIds,
+      userIds,
+      start: start.toJSDate(),
+      end: end.toJSDate(),
+    });
+
+    const data = input.eventTypes.map((requestedEventType) => {
+      const eventType = eventTypes.find((candidate) => candidate.id === requestedEventType.eventTypeId);
+      if (!eventType) {
+        throw new NotFoundException(`Event type not found: ${requestedEventType.eventTypeId}`);
+      }
+
+      const duration = requestedEventType.duration ?? eventType.length;
+      const hosts = this.getHosts(eventType);
+      const candidateSlots = hosts.flatMap((host) =>
+        this.buildSlotsFromSchedule({
+          eventType,
+          host,
+          rangeStart: start,
+          rangeEnd: end,
+          duration,
+          outputTimeZone: input.timeZone,
+        })
+      );
+
+      const busyDetails = this.getBusyDetails({
+        eventType,
+        hosts,
+        bookings: blockingBookings,
+        outputTimeZone: input.timeZone,
+      });
+
+      const availableSlots = candidateSlots
+        .filter((slot) => !this.overlapsBusy(slot, busyDetails))
+        .slice(0, input.limit ?? 50);
+
+      return {
+        eventTypeId: eventType.id,
+        label: requestedEventType.label,
+        title: eventType.title,
+        ownerId: eventType.userId ?? hosts[0]?.id ?? 0,
+        slots: this.groupSlotsByDate(availableSlots, input.timeZone),
+        ...(input.includeBusyDetails ? { busyDetails } : {}),
+      } satisfies BulkAvailabilityPreviewResult_2024_09_04;
+    });
+
+    return {
+      timeZone: input.timeZone,
+      data,
+    };
+  }
+
+  private getHosts(eventType: PreviewEventType): HostForPreview[] {
+    if (eventType.hosts.length > 0) {
+      return eventType.hosts.map((host) => ({
+        id: host.user.id,
+        email: host.user.email,
+        name: host.user.name,
+        timeZone: host.schedule?.timeZone ?? host.user.timeZone,
+        schedule: host.schedule ?? host.user.schedules.find((schedule) => schedule.id === host.user.defaultScheduleId),
+      }));
+    }
+
+    if (eventType.users.length > 0) {
+      return eventType.users.map((user) => ({
+        id: user.id,
+        email: user.email,
+        name: user.name,
+        timeZone: eventType.schedule?.timeZone ?? user.timeZone,
+        schedule: eventType.schedule ?? user.schedules.find((schedule) => schedule.id === user.defaultScheduleId),
+      }));
+    }
+
+    if (eventType.userId && eventType.schedule) {
+      return [
+        {
+          id: eventType.userId,
+          email: "unknown",
+          name: null,
+          timeZone: eventType.schedule.timeZone ?? eventType.timeZone ?? "UTC",
+          schedule: eventType.schedule,
+        },
+      ];
+    }
+
+    return [];
+  }
+
+  private buildSlotsFromSchedule({
+    eventType,
+    host,
+    rangeStart,
+    rangeEnd,
+    duration,
+    outputTimeZone,
+  }: {
+    eventType: PreviewEventType;
+    host: HostForPreview;
+    rangeStart: DateTime;
+    rangeEnd: DateTime;
+    duration: number;
+    outputTimeZone: string;
+  }): BulkAvailabilitySlot_2024_09_04[] {
+    const slots: BulkAvailabilitySlot_2024_09_04[] = [];
+    const scheduleTimeZone = host.schedule?.timeZone ?? eventType.timeZone ?? host.timeZone ?? "UTC";
+    const intervalMinutes = eventType.slotInterval ?? duration;
+    const availability = host.schedule?.availability ?? eventType.availability;
+
+    for (let cursor = rangeStart.setZone(scheduleTimeZone).startOf("day"); cursor < rangeEnd; cursor = cursor.plus({ days: 1 })) {
+      const dayAvailability = availability.filter((rule) => {
+        if (rule.date) {
+          return DateTime.fromJSDate(rule.date, { zone: scheduleTimeZone }).hasSame(cursor, "day");
+        }
+        return rule.days.includes(cursor.weekday % 7);
+      });
+
+      for (const rule of dayAvailability) {
+        const ruleStart = DateTime.fromJSDate(rule.startTime, { zone: "utc" });
+        const ruleEnd = DateTime.fromJSDate(rule.endTime, { zone: "utc" });
+        let slotStart = cursor.set({
+          hour: ruleStart.hour,
+          minute: ruleStart.minute,
+          second: 0,
+          millisecond: 0,
+        });
+        const ruleEndOnCursor = cursor.set({
+          hour: ruleEnd.hour,
+          minute: ruleEnd.minute,
+          second: 0,
+          millisecond: 0,
+        });
+
+        while (slotStart.plus({ minutes: duration }) <= ruleEndOnCursor) {
+          if (slotStart >= rangeStart.setZone(scheduleTimeZone) && slotStart < rangeEnd.setZone(scheduleTimeZone)) {
+            const start = slotStart.setZone(outputTimeZone).toISO();
+            const end = slotStart.plus({ minutes: duration }).setZone(outputTimeZone).toISO();
+            if (start && end) {
+              slots.push({ start, end });
+            }
+          }
+          slotStart = slotStart.plus({ minutes: intervalMinutes });
+        }
+      }
+    }
+
+    return slots;
+  }
+
+  private getBusyDetails({
+    eventType,
+    hosts,
+    bookings,
+    outputTimeZone,
+  }: {
+    eventType: PreviewEventType;
+    hosts: HostForPreview[];
+    bookings: BlockingBooking[];
+    outputTimeZone: string;
+  }): BulkAvailabilityBusyDetail_2024_09_04[] {
+    const hostIds = new Set(hosts.map((host) => host.id));
+    const hostEmails = new Set(hosts.map((host) => host.email));
+
+    return bookings
+      .filter((booking) => {
+        if (booking.eventType?.id === eventType.id) return true;
+        if (booking.userId && hostIds.has(booking.userId)) return true;
+        return booking.attendees.some((attendee) => hostEmails.has(attendee.email));
+      })
+      .map((booking) => {
+        const beforeBuffer = booking.eventType?.beforeEventBuffer ?? eventType.beforeEventBuffer ?? 0;
+        const afterBuffer = booking.eventType?.afterEventBuffer ?? eventType.afterEventBuffer ?? 0;
+        const start = DateTime.fromJSDate(booking.startTime, { zone: "utc" })
+          .minus({ minutes: beforeBuffer })
+          .setZone(outputTimeZone)
+          .toISO();
+        const end = DateTime.fromJSDate(booking.endTime, { zone: "utc" })
+          .plus({ minutes: afterBuffer })
+          .setZone(outputTimeZone)
+          .toISO();
+
+        return {
+          start: start ?? booking.startTime.toISOString(),
+          end: end ?? booking.endTime.toISOString(),
+          title: booking.title,
+          organizerEmail: booking.user?.email ?? null,
+          attendeeEmails: booking.attendees.map((attendee) => attendee.email),
+          source: `eventType-${booking.eventType?.id}-booking-${booking.id}`,
+        };
+      });
+  }
+
+  private overlapsBusy(
+    slot: BulkAvailabilitySlot_2024_09_04,
+    busyDetails: BulkAvailabilityBusyDetail_2024_09_04[]
+  ) {
+    const slotInterval = Interval.fromDateTimes(DateTime.fromISO(slot.start), DateTime.fromISO(slot.end));
+
+    return busyDetails.some((busy) => {
+      const busyInterval = Interval.fromDateTimes(DateTime.fromISO(busy.start), DateTime.fromISO(busy.end));
+      return slotInterval.overlaps(busyInterval);
+    });
+  }
+
+  private groupSlotsByDate(slots: BulkAvailabilitySlot_2024_09_04[], timeZone: string) {
+    return slots.reduce<Record<string, BulkAvailabilitySlot_2024_09_04[]>>((acc, slot) => {
+      const date = DateTime.fromISO(slot.start).setZone(timeZone).toISODate();
+      if (!date) return acc;
+      acc[date] = acc[date] ?? [];
+      acc[date].push(slot);
+      return acc;
+    }, {});
+  }
+}
diff --git a/apps/api/v2/src/modules/slots/slots-2024-09-04/services/slots.service.ts b/apps/api/v2/src/modules/slots/slots-2024-09-04/services/slots.service.ts
index 31cb2bb220..15aba931db 100644
--- a/apps/api/v2/src/modules/slots/slots-2024-09-04/services/slots.service.ts
+++ b/apps/api/v2/src/modules/slots/slots-2024-09-04/services/slots.service.ts
@@ -7,6 +7,8 @@ import {
   InternalGetSlotsQuery,
   InternalGetSlotsQueryWithRouting,
 } from "@/modules/slots/slots-2024-09-04/services/slots-input.service";
+import { BulkAvailabilityPreviewInput_2024_09_04 } from "@/modules/slots/slots-2024-09-04/inputs/bulk-availability-preview.input";
+import { BulkAvailabilityPreviewService_2024_09_04 } from "@/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service";
 import { SlotsOutputService_2024_09_04 } from "@/modules/slots/slots-2024-09-04/services/slots-output.service";
 import { SlotsRepository_2024_09_04 } from "@/modules/slots/slots-2024-09-04/slots.repository";
 import { TeamsRepository } from "@/modules/teams/teams/teams.repository";
@@ -45,7 +47,8 @@ export class SlotsService_2024_09_04 {
     private readonly membershipsService: MembershipsService,
     private readonly membershipsRepository: MembershipsRepository,
     private readonly teamsRepository: TeamsRepository,
-    private readonly availableSlotsService: AvailableSlotsService
+    private readonly availableSlotsService: AvailableSlotsService,
+    private readonly bulkAvailabilityPreviewService: BulkAvailabilityPreviewService_2024_09_04
   ) {}
 
   private async fetchAndFormatSlots(queryTransformed: InternalSlotsQuery, format?: SlotFormat) {
@@ -82,6 +85,10 @@ export class SlotsService_2024_09_04 {
     return this.fetchAndFormatSlots(queryTransformed, query.format);
   }
 
+  async getBulkAvailabilityPreview(input: BulkAvailabilityPreviewInput_2024_09_04) {
+    return this.bulkAvailabilityPreviewService.getBulkAvailabilityPreview(input);
+  }
+
   async reserveSlot(input: ReserveSlotInput_2024_09_04, authUserId?: number) {
     if (input.reservationDuration && !authUserId) {
       throw new UnauthorizedException(
diff --git a/apps/api/v2/src/modules/slots/slots-2024-09-04/controllers/slots.controller.ts b/apps/api/v2/src/modules/slots/slots-2024-09-04/controllers/slots.controller.ts
index 2b327faa10..c016df8621 100644
--- a/apps/api/v2/src/modules/slots/slots-2024-09-04/controllers/slots.controller.ts
+++ b/apps/api/v2/src/modules/slots/slots-2024-09-04/controllers/slots.controller.ts
@@ -1,6 +1,7 @@
 import { Controller, Get, Post, Query, Body, Param, ParseUUIDPipe } from "@nestjs/common";
 import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
 
+import { BulkAvailabilityPreviewInput_2024_09_04 } from "../inputs/bulk-availability-preview.input";
 import {
   GetSlotsInput_2024_09_04,
   GetSlotsInputWithRouting_2024_09_04,
@@ -13,6 +14,7 @@ import {
   ReserveSlotOutput_2024_09_04,
   SlotsOutput_2024_09_04,
 } from "@calcom/platform-types";
+import { BulkAvailabilityPreviewOutput_2024_09_04 } from "../outputs/bulk-availability-preview.output";
 import { SlotsService_2024_09_04 } from "../services/slots.service";
 
 @ApiTags("Slots")
@@ -48,6 +50,18 @@ export class SlotsController_2024_09_04 {
     return this.slotsService.getAvailableSlotsWithRouting(query);
   }
 
+  @Post("/bulk-preview")
+  @ApiOperation({
+    summary: "Preview available slots for multiple event types.",
+    description: "Returns grouped availability for a set of event types in a single request.",
+  })
+  @ApiResponse({
+    status: 200,
+    type: BulkAvailabilityPreviewOutput_2024_09_04,
+  })
+  async getBulkAvailabilityPreview(@Body() body: BulkAvailabilityPreviewInput_2024_09_04) {
+    return this.slotsService.getBulkAvailabilityPreview(body);
+  }
+
   @Post("/reservations")
   @ApiOperation({
     summary: "Reserve a slot.",
diff --git a/apps/api/v2/src/modules/slots/slots-2024-09-04/slots.module.ts b/apps/api/v2/src/modules/slots/slots-2024-09-04/slots.module.ts
index 1c79ae6622..24423f4c80 100644
--- a/apps/api/v2/src/modules/slots/slots-2024-09-04/slots.module.ts
+++ b/apps/api/v2/src/modules/slots/slots-2024-09-04/slots.module.ts
@@ -5,6 +5,7 @@ import { SlotsController_2024_09_04 } from "./controllers/slots.controller";
 import { SlotsRepository_2024_09_04 } from "./slots.repository";
 import { SlotsInputService_2024_09_04 } from "./services/slots-input.service";
 import { SlotsOutputService_2024_09_04 } from "./services/slots-output.service";
+import { BulkAvailabilityPreviewService_2024_09_04 } from "./services/bulk-availability-preview.service";
 import { SlotsService_2024_09_04 } from "./services/slots.service";
 
 @Module({
@@ -18,6 +19,7 @@ import { SlotsService_2024_09_04 } from "./services/slots.service";
     SlotsRepository_2024_09_04,
     SlotsInputService_2024_09_04,
     SlotsOutputService_2024_09_04,
+    BulkAvailabilityPreviewService_2024_09_04,
     SlotsService_2024_09_04,
   ],
   exports: [SlotsService_2024_09_04],
diff --git a/apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.spec.ts b/apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.spec.ts
new file mode 100644
index 0000000000..bb1e7d6cab
--- /dev/null
+++ b/apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.spec.ts
@@ -0,0 +1,182 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { BulkAvailabilityPreviewService_2024_09_04 } from "./bulk-availability-preview.service";
+
+const makeDate = (hour: number, minute = 0) => new Date(Date.UTC(2026, 0, 12, hour, minute, 0));
+
+describe("BulkAvailabilityPreviewService_2024_09_04", () => {
+  it("returns available slots for multiple event types", async () => {
+    const repository = {
+      findEventTypesForBulkAvailabilityPreview: vi.fn().mockResolvedValue([
+        {
+          id: 10,
+          title: "Intro",
+          length: 30,
+          userId: 1,
+          teamId: null,
+          schedulingType: null,
+          beforeEventBuffer: 0,
+          afterEventBuffer: 0,
+          slotInterval: 30,
+          timeZone: "America/New_York",
+          periodType: "UNLIMITED",
+          minimumBookingNotice: 0,
+          hideOrganizerEmail: false,
+          hideCalendarEventDetails: false,
+          schedule: {
+            id: 1,
+            timeZone: "America/New_York",
+            availability: [
+              {
+                days: [1],
+                startTime: makeDate(14),
+                endTime: makeDate(16),
+                date: null,
+              },
+            ],
+          },
+          availability: [],
+          users: [
+            {
+              id: 1,
+              email: "host@example.com",
+              name: "Host",
+              username: "host",
+              timeZone: "America/New_York",
+              defaultScheduleId: 1,
+              schedules: [
+                {
+                  id: 1,
+                  timeZone: "America/New_York",
+                  availability: [
+                    {
+                      days: [1],
+                      startTime: makeDate(14),
+                      endTime: makeDate(16),
+                      date: null,
+                    },
+                  ],
+                },
+              ],
+            },
+          ],
+          hosts: [],
+        },
+        {
+          id: 11,
+          title: "Demo",
+          length: 60,
+          userId: 2,
+          teamId: null,
+          schedulingType: null,
+          beforeEventBuffer: 0,
+          afterEventBuffer: 0,
+          slotInterval: 60,
+          timeZone: "America/New_York",
+          periodType: "UNLIMITED",
+          minimumBookingNotice: 0,
+          hideOrganizerEmail: false,
+          hideCalendarEventDetails: false,
+          schedule: {
+            id: 2,
+            timeZone: "America/New_York",
+            availability: [
+              {
+                days: [1],
+                startTime: makeDate(15),
+                endTime: makeDate(17),
+                date: null,
+              },
+            ],
+          },
+          availability: [],
+          users: [
+            {
+              id: 2,
+              email: "demo@example.com",
+              name: "Demo Host",
+              username: "demo",
+              timeZone: "America/New_York",
+              defaultScheduleId: 2,
+              schedules: [
+                {
+                  id: 2,
+                  timeZone: "America/New_York",
+                  availability: [
+                    {
+                      days: [1],
+                      startTime: makeDate(15),
+                      endTime: makeDate(17),
+                      date: null,
+                    },
+                  ],
+                },
+              ],
+            },
+          ],
+          hosts: [],
+        },
+      ]),
+      findBlockingBookingsForBulkAvailabilityPreview: vi.fn().mockResolvedValue([]),
+    };
+
+    const service = new BulkAvailabilityPreviewService_2024_09_04(repository as never);
+
+    const result = await service.getBulkAvailabilityPreview({
+      eventTypes: [
+        { eventTypeId: 10, label: "intro" },
+        { eventTypeId: 11, label: "demo" },
+      ],
+      start: "2026-01-12T00:00:00.000Z",
+      end: "2026-01-13T00:00:00.000Z",
+      timeZone: "America/New_York",
+      limit: 10,
+    });
+
+    expect(result.data).toHaveLength(2);
+    expect(result.data[0].slots["2026-01-12"]).toHaveLength(4);
+    expect(result.data[1].slots["2026-01-12"]).toHaveLength(2);
+  });
+
+  it("can include busy details for debugging", async () => {
+    const repository = {
+      findEventTypesForBulkAvailabilityPreview: vi.fn().mockResolvedValue([
+        {
+          id: 10,
+          title: "Intro",
+          length: 30,
+          userId: 1,
+          teamId: null,
+          schedulingType: null,
+          beforeEventBuffer: 0,
+          afterEventBuffer: 0,
+          slotInterval: 30,
+          timeZone: "America/New_York",
+          periodType: "UNLIMITED",
+          minimumBookingNotice: 0,
+          hideOrganizerEmail: true,
+          hideCalendarEventDetails: true,
+          schedule: {
+            id: 1,
+            timeZone: "America/New_York",
+            availability: [{ days: [1], startTime: makeDate(14), endTime: makeDate(16), date: null }],
+          },
+          availability: [],
+          users: [
+            {
+              id: 1,
+              email: "host@example.com",
+              name: "Host",
+              username: "host",
+              timeZone: "America/New_York",
+              defaultScheduleId: 1,
+              schedules: [
+                {
+                  id: 1,
+                  timeZone: "America/New_York",
+                  availability: [{ days: [1], startTime: makeDate(14), endTime: makeDate(16), date: null }],
+                },
+              ],
+            },
+          ],
+          hosts: [],
+        },
+      ]),
+      findBlockingBookingsForBulkAvailabilityPreview: vi.fn().mockResolvedValue([
+        {
+          id: 99,
+          uid: "booking-99",
+          title: "Investor call",
+          startTime: makeDate(14, 30),
+          endTime: makeDate(15),
+          userId: 1,
+          user: { id: 1, email: "host@example.com", name: "Host" },
+          attendees: [{ email: "investor@example.com" }],
+          eventType: { id: 10, beforeEventBuffer: 0, afterEventBuffer: 0, hideOrganizerEmail: true, hideCalendarEventDetails: true },
+        },
+      ]),
+    };
+
+    const service = new BulkAvailabilityPreviewService_2024_09_04(repository as never);
+
+    const result = await service.getBulkAvailabilityPreview({
+      eventTypes: [{ eventTypeId: 10 }],
+      start: "2026-01-12T00:00:00.000Z",
+      end: "2026-01-13T00:00:00.000Z",
+      timeZone: "America/New_York",
+      includeBusyDetails: true,
+    });
+
+    expect(result.data[0].busyDetails?.[0].title).toBe("Investor call");
+    expect(result.data[0].busyDetails?.[0].organizerEmail).toBe("host@example.com");
+    expect(result.data[0].busyDetails?.[0].attendeeEmails).toEqual(["investor@example.com"]);
+  });
+});
```

## Intended Flaws

### Flaw 1: Bulk Preview Reimplements Availability And Bypasses The Domain Calculator

- `type`: `invariant_drift`
- `location`: `apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.ts:56-90`, `apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.ts:119-186`, `apps/api/v2/src/modules/slots/slots-2024-09-04/slots.repository.ts:84-170`, `apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.spec.ts:1-182`
- `learner_prompt`: Does the new bulk endpoint preserve the same availability contract as the existing slots endpoint?

Expected answer:

- `identify`: The new service builds slots directly from raw event type/user schedules and subtracts only a simplified booking query. It does not call `AvailableSlotsService.getAvailableSlots`, `UserAvailabilityService`, or the existing v2 input/output path. That bypasses date-range construction, travel schedules, holidays, out-of-office days, connected-calendar busy times, restriction schedules, selected-slot reservations, pending confirmation blockers, team host qualification, round-robin/collective aggregation, seats, period limits, current seats, reschedule semantics, and minimum booking notice behavior.
- `impact`: The endpoint will show slots that the normal booking flow later rejects, especially for teams, travel schedules, DST edges, holds/reservations, pending confirmation events, external calendar conflicts, and booking limits. Product pages become untrustworthy: users see "available" times, click one, then fail at booking. Worse, the bulk endpoint becomes a second availability engine that drifts every time the real slots service evolves.
- `fix_direction`: Make bulk preview a batching/orchestration layer over the existing slots contract. Transform each requested event type into the same internal slots query and call `AvailableSlotsService` through the v2 slots service/output path, with bounded concurrency, shared prefetch only behind existing service boundaries, and tests comparing bulk results to single-event slots results for the same inputs.

Hints:

1. Compare the new service to the path used by the existing v2 slots endpoint.
2. Ask whether "schedule availability minus accepted bookings" is the full Cal.com availability contract.
3. The dangerous code is the loop that creates slots from `schedule.availability` instead of delegating to `AvailableSlotsService`.

### Flaw 2: Debug Busy Details Leak Private Booking Data

- `type`: `tenant_boundary_leak`
- `location`: `apps/api/v2/src/modules/slots/slots-2024-09-04/outputs/bulk-availability-preview.output.ts:17-51`, `apps/api/v2/src/modules/slots/slots-2024-09-04/slots.repository.ts:171-222`, `apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.ts:188-230`, `apps/api/v2/src/modules/slots/slots-2024-09-04/services/bulk-availability-preview.service.spec.ts:139-181`
- `learner_prompt`: Is the `includeBusyDetails` response safe for a public availability preview API?

Expected answer:

- `identify`: The public response exposes blocking booking titles, organizer emails, attendee emails, and internal source strings. The repository selects that data for every blocking booking, and the service returns it even when the event type has `hideOrganizerEmail` and `hideCalendarEventDetails` enabled. The test locks in the leak by asserting the private title and emails are returned.
- `impact`: Anyone who can preview availability for an event type can infer private meetings, customer emails, investor calls, personal appointments, and internal booking ids. For team events, attendee-email matching can expose data about hosts or invitees outside the caller's relationship. The normal slots API intentionally returns available times, not why a human was busy.
- `fix_direction`: Remove raw busy details from the public contract. If debugging is needed, return only coarse blocked intervals or counts, behind authenticated owner/admin tooling. Respect `hideOrganizerEmail`, `hideCalendarEventDetails`, and the same permission model as booking reads. Do not select titles or attendee emails for unauthenticated/public slot preview.

Hints:

1. Look at the response model before looking at the service.
2. Check whether privacy flags on the event type affect the returned busy details.
3. A slot preview can say "blocked" without saying "Investor call with investor@example.com."

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that the endpoint bypasses the established availability service and reimplements the domain logic. Answers that only mention "timezone bug" or "missing tests" are incomplete unless they connect the issue to the broader availability contract.

For flaw 2, a correct answer must identify the private booking-data leak in the busy-details response. Answers that only say "debug mode is risky" are incomplete unless they name the leaked fields and explain why a public availability API should not expose them.

### Product-Level Change

The PR tries to make partner experiences faster by letting them preview several event types with one request. That is a reasonable product goal. The review question is whether "bulk" changes orchestration only, or whether it accidentally creates a second source of truth for one of the most important product invariants: when is a slot actually bookable?

### Changed Contracts

- API contract: `POST /slots/bulk-preview` returns availability for several event types.
- Availability contract: the PR implicitly defines availability as schedule windows minus accepted bookings.
- Privacy contract: callers can request `includeBusyDetails` and receive human booking metadata.
- Service boundary contract: the v2 slots module now owns availability calculation logic that previously lived behind shared availability services.
- Test contract: tests assert the simplified behavior and the privacy leak, so future maintainers may treat both as intended.

### Failure Modes

A host is traveling next week, has an out-of-office day, and has a connected calendar event blocking the morning. The normal slots endpoint would remove those times. The bulk endpoint reads the weekly schedule and returns them as available. The attendee chooses one, then booking fails later.

A founder sets `hideCalendarEventDetails` because their calendar contains sensitive meetings. A partner calls bulk preview with `includeBusyDetails=true` and receives `Investor call`, the organizer email, and the attendee email. The endpoint turns availability into a private calendar metadata leak.

### Reviewer Thought Process

A strong reviewer first asks: "Is this PR changing the product contract or only the transport shape?" Bulk reads should usually compose the single-read path. When a PR adds a shortcut for performance, inspect whether it bypasses the service that owns the hard invariants.

The second move is to inspect the response model. Availability APIs are often public or semi-public, so any "debug" or "explain" field deserves suspicion. A reviewer should ask what the least revealing useful answer is. In this case, a blocked interval is enough; a meeting title and attendee email are not.

### Better Implementation Direction

Keep one availability engine:

- Convert each bulk item into the same internal query used by `SlotsService_2024_09_04.getAvailableSlots`.
- Call the existing available-slots path with bounded concurrency.
- Add parity tests: bulk result for one event type must match the single-event slots endpoint for the same input.
- Only optimize shared reads after the invariants are preserved.
- Return public-safe blocked intervals or omit busy explanations entirely.
- Put detailed debug reasons behind authenticated owner/admin tooling with explicit redaction.

## Why This Case Exists

This is an early exercise because the lesson is foundational: do not fork domain logic just because the new API shape is slightly different. The same habit applies everywhere. If a PR adds a faster batch endpoint, a reviewer should immediately look for reused contracts, not just working tests.
