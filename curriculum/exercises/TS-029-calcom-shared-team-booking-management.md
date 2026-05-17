# TS-029: Cal.diy Shared Team Booking Management

## Metadata

- `id`: TS-029
- `source_repo`: [calcom/cal.diy](https://github.com/calcom/cal.diy)
- `repo_area`: v2 bookings API, team event types, booking access checks, membership roles, reschedule flow, attendee side effects
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 1,150-1,400
- `represented_diff_lines`: 1341
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about team membership boundaries, event-type hosts, booking ownership, reschedule side effects, and PBAC without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds shared team booking management for the v2 API.

Today, a team admin who is helping support or operations often has to ask the original host to manage a booking. That creates avoidable support loops for round-robin teams, onboarding teams, and managed sales/customer-success calendars. This change adds team booking endpoints so authorized team members can list bookings for a team event type, inspect a booking, and reschedule a booking from a manager workflow.

The PR adds:

- team booking list and detail endpoints under `/v2/teams/:teamId/bookings`,
- shared DTOs for team booking management responses,
- a repository for team booking lookups and updates,
- a service that centralizes list/detail/reschedule logic,
- manager reschedule support that updates attendees and calls the existing booking creation path,
- OpenAPI-facing input/output types,
- tests for former hosts, team admins, and manager reschedule.

## Existing Code Context

The real Cal.diy codebase already has these relevant contracts:

- `apps/api/v2/src/platform/bookings/2024-08-13/services/bookings.service.ts` routes normal reschedules through `inputService.createRescheduleBookingRequest`, checks `canRescheduleBooking`, and then calls `regularBookingService.createBooking`.
- `apps/api/v2/src/platform/bookings/2024-08-13/guards/booking-pbac.guard.ts` delegates booking access to `BookingAccessService.doesUserIdHaveAccessToBooking`.
- `packages/features/bookings/services/BookingAccessService.ts` distinguishes booking organizer, event-type hosts/users, team booking permissions, parent managed-event team permissions, org admin permissions, and team admin permissions.
- `apps/api/v2/src/modules/event-types/services/event-type-access.service.ts` treats event-type owner, host/assigned user, team admin/owner, parent org admin, and system admin as different access paths.
- `apps/api/v2/src/lib/repositories/prisma-team.repository.ts` checks team admin access by querying current team membership with role `ADMIN` or `OWNER`.
- `packages/features/membership/repositories/MembershipRepository.ts` exposes accepted membership checks and admin/owner membership helpers. Current `Membership.accepted` state is the durable boundary for team access.
- `packages/prisma/schema.prisma` stores `Booking.userId`, `Booking.eventTypeId`, `Booking.fromReschedule`, `Booking.rescheduledBy`, `Attendee`, `Membership`, and `EventType.teamId`. A booking's assigned host is historical state; team membership can change later.
- `packages/features/bookings/lib/handleNewBooking/createBooking.ts` cancels the original booking and creates the new booking inside the booking creation transaction when `rescheduleUid` is present.
- `packages/features/booking-audit/lib/service/BookingAuditAccessService.ts` intentionally keeps audit access narrower than normal booking reads, which is a reminder that "can see/manage a booking" is not one universal permission.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/platform/types/bookings/2024-08-13/inputs/team-bookings.input.ts`
- `packages/platform/types/bookings/2024-08-13/outputs/team-booking.output.ts`
- `apps/api/v2/src/platform/bookings/2024-08-13/repositories/team-booking-management.repository.ts`
- `apps/api/v2/src/platform/bookings/2024-08-13/services/team-booking-management.service.ts`
- `apps/api/v2/src/platform/bookings/2024-08-13/controllers/team-bookings.controller.ts`
- `apps/api/v2/src/platform/bookings/2024-08-13/bookings.module.ts`
- `apps/api/v2/src/platform/bookings/2024-08-13/controllers/e2e/team-bookings.e2e-spec.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on backend/API behavior, authorization, team membership, booking ownership, reschedule ordering, side effects, and tests.

## Diff

```diff
diff --git a/packages/platform/types/bookings/2024-08-13/inputs/team-bookings.input.ts b/packages/platform/types/bookings/2024-08-13/inputs/team-bookings.input.ts
new file mode 100644
index 0000000000..93813aa124
--- /dev/null
+++ b/packages/platform/types/bookings/2024-08-13/inputs/team-bookings.input.ts
@@ -0,0 +1,123 @@
+import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
+import { Type } from "class-transformer";
+import {
+  IsArray,
+  IsBoolean,
+  IsDateString,
+  IsEmail,
+  IsEnum,
+  IsInt,
+  IsOptional,
+  IsString,
+  Max,
+  Min,
+  ValidateNested,
+} from "class-validator";
+
+export enum TeamBookingStatusFilter_2024_08_13 {
+  UPCOMING = "upcoming",
+  PAST = "past",
+  CANCELLED = "cancelled",
+  ALL = "all",
+}
+
+export enum TeamBookingSort_2024_08_13 {
+  START_ASC = "start_asc",
+  START_DESC = "start_desc",
+  CREATED_DESC = "created_desc",
+}
+
+export class GetTeamBookingsInput_2024_08_13 {
+  @ApiPropertyOptional({
+    description: "Filter bookings by event type id. Must belong to the requested team.",
+    example: 1301,
+  })
+  @IsOptional()
+  @Type(() => Number)
+  @IsInt()
+  eventTypeId?: number;
+
+  @ApiPropertyOptional({
+    enum: TeamBookingStatusFilter_2024_08_13,
+    default: TeamBookingStatusFilter_2024_08_13.UPCOMING,
+  })
+  @IsOptional()
+  @IsEnum(TeamBookingStatusFilter_2024_08_13)
+  status?: TeamBookingStatusFilter_2024_08_13 = TeamBookingStatusFilter_2024_08_13.UPCOMING;
+
+  @ApiPropertyOptional({
+    enum: TeamBookingSort_2024_08_13,
+    default: TeamBookingSort_2024_08_13.START_ASC,
+  })
+  @IsOptional()
+  @IsEnum(TeamBookingSort_2024_08_13)
+  sort?: TeamBookingSort_2024_08_13 = TeamBookingSort_2024_08_13.START_ASC;
+
+  @ApiPropertyOptional({ example: "2026-02-01T00:00:00.000Z" })
+  @IsOptional()
+  @IsDateString()
+  startFrom?: string;
+
+  @ApiPropertyOptional({ example: "2026-02-28T23:59:59.999Z" })
+  @IsOptional()
+  @IsDateString()
+  startTo?: string;
+
+  @ApiPropertyOptional({ example: "alex@example.com" })
+  @IsOptional()
+  @IsEmail()
+  attendeeEmail?: string;
+
+  @ApiPropertyOptional({ default: 0 })
+  @IsOptional()
+  @Type(() => Number)
+  @IsInt()
+  @Min(0)
+  skip?: number = 0;
+
+  @ApiPropertyOptional({ default: 50, maximum: 100 })
+  @IsOptional()
+  @Type(() => Number)
+  @IsInt()
+  @Min(1)
+  @Max(100)
+  take?: number = 50;
+}
+
+export class ManagerRescheduleAttendeeInput_2024_08_13 {
+  @ApiProperty({ example: "Jordan Booker" })
+  @IsString()
+  name!: string;
+
+  @ApiProperty({ example: "jordan@example.com" })
+  @IsEmail()
+  email!: string;
+
+  @ApiPropertyOptional({ example: "America/New_York" })
+  @IsOptional()
+  @IsString()
+  timeZone?: string;
+}
+
+export class ManagerRescheduleTeamBookingInput_2024_08_13 {
+  @ApiProperty({ example: "2026-03-01T17:00:00.000Z" })
+  @IsDateString()
+  start!: string;
+
+  @ApiPropertyOptional({ type: [ManagerRescheduleAttendeeInput_2024_08_13] })
+  @IsOptional()
+  @IsArray()
+  @ValidateNested({ each: true })
+  @Type(() => ManagerRescheduleAttendeeInput_2024_08_13)
+  attendees?: ManagerRescheduleAttendeeInput_2024_08_13[];
+
+  @ApiPropertyOptional({ example: "Customer support moved this into the onboarding block." })
+  @IsOptional()
+  @IsString()
+  rescheduleReason?: string;
+
+  @ApiPropertyOptional({ default: true })
+  @IsOptional()
+  @IsBoolean()
+  notifyAttendees?: boolean = true;
+}
diff --git a/packages/platform/types/bookings/2024-08-13/outputs/team-booking.output.ts b/packages/platform/types/bookings/2024-08-13/outputs/team-booking.output.ts
new file mode 100644
index 0000000000..7f38e2f41b
--- /dev/null
+++ b/packages/platform/types/bookings/2024-08-13/outputs/team-booking.output.ts
@@ -0,0 +1,132 @@
+import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
+
+export class TeamBookingAttendeeOutput_2024_08_13 {
+  @ApiProperty({ example: 91001 })
+  id!: number;
+
+  @ApiProperty({ example: "Jordan Booker" })
+  name!: string;
+
+  @ApiProperty({ example: "jordan@example.com" })
+  email!: string;
+
+  @ApiPropertyOptional({ example: "America/New_York" })
+  timeZone?: string | null;
+}
+
+export class TeamBookingHostOutput_2024_08_13 {
+  @ApiProperty({ example: 42 })
+  id!: number;
+
+  @ApiProperty({ example: "Riley Host" })
+  name!: string | null;
+
+  @ApiProperty({ example: "riley@example.com" })
+  email!: string;
+
+  @ApiPropertyOptional({ example: "Europe/London" })
+  timeZone?: string | null;
+}
+
+export class TeamBookingEventTypeOutput_2024_08_13 {
+  @ApiProperty({ example: 1301 })
+  id!: number;
+
+  @ApiProperty({ example: "enterprise-onboarding" })
+  slug!: string;
+
+  @ApiProperty({ example: "Enterprise onboarding" })
+  title!: string;
+
+  @ApiProperty({ example: 88 })
+  teamId!: number;
+
+  @ApiPropertyOptional({ example: "ROUND_ROBIN" })
+  schedulingType?: string | null;
+}
+
+export class TeamBookingOutput_2024_08_13 {
+  @ApiProperty({ example: 555001 })
+  id!: number;
+
+  @ApiProperty({ example: "bkg_01HRMANAGER" })
+  uid!: string;
+
+  @ApiProperty({ example: "Enterprise onboarding" })
+  title!: string;
+
+  @ApiProperty({ example: "2026-03-01T17:00:00.000Z" })
+  startTime!: string;
+
+  @ApiProperty({ example: "2026-03-01T17:30:00.000Z" })
+  endTime!: string;
+
+  @ApiProperty({ example: "ACCEPTED" })
+  status!: string;
+
+  @ApiPropertyOptional({ type: TeamBookingHostOutput_2024_08_13 })
+  host?: TeamBookingHostOutput_2024_08_13 | null;
+
+  @ApiProperty({ type: [TeamBookingAttendeeOutput_2024_08_13] })
+  attendees!: TeamBookingAttendeeOutput_2024_08_13[];
+
+  @ApiProperty({ type: TeamBookingEventTypeOutput_2024_08_13 })
+  eventType!: TeamBookingEventTypeOutput_2024_08_13;
+
+  @ApiPropertyOptional({
+    description: "UID of the booking this booking was rescheduled from.",
+    example: "bkg_OLD",
+  })
+  rescheduledFromUid?: string | null;
+
+  @ApiPropertyOptional({
+    description: "UID of the booking this booking was rescheduled to.",
+    example: "bkg_NEW",
+  })
+  rescheduledToUid?: string | null;
+
+  @ApiProperty({ example: false })
+  isManagedByCurrentUser!: boolean;
+}
+
+export class TeamBookingsPaginationOutput_2024_08_13 {
+  @ApiProperty({ example: 0 })
+  skip!: number;
+
+  @ApiProperty({ example: 50 })
+  take!: number;
+
+  @ApiProperty({ example: 122 })
+  total!: number;
+
+  @ApiProperty({ example: true })
+  hasMore!: boolean;
+}
+
+export class GetTeamBookingsOutput_2024_08_13 {
+  @ApiProperty({ example: "success" })
+  status!: string;
+
+  @ApiProperty({ type: [TeamBookingOutput_2024_08_13] })
+  data!: TeamBookingOutput_2024_08_13[];
+
+  @ApiProperty({ type: TeamBookingsPaginationOutput_2024_08_13 })
+  pagination!: TeamBookingsPaginationOutput_2024_08_13;
+}
+
+export class GetTeamBookingOutput_2024_08_13 {
+  @ApiProperty({ example: "success" })
+  status!: string;
+
+  @ApiProperty({ type: TeamBookingOutput_2024_08_13 })
+  data!: TeamBookingOutput_2024_08_13;
+}
+
+export class ManagerRescheduleTeamBookingOutput_2024_08_13 {
+  @ApiProperty({ example: "success" })
+  status!: string;
+
+  @ApiProperty({ type: TeamBookingOutput_2024_08_13 })
+  data!: TeamBookingOutput_2024_08_13;
+}
+
diff --git a/apps/api/v2/src/platform/bookings/2024-08-13/repositories/team-booking-management.repository.ts b/apps/api/v2/src/platform/bookings/2024-08-13/repositories/team-booking-management.repository.ts
new file mode 100644
index 0000000000..d65027f41a
--- /dev/null
+++ b/apps/api/v2/src/platform/bookings/2024-08-13/repositories/team-booking-management.repository.ts
@@ -0,0 +1,308 @@
+import type { Prisma } from "@calcom/prisma/client";
+import { BookingStatus, MembershipRole } from "@calcom/prisma/enums";
+import { Injectable } from "@nestjs/common";
+import { PrismaReadService } from "@/modules/prisma/prisma-read.service";
+import { PrismaWriteService } from "@/modules/prisma/prisma-write.service";
+import {
+  GetTeamBookingsInput_2024_08_13,
+  TeamBookingSort_2024_08_13,
+  TeamBookingStatusFilter_2024_08_13,
+} from "@calcom/platform-types";
+
+export const teamBookingSelect = {
+  id: true,
+  uid: true,
+  title: true,
+  startTime: true,
+  endTime: true,
+  status: true,
+  userId: true,
+  fromReschedule: true,
+  rescheduledBy: true,
+  eventTypeId: true,
+  eventType: {
+    select: {
+      id: true,
+      slug: true,
+      title: true,
+      teamId: true,
+      schedulingType: true,
+      users: {
+        select: {
+          id: true,
+          email: true,
+          name: true,
+          timeZone: true,
+        },
+      },
+      hosts: {
+        select: {
+          userId: true,
+          user: {
+            select: {
+              id: true,
+              email: true,
+              name: true,
+              timeZone: true,
+            },
+          },
+        },
+      },
+    },
+  },
+  user: {
+    select: {
+      id: true,
+      email: true,
+      name: true,
+      timeZone: true,
+    },
+  },
+  attendees: {
+    select: {
+      id: true,
+      email: true,
+      name: true,
+      timeZone: true,
+    },
+    orderBy: { id: "asc" },
+  },
+} satisfies Prisma.BookingSelect;
+
+export type TeamBookingRecord = Prisma.BookingGetPayload<{
+  select: typeof teamBookingSelect;
+}>;
+
+@Injectable()
+export class TeamBookingManagementRepository_2024_08_13 {
+  constructor(
+    private readonly dbRead: PrismaReadService,
+    private readonly dbWrite: PrismaWriteService
+  ) {}
+
+  async findTeamBookingForManager(args: {
+    teamId: number;
+    bookingUid: string;
+    actorUserId: number;
+  }): Promise<TeamBookingRecord | null> {
+    return this.dbRead.prisma.booking.findFirst({
+      where: {
+        uid: args.bookingUid,
+        eventType: {
+          teamId: args.teamId,
+        },
+        OR: [
+          { userId: args.actorUserId },
+          {
+            eventType: {
+              users: {
+                some: {
+                  id: args.actorUserId,
+                },
+              },
+            },
+          },
+          {
+            eventType: {
+              hosts: {
+                some: {
+                  userId: args.actorUserId,
+                },
+              },
+            },
+          },
+        ],
+      },
+      select: teamBookingSelect,
+    });
+  }
+
+  async countTeamBookings(args: {
+    teamId: number;
+    query: GetTeamBookingsInput_2024_08_13;
+    actorUserId: number;
+  }) {
+    return this.dbRead.prisma.booking.count({
+      where: this.buildTeamBookingsWhere(args),
+    });
+  }
+
+  async listTeamBookings(args: {
+    teamId: number;
+    query: GetTeamBookingsInput_2024_08_13;
+    actorUserId: number;
+  }): Promise<TeamBookingRecord[]> {
+    const skip = Math.max(args.query.skip ?? 0, 0);
+    const take = Math.min(Math.max(args.query.take ?? 50, 1), 100);
+    return this.dbRead.prisma.booking.findMany({
+      where: this.buildTeamBookingsWhere(args),
+      orderBy: this.buildOrderBy(args.query.sort),
+      skip,
+      take,
+      select: teamBookingSelect,
+    });
+  }
+
+  private buildTeamBookingsWhere(args: {
+    teamId: number;
+    query: GetTeamBookingsInput_2024_08_13;
+    actorUserId: number;
+  }): Prisma.BookingWhereInput {
+    const query = args.query;
+    const now = new Date();
+    const dateFilter: Prisma.DateTimeFilter = {};
+    if (query.startFrom) {
+      dateFilter.gte = new Date(query.startFrom);
+    }
+    if (query.startTo) {
+      dateFilter.lte = new Date(query.startTo);
+    }
+
+    const where: Prisma.BookingWhereInput = {
+      eventType: {
+        teamId: args.teamId,
+        ...(query.eventTypeId ? { id: query.eventTypeId } : {}),
+      },
+      OR: [
+        { userId: args.actorUserId },
+        {
+          eventType: {
+            users: {
+              some: {
+                id: args.actorUserId,
+              },
+            },
+          },
+        },
+        {
+          eventType: {
+            hosts: {
+              some: {
+                userId: args.actorUserId,
+              },
+            },
+          },
+        },
+      ],
+    };
+
+    if (Object.keys(dateFilter).length) {
+      where.startTime = dateFilter;
+    }
+
+    if (query.status === TeamBookingStatusFilter_2024_08_13.UPCOMING || !query.status) {
+      where.status = { not: BookingStatus.CANCELLED };
+      where.startTime = {
+        ...(typeof where.startTime === "object" && where.startTime !== null ? where.startTime : {}),
+        gte: (where.startTime as Prisma.DateTimeFilter | undefined)?.gte ?? now,
+      };
+    } else if (query.status === TeamBookingStatusFilter_2024_08_13.PAST) {
+      where.startTime = {
+        ...(typeof where.startTime === "object" && where.startTime !== null ? where.startTime : {}),
+        lt: now,
+      };
+      where.status = { not: BookingStatus.CANCELLED };
+    } else if (query.status === TeamBookingStatusFilter_2024_08_13.CANCELLED) {
+      where.status = BookingStatus.CANCELLED;
+    }
+
+    if (query.attendeeEmail) {
+      where.attendees = {
+        some: {
+          email: {
+            equals: query.attendeeEmail,
+            mode: "insensitive",
+          },
+        },
+      };
+    }
+
+    return where;
+  }
+
+  private buildOrderBy(sort?: TeamBookingSort_2024_08_13): Prisma.BookingOrderByWithRelationInput {
+    switch (sort) {
+      case TeamBookingSort_2024_08_13.START_DESC:
+        return { startTime: "desc" };
+      case TeamBookingSort_2024_08_13.CREATED_DESC:
+        return { createdAt: "desc" };
+      case TeamBookingSort_2024_08_13.START_ASC:
+      default:
+        return { startTime: "asc" };
+    }
+  }
+
+  async getCurrentMembership(args: { teamId: number; actorUserId: number }) {
+    return this.dbRead.prisma.membership.findFirst({
+      where: {
+        teamId: args.teamId,
+        userId: args.actorUserId,
+        accepted: true,
+        role: {
+          in: [MembershipRole.MEMBER, MembershipRole.ADMIN, MembershipRole.OWNER],
+        },
+      },
+      select: {
+        id: true,
+        role: true,
+        accepted: true,
+      },
+    });
+  }
+
+  async getCurrentAdminMembership(args: { teamId: number; actorUserId: number }) {
+    return this.dbRead.prisma.membership.findFirst({
+      where: {
+        teamId: args.teamId,
+        userId: args.actorUserId,
+        accepted: true,
+        role: {
+          in: [MembershipRole.ADMIN, MembershipRole.OWNER],
+        },
+      },
+      select: {
+        id: true,
+        role: true,
+      },
+    });
+  }
+
+  async replaceBookingAttendees(args: {
+    bookingId: number;
+    attendees: { name: string; email: string; timeZone?: string | null }[];
+  }) {
+    await this.dbWrite.prisma.attendee.deleteMany({
+      where: {
+        bookingId: args.bookingId,
+      },
+    });
+    return this.dbWrite.prisma.attendee.createMany({
+      data: args.attendees.map((attendee) => ({
+        bookingId: args.bookingId,
+        name: attendee.name,
+        email: attendee.email,
+        timeZone: attendee.timeZone ?? "UTC",
+      })),
+    });
+  }
+
+  async recordManagerAction(args: {
+    bookingUid: string;
+    actorUserId: number;
+    action: "viewed" | "rescheduled" | "attendees_updated";
+    metadata?: Prisma.InputJsonObject;
+  }) {
+    return this.dbWrite.prisma.bookingInternalNote.create({
+      data: {
+        booking: {
+          connect: { uid: args.bookingUid },
+        },
+        createdBy: {
+          connect: { id: args.actorUserId },
+        },
+        note: `team_manager:${args.action}`,
+        metadata: args.metadata ?? {},
+      },
+    });
+  }
+}
diff --git a/apps/api/v2/src/platform/bookings/2024-08-13/services/team-booking-management.service.ts b/apps/api/v2/src/platform/bookings/2024-08-13/services/team-booking-management.service.ts
new file mode 100644
index 0000000000..bc22e1b11d
--- /dev/null
+++ b/apps/api/v2/src/platform/bookings/2024-08-13/services/team-booking-management.service.ts
@@ -0,0 +1,284 @@
+import {
+  GetTeamBookingsInput_2024_08_13,
+  ManagerRescheduleTeamBookingInput_2024_08_13,
+  TeamBookingOutput_2024_08_13,
+} from "@calcom/platform-types";
+import { MembershipRole } from "@calcom/prisma/enums";
+import {
+  BadRequestException,
+  ForbiddenException,
+  Injectable,
+  NotFoundException,
+} from "@nestjs/common";
+import { Request } from "express";
+import { DateTime } from "luxon";
+import { RegularBookingService } from "@/lib/services/regular-booking.service";
+import { BookingEmailAndSmsTasker } from "@/lib/services/tasker/booking-emails-sms-tasker.service";
+import { InputBookingsService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/input.service";
+import {
+  TeamBookingManagementRepository_2024_08_13,
+  TeamBookingRecord,
+} from "@/platform/bookings/2024-08-13/repositories/team-booking-management.repository";
+import { ApiAuthGuardUser } from "@/modules/auth/strategies/api-auth/api-auth.strategy";
+
+export class TeamBookingManagePermissionError extends ForbiddenException {
+  constructor() {
+    super("You do not have permission to manage this team booking");
+  }
+}
+
+type ManagerActor = Pick<ApiAuthGuardUser, "id" | "uuid" | "email" | "isSystemAdmin">;
+
+@Injectable()
+export class TeamBookingManagementService_2024_08_13 {
+  constructor(
+    private readonly repository: TeamBookingManagementRepository_2024_08_13,
+    private readonly inputService: InputBookingsService_2024_08_13,
+    private readonly regularBookingService: RegularBookingService,
+    private readonly bookingEmailAndSmsTasker: BookingEmailAndSmsTasker
+  ) {}
+
+  async listTeamBookings(args: {
+    teamId: number;
+    query: GetTeamBookingsInput_2024_08_13;
+    actor: ManagerActor;
+  }) {
+    const [bookings, total] = await Promise.all([
+      this.repository.listTeamBookings({
+        teamId: args.teamId,
+        query: args.query,
+        actorUserId: args.actor.id,
+      }),
+      this.repository.countTeamBookings({
+        teamId: args.teamId,
+        query: args.query,
+        actorUserId: args.actor.id,
+      }),
+    ]);
+
+    const skip = Math.max(args.query.skip ?? 0, 0);
+    const take = Math.min(Math.max(args.query.take ?? 50, 1), 100);
+    return {
+      data: bookings.map((booking) => this.toOutput(booking, args.actor.id)),
+      pagination: {
+        skip,
+        take,
+        total,
+        hasMore: skip + take < total,
+      },
+    };
+  }
+
+  async getTeamBooking(args: {
+    teamId: number;
+    bookingUid: string;
+    actor: ManagerActor;
+  }): Promise<TeamBookingOutput_2024_08_13> {
+    const booking = await this.repository.findTeamBookingForManager({
+      teamId: args.teamId,
+      bookingUid: args.bookingUid,
+      actorUserId: args.actor.id,
+    });
+    if (!booking) {
+      throw new NotFoundException(`Booking with uid=${args.bookingUid} was not found`);
+    }
+
+    await this.repository.recordManagerAction({
+      bookingUid: args.bookingUid,
+      actorUserId: args.actor.id,
+      action: "viewed",
+    });
+
+    return this.toOutput(booking, args.actor.id);
+  }
+
+  async managerRescheduleTeamBooking(args: {
+    teamId: number;
+    bookingUid: string;
+    actor: ApiAuthGuardUser;
+    request: Request;
+    body: ManagerRescheduleTeamBookingInput_2024_08_13;
+  }): Promise<TeamBookingOutput_2024_08_13> {
+    const booking = await this.repository.findTeamBookingForManager({
+      teamId: args.teamId,
+      bookingUid: args.bookingUid,
+      actorUserId: args.actor.id,
+    });
+    if (!booking) {
+      throw new NotFoundException(`Booking with uid=${args.bookingUid} was not found`);
+    }
+
+    const requestedStart = DateTime.fromISO(args.body.start, { zone: "utc" });
+    if (!requestedStart.isValid) {
+      throw new BadRequestException("Invalid reschedule start time");
+    }
+    if (requestedStart < DateTime.utc()) {
+      throw new BadRequestException("Cannot reschedule a booking into the past");
+    }
+
+    if (args.body.attendees?.length) {
+      await this.repository.replaceBookingAttendees({
+        bookingId: booking.id,
+        attendees: args.body.attendees.map((attendee) => ({
+          name: attendee.name,
+          email: attendee.email,
+          timeZone: attendee.timeZone ?? "UTC",
+        })),
+      });
+
+      await this.repository.recordManagerAction({
+        bookingUid: args.bookingUid,
+        actorUserId: args.actor.id,
+        action: "attendees_updated",
+        metadata: {
+          attendeeEmails: args.body.attendees.map((attendee) => attendee.email),
+        },
+      });
+
+      if (args.body.notifyAttendees !== false) {
+        await this.bookingEmailAndSmsTasker.sendAttendeeUpdatedEmails({
+          bookingUid: args.bookingUid,
+          attendeeEmails: args.body.attendees.map((attendee) => attendee.email),
+          triggeredBy: args.actor.email,
+        });
+      }
+    }
+
+    await this.assertCanManageTeamBooking({
+      teamId: args.teamId,
+      actor: args.actor,
+      booking,
+      requiredRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
+    });
+
+    const bookingRequest = await this.inputService.createRescheduleBookingRequest(
+      args.request,
+      args.bookingUid,
+      {
+        start: args.body.start,
+        rescheduledBy: args.actor.email,
+        rescheduleReason: args.body.rescheduleReason,
+      },
+      false
+    );
+
+    const createdBooking = await this.regularBookingService.createBooking({
+      bookingData: bookingRequest.body,
+      bookingMeta: {
+        userId: bookingRequest.userId ?? args.actor.id,
+        hostname: bookingRequest.headers?.host || "",
+        platformClientId: bookingRequest.platformClientId,
+        platformRescheduleUrl: bookingRequest.platformRescheduleUrl,
+        platformCancelUrl: bookingRequest.platformCancelUrl,
+        platformBookingUrl: bookingRequest.platformBookingUrl,
+        platformBookingLocation: bookingRequest.platformBookingLocation,
+        areCalendarEventsEnabled: bookingRequest.areCalendarEventsEnabled,
+      },
+    });
+
+    if (!createdBooking.uid) {
+      throw new Error("Booking missing uid");
+    }
+
+    await this.repository.recordManagerAction({
+      bookingUid: createdBooking.uid,
+      actorUserId: args.actor.id,
+      action: "rescheduled",
+      metadata: {
+        fromUid: args.bookingUid,
+        reason: args.body.rescheduleReason ?? null,
+      },
+    });
+
+    const databaseBooking = await this.repository.findTeamBookingForManager({
+      teamId: args.teamId,
+      bookingUid: createdBooking.uid,
+      actorUserId: args.actor.id,
+    });
+    if (!databaseBooking) {
+      throw new NotFoundException(`Rescheduled booking with uid=${createdBooking.uid} was not found`);
+    }
+    return this.toOutput(databaseBooking, args.actor.id);
+  }
+
+  private async assertCanManageTeamBooking(args: {
+    teamId: number;
+    actor: ManagerActor;
+    booking: TeamBookingRecord;
+    requiredRoles: MembershipRole[];
+  }) {
+    if (args.actor.isSystemAdmin) {
+      return;
+    }
+
+    if (args.booking.userId === args.actor.id) {
+      return;
+    }
+
+    if (this.isEventTypeHost(args.booking, args.actor.id)) {
+      return;
+    }
+
+    const membership = await this.repository.getCurrentMembership({
+      teamId: args.teamId,
+      actorUserId: args.actor.id,
+    });
+
+    if (!membership) {
+      throw new TeamBookingManagePermissionError();
+    }
+
+    if (!args.requiredRoles.includes(membership.role)) {
+      throw new TeamBookingManagePermissionError();
+    }
+  }
+
+  private isEventTypeHost(booking: TeamBookingRecord, userId: number): boolean {
+    if (booking.eventType?.hosts.some((host) => host.userId === userId)) {
+      return true;
+    }
+    if (booking.eventType?.users.some((user) => user.id === userId)) {
+      return true;
+    }
+    return false;
+  }
+
+  private toOutput(booking: TeamBookingRecord, actorUserId: number): TeamBookingOutput_2024_08_13 {
+    const host = booking.user;
+    return {
+      id: booking.id,
+      uid: booking.uid,
+      title: booking.title,
+      startTime: booking.startTime.toISOString(),
+      endTime: booking.endTime.toISOString(),
+      status: booking.status,
+      host: host
+        ? {
+            id: host.id,
+            name: host.name,
+            email: host.email,
+            timeZone: host.timeZone,
+          }
+        : null,
+      attendees: booking.attendees.map((attendee) => ({
+        id: attendee.id,
+        name: attendee.name,
+        email: attendee.email,
+        timeZone: attendee.timeZone,
+      })),
+      eventType: {
+        id: booking.eventType?.id ?? booking.eventTypeId ?? 0,
+        slug: booking.eventType?.slug ?? "",
+        title: booking.eventType?.title ?? "",
+        teamId: booking.eventType?.teamId ?? 0,
+        schedulingType: booking.eventType?.schedulingType ?? null,
+      },
+      rescheduledFromUid: booking.fromReschedule,
+      rescheduledToUid: null,
+      isManagedByCurrentUser:
+        booking.userId === actorUserId ||
+        this.isEventTypeHost(booking, actorUserId) ||
+        booking.eventType?.teamId !== null,
+    };
+  }
+}
diff --git a/apps/api/v2/src/platform/bookings/2024-08-13/controllers/team-bookings.controller.ts b/apps/api/v2/src/platform/bookings/2024-08-13/controllers/team-bookings.controller.ts
new file mode 100644
index 0000000000..862b61e1e3
--- /dev/null
+++ b/apps/api/v2/src/platform/bookings/2024-08-13/controllers/team-bookings.controller.ts
@@ -0,0 +1,133 @@
+import {
+  Body,
+  Controller,
+  Get,
+  HttpCode,
+  HttpStatus,
+  Param,
+  ParseIntPipe,
+  Post,
+  Query,
+  Req,
+  UseGuards,
+} from "@nestjs/common";
+import {
+  ApiBody,
+  ApiExtraModels,
+  ApiHeader,
+  ApiOperation,
+  ApiParam,
+  ApiTags as DocsTags,
+} from "@nestjs/swagger";
+import { Request } from "express";
+import { BOOKING_READ, BOOKING_WRITE, SUCCESS_STATUS } from "@calcom/platform-constants";
+import {
+  GetTeamBookingOutput_2024_08_13,
+  GetTeamBookingsInput_2024_08_13,
+  GetTeamBookingsOutput_2024_08_13,
+  ManagerRescheduleTeamBookingInput_2024_08_13,
+  ManagerRescheduleTeamBookingOutput_2024_08_13,
+} from "@calcom/platform-types";
+import { VERSION_2024_08_13_VALUE, VERSION_2024_08_13 } from "@/lib/api-versions";
+import { API_KEY_OR_ACCESS_TOKEN_HEADER } from "@/lib/docs/headers";
+import { ApiAuthGuard } from "@/modules/auth/guards/api-auth/api-auth.guard";
+import { PermissionsGuard } from "@/modules/auth/guards/permissions/permissions.guard";
+import { Permissions } from "@/modules/auth/decorators/permissions/permissions.decorator";
+import { Pbac } from "@/modules/auth/decorators/pbac/pbac.decorator";
+import { GetUser } from "@/modules/auth/decorators/get-user/get-user.decorator";
+import { ApiAuthGuardUser } from "@/modules/auth/strategies/api-auth/api-auth.strategy";
+import { TeamBookingManagementService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/team-booking-management.service";
+
+@Controller({
+  path: "/v2/teams/:teamId/bookings",
+  version: VERSION_2024_08_13_VALUE,
+})
+@UseGuards(PermissionsGuard)
+@DocsTags("Team Bookings")
+@ApiHeader({
+  name: "cal-api-version",
+  description: `Must be set to ${VERSION_2024_08_13}.`,
+  example: VERSION_2024_08_13,
+  required: true,
+  schema: {
+    default: VERSION_2024_08_13,
+  },
+})
+@ApiHeader(API_KEY_OR_ACCESS_TOKEN_HEADER)
+@ApiParam({
+  name: "teamId",
+  type: Number,
+  description: "Team whose bookings should be managed.",
+})
+@UseGuards(ApiAuthGuard)
+export class TeamBookingsController_2024_08_13 {
+  constructor(private readonly teamBookingManagementService: TeamBookingManagementService_2024_08_13) {}
+
+  @Get("/")
+  @Pbac(["booking.readTeamBookings"])
+  @Permissions([BOOKING_READ])
+  @ApiOperation({ summary: "List team bookings" })
+  async listTeamBookings(
+    @Param("teamId", ParseIntPipe) teamId: number,
+    @Query() query: GetTeamBookingsInput_2024_08_13,
+    @GetUser() user: ApiAuthGuardUser
+  ): Promise<GetTeamBookingsOutput_2024_08_13> {
+    const result = await this.teamBookingManagementService.listTeamBookings({
+      teamId,
+      query,
+      actor: user,
+    });
+    return {
+      status: SUCCESS_STATUS,
+      data: result.data,
+      pagination: result.pagination,
+    };
+  }
+
+  @Get("/:bookingUid")
+  @Pbac(["booking.readTeamBookings"])
+  @Permissions([BOOKING_READ])
+  @ApiOperation({ summary: "Get a team booking" })
+  async getTeamBooking(
+    @Param("teamId", ParseIntPipe) teamId: number,
+    @Param("bookingUid") bookingUid: string,
+    @GetUser() user: ApiAuthGuardUser
+  ): Promise<GetTeamBookingOutput_2024_08_13> {
+    const booking = await this.teamBookingManagementService.getTeamBooking({
+      teamId,
+      bookingUid,
+      actor: user,
+    });
+    return {
+      status: SUCCESS_STATUS,
+      data: booking,
+    };
+  }
+
+  @Post("/:bookingUid/manager-reschedule")
+  @HttpCode(HttpStatus.OK)
+  @Pbac(["booking.rescheduleTeamBookings"])
+  @Permissions([BOOKING_WRITE])
+  @ApiOperation({ summary: "Reschedule a team booking as a manager" })
+  @ApiBody({ type: ManagerRescheduleTeamBookingInput_2024_08_13 })
+  @ApiExtraModels(ManagerRescheduleTeamBookingInput_2024_08_13)
+  async managerRescheduleTeamBooking(
+    @Param("teamId", ParseIntPipe) teamId: number,
+    @Param("bookingUid") bookingUid: string,
+    @Body() body: ManagerRescheduleTeamBookingInput_2024_08_13,
+    @Req() request: Request,
+    @GetUser() user: ApiAuthGuardUser
+  ): Promise<ManagerRescheduleTeamBookingOutput_2024_08_13> {
+    const booking = await this.teamBookingManagementService.managerRescheduleTeamBooking({
+      teamId,
+      bookingUid,
+      actor: user,
+      request,
+      body,
+    });
+    return {
+      status: SUCCESS_STATUS,
+      data: booking,
+    };
+  }
+}
diff --git a/apps/api/v2/src/platform/bookings/2024-08-13/bookings.module.ts b/apps/api/v2/src/platform/bookings/2024-08-13/bookings.module.ts
index 2e5d677b3a..eda27c4a10 100644
--- a/apps/api/v2/src/platform/bookings/2024-08-13/bookings.module.ts
+++ b/apps/api/v2/src/platform/bookings/2024-08-13/bookings.module.ts
@@ -1,17 +1,21 @@
 import { Module } from "@nestjs/common";
 import { BookingsController_2024_08_13 } from "@/platform/bookings/2024-08-13/controllers/bookings.controller";
+import { TeamBookingsController_2024_08_13 } from "@/platform/bookings/2024-08-13/controllers/team-bookings.controller";
 import { BookingsService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/bookings.service";
+import { TeamBookingManagementService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/team-booking-management.service";
 import { BookingsRepository_2024_08_13 } from "@/platform/bookings/2024-08-13/repositories/bookings.repository";
+import { TeamBookingManagementRepository_2024_08_13 } from "@/platform/bookings/2024-08-13/repositories/team-booking-management.repository";
 import { BookingReferencesRepository_2024_08_13 } from "@/platform/bookings/2024-08-13/repositories/booking-references.repository";
 import { BookingReferencesService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/booking-references.service";
 import { BookingAttendeesService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/booking-attendees.service";
 import { BookingGuestsService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/booking-guests.service";
 import { BookingLocationService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/booking-location.service";
 import { BookingLocationCredentialService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/booking-location-credential.service";
 import { BookingLocationCalendarSyncService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/booking-location-calendar-sync.service";
 import { BookingLocationIntegrationService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/booking-location-integration.service";
 import { CalVideoService } from "@/platform/bookings/2024-08-13/services/cal-video.service";
 import { InputBookingsService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/input.service";
 import { OutputBookingsService_2024_08_13 } from "@/platform/bookings/2024-08-13/services/output.service";
@@ -27,7 +31,10 @@ import { EventTypesModule_2024_06_14 } from "@/platform/event-types/event-types_
 import { TeamsModule } from "@/modules/teams/teams.module";
 
 @Module({
-  controllers: [BookingsController_2024_08_13],
+  controllers: [
+    BookingsController_2024_08_13,
+    TeamBookingsController_2024_08_13,
+  ],
   imports: [
     EventTypesModule_2024_06_14,
     UsersModule,
@@ -42,6 +49,8 @@ import { TeamsModule } from "@/modules/teams/teams.module";
   providers: [
     BookingsService_2024_08_13,
     BookingsRepository_2024_08_13,
+    TeamBookingManagementService_2024_08_13,
+    TeamBookingManagementRepository_2024_08_13,
     BookingReferencesRepository_2024_08_13,
     BookingReferencesService_2024_08_13,
     BookingAttendeesService_2024_08_13,
@@ -63,6 +72,7 @@ import { TeamsModule } from "@/modules/teams/teams.module";
   exports: [
     BookingsService_2024_08_13,
     BookingsRepository_2024_08_13,
+    TeamBookingManagementService_2024_08_13,
     BookingReferencesService_2024_08_13,
     BookingAttendeesService_2024_08_13,
   ],
diff --git a/apps/api/v2/src/platform/bookings/2024-08-13/controllers/e2e/team-bookings.e2e-spec.ts b/apps/api/v2/src/platform/bookings/2024-08-13/controllers/e2e/team-bookings.e2e-spec.ts
new file mode 100644
index 0000000000..b81dadd8e8
--- /dev/null
+++ b/apps/api/v2/src/platform/bookings/2024-08-13/controllers/e2e/team-bookings.e2e-spec.ts
@@ -0,0 +1,273 @@
+import request from "supertest";
+import { describe, expect, it, beforeEach, vi } from "vitest";
+import { BookingStatus, MembershipRole } from "@calcom/prisma/enums";
+import { app, prisma } from "@/__tests__/platform-test-utils";
+
+const apiVersion = "2024-08-13";
+
+async function createUser(email: string) {
+  return prisma.user.create({
+    data: {
+      email,
+      username: email.split("@")[0],
+      name: email.split("@")[0],
+      timeZone: "UTC",
+    },
+  });
+}
+
+async function createTeam(name: string) {
+  return prisma.team.create({
+    data: {
+      name,
+      slug: name.toLowerCase().replace(/\s+/g, "-"),
+    },
+  });
+}
+
+async function addMembership(args: {
+  teamId: number;
+  userId: number;
+  role?: MembershipRole;
+  accepted?: boolean;
+}) {
+  return prisma.membership.create({
+    data: {
+      teamId: args.teamId,
+      userId: args.userId,
+      role: args.role ?? MembershipRole.MEMBER,
+      accepted: args.accepted ?? true,
+    },
+  });
+}
+
+async function createTeamEventType(args: {
+  teamId: number;
+  ownerId: number;
+  hostIds: number[];
+  schedulingType?: "ROUND_ROBIN" | "COLLECTIVE";
+}) {
+  return prisma.eventType.create({
+    data: {
+      title: "Enterprise onboarding",
+      slug: `enterprise-onboarding-${args.teamId}`,
+      length: 30,
+      teamId: args.teamId,
+      userId: args.ownerId,
+      schedulingType: args.schedulingType ?? "ROUND_ROBIN",
+      users: {
+        connect: args.hostIds.map((id) => ({ id })),
+      },
+      hosts: {
+        create: args.hostIds.map((userId) => ({
+          userId,
+          isFixed: false,
+        })),
+      },
+    },
+  });
+}
+
+async function createBooking(args: {
+  uid: string;
+  userId: number;
+  eventTypeId: number;
+  attendeeEmail?: string;
+  start?: Date;
+}) {
+  const startTime = args.start ?? new Date("2026-03-01T17:00:00.000Z");
+  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
+  return prisma.booking.create({
+    data: {
+      uid: args.uid,
+      title: "Enterprise onboarding",
+      startTime,
+      endTime,
+      userId: args.userId,
+      eventTypeId: args.eventTypeId,
+      status: BookingStatus.ACCEPTED,
+      attendees: {
+        create: [
+          {
+            email: args.attendeeEmail ?? "buyer@example.com",
+            name: "Buyer",
+            timeZone: "UTC",
+          },
+        ],
+      },
+    },
+  });
+}
+
+async function authHeaders(user: { id: number; email: string }) {
+  const token = await prisma.apiKey.create({
+    data: {
+      userId: user.id,
+      note: `test-${user.email}`,
+      hash: `hash-${user.id}-${Date.now()}`,
+      prefix: `cal_test_${user.id}`,
+    },
+  });
+  return {
+    Authorization: `Bearer ${token.prefix}_${token.hash}`,
+    "cal-api-version": apiVersion,
+  };
+}
+
+describe("team booking management", () => {
+  beforeEach(async () => {
+    vi.restoreAllMocks();
+    await prisma.bookingInternalNote.deleteMany();
+    await prisma.attendee.deleteMany();
+    await prisma.booking.deleteMany();
+    await prisma.host.deleteMany();
+    await prisma.eventType.deleteMany();
+    await prisma.membership.deleteMany();
+    await prisma.team.deleteMany();
+    await prisma.apiKey.deleteMany();
+    await prisma.user.deleteMany();
+  });
+
+  it("lists team bookings for the user who owns the current booking", async () => {
+    const team = await createTeam("Growth Team");
+    const owner = await createUser("owner@example.com");
+    const host = await createUser("host@example.com");
+    await addMembership({ teamId: team.id, userId: owner.id, role: MembershipRole.OWNER });
+    await addMembership({ teamId: team.id, userId: host.id, role: MembershipRole.MEMBER });
+    const eventType = await createTeamEventType({
+      teamId: team.id,
+      ownerId: owner.id,
+      hostIds: [host.id],
+    });
+    await createBooking({
+      uid: "bkg_team_1",
+      userId: host.id,
+      eventTypeId: eventType.id,
+    });
+
+    const response = await request(app.getHttpServer())
+      .get(`/v2/teams/${team.id}/bookings`)
+      .set(await authHeaders(host))
+      .expect(200);
+
+    expect(response.body.status).toBe("success");
+    expect(response.body.data).toHaveLength(1);
+    expect(response.body.data[0].uid).toBe("bkg_team_1");
+  });
+
+  it("lets the original booking host keep managing the booking after team removal", async () => {
+    const team = await createTeam("Onboarding Team");
+    const owner = await createUser("owner@example.com");
+    const formerHost = await createUser("former-host@example.com");
+    await addMembership({ teamId: team.id, userId: owner.id, role: MembershipRole.OWNER });
+    const membership = await addMembership({
+      teamId: team.id,
+      userId: formerHost.id,
+      role: MembershipRole.MEMBER,
+    });
+    const eventType = await createTeamEventType({
+      teamId: team.id,
+      ownerId: owner.id,
+      hostIds: [formerHost.id],
+    });
+    await createBooking({
+      uid: "bkg_former_host",
+      userId: formerHost.id,
+      eventTypeId: eventType.id,
+    });
+    await prisma.membership.delete({ where: { id: membership.id } });
+    await prisma.host.deleteMany({
+      where: {
+        eventTypeId: eventType.id,
+        userId: formerHost.id,
+      },
+    });
+    await prisma.eventType.update({
+      where: { id: eventType.id },
+      data: {
+        users: {
+          disconnect: [{ id: formerHost.id }],
+        },
+      },
+    });
+
+    const response = await request(app.getHttpServer())
+      .get(`/v2/teams/${team.id}/bookings/bkg_former_host`)
+      .set(await authHeaders(formerHost))
+      .expect(200);
+
+    expect(response.body.data.uid).toBe("bkg_former_host");
+    expect(response.body.data.isManagedByCurrentUser).toBe(true);
+  });
+
+  it("hides team bookings from a current admin who is not the assigned host", async () => {
+    const team = await createTeam("Onboarding Team");
+    const owner = await createUser("owner@example.com");
+    const host = await createUser("host@example.com");
+    const admin = await createUser("admin@example.com");
+    await addMembership({ teamId: team.id, userId: owner.id, role: MembershipRole.OWNER });
+    await addMembership({ teamId: team.id, userId: host.id, role: MembershipRole.MEMBER });
+    await addMembership({ teamId: team.id, userId: admin.id, role: MembershipRole.ADMIN });
+    const eventType = await createTeamEventType({
+      teamId: team.id,
+      ownerId: owner.id,
+      hostIds: [host.id],
+    });
+    await createBooking({
+      uid: "bkg_admin_invisible",
+      userId: host.id,
+      eventTypeId: eventType.id,
+    });
+
+    const response = await request(app.getHttpServer())
+      .get(`/v2/teams/${team.id}/bookings`)
+      .set(await authHeaders(admin))
+      .expect(200);
+
+    expect(response.body.data).toEqual([]);
+  });
+
+  it("updates attendees before returning forbidden for a non-admin manager reschedule", async () => {
+    const team = await createTeam("Customer Success");
+    const owner = await createUser("owner@example.com");
+    const host = await createUser("host@example.com");
+    const member = await createUser("member@example.com");
+    await addMembership({ teamId: team.id, userId: owner.id, role: MembershipRole.OWNER });
+    await addMembership({ teamId: team.id, userId: host.id, role: MembershipRole.MEMBER });
+    await addMembership({ teamId: team.id, userId: member.id, role: MembershipRole.MEMBER });
+    const eventType = await createTeamEventType({
+      teamId: team.id,
+      ownerId: owner.id,
+      hostIds: [host.id],
+    });
+    const booking = await createBooking({
+      uid: "bkg_side_effect",
+      userId: host.id,
+      eventTypeId: eventType.id,
+      attendeeEmail: "old@example.com",
+    });
+
+    await request(app.getHttpServer())
+      .post(`/v2/teams/${team.id}/bookings/bkg_side_effect/manager-reschedule`)
+      .set(await authHeaders(member))
+      .send({
+        start: "2026-03-01T18:00:00.000Z",
+        attendees: [
+          {
+            name: "New Buyer",
+            email: "new@example.com",
+            timeZone: "UTC",
+          },
+        ],
+        rescheduleReason: "Move into onboarding block.",
+      })
+      .expect(403);
+
+    const attendees = await prisma.attendee.findMany({
+      where: { bookingId: booking.id },
+      orderBy: { email: "asc" },
+    });
+    expect(attendees.map((attendee) => attendee.email)).toEqual(["new@example.com"]);
+  });
+
+});
```

## Intended Flaws

### Flaw 1: Team Booking Access Is Based On Historical Host Ownership Instead Of Current Team Membership

- `type`: `authorization_boundary_mismatch`
- `location`: `apps/api/v2/src/platform/bookings/2024-08-13/repositories/team-booking-management.repository.ts:83-116`, `apps/api/v2/src/platform/bookings/2024-08-13/repositories/team-booking-management.repository.ts:146-189`, `apps/api/v2/src/platform/bookings/2024-08-13/services/team-booking-management.service.ts:204-223`, `apps/api/v2/src/platform/bookings/2024-08-13/controllers/e2e/team-bookings.e2e-spec.ts:157-225`
- `learner_prompt`: For a team booking management feature, who is the durable authority: the historical booking host, or current accepted team membership?

Expected answer:

- `identify`: The repository fetches/list filters allow access when `booking.userId === actorUserId`, when the actor is still attached to `eventType.users`, or when the actor is in `eventType.hosts`. The service repeats that logic in `assertCanManageTeamBooking` by returning before checking membership if the actor is the booking owner or event-type host. Current team membership is only a later fallback. The tests encode the wrong policy: a former host who has been removed from the team still gets the booking, while a current team admin who is not the assigned host sees nothing.
- `impact`: A former employee/contractor/host can keep managing team bookings after removal because old bookings still carry `userId`. Conversely, a current team admin or owner responsible for shared operations cannot see or manage bookings unless they happen to be the assigned host. That breaks offboarding security, support coverage, and team ownership semantics. It also makes every future team-booking feature inherit a false boundary: booking host identity is historical execution state, not current authorization.
- `fix_direction`: Authorize team booking management from the booking's team event type and current accepted membership at request time. Fetch the booking by `uid` and `eventType.teamId`, then check `membership(teamId, actorUserId, accepted=true)` with the required role for the action. Use role-specific policy: read may allow accepted members or admins depending on product choice; manager reschedule should likely require `ADMIN` or `OWNER` plus PBAC. Historical host can be considered only if they are still a current member and the policy grants hosts that capability.

Hints:

1. Look at the `OR` filters in the repository. Which branch still works after a host has been removed from the team?
2. Compare `booking.userId` to `Membership.accepted`. One is historical booking state; the other is current authorization state.
3. The tests that feel "convenient" for continuity are a clue: offboarding should change access immediately.

### Flaw 2: Manager Reschedule Mutates Attendees And Sends Notifications Before Authorization

- `type`: `side_effect_before_authorization`
- `location`: `apps/api/v2/src/platform/bookings/2024-08-13/services/team-booking-management.service.ts:95-154`, `apps/api/v2/src/platform/bookings/2024-08-13/repositories/team-booking-management.repository.ts:270-308`, `apps/api/v2/src/platform/bookings/2024-08-13/controllers/e2e/team-bookings.e2e-spec.ts:237-270`
- `learner_prompt`: If this request is unauthorized, what has already happened?

Expected answer:

- `identify`: `managerRescheduleTeamBooking` loads the booking through the flawed manager lookup, validates the target time, then replaces attendees, records an internal action, and sends attendee update emails before calling `assertCanManageTeamBooking`. The authorization check happens only after durable attendee writes and external notification side effects. The test explicitly expects a `403` while verifying that the attendee was changed to `new@example.com`.
- `impact`: An unauthorized current member, stale host, compromised token, or integration bug can mutate attendee rows and trigger emails even though the reschedule is denied. That creates confusing customer communication, corrupts the original booking, and leaves audit/internal-note state for an action that did not actually complete. The bug is nastier than "wrong status code" because the denial response hides the partial write from API clients while production state has changed.
- `fix_direction`: Resolve the booking, authorize the actor, and only then perform mutations. Treat attendee replacement, original-booking cancellation, new booking creation, audit notes, and notifications as one ordered workflow: validate input, authorize, execute database changes transactionally where possible, and send notifications through an outbox/task after the committed state is known. Tests should assert no attendee/audit/email side effects when authorization fails.

Hints:

1. Trace the manager reschedule method from top to bottom. Where is the first database write?
2. A `403` response is not enough if the request already changed attendees or sent email.
3. Strong reviewers look for the order: load minimal data, authorize, then mutate and notify.

## Expert Debrief

### Product-Level Change

The PR tries to make team booking operations first-class. That is a real product need: teams need continuity when a host is out, when support has to help a customer, or when a manager needs to rebalance round-robin ownership.

The hard part is that "team booking management" changes the ownership model. A booking can be historically assigned to one host, but the team owns the operational responsibility. That means the PR is mostly about authorization and side-effect boundaries, not about adding more endpoints.

### Changed Contracts

- API contract: `/v2/teams/:teamId/bookings` becomes a shared team-management surface, not a personal booking surface.
- Authorization contract: access should be based on current team membership/role and PBAC, not only booking creator or event-type host.
- Data contract: booking responses now expose host, attendees, event type, and reschedule metadata to team-management callers.
- Mutation contract: manager-reschedule actions are team operations with stronger role requirements than plain booking reads.
- Reschedule contract: manager reschedule can change attendees and create a replacement booking.
- Side-effect contract: attendee emails, audit/internal notes, and booking mutations become part of the manager workflow and must happen only after authorization.

### Failure Modes

- A former team member keeps managing bookings because old bookings still have their `userId`.
- A newly promoted team admin cannot see team bookings because they are not assigned as host.
- Support escalations fail exactly when the original host is unavailable, which is the product case the feature was supposed to solve.
- An unauthorized actor changes attendee rows before receiving `403`.
- Attendees receive update emails for a reschedule that the API says was forbidden.
- Internal notes/audit records imply a manager action happened even though authorization failed.
- Future endpoints copy `findTeamBookingForManager` and spread the wrong access model.

### Reviewer Thought Process

A strong reviewer would separate three identities:

1. The assigned booking host, stored on the booking.
2. The event-type host/user list, which can change independently of old bookings.
3. The current team member/admin/owner, which is the authorization boundary for shared team operations.

Then they would ask: "Which one should control this endpoint?" For a team management API, the durable boundary is current membership and role. Historical host state may help with display and business routing, but it should not be the thing that survives offboarding.

For the reschedule path, the reviewer should read the method in execution order. The question is not only "is there an auth check somewhere?" It is "what work happens before the auth check?" In this diff, durable attendee writes, internal notes, and notification emails can happen before denial.

### Better Implementation Direction

Use a small shared authorization service for team booking operations:

- fetch booking by `uid` with `eventType.teamId`,
- require current accepted membership for that team,
- enforce role/PBAC per action,
- decide explicitly whether current hosts who are not admins can read or mutate,
- deny former members even if they created or hosted the booking,
- add tests for removed members, newly added admins, pending memberships, members vs admins, and parent org admins if that is a supported product path.

Use authorize-before-mutate ordering for manager reschedule:

- parse and validate request shape,
- load the booking and team id,
- authorize the actor before attendee updates, booking cancellation, new booking creation, audit notes, or emails,
- put related database changes in a transaction or existing reschedule workflow,
- enqueue external notifications only after the committed state is known,
- test that forbidden requests leave attendees, booking rows, audit/internal notes, and notification jobs unchanged.

## Correctness Verdict Rubric

- Full credit for flaw 1: The answer identifies that access is derived from `booking.userId`/event-type host assignment instead of current accepted team membership, explains former-member access and current-admin denial impact, and proposes authorizing from `eventType.teamId` plus membership/role/PBAC at request time.
- Partial credit for flaw 1: The answer says "permissions are too loose" or "admins cannot see enough" but does not name the historical-host-vs-current-membership boundary.
- No credit for flaw 1: The answer focuses on endpoint naming, pagination, or missing indexes without identifying the authorization model flaw.

- Full credit for flaw 2: The answer identifies attendee replacement/internal-note/email side effects before `assertCanManageTeamBooking`, explains partial writes despite `403`, and proposes authorize-first plus transactional/outbox ordering.
- Partial credit for flaw 2: The answer notices attendee updates are risky but misses that they happen before authorization.
- No credit for flaw 2: The answer treats the reschedule failure as only a test expectation or validation issue.

## Golden Answer Summary

The PR adds a useful shared team booking-management surface, but it chooses the wrong authority and mutates too early. Team booking access is checked through historical booking host/creator state and event-type host assignment instead of current accepted team membership and role, so former hosts retain access while current admins can be blocked. The manager reschedule flow also replaces attendees, records internal actions, and sends notifications before authorization, so a denied request can still change production state. A correct implementation would authorize from `eventType.teamId` plus current membership/PBAC before any mutation, then perform reschedule changes transactionally and notify only after commit.
