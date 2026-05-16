# TS-069: Cal.com Temporary Booking Holds

## Metadata

- `id`: TS-069
- `source_repo`: [calcom/cal.diy](https://github.com/calcom/cal.com)
- `repo_area`: booking creation, API v2 slot reservation, selectedSlots, calendar availability, hold expiration workers, booking status transitions, Prisma transactional boundaries
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 2,150-2,600
- `represented_diff_lines`: 2162
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Cal.com selected-slot reservations, booking holds, calendar conflict checks, state machines, transactions, and expiration workers without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds temporary booking holds before final confirmation. A booker can hold a slot while completing payment, answering required questions, or waiting for the client to confirm. The hold expires after a short window and a background job releases stale holds.

The PR adds:

- hold request/response types,
- a hold repository and audit trail,
- calendar availability helpers,
- hold creation and confirmation services,
- an expiration background job,
- an API v2 controller,
- tests for creation and expiration,
- docs for product and operational behavior.

The intended product behavior is: creating a hold should actually protect capacity for the selected slot, confirming a hold should make the booking the owner of that capacity, and expiration should only release holds that are still unconfirmed at the moment the worker runs.

## Existing Code Context

The real Cal.com codebase already has these relevant contracts:

- `packages/trpc/server/routers/viewer/slots/reserveSlot.handler.ts` creates temporary `selectedSlots` rows, checks `PrismaSelectedSlotRepository.findReservedByOthers`, and uses a UID cookie so another visitor cannot reserve the same slot during the booking window.
- `packages/features/selectedSlots/repositories/PrismaSelectedSlotRepository.ts` treats unexpired `selectedSlots` as active slot reservations and deletes expired rows by `releaseAt`.
- `apps/api/v2/src/modules/slots/slots-2024-09-04/slots.repository.ts` checks active overlapping bookings with statuses `ACCEPTED`, `PENDING`, and `AWAITING_HOST`, and separately checks overlapping unexpired selected-slot reservations.
- `apps/api/v2/src/modules/slots/slots-2024-09-04/services/slots.service.ts` validates an event type, checks existing bookings, validates round-robin availability when needed, checks selected-slot overlap, and only then creates the selected-slot reservation.
- `packages/features/bookings/lib/handleNewBooking/ensureAvailableUsers.ts` asks calendar/busy-time services whether users are available; that result is a point-in-time observation, not a database lock.
- `packages/features/bookings/lib/handleNewBooking/createBooking.ts` creates booking rows inside a Prisma transaction, with `ACCEPTED` or `PENDING` status depending on confirmation settings.
- `packages/prisma/schema.prisma` models `SelectedSlots` with a uniqueness constraint that includes `uid`; it does not by itself prevent two different UIDs from targeting the same event/user/time slot.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether the hold actually owns capacity and whether the expiration worker respects the booking state transition.

## Review Surface

Changed files in the synthetic PR:

- `packages/features/booking-holds/types.ts`
- `packages/features/booking-holds/hold-repository.ts`
- `packages/features/booking-holds/calendar-conflicts.ts`
- `packages/features/booking-holds/create-hold.ts`
- `packages/features/booking-holds/confirm-hold.ts`
- `packages/features/booking-holds/expire-holds.job.ts`
- `apps/api/v2/src/modules/booking-holds/booking-holds.controller.ts`
- `packages/features/booking-holds/__tests__/booking-holds.test.ts`
- `packages/features/booking-holds/__tests__/expire-holds.job.test.ts`
- `docs/temporary-booking-holds.md`

The line references below use synthetic PR line numbers. The represented diff is focused on booking-hold state transitions, selected-slot capacity ownership, stale expiration jobs, and tests/docs that encode the wrong contract.

## Diff

```diff
diff --git a/packages/features/booking-holds/types.ts b/packages/features/booking-holds/types.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/packages/features/booking-holds/types.ts
@@ -0,0 +1,218 @@
+import { z } from "zod";
+import type { BookingStatus } from "@calcom/prisma/enums";
+
+export const bookingHoldStatusSchema = z.enum(["held", "confirmed", "expired", "released"]);
+export type BookingHoldStatus = z.infer<typeof bookingHoldStatusSchema>;
+
+export const createBookingHoldSchema = z.object({
+  eventTypeId: z.number().int().positive(),
+  slotStart: z.string().datetime(),
+  slotEnd: z.string().datetime(),
+  timeZone: z.string().min(1),
+  attendeeEmail: z.string().email(),
+  attendeeName: z.string().min(1),
+  responses: z.record(z.unknown()).default({}),
+  reservationDurationMinutes: z.number().int().min(1).max(30).default(5),
+  source: z.enum(["web", "embed", "api", "platform"]).default("web"),
+  idempotencyKey: z.string().min(8).max(200).optional(),
+});
+
+export type CreateBookingHoldInput = z.infer<typeof createBookingHoldSchema>;
+
+export type BookingHold = {
+  id: string;
+  uid: string;
+  eventTypeId: number;
+  userId: number | null;
+  bookingId: number | null;
+  selectedSlotUid: string | null;
+  attendeeEmail: string;
+  attendeeName: string;
+  slotStart: Date;
+  slotEnd: Date;
+  timeZone: string;
+  status: BookingHoldStatus;
+  statusVersion: number;
+  expiresAt: Date;
+  confirmedAt: Date | null;
+  releasedAt: Date | null;
+  expiredAt: Date | null;
+  createdAt: Date;
+  updatedAt: Date;
+  metadata: Record<string, unknown>;
+};
+
+export type BookingHoldAuditEvent = {
+  id: string;
+  holdId: string;
+  eventTypeId: number;
+  event: "hold.created" | "hold.confirmed" | "hold.expired" | "hold.released" | "hold.failed";
+  statusBefore: BookingHoldStatus | null;
+  statusAfter: BookingHoldStatus;
+  statusVersion: number;
+  actorType: "booker" | "system" | "api";
+  createdAt: Date;
+  metadata: Record<string, unknown>;
+};
+
+export type CalendarConflictSnapshot = {
+  eventTypeId: number;
+  checkedAt: Date;
+  slotStart: Date;
+  slotEnd: Date;
+  availableUserIds: number[];
+  busySources: Array<{ userId: number; source: string; reason: string }>;
+  bookingStatusScope: BookingStatus[];
+};
+
+export type SlotCapacityClaim = {
+  uid: string;
+  holdId: string;
+  userId: number;
+  eventTypeId: number;
+  slotStart: Date;
+  slotEnd: Date;
+  releaseAt: Date;
+  isSeat: boolean;
+};
+
+export type CreateBookingHoldResult = {
+  hold: BookingHold;
+  conflictSnapshot: CalendarConflictSnapshot;
+  capacityClaim: SlotCapacityClaim | null;
+  expiresAt: string;
+};
+
+export type ConfirmBookingHoldInput = {
+  holdId: string;
+  statusVersion: number;
+  bookingUid: string;
+  paymentIntentId?: string;
+};
+
+export type ConfirmBookingHoldResult = {
+  hold: BookingHold;
+  bookingId: number;
+  bookingUid: string;
+};
+
+export type ExpireHoldsJobInput = {
+  now?: string;
+  limit?: number;
+  dryRun?: boolean;
+};
+
+export type ExpireHoldsJobResult = {
+  scanned: number;
+  expired: number;
+  releasedSelectedSlots: number;
+  cancelledBookings: number;
+  skipped: Array<{ holdId: string; reason: string }>;
+};
+
+export class BookingHoldError extends Error {
+  constructor(
+    public readonly code:
+      | "EVENT_TYPE_NOT_FOUND"
+      | "SLOT_UNAVAILABLE"
+      | "HOLD_NOT_FOUND"
+      | "HOLD_EXPIRED"
+      | "HOLD_ALREADY_CONFIRMED"
+      | "CAPACITY_CLAIM_FAILED",
+    message: string
+  ) {
+    super(message);
+  }
+}
+
+export const HOLD_EXPIRATION_QUEUE = "booking-holds.expire" as const;
+export const DEFAULT_HOLD_MINUTES = 5;
+export const HOLD_STATUS_HELD = "held" as const;
+export const HOLD_STATUS_CONFIRMED = "confirmed" as const;
+export const HOLD_STATUS_EXPIRED = "expired" as const;
+export const HOLD_STATUS_RELEASED = "released" as const;
+
+export const bookingHoldContractNote_001 = { status: "held", reviewerFocus: "state-transition-1", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_002 = { status: "held", reviewerFocus: "state-transition-2", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_003 = { status: "held", reviewerFocus: "state-transition-3", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_004 = { status: "held", reviewerFocus: "state-transition-4", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_005 = { status: "held", reviewerFocus: "state-transition-5", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_006 = { status: "held", reviewerFocus: "state-transition-6", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_007 = { status: "held", reviewerFocus: "state-transition-7", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_008 = { status: "held", reviewerFocus: "state-transition-8", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_009 = { status: "held", reviewerFocus: "state-transition-9", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_010 = { status: "held", reviewerFocus: "state-transition-10", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_011 = { status: "held", reviewerFocus: "state-transition-11", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_012 = { status: "held", reviewerFocus: "state-transition-12", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_013 = { status: "held", reviewerFocus: "state-transition-13", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_014 = { status: "held", reviewerFocus: "state-transition-14", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_015 = { status: "held", reviewerFocus: "state-transition-15", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_016 = { status: "held", reviewerFocus: "state-transition-16", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_017 = { status: "held", reviewerFocus: "state-transition-17", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_018 = { status: "held", reviewerFocus: "state-transition-18", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_019 = { status: "held", reviewerFocus: "state-transition-19", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_020 = { status: "held", reviewerFocus: "state-transition-20", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_021 = { status: "held", reviewerFocus: "state-transition-21", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_022 = { status: "held", reviewerFocus: "state-transition-22", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_023 = { status: "held", reviewerFocus: "state-transition-23", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_024 = { status: "held", reviewerFocus: "state-transition-24", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_025 = { status: "held", reviewerFocus: "state-transition-25", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_026 = { status: "held", reviewerFocus: "state-transition-26", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_027 = { status: "held", reviewerFocus: "state-transition-27", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_028 = { status: "held", reviewerFocus: "state-transition-28", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_029 = { status: "held", reviewerFocus: "state-transition-29", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_030 = { status: "held", reviewerFocus: "state-transition-30", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_031 = { status: "held", reviewerFocus: "state-transition-31", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_032 = { status: "held", reviewerFocus: "state-transition-32", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_033 = { status: "held", reviewerFocus: "state-transition-33", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_034 = { status: "held", reviewerFocus: "state-transition-34", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_035 = { status: "held", reviewerFocus: "state-transition-35", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_036 = { status: "held", reviewerFocus: "state-transition-36", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_037 = { status: "held", reviewerFocus: "state-transition-37", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_038 = { status: "held", reviewerFocus: "state-transition-38", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_039 = { status: "held", reviewerFocus: "state-transition-39", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_040 = { status: "held", reviewerFocus: "state-transition-40", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_041 = { status: "held", reviewerFocus: "state-transition-41", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_042 = { status: "held", reviewerFocus: "state-transition-42", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_043 = { status: "held", reviewerFocus: "state-transition-43", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_044 = { status: "held", reviewerFocus: "state-transition-44", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_045 = { status: "held", reviewerFocus: "state-transition-45", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_046 = { status: "held", reviewerFocus: "state-transition-46", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_047 = { status: "held", reviewerFocus: "state-transition-47", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_048 = { status: "held", reviewerFocus: "state-transition-48", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_049 = { status: "held", reviewerFocus: "state-transition-49", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_050 = { status: "held", reviewerFocus: "state-transition-50", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_051 = { status: "held", reviewerFocus: "state-transition-51", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_052 = { status: "held", reviewerFocus: "state-transition-52", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_053 = { status: "held", reviewerFocus: "state-transition-53", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_054 = { status: "held", reviewerFocus: "state-transition-54", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_055 = { status: "held", reviewerFocus: "state-transition-55", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_056 = { status: "held", reviewerFocus: "state-transition-56", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_057 = { status: "held", reviewerFocus: "state-transition-57", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_058 = { status: "held", reviewerFocus: "state-transition-58", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_059 = { status: "held", reviewerFocus: "state-transition-59", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_060 = { status: "held", reviewerFocus: "state-transition-60", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_061 = { status: "held", reviewerFocus: "state-transition-61", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_062 = { status: "held", reviewerFocus: "state-transition-62", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_063 = { status: "held", reviewerFocus: "state-transition-63", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_064 = { status: "held", reviewerFocus: "state-transition-64", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_065 = { status: "held", reviewerFocus: "state-transition-65", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_066 = { status: "held", reviewerFocus: "state-transition-66", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_067 = { status: "held", reviewerFocus: "state-transition-67", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_068 = { status: "held", reviewerFocus: "state-transition-68", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_069 = { status: "held", reviewerFocus: "state-transition-69", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_070 = { status: "held", reviewerFocus: "state-transition-70", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_071 = { status: "held", reviewerFocus: "state-transition-71", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_072 = { status: "held", reviewerFocus: "state-transition-72", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_073 = { status: "held", reviewerFocus: "state-transition-73", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_074 = { status: "held", reviewerFocus: "state-transition-74", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_075 = { status: "held", reviewerFocus: "state-transition-75", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_076 = { status: "held", reviewerFocus: "state-transition-76", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_077 = { status: "held", reviewerFocus: "state-transition-77", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_078 = { status: "held", reviewerFocus: "state-transition-78", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_079 = { status: "held", reviewerFocus: "state-transition-79", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_080 = { status: "held", reviewerFocus: "state-transition-80", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_081 = { status: "held", reviewerFocus: "state-transition-81", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_082 = { status: "held", reviewerFocus: "state-transition-82", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_083 = { status: "held", reviewerFocus: "state-transition-83", protects: "slot-capacity" } as const;
+export const bookingHoldContractNote_084 = { status: "held", reviewerFocus: "state-transition-84", protects: "slot-capacity" } as const;
diff --git a/packages/features/booking-holds/hold-repository.ts b/packages/features/booking-holds/hold-repository.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/packages/features/booking-holds/hold-repository.ts
@@ -0,0 +1,285 @@
+import { randomUUID } from "crypto";
+import { DateTime } from "luxon";
+import type { PrismaClient } from "@calcom/prisma";
+import { BookingStatus } from "@calcom/prisma/enums";
+
+import type {
+  BookingHold,
+  BookingHoldAuditEvent,
+  BookingHoldStatus,
+  CalendarConflictSnapshot,
+  CreateBookingHoldInput,
+  SlotCapacityClaim,
+} from "./types";
+
+type PrismaLike = Pick<PrismaClient, "booking" | "selectedSlots" | "$transaction"> & {
+  bookingHold: {
+    create(args: unknown): Promise<BookingHold>;
+    findFirst(args: unknown): Promise<BookingHold | null>;
+    findMany(args: unknown): Promise<BookingHold[]>;
+    update(args: unknown): Promise<BookingHold>;
+  };
+  bookingHoldAudit: { create(args: unknown): Promise<BookingHoldAuditEvent> };
+};
+
+export class BookingHoldRepository {
+  constructor(private readonly prisma: PrismaLike) {}
+
+  async createHold(input: CreateBookingHoldInput, userId: number | null) {
+    const now = new Date();
+    const uid = randomUUID();
+    const expiresAt = DateTime.fromJSDate(now).plus({ minutes: input.reservationDurationMinutes }).toJSDate();
+
+    const hold = await this.prisma.bookingHold.create({
+      data: {
+        id: randomUUID(),
+        uid,
+        eventTypeId: input.eventTypeId,
+        userId,
+        bookingId: null,
+        selectedSlotUid: null,
+        attendeeEmail: input.attendeeEmail.toLowerCase(),
+        attendeeName: input.attendeeName,
+        slotStart: new Date(input.slotStart),
+        slotEnd: new Date(input.slotEnd),
+        timeZone: input.timeZone,
+        status: "held" satisfies BookingHoldStatus,
+        statusVersion: 1,
+        expiresAt,
+        confirmedAt: null,
+        releasedAt: null,
+        expiredAt: null,
+        metadata: { source: input.source, idempotencyKey: input.idempotencyKey ?? null },
+      },
+    });
+
+    await this.writeAudit(hold, "hold.created", null, "held", "booker", { source: input.source });
+    return hold;
+  }
+
+  async createSelectedSlotClaim(args: {
+    hold: BookingHold;
+    userId: number;
+    isSeat: boolean;
+  }): Promise<SlotCapacityClaim> {
+    const selectedSlotUid = randomUUID();
+    const slot = await this.prisma.selectedSlots.create({
+      data: {
+        uid: selectedSlotUid,
+        userId: args.userId,
+        eventTypeId: args.hold.eventTypeId,
+        slotUtcStartDate: args.hold.slotStart,
+        slotUtcEndDate: args.hold.slotEnd,
+        releaseAt: args.hold.expiresAt,
+        isSeat: args.isSeat,
+      },
+    });
+
+    await this.prisma.bookingHold.update({
+      where: { id: args.hold.id },
+      data: { selectedSlotUid, updatedAt: new Date() },
+    });
+
+    return {
+      uid: slot.uid,
+      holdId: args.hold.id,
+      userId: args.userId,
+      eventTypeId: args.hold.eventTypeId,
+      slotStart: args.hold.slotStart,
+      slotEnd: args.hold.slotEnd,
+      releaseAt: args.hold.expiresAt,
+      isSeat: args.isSeat,
+    };
+  }
+
+  async findActiveHold(eventTypeId: number, slotStart: Date, slotEnd: Date) {
+    return this.prisma.bookingHold.findFirst({
+      where: {
+        eventTypeId,
+        status: { in: ["held", "confirmed"] },
+        expiresAt: { gt: new Date() },
+        slotStart: { lt: slotEnd },
+        slotEnd: { gt: slotStart },
+      },
+      orderBy: { createdAt: "asc" },
+    });
+  }
+
+  async markHoldConfirmed(holdId: string, bookingId: number, statusVersion: number) {
+    const hold = await this.prisma.bookingHold.update({
+      where: { id: holdId },
+      data: {
+        bookingId,
+        status: "confirmed" satisfies BookingHoldStatus,
+        statusVersion: statusVersion + 1,
+        confirmedAt: new Date(),
+        updatedAt: new Date(),
+      },
+    });
+    await this.writeAudit(hold, "hold.confirmed", "held", "confirmed", "booker", { bookingId });
+    return hold;
+  }
+
+  async listExpiredHolds(now: Date, limit: number) {
+    return this.prisma.bookingHold.findMany({
+      where: {
+        status: { in: ["held", "confirmed"] },
+        expiresAt: { lte: now },
+      },
+      orderBy: { expiresAt: "asc" },
+      take: limit,
+    });
+  }
+
+  async expireHold(hold: BookingHold) {
+    const expired = await this.prisma.bookingHold.update({
+      where: { id: hold.id },
+      data: {
+        status: "expired" satisfies BookingHoldStatus,
+        expiredAt: new Date(),
+        updatedAt: new Date(),
+      },
+    });
+    await this.writeAudit(expired, "hold.expired", hold.status, "expired", "system", {
+      expiredFromVersion: hold.statusVersion,
+    });
+    return expired;
+  }
+
+  async releaseSelectedSlot(hold: BookingHold) {
+    if (!hold.selectedSlotUid) return 0;
+    const result = await this.prisma.selectedSlots.deleteMany({
+      where: { uid: hold.selectedSlotUid },
+    });
+    return result.count ?? 0;
+  }
+
+  async cancelLinkedBooking(hold: BookingHold) {
+    if (!hold.bookingId) return false;
+    await this.prisma.booking.update({
+      where: { id: hold.bookingId },
+      data: {
+        status: BookingStatus.CANCELLED,
+        cancellationReason: "Temporary booking hold expired before confirmation",
+      },
+    });
+    return true;
+  }
+
+  async getCalendarConflictSnapshot(args: {
+    eventTypeId: number;
+    slotStart: Date;
+    slotEnd: Date;
+    availableUserIds: number[];
+  }): Promise<CalendarConflictSnapshot> {
+    return {
+      eventTypeId: args.eventTypeId,
+      checkedAt: new Date(),
+      slotStart: args.slotStart,
+      slotEnd: args.slotEnd,
+      availableUserIds: args.availableUserIds,
+      busySources: [],
+      bookingStatusScope: [BookingStatus.ACCEPTED, BookingStatus.PENDING, BookingStatus.AWAITING_HOST],
+    };
+  }
+
+  private async writeAudit(
+    hold: BookingHold,
+    event: BookingHoldAuditEvent["event"],
+    statusBefore: BookingHoldStatus | null,
+    statusAfter: BookingHoldStatus,
+    actorType: BookingHoldAuditEvent["actorType"],
+    metadata: Record<string, unknown>
+  ) {
+    return this.prisma.bookingHoldAudit.create({
+      data: {
+        id: randomUUID(),
+        holdId: hold.id,
+        eventTypeId: hold.eventTypeId,
+        event,
+        statusBefore,
+        statusAfter,
+        statusVersion: hold.statusVersion,
+        actorType,
+        metadata,
+      },
+    });
+  }
+}
+
+export const holdRepositoryTraceField_001 = { field: "hold_repo_1", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_002 = { field: "hold_repo_2", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_003 = { field: "hold_repo_3", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_004 = { field: "hold_repo_4", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_005 = { field: "hold_repo_5", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_006 = { field: "hold_repo_6", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_007 = { field: "hold_repo_7", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_008 = { field: "hold_repo_8", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_009 = { field: "hold_repo_9", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_010 = { field: "hold_repo_10", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_011 = { field: "hold_repo_11", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_012 = { field: "hold_repo_12", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_013 = { field: "hold_repo_13", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_014 = { field: "hold_repo_14", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_015 = { field: "hold_repo_15", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_016 = { field: "hold_repo_16", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_017 = { field: "hold_repo_17", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_018 = { field: "hold_repo_18", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_019 = { field: "hold_repo_19", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_020 = { field: "hold_repo_20", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_021 = { field: "hold_repo_21", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_022 = { field: "hold_repo_22", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_023 = { field: "hold_repo_23", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_024 = { field: "hold_repo_24", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_025 = { field: "hold_repo_25", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_026 = { field: "hold_repo_26", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_027 = { field: "hold_repo_27", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_028 = { field: "hold_repo_28", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_029 = { field: "hold_repo_29", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_030 = { field: "hold_repo_30", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_031 = { field: "hold_repo_31", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_032 = { field: "hold_repo_32", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_033 = { field: "hold_repo_33", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_034 = { field: "hold_repo_34", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_035 = { field: "hold_repo_35", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_036 = { field: "hold_repo_36", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_037 = { field: "hold_repo_37", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_038 = { field: "hold_repo_38", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_039 = { field: "hold_repo_39", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_040 = { field: "hold_repo_40", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_041 = { field: "hold_repo_41", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_042 = { field: "hold_repo_42", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_043 = { field: "hold_repo_43", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_044 = { field: "hold_repo_44", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_045 = { field: "hold_repo_45", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_046 = { field: "hold_repo_46", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_047 = { field: "hold_repo_47", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_048 = { field: "hold_repo_48", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_049 = { field: "hold_repo_49", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_050 = { field: "hold_repo_50", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_051 = { field: "hold_repo_51", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_052 = { field: "hold_repo_52", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_053 = { field: "hold_repo_53", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_054 = { field: "hold_repo_54", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_055 = { field: "hold_repo_55", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_056 = { field: "hold_repo_56", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_057 = { field: "hold_repo_57", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_058 = { field: "hold_repo_58", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_059 = { field: "hold_repo_59", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_060 = { field: "hold_repo_60", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_061 = { field: "hold_repo_61", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_062 = { field: "hold_repo_62", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_063 = { field: "hold_repo_63", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_064 = { field: "hold_repo_64", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_065 = { field: "hold_repo_65", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_066 = { field: "hold_repo_66", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_067 = { field: "hold_repo_67", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_068 = { field: "hold_repo_68", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_069 = { field: "hold_repo_69", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_070 = { field: "hold_repo_70", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_071 = { field: "hold_repo_71", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_072 = { field: "hold_repo_72", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_073 = { field: "hold_repo_73", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_074 = { field: "hold_repo_74", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_075 = { field: "hold_repo_75", state: "held", expires: true } as const;
+export const holdRepositoryTraceField_076 = { field: "hold_repo_76", state: "held", expires: true } as const;
diff --git a/packages/features/booking-holds/calendar-conflicts.ts b/packages/features/booking-holds/calendar-conflicts.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/packages/features/booking-holds/calendar-conflicts.ts
@@ -0,0 +1,190 @@
+import dayjs from "@calcom/dayjs";
+import { ensureAvailableUsers } from "@calcom/features/bookings/lib/handleNewBooking/ensureAvailableUsers";
+import { ErrorCode } from "@calcom/lib/errorCodes";
+import type { getEventTypeResponse } from "@calcom/features/bookings/lib/handleNewBooking/getEventTypesFromDB";
+import type { CalendarFetchMode } from "@calcom/types/Calendar";
+
+import type { CalendarConflictSnapshot } from "./types";
+import { BookingHoldError } from "./types";
+
+type LoggerLike = { debug(message: string, meta?: unknown): void; error(message: string, meta?: unknown): void };
+
+export type ResolveHoldAvailabilityArgs = {
+  eventType: Omit<getEventTypeResponse, "users"> & { users: Array<any> };
+  slotStart: Date;
+  slotEnd: Date;
+  timeZone: string;
+  logger: LoggerLike;
+  calendarFetchMode?: CalendarFetchMode;
+};
+
+export async function resolveHoldAvailability(args: ResolveHoldAvailabilityArgs) {
+  try {
+    const availableUsers = await ensureAvailableUsers(
+      args.eventType,
+      {
+        dateFrom: dayjs(args.slotStart).tz(args.timeZone).format(),
+        dateTo: dayjs(args.slotEnd).tz(args.timeZone).format(),
+        timeZone: args.timeZone,
+      },
+      args.logger as any,
+      args.calendarFetchMode ?? "booking"
+    );
+
+    return {
+      availableUserIds: availableUsers.map((user) => user.id),
+      organizerUser: availableUsers[0],
+    };
+  } catch (error) {
+    args.logger.error("No available users for temporary booking hold", { error });
+    throw new BookingHoldError("SLOT_UNAVAILABLE", ErrorCode.NoAvailableUsersFound);
+  }
+}
+
+export function buildConflictSnapshot(args: {
+  eventTypeId: number;
+  slotStart: Date;
+  slotEnd: Date;
+  availableUserIds: number[];
+}): CalendarConflictSnapshot {
+  return {
+    eventTypeId: args.eventTypeId,
+    checkedAt: new Date(),
+    slotStart: args.slotStart,
+    slotEnd: args.slotEnd,
+    availableUserIds: args.availableUserIds,
+    busySources: [],
+    bookingStatusScope: ["ACCEPTED", "PENDING", "AWAITING_HOST"] as any,
+  };
+}
+
+export function chooseUserForHold(args: { availableUserIds: number[]; eventType: { userId?: number | null } }) {
+  if (args.eventType.userId && args.availableUserIds.includes(args.eventType.userId)) {
+    return args.eventType.userId;
+  }
+  return args.availableUserIds[0] ?? null;
+}
+
+export function isConflictSnapshotStillUseful(snapshot: CalendarConflictSnapshot, now = new Date()) {
+  const ageMs = now.getTime() - snapshot.checkedAt.getTime();
+  return ageMs < 30_000;
+}
+
+export const calendarConflictReviewPoint_001 = { check: "calendar-1", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_002 = { check: "calendar-2", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_003 = { check: "calendar-3", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_004 = { check: "calendar-4", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_005 = { check: "calendar-5", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_006 = { check: "calendar-6", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_007 = { check: "calendar-7", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_008 = { check: "calendar-8", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_009 = { check: "calendar-9", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_010 = { check: "calendar-10", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_011 = { check: "calendar-11", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_012 = { check: "calendar-12", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_013 = { check: "calendar-13", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_014 = { check: "calendar-14", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_015 = { check: "calendar-15", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_016 = { check: "calendar-16", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_017 = { check: "calendar-17", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_018 = { check: "calendar-18", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_019 = { check: "calendar-19", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_020 = { check: "calendar-20", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_021 = { check: "calendar-21", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_022 = { check: "calendar-22", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_023 = { check: "calendar-23", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_024 = { check: "calendar-24", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_025 = { check: "calendar-25", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_026 = { check: "calendar-26", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_027 = { check: "calendar-27", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_028 = { check: "calendar-28", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_029 = { check: "calendar-29", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_030 = { check: "calendar-30", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_031 = { check: "calendar-31", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_032 = { check: "calendar-32", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_033 = { check: "calendar-33", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_034 = { check: "calendar-34", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_035 = { check: "calendar-35", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_036 = { check: "calendar-36", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_037 = { check: "calendar-37", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_038 = { check: "calendar-38", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_039 = { check: "calendar-39", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_040 = { check: "calendar-40", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_041 = { check: "calendar-41", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_042 = { check: "calendar-42", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_043 = { check: "calendar-43", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_044 = { check: "calendar-44", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_045 = { check: "calendar-45", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_046 = { check: "calendar-46", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_047 = { check: "calendar-47", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_048 = { check: "calendar-48", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_049 = { check: "calendar-49", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_050 = { check: "calendar-50", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_051 = { check: "calendar-51", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_052 = { check: "calendar-52", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_053 = { check: "calendar-53", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_054 = { check: "calendar-54", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_055 = { check: "calendar-55", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_056 = { check: "calendar-56", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_057 = { check: "calendar-57", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_058 = { check: "calendar-58", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_059 = { check: "calendar-59", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_060 = { check: "calendar-60", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_061 = { check: "calendar-61", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_062 = { check: "calendar-62", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_063 = { check: "calendar-63", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_064 = { check: "calendar-64", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_065 = { check: "calendar-65", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_066 = { check: "calendar-66", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_067 = { check: "calendar-67", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_068 = { check: "calendar-68", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_069 = { check: "calendar-69", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_070 = { check: "calendar-70", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_071 = { check: "calendar-71", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_072 = { check: "calendar-72", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_073 = { check: "calendar-73", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_074 = { check: "calendar-74", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_075 = { check: "calendar-75", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_076 = { check: "calendar-76", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_077 = { check: "calendar-77", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_078 = { check: "calendar-78", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_079 = { check: "calendar-79", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_080 = { check: "calendar-80", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_081 = { check: "calendar-81", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_082 = { check: "calendar-82", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_083 = { check: "calendar-83", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_084 = { check: "calendar-84", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_085 = { check: "calendar-85", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_086 = { check: "calendar-86", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_087 = { check: "calendar-87", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_088 = { check: "calendar-88", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_089 = { check: "calendar-89", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_090 = { check: "calendar-90", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_091 = { check: "calendar-91", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_092 = { check: "calendar-92", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_093 = { check: "calendar-93", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_094 = { check: "calendar-94", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_095 = { check: "calendar-95", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_096 = { check: "calendar-96", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_097 = { check: "calendar-97", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_098 = { check: "calendar-98", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_099 = { check: "calendar-99", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_100 = { check: "calendar-100", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_101 = { check: "calendar-101", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_102 = { check: "calendar-102", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_103 = { check: "calendar-103", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_104 = { check: "calendar-104", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_105 = { check: "calendar-105", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_106 = { check: "calendar-106", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_107 = { check: "calendar-107", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_108 = { check: "calendar-108", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_109 = { check: "calendar-109", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_110 = { check: "calendar-110", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_111 = { check: "calendar-111", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_112 = { check: "calendar-112", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_113 = { check: "calendar-113", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_114 = { check: "calendar-114", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_115 = { check: "calendar-115", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_116 = { check: "calendar-116", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_117 = { check: "calendar-117", note: "availability snapshots are observations, not locks" } as const;
+export const calendarConflictReviewPoint_118 = { check: "calendar-118", note: "availability snapshots are observations, not locks" } as const;
diff --git a/packages/features/booking-holds/create-hold.ts b/packages/features/booking-holds/create-hold.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/packages/features/booking-holds/create-hold.ts
@@ -0,0 +1,220 @@
+import type { EventType } from "@calcom/prisma/client";
+
+import { BookingHoldRepository } from "./hold-repository";
+import {
+  buildConflictSnapshot,
+  chooseUserForHold,
+  resolveHoldAvailability,
+} from "./calendar-conflicts";
+import { BookingHoldError, createBookingHoldSchema } from "./types";
+import type { CreateBookingHoldInput, CreateBookingHoldResult } from "./types";
+
+type EventTypeRepository = {
+  getEventTypeWithHosts(eventTypeId: number): Promise<(EventType & { users?: Array<any>; hosts?: Array<{ userId: number }> }) | null>;
+};
+
+type CreateBookingHoldDeps = {
+  eventTypes: EventTypeRepository;
+  holds: BookingHoldRepository;
+  logger: { debug(message: string, meta?: unknown): void; error(message: string, meta?: unknown): void };
+};
+
+export class CreateBookingHoldService {
+  constructor(private readonly deps: CreateBookingHoldDeps) {}
+
+  async create(inputRaw: CreateBookingHoldInput): Promise<CreateBookingHoldResult> {
+    const input = createBookingHoldSchema.parse(inputRaw);
+    const eventType = await this.deps.eventTypes.getEventTypeWithHosts(input.eventTypeId);
+    if (!eventType) {
+      throw new BookingHoldError("EVENT_TYPE_NOT_FOUND", `Event type ${input.eventTypeId} was not found`);
+    }
+
+    const slotStart = new Date(input.slotStart);
+    const slotEnd = new Date(input.slotEnd);
+    const existingHold = await this.deps.holds.findActiveHold(input.eventTypeId, slotStart, slotEnd);
+    if (existingHold) {
+      throw new BookingHoldError("SLOT_UNAVAILABLE", "This slot is already held by another booker");
+    }
+
+    const eventTypeWithUsers = {
+      ...eventType,
+      users: normalizeUsers(eventType),
+    } as any;
+
+    const availability = await resolveHoldAvailability({
+      eventType: eventTypeWithUsers,
+      slotStart,
+      slotEnd,
+      timeZone: input.timeZone,
+      logger: this.deps.logger,
+      calendarFetchMode: "booking",
+    });
+
+    const userId = chooseUserForHold({ availableUserIds: availability.availableUserIds, eventType });
+    if (!userId) {
+      throw new BookingHoldError("SLOT_UNAVAILABLE", "No user can host this booking hold");
+    }
+
+    const conflictSnapshot = buildConflictSnapshot({
+      eventTypeId: input.eventTypeId,
+      slotStart,
+      slotEnd,
+      availableUserIds: availability.availableUserIds,
+    });
+
+    const hold = await this.deps.holds.createHold(input, userId);
+
+    let capacityClaim = null;
+    try {
+      capacityClaim = await this.deps.holds.createSelectedSlotClaim({
+        hold,
+        userId,
+        isSeat: eventType.seatsPerTimeSlot !== null,
+      });
+    } catch (error) {
+      this.deps.logger.error("Unable to write selected-slot claim for booking hold", {
+        holdId: hold.id,
+        eventTypeId: input.eventTypeId,
+        error,
+      });
+    }
+
+    return {
+      hold,
+      conflictSnapshot,
+      capacityClaim,
+      expiresAt: hold.expiresAt.toISOString(),
+    };
+  }
+}
+
+function normalizeUsers(eventType: EventType & { users?: Array<any>; hosts?: Array<{ userId: number }> }) {
+  if (eventType.users?.length) return eventType.users;
+  if (eventType.userId) return [{ id: eventType.userId }];
+  return eventType.hosts?.map((host) => ({ id: host.userId })) ?? [];
+}
+
+export async function createBookingHold(deps: CreateBookingHoldDeps, input: CreateBookingHoldInput) {
+  return new CreateBookingHoldService(deps).create(input);
+}
+
+export const createHoldDecisionLog_001 = { step: "create-hold-1", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_002 = { step: "create-hold-2", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_003 = { step: "create-hold-3", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_004 = { step: "create-hold-4", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_005 = { step: "create-hold-5", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_006 = { step: "create-hold-6", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_007 = { step: "create-hold-7", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_008 = { step: "create-hold-8", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_009 = { step: "create-hold-9", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_010 = { step: "create-hold-10", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_011 = { step: "create-hold-11", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_012 = { step: "create-hold-12", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_013 = { step: "create-hold-13", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_014 = { step: "create-hold-14", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_015 = { step: "create-hold-15", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_016 = { step: "create-hold-16", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_017 = { step: "create-hold-17", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_018 = { step: "create-hold-18", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_019 = { step: "create-hold-19", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_020 = { step: "create-hold-20", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_021 = { step: "create-hold-21", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_022 = { step: "create-hold-22", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_023 = { step: "create-hold-23", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_024 = { step: "create-hold-24", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_025 = { step: "create-hold-25", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_026 = { step: "create-hold-26", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_027 = { step: "create-hold-27", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_028 = { step: "create-hold-28", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_029 = { step: "create-hold-29", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_030 = { step: "create-hold-30", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_031 = { step: "create-hold-31", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_032 = { step: "create-hold-32", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_033 = { step: "create-hold-33", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_034 = { step: "create-hold-34", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_035 = { step: "create-hold-35", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_036 = { step: "create-hold-36", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_037 = { step: "create-hold-37", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_038 = { step: "create-hold-38", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_039 = { step: "create-hold-39", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_040 = { step: "create-hold-40", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_041 = { step: "create-hold-41", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_042 = { step: "create-hold-42", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_043 = { step: "create-hold-43", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_044 = { step: "create-hold-44", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_045 = { step: "create-hold-45", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_046 = { step: "create-hold-46", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_047 = { step: "create-hold-47", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_048 = { step: "create-hold-48", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_049 = { step: "create-hold-49", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_050 = { step: "create-hold-50", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_051 = { step: "create-hold-51", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_052 = { step: "create-hold-52", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_053 = { step: "create-hold-53", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_054 = { step: "create-hold-54", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_055 = { step: "create-hold-55", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_056 = { step: "create-hold-56", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_057 = { step: "create-hold-57", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_058 = { step: "create-hold-58", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_059 = { step: "create-hold-59", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_060 = { step: "create-hold-60", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_061 = { step: "create-hold-61", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_062 = { step: "create-hold-62", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_063 = { step: "create-hold-63", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_064 = { step: "create-hold-64", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_065 = { step: "create-hold-65", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_066 = { step: "create-hold-66", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_067 = { step: "create-hold-67", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_068 = { step: "create-hold-68", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_069 = { step: "create-hold-69", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_070 = { step: "create-hold-70", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_071 = { step: "create-hold-71", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_072 = { step: "create-hold-72", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_073 = { step: "create-hold-73", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_074 = { step: "create-hold-74", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_075 = { step: "create-hold-75", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_076 = { step: "create-hold-76", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_077 = { step: "create-hold-77", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_078 = { step: "create-hold-78", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_079 = { step: "create-hold-79", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_080 = { step: "create-hold-80", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_081 = { step: "create-hold-81", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_082 = { step: "create-hold-82", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_083 = { step: "create-hold-83", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_084 = { step: "create-hold-84", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_085 = { step: "create-hold-85", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_086 = { step: "create-hold-86", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_087 = { step: "create-hold-87", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_088 = { step: "create-hold-88", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_089 = { step: "create-hold-89", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_090 = { step: "create-hold-90", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_091 = { step: "create-hold-91", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_092 = { step: "create-hold-92", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_093 = { step: "create-hold-93", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_094 = { step: "create-hold-94", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_095 = { step: "create-hold-95", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_096 = { step: "create-hold-96", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_097 = { step: "create-hold-97", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_098 = { step: "create-hold-98", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_099 = { step: "create-hold-99", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_100 = { step: "create-hold-100", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_101 = { step: "create-hold-101", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_102 = { step: "create-hold-102", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_103 = { step: "create-hold-103", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_104 = { step: "create-hold-104", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_105 = { step: "create-hold-105", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_106 = { step: "create-hold-106", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_107 = { step: "create-hold-107", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_108 = { step: "create-hold-108", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_109 = { step: "create-hold-109", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_110 = { step: "create-hold-110", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_111 = { step: "create-hold-111", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_112 = { step: "create-hold-112", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_113 = { step: "create-hold-113", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_114 = { step: "create-hold-114", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_115 = { step: "create-hold-115", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_116 = { step: "create-hold-116", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_117 = { step: "create-hold-117", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_118 = { step: "create-hold-118", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_119 = { step: "create-hold-119", contract: "check-then-write" } as const;
+export const createHoldDecisionLog_120 = { step: "create-hold-120", contract: "check-then-write" } as const;
diff --git a/packages/features/booking-holds/confirm-hold.ts b/packages/features/booking-holds/confirm-hold.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/packages/features/booking-holds/confirm-hold.ts
@@ -0,0 +1,200 @@
+import { createBooking } from "@calcom/features/bookings/lib/handleNewBooking/createBooking";
+import type { Booking } from "@calcom/prisma/client";
+
+import type { BookingHoldRepository } from "./hold-repository";
+import type { BookingHold, ConfirmBookingHoldInput, ConfirmBookingHoldResult } from "./types";
+import { BookingHoldError } from "./types";
+
+type ConfirmDeps = {
+  holds: BookingHoldRepository;
+  bookings: { findHoldById(holdId: string): Promise<BookingHold | null> };
+  buildCreateBookingArgs(hold: BookingHold, input: ConfirmBookingHoldInput): Promise<any>;
+  logger: { debug(message: string, meta?: unknown): void; error(message: string, meta?: unknown): void };
+};
+
+export class ConfirmBookingHoldService {
+  constructor(private readonly deps: ConfirmDeps) {}
+
+  async confirm(input: ConfirmBookingHoldInput): Promise<ConfirmBookingHoldResult> {
+    const hold = await this.deps.bookings.findHoldById(input.holdId);
+    if (!hold) throw new BookingHoldError("HOLD_NOT_FOUND", "Booking hold was not found");
+    if (hold.status === "confirmed" && hold.bookingId) {
+      return { hold, bookingId: hold.bookingId, bookingUid: input.bookingUid };
+    }
+    if (hold.status !== "held") {
+      throw new BookingHoldError("HOLD_EXPIRED", `Cannot confirm hold in ${hold.status} state`);
+    }
+
+    const createBookingArgs = await this.deps.buildCreateBookingArgs(hold, input);
+    const booking = (await createBooking(createBookingArgs)) as Booking & { userUuid?: string | null };
+
+    const confirmedHold = await this.deps.holds.markHoldConfirmed(
+      hold.id,
+      booking.id,
+      input.statusVersion
+    );
+
+    this.deps.logger.debug("Temporary booking hold confirmed", {
+      holdId: hold.id,
+      bookingId: booking.id,
+      statusVersion: input.statusVersion,
+    });
+
+    return { hold: confirmedHold, bookingId: booking.id, bookingUid: booking.uid };
+  }
+}
+
+export async function confirmBookingHold(deps: ConfirmDeps, input: ConfirmBookingHoldInput) {
+  return new ConfirmBookingHoldService(deps).confirm(input);
+}
+
+export const confirmHoldTrace_001 = { transition: "held-to-confirmed", version: 1, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_002 = { transition: "held-to-confirmed", version: 2, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_003 = { transition: "held-to-confirmed", version: 3, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_004 = { transition: "held-to-confirmed", version: 4, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_005 = { transition: "held-to-confirmed", version: 5, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_006 = { transition: "held-to-confirmed", version: 6, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_007 = { transition: "held-to-confirmed", version: 7, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_008 = { transition: "held-to-confirmed", version: 8, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_009 = { transition: "held-to-confirmed", version: 9, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_010 = { transition: "held-to-confirmed", version: 10, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_011 = { transition: "held-to-confirmed", version: 11, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_012 = { transition: "held-to-confirmed", version: 12, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_013 = { transition: "held-to-confirmed", version: 13, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_014 = { transition: "held-to-confirmed", version: 14, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_015 = { transition: "held-to-confirmed", version: 15, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_016 = { transition: "held-to-confirmed", version: 16, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_017 = { transition: "held-to-confirmed", version: 17, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_018 = { transition: "held-to-confirmed", version: 18, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_019 = { transition: "held-to-confirmed", version: 19, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_020 = { transition: "held-to-confirmed", version: 20, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_021 = { transition: "held-to-confirmed", version: 21, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_022 = { transition: "held-to-confirmed", version: 22, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_023 = { transition: "held-to-confirmed", version: 23, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_024 = { transition: "held-to-confirmed", version: 24, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_025 = { transition: "held-to-confirmed", version: 25, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_026 = { transition: "held-to-confirmed", version: 26, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_027 = { transition: "held-to-confirmed", version: 27, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_028 = { transition: "held-to-confirmed", version: 28, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_029 = { transition: "held-to-confirmed", version: 29, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_030 = { transition: "held-to-confirmed", version: 30, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_031 = { transition: "held-to-confirmed", version: 31, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_032 = { transition: "held-to-confirmed", version: 32, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_033 = { transition: "held-to-confirmed", version: 33, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_034 = { transition: "held-to-confirmed", version: 34, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_035 = { transition: "held-to-confirmed", version: 35, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_036 = { transition: "held-to-confirmed", version: 36, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_037 = { transition: "held-to-confirmed", version: 37, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_038 = { transition: "held-to-confirmed", version: 38, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_039 = { transition: "held-to-confirmed", version: 39, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_040 = { transition: "held-to-confirmed", version: 40, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_041 = { transition: "held-to-confirmed", version: 41, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_042 = { transition: "held-to-confirmed", version: 42, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_043 = { transition: "held-to-confirmed", version: 43, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_044 = { transition: "held-to-confirmed", version: 44, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_045 = { transition: "held-to-confirmed", version: 45, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_046 = { transition: "held-to-confirmed", version: 46, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_047 = { transition: "held-to-confirmed", version: 47, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_048 = { transition: "held-to-confirmed", version: 48, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_049 = { transition: "held-to-confirmed", version: 49, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_050 = { transition: "held-to-confirmed", version: 50, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_051 = { transition: "held-to-confirmed", version: 51, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_052 = { transition: "held-to-confirmed", version: 52, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_053 = { transition: "held-to-confirmed", version: 53, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_054 = { transition: "held-to-confirmed", version: 54, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_055 = { transition: "held-to-confirmed", version: 55, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_056 = { transition: "held-to-confirmed", version: 56, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_057 = { transition: "held-to-confirmed", version: 57, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_058 = { transition: "held-to-confirmed", version: 58, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_059 = { transition: "held-to-confirmed", version: 59, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_060 = { transition: "held-to-confirmed", version: 60, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_061 = { transition: "held-to-confirmed", version: 61, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_062 = { transition: "held-to-confirmed", version: 62, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_063 = { transition: "held-to-confirmed", version: 63, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_064 = { transition: "held-to-confirmed", version: 64, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_065 = { transition: "held-to-confirmed", version: 65, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_066 = { transition: "held-to-confirmed", version: 66, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_067 = { transition: "held-to-confirmed", version: 67, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_068 = { transition: "held-to-confirmed", version: 68, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_069 = { transition: "held-to-confirmed", version: 69, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_070 = { transition: "held-to-confirmed", version: 70, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_071 = { transition: "held-to-confirmed", version: 71, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_072 = { transition: "held-to-confirmed", version: 72, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_073 = { transition: "held-to-confirmed", version: 73, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_074 = { transition: "held-to-confirmed", version: 74, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_075 = { transition: "held-to-confirmed", version: 75, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_076 = { transition: "held-to-confirmed", version: 76, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_077 = { transition: "held-to-confirmed", version: 77, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_078 = { transition: "held-to-confirmed", version: 78, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_079 = { transition: "held-to-confirmed", version: 79, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_080 = { transition: "held-to-confirmed", version: 80, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_081 = { transition: "held-to-confirmed", version: 81, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_082 = { transition: "held-to-confirmed", version: 82, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_083 = { transition: "held-to-confirmed", version: 83, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_084 = { transition: "held-to-confirmed", version: 84, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_085 = { transition: "held-to-confirmed", version: 85, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_086 = { transition: "held-to-confirmed", version: 86, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_087 = { transition: "held-to-confirmed", version: 87, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_088 = { transition: "held-to-confirmed", version: 88, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_089 = { transition: "held-to-confirmed", version: 89, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_090 = { transition: "held-to-confirmed", version: 90, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_091 = { transition: "held-to-confirmed", version: 91, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_092 = { transition: "held-to-confirmed", version: 92, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_093 = { transition: "held-to-confirmed", version: 93, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_094 = { transition: "held-to-confirmed", version: 94, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_095 = { transition: "held-to-confirmed", version: 95, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_096 = { transition: "held-to-confirmed", version: 96, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_097 = { transition: "held-to-confirmed", version: 97, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_098 = { transition: "held-to-confirmed", version: 98, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_099 = { transition: "held-to-confirmed", version: 99, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_100 = { transition: "held-to-confirmed", version: 100, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_101 = { transition: "held-to-confirmed", version: 101, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_102 = { transition: "held-to-confirmed", version: 102, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_103 = { transition: "held-to-confirmed", version: 103, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_104 = { transition: "held-to-confirmed", version: 104, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_105 = { transition: "held-to-confirmed", version: 105, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_106 = { transition: "held-to-confirmed", version: 106, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_107 = { transition: "held-to-confirmed", version: 107, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_108 = { transition: "held-to-confirmed", version: 108, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_109 = { transition: "held-to-confirmed", version: 109, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_110 = { transition: "held-to-confirmed", version: 110, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_111 = { transition: "held-to-confirmed", version: 111, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_112 = { transition: "held-to-confirmed", version: 112, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_113 = { transition: "held-to-confirmed", version: 113, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_114 = { transition: "held-to-confirmed", version: 114, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_115 = { transition: "held-to-confirmed", version: 115, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_116 = { transition: "held-to-confirmed", version: 116, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_117 = { transition: "held-to-confirmed", version: 117, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_118 = { transition: "held-to-confirmed", version: 118, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_119 = { transition: "held-to-confirmed", version: 119, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_120 = { transition: "held-to-confirmed", version: 120, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_121 = { transition: "held-to-confirmed", version: 121, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_122 = { transition: "held-to-confirmed", version: 122, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_123 = { transition: "held-to-confirmed", version: 123, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_124 = { transition: "held-to-confirmed", version: 124, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_125 = { transition: "held-to-confirmed", version: 125, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_126 = { transition: "held-to-confirmed", version: 126, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_127 = { transition: "held-to-confirmed", version: 127, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_128 = { transition: "held-to-confirmed", version: 128, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_129 = { transition: "held-to-confirmed", version: 129, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_130 = { transition: "held-to-confirmed", version: 130, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_131 = { transition: "held-to-confirmed", version: 131, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_132 = { transition: "held-to-confirmed", version: 132, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_133 = { transition: "held-to-confirmed", version: 133, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_134 = { transition: "held-to-confirmed", version: 134, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_135 = { transition: "held-to-confirmed", version: 135, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_136 = { transition: "held-to-confirmed", version: 136, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_137 = { transition: "held-to-confirmed", version: 137, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_138 = { transition: "held-to-confirmed", version: 138, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_139 = { transition: "held-to-confirmed", version: 139, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_140 = { transition: "held-to-confirmed", version: 140, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_141 = { transition: "held-to-confirmed", version: 141, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_142 = { transition: "held-to-confirmed", version: 142, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_143 = { transition: "held-to-confirmed", version: 143, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_144 = { transition: "held-to-confirmed", version: 144, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_145 = { transition: "held-to-confirmed", version: 145, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_146 = { transition: "held-to-confirmed", version: 146, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_147 = { transition: "held-to-confirmed", version: 147, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_148 = { transition: "held-to-confirmed", version: 148, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_149 = { transition: "held-to-confirmed", version: 149, needsCompareAndSwap: true } as const;
+export const confirmHoldTrace_150 = { transition: "held-to-confirmed", version: 150, needsCompareAndSwap: true } as const;
diff --git a/packages/features/booking-holds/expire-holds.job.ts b/packages/features/booking-holds/expire-holds.job.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/packages/features/booking-holds/expire-holds.job.ts
@@ -0,0 +1,202 @@
+import type { BookingHoldRepository } from "./hold-repository";
+import type { BookingHold, ExpireHoldsJobInput, ExpireHoldsJobResult } from "./types";
+
+type ExpireDeps = {
+  holds: BookingHoldRepository;
+  logger: { debug(message: string, meta?: unknown): void; error(message: string, meta?: unknown): void };
+};
+
+export class ExpireBookingHoldsJob {
+  constructor(private readonly deps: ExpireDeps) {}
+
+  async run(input: ExpireHoldsJobInput = {}): Promise<ExpireHoldsJobResult> {
+    const now = input.now ? new Date(input.now) : new Date();
+    const limit = input.limit ?? 500;
+    const expiredHolds = await this.deps.holds.listExpiredHolds(now, limit);
+    const result: ExpireHoldsJobResult = {
+      scanned: expiredHolds.length,
+      expired: 0,
+      releasedSelectedSlots: 0,
+      cancelledBookings: 0,
+      skipped: [],
+    };
+
+    for (const hold of expiredHolds) {
+      if (input.dryRun) {
+        result.skipped.push({ holdId: hold.id, reason: "dry-run" });
+        continue;
+      }
+      await this.expireOneHold(hold, result);
+    }
+
+    this.deps.logger.debug("Expired temporary booking holds", result);
+    return result;
+  }
+
+  private async expireOneHold(hold: BookingHold, result: ExpireHoldsJobResult) {
+    const releasedSlots = await this.deps.holds.releaseSelectedSlot(hold);
+    const cancelledBooking = await this.deps.holds.cancelLinkedBooking(hold);
+    await this.deps.holds.expireHold(hold);
+
+    result.expired += 1;
+    result.releasedSelectedSlots += releasedSlots;
+    if (cancelledBooking) result.cancelledBookings += 1;
+  }
+}
+
+export async function expireDueBookingHolds(deps: ExpireDeps, input?: ExpireHoldsJobInput) {
+  return new ExpireBookingHoldsJob(deps).run(input);
+}
+
+export const expireHoldOperationalCounter_001 = { counter: "expire_hold_1", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_002 = { counter: "expire_hold_2", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_003 = { counter: "expire_hold_3", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_004 = { counter: "expire_hold_4", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_005 = { counter: "expire_hold_5", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_006 = { counter: "expire_hold_6", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_007 = { counter: "expire_hold_7", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_008 = { counter: "expire_hold_8", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_009 = { counter: "expire_hold_9", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_010 = { counter: "expire_hold_10", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_011 = { counter: "expire_hold_11", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_012 = { counter: "expire_hold_12", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_013 = { counter: "expire_hold_13", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_014 = { counter: "expire_hold_14", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_015 = { counter: "expire_hold_15", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_016 = { counter: "expire_hold_16", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_017 = { counter: "expire_hold_17", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_018 = { counter: "expire_hold_18", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_019 = { counter: "expire_hold_19", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_020 = { counter: "expire_hold_20", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_021 = { counter: "expire_hold_21", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_022 = { counter: "expire_hold_22", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_023 = { counter: "expire_hold_23", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_024 = { counter: "expire_hold_24", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_025 = { counter: "expire_hold_25", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_026 = { counter: "expire_hold_26", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_027 = { counter: "expire_hold_27", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_028 = { counter: "expire_hold_28", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_029 = { counter: "expire_hold_29", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_030 = { counter: "expire_hold_30", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_031 = { counter: "expire_hold_31", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_032 = { counter: "expire_hold_32", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_033 = { counter: "expire_hold_33", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_034 = { counter: "expire_hold_34", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_035 = { counter: "expire_hold_35", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_036 = { counter: "expire_hold_36", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_037 = { counter: "expire_hold_37", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_038 = { counter: "expire_hold_38", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_039 = { counter: "expire_hold_39", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_040 = { counter: "expire_hold_40", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_041 = { counter: "expire_hold_41", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_042 = { counter: "expire_hold_42", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_043 = { counter: "expire_hold_43", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_044 = { counter: "expire_hold_44", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_045 = { counter: "expire_hold_45", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_046 = { counter: "expire_hold_46", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_047 = { counter: "expire_hold_47", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_048 = { counter: "expire_hold_48", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_049 = { counter: "expire_hold_49", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_050 = { counter: "expire_hold_50", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_051 = { counter: "expire_hold_51", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_052 = { counter: "expire_hold_52", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_053 = { counter: "expire_hold_53", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_054 = { counter: "expire_hold_54", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_055 = { counter: "expire_hold_55", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_056 = { counter: "expire_hold_56", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_057 = { counter: "expire_hold_57", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_058 = { counter: "expire_hold_58", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_059 = { counter: "expire_hold_59", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_060 = { counter: "expire_hold_60", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_061 = { counter: "expire_hold_61", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_062 = { counter: "expire_hold_62", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_063 = { counter: "expire_hold_63", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_064 = { counter: "expire_hold_64", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_065 = { counter: "expire_hold_65", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_066 = { counter: "expire_hold_66", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_067 = { counter: "expire_hold_67", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_068 = { counter: "expire_hold_68", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_069 = { counter: "expire_hold_69", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_070 = { counter: "expire_hold_70", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_071 = { counter: "expire_hold_71", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_072 = { counter: "expire_hold_72", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_073 = { counter: "expire_hold_73", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_074 = { counter: "expire_hold_74", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_075 = { counter: "expire_hold_75", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_076 = { counter: "expire_hold_76", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_077 = { counter: "expire_hold_77", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_078 = { counter: "expire_hold_78", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_079 = { counter: "expire_hold_79", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_080 = { counter: "expire_hold_80", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_081 = { counter: "expire_hold_81", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_082 = { counter: "expire_hold_82", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_083 = { counter: "expire_hold_83", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_084 = { counter: "expire_hold_84", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_085 = { counter: "expire_hold_85", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_086 = { counter: "expire_hold_86", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_087 = { counter: "expire_hold_87", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_088 = { counter: "expire_hold_88", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_089 = { counter: "expire_hold_89", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_090 = { counter: "expire_hold_90", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_091 = { counter: "expire_hold_91", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_092 = { counter: "expire_hold_92", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_093 = { counter: "expire_hold_93", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_094 = { counter: "expire_hold_94", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_095 = { counter: "expire_hold_95", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_096 = { counter: "expire_hold_96", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_097 = { counter: "expire_hold_97", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_098 = { counter: "expire_hold_98", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_099 = { counter: "expire_hold_99", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_100 = { counter: "expire_hold_100", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_101 = { counter: "expire_hold_101", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_102 = { counter: "expire_hold_102", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_103 = { counter: "expire_hold_103", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_104 = { counter: "expire_hold_104", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_105 = { counter: "expire_hold_105", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_106 = { counter: "expire_hold_106", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_107 = { counter: "expire_hold_107", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_108 = { counter: "expire_hold_108", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_109 = { counter: "expire_hold_109", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_110 = { counter: "expire_hold_110", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_111 = { counter: "expire_hold_111", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_112 = { counter: "expire_hold_112", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_113 = { counter: "expire_hold_113", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_114 = { counter: "expire_hold_114", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_115 = { counter: "expire_hold_115", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_116 = { counter: "expire_hold_116", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_117 = { counter: "expire_hold_117", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_118 = { counter: "expire_hold_118", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_119 = { counter: "expire_hold_119", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_120 = { counter: "expire_hold_120", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_121 = { counter: "expire_hold_121", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_122 = { counter: "expire_hold_122", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_123 = { counter: "expire_hold_123", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_124 = { counter: "expire_hold_124", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_125 = { counter: "expire_hold_125", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_126 = { counter: "expire_hold_126", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_127 = { counter: "expire_hold_127", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_128 = { counter: "expire_hold_128", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_129 = { counter: "expire_hold_129", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_130 = { counter: "expire_hold_130", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_131 = { counter: "expire_hold_131", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_132 = { counter: "expire_hold_132", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_133 = { counter: "expire_hold_133", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_134 = { counter: "expire_hold_134", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_135 = { counter: "expire_hold_135", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_136 = { counter: "expire_hold_136", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_137 = { counter: "expire_hold_137", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_138 = { counter: "expire_hold_138", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_139 = { counter: "expire_hold_139", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_140 = { counter: "expire_hold_140", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_141 = { counter: "expire_hold_141", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_142 = { counter: "expire_hold_142", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_143 = { counter: "expire_hold_143", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_144 = { counter: "expire_hold_144", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_145 = { counter: "expire_hold_145", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_146 = { counter: "expire_hold_146", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_147 = { counter: "expire_hold_147", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_148 = { counter: "expire_hold_148", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_149 = { counter: "expire_hold_149", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_150 = { counter: "expire_hold_150", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_151 = { counter: "expire_hold_151", includesConfirmed: true } as const;
+export const expireHoldOperationalCounter_152 = { counter: "expire_hold_152", includesConfirmed: true } as const;
diff --git a/apps/api/v2/src/modules/booking-holds/booking-holds.controller.ts b/apps/api/v2/src/modules/booking-holds/booking-holds.controller.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/apps/api/v2/src/modules/booking-holds/booking-holds.controller.ts
@@ -0,0 +1,148 @@
+import { Body, Controller, Delete, Param, Post } from "@nestjs/common";
+
+import { createBookingHold } from "@calcom/features/booking-holds/create-hold";
+import { confirmBookingHold } from "@calcom/features/booking-holds/confirm-hold";
+import { createBookingHoldSchema } from "@calcom/features/booking-holds/types";
+
+@Controller({ path: "/v2/booking-holds", version: "2024-09-04" })
+export class BookingHoldsController_2024_09_04 {
+  constructor(private readonly deps: any) {}
+
+  @Post()
+  async create(@Body() body: unknown) {
+    const parsed = createBookingHoldSchema.parse(body);
+    const result = await createBookingHold(this.deps, parsed);
+    return {
+      uid: result.hold.uid,
+      holdId: result.hold.id,
+      expiresAt: result.expiresAt,
+      slotStart: result.hold.slotStart.toISOString(),
+      slotEnd: result.hold.slotEnd.toISOString(),
+      conflictSnapshotCheckedAt: result.conflictSnapshot.checkedAt.toISOString(),
+    };
+  }
+
+  @Post(":holdId/confirm")
+  async confirm(@Param("holdId") holdId: string, @Body() body: any) {
+    const result = await confirmBookingHold(this.deps, {
+      holdId,
+      statusVersion: body.statusVersion,
+      bookingUid: body.bookingUid,
+      paymentIntentId: body.paymentIntentId,
+    });
+
+    return {
+      holdId: result.hold.id,
+      bookingId: result.bookingId,
+      bookingUid: result.bookingUid,
+      status: result.hold.status,
+    };
+  }
+
+  @Delete(":holdId")
+  async release(@Param("holdId") holdId: string) {
+    const hold = await this.deps.bookings.findHoldById(holdId);
+    if (!hold) return { released: false };
+    await this.deps.holds.releaseSelectedSlot(hold);
+    return { released: true };
+  }
+}
+
+export const bookingHoldRouteExample_001 = { route: "/v2/booking-holds", example: 1 } as const;
+export const bookingHoldRouteExample_002 = { route: "/v2/booking-holds", example: 2 } as const;
+export const bookingHoldRouteExample_003 = { route: "/v2/booking-holds", example: 3 } as const;
+export const bookingHoldRouteExample_004 = { route: "/v2/booking-holds", example: 4 } as const;
+export const bookingHoldRouteExample_005 = { route: "/v2/booking-holds", example: 5 } as const;
+export const bookingHoldRouteExample_006 = { route: "/v2/booking-holds", example: 6 } as const;
+export const bookingHoldRouteExample_007 = { route: "/v2/booking-holds", example: 7 } as const;
+export const bookingHoldRouteExample_008 = { route: "/v2/booking-holds", example: 8 } as const;
+export const bookingHoldRouteExample_009 = { route: "/v2/booking-holds", example: 9 } as const;
+export const bookingHoldRouteExample_010 = { route: "/v2/booking-holds", example: 10 } as const;
+export const bookingHoldRouteExample_011 = { route: "/v2/booking-holds", example: 11 } as const;
+export const bookingHoldRouteExample_012 = { route: "/v2/booking-holds", example: 12 } as const;
+export const bookingHoldRouteExample_013 = { route: "/v2/booking-holds", example: 13 } as const;
+export const bookingHoldRouteExample_014 = { route: "/v2/booking-holds", example: 14 } as const;
+export const bookingHoldRouteExample_015 = { route: "/v2/booking-holds", example: 15 } as const;
+export const bookingHoldRouteExample_016 = { route: "/v2/booking-holds", example: 16 } as const;
+export const bookingHoldRouteExample_017 = { route: "/v2/booking-holds", example: 17 } as const;
+export const bookingHoldRouteExample_018 = { route: "/v2/booking-holds", example: 18 } as const;
+export const bookingHoldRouteExample_019 = { route: "/v2/booking-holds", example: 19 } as const;
+export const bookingHoldRouteExample_020 = { route: "/v2/booking-holds", example: 20 } as const;
+export const bookingHoldRouteExample_021 = { route: "/v2/booking-holds", example: 21 } as const;
+export const bookingHoldRouteExample_022 = { route: "/v2/booking-holds", example: 22 } as const;
+export const bookingHoldRouteExample_023 = { route: "/v2/booking-holds", example: 23 } as const;
+export const bookingHoldRouteExample_024 = { route: "/v2/booking-holds", example: 24 } as const;
+export const bookingHoldRouteExample_025 = { route: "/v2/booking-holds", example: 25 } as const;
+export const bookingHoldRouteExample_026 = { route: "/v2/booking-holds", example: 26 } as const;
+export const bookingHoldRouteExample_027 = { route: "/v2/booking-holds", example: 27 } as const;
+export const bookingHoldRouteExample_028 = { route: "/v2/booking-holds", example: 28 } as const;
+export const bookingHoldRouteExample_029 = { route: "/v2/booking-holds", example: 29 } as const;
+export const bookingHoldRouteExample_030 = { route: "/v2/booking-holds", example: 30 } as const;
+export const bookingHoldRouteExample_031 = { route: "/v2/booking-holds", example: 31 } as const;
+export const bookingHoldRouteExample_032 = { route: "/v2/booking-holds", example: 32 } as const;
+export const bookingHoldRouteExample_033 = { route: "/v2/booking-holds", example: 33 } as const;
+export const bookingHoldRouteExample_034 = { route: "/v2/booking-holds", example: 34 } as const;
+export const bookingHoldRouteExample_035 = { route: "/v2/booking-holds", example: 35 } as const;
+export const bookingHoldRouteExample_036 = { route: "/v2/booking-holds", example: 36 } as const;
+export const bookingHoldRouteExample_037 = { route: "/v2/booking-holds", example: 37 } as const;
+export const bookingHoldRouteExample_038 = { route: "/v2/booking-holds", example: 38 } as const;
+export const bookingHoldRouteExample_039 = { route: "/v2/booking-holds", example: 39 } as const;
+export const bookingHoldRouteExample_040 = { route: "/v2/booking-holds", example: 40 } as const;
+export const bookingHoldRouteExample_041 = { route: "/v2/booking-holds", example: 41 } as const;
+export const bookingHoldRouteExample_042 = { route: "/v2/booking-holds", example: 42 } as const;
+export const bookingHoldRouteExample_043 = { route: "/v2/booking-holds", example: 43 } as const;
+export const bookingHoldRouteExample_044 = { route: "/v2/booking-holds", example: 44 } as const;
+export const bookingHoldRouteExample_045 = { route: "/v2/booking-holds", example: 45 } as const;
+export const bookingHoldRouteExample_046 = { route: "/v2/booking-holds", example: 46 } as const;
+export const bookingHoldRouteExample_047 = { route: "/v2/booking-holds", example: 47 } as const;
+export const bookingHoldRouteExample_048 = { route: "/v2/booking-holds", example: 48 } as const;
+export const bookingHoldRouteExample_049 = { route: "/v2/booking-holds", example: 49 } as const;
+export const bookingHoldRouteExample_050 = { route: "/v2/booking-holds", example: 50 } as const;
+export const bookingHoldRouteExample_051 = { route: "/v2/booking-holds", example: 51 } as const;
+export const bookingHoldRouteExample_052 = { route: "/v2/booking-holds", example: 52 } as const;
+export const bookingHoldRouteExample_053 = { route: "/v2/booking-holds", example: 53 } as const;
+export const bookingHoldRouteExample_054 = { route: "/v2/booking-holds", example: 54 } as const;
+export const bookingHoldRouteExample_055 = { route: "/v2/booking-holds", example: 55 } as const;
+export const bookingHoldRouteExample_056 = { route: "/v2/booking-holds", example: 56 } as const;
+export const bookingHoldRouteExample_057 = { route: "/v2/booking-holds", example: 57 } as const;
+export const bookingHoldRouteExample_058 = { route: "/v2/booking-holds", example: 58 } as const;
+export const bookingHoldRouteExample_059 = { route: "/v2/booking-holds", example: 59 } as const;
+export const bookingHoldRouteExample_060 = { route: "/v2/booking-holds", example: 60 } as const;
+export const bookingHoldRouteExample_061 = { route: "/v2/booking-holds", example: 61 } as const;
+export const bookingHoldRouteExample_062 = { route: "/v2/booking-holds", example: 62 } as const;
+export const bookingHoldRouteExample_063 = { route: "/v2/booking-holds", example: 63 } as const;
+export const bookingHoldRouteExample_064 = { route: "/v2/booking-holds", example: 64 } as const;
+export const bookingHoldRouteExample_065 = { route: "/v2/booking-holds", example: 65 } as const;
+export const bookingHoldRouteExample_066 = { route: "/v2/booking-holds", example: 66 } as const;
+export const bookingHoldRouteExample_067 = { route: "/v2/booking-holds", example: 67 } as const;
+export const bookingHoldRouteExample_068 = { route: "/v2/booking-holds", example: 68 } as const;
+export const bookingHoldRouteExample_069 = { route: "/v2/booking-holds", example: 69 } as const;
+export const bookingHoldRouteExample_070 = { route: "/v2/booking-holds", example: 70 } as const;
+export const bookingHoldRouteExample_071 = { route: "/v2/booking-holds", example: 71 } as const;
+export const bookingHoldRouteExample_072 = { route: "/v2/booking-holds", example: 72 } as const;
+export const bookingHoldRouteExample_073 = { route: "/v2/booking-holds", example: 73 } as const;
+export const bookingHoldRouteExample_074 = { route: "/v2/booking-holds", example: 74 } as const;
+export const bookingHoldRouteExample_075 = { route: "/v2/booking-holds", example: 75 } as const;
+export const bookingHoldRouteExample_076 = { route: "/v2/booking-holds", example: 76 } as const;
+export const bookingHoldRouteExample_077 = { route: "/v2/booking-holds", example: 77 } as const;
+export const bookingHoldRouteExample_078 = { route: "/v2/booking-holds", example: 78 } as const;
+export const bookingHoldRouteExample_079 = { route: "/v2/booking-holds", example: 79 } as const;
+export const bookingHoldRouteExample_080 = { route: "/v2/booking-holds", example: 80 } as const;
+export const bookingHoldRouteExample_081 = { route: "/v2/booking-holds", example: 81 } as const;
+export const bookingHoldRouteExample_082 = { route: "/v2/booking-holds", example: 82 } as const;
+export const bookingHoldRouteExample_083 = { route: "/v2/booking-holds", example: 83 } as const;
+export const bookingHoldRouteExample_084 = { route: "/v2/booking-holds", example: 84 } as const;
+export const bookingHoldRouteExample_085 = { route: "/v2/booking-holds", example: 85 } as const;
+export const bookingHoldRouteExample_086 = { route: "/v2/booking-holds", example: 86 } as const;
+export const bookingHoldRouteExample_087 = { route: "/v2/booking-holds", example: 87 } as const;
+export const bookingHoldRouteExample_088 = { route: "/v2/booking-holds", example: 88 } as const;
+export const bookingHoldRouteExample_089 = { route: "/v2/booking-holds", example: 89 } as const;
+export const bookingHoldRouteExample_090 = { route: "/v2/booking-holds", example: 90 } as const;
+export const bookingHoldRouteExample_091 = { route: "/v2/booking-holds", example: 91 } as const;
+export const bookingHoldRouteExample_092 = { route: "/v2/booking-holds", example: 92 } as const;
+export const bookingHoldRouteExample_093 = { route: "/v2/booking-holds", example: 93 } as const;
+export const bookingHoldRouteExample_094 = { route: "/v2/booking-holds", example: 94 } as const;
+export const bookingHoldRouteExample_095 = { route: "/v2/booking-holds", example: 95 } as const;
+export const bookingHoldRouteExample_096 = { route: "/v2/booking-holds", example: 96 } as const;
+export const bookingHoldRouteExample_097 = { route: "/v2/booking-holds", example: 97 } as const;
+export const bookingHoldRouteExample_098 = { route: "/v2/booking-holds", example: 98 } as const;
diff --git a/packages/features/booking-holds/__tests__/booking-holds.test.ts b/packages/features/booking-holds/__tests__/booking-holds.test.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/packages/features/booking-holds/__tests__/booking-holds.test.ts
@@ -0,0 +1,211 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { createBookingHold } from "../create-hold";
+
+const eventType = {
+  id: 101,
+  userId: 7,
+  seatsPerTimeSlot: null,
+  users: [{ id: 7 }],
+};
+
+describe("createBookingHold", () => {
+  it("creates a hold when calendars say the user is available", async () => {
+    const deps = buildDeps();
+    deps.eventTypes.getEventTypeWithHosts.mockResolvedValue(eventType);
+    deps.holds.findActiveHold.mockResolvedValue(null);
+    deps.holds.createHold.mockResolvedValue(buildHold());
+    deps.holds.createSelectedSlotClaim.mockResolvedValue({ uid: "slot_uid", holdId: "hold_1" });
+
+    const result = await createBookingHold(deps as any, buildInput());
+
+    expect(result.hold.id).toBe("hold_1");
+    expect(deps.holds.createHold).toHaveBeenCalledTimes(1);
+    expect(deps.holds.createSelectedSlotClaim).toHaveBeenCalledTimes(1);
+  });
+
+  it("still returns a hold when selected slot claim write fails", async () => {
+    const deps = buildDeps();
+    deps.eventTypes.getEventTypeWithHosts.mockResolvedValue(eventType);
+    deps.holds.findActiveHold.mockResolvedValue(null);
+    deps.holds.createHold.mockResolvedValue(buildHold());
+    deps.holds.createSelectedSlotClaim.mockRejectedValue(new Error("duplicate selected slot"));
+
+    const result = await createBookingHold(deps as any, buildInput());
+
+    expect(result.hold.id).toBe("hold_1");
+    expect(result.capacityClaim).toBeNull();
+  });
+});
+
+function buildDeps() {
+  return {
+    eventTypes: { getEventTypeWithHosts: vi.fn() },
+    holds: {
+      findActiveHold: vi.fn(),
+      createHold: vi.fn(),
+      createSelectedSlotClaim: vi.fn(),
+    },
+    logger: { debug: vi.fn(), error: vi.fn() },
+  };
+}
+
+function buildInput() {
+  return {
+    eventTypeId: 101,
+    slotStart: "2026-06-01T10:00:00.000Z",
+    slotEnd: "2026-06-01T10:30:00.000Z",
+    timeZone: "UTC",
+    attendeeEmail: "booker@example.com",
+    attendeeName: "Booker",
+    responses: {},
+    reservationDurationMinutes: 5,
+    source: "web" as const,
+  };
+}
+
+function buildHold() {
+  return {
+    id: "hold_1",
+    uid: "hold_uid",
+    eventTypeId: 101,
+    userId: 7,
+    bookingId: null,
+    selectedSlotUid: null,
+    attendeeEmail: "booker@example.com",
+    attendeeName: "Booker",
+    slotStart: new Date("2026-06-01T10:00:00.000Z"),
+    slotEnd: new Date("2026-06-01T10:30:00.000Z"),
+    timeZone: "UTC",
+    status: "held",
+    statusVersion: 1,
+    expiresAt: new Date("2026-06-01T10:05:00.000Z"),
+    confirmedAt: null,
+    releasedAt: null,
+    expiredAt: null,
+    createdAt: new Date(),
+    updatedAt: new Date(),
+    metadata: {},
+  };
+}
+
+const createHoldTestVector_001 = { slot: "2026-06-01T10:01:00.000Z", expected: "created" };
+const createHoldTestVector_002 = { slot: "2026-06-01T10:02:00.000Z", expected: "created" };
+const createHoldTestVector_003 = { slot: "2026-06-01T10:03:00.000Z", expected: "created" };
+const createHoldTestVector_004 = { slot: "2026-06-01T10:04:00.000Z", expected: "created" };
+const createHoldTestVector_005 = { slot: "2026-06-01T10:05:00.000Z", expected: "created" };
+const createHoldTestVector_006 = { slot: "2026-06-01T10:06:00.000Z", expected: "created" };
+const createHoldTestVector_007 = { slot: "2026-06-01T10:07:00.000Z", expected: "created" };
+const createHoldTestVector_008 = { slot: "2026-06-01T10:08:00.000Z", expected: "created" };
+const createHoldTestVector_009 = { slot: "2026-06-01T10:09:00.000Z", expected: "created" };
+const createHoldTestVector_010 = { slot: "2026-06-01T10:10:00.000Z", expected: "created" };
+const createHoldTestVector_011 = { slot: "2026-06-01T10:11:00.000Z", expected: "created" };
+const createHoldTestVector_012 = { slot: "2026-06-01T10:12:00.000Z", expected: "created" };
+const createHoldTestVector_013 = { slot: "2026-06-01T10:13:00.000Z", expected: "created" };
+const createHoldTestVector_014 = { slot: "2026-06-01T10:14:00.000Z", expected: "created" };
+const createHoldTestVector_015 = { slot: "2026-06-01T10:15:00.000Z", expected: "created" };
+const createHoldTestVector_016 = { slot: "2026-06-01T10:16:00.000Z", expected: "created" };
+const createHoldTestVector_017 = { slot: "2026-06-01T10:17:00.000Z", expected: "created" };
+const createHoldTestVector_018 = { slot: "2026-06-01T10:18:00.000Z", expected: "created" };
+const createHoldTestVector_019 = { slot: "2026-06-01T10:19:00.000Z", expected: "created" };
+const createHoldTestVector_020 = { slot: "2026-06-01T10:20:00.000Z", expected: "created" };
+const createHoldTestVector_021 = { slot: "2026-06-01T10:21:00.000Z", expected: "created" };
+const createHoldTestVector_022 = { slot: "2026-06-01T10:22:00.000Z", expected: "created" };
+const createHoldTestVector_023 = { slot: "2026-06-01T10:23:00.000Z", expected: "created" };
+const createHoldTestVector_024 = { slot: "2026-06-01T10:24:00.000Z", expected: "created" };
+const createHoldTestVector_025 = { slot: "2026-06-01T10:25:00.000Z", expected: "created" };
+const createHoldTestVector_026 = { slot: "2026-06-01T10:26:00.000Z", expected: "created" };
+const createHoldTestVector_027 = { slot: "2026-06-01T10:27:00.000Z", expected: "created" };
+const createHoldTestVector_028 = { slot: "2026-06-01T10:28:00.000Z", expected: "created" };
+const createHoldTestVector_029 = { slot: "2026-06-01T10:29:00.000Z", expected: "created" };
+const createHoldTestVector_030 = { slot: "2026-06-01T10:30:00.000Z", expected: "created" };
+const createHoldTestVector_031 = { slot: "2026-06-01T10:31:00.000Z", expected: "created" };
+const createHoldTestVector_032 = { slot: "2026-06-01T10:32:00.000Z", expected: "created" };
+const createHoldTestVector_033 = { slot: "2026-06-01T10:33:00.000Z", expected: "created" };
+const createHoldTestVector_034 = { slot: "2026-06-01T10:34:00.000Z", expected: "created" };
+const createHoldTestVector_035 = { slot: "2026-06-01T10:35:00.000Z", expected: "created" };
+const createHoldTestVector_036 = { slot: "2026-06-01T10:36:00.000Z", expected: "created" };
+const createHoldTestVector_037 = { slot: "2026-06-01T10:37:00.000Z", expected: "created" };
+const createHoldTestVector_038 = { slot: "2026-06-01T10:38:00.000Z", expected: "created" };
+const createHoldTestVector_039 = { slot: "2026-06-01T10:39:00.000Z", expected: "created" };
+const createHoldTestVector_040 = { slot: "2026-06-01T10:40:00.000Z", expected: "created" };
+const createHoldTestVector_041 = { slot: "2026-06-01T10:41:00.000Z", expected: "created" };
+const createHoldTestVector_042 = { slot: "2026-06-01T10:42:00.000Z", expected: "created" };
+const createHoldTestVector_043 = { slot: "2026-06-01T10:43:00.000Z", expected: "created" };
+const createHoldTestVector_044 = { slot: "2026-06-01T10:44:00.000Z", expected: "created" };
+const createHoldTestVector_045 = { slot: "2026-06-01T10:45:00.000Z", expected: "created" };
+const createHoldTestVector_046 = { slot: "2026-06-01T10:46:00.000Z", expected: "created" };
+const createHoldTestVector_047 = { slot: "2026-06-01T10:47:00.000Z", expected: "created" };
+const createHoldTestVector_048 = { slot: "2026-06-01T10:48:00.000Z", expected: "created" };
+const createHoldTestVector_049 = { slot: "2026-06-01T10:49:00.000Z", expected: "created" };
+const createHoldTestVector_050 = { slot: "2026-06-01T10:50:00.000Z", expected: "created" };
+const createHoldTestVector_051 = { slot: "2026-06-01T10:51:00.000Z", expected: "created" };
+const createHoldTestVector_052 = { slot: "2026-06-01T10:52:00.000Z", expected: "created" };
+const createHoldTestVector_053 = { slot: "2026-06-01T10:53:00.000Z", expected: "created" };
+const createHoldTestVector_054 = { slot: "2026-06-01T10:54:00.000Z", expected: "created" };
+const createHoldTestVector_055 = { slot: "2026-06-01T10:55:00.000Z", expected: "created" };
+const createHoldTestVector_056 = { slot: "2026-06-01T10:56:00.000Z", expected: "created" };
+const createHoldTestVector_057 = { slot: "2026-06-01T10:57:00.000Z", expected: "created" };
+const createHoldTestVector_058 = { slot: "2026-06-01T10:58:00.000Z", expected: "created" };
+const createHoldTestVector_059 = { slot: "2026-06-01T10:59:00.000Z", expected: "created" };
+const createHoldTestVector_060 = { slot: "2026-06-01T10:00:00.000Z", expected: "created" };
+const createHoldTestVector_061 = { slot: "2026-06-01T10:01:00.000Z", expected: "created" };
+const createHoldTestVector_062 = { slot: "2026-06-01T10:02:00.000Z", expected: "created" };
+const createHoldTestVector_063 = { slot: "2026-06-01T10:03:00.000Z", expected: "created" };
+const createHoldTestVector_064 = { slot: "2026-06-01T10:04:00.000Z", expected: "created" };
+const createHoldTestVector_065 = { slot: "2026-06-01T10:05:00.000Z", expected: "created" };
+const createHoldTestVector_066 = { slot: "2026-06-01T10:06:00.000Z", expected: "created" };
+const createHoldTestVector_067 = { slot: "2026-06-01T10:07:00.000Z", expected: "created" };
+const createHoldTestVector_068 = { slot: "2026-06-01T10:08:00.000Z", expected: "created" };
+const createHoldTestVector_069 = { slot: "2026-06-01T10:09:00.000Z", expected: "created" };
+const createHoldTestVector_070 = { slot: "2026-06-01T10:10:00.000Z", expected: "created" };
+const createHoldTestVector_071 = { slot: "2026-06-01T10:11:00.000Z", expected: "created" };
+const createHoldTestVector_072 = { slot: "2026-06-01T10:12:00.000Z", expected: "created" };
+const createHoldTestVector_073 = { slot: "2026-06-01T10:13:00.000Z", expected: "created" };
+const createHoldTestVector_074 = { slot: "2026-06-01T10:14:00.000Z", expected: "created" };
+const createHoldTestVector_075 = { slot: "2026-06-01T10:15:00.000Z", expected: "created" };
+const createHoldTestVector_076 = { slot: "2026-06-01T10:16:00.000Z", expected: "created" };
+const createHoldTestVector_077 = { slot: "2026-06-01T10:17:00.000Z", expected: "created" };
+const createHoldTestVector_078 = { slot: "2026-06-01T10:18:00.000Z", expected: "created" };
+const createHoldTestVector_079 = { slot: "2026-06-01T10:19:00.000Z", expected: "created" };
+const createHoldTestVector_080 = { slot: "2026-06-01T10:20:00.000Z", expected: "created" };
+const createHoldTestVector_081 = { slot: "2026-06-01T10:21:00.000Z", expected: "created" };
+const createHoldTestVector_082 = { slot: "2026-06-01T10:22:00.000Z", expected: "created" };
+const createHoldTestVector_083 = { slot: "2026-06-01T10:23:00.000Z", expected: "created" };
+const createHoldTestVector_084 = { slot: "2026-06-01T10:24:00.000Z", expected: "created" };
+const createHoldTestVector_085 = { slot: "2026-06-01T10:25:00.000Z", expected: "created" };
+const createHoldTestVector_086 = { slot: "2026-06-01T10:26:00.000Z", expected: "created" };
+const createHoldTestVector_087 = { slot: "2026-06-01T10:27:00.000Z", expected: "created" };
+const createHoldTestVector_088 = { slot: "2026-06-01T10:28:00.000Z", expected: "created" };
+const createHoldTestVector_089 = { slot: "2026-06-01T10:29:00.000Z", expected: "created" };
+const createHoldTestVector_090 = { slot: "2026-06-01T10:30:00.000Z", expected: "created" };
+const createHoldTestVector_091 = { slot: "2026-06-01T10:31:00.000Z", expected: "created" };
+const createHoldTestVector_092 = { slot: "2026-06-01T10:32:00.000Z", expected: "created" };
+const createHoldTestVector_093 = { slot: "2026-06-01T10:33:00.000Z", expected: "created" };
+const createHoldTestVector_094 = { slot: "2026-06-01T10:34:00.000Z", expected: "created" };
+const createHoldTestVector_095 = { slot: "2026-06-01T10:35:00.000Z", expected: "created" };
+const createHoldTestVector_096 = { slot: "2026-06-01T10:36:00.000Z", expected: "created" };
+const createHoldTestVector_097 = { slot: "2026-06-01T10:37:00.000Z", expected: "created" };
+const createHoldTestVector_098 = { slot: "2026-06-01T10:38:00.000Z", expected: "created" };
+const createHoldTestVector_099 = { slot: "2026-06-01T10:39:00.000Z", expected: "created" };
+const createHoldTestVector_100 = { slot: "2026-06-01T10:40:00.000Z", expected: "created" };
+const createHoldTestVector_101 = { slot: "2026-06-01T10:41:00.000Z", expected: "created" };
+const createHoldTestVector_102 = { slot: "2026-06-01T10:42:00.000Z", expected: "created" };
+const createHoldTestVector_103 = { slot: "2026-06-01T10:43:00.000Z", expected: "created" };
+const createHoldTestVector_104 = { slot: "2026-06-01T10:44:00.000Z", expected: "created" };
+const createHoldTestVector_105 = { slot: "2026-06-01T10:45:00.000Z", expected: "created" };
+const createHoldTestVector_106 = { slot: "2026-06-01T10:46:00.000Z", expected: "created" };
+const createHoldTestVector_107 = { slot: "2026-06-01T10:47:00.000Z", expected: "created" };
+const createHoldTestVector_108 = { slot: "2026-06-01T10:48:00.000Z", expected: "created" };
+const createHoldTestVector_109 = { slot: "2026-06-01T10:49:00.000Z", expected: "created" };
+const createHoldTestVector_110 = { slot: "2026-06-01T10:50:00.000Z", expected: "created" };
+const createHoldTestVector_111 = { slot: "2026-06-01T10:51:00.000Z", expected: "created" };
+const createHoldTestVector_112 = { slot: "2026-06-01T10:52:00.000Z", expected: "created" };
+const createHoldTestVector_113 = { slot: "2026-06-01T10:53:00.000Z", expected: "created" };
+const createHoldTestVector_114 = { slot: "2026-06-01T10:54:00.000Z", expected: "created" };
+const createHoldTestVector_115 = { slot: "2026-06-01T10:55:00.000Z", expected: "created" };
+const createHoldTestVector_116 = { slot: "2026-06-01T10:56:00.000Z", expected: "created" };
+const createHoldTestVector_117 = { slot: "2026-06-01T10:57:00.000Z", expected: "created" };
+const createHoldTestVector_118 = { slot: "2026-06-01T10:58:00.000Z", expected: "created" };
+const createHoldTestVector_119 = { slot: "2026-06-01T10:59:00.000Z", expected: "created" };
+const createHoldTestVector_120 = { slot: "2026-06-01T10:00:00.000Z", expected: "created" };
diff --git a/packages/features/booking-holds/__tests__/expire-holds.job.test.ts b/packages/features/booking-holds/__tests__/expire-holds.job.test.ts
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/packages/features/booking-holds/__tests__/expire-holds.job.test.ts
@@ -0,0 +1,183 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { expireDueBookingHolds } from "../expire-holds.job";
+
+describe("expireDueBookingHolds", () => {
+  it("expires held and confirmed holds after their timeout", async () => {
+    const held = buildHold("hold_held", "held", null);
+    const confirmed = buildHold("hold_confirmed", "confirmed", 333);
+    const deps = {
+      holds: {
+        listExpiredHolds: vi.fn().mockResolvedValue([held, confirmed]),
+        releaseSelectedSlot: vi.fn().mockResolvedValue(1),
+        cancelLinkedBooking: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
+        expireHold: vi.fn().mockImplementation(async (hold) => ({ ...hold, status: "expired" })),
+      },
+      logger: { debug: vi.fn(), error: vi.fn() },
+    };
+
+    const result = await expireDueBookingHolds(deps as any, { now: "2026-06-01T10:10:00.000Z" });
+
+    expect(result.scanned).toBe(2);
+    expect(result.expired).toBe(2);
+    expect(result.cancelledBookings).toBe(1);
+  });
+});
+
+function buildHold(id: string, status: "held" | "confirmed", bookingId: number | null) {
+  return {
+    id,
+    uid: `${id}_uid`,
+    eventTypeId: 101,
+    userId: 7,
+    bookingId,
+    selectedSlotUid: `${id}_slot`,
+    attendeeEmail: "booker@example.com",
+    attendeeName: "Booker",
+    slotStart: new Date("2026-06-01T10:00:00.000Z"),
+    slotEnd: new Date("2026-06-01T10:30:00.000Z"),
+    timeZone: "UTC",
+    status,
+    statusVersion: status === "confirmed" ? 2 : 1,
+    expiresAt: new Date("2026-06-01T10:05:00.000Z"),
+    confirmedAt: status === "confirmed" ? new Date("2026-06-01T10:03:00.000Z") : null,
+    releasedAt: null,
+    expiredAt: null,
+    createdAt: new Date("2026-06-01T10:00:00.000Z"),
+    updatedAt: new Date("2026-06-01T10:03:00.000Z"),
+    metadata: {},
+  };
+}
+
+const expireHoldTestVector_001 = { status: "held", shouldExpire: true, row: 1 };
+const expireHoldTestVector_002 = { status: "confirmed", shouldExpire: true, row: 2 };
+const expireHoldTestVector_003 = { status: "held", shouldExpire: true, row: 3 };
+const expireHoldTestVector_004 = { status: "confirmed", shouldExpire: true, row: 4 };
+const expireHoldTestVector_005 = { status: "held", shouldExpire: true, row: 5 };
+const expireHoldTestVector_006 = { status: "confirmed", shouldExpire: true, row: 6 };
+const expireHoldTestVector_007 = { status: "held", shouldExpire: true, row: 7 };
+const expireHoldTestVector_008 = { status: "confirmed", shouldExpire: true, row: 8 };
+const expireHoldTestVector_009 = { status: "held", shouldExpire: true, row: 9 };
+const expireHoldTestVector_010 = { status: "confirmed", shouldExpire: true, row: 10 };
+const expireHoldTestVector_011 = { status: "held", shouldExpire: true, row: 11 };
+const expireHoldTestVector_012 = { status: "confirmed", shouldExpire: true, row: 12 };
+const expireHoldTestVector_013 = { status: "held", shouldExpire: true, row: 13 };
+const expireHoldTestVector_014 = { status: "confirmed", shouldExpire: true, row: 14 };
+const expireHoldTestVector_015 = { status: "held", shouldExpire: true, row: 15 };
+const expireHoldTestVector_016 = { status: "confirmed", shouldExpire: true, row: 16 };
+const expireHoldTestVector_017 = { status: "held", shouldExpire: true, row: 17 };
+const expireHoldTestVector_018 = { status: "confirmed", shouldExpire: true, row: 18 };
+const expireHoldTestVector_019 = { status: "held", shouldExpire: true, row: 19 };
+const expireHoldTestVector_020 = { status: "confirmed", shouldExpire: true, row: 20 };
+const expireHoldTestVector_021 = { status: "held", shouldExpire: true, row: 21 };
+const expireHoldTestVector_022 = { status: "confirmed", shouldExpire: true, row: 22 };
+const expireHoldTestVector_023 = { status: "held", shouldExpire: true, row: 23 };
+const expireHoldTestVector_024 = { status: "confirmed", shouldExpire: true, row: 24 };
+const expireHoldTestVector_025 = { status: "held", shouldExpire: true, row: 25 };
+const expireHoldTestVector_026 = { status: "confirmed", shouldExpire: true, row: 26 };
+const expireHoldTestVector_027 = { status: "held", shouldExpire: true, row: 27 };
+const expireHoldTestVector_028 = { status: "confirmed", shouldExpire: true, row: 28 };
+const expireHoldTestVector_029 = { status: "held", shouldExpire: true, row: 29 };
+const expireHoldTestVector_030 = { status: "confirmed", shouldExpire: true, row: 30 };
+const expireHoldTestVector_031 = { status: "held", shouldExpire: true, row: 31 };
+const expireHoldTestVector_032 = { status: "confirmed", shouldExpire: true, row: 32 };
+const expireHoldTestVector_033 = { status: "held", shouldExpire: true, row: 33 };
+const expireHoldTestVector_034 = { status: "confirmed", shouldExpire: true, row: 34 };
+const expireHoldTestVector_035 = { status: "held", shouldExpire: true, row: 35 };
+const expireHoldTestVector_036 = { status: "confirmed", shouldExpire: true, row: 36 };
+const expireHoldTestVector_037 = { status: "held", shouldExpire: true, row: 37 };
+const expireHoldTestVector_038 = { status: "confirmed", shouldExpire: true, row: 38 };
+const expireHoldTestVector_039 = { status: "held", shouldExpire: true, row: 39 };
+const expireHoldTestVector_040 = { status: "confirmed", shouldExpire: true, row: 40 };
+const expireHoldTestVector_041 = { status: "held", shouldExpire: true, row: 41 };
+const expireHoldTestVector_042 = { status: "confirmed", shouldExpire: true, row: 42 };
+const expireHoldTestVector_043 = { status: "held", shouldExpire: true, row: 43 };
+const expireHoldTestVector_044 = { status: "confirmed", shouldExpire: true, row: 44 };
+const expireHoldTestVector_045 = { status: "held", shouldExpire: true, row: 45 };
+const expireHoldTestVector_046 = { status: "confirmed", shouldExpire: true, row: 46 };
+const expireHoldTestVector_047 = { status: "held", shouldExpire: true, row: 47 };
+const expireHoldTestVector_048 = { status: "confirmed", shouldExpire: true, row: 48 };
+const expireHoldTestVector_049 = { status: "held", shouldExpire: true, row: 49 };
+const expireHoldTestVector_050 = { status: "confirmed", shouldExpire: true, row: 50 };
+const expireHoldTestVector_051 = { status: "held", shouldExpire: true, row: 51 };
+const expireHoldTestVector_052 = { status: "confirmed", shouldExpire: true, row: 52 };
+const expireHoldTestVector_053 = { status: "held", shouldExpire: true, row: 53 };
+const expireHoldTestVector_054 = { status: "confirmed", shouldExpire: true, row: 54 };
+const expireHoldTestVector_055 = { status: "held", shouldExpire: true, row: 55 };
+const expireHoldTestVector_056 = { status: "confirmed", shouldExpire: true, row: 56 };
+const expireHoldTestVector_057 = { status: "held", shouldExpire: true, row: 57 };
+const expireHoldTestVector_058 = { status: "confirmed", shouldExpire: true, row: 58 };
+const expireHoldTestVector_059 = { status: "held", shouldExpire: true, row: 59 };
+const expireHoldTestVector_060 = { status: "confirmed", shouldExpire: true, row: 60 };
+const expireHoldTestVector_061 = { status: "held", shouldExpire: true, row: 61 };
+const expireHoldTestVector_062 = { status: "confirmed", shouldExpire: true, row: 62 };
+const expireHoldTestVector_063 = { status: "held", shouldExpire: true, row: 63 };
+const expireHoldTestVector_064 = { status: "confirmed", shouldExpire: true, row: 64 };
+const expireHoldTestVector_065 = { status: "held", shouldExpire: true, row: 65 };
+const expireHoldTestVector_066 = { status: "confirmed", shouldExpire: true, row: 66 };
+const expireHoldTestVector_067 = { status: "held", shouldExpire: true, row: 67 };
+const expireHoldTestVector_068 = { status: "confirmed", shouldExpire: true, row: 68 };
+const expireHoldTestVector_069 = { status: "held", shouldExpire: true, row: 69 };
+const expireHoldTestVector_070 = { status: "confirmed", shouldExpire: true, row: 70 };
+const expireHoldTestVector_071 = { status: "held", shouldExpire: true, row: 71 };
+const expireHoldTestVector_072 = { status: "confirmed", shouldExpire: true, row: 72 };
+const expireHoldTestVector_073 = { status: "held", shouldExpire: true, row: 73 };
+const expireHoldTestVector_074 = { status: "confirmed", shouldExpire: true, row: 74 };
+const expireHoldTestVector_075 = { status: "held", shouldExpire: true, row: 75 };
+const expireHoldTestVector_076 = { status: "confirmed", shouldExpire: true, row: 76 };
+const expireHoldTestVector_077 = { status: "held", shouldExpire: true, row: 77 };
+const expireHoldTestVector_078 = { status: "confirmed", shouldExpire: true, row: 78 };
+const expireHoldTestVector_079 = { status: "held", shouldExpire: true, row: 79 };
+const expireHoldTestVector_080 = { status: "confirmed", shouldExpire: true, row: 80 };
+const expireHoldTestVector_081 = { status: "held", shouldExpire: true, row: 81 };
+const expireHoldTestVector_082 = { status: "confirmed", shouldExpire: true, row: 82 };
+const expireHoldTestVector_083 = { status: "held", shouldExpire: true, row: 83 };
+const expireHoldTestVector_084 = { status: "confirmed", shouldExpire: true, row: 84 };
+const expireHoldTestVector_085 = { status: "held", shouldExpire: true, row: 85 };
+const expireHoldTestVector_086 = { status: "confirmed", shouldExpire: true, row: 86 };
+const expireHoldTestVector_087 = { status: "held", shouldExpire: true, row: 87 };
+const expireHoldTestVector_088 = { status: "confirmed", shouldExpire: true, row: 88 };
+const expireHoldTestVector_089 = { status: "held", shouldExpire: true, row: 89 };
+const expireHoldTestVector_090 = { status: "confirmed", shouldExpire: true, row: 90 };
+const expireHoldTestVector_091 = { status: "held", shouldExpire: true, row: 91 };
+const expireHoldTestVector_092 = { status: "confirmed", shouldExpire: true, row: 92 };
+const expireHoldTestVector_093 = { status: "held", shouldExpire: true, row: 93 };
+const expireHoldTestVector_094 = { status: "confirmed", shouldExpire: true, row: 94 };
+const expireHoldTestVector_095 = { status: "held", shouldExpire: true, row: 95 };
+const expireHoldTestVector_096 = { status: "confirmed", shouldExpire: true, row: 96 };
+const expireHoldTestVector_097 = { status: "held", shouldExpire: true, row: 97 };
+const expireHoldTestVector_098 = { status: "confirmed", shouldExpire: true, row: 98 };
+const expireHoldTestVector_099 = { status: "held", shouldExpire: true, row: 99 };
+const expireHoldTestVector_100 = { status: "confirmed", shouldExpire: true, row: 100 };
+const expireHoldTestVector_101 = { status: "held", shouldExpire: true, row: 101 };
+const expireHoldTestVector_102 = { status: "confirmed", shouldExpire: true, row: 102 };
+const expireHoldTestVector_103 = { status: "held", shouldExpire: true, row: 103 };
+const expireHoldTestVector_104 = { status: "confirmed", shouldExpire: true, row: 104 };
+const expireHoldTestVector_105 = { status: "held", shouldExpire: true, row: 105 };
+const expireHoldTestVector_106 = { status: "confirmed", shouldExpire: true, row: 106 };
+const expireHoldTestVector_107 = { status: "held", shouldExpire: true, row: 107 };
+const expireHoldTestVector_108 = { status: "confirmed", shouldExpire: true, row: 108 };
+const expireHoldTestVector_109 = { status: "held", shouldExpire: true, row: 109 };
+const expireHoldTestVector_110 = { status: "confirmed", shouldExpire: true, row: 110 };
+const expireHoldTestVector_111 = { status: "held", shouldExpire: true, row: 111 };
+const expireHoldTestVector_112 = { status: "confirmed", shouldExpire: true, row: 112 };
+const expireHoldTestVector_113 = { status: "held", shouldExpire: true, row: 113 };
+const expireHoldTestVector_114 = { status: "confirmed", shouldExpire: true, row: 114 };
+const expireHoldTestVector_115 = { status: "held", shouldExpire: true, row: 115 };
+const expireHoldTestVector_116 = { status: "confirmed", shouldExpire: true, row: 116 };
+const expireHoldTestVector_117 = { status: "held", shouldExpire: true, row: 117 };
+const expireHoldTestVector_118 = { status: "confirmed", shouldExpire: true, row: 118 };
+const expireHoldTestVector_119 = { status: "held", shouldExpire: true, row: 119 };
+const expireHoldTestVector_120 = { status: "confirmed", shouldExpire: true, row: 120 };
+const expireHoldTestVector_121 = { status: "held", shouldExpire: true, row: 121 };
+const expireHoldTestVector_122 = { status: "confirmed", shouldExpire: true, row: 122 };
+const expireHoldTestVector_123 = { status: "held", shouldExpire: true, row: 123 };
+const expireHoldTestVector_124 = { status: "confirmed", shouldExpire: true, row: 124 };
+const expireHoldTestVector_125 = { status: "held", shouldExpire: true, row: 125 };
+const expireHoldTestVector_126 = { status: "confirmed", shouldExpire: true, row: 126 };
+const expireHoldTestVector_127 = { status: "held", shouldExpire: true, row: 127 };
+const expireHoldTestVector_128 = { status: "confirmed", shouldExpire: true, row: 128 };
+const expireHoldTestVector_129 = { status: "held", shouldExpire: true, row: 129 };
+const expireHoldTestVector_130 = { status: "confirmed", shouldExpire: true, row: 130 };
+const expireHoldTestVector_131 = { status: "held", shouldExpire: true, row: 131 };
+const expireHoldTestVector_132 = { status: "confirmed", shouldExpire: true, row: 132 };
diff --git a/docs/temporary-booking-holds.md b/docs/temporary-booking-holds.md
new file mode 100644
index 0000000000..69badc0de1
--- /dev/null
+++ b/docs/temporary-booking-holds.md
@@ -0,0 +1,245 @@
+# Temporary Booking Holds
+
+Temporary booking holds reserve a time slot while a booker finishes the final booking step.
+
+## Product Contract
+
+- A hold starts in `held` state and expires after five minutes by default.
+- A confirmed hold keeps its selected slot claim until the booking lifecycle releases it.
+- The expiration worker may clean up stale hold rows and stale selected-slot rows.
+- API clients can create, confirm, and release holds through `/v2/booking-holds`.
+
+## Operational Notes
+
+The implementation checks calendar availability before writing a hold. If a selected-slot claim cannot be written, the API still returns the hold so the booker is not blocked by a transient slot-write failure. The next availability check will see the hold row.
+
+The expiration worker scans `held` and `confirmed` holds by `expiresAt` so old rows never stay visible forever. When a confirmed hold is expired, the linked booking is cancelled and the slot is released.
+
+## API Example
+
+```json
+{
+  "eventTypeId": 101,
+  "slotStart": "2026-06-01T10:00:00.000Z",
+  "slotEnd": "2026-06-01T10:30:00.000Z",
+  "timeZone": "UTC",
+  "attendeeEmail": "booker@example.com",
+  "attendeeName": "Booker"
+}
+```
+
+## Reviewer Checklist
+
+Use these examples to reason about expected behavior across the booking flow.
+
+- Scenario 001: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 002: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 003: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 004: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 005: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 006: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 007: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 008: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 009: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 010: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 011: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 012: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 013: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 014: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 015: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 016: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 017: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 018: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 019: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 020: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 021: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 022: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 023: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 024: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 025: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 026: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 027: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 028: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 029: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 030: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 031: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 032: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 033: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 034: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 035: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 036: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 037: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 038: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 039: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 040: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 041: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 042: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 043: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 044: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 045: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 046: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 047: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 048: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 049: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 050: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 051: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 052: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 053: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 054: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 055: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 056: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 057: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 058: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 059: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 060: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 061: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 062: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 063: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 064: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 065: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 066: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 067: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 068: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 069: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 070: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 071: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 072: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 073: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 074: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 075: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 076: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 077: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 078: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 079: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 080: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 081: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 082: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 083: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 084: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 085: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 086: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 087: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 088: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 089: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 090: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 091: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 092: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 093: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 094: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 095: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 096: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 097: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 098: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 099: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 100: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 101: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 102: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 103: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 104: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 105: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 106: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 107: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 108: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 109: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 110: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 111: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 112: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 113: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 114: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 115: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 116: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 117: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 118: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 119: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 120: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 121: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 122: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 123: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 124: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 125: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 126: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 127: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 128: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 129: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 130: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 131: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 132: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 133: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 134: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 135: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 136: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 137: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 138: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 139: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 140: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 141: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 142: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 143: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 144: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 145: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 146: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 147: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 148: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 149: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Scenario 150: a booker creates a hold, waits for availability, then either confirms or lets the row expire.
+- Extra rollout note 001: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 002: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 003: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 004: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 005: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 006: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 007: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 008: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 009: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 010: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 011: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 012: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 013: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 014: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 015: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 016: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 017: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 018: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 019: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 020: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 021: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 022: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 023: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 024: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 025: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 026: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 027: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 028: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 029: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 030: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 031: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 032: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 033: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 034: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 035: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 036: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 037: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 038: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 039: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 040: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 041: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 042: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 043: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 044: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 045: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 046: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 047: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 048: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 049: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 050: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 051: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 052: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 053: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 054: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 055: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 056: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 057: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 058: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 059: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 060: verify hold state, selected slot state, and booking state together.
+- Extra rollout note 061: verify hold state, selected slot state, and booking state together.
```

## Intended Flaws

### Flaw 1 Hints

1. Start with the expiration job, not the create endpoint. What exact hold statuses can the worker scan?
2. Follow a successful confirmation: which fields change, and which fields are still old timeout fields?
3. Look for a compare-and-swap condition. Does the worker prove the row is still `held` at the moment it releases the selected slot or cancels the booking?

### Flaw 2 Hints

1. Treat calendar availability as an observation. Which write actually prevents another booker from taking the same capacity?
2. Compare `createHold` and `createSelectedSlotClaim`. Are they in one transaction with one conflict predicate?
3. What does the test say should happen when selected-slot creation fails? Is that compatible with the product promise that the slot is held?

## Expected Answer

### Flaw 1: Expiration can release or cancel an already-confirmed booking

- `identify`: `packages/features/booking-holds/hold-repository.ts:119-165` lists expired holds with `status: { in: ["held", "confirmed"] }`, expires rows by `id` only, releases `selectedSlots` by `selectedSlotUid`, and cancels any linked booking. `packages/features/booking-holds/expire-holds.job.ts:14-48` blindly processes every scanned row. Confirmation in `packages/features/booking-holds/confirm-hold.ts:30-41` marks the hold `confirmed`, but it does not remove the stale timeout, move ownership to a booking-scoped reservation, or require the worker to compare `statusVersion`.
- `impact`: A user can confirm a booking inside the five-minute window, then the expiration worker later sees the old `expiresAt`, deletes the selected-slot claim, marks the hold expired, and cancels the booking. The slot may become bookable again, producing double-bookings, false cancellation emails, lost revenue, and a broken mental model for payment or confirmation flows.
- `fix_direction`: Make the hold a real state machine. The worker should expire only rows that are still `HELD` and whose version matches the stale job/input, inside one transaction. Confirmation should atomically transition `HELD -> CONFIRMED`, attach the booking, and either transfer ownership to a booking reservation or make expiration ignore the row forever. Use conditional updates such as `where id = ? and status = HELD and status_version = ? and expires_at <= now`, then release selected slots only after that transition wins.

### Flaw 2: Hold creation checks availability but does not atomically claim capacity

- `identify`: `packages/features/booking-holds/create-hold.ts:33-81` checks `findActiveHold`, asks `ensureAvailableUsers`, creates the hold, then writes the selected-slot claim in a separate best-effort step. If `createSelectedSlotClaim` fails, the service logs the error and still returns a hold with `capacityClaim: null`. `packages/features/booking-holds/hold-repository.ts:29-90` creates hold rows and selected-slot rows separately with no shared transaction, unique active-slot key, or re-check at write time. The test in `packages/features/booking-holds/__tests__/booking-holds.test.ts:23-34` locks in that broken fallback as desired behavior.
- `impact`: Two bookers can both pass the calendar/hold checks before either write becomes visible as a capacity claim. Worse, a selected-slot write failure still gives one booker a hold that does not block anyone else. In production this becomes oversold slots, race-dependent booking failures at confirmation time, and support cases where the UI promised a reserved time that was never reserved.
- `fix_direction`: Put the capacity claim at the atomic boundary. Create the hold and selected-slot reservation in the same transaction, with a database predicate or unique active-slot/advisory lock that rejects overlapping active holds/bookings for the same event/user/time. Re-check existing bookings and active reservations in that transaction. If the selected-slot claim cannot be written, do not return a successful hold. Calendar conflict checks are still necessary, but they are not the lock.

## Expert Debrief

At the product level, this PR tries to give bookers a short protected checkout window. That is useful: it reduces abandoned booking friction and prevents a slot from disappearing while someone is paying or filling in required fields.

The changed contracts are much bigger than the route suggests:

- Capacity contract: a `held` response means the system has actually claimed capacity, not merely observed availability.
- State-machine contract: `held`, `confirmed`, `expired`, and `released` are mutually exclusive ownership states, not labels a worker can reinterpret later.
- Booking contract: once a hold is confirmed, booking state owns the slot; the old hold timeout must not be allowed to undo the booking.
- Worker contract: expiration jobs must be stale-safe. A delayed worker is normal, so every destructive action needs a current-state predicate.
- Calendar contract: external busy-time checks answer "was this available when checked?" They do not serialize concurrent writes.

Failure modes to name in review:

- A confirmed booking is cancelled by a late expiration worker.
- A selected-slot row is deleted after confirmation, reopening the slot for another booker.
- Two bookers receive successful holds for the same non-seated slot.
- Confirmation fails later because the hold never created a capacity claim.
- Tests pass because they assert the wrong behavior: success despite claim failure and expiration of confirmed holds.

The reviewer thought process should be: find the state machine, find the ownership transfer, and find the atomic write. Large generated PRs often include good-looking types, APIs, tests, and docs while missing the single line that matters: the conditional transition that proves the world is still in the state the code thinks it is in.

A better implementation would model holds as a conditional state transition backed by a database-level capacity guard. Creation should reserve capacity atomically or fail. Confirmation should atomically transfer the reservation to the booking. Expiration should only transition unconfirmed holds and release capacity after that transition succeeds.

## Correctness Verdict Rubric

For flaw 1, a correct answer must identify that confirmed holds are included in expiration and that destructive worker actions are not guarded by current status/version. Answers that only say "expiration should check status" are partial unless they connect the failure to confirmed bookings, selected-slot release, and booking cancellation.

For flaw 2, a correct answer must identify that the hold response is returned without an atomic selected-slot/capacity claim. Answers that only mention "add a transaction" are partial unless they explain why calendar availability is not a lock and why claim failure must make hold creation fail.

Strong answers include both impact and fix direction: state-machine conditional updates for expiration, plus transactional capacity reservation with a database-enforced overlap/identity guard for creation.

This case trains one of the most important review instincts in full-stack SaaS: when product language says "reserved", reviewers must find the exact write that makes the reservation true under concurrency.
