# TS-039: Cal.com Booking Reschedule API

## Metadata

- `id`: TS-039
- `source_repo`: [calcom/cal.com](https://github.com/calcom/cal.com)
- `repo_area`: booking reschedule API, booking state transitions, calendar references, notification side effects, Prisma transactions, platform API v2, booking repository tests
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,400-1,700
- `represented_diff_lines`: 1408
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Cal.com booking state, reschedule semantics, calendar holds, external calendar updates, notification side effects, transactional outbox patterns, and API v2 controller design without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a public API v2 endpoint for rescheduling a booking.

Cal.com already supports rescheduling through the booking page, but platform customers want a direct API endpoint so their own apps can move bookings without redirecting users. This change adds `POST /v2/bookings/:uid/reschedule`, validates the new time, creates a booking at the requested slot, sends reschedule notifications, stores a small audit record, and returns both the original booking uid and the new booking uid.

The PR adds:

- request and response schemas for the reschedule endpoint,
- a Nest controller and module,
- a repository for loading original booking data and creating the replacement booking,
- notification helpers for organizer/booker messages,
- tests for owner reschedule, booker reschedule, unavailable slot, notification payload, and transaction failure,
- API documentation.

The intended product behavior is: API callers can reschedule an existing booking while preserving the single booking lifecycle, calendar references, audit trail, and user notifications that Cal.com already relies on.

## Existing Code Context

The real Cal.com codebase already has these relevant contracts:

- `packages/features/bookings/lib/handleNewBooking/createBooking.ts` treats a reschedule as linked booking state: the new booking gets `fromReschedule = originalRescheduledBooking.uid`, and the original booking update sets `rescheduled: true`, `status: CANCELLED`, and `rescheduledBy`.
- `packages/features/bookings/lib/service/RegularBookingService.ts` has a reschedule branch that calls `EventManager.reschedule(...)` for non-seat bookings, preserving calendar/video references and updating external calendar events instead of blindly creating a second independent hold.
- The same service passes `originalRescheduledBooking` into email/SMS handling and webhook payloads so rescheduled notifications can include old start/end times and avoid looking like unrelated new bookings.
- `RegularBookingService.fireBookingEvents(...)` calls `bookingEventHandler.onBookingRescheduled(...)` when `originalRescheduledBooking` exists, instead of emitting a plain booking-created event.
- `packages/features/bookings/lib/BookingEmailSmsHandler.ts` has a `BookingActionMap.rescheduled` branch that sends rescheduled emails/SMS and round-robin reassignment/cancellation messages.
- `packages/features/bookings/repositories/BookingRepository.ts` has helpers such as `findRescheduledToBooking`, `findPreviousBooking`, and `updateBookingStatus`, showing that reschedule links and original booking state are part of the domain model.
- Slots and booking-limit paths accept `rescheduleUid` so the original time can be handled differently during availability checks.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether this endpoint preserves booking lifecycle semantics and safe side-effect ordering.

## Review Surface

Changed files in the synthetic PR:

- `apps/api/v2/src/modules/bookings/reschedule/inputs.ts`
- `apps/api/v2/src/modules/bookings/reschedule/controller.ts`
- `apps/api/v2/src/modules/bookings/reschedule/repository.ts`
- `apps/api/v2/src/modules/bookings/reschedule/notifications.ts`
- `apps/api/v2/src/modules/bookings/reschedule/service.ts`
- `apps/api/v2/src/modules/bookings/reschedule/module.ts`
- `apps/api/v2/src/modules/bookings/reschedule/service.spec.ts`
- `apps/api/v2/src/modules/bookings/reschedule/repository.spec.ts`
- `docs/api/bookings-reschedule.md`

The line references below use synthetic PR line numbers. The represented diff is focused on booking state transitions, calendar reference lifecycle, notification timing, transaction boundaries, and tests that lock in the wrong behavior.

## Diff

```diff
diff --git a/apps/api/v2/src/modules/bookings/reschedule/inputs.ts b/apps/api/v2/src/modules/bookings/reschedule/inputs.ts
new file mode 100644
index 000000000..b11a79db5
--- /dev/null
+++ b/apps/api/v2/src/modules/bookings/reschedule/inputs.ts
@@ -0,0 +1,126 @@
+import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
+import { z } from "zod";
+
+export const rescheduleActorSchema = z.enum(["organizer", "booker", "admin", "platform"]);
+
+export const rescheduleBookingBodySchema = z.object({
+  start: z.string().datetime(),
+  end: z.string().datetime(),
+  timeZone: z.string().min(1),
+  reason: z.string().max(1000).optional(),
+  rescheduledBy: z.string().email().optional(),
+  actor: rescheduleActorSchema.default("platform"),
+  notifyOrganizer: z.boolean().default(true),
+  notifyBooker: z.boolean().default(true),
+  notifyGuests: z.boolean().default(true),
+  metadata: z.record(z.unknown()).optional(),
+  preserveAttendees: z.boolean().default(true),
+  preserveLocation: z.boolean().default(true),
+  preserveResponses: z.boolean().default(true),
+});
+
+export type RescheduleBookingBody = z.infer<typeof rescheduleBookingBodySchema>;
+
+export class RescheduleBookingBodyDto {
+  @ApiProperty({
+    description: "New booking start time as an ISO datetime.",
+    example: "2026-06-01T14:00:00.000Z",
+  })
+  start!: string;
+
+  @ApiProperty({
+    description: "New booking end time as an ISO datetime.",
+    example: "2026-06-01T14:30:00.000Z",
+  })
+  end!: string;
+
+  @ApiProperty({
+    description: "Booker timezone used for notification rendering.",
+    example: "America/New_York",
+  })
+  timeZone!: string;
+
+  @ApiPropertyOptional({
+    description: "Human-readable reason shown in reschedule notifications.",
+  })
+  reason?: string;
+
+  @ApiPropertyOptional({
+    description: "Email address of the actor that requested the reschedule.",
+  })
+  rescheduledBy?: string;
+
+  @ApiPropertyOptional({
+    enum: ["organizer", "booker", "admin", "platform"],
+    default: "platform",
+  })
+  actor?: "organizer" | "booker" | "admin" | "platform";
+
+  @ApiPropertyOptional({
+    description: "Whether the organizer should receive a notification.",
+    default: true,
+  })
+  notifyOrganizer?: boolean;
+
+  @ApiPropertyOptional({
+    description: "Whether the booker should receive a notification.",
+    default: true,
+  })
+  notifyBooker?: boolean;
+
+  @ApiPropertyOptional({
+    description: "Whether additional guests should receive a notification.",
+    default: true,
+  })
+  notifyGuests?: boolean;
+
+  @ApiPropertyOptional({
+    description: "Additional opaque metadata stored with the new booking.",
+  })
+  metadata?: Record<string, unknown>;
+
+  @ApiPropertyOptional({
+    description: "Copy attendees from the original booking.",
+    default: true,
+  })
+  preserveAttendees?: boolean;
+
+  @ApiPropertyOptional({
+    description: "Copy location from the original booking.",
+    default: true,
+  })
+  preserveLocation?: boolean;
+
+  @ApiPropertyOptional({
+    description: "Copy booking field responses from the original booking.",
+    default: true,
+  })
+  preserveResponses?: boolean;
+}
+
+export const rescheduleBookingParamsSchema = z.object({
+  uid: z.string().min(1),
+});
+
+export type RescheduleBookingParams = z.infer<typeof rescheduleBookingParamsSchema>;
+
+export type RescheduleBookingResponse = {
+  data: {
+    originalBookingUid: string;
+    newBookingUid: string;
+    status: "rescheduled";
+    notifications: {
+      organizer: boolean;
+      booker: boolean;
+      guests: boolean;
+    };
+  };
+};
+
+export function parseRescheduleBody(body: unknown): RescheduleBookingBody {
+  return rescheduleBookingBodySchema.parse(body);
+}
+
+export function parseRescheduleParams(params: unknown): RescheduleBookingParams {
+  return rescheduleBookingParamsSchema.parse(params);
+}
diff --git a/apps/api/v2/src/modules/bookings/reschedule/controller.ts b/apps/api/v2/src/modules/bookings/reschedule/controller.ts
new file mode 100644
index 000000000..77e8cf84b
--- /dev/null
+++ b/apps/api/v2/src/modules/bookings/reschedule/controller.ts
@@ -0,0 +1,87 @@
+import { Body, Controller, Param, Post, Req } from "@nestjs/common";
+import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
+import type { Request } from "express";
+import {
+  RescheduleBookingBodyDto,
+  parseRescheduleBody,
+  parseRescheduleParams,
+  type RescheduleBookingResponse,
+} from "./inputs";
+import { BookingRescheduleService } from "./service";
+
+@ApiTags("Bookings")
+@Controller({
+  path: "/v2/bookings",
+  version: "2",
+})
+export class BookingRescheduleController {
+  constructor(private readonly service: BookingRescheduleService) {}
+
+  @Post("/:uid/reschedule")
+  @ApiOperation({
+    summary: "Reschedule a booking",
+    description:
+      "Moves an existing booking to a new time and sends reschedule notifications to the organizer and attendees.",
+  })
+  @ApiParam({
+    name: "uid",
+    description: "The uid of the booking to reschedule.",
+  })
+  @ApiBody({
+    type: RescheduleBookingBodyDto,
+  })
+  @ApiResponse({
+    status: 200,
+    description: "The booking was rescheduled.",
+  })
+  async reschedule(
+    @Param() rawParams: Record<string, string>,
+    @Body() rawBody: unknown,
+    @Req() request: Request
+  ): Promise<RescheduleBookingResponse> {
+    const params = parseRescheduleParams(rawParams);
+    const body = parseRescheduleBody(rawBody);
+    const actorEmail = request.headers["x-cal-actor-email"];
+    const platformClientId = request.headers["x-cal-platform-client-id"];
+
+    const result = await this.service.rescheduleBooking({
+      uid: params.uid,
+      body,
+      requestMeta: {
+        actorEmail: typeof actorEmail === "string" ? actorEmail : undefined,
+        platformClientId: typeof platformClientId === "string" ? platformClientId : undefined,
+        requestId:
+          typeof request.headers["x-request-id"] === "string"
+            ? request.headers["x-request-id"]
+            : undefined,
+      },
+    });
+
+    return {
+      data: {
+        originalBookingUid: result.originalBooking.uid,
+        newBookingUid: result.newBooking.uid,
+        status: "rescheduled",
+        notifications: result.notifications,
+      },
+    };
+  }
+}
+
+export type BookingRescheduleRequestMeta = {
+  actorEmail?: string;
+  platformClientId?: string;
+  requestId?: string;
+};
+
+export function buildRequestMeta(request: Request): BookingRescheduleRequestMeta {
+  const actorEmail = request.headers["x-cal-actor-email"];
+  const platformClientId = request.headers["x-cal-platform-client-id"];
+  const requestId = request.headers["x-request-id"];
+
+  return {
+    actorEmail: typeof actorEmail === "string" ? actorEmail : undefined,
+    platformClientId: typeof platformClientId === "string" ? platformClientId : undefined,
+    requestId: typeof requestId === "string" ? requestId : undefined,
+  };
+}
diff --git a/apps/api/v2/src/modules/bookings/reschedule/repository.ts b/apps/api/v2/src/modules/bookings/reschedule/repository.ts
new file mode 100644
index 000000000..51f4f68b8
--- /dev/null
+++ b/apps/api/v2/src/modules/bookings/reschedule/repository.ts
@@ -0,0 +1,247 @@
+import { Injectable } from "@nestjs/common";
+import { PrismaWriteService } from "@/modules/prisma/prisma-write.service";
+import { BookingStatus } from "@calcom/prisma/enums";
+import type { Prisma } from "@calcom/prisma/client";
+import { randomString } from "@calcom/lib/random";
+
+export type OriginalBookingForReschedule = NonNullable<
+  Awaited<ReturnType<BookingRescheduleRepository["findOriginalBooking"]>>
+>;
+
+export type ReplacementBookingData = {
+  startTime: Date;
+  endTime: Date;
+  timeZone: string;
+  reason?: string;
+  metadata?: Record<string, unknown>;
+  actorEmail?: string;
+  preserveAttendees: boolean;
+  preserveLocation: boolean;
+  preserveResponses: boolean;
+};
+
+@Injectable()
+export class BookingRescheduleRepository {
+  constructor(private readonly prismaWriteService: PrismaWriteService) {}
+
+  get prisma() {
+    return this.prismaWriteService.prisma;
+  }
+
+  async findOriginalBooking(uid: string) {
+    return this.prisma.booking.findUnique({
+      where: { uid },
+      select: {
+        id: true,
+        uid: true,
+        title: true,
+        description: true,
+        startTime: true,
+        endTime: true,
+        status: true,
+        userId: true,
+        userPrimaryEmail: true,
+        eventTypeId: true,
+        location: true,
+        customInputs: true,
+        responses: true,
+        metadata: true,
+        iCalUID: true,
+        iCalSequence: true,
+        smsReminderNumber: true,
+        paid: true,
+        rescheduled: true,
+        rescheduledBy: true,
+        fromReschedule: true,
+        attendees: {
+          select: {
+            name: true,
+            email: true,
+            timeZone: true,
+            locale: true,
+            phoneNumber: true,
+          },
+        },
+        references: {
+          select: {
+            id: true,
+            type: true,
+            uid: true,
+            meetingId: true,
+            meetingPassword: true,
+            meetingUrl: true,
+            credentialId: true,
+            externalCalendarId: true,
+            deleted: true,
+          },
+        },
+        user: {
+          select: {
+            id: true,
+            email: true,
+            name: true,
+            username: true,
+            timeZone: true,
+            locale: true,
+          },
+        },
+        eventType: {
+          select: {
+            id: true,
+            slug: true,
+            title: true,
+            length: true,
+            schedulingType: true,
+            metadata: true,
+            seatsPerTimeSlot: true,
+            destinationCalendar: true,
+          },
+        },
+      },
+    });
+  }
+
+  async findConflictingAcceptedBooking(args: {
+    eventTypeId: number | null;
+    startTime: Date;
+    endTime: Date;
+    ignoredUid: string;
+  }) {
+    return this.prisma.booking.findFirst({
+      where: {
+        uid: { not: args.ignoredUid },
+        eventTypeId: args.eventTypeId,
+        status: BookingStatus.ACCEPTED,
+        startTime: { lt: args.endTime },
+        endTime: { gt: args.startTime },
+      },
+      select: {
+        uid: true,
+        startTime: true,
+        endTime: true,
+      },
+    });
+  }
+
+  buildReplacementBookingCreateInput(
+    original: OriginalBookingForReschedule,
+    data: ReplacementBookingData
+  ): Prisma.BookingCreateInput {
+    const uid = `resch_${randomString(16)}`;
+    const attendees =
+      data.preserveAttendees && original.attendees.length > 0
+        ? {
+            createMany: {
+              data: original.attendees.map((attendee) => ({
+                name: attendee.name,
+                email: attendee.email,
+                timeZone: attendee.timeZone,
+                locale: attendee.locale,
+                phoneNumber: attendee.phoneNumber,
+              })),
+            },
+          }
+        : undefined;
+
+    const references =
+      original.references.length > 0
+        ? {
+            createMany: {
+              data: original.references.map((reference) => ({
+                type: reference.type,
+                uid: reference.uid,
+                meetingId: reference.meetingId,
+                meetingPassword: reference.meetingPassword,
+                meetingUrl: reference.meetingUrl,
+                credentialId: reference.credentialId,
+                externalCalendarId: reference.externalCalendarId,
+                deleted: false,
+              })),
+            },
+          }
+        : undefined;
+
+    return {
+      uid,
+      title: original.title,
+      description: original.description,
+      startTime: data.startTime,
+      endTime: data.endTime,
+      status: BookingStatus.ACCEPTED,
+      user: original.userId ? { connect: { id: original.userId } } : undefined,
+      eventType: original.eventTypeId ? { connect: { id: original.eventTypeId } } : undefined,
+      location: data.preserveLocation ? original.location : null,
+      customInputs: original.customInputs ?? undefined,
+      responses: data.preserveResponses ? original.responses ?? undefined : undefined,
+      metadata: {
+        ...(typeof original.metadata === "object" && original.metadata ? original.metadata : {}),
+        ...(data.metadata ?? {}),
+        apiReschedule: {
+          originalBookingUid: original.uid,
+          reason: data.reason,
+          actorEmail: data.actorEmail,
+        },
+      },
+      paid: original.paid,
+      smsReminderNumber: original.smsReminderNumber,
+      iCalUID: original.iCalUID,
+      iCalSequence: original.iCalSequence,
+      fromReschedule: null,
+      rescheduled: false,
+      rescheduledBy: null,
+      attendees,
+      references,
+    };
+  }
+
+  async createReplacementBooking(original: OriginalBookingForReschedule, data: ReplacementBookingData) {
+    return this.prisma.booking.create({
+      data: this.buildReplacementBookingCreateInput(original, data),
+      select: {
+        id: true,
+        uid: true,
+        startTime: true,
+        endTime: true,
+        status: true,
+        fromReschedule: true,
+        rescheduled: true,
+        rescheduledBy: true,
+      },
+    });
+  }
+
+  async appendRescheduleAudit(args: {
+    originalBookingId: number;
+    originalBookingUid: string;
+    newBookingUid: string;
+    actorEmail?: string;
+    reason?: string;
+    requestId?: string;
+  }) {
+    return this.prisma.booking.update({
+      where: { id: args.originalBookingId },
+      data: {
+        metadata: {
+          apiRescheduleAudit: {
+            newBookingUid: args.newBookingUid,
+            actorEmail: args.actorEmail,
+            reason: args.reason,
+            requestId: args.requestId,
+            recordedAt: new Date().toISOString(),
+          },
+        },
+      },
+      select: {
+        uid: true,
+        status: true,
+        rescheduled: true,
+        rescheduledBy: true,
+        fromReschedule: true,
+      },
+    });
+  }
+
+  async withTransaction<T>(callback: (tx: typeof this.prisma) => Promise<T>): Promise<T> {
+    return this.prisma.$transaction(async (tx) => callback(tx as typeof this.prisma));
+  }
+}
diff --git a/apps/api/v2/src/modules/bookings/reschedule/notifications.ts b/apps/api/v2/src/modules/bookings/reschedule/notifications.ts
new file mode 100644
index 000000000..7c1e3a613
--- /dev/null
+++ b/apps/api/v2/src/modules/bookings/reschedule/notifications.ts
@@ -0,0 +1,114 @@
+import { Injectable } from "@nestjs/common";
+import { BookingEmailSmsService } from "@/lib/services/booking-emails-sms-service";
+import { BookingActionMap } from "@calcom/platform-libraries/bookings";
+import type { OriginalBookingForReschedule } from "./repository";
+import type { RescheduleBookingBody } from "./inputs";
+
+export type RescheduleNotificationResult = {
+  organizer: boolean;
+  booker: boolean;
+  guests: boolean;
+};
+
+export type SendRescheduleNotificationArgs = {
+  originalBooking: OriginalBookingForReschedule;
+  newStart: Date;
+  newEnd: Date;
+  body: RescheduleBookingBody;
+  newBookingUid?: string;
+};
+
+@Injectable()
+export class BookingRescheduleNotificationService {
+  constructor(private readonly emailSmsService: BookingEmailSmsService) {}
+
+  async sendPendingRescheduleNotifications(
+    args: SendRescheduleNotificationArgs
+  ): Promise<RescheduleNotificationResult> {
+    const attendees = args.originalBooking.attendees.map((attendee) => ({
+      name: attendee.name,
+      email: attendee.email,
+      timeZone: attendee.timeZone,
+      language: {
+        translate: (key: string) => key,
+        locale: attendee.locale ?? "en",
+      },
+      phoneNumber: attendee.phoneNumber ?? undefined,
+    }));
+
+    const organizer = args.originalBooking.user
+      ? {
+          id: args.originalBooking.user.id,
+          name: args.originalBooking.user.name ?? "",
+          email: args.originalBooking.user.email,
+          username: args.originalBooking.user.username ?? undefined,
+          timeZone: args.originalBooking.user.timeZone,
+          language: {
+            translate: (key: string) => key,
+            locale: args.originalBooking.user.locale ?? "en",
+          },
+        }
+      : undefined;
+
+    const evt = {
+      type: args.originalBooking.eventType?.slug ?? "rescheduled-booking",
+      title: args.originalBooking.title,
+      startTime: args.newStart.toISOString(),
+      endTime: args.newEnd.toISOString(),
+      organizer,
+      attendees,
+      uid: args.newBookingUid ?? args.originalBooking.uid,
+      iCalUID: args.originalBooking.iCalUID,
+      iCalSequence: args.originalBooking.iCalSequence,
+      location: args.body.preserveLocation ? args.originalBooking.location : undefined,
+      responses: args.body.preserveResponses ? args.originalBooking.responses : undefined,
+      rescheduledBy: args.body.rescheduledBy,
+    };
+
+    await this.emailSmsService.send({
+      action: BookingActionMap.rescheduled,
+      data: {
+        evt,
+        eventType: {
+          metadata: args.originalBooking.eventType?.metadata ?? undefined,
+          schedulingType: args.originalBooking.eventType?.schedulingType ?? null,
+        },
+        additionalInformation: {},
+        additionalNotes: null,
+        iCalUID: args.originalBooking.iCalUID ?? "",
+        originalRescheduledBooking: args.originalBooking,
+        rescheduleReason: args.body.reason,
+        isRescheduledByBooker:
+          !!args.body.rescheduledBy &&
+          args.originalBooking.attendees.some((attendee) => attendee.email === args.body.rescheduledBy),
+        users: args.originalBooking.user
+          ? [
+              {
+                name: args.originalBooking.user.name,
+                email: args.originalBooking.user.email,
+              },
+            ]
+          : [],
+        changedOrganizer: false,
+      },
+    });
+
+    return {
+      organizer: args.body.notifyOrganizer ?? true,
+      booker: args.body.notifyBooker ?? true,
+      guests: args.body.notifyGuests ?? true,
+    };
+  }
+}
+
+export function shouldNotify(body: RescheduleBookingBody) {
+  return Boolean(body.notifyOrganizer || body.notifyBooker || body.notifyGuests);
+}
+
+export function summarizeNotificationRecipients(original: OriginalBookingForReschedule) {
+  return {
+    organizer: original.user?.email ?? null,
+    attendees: original.attendees.map((attendee) => attendee.email),
+    guestCount: Math.max(0, original.attendees.length - 1),
+  };
+}
diff --git a/apps/api/v2/src/modules/bookings/reschedule/service.ts b/apps/api/v2/src/modules/bookings/reschedule/service.ts
new file mode 100644
index 000000000..30bcf093a
--- /dev/null
+++ b/apps/api/v2/src/modules/bookings/reschedule/service.ts
@@ -0,0 +1,174 @@
+import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
+import { BookingStatus } from "@calcom/prisma/enums";
+import {
+  BookingRescheduleRepository,
+  type OriginalBookingForReschedule,
+} from "./repository";
+import {
+  BookingRescheduleNotificationService,
+  shouldNotify,
+  type RescheduleNotificationResult,
+} from "./notifications";
+import type { BookingRescheduleRequestMeta } from "./controller";
+import type { RescheduleBookingBody } from "./inputs";
+
+export type RescheduleBookingCommand = {
+  uid: string;
+  body: RescheduleBookingBody;
+  requestMeta: BookingRescheduleRequestMeta;
+};
+
+export type RescheduleBookingResult = {
+  originalBooking: OriginalBookingForReschedule;
+  newBooking: {
+    id: number;
+    uid: string;
+    startTime: Date;
+    endTime: Date;
+    status: BookingStatus;
+    fromReschedule: string | null;
+    rescheduled: boolean;
+    rescheduledBy: string | null;
+  };
+  notifications: RescheduleNotificationResult;
+};
+
+@Injectable()
+export class BookingRescheduleService {
+  constructor(
+    private readonly repository: BookingRescheduleRepository,
+    private readonly notifications: BookingRescheduleNotificationService
+  ) {}
+
+  async rescheduleBooking(command: RescheduleBookingCommand): Promise<RescheduleBookingResult> {
+    const originalBooking = await this.repository.findOriginalBooking(command.uid);
+    if (!originalBooking) {
+      throw new NotFoundException("Booking not found");
+    }
+
+    this.assertCanReschedule(originalBooking);
+
+    const startTime = new Date(command.body.start);
+    const endTime = new Date(command.body.end);
+    this.assertTimeRange(startTime, endTime);
+
+    const conflict = await this.repository.findConflictingAcceptedBooking({
+      eventTypeId: originalBooking.eventTypeId,
+      startTime,
+      endTime,
+      ignoredUid: originalBooking.uid,
+    });
+
+    if (conflict) {
+      throw new ConflictException("Requested slot is no longer available");
+    }
+
+    const notifications = shouldNotify(command.body)
+      ? await this.notifications.sendPendingRescheduleNotifications({
+          originalBooking,
+          newStart: startTime,
+          newEnd: endTime,
+          body: command.body,
+        })
+      : {
+          organizer: false,
+          booker: false,
+          guests: false,
+        };
+
+    const newBooking = await this.repository.withTransaction(async () => {
+      const created = await this.repository.createReplacementBooking(originalBooking, {
+        startTime,
+        endTime,
+        timeZone: command.body.timeZone,
+        reason: command.body.reason,
+        metadata: command.body.metadata,
+        actorEmail: command.body.rescheduledBy ?? command.requestMeta.actorEmail,
+        preserveAttendees: command.body.preserveAttendees,
+        preserveLocation: command.body.preserveLocation,
+        preserveResponses: command.body.preserveResponses,
+      });
+
+      await this.repository.appendRescheduleAudit({
+        originalBookingId: originalBooking.id,
+        originalBookingUid: originalBooking.uid,
+        newBookingUid: created.uid,
+        actorEmail: command.body.rescheduledBy ?? command.requestMeta.actorEmail,
+        reason: command.body.reason,
+        requestId: command.requestMeta.requestId,
+      });
+
+      return created;
+    });
+
+    return {
+      originalBooking,
+      newBooking,
+      notifications,
+    };
+  }
+
+  private assertCanReschedule(originalBooking: OriginalBookingForReschedule) {
+    if (originalBooking.status === BookingStatus.CANCELLED) {
+      throw new BadRequestException("Cancelled bookings cannot be rescheduled");
+    }
+
+    if (originalBooking.rescheduled) {
+      throw new BadRequestException("Booking was already rescheduled");
+    }
+
+    if (!originalBooking.eventTypeId) {
+      throw new BadRequestException("Booking is not attached to an event type");
+    }
+  }
+
+  private assertTimeRange(startTime: Date, endTime: Date) {
+    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
+      throw new BadRequestException("Invalid start or end time");
+    }
+
+    if (endTime <= startTime) {
+      throw new BadRequestException("End time must be after start time");
+    }
+  }
+}
+
+export function buildRescheduleResponseSummary(result: RescheduleBookingResult) {
+  return {
+    originalBookingUid: result.originalBooking.uid,
+    newBookingUid: result.newBooking.uid,
+    originalStatus: result.originalBooking.status,
+    newStatus: result.newBooking.status,
+    fromReschedule: result.newBooking.fromReschedule,
+    originalMarkedRescheduled: result.originalBooking.rescheduled,
+    notifications: result.notifications,
+  };
+}
+
+export function assertReschedulePreservesDuration(args: {
+  originalStart: Date;
+  originalEnd: Date;
+  newStart: Date;
+  newEnd: Date;
+}) {
+  const originalDuration = args.originalEnd.getTime() - args.originalStart.getTime();
+  const newDuration = args.newEnd.getTime() - args.newStart.getTime();
+  if (originalDuration !== newDuration) {
+    throw new BadRequestException("Reschedule must preserve booking duration");
+  }
+}
+
+export function describeRescheduleAudit(args: {
+  originalBookingUid: string;
+  newBookingUid: string;
+  reason?: string;
+  actorEmail?: string;
+}) {
+  return {
+    action: "booking.rescheduled",
+    originalBookingUid: args.originalBookingUid,
+    newBookingUid: args.newBookingUid,
+    reason: args.reason ?? null,
+    actorEmail: args.actorEmail ?? null,
+  };
+}
diff --git a/apps/api/v2/src/modules/bookings/reschedule/module.ts b/apps/api/v2/src/modules/bookings/reschedule/module.ts
new file mode 100644
index 000000000..8175e4e21
--- /dev/null
+++ b/apps/api/v2/src/modules/bookings/reschedule/module.ts
@@ -0,0 +1,28 @@
+import { Module } from "@nestjs/common";
+import { BookingRescheduleController } from "./controller";
+import { BookingRescheduleRepository } from "./repository";
+import { BookingRescheduleNotificationService } from "./notifications";
+import { BookingRescheduleService } from "./service";
+import { BookingEmailSmsService } from "@/lib/services/booking-emails-sms-service";
+import { PrismaWriteService } from "@/modules/prisma/prisma-write.service";
+
+@Module({
+  controllers: [BookingRescheduleController],
+  providers: [
+    BookingRescheduleService,
+    BookingRescheduleRepository,
+    BookingRescheduleNotificationService,
+    BookingEmailSmsService,
+    PrismaWriteService,
+  ],
+  exports: [BookingRescheduleService],
+})
+export class BookingRescheduleModule {}
+
+export const bookingRescheduleProviders = [
+  BookingRescheduleService,
+  BookingRescheduleRepository,
+  BookingRescheduleNotificationService,
+  BookingEmailSmsService,
+  PrismaWriteService,
+];
diff --git a/apps/api/v2/src/modules/bookings/reschedule/service.spec.ts b/apps/api/v2/src/modules/bookings/reschedule/service.spec.ts
new file mode 100644
index 000000000..2cc135cc0
--- /dev/null
+++ b/apps/api/v2/src/modules/bookings/reschedule/service.spec.ts
@@ -0,0 +1,228 @@
+import { beforeEach, describe, expect, it, vi } from "vitest";
+import { BookingStatus } from "@calcom/prisma/enums";
+import { BookingRescheduleService } from "./service";
+import type { BookingRescheduleRepository, OriginalBookingForReschedule } from "./repository";
+import type { BookingRescheduleNotificationService } from "./notifications";
+import type { RescheduleBookingBody } from "./inputs";
+
+const originalBooking = {
+  id: 1,
+  uid: "book_old",
+  title: "Demo call",
+  description: "Original description",
+  startTime: new Date("2026-06-01T10:00:00.000Z"),
+  endTime: new Date("2026-06-01T10:30:00.000Z"),
+  status: BookingStatus.ACCEPTED,
+  userId: 10,
+  userPrimaryEmail: "host@example.com",
+  eventTypeId: 100,
+  location: "https://meet.example.com/old",
+  customInputs: null,
+  responses: { name: "Booker" },
+  metadata: { source: "test" },
+  iCalUID: "ical_old",
+  iCalSequence: 1,
+  smsReminderNumber: null,
+  paid: false,
+  rescheduled: false,
+  rescheduledBy: null,
+  fromReschedule: null,
+  attendees: [
+    {
+      name: "Booker",
+      email: "booker@example.com",
+      timeZone: "America/New_York",
+      locale: "en",
+      phoneNumber: null,
+    },
+  ],
+  references: [
+    {
+      id: 11,
+      type: "google_calendar",
+      uid: "gcal_event_old",
+      meetingId: null,
+      meetingPassword: null,
+      meetingUrl: null,
+      credentialId: 55,
+      externalCalendarId: "primary",
+      deleted: false,
+    },
+  ],
+  user: {
+    id: 10,
+    email: "host@example.com",
+    name: "Host",
+    username: "host",
+    timeZone: "America/Los_Angeles",
+    locale: "en",
+  },
+  eventType: {
+    id: 100,
+    slug: "demo",
+    title: "Demo",
+    length: 30,
+    schedulingType: null,
+    metadata: {},
+    seatsPerTimeSlot: null,
+    destinationCalendar: null,
+  },
+} satisfies OriginalBookingForReschedule;
+
+function body(overrides: Partial<RescheduleBookingBody> = {}): RescheduleBookingBody {
+  return {
+    start: "2026-06-02T10:00:00.000Z",
+    end: "2026-06-02T10:30:00.000Z",
+    timeZone: "America/New_York",
+    reason: "Need a better time",
+    rescheduledBy: "booker@example.com",
+    actor: "booker",
+    notifyOrganizer: true,
+    notifyBooker: true,
+    notifyGuests: true,
+    preserveAttendees: true,
+    preserveLocation: true,
+    preserveResponses: true,
+    metadata: { via: "api" },
+    ...overrides,
+  };
+}
+
+describe("BookingRescheduleService", () => {
+  let repository: Pick<
+    BookingRescheduleRepository,
+    | "findOriginalBooking"
+    | "findConflictingAcceptedBooking"
+    | "createReplacementBooking"
+    | "appendRescheduleAudit"
+    | "withTransaction"
+  >;
+  let notifications: Pick<BookingRescheduleNotificationService, "sendPendingRescheduleNotifications">;
+  let service: BookingRescheduleService;
+
+  beforeEach(() => {
+    repository = {
+      findOriginalBooking: vi.fn(async () => originalBooking),
+      findConflictingAcceptedBooking: vi.fn(async () => null),
+      createReplacementBooking: vi.fn(async () => ({
+        id: 2,
+        uid: "book_new",
+        startTime: new Date("2026-06-02T10:00:00.000Z"),
+        endTime: new Date("2026-06-02T10:30:00.000Z"),
+        status: BookingStatus.ACCEPTED,
+        fromReschedule: null,
+        rescheduled: false,
+        rescheduledBy: null,
+      })),
+      appendRescheduleAudit: vi.fn(async () => ({
+        uid: "book_old",
+        status: BookingStatus.ACCEPTED,
+        rescheduled: false,
+        rescheduledBy: null,
+        fromReschedule: null,
+      })),
+      withTransaction: vi.fn(async (callback) => callback({} as never)),
+    };
+    notifications = {
+      sendPendingRescheduleNotifications: vi.fn(async () => ({
+        organizer: true,
+        booker: true,
+        guests: true,
+      })),
+    };
+    service = new BookingRescheduleService(
+      repository as BookingRescheduleRepository,
+      notifications as BookingRescheduleNotificationService
+    );
+  });
+
+  it("creates a replacement booking for the new time", async () => {
+    const result = await service.rescheduleBooking({
+      uid: "book_old",
+      body: body(),
+      requestMeta: { requestId: "req_123" },
+    });
+
+    expect(result.originalBooking.uid).toBe("book_old");
+    expect(result.newBooking.uid).toBe("book_new");
+    expect(result.newBooking.status).toBe(BookingStatus.ACCEPTED);
+    expect(result.newBooking.fromReschedule).toBeNull();
+    expect(result.originalBooking.status).toBe(BookingStatus.ACCEPTED);
+    expect(result.originalBooking.rescheduled).toBe(false);
+  });
+
+  it("sends notifications before writing the replacement booking", async () => {
+    const calls: string[] = [];
+    vi.mocked(notifications.sendPendingRescheduleNotifications).mockImplementationOnce(async () => {
+      calls.push("notify");
+      return { organizer: true, booker: true, guests: true };
+    });
+    vi.mocked(repository.createReplacementBooking).mockImplementationOnce(async () => {
+      calls.push("create");
+      return {
+        id: 2,
+        uid: "book_new",
+        startTime: new Date("2026-06-02T10:00:00.000Z"),
+        endTime: new Date("2026-06-02T10:30:00.000Z"),
+        status: BookingStatus.ACCEPTED,
+        fromReschedule: null,
+        rescheduled: false,
+        rescheduledBy: null,
+      };
+    });
+
+    await service.rescheduleBooking({
+      uid: "book_old",
+      body: body(),
+      requestMeta: { requestId: "req_123" },
+    });
+
+    expect(calls).toEqual(["notify", "create"]);
+  });
+
+  it("still sends notifications when the later transaction fails", async () => {
+    vi.mocked(repository.withTransaction).mockRejectedValueOnce(new Error("deadlock"));
+
+    await expect(
+      service.rescheduleBooking({
+        uid: "book_old",
+        body: body(),
+        requestMeta: { requestId: "req_123" },
+      })
+    ).rejects.toThrow("deadlock");
+
+    expect(notifications.sendPendingRescheduleNotifications).toHaveBeenCalledTimes(1);
+    expect(repository.createReplacementBooking).not.toHaveBeenCalled();
+  });
+
+  it("rejects a slot conflict", async () => {
+    vi.mocked(repository.findConflictingAcceptedBooking).mockResolvedValueOnce({
+      uid: "book_other",
+      startTime: new Date("2026-06-02T10:15:00.000Z"),
+      endTime: new Date("2026-06-02T10:45:00.000Z"),
+    });
+
+    await expect(
+      service.rescheduleBooking({
+        uid: "book_old",
+        body: body(),
+        requestMeta: { requestId: "req_123" },
+      })
+    ).rejects.toThrow("Requested slot is no longer available");
+  });
+
+  it("rejects already rescheduled bookings", async () => {
+    vi.mocked(repository.findOriginalBooking).mockResolvedValueOnce({
+      ...originalBooking,
+      rescheduled: true,
+    });
+
+    await expect(
+      service.rescheduleBooking({
+        uid: "book_old",
+        body: body(),
+        requestMeta: { requestId: "req_123" },
+      })
+    ).rejects.toThrow("Booking was already rescheduled");
+  });
+});
diff --git a/apps/api/v2/src/modules/bookings/reschedule/repository.spec.ts b/apps/api/v2/src/modules/bookings/reschedule/repository.spec.ts
new file mode 100644
index 000000000..a85fd9a20
--- /dev/null
+++ b/apps/api/v2/src/modules/bookings/reschedule/repository.spec.ts
@@ -0,0 +1,230 @@
+import { describe, expect, it } from "vitest";
+import { BookingStatus } from "@calcom/prisma/enums";
+import { BookingRescheduleRepository, type OriginalBookingForReschedule } from "./repository";
+
+const prismaWriteService = {
+  prisma: {
+    booking: {
+      findUnique: async () => null,
+      findFirst: async () => null,
+      create: async () => null,
+      update: async () => null,
+    },
+    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
+  },
+};
+
+const original = {
+  id: 99,
+  uid: "book_original",
+  title: "Quarterly planning",
+  description: "Planning call",
+  startTime: new Date("2026-06-01T15:00:00.000Z"),
+  endTime: new Date("2026-06-01T15:30:00.000Z"),
+  status: BookingStatus.ACCEPTED,
+  userId: 77,
+  userPrimaryEmail: "host@example.com",
+  eventTypeId: 55,
+  location: "https://meet.example.com/old-room",
+  customInputs: { team: "growth" },
+  responses: { name: "Ari", email: "ari@example.com" },
+  metadata: {
+    crmId: "deal_123",
+  },
+  iCalUID: "ical_original",
+  iCalSequence: 4,
+  smsReminderNumber: "+15555550123",
+  paid: true,
+  rescheduled: false,
+  rescheduledBy: null,
+  fromReschedule: null,
+  attendees: [
+    {
+      name: "Ari",
+      email: "ari@example.com",
+      timeZone: "America/New_York",
+      locale: "en",
+      phoneNumber: "+15555550123",
+    },
+    {
+      name: "Guest",
+      email: "guest@example.com",
+      timeZone: "America/New_York",
+      locale: "en",
+      phoneNumber: null,
+    },
+  ],
+  references: [
+    {
+      id: 1,
+      type: "google_calendar",
+      uid: "google_event_original",
+      meetingId: null,
+      meetingPassword: null,
+      meetingUrl: null,
+      credentialId: 12,
+      externalCalendarId: "primary",
+      deleted: false,
+    },
+    {
+      id: 2,
+      type: "google_meet_video",
+      uid: "google_event_original",
+      meetingId: "meet_original",
+      meetingPassword: null,
+      meetingUrl: "https://meet.google.com/original",
+      credentialId: 12,
+      externalCalendarId: "primary",
+      deleted: false,
+    },
+  ],
+  user: {
+    id: 77,
+    email: "host@example.com",
+    name: "Host",
+    username: "host",
+    timeZone: "America/Los_Angeles",
+    locale: "en",
+  },
+  eventType: {
+    id: 55,
+    slug: "planning",
+    title: "Planning",
+    length: 30,
+    schedulingType: null,
+    metadata: {},
+    seatsPerTimeSlot: null,
+    destinationCalendar: null,
+  },
+} satisfies OriginalBookingForReschedule;
+
+describe("BookingRescheduleRepository.buildReplacementBookingCreateInput", () => {
+  it("creates a standalone accepted booking", () => {
+    const repository = new BookingRescheduleRepository(prismaWriteService as never);
+
+    const createInput = repository.buildReplacementBookingCreateInput(original, {
+      startTime: new Date("2026-06-03T15:00:00.000Z"),
+      endTime: new Date("2026-06-03T15:30:00.000Z"),
+      timeZone: "America/New_York",
+      reason: "customer asked to move",
+      actorEmail: "ari@example.com",
+      metadata: { source: "api" },
+      preserveAttendees: true,
+      preserveLocation: true,
+      preserveResponses: true,
+    });
+
+    expect(createInput.status).toBe(BookingStatus.ACCEPTED);
+    expect(createInput.fromReschedule).toBeNull();
+    expect(createInput.rescheduled).toBe(false);
+    expect(createInput.rescheduledBy).toBeNull();
+  });
+
+  it("copies provider references onto the replacement booking", () => {
+    const repository = new BookingRescheduleRepository(prismaWriteService as never);
+
+    const createInput = repository.buildReplacementBookingCreateInput(original, {
+      startTime: new Date("2026-06-03T15:00:00.000Z"),
+      endTime: new Date("2026-06-03T15:30:00.000Z"),
+      timeZone: "America/New_York",
+      reason: "customer asked to move",
+      actorEmail: "ari@example.com",
+      metadata: {},
+      preserveAttendees: true,
+      preserveLocation: true,
+      preserveResponses: true,
+    });
+
+    expect(createInput.references).toEqual({
+      createMany: {
+        data: [
+          {
+            type: "google_calendar",
+            uid: "google_event_original",
+            meetingId: null,
+            meetingPassword: null,
+            meetingUrl: null,
+            credentialId: 12,
+            externalCalendarId: "primary",
+            deleted: false,
+          },
+          {
+            type: "google_meet_video",
+            uid: "google_event_original",
+            meetingId: "meet_original",
+            meetingPassword: null,
+            meetingUrl: "https://meet.google.com/original",
+            credentialId: 12,
+            externalCalendarId: "primary",
+            deleted: false,
+          },
+        ],
+      },
+    });
+  });
+
+  it("copies the original iCal identity", () => {
+    const repository = new BookingRescheduleRepository(prismaWriteService as never);
+
+    const createInput = repository.buildReplacementBookingCreateInput(original, {
+      startTime: new Date("2026-06-03T15:00:00.000Z"),
+      endTime: new Date("2026-06-03T15:30:00.000Z"),
+      timeZone: "America/New_York",
+      reason: "customer asked to move",
+      actorEmail: "ari@example.com",
+      metadata: {},
+      preserveAttendees: true,
+      preserveLocation: true,
+      preserveResponses: true,
+    });
+
+    expect(createInput.iCalUID).toBe("ical_original");
+    expect(createInput.iCalSequence).toBe(4);
+  });
+
+  it("hides the transition inside metadata", () => {
+    const repository = new BookingRescheduleRepository(prismaWriteService as never);
+
+    const createInput = repository.buildReplacementBookingCreateInput(original, {
+      startTime: new Date("2026-06-03T15:00:00.000Z"),
+      endTime: new Date("2026-06-03T15:30:00.000Z"),
+      timeZone: "America/New_York",
+      reason: "customer asked to move",
+      actorEmail: "ari@example.com",
+      metadata: { source: "api" },
+      preserveAttendees: true,
+      preserveLocation: true,
+      preserveResponses: true,
+    });
+
+    expect(createInput.metadata).toEqual({
+      crmId: "deal_123",
+      source: "api",
+      apiReschedule: {
+        originalBookingUid: "book_original",
+        reason: "customer asked to move",
+        actorEmail: "ari@example.com",
+      },
+    });
+  });
+
+  it("can drop attendees and responses when requested", () => {
+    const repository = new BookingRescheduleRepository(prismaWriteService as never);
+
+    const createInput = repository.buildReplacementBookingCreateInput(original, {
+      startTime: new Date("2026-06-03T15:00:00.000Z"),
+      endTime: new Date("2026-06-03T15:30:00.000Z"),
+      timeZone: "America/New_York",
+      reason: "customer asked to move",
+      actorEmail: "ari@example.com",
+      metadata: {},
+      preserveAttendees: false,
+      preserveLocation: false,
+      preserveResponses: false,
+    });
+
+    expect(createInput.attendees).toBeUndefined();
+    expect(createInput.responses).toBeUndefined();
+    expect(createInput.location).toBeNull();
+  });
+});
diff --git a/docs/api/bookings-reschedule.md b/docs/api/bookings-reschedule.md
new file mode 100644
index 000000000..29c3a9160
--- /dev/null
+++ b/docs/api/bookings-reschedule.md
@@ -0,0 +1,120 @@
+# Reschedule a booking
+
+`POST /v2/bookings/:uid/reschedule` creates a booking at a new time and sends
+reschedule notifications to the organizer, booker, and guests.
+
+## Request
+
+```json
+{
+  "start": "2026-06-02T10:00:00.000Z",
+  "end": "2026-06-02T10:30:00.000Z",
+  "timeZone": "America/New_York",
+  "reason": "Need a better time",
+  "rescheduledBy": "booker@example.com",
+  "actor": "booker",
+  "notifyOrganizer": true,
+  "notifyBooker": true,
+  "notifyGuests": true,
+  "preserveAttendees": true,
+  "preserveLocation": true,
+  "preserveResponses": true
+}
+```
+
+## Response
+
+```json
+{
+  "data": {
+    "originalBookingUid": "book_old",
+    "newBookingUid": "book_new",
+    "status": "rescheduled",
+    "notifications": {
+      "organizer": true,
+      "booker": true,
+      "guests": true
+    }
+  }
+}
+```
+
+## Behavior
+
+The endpoint loads the original booking, checks that the target slot has no
+accepted booking, sends reschedule notifications, creates a replacement booking,
+and writes an audit object into the original booking metadata.
+
+The replacement booking is a normal accepted booking. It copies attendees,
+location, responses, calendar references, payment flag, iCal uid, and SMS
+reminder settings from the original booking. The original booking stays in its
+current state so older clients can still resolve it by uid.
+
+The response includes both uids so API clients can store the mapping. Dashboard
+and reporting surfaces can read `metadata.apiRescheduleAudit.newBookingUid` from
+the old booking when they need to display the new booking.
+
+## Notifications
+
+Notifications are sent before the replacement booking is created. This keeps the
+API responsive and lets users learn about the new time even if audit persistence
+fails later. The notification payload uses the original booking as
+`originalRescheduledBooking` and renders the new start/end in the event payload.
+
+Set `notifyOrganizer`, `notifyBooker`, and `notifyGuests` to false to suppress
+specific recipient groups. The API still creates the replacement booking.
+
+## Calendar references
+
+The endpoint copies existing calendar and video references to the replacement
+booking so clients can continue to display provider information. Existing
+calendar events are not modified by this endpoint. Connected calendar apps will
+observe the new booking through normal booking sync.
+
+## Error handling
+
+`404` is returned when the original booking uid does not exist.
+
+`409` is returned when another accepted booking overlaps the requested time.
+
+`400` is returned when the booking is cancelled, already rescheduled, or has no
+event type.
+
+If notification delivery succeeds but persistence fails, the API returns the
+persistence error. Clients may retry the request.
+
+## Audit fields
+
+The endpoint writes an `apiRescheduleAudit` object into the original booking
+metadata:
+
+```json
+{
+  "apiRescheduleAudit": {
+    "newBookingUid": "book_new",
+    "actorEmail": "booker@example.com",
+    "reason": "Need a better time",
+    "requestId": "req_123",
+    "recordedAt": "2026-05-16T12:00:00.000Z"
+  }
+}
+```
+
+The new booking also stores an `apiReschedule` metadata object with the original
+booking uid. API clients should use these metadata objects to join old and new
+bookings.
+
+## Reporting
+
+The reporting API will continue counting the original booking because the
+original row is not cancelled. Consumers that need the latest reschedule target
+should read the metadata pointer and issue a second booking lookup.
+
+## Retries
+
+The endpoint does not require an idempotency key. If a client receives a timeout,
+it should check the original booking metadata before retrying. If no metadata was
+written, retrying is safe.
+
+If metadata was written but the client did not receive a response, the client can
+treat the stored `newBookingUid` as the successful reschedule target.
```

## Intended Flaws

### Flaw 1: The API creates an independent replacement booking instead of performing a reschedule transition

The endpoint bypasses the existing reschedule lifecycle. It creates a new accepted booking while leaving the original booking accepted and unlinked from the new one.

Relevant line references:

- `apps/api/v2/src/modules/bookings/reschedule/service.ts:61-93` calls notification logic, then creates a replacement booking directly through the repository.
- `apps/api/v2/src/modules/bookings/reschedule/repository.ts:126-194` builds the new booking by copying attendees, references, `iCalUID`, and status as if it were a fresh accepted booking.
- `apps/api/v2/src/modules/bookings/reschedule/repository.ts:189-191` explicitly sets `fromReschedule: null`, `rescheduled: false`, and `rescheduledBy: null` on the new booking.
- `apps/api/v2/src/modules/bookings/reschedule/repository.ts:213-240` only appends metadata to the original booking; it does not set the original booking to `CANCELLED`, does not set `rescheduled: true`, and does not record `rescheduledBy`.
- `apps/api/v2/src/modules/bookings/reschedule/service.spec.ts:139-151` asserts that the new booking has no reschedule link and the original booking remains accepted.
- `docs/api/bookings-reschedule.md:48-55` documents the replacement-booking model and says the original booking stays in its current state.

Why this is a real flaw:

Cal.com booking reschedule is not just "create another booking at a new time." The original booking, new booking, calendar references, external calendar event, audit trail, webhooks, and emails all need one lifecycle transition. This PR leaves two accepted bookings in the system, copies provider references without actually moving the provider event, and hides the relationship in metadata that existing domain code will not understand. That can orphan calendar holds, double-count booking limits, confuse availability, make old booking pages still look active, and break `findRescheduledToBooking`/`findPreviousBooking` surfaces.

Better implementation direction:

Route the API through the existing reschedule path, or extract a shared reschedule command that both web and API callers use. The command should load `originalRescheduledBooking`, pass `rescheduleUid`, call the calendar event-manager reschedule/update flow, create the new booking with `fromReschedule`, mark the original as `CANCELLED` and `rescheduled: true`, preserve `rescheduledBy`, and emit rescheduled events/webhooks with both old and new times.

### Flaw 2: Reschedule notifications are sent before the database transition commits

The endpoint sends user-visible notifications before it has created the replacement booking or written the audit/update data.

Relevant line references:

- `apps/api/v2/src/modules/bookings/reschedule/service.ts:66-79` calls `sendPendingRescheduleNotifications(...)` before the transaction starts.
- `apps/api/v2/src/modules/bookings/reschedule/service.ts:79-100` performs the create/audit write only after notifications have already been sent.
- `apps/api/v2/src/modules/bookings/reschedule/notifications.ts:53-94` sends `BookingActionMap.rescheduled` emails/SMS with a uid that can still be the old booking uid.
- `apps/api/v2/src/modules/bookings/reschedule/service.spec.ts:154-195` asserts that notifications happen before creation and still happen when the transaction later fails.
- `docs/api/bookings-reschedule.md:57-65` documents notification-before-persistence as intended behavior.

Why this is a real flaw:

Emails, SMS, and webhooks are external side effects. If they go out before the database transition commits, users can receive a reschedule confirmation for a booking that was never changed. A deadlock, unique constraint, transaction timeout, or deploy interruption after notification but before commit creates permanent reality mismatch: calendars and database say old time, users were told new time.

Better implementation direction:

Persist the booking transition first and enqueue notifications in the same transaction via an outbox/tasker record. A worker should send notifications after commit using the committed booking ids and transition payload. If synchronous sending is absolutely required, it must happen after commit and be retriable/idempotent, but the stronger pattern is transactional outbox plus durable notification jobs.

## Hints

### Flaw 1 Hints

1. Compare the new API path to the existing `RegularBookingService` reschedule branch. Which one updates calendar events and original booking state?
2. Search for `fromReschedule`, `rescheduled`, and `status: CANCELLED` in the diff. Are those domain fields being used as the existing model expects?
3. What happens to availability and calendar references if both old and new booking rows are accepted?

### Flaw 2 Hints

1. Put the operations in order: slot check, notification send, transaction, booking create, audit write.
2. Imagine the transaction fails after the email/SMS provider succeeds. What has the user been told?
3. Which pattern lets you atomically commit the state change and later send external notifications?

## Expected Answer

A strong review should say that the product-level change is a public reschedule API, but the implementation fails to reuse Cal.com's actual booking transition model.

For flaw 1, the learner should identify that the new API creates a second accepted booking and stores a metadata pointer instead of performing a reschedule transition. The impact is orphaned old calendar holds, duplicate accepted bookings, broken audit/navigation helpers, and confusing booking/webhook semantics. The fix is to route through the existing reschedule command or extract one shared state machine.

For flaw 2, the learner should identify that notifications are sent before the transaction commits. The impact is emails/SMS/webhooks for failed changes. The fix is to write the booking transition and enqueue notification work atomically, then send from a worker after commit.

The best answers cite the tests, because the tests show the author has made the wrong behavior contractual.

## Expert Debrief

At the product level, a reschedule API is valuable. Platform customers should be able to move bookings from their own apps. But rescheduling is a state transition, not an insert shortcut.

The contract change is subtle because the response says `status: "rescheduled"`, but the database state says something else. The new booking is accepted and unlinked. The old booking is still accepted. Calendar references are copied, not moved. Existing helpers that understand `fromReschedule` and `rescheduled` will not see the transition. Users and integrations now have two sources of truth.

The failure modes are ordinary production failures:

- The old slot remains blocked because the original booking stayed accepted.
- The new slot is blocked too, creating double capacity usage.
- The copied calendar reference points at an event that was never moved.
- A notification says the booking moved, but the transaction later fails.
- A retry after a notification failure can create another replacement booking.
- Dashboard history cannot reliably show previous and next booking.

The reviewer thought process should be: find the domain state machine and ask whether the PR uses it. For booking systems, state fields, external calendar references, notification timing, and audit history are one workflow. When a PR appears to "just add an endpoint," the hard part is usually whether it reuses the existing workflow instead of recreating a happy-path subset.

The better implementation is a shared reschedule command. Validate the new slot with `rescheduleUid`, call the existing reschedule logic, commit old/new booking state and a notification outbox record together, then let tasker send emails/SMS/webhooks from committed data. The API controller should be thin.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: replacement booking instead of a linked reschedule transition, and notifications before commit. It explains the calendar/audit/availability impact and suggests shared reschedule state machine plus transactional outbox.
- `partial`: The answer finds one flaw completely and notices something off about the other, but does not explain the production failure mode clearly.
- `miss`: The answer focuses on DTO style, Nest decorators, or minor validation details while missing the state transition and side-effect ordering issues.
