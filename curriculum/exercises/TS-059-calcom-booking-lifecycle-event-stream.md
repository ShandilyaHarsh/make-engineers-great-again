# TS-059: Cal.com Booking Lifecycle Event Stream

## Metadata

- `id`: TS-059
- `source_repo`: [calcom/cal.diy](https://github.com/calcom/cal.com)
- `repo_area`: booking creation service, recurring booking service, confirmation handler, webhook producer, booking status contracts, event payload builders, booking lifecycle tests, API v2 booking services
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,900-2,300
- `represented_diff_lines`: 2298
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Cal.com booking statuses, requested-vs-created semantics, recurring booking instances, confirmation flows, webhook contracts, and downstream lifecycle consumers without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a new internal booking lifecycle event stream. The goal is to give analytics, CRM sync, revenue reporting, customer success alerts, and workflow automation consumers one consistent event contract instead of having every consumer stitch together booking webhooks and status reads.

The PR adds:

- a `booking.lifecycle` event envelope,
- a lifecycle event builder for booking-created and booking-confirmed flows,
- a publisher abstraction wired into regular bookings,
- recurring booking lifecycle support,
- confirmation-handler lifecycle events,
- tests for requested, created, confirmed, and recurring bookings,
- docs for downstream consumers.

The intended product behavior is: consumers should be able to distinguish "a booking record was created", "a requested booking is pending host confirmation", and "a pending booking became confirmed". For recurring bookings, consumers should get lifecycle events for every concrete booking instance, not only a series-level summary.

## Existing Code Context

The real Cal.com codebase already has these relevant contracts:

- `packages/features/bookings/lib/handleNewBooking/createBooking.ts` creates bookings with `BookingStatus.ACCEPTED` when the event type is confirmed by default, and `BookingStatus.PENDING` when the event type requires confirmation.
- `packages/features/bookings/lib/service/RegularBookingService.ts` sends existing booking webhooks after create/reschedule and queues `BOOKING_REQUESTED` after pending bookings are updated with location, metadata, and references.
- `packages/features/webhooks/lib/service/WebhookTaskerProducerService.ts` already has separate producer methods such as `queueBookingCreatedWebhook`, `queueBookingRequestedWebhook`, `queueBookingRescheduledWebhook`, and `queueBookingRejectedWebhook`.
- `packages/features/webhooks/lib/factory/versioned/v2021-10-20/BookingPayloadBuilder.ts` builds `BOOKING_CREATED` payloads with accepted status and `BOOKING_REQUESTED` payloads with pending status.
- `packages/features/bookings/lib/handleConfirmation.ts` changes pending bookings to `BookingStatus.ACCEPTED`; when `recurringEventId` is provided, it finds all pending bookings in the recurring series and updates them.
- `packages/features/bookings/lib/service/RecurringBookingService.ts` loops through every recurring slot and calls `regularBookingService.createBooking` once per occurrence; tests assert multiple concrete bookings are created for a recurring request.
- `packages/features/bookings/lib/service/RecurringBookingService.test.ts` has recurring scenarios that expect four bookings and booking-created behavior for each instance.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this lifecycle stream is a reliable product contract for downstream consumers.

## Review Surface

Changed files in the synthetic PR:

- `packages/features/bookings/lifecycle/bookingLifecycleEvent.types.ts`
- `packages/features/bookings/lifecycle/buildBookingLifecycleEvent.ts`
- `packages/features/bookings/lifecycle/bookingLifecycleEventPublisher.ts`
- `packages/features/bookings/lifecycle/index.ts`
- `packages/features/bookings/lib/service/RegularBookingService.ts`
- `packages/features/bookings/lib/service/RecurringBookingService.ts`
- `packages/features/bookings/lib/handleConfirmation.ts`
- `packages/features/bookings/lifecycle/__tests__/buildBookingLifecycleEvent.test.ts`
- `packages/features/bookings/lib/service/RecurringBookingService.lifecycle.test.ts`
- `packages/features/bookings/lib/handleConfirmation.lifecycle.test.ts`
- `packages/features/bookings/lifecycle/README.md`

The line references below use synthetic PR line numbers. The represented diff is focused on lifecycle event vocabulary, status-transition semantics, and recurring instance coverage.

## Diff

```diff
diff --git a/packages/features/bookings/lifecycle/bookingLifecycleEvent.types.ts b/packages/features/bookings/lifecycle/bookingLifecycleEvent.types.ts
new file mode 100644
index 0000000000..8d71ac4201
--- /dev/null
+++ b/packages/features/bookings/lifecycle/bookingLifecycleEvent.types.ts
@@ -0,0 +1,126 @@
+import type { BookingStatus } from "@calcom/prisma/enums";
+
+export const BookingLifecycleEventName = "booking.lifecycle" as const;
+
+export type BookingLifecycleStatus =
+  | "ACCEPTED"
+  | "PENDING"
+  | "CANCELLED"
+  | "REJECTED"
+  | "AWAITING_HOST";
+
+export type BookingLifecycleActorType =
+  | "booker"
+  | "organizer"
+  | "team_member"
+  | "system"
+  | "api";
+
+export type BookingLifecycleConsumer =
+  | "analytics"
+  | "crm"
+  | "customer_success"
+  | "notifications"
+  | "reporting"
+  | "automation";
+
+export type BookingLifecycleSource =
+  | "webapp"
+  | "api_v1"
+  | "api_v2"
+  | "platform"
+  | "embed"
+  | "workflow";
+
+export type BookingLifecycleEvent = {
+  id: string;
+  eventName: typeof BookingLifecycleEventName;
+  bookingId: number;
+  bookingUid: string;
+  eventTypeId: number | null;
+  userId: number | null;
+  teamId: number | null;
+  orgId: number | null;
+  oAuthClientId: string | null;
+  title: string;
+  description: string | null;
+  startTime: string;
+  endTime: string;
+  timeZone: string | null;
+  status: BookingLifecycleStatus;
+  actorType: BookingLifecycleActorType;
+  source: BookingLifecycleSource;
+  attendeeEmail: string | null;
+  attendeeName: string | null;
+  organizerEmail: string | null;
+  organizerName: string | null;
+  recurringEventId: string | null;
+  recurringIndex: number | null;
+  recurringCount: number | null;
+  isRecurring: boolean;
+  location: string | null;
+  createdAt: string;
+  emittedAt: string;
+  metadata: Record<string, unknown>;
+  labels: string[];
+  consumers: BookingLifecycleConsumer[];
+};
+
+export type BookingLifecycleBookingSnapshot = {
+  id: number;
+  uid: string;
+  title: string;
+  description?: string | null;
+  eventTypeId?: number | null;
+  userId?: number | null;
+  teamId?: number | null;
+  orgId?: number | null;
+  oAuthClientId?: string | null;
+  startTime: Date | string;
+  endTime: Date | string;
+  timeZone?: string | null;
+  status: BookingStatus | BookingLifecycleStatus;
+  location?: string | null;
+  recurringEventId?: string | null;
+  recurringIndex?: number | null;
+  recurringCount?: number | null;
+  createdAt?: Date | string | null;
+  metadata?: Record<string, unknown> | null;
+  attendees?: Array<{
+    email?: string | null;
+    name?: string | null;
+    timeZone?: string | null;
+  }>;
+  user?: {
+    email?: string | null;
+    name?: string | null;
+  } | null;
+};
+
+export type BookingLifecycleContext = {
+  source?: BookingLifecycleSource;
+  actorType?: BookingLifecycleActorType;
+  teamId?: number | null;
+  orgId?: number | null;
+  oAuthClientId?: string | null;
+  recurringCount?: number | null;
+  recurringIndex?: number | null;
+  labels?: string[];
+  consumers?: BookingLifecycleConsumer[];
+  metadata?: Record<string, unknown>;
+};
+
+export type BookingLifecyclePublishInput = {
+  booking: BookingLifecycleBookingSnapshot;
+  context?: BookingLifecycleContext;
+};
+
+export type BookingLifecyclePublisher = {
+  publishBookingCreated(input: BookingLifecyclePublishInput): Promise<void>;
+  publishBookingRequested(input: BookingLifecyclePublishInput): Promise<void>;
+  publishBookingConfirmed(input: BookingLifecyclePublishInput): Promise<void>;
+  publishRecurringSeriesCreated(input: {
+    seriesId: string;
+    bookings: BookingLifecycleBookingSnapshot[];
+    context?: BookingLifecycleContext;
+  }): Promise<void>;
+};
+
+export type BookingLifecycleDelivery = {
+  topic: typeof BookingLifecycleEventName;
+  key: string;
+  payload: BookingLifecycleEvent;
+};
diff --git a/packages/features/bookings/lifecycle/buildBookingLifecycleEvent.ts b/packages/features/bookings/lifecycle/buildBookingLifecycleEvent.ts
new file mode 100644
index 0000000000..5af6d43ce8
--- /dev/null
+++ b/packages/features/bookings/lifecycle/buildBookingLifecycleEvent.ts
@@ -0,0 +1,196 @@
+import crypto from "node:crypto";
+
+import { BookingStatus } from "@calcom/prisma/enums";
+import {
+  BookingLifecycleEventName,
+  type BookingLifecycleBookingSnapshot,
+  type BookingLifecycleContext,
+  type BookingLifecycleEvent,
+  type BookingLifecycleStatus,
+} from "./bookingLifecycleEvent.types";
+
+type LifecycleAction = "created" | "requested" | "confirmed";
+
+function toIso(value: Date | string | null | undefined) {
+  if (!value) {
+    return new Date().toISOString();
+  }
+
+  if (value instanceof Date) {
+    return value.toISOString();
+  }
+
+  return new Date(value).toISOString();
+}
+
+function normalizeStatus(status: BookingLifecycleBookingSnapshot["status"]): BookingLifecycleStatus {
+  if (status === BookingStatus.ACCEPTED || status === "ACCEPTED") {
+    return "ACCEPTED";
+  }
+
+  if (status === BookingStatus.PENDING || status === "PENDING") {
+    return "PENDING";
+  }
+
+  if (status === BookingStatus.CANCELLED || status === "CANCELLED") {
+    return "CANCELLED";
+  }
+
+  if (status === BookingStatus.REJECTED || status === "REJECTED") {
+    return "REJECTED";
+  }
+
+  return "AWAITING_HOST";
+}
+
+function pickPrimaryAttendee(booking: BookingLifecycleBookingSnapshot) {
+  const attendee = booking.attendees?.[0];
+
+  return {
+    attendeeEmail: attendee?.email ?? null,
+    attendeeName: attendee?.name ?? null,
+    timeZone: attendee?.timeZone ?? booking.timeZone ?? null,
+  };
+}
+
+function createBasePayload({
+  booking,
+  context,
+}: {
+  booking: BookingLifecycleBookingSnapshot;
+  context?: BookingLifecycleContext;
+}) {
+  const primaryAttendee = pickPrimaryAttendee(booking);
+  const metadata = {
+    ...(booking.metadata ?? {}),
+    ...(context?.metadata ?? {}),
+  };
+
+  return {
+    bookingId: booking.id,
+    bookingUid: booking.uid,
+    eventTypeId: booking.eventTypeId ?? null,
+    userId: booking.userId ?? null,
+    teamId: context?.teamId ?? booking.teamId ?? null,
+    orgId: context?.orgId ?? booking.orgId ?? null,
+    oAuthClientId: context?.oAuthClientId ?? booking.oAuthClientId ?? null,
+    title: booking.title,
+    description: booking.description ?? null,
+    startTime: toIso(booking.startTime),
+    endTime: toIso(booking.endTime),
+    timeZone: primaryAttendee.timeZone,
+    attendeeEmail: primaryAttendee.attendeeEmail,
+    attendeeName: primaryAttendee.attendeeName,
+    organizerEmail: booking.user?.email ?? null,
+    organizerName: booking.user?.name ?? null,
+    recurringEventId: booking.recurringEventId ?? null,
+    recurringIndex: context?.recurringIndex ?? booking.recurringIndex ?? null,
+    recurringCount: context?.recurringCount ?? booking.recurringCount ?? null,
+    isRecurring: Boolean(context?.recurringCount || booking.recurringEventId),
+    location: booking.location ?? null,
+    createdAt: toIso(booking.createdAt),
+    metadata,
+    labels: context?.labels ?? [],
+    consumers: context?.consumers ?? [
+      "analytics",
+      "crm",
+      "customer_success",
+      "notifications",
+      "reporting",
+      "automation",
+    ],
+  };
+}
+
+function lifecycleStatusForAction({
+  action,
+  booking,
+}: {
+  action: LifecycleAction;
+  booking: BookingLifecycleBookingSnapshot;
+}) {
+  if (action === "requested") {
+    return "PENDING" as const;
+  }
+
+  if (action === "created") {
+    return "ACCEPTED" as const;
+  }
+
+  if (action === "confirmed") {
+    return "ACCEPTED" as const;
+  }
+
+  return normalizeStatus(booking.status);
+}
+
+export function buildBookingLifecycleEvent({
+  action,
+  booking,
+  context,
+}: {
+  action: LifecycleAction;
+  booking: BookingLifecycleBookingSnapshot;
+  context?: BookingLifecycleContext;
+}): BookingLifecycleEvent {
+  const base = createBasePayload({ booking, context });
+  const status = lifecycleStatusForAction({ action, booking });
+
+  return {
+    id: crypto.randomUUID(),
+    eventName: BookingLifecycleEventName,
+    ...base,
+    status,
+    actorType: context?.actorType ?? "system",
+    source: context?.source ?? "webapp",
+    emittedAt: new Date().toISOString(),
+    metadata: {
+      ...base.metadata,
+      lifecycleAction: action,
+      lifecycleStatus: status,
+      consumerStatus: status.toLowerCase(),
+    },
+  };
+}
+
+export function buildBookingCreatedLifecycleEvent({
+  booking,
+  context,
+}: {
+  booking: BookingLifecycleBookingSnapshot;
+  context?: BookingLifecycleContext;
+}) {
+  return buildBookingLifecycleEvent({
+    action: "created",
+    booking,
+    context: {
+      ...context,
+      labels: [...(context?.labels ?? []), "booking_created"],
+    },
+  });
+}
+
+export function buildBookingRequestedLifecycleEvent({
+  booking,
+  context,
+}: {
+  booking: BookingLifecycleBookingSnapshot;
+  context?: BookingLifecycleContext;
+}) {
+  return buildBookingLifecycleEvent({
+    action: "requested",
+    booking,
+    context: {
+      ...context,
+      labels: [...(context?.labels ?? []), "booking_requested"],
+    },
+  });
+}
+
+export function buildBookingConfirmedLifecycleEvent({
+  booking,
+  context,
+}: {
+  booking: BookingLifecycleBookingSnapshot;
+  context?: BookingLifecycleContext;
+}) {
+  return buildBookingLifecycleEvent({
+    action: "confirmed",
+    booking,
+    context: {
+      ...context,
+      labels: [...(context?.labels ?? []), "booking_confirmed"],
+    },
+  });
+}
+
+export function buildRecurringSeriesLifecycleEvent({
+  seriesId,
+  bookings,
+  context,
+}: {
+  seriesId: string;
+  bookings: BookingLifecycleBookingSnapshot[];
+  context?: BookingLifecycleContext;
+}) {
+  const firstBooking = bookings[0];
+
+  if (!firstBooking) {
+    throw new Error("Cannot build recurring series lifecycle event without at least one booking");
+  }
+
+  return buildBookingCreatedLifecycleEvent({
+    booking: {
+      ...firstBooking,
+      uid: seriesId,
+      recurringEventId: seriesId,
+      recurringCount: bookings.length,
+      recurringIndex: null,
+    },
+    context: {
+      ...context,
+      recurringCount: bookings.length,
+      recurringIndex: null,
+      labels: [...(context?.labels ?? []), "recurring_series_created"],
+      metadata: {
+        ...(context?.metadata ?? {}),
+        seriesId,
+        bookingUids: bookings.map((booking) => booking.uid),
+        instanceCount: bookings.length,
+      },
+    },
+  });
+}
diff --git a/packages/features/bookings/lifecycle/bookingLifecycleEventPublisher.ts b/packages/features/bookings/lifecycle/bookingLifecycleEventPublisher.ts
new file mode 100644
index 0000000000..f752049014
--- /dev/null
+++ b/packages/features/bookings/lifecycle/bookingLifecycleEventPublisher.ts
@@ -0,0 +1,228 @@
+import logger from "@calcom/lib/logger";
+import type { EventBusService } from "@calcom/lib/server/event-bus";
+import {
+  buildBookingConfirmedLifecycleEvent,
+  buildBookingCreatedLifecycleEvent,
+  buildBookingRequestedLifecycleEvent,
+  buildRecurringSeriesLifecycleEvent,
+} from "./buildBookingLifecycleEvent";
+import {
+  BookingLifecycleEventName,
+  type BookingLifecycleDelivery,
+  type BookingLifecyclePublishInput,
+  type BookingLifecyclePublisher,
+  type BookingLifecycleEvent,
+} from "./bookingLifecycleEvent.types";
+
+type PublishTransport = Pick<EventBusService, "publish"> | undefined;
+
+export type BookingLifecycleEventPublisherOptions = {
+  transport?: PublishTransport;
+  enabled?: boolean;
+  environment?: string;
+};
+
+const log = logger.getSubLogger({ prefix: ["booking-lifecycle-events"] });
+
+function createDelivery(payload: BookingLifecycleEvent): BookingLifecycleDelivery {
+  return {
+    topic: BookingLifecycleEventName,
+    key: payload.bookingUid,
+    payload,
+  };
+}
+
+async function publishDelivery({
+  transport,
+  delivery,
+  enabled,
+}: {
+  transport: PublishTransport;
+  delivery: BookingLifecycleDelivery;
+  enabled: boolean;
+}) {
+  if (!enabled) {
+    log.debug("Booking lifecycle event stream disabled", {
+      bookingUid: delivery.payload.bookingUid,
+      topic: delivery.topic,
+    });
+    return;
+  }
+
+  if (!transport) {
+    log.warn("Booking lifecycle event transport missing", {
+      bookingUid: delivery.payload.bookingUid,
+      topic: delivery.topic,
+    });
+    return;
+  }
+
+  await transport.publish(delivery.topic, {
+    key: delivery.key,
+    payload: delivery.payload,
+  });
+}
+
+export class DefaultBookingLifecycleEventPublisher implements BookingLifecyclePublisher {
+  private readonly transport: PublishTransport;
+  private readonly enabled: boolean;
+  private readonly environment: string;
+
+  constructor(options: BookingLifecycleEventPublisherOptions = {}) {
+    this.transport = options.transport;
+    this.enabled = options.enabled ?? process.env.CAL_BOOKING_LIFECYCLE_EVENTS === "1";
+    this.environment = options.environment ?? process.env.NODE_ENV ?? "development";
+  }
+
+  async publishBookingCreated(input: BookingLifecyclePublishInput): Promise<void> {
+    const payload = buildBookingCreatedLifecycleEvent({
+      booking: input.booking,
+      context: {
+        ...input.context,
+        metadata: {
+          ...(input.context?.metadata ?? {}),
+          environment: this.environment,
+          emittedBy: "regular-booking-service",
+        },
+      },
+    });
+
+    await publishDelivery({
+      transport: this.transport,
+      delivery: createDelivery(payload),
+      enabled: this.enabled,
+    });
+  }
+
+  async publishBookingRequested(input: BookingLifecyclePublishInput): Promise<void> {
+    const payload = buildBookingRequestedLifecycleEvent({
+      booking: input.booking,
+      context: {
+        ...input.context,
+        metadata: {
+          ...(input.context?.metadata ?? {}),
+          environment: this.environment,
+          emittedBy: "regular-booking-service",
+        },
+      },
+    });
+
+    await publishDelivery({
+      transport: this.transport,
+      delivery: createDelivery(payload),
+      enabled: this.enabled,
+    });
+  }
+
+  async publishBookingConfirmed(input: BookingLifecyclePublishInput): Promise<void> {
+    const payload = buildBookingConfirmedLifecycleEvent({
+      booking: input.booking,
+      context: {
+        ...input.context,
+        metadata: {
+          ...(input.context?.metadata ?? {}),
+          environment: this.environment,
+          emittedBy: "confirm-handler",
+        },
+      },
+    });
+
+    await publishDelivery({
+      transport: this.transport,
+      delivery: createDelivery(payload),
+      enabled: this.enabled,
+    });
+  }
+
+  async publishRecurringSeriesCreated(input: {
+    seriesId: string;
+    bookings: BookingLifecyclePublishInput["booking"][];
+    context?: BookingLifecyclePublishInput["context"];
+  }): Promise<void> {
+    const payload = buildRecurringSeriesLifecycleEvent({
+      seriesId: input.seriesId,
+      bookings: input.bookings,
+      context: {
+        ...input.context,
+        metadata: {
+          ...(input.context?.metadata ?? {}),
+          environment: this.environment,
+          emittedBy: "recurring-booking-service",
+        },
+      },
+    });
+
+    await publishDelivery({
+      transport: this.transport,
+      delivery: createDelivery(payload),
+      enabled: this.enabled,
+    });
+  }
+}
+
+export class InMemoryBookingLifecycleEventPublisher implements BookingLifecyclePublisher {
+  public readonly deliveries: BookingLifecycleDelivery[] = [];
+
+  async publishBookingCreated(input: BookingLifecyclePublishInput): Promise<void> {
+    this.deliveries.push(
+      createDelivery(
+        buildBookingCreatedLifecycleEvent({
+          booking: input.booking,
+          context: input.context,
+        })
+      )
+    );
+  }
+
+  async publishBookingRequested(input: BookingLifecyclePublishInput): Promise<void> {
+    this.deliveries.push(
+      createDelivery(
+        buildBookingRequestedLifecycleEvent({
+          booking: input.booking,
+          context: input.context,
+        })
+      )
+    );
+  }
+
+  async publishBookingConfirmed(input: BookingLifecyclePublishInput): Promise<void> {
+    this.deliveries.push(
+      createDelivery(
+        buildBookingConfirmedLifecycleEvent({
+          booking: input.booking,
+          context: input.context,
+        })
+      )
+    );
+  }
+
+  async publishRecurringSeriesCreated(input: {
+    seriesId: string;
+    bookings: BookingLifecyclePublishInput["booking"][];
+    context?: BookingLifecyclePublishInput["context"];
+  }): Promise<void> {
+    this.deliveries.push(
+      createDelivery(
+        buildRecurringSeriesLifecycleEvent({
+          seriesId: input.seriesId,
+          bookings: input.bookings,
+          context: input.context,
+        })
+      )
+    );
+  }
+
+  findByBookingUid(bookingUid: string) {
+    return this.deliveries.filter((delivery) => delivery.payload.bookingUid === bookingUid);
+  }
+
+  findBySeriesId(seriesId: string) {
+    return this.deliveries.filter((delivery) => delivery.payload.recurringEventId === seriesId);
+  }
+
+  clear() {
+    this.deliveries.splice(0, this.deliveries.length);
+  }
+}
+
+let defaultPublisher: BookingLifecyclePublisher | null = null;
+
+export function getBookingLifecycleEventPublisher() {
+  if (!defaultPublisher) {
+    defaultPublisher = new DefaultBookingLifecycleEventPublisher();
+  }
+
+  return defaultPublisher;
+}
+
+export function setBookingLifecycleEventPublisherForTests(publisher: BookingLifecyclePublisher | null) {
+  defaultPublisher = publisher;
+}
+
+export async function publishBookingLifecycleEventSafely(
+  operation: () => Promise<void>,
+  context: { bookingUid?: string; operationName: string }
+) {
+  try {
+    await operation();
+  } catch (error) {
+    log.error("Failed to publish booking lifecycle event", {
+      operationName: context.operationName,
+      bookingUid: context.bookingUid,
+      error,
+    });
+  }
+}
diff --git a/packages/features/bookings/lifecycle/index.ts b/packages/features/bookings/lifecycle/index.ts
new file mode 100644
index 0000000000..d82675f111
--- /dev/null
+++ b/packages/features/bookings/lifecycle/index.ts
@@ -0,0 +1,44 @@
+export {
+  BookingLifecycleEventName,
+  type BookingLifecycleActorType,
+  type BookingLifecycleBookingSnapshot,
+  type BookingLifecycleConsumer,
+  type BookingLifecycleContext,
+  type BookingLifecycleDelivery,
+  type BookingLifecycleEvent,
+  type BookingLifecyclePublishInput,
+  type BookingLifecyclePublisher,
+  type BookingLifecycleSource,
+  type BookingLifecycleStatus,
+} from "./bookingLifecycleEvent.types";
+
+export {
+  buildBookingConfirmedLifecycleEvent,
+  buildBookingCreatedLifecycleEvent,
+  buildBookingLifecycleEvent,
+  buildBookingRequestedLifecycleEvent,
+  buildRecurringSeriesLifecycleEvent,
+} from "./buildBookingLifecycleEvent";
+
+export {
+  DefaultBookingLifecycleEventPublisher,
+  InMemoryBookingLifecycleEventPublisher,
+  getBookingLifecycleEventPublisher,
+  publishBookingLifecycleEventSafely,
+  setBookingLifecycleEventPublisherForTests,
+} from "./bookingLifecycleEventPublisher";
diff --git a/packages/features/bookings/lib/service/RegularBookingService.ts b/packages/features/bookings/lib/service/RegularBookingService.ts
index d933c1ab12..0a381fc6ef 100644
--- a/packages/features/bookings/lib/service/RegularBookingService.ts
+++ b/packages/features/bookings/lib/service/RegularBookingService.ts
@@ -43,6 +43,14 @@ import type { CalendarEvent } from "@calcom/types/Calendar";
 import type { AppsStatus } from "@calcom/types/Calendar";
 import type { EventBusyDetails } from "@calcom/types/Calendar";
 import type { IBookingService } from "../interfaces/IBookingService";
+import {
+  getBookingLifecycleEventPublisher,
+  publishBookingLifecycleEventSafely,
+  type BookingLifecycleBookingSnapshot,
+  type BookingLifecycleContext,
+  type BookingLifecyclePublisher,
+} from "../../lifecycle";
 import { createBooking } from "../handleNewBooking/createBooking";
 import { getEventTypesFromDB } from "../handleNewBooking/getEventTypesFromDB";
 import { handlePayment } from "../handleNewBooking/handlePayment";
@@ -154,6 +162,18 @@ type CreatedBooking = Booking & {
 } & { appsStatus?: AppsStatus[]; paymentUid?: string; paymentId?: number };
 type ReturnTypeCreateBooking = Awaited<ReturnType<typeof createBooking>>;
+type LifecycleCapableCreatedBooking = CreatedBooking & {
+  attendees?: Array<{
+    email?: string | null;
+    name?: string | null;
+    timeZone?: string | null;
+  }>;
+  user?: {
+    email?: string | null;
+    name?: string | null;
+  } | null;
+};
+
 export const buildDryRunBooking = ({
   eventTypeId,
   organizerUser,
@@ -326,6 +346,66 @@ async function scheduleNoShowTriggersForBooking({
   }
 }
+
+function toBookingLifecycleSnapshot({
+  booking,
+  subscriberOptions,
+  platformClientId,
+  recurringCount,
+  recurringIndex,
+}: {
+  booking: LifecycleCapableCreatedBooking;
+  subscriberOptions: GetSubscriberOptions;
+  platformClientId?: string | null;
+  recurringCount?: number | null;
+  recurringIndex?: number | null;
+}): BookingLifecycleBookingSnapshot {
+  return {
+    id: booking.id,
+    uid: booking.uid,
+    title: booking.title,
+    description: booking.description,
+    eventTypeId: booking.eventTypeId,
+    userId: subscriberOptions.userId ?? booking.userId ?? null,
+    teamId: Array.isArray(subscriberOptions.teamId)
+      ? subscriberOptions.teamId[0] ?? null
+      : subscriberOptions.teamId ?? null,
+    orgId: subscriberOptions.orgId ?? null,
+    oAuthClientId: platformClientId ?? null,
+    startTime: booking.startTime,
+    endTime: booking.endTime,
+    timeZone: booking.attendees?.[0]?.timeZone ?? null,
+    status: booking.status,
+    location: booking.location,
+    recurringEventId: booking.recurringEventId,
+    recurringIndex,
+    recurringCount,
+    createdAt: booking.createdAt,
+    metadata:
+      booking.metadata && typeof booking.metadata === "object"
+        ? (booking.metadata as Record<string, unknown>)
+        : {},
+    attendees: booking.attendees,
+    user: booking.user,
+  };
+}
+
+async function publishLifecycleForCreatedBooking({
+  booking,
+  subscriberOptions,
+  platformClientId,
+  publisher,
+  context,
+}: {
+  booking: LifecycleCapableCreatedBooking;
+  subscriberOptions: GetSubscriberOptions;
+  platformClientId?: string | null;
+  publisher: BookingLifecyclePublisher;
+  context: BookingLifecycleContext;
+}) {
+  const snapshot = toBookingLifecycleSnapshot({
+    booking,
+    subscriberOptions,
+    platformClientId,
+    recurringCount: context.recurringCount,
+    recurringIndex: context.recurringIndex,
+  });
+
+  await publishBookingLifecycleEventSafely(
+    () =>
+      booking.status === BookingStatus.PENDING
+        ? publisher.publishBookingRequested({ booking: snapshot, context })
+        : publisher.publishBookingCreated({ booking: snapshot, context }),
+    { bookingUid: booking.uid, operationName: "publish-created-booking-lifecycle-event" }
+  );
+}
@@ -593,6 +673,7 @@ export async function handleNewBooking({
   const deps = getDependencies();
   const bookerUrl = input.bookerUrl || WEBAPP_URL;
   const isDryRun = Boolean(input.dryRun);
+  const lifecycleEventPublisher = getBookingLifecycleEventPublisher();
   const traceContext = input.traceContext;
   const metadata = input.metadata || {};
   const creationSource = input.creationSource || "WEBAPP";
@@ -1664,6 +1745,18 @@ export async function handleNewBooking({
     }
   }
 
+  const lifecycleContext: BookingLifecycleContext = {
+    source: creationSource === "API" ? "api_v2" : "webapp",
+    actorType: input.userId && input.userId > 0 ? "organizer" : "booker",
+    teamId: Array.isArray(subscriberOptions.teamId)
+      ? subscriberOptions.teamId[0] ?? null
+      : subscriberOptions.teamId ?? null,
+    orgId: subscriberOptions.orgId ?? null,
+    oAuthClientId: platformClientId ?? null,
+    recurringCount: reqBody.allRecurringDates?.length ?? null,
+    recurringIndex: reqBody.currentRecurringIndex ?? null,
+  };
+
   // Send Webhook call if hooked to BOOKING_CREATED & BOOKING_RESCHEDULED
   if (!isDryRun) {
     await handleWebhookTrigger({
@@ -1684,6 +1777,17 @@ export async function handleNewBooking({
       traceContext,
     });
   }
+
+  if (booking && booking.status !== BookingStatus.PENDING && !isDryRun) {
+    await publishLifecycleForCreatedBooking({
+      booking: booking as LifecycleCapableCreatedBooking,
+      subscriberOptions,
+      platformClientId,
+      publisher: lifecycleEventPublisher,
+      context: lifecycleContext,
+    });
+  }
 
   if (!booking) throw new HttpError({ statusCode: 400, message: "Booking failed" });
 
@@ -2474,6 +2578,29 @@ export async function handleNewBooking({
       );
     }
   }
+
+  if (booking && booking.status === BookingStatus.PENDING && !isDryRun) {
+    await publishBookingLifecycleEventSafely(
+      () =>
+        lifecycleEventPublisher.publishBookingRequested({
+          booking: toBookingLifecycleSnapshot({
+            booking: booking as LifecycleCapableCreatedBooking,
+            subscriberOptions,
+            platformClientId,
+            recurringCount: lifecycleContext.recurringCount,
+            recurringIndex: lifecycleContext.recurringIndex,
+          }),
+          context: {
+            ...lifecycleContext,
+            metadata: {
+              existingWebhook: "BOOKING_REQUESTED",
+              referencesCreated: referencesToCreate.length,
+            },
+          },
+        }),
+      { bookingUid: booking.uid, operationName: "publish-requested-booking-lifecycle-event" }
+    );
+  }
 
   const evtWithMetadata = {
     ...evt,
diff --git a/packages/features/bookings/lib/service/RecurringBookingService.ts b/packages/features/bookings/lib/service/RecurringBookingService.ts
index 0b3f60480d..a17cc52d60 100644
--- a/packages/features/bookings/lib/service/RecurringBookingService.ts
+++ b/packages/features/bookings/lib/service/RecurringBookingService.ts
@@ -1,11 +1,21 @@
 import type { CreateBookingMeta, CreateRecurringBookingData } from "@calcom/features/bookings/lib/dto/types";
 import type { BookingResponse } from "@calcom/features/bookings/types";
 import { type CreationSource, SchedulingType } from "@calcom/prisma/enums";
 import type { AppsStatus } from "@calcom/types/Calendar";
+import {
+  getBookingLifecycleEventPublisher,
+  publishBookingLifecycleEventSafely,
+  type BookingLifecycleBookingSnapshot,
+  type BookingLifecyclePublisher,
+} from "../../lifecycle";
 import type { IBookingService } from "../interfaces/IBookingService";
 import type { RegularBookingService } from "./RegularBookingService";
 export type BookingHandlerInput = {
   bookingData: CreateRecurringBookingData;
 } & CreateBookingMeta;
+
+function getSeriesIdFromBookings(bookings: BookingResponse[]) {
+  return bookings[0]?.recurringEventId || bookings[0]?.uid || "unknown-recurring-series";
+}
 
 export const handleNewRecurringBooking = async function (
   this: RecurringBookingService,
@@ -17,6 +27,7 @@ export const handleNewRecurringBooking = async function (
     deps: IRecurringBookingServiceDependencies;
     creationSource: CreationSource;
   }
 ): Promise<BookingResponse[]> {
   const data = input.bookingData;
   const { regularBookingService } = deps;
+  const lifecycleEventPublisher = deps.lifecycleEventPublisher ?? getBookingLifecycleEventPublisher();
   const createdBookings: BookingResponse[] = [];
   const allRecurringDates: { start: string; end: string | undefined }[] = data.map((booking) => {
     return { start: booking.start, end: booking.end };
@@ -68,6 +79,17 @@ export const handleNewRecurringBooking = async function (
       },
     });
     luckyUsers = firstBookingResult.luckyUsers;
+    createdBookings.push(firstBookingResult);
   }
 
   for (let key = isRoundRobin ? 1 : 0; key < data.length; key++) {
@@ -112,6 +134,47 @@ export const handleNewRecurringBooking = async function (
     }
   }
+
+  if (createdBookings.length > 0) {
+    const seriesId = getSeriesIdFromBookings(createdBookings);
+    const snapshots: BookingLifecycleBookingSnapshot[] = createdBookings.map((booking, index) => ({
+      id: booking.id,
+      uid: booking.uid,
+      title: booking.title,
+      description: booking.description,
+      eventTypeId: booking.eventTypeId,
+      userId: booking.userId,
+      teamId: null,
+      orgId: null,
+      oAuthClientId: input.platformClientId ?? null,
+      startTime: booking.startTime,
+      endTime: booking.endTime,
+      timeZone: booking.attendees?.[0]?.timeZone ?? null,
+      status: booking.status,
+      location: booking.location,
+      recurringEventId: seriesId,
+      recurringIndex: index,
+      recurringCount: createdBookings.length,
+      createdAt: booking.createdAt,
+      metadata:
+        booking.metadata && typeof booking.metadata === "object"
+          ? (booking.metadata as Record<string, unknown>)
+          : {},
+      attendees: booking.attendees,
+      user: booking.user,
+    }));
+
+    await publishBookingLifecycleEventSafely(
+      () =>
+        lifecycleEventPublisher.publishRecurringSeriesCreated({
+          seriesId,
+          bookings: snapshots,
+          context: {
+            source: creationSource === "API" ? "api_v2" : "webapp",
+            actorType: input.userId && input.userId > 0 ? "organizer" : "booker",
+            recurringCount: createdBookings.length,
+            recurringIndex: null,
+            oAuthClientId: input.platformClientId ?? null,
+          },
+        }),
+      { bookingUid: seriesId, operationName: "publish-recurring-series-created-lifecycle-event" }
+    );
+  }
 
   return createdBookings;
 };
@@ -119,11 +182,13 @@ export const handleNewRecurringBooking = async function (
 export interface IRecurringBookingServiceDependencies {
   regularBookingService: RegularBookingService;
+  lifecycleEventPublisher?: BookingLifecyclePublisher;
 }
 
 /**
  * Recurring Booking Service takes care of creating/rescheduling recurring bookings.
  */
 export class RecurringBookingService implements IBookingService {
   constructor(private readonly deps: IRecurringBookingServiceDependencies) {}
 
   async createBooking(input: {
@@ -137,6 +202,7 @@ export class RecurringBookingService implements IBookingService {
     return handleNewRecurringBooking.bind(this)({
       input: handlerInput,
       deps: this.deps,
       creationSource: input.creationSource,
     });
   }
diff --git a/packages/features/bookings/lib/handleConfirmation.ts b/packages/features/bookings/lib/handleConfirmation.ts
index efc04d8820..764ae9bb91 100644
--- a/packages/features/bookings/lib/handleConfirmation.ts
+++ b/packages/features/bookings/lib/handleConfirmation.ts
@@ -20,6 +20,12 @@ import { getTranslation } from "@calcom/i18n/server";
 import logger from "@calcom/lib/logger";
 import { safeStringify } from "@calcom/lib/safeStringify";
 import { getTimeFormatStringFromUserTimeFormat } from "@calcom/lib/timeFormat";
+import {
+  getBookingLifecycleEventPublisher,
+  publishBookingLifecycleEventSafely,
+  type BookingLifecycleBookingSnapshot,
+} from "../lifecycle";
 import type { TraceContext } from "@calcom/lib/tracing";
 import { prisma } from "@calcom/prisma";
 import { Prisma } from "@calcom/prisma/client";
@@ -43,6 +49,42 @@ type ConfirmOptions = {
   input: TConfirmInputSchema;
 };
+
+function toLifecycleSnapshotFromConfirmedBooking({
+  booking,
+  userId,
+  platformClientId,
+}: {
+  booking: {
+    id: number;
+    uid: string;
+    title: string;
+    description: string | null;
+    eventTypeId: number | null;
+    userId: number | null;
+    startTime: Date;
+    endTime: Date;
+    status: BookingStatus;
+    location: string | null;
+    recurringEventId: string | null;
+    metadata: unknown;
+    attendees: Array<{ email?: string | null; name?: string | null; timeZone?: string | null }>;
+  };
+  userId: number | null;
+  platformClientId?: string | null;
+}): BookingLifecycleBookingSnapshot {
+  return {
+    id: booking.id,
+    uid: booking.uid,
+    title: booking.title,
+    description: booking.description,
+    eventTypeId: booking.eventTypeId,
+    userId: booking.userId ?? userId,
+    teamId: null,
+    orgId: null,
+    oAuthClientId: platformClientId ?? null,
+    startTime: booking.startTime,
+    endTime: booking.endTime,
+    timeZone: booking.attendees[0]?.timeZone ?? null,
+    status: booking.status,
+    location: booking.location,
+    recurringEventId: booking.recurringEventId,
+    metadata: typeof booking.metadata === "object" && booking.metadata ? (booking.metadata as Record<string, unknown>) : {},
+    attendees: booking.attendees,
+  };
+}
 
 /**
 * Existing note: convert this to a service; it is the single entry point across trpc, magic-links, and API v2.
@@ -53,6 +95,7 @@ export const confirmHandler = async ({ ctx, input }: ConfirmOptions) => {
     bookingId,
     recurringEventId,
     reason: rejectionReason,
     confirmed,
     emailsEnabled,
     platformClientParams,
   } = input;
+  const lifecycleEventPublisher = getBookingLifecycleEventPublisher();
 
   const booking = await prisma.booking.findUniqueOrThrow({
@@ -303,6 +346,43 @@ export const confirmHandler = async ({ ctx, input }: ConfirmOptions) => {
     ];
   }
+
+  const confirmedLifecycleTargets = updatedBookings.map((updatedBooking) => ({
+    id: updatedBooking.id,
+    uid: updatedBooking.uid,
+    title: updatedBooking.title,
+    description: updatedBooking.description,
+    eventTypeId: booking.eventTypeId,
+    userId: booking.userId,
+    startTime: updatedBooking.startTime,
+    endTime: updatedBooking.endTime,
+    status: updatedBooking.status,
+    location: updatedBooking.location,
+    recurringEventId: recurringEventId ?? booking.recurringEventId,
+    metadata: updatedBooking.metadata,
+    attendees: updatedBooking.attendees,
+  }));
+
+  await Promise.all(
+    confirmedLifecycleTargets.map((target) =>
+      publishBookingLifecycleEventSafely(
+        () =>
+          lifecycleEventPublisher.publishBookingConfirmed({
+            booking: toLifecycleSnapshotFromConfirmedBooking({
+              booking: target,
+              userId: booking.userId,
+              platformClientId: platformClientParams?.platformClientId ?? null,
+            }),
+            context: {
+              actorType: "organizer",
+              source: platformClientParams?.platformClientId ? "platform" : "webapp",
+              oAuthClientId: platformClientParams?.platformClientId ?? null,
+              recurringCount: recurringEventId ? confirmedLifecycleTargets.length : null,
+              recurringIndex: null,
+              metadata: {
+                previousStatus: acceptedBookings.find((item) => item.uid === target.uid)?.oldStatus,
+                confirmationInput: confirmed,
+              },
+            },
+          }),
+        { bookingUid: target.uid, operationName: "publish-confirmed-booking-lifecycle-event" }
+      )
+    )
+  );
 
   const triggerForUser = true;
   const userId = booking.userId;
@@ -396,6 +476,12 @@ export const confirmHandler = async ({ ctx, input }: ConfirmOptions) => {
       bookingId,
       eventTypeId: eventType?.id,
       status: "ACCEPTED",
       smsReminderNumber: booking.smsReminderNumber || undefined,
       metadata: meetingUrl ? { videoCallUrl: meetingUrl } : {},
       ...(platformClientParams ? platformClientParams : {}),
+      lifecycle: {
+        eventName: "booking.lifecycle",
+        status: "ACCEPTED",
+        source: platformClientParams?.platformClientId ? "platform" : "webapp",
+      },
     };
 
     const promises = subscribersBookingCreated.map((sub) =>
diff --git a/packages/features/bookings/lifecycle/__tests__/buildBookingLifecycleEvent.test.ts b/packages/features/bookings/lifecycle/__tests__/buildBookingLifecycleEvent.test.ts
new file mode 100644
index 0000000000..c7b9372420
--- /dev/null
+++ b/packages/features/bookings/lifecycle/__tests__/buildBookingLifecycleEvent.test.ts
@@ -0,0 +1,306 @@
+import { describe, expect, it, vi } from "vitest";
+import { BookingStatus } from "@calcom/prisma/enums";
+import {
+  buildBookingConfirmedLifecycleEvent,
+  buildBookingCreatedLifecycleEvent,
+  buildBookingRequestedLifecycleEvent,
+  buildRecurringSeriesLifecycleEvent,
+} from "../buildBookingLifecycleEvent";
+import { BookingLifecycleEventName, type BookingLifecycleBookingSnapshot } from "../bookingLifecycleEvent.types";
+
+vi.mock("node:crypto", () => ({
+  default: {
+    randomUUID: () => "deterministic-test-event-id",
+  },
+}));
+
+function makeBooking(overrides: Partial<BookingLifecycleBookingSnapshot> = {}): BookingLifecycleBookingSnapshot {
+  return {
+    id: 1001,
+    uid: "booking_uid_1001",
+    title: "30m Demo",
+    description: "Demo call",
+    eventTypeId: 33,
+    userId: 77,
+    teamId: 20,
+    orgId: 3,
+    oAuthClientId: "platform_client_1",
+    startTime: new Date("2026-02-01T10:00:00.000Z"),
+    endTime: new Date("2026-02-01T10:30:00.000Z"),
+    timeZone: "Europe/London",
+    status: BookingStatus.ACCEPTED,
+    location: "integrations:daily",
+    recurringEventId: null,
+    recurringIndex: null,
+    recurringCount: null,
+    createdAt: new Date("2026-01-15T12:00:00.000Z"),
+    metadata: {
+      source: "test",
+    },
+    attendees: [
+      {
+        email: "booker@example.com",
+        name: "Booker",
+        timeZone: "Europe/London",
+      },
+    ],
+    user: {
+      email: "organizer@example.com",
+      name: "Organizer",
+    },
+    ...overrides,
+  };
+}
+
+describe("buildBookingLifecycleEvent", () => {
+  it("builds a created event for confirmed-by-default bookings", () => {
+    const event = buildBookingCreatedLifecycleEvent({
+      booking: makeBooking({
+        status: BookingStatus.ACCEPTED,
+      }),
+      context: {
+        source: "webapp",
+        actorType: "booker",
+      },
+    });
+
+    expect(event).toEqual(
+      expect.objectContaining({
+        id: "deterministic-test-event-id",
+        eventName: BookingLifecycleEventName,
+        bookingId: 1001,
+        bookingUid: "booking_uid_1001",
+        eventTypeId: 33,
+        userId: 77,
+        teamId: 20,
+        orgId: 3,
+        oAuthClientId: "platform_client_1",
+        title: "30m Demo",
+        status: "ACCEPTED",
+        actorType: "booker",
+        source: "webapp",
+        attendeeEmail: "booker@example.com",
+        organizerEmail: "organizer@example.com",
+        isRecurring: false,
+      })
+    );
+
+    expect(event.metadata).toEqual(
+      expect.objectContaining({
+        source: "test",
+        lifecycleAction: "created",
+        lifecycleStatus: "ACCEPTED",
+        consumerStatus: "accepted",
+      })
+    );
+  });
+
+  it("builds a requested event for pending bookings", () => {
+    const event = buildBookingRequestedLifecycleEvent({
+      booking: makeBooking({
+        status: BookingStatus.PENDING,
+      }),
+      context: {
+        source: "api_v2",
+        actorType: "api",
+        metadata: {
+          requiresConfirmation: true,
+        },
+      },
+    });
+
+    expect(event).toEqual(
+      expect.objectContaining({
+        eventName: BookingLifecycleEventName,
+        bookingUid: "booking_uid_1001",
+        status: "PENDING",
+        source: "api_v2",
+        actorType: "api",
+      })
+    );
+    expect(event.metadata).toEqual(
+      expect.objectContaining({
+        requiresConfirmation: true,
+        lifecycleAction: "requested",
+        lifecycleStatus: "PENDING",
+      })
+    );
+  });
+
+  it("builds a confirmed event after host approval", () => {
+    const event = buildBookingConfirmedLifecycleEvent({
+      booking: makeBooking({
+        status: BookingStatus.ACCEPTED,
+      }),
+      context: {
+        source: "webapp",
+        actorType: "organizer",
+        metadata: {
+          previousStatus: BookingStatus.PENDING,
+        },
+      },
+    });
+
+    expect(event).toEqual(
+      expect.objectContaining({
+        eventName: BookingLifecycleEventName,
+        bookingUid: "booking_uid_1001",
+        status: "ACCEPTED",
+        source: "webapp",
+        actorType: "organizer",
+      })
+    );
+    expect(event.metadata).toEqual(
+      expect.objectContaining({
+        previousStatus: BookingStatus.PENDING,
+        lifecycleAction: "confirmed",
+        lifecycleStatus: "ACCEPTED",
+      })
+    );
+  });
+
+  it("serializes created and confirmed events with the same public status and event name", () => {
+    const booking = makeBooking({
+      status: BookingStatus.ACCEPTED,
+    });
+
+    const created = buildBookingCreatedLifecycleEvent({
+      booking,
+      context: {
+        actorType: "booker",
+        source: "webapp",
+      },
+    });
+    const confirmed = buildBookingConfirmedLifecycleEvent({
+      booking,
+      context: {
+        actorType: "organizer",
+        source: "webapp",
+        metadata: {
+          previousStatus: BookingStatus.PENDING,
+        },
+      },
+    });
+
+    expect(created.eventName).toBe("booking.lifecycle");
+    expect(confirmed.eventName).toBe("booking.lifecycle");
+    expect(created.status).toBe("ACCEPTED");
+    expect(confirmed.status).toBe("ACCEPTED");
+    expect(created.bookingUid).toBe(confirmed.bookingUid);
+    expect(created.metadata.lifecycleStatus).toBe(confirmed.metadata.lifecycleStatus);
+  });
+
+  it("keeps labels as optional consumer hints", () => {
+    const event = buildBookingConfirmedLifecycleEvent({
+      booking: makeBooking(),
+      context: {
+        labels: ["sla_tracked"],
+      },
+    });
+
+    expect(event.labels).toContain("sla_tracked");
+    expect(event.labels).toContain("booking_confirmed");
+  });
+
+  it("merges booking metadata and context metadata", () => {
+    const event = buildBookingCreatedLifecycleEvent({
+      booking: makeBooking({
+        metadata: {
+          campaign: "summer",
+          source: "embed",
+        },
+      }),
+      context: {
+        metadata: {
+          source: "platform",
+          workflowId: "wf_123",
+        },
+      },
+    });
+
+    expect(event.metadata).toEqual(
+      expect.objectContaining({
+        campaign: "summer",
+        source: "platform",
+        workflowId: "wf_123",
+        lifecycleAction: "created",
+      })
+    );
+  });
+
+  it("marks recurring events when recurringEventId is present", () => {
+    const event = buildBookingCreatedLifecycleEvent({
+      booking: makeBooking({
+        recurringEventId: "recurring_123",
+        recurringIndex: 2,
+        recurringCount: 5,
+      }),
+    });
+
+    expect(event.isRecurring).toBe(true);
+    expect(event.recurringEventId).toBe("recurring_123");
+    expect(event.recurringIndex).toBe(2);
+    expect(event.recurringCount).toBe(5);
+  });
+
+  it("builds one recurring series event from many booking instances", () => {
+    const bookings = [
+      makeBooking({
+        uid: "booking_1",
+        id: 1,
+        startTime: new Date("2026-02-01T10:00:00.000Z"),
+        endTime: new Date("2026-02-01T10:30:00.000Z"),
+      }),
+      makeBooking({
+        uid: "booking_2",
+        id: 2,
+        startTime: new Date("2026-02-08T10:00:00.000Z"),
+        endTime: new Date("2026-02-08T10:30:00.000Z"),
+      }),
+      makeBooking({
+        uid: "booking_3",
+        id: 3,
+        startTime: new Date("2026-02-15T10:00:00.000Z"),
+        endTime: new Date("2026-02-15T10:30:00.000Z"),
+      }),
+      makeBooking({
+        uid: "booking_4",
+        id: 4,
+        startTime: new Date("2026-02-22T10:00:00.000Z"),
+        endTime: new Date("2026-02-22T10:30:00.000Z"),
+      }),
+    ];
+
+    const event = buildRecurringSeriesLifecycleEvent({
+      seriesId: "recurring_series_123",
+      bookings,
+      context: {
+        source: "webapp",
+      },
+    });
+
+    expect(event.bookingUid).toBe("recurring_series_123");
+    expect(event.recurringEventId).toBe("recurring_series_123");
+    expect(event.recurringIndex).toBeNull();
+    expect(event.recurringCount).toBe(4);
+    expect(event.metadata).toEqual(
+      expect.objectContaining({
+        seriesId: "recurring_series_123",
+        bookingUids: ["booking_1", "booking_2", "booking_3", "booking_4"],
+        instanceCount: 4,
+      })
+    );
+  });
+
+  it("throws when recurring series has no bookings", () => {
+    expect(() =>
+      buildRecurringSeriesLifecycleEvent({
+        seriesId: "empty",
+        bookings: [],
+      })
+    ).toThrow("Cannot build recurring series lifecycle event without at least one booking");
+  });
+});
diff --git a/packages/features/bookings/lib/service/RecurringBookingService.lifecycle.test.ts b/packages/features/bookings/lib/service/RecurringBookingService.lifecycle.test.ts
new file mode 100644
index 0000000000..3f94d7620a
--- /dev/null
+++ b/packages/features/bookings/lib/service/RecurringBookingService.lifecycle.test.ts
@@ -0,0 +1,286 @@
+import { describe, expect, it, vi } from "vitest";
+import { BookingStatus } from "@calcom/prisma/enums";
+import {
+  InMemoryBookingLifecycleEventPublisher,
+  setBookingLifecycleEventPublisherForTests,
+} from "../../lifecycle";
+import { RecurringBookingService } from "./RecurringBookingService";
+
+function makeBooking(index: number) {
+  const start = new Date(Date.UTC(2026, 1, 1 + index * 7, 10, 0, 0));
+  const end = new Date(Date.UTC(2026, 1, 1 + index * 7, 10, 30, 0));
+
+  return {
+    id: 2000 + index,
+    uid: `booking_uid_${index}`,
+    title: "Recurring Demo",
+    description: "Weekly demo",
+    eventTypeId: 50,
+    userId: 10,
+    startTime: start,
+    endTime: end,
+    status: BookingStatus.ACCEPTED,
+    location: "integrations:daily",
+    recurringEventId: "recurring_event_abc",
+    attendees: [
+      {
+        email: "booker@example.com",
+        name: "Booker",
+        timeZone: "Europe/London",
+      },
+    ],
+    metadata: {
+      occurrence: index,
+    },
+    createdAt: new Date("2026-01-15T10:00:00.000Z"),
+    references: [],
+  };
+}
+
+function makeRecurringRequest(count: number) {
+  return Array.from({ length: count }).map((_, index) => ({
+    eventTypeId: 50,
+    start: new Date(Date.UTC(2026, 1, 1 + index * 7, 10, 0, 0)).toISOString(),
+    end: new Date(Date.UTC(2026, 1, 1 + index * 7, 10, 30, 0)).toISOString(),
+    responses: {
+      email: "booker@example.com",
+      name: "Booker",
+      location: {
+        value: "integrations:daily",
+        optionValue: "",
+      },
+    },
+    recurringEventId: "recurring_event_abc",
+    currentRecurringIndex: index,
+    allRecurringDates: Array.from({ length: count }).map((_, nestedIndex) => ({
+      start: new Date(Date.UTC(2026, 1, 1 + nestedIndex * 7, 10, 0, 0)).toISOString(),
+      end: new Date(Date.UTC(2026, 1, 1 + nestedIndex * 7, 10, 30, 0)).toISOString(),
+    })),
+  }));
+}
+
+describe("RecurringBookingService lifecycle events", () => {
+  it("publishes one series lifecycle event for a four-instance recurring booking", async () => {
+    const lifecyclePublisher = new InMemoryBookingLifecycleEventPublisher();
+    setBookingLifecycleEventPublisherForTests(lifecyclePublisher);
+    const regularBookingService = {
+      createBooking: vi.fn(async ({ bookingData }: { bookingData: { currentRecurringIndex: number } }) =>
+        makeBooking(bookingData.currentRecurringIndex)
+      ),
+    };
+    const service = new RecurringBookingService({
+      regularBookingService: regularBookingService as never,
+      lifecycleEventPublisher: lifecyclePublisher,
+    });
+
+    const createdBookings = await service.createBooking({
+      bookingData: makeRecurringRequest(4) as never,
+      bookingMeta: {
+        userId: -1,
+        platformClientId: "platform-client",
+      },
+      creationSource: "WEBAPP",
+    });
+
+    expect(createdBookings).toHaveLength(4);
+    expect(regularBookingService.createBooking).toHaveBeenCalledTimes(4);
+    expect(lifecyclePublisher.deliveries).toHaveLength(1);
+    expect(lifecyclePublisher.deliveries[0].payload).toEqual(
+      expect.objectContaining({
+        eventName: "booking.lifecycle",
+        bookingUid: "recurring_event_abc",
+        recurringEventId: "recurring_event_abc",
+        recurringCount: 4,
+        recurringIndex: null,
+        status: "ACCEPTED",
+      })
+    );
+    expect(lifecyclePublisher.deliveries[0].payload.metadata).toEqual(
+      expect.objectContaining({
+        bookingUids: ["booking_uid_0", "booking_uid_1", "booking_uid_2", "booking_uid_3"],
+        instanceCount: 4,
+      })
+    );
+  });
+
+  it("does not publish one lifecycle event per recurring occurrence", async () => {
+    const lifecyclePublisher = new InMemoryBookingLifecycleEventPublisher();
+    const regularBookingService = {
+      createBooking: vi.fn(async ({ bookingData }: { bookingData: { currentRecurringIndex: number } }) =>
+        makeBooking(bookingData.currentRecurringIndex)
+      ),
+    };
+    const service = new RecurringBookingService({
+      regularBookingService: regularBookingService as never,
+      lifecycleEventPublisher: lifecyclePublisher,
+    });
+
+    await service.createBooking({
+      bookingData: makeRecurringRequest(3) as never,
+      bookingMeta: {
+        userId: 10,
+      },
+      creationSource: "WEBAPP",
+    });
+
+    const payloads = lifecyclePublisher.deliveries.map((delivery) => delivery.payload);
+    expect(payloads.map((payload) => payload.bookingUid)).toEqual(["recurring_event_abc"]);
+    expect(payloads.some((payload) => payload.bookingUid === "booking_uid_0")).toBe(false);
+    expect(payloads.some((payload) => payload.bookingUid === "booking_uid_1")).toBe(false);
+    expect(payloads.some((payload) => payload.bookingUid === "booking_uid_2")).toBe(false);
+  });
+
+  it("uses the first booking as the series payload anchor", async () => {
+    const lifecyclePublisher = new InMemoryBookingLifecycleEventPublisher();
+    const regularBookingService = {
+      createBooking: vi.fn(async ({ bookingData }: { bookingData: { currentRecurringIndex: number } }) =>
+        makeBooking(bookingData.currentRecurringIndex)
+      ),
+    };
+    const service = new RecurringBookingService({
+      regularBookingService: regularBookingService as never,
+      lifecycleEventPublisher: lifecyclePublisher,
+    });
+
+    await service.createBooking({
+      bookingData: makeRecurringRequest(2) as never,
+      bookingMeta: {
+        userId: -1,
+      },
+      creationSource: "WEBAPP",
+    });
+
+    const payload = lifecyclePublisher.deliveries[0].payload;
+    expect(payload.startTime).toBe("2026-02-01T10:00:00.000Z");
+    expect(payload.endTime).toBe("2026-02-01T10:30:00.000Z");
+    expect(payload.metadata.bookingUids).toEqual(["booking_uid_0", "booking_uid_1"]);
+  });
+
+  it("sets actor type from booking meta user id", async () => {
+    const lifecyclePublisher = new InMemoryBookingLifecycleEventPublisher();
+    const regularBookingService = {
+      createBooking: vi.fn(async ({ bookingData }: { bookingData: { currentRecurringIndex: number } }) =>
+        makeBooking(bookingData.currentRecurringIndex)
+      ),
+    };
+    const service = new RecurringBookingService({
+      regularBookingService: regularBookingService as never,
+      lifecycleEventPublisher: lifecyclePublisher,
+    });
+
+    await service.createBooking({
+      bookingData: makeRecurringRequest(2) as never,
+      bookingMeta: {
+        userId: 10,
+      },
+      creationSource: "WEBAPP",
+    });
+
+    expect(lifecyclePublisher.deliveries[0].payload.actorType).toBe("organizer");
+  });
+
+  it("keeps platform client id on the series event", async () => {
+    const lifecyclePublisher = new InMemoryBookingLifecycleEventPublisher();
+    const regularBookingService = {
+      createBooking: vi.fn(async ({ bookingData }: { bookingData: { currentRecurringIndex: number } }) =>
+        makeBooking(bookingData.currentRecurringIndex)
+      ),
+    };
+    const service = new RecurringBookingService({
+      regularBookingService: regularBookingService as never,
+      lifecycleEventPublisher: lifecyclePublisher,
+    });
+
+    await service.createBooking({
+      bookingData: makeRecurringRequest(2) as never,
+      bookingMeta: {
+        userId: -1,
+        platformClientId: "platform-client-id",
+      },
+      creationSource: "WEBAPP",
+    });
+
+    expect(lifecyclePublisher.deliveries[0].payload.oAuthClientId).toBe("platform-client-id");
+  });
+});
diff --git a/packages/features/bookings/lib/handleConfirmation.lifecycle.test.ts b/packages/features/bookings/lib/handleConfirmation.lifecycle.test.ts
new file mode 100644
index 0000000000..34b42f2023
--- /dev/null
+++ b/packages/features/bookings/lib/handleConfirmation.lifecycle.test.ts
@@ -0,0 +1,246 @@
+import { beforeEach, describe, expect, it, vi } from "vitest";
+import { BookingStatus } from "@calcom/prisma/enums";
+import {
+  InMemoryBookingLifecycleEventPublisher,
+  setBookingLifecycleEventPublisherForTests,
+} from "../lifecycle";
+import { confirmHandler } from "./handleConfirmation";
+
+const lifecyclePublisher = new InMemoryBookingLifecycleEventPublisher();
+
+vi.mock("@calcom/prisma", () => ({
+  prisma: {
+    booking: {
+      findUniqueOrThrow: vi.fn(),
+      findMany: vi.fn(),
+      update: vi.fn(),
+    },
+    profile: {
+      findFirst: vi.fn(),
+    },
+  },
+}));
+
+vi.mock("@calcom/features/bookings/services/BookingAccessService", () => ({
+  BookingAccessService: class {
+    async doesUserIdHaveAccessToBooking() {
+      return true;
+    }
+  },
+}));
+
+vi.mock("@calcom/features/bookings/lib/handleConfirmation", async (importOriginal) => {
+  const actual = await importOriginal<typeof import("./handleConfirmation")>();
+  return actual;
+});
+
+function pendingBooking() {
+  return {
+    id: 321,
+    uid: "pending_booking_uid",
+    title: "Design review",
+    description: "Design review call",
+    customInputs: {},
+    startTime: new Date("2026-04-01T09:00:00.000Z"),
+    endTime: new Date("2026-04-01T09:30:00.000Z"),
+    attendees: [
+      {
+        email: "booker@example.com",
+        name: "Booker",
+        timeZone: "Europe/London",
+      },
+    ],
+    eventTypeId: 40,
+    responses: {},
+    metadata: {},
+    userPrimaryEmail: "organizer@example.com",
+    eventType: {
+      id: 40,
+      owner: null,
+      teamId: null,
+      recurringEvent: null,
+      title: "Design review",
+      slug: "design-review",
+      requiresConfirmation: true,
+      currency: "usd",
+      length: 30,
+      description: "",
+      price: 0,
+      bookingFields: null,
+      hideOrganizerEmail: false,
+      hideCalendarNotes: false,
+      hideCalendarEventDetails: false,
+      disableGuests: false,
+      disableCancelling: false,
+      disableRescheduling: false,
+      customReplyToEmail: null,
+      seatsPerTimeSlot: null,
+      seatsShowAttendees: null,
+      metadata: {},
+      locations: [],
+      team: null,
+      customInputs: [],
+      parentId: null,
+      parent: null,
+    },
+    location: "integrations:daily",
+    userId: 12,
+    user: {
+      id: 12,
+      username: "organizer",
+      email: "organizer@example.com",
+      timeZone: "Europe/London",
+      timeFormat: 12,
+      name: "Organizer",
+      destinationCalendar: null,
+      locale: "en",
+      hideBranding: false,
+      profiles: [],
+    },
+    payment: [],
+    destinationCalendar: null,
+    paid: true,
+    recurringEventId: null,
+    status: BookingStatus.PENDING,
+    smsReminderNumber: null,
+    assignmentReason: [],
+  };
+}
+
+function acceptedUpdate(overrides: Record<string, unknown> = {}) {
+  return {
+    id: 321,
+    uid: "pending_booking_uid",
+    title: "Design review",
+    description: "Design review call",
+    startTime: new Date("2026-04-01T09:00:00.000Z"),
+    endTime: new Date("2026-04-01T09:30:00.000Z"),
+    attendees: [
+      {
+        email: "booker@example.com",
+        name: "Booker",
+        timeZone: "Europe/London",
+      },
+    ],
+    eventType: {
+      slug: "design-review",
+      bookingFields: null,
+      schedulingType: null,
+      owner: null,
+      hosts: [],
+    },
+    status: BookingStatus.ACCEPTED,
+    responses: {},
+    title: "Design review",
+    metadata: {},
+    cancellationReason: null,
+    location: "integrations:daily",
+    customInputs: {},
+    smsReminderNumber: null,
+    ...overrides,
+  };
+}
+
+describe("confirmHandler lifecycle events", () => {
+  beforeEach(() => {
+    lifecyclePublisher.clear();
+    setBookingLifecycleEventPublisherForTests(lifecyclePublisher);
+  });
+
+  it("publishes a confirmed lifecycle event with accepted status", async () => {
+    const { prisma } = await import("@calcom/prisma");
+    vi.mocked(prisma.booking.findUniqueOrThrow).mockResolvedValue(pendingBooking() as never);
+    vi.mocked(prisma.booking.update).mockResolvedValue(acceptedUpdate() as never);
+    vi.mocked(prisma.profile.findFirst).mockResolvedValue(null);
+
+    await confirmHandler({
+      ctx: {
+        user: {
+          id: 12,
+          uuid: "user_uuid",
+          email: "organizer@example.com",
+          username: "organizer",
+          role: "USER",
+          destinationCalendar: null,
+        },
+        traceContext: {},
+      },
+      input: {
+        bookingId: 321,
+        confirmed: true,
+        emailsEnabled: true,
+      },
+    } as never);
+
+    expect(lifecyclePublisher.deliveries).toHaveLength(1);
+    expect(lifecyclePublisher.deliveries[0].payload).toEqual(
+      expect.objectContaining({
+        eventName: "booking.lifecycle",
+        bookingUid: "pending_booking_uid",
+        status: "ACCEPTED",
+        actorType: "organizer",
+      })
+    );
+    expect(lifecyclePublisher.deliveries[0].payload.metadata).toEqual(
+      expect.objectContaining({
+        previousStatus: BookingStatus.PENDING,
+        lifecycleAction: "confirmed",
+        lifecycleStatus: "ACCEPTED",
+      })
+    );
+  });
+
+  it("uses the same event name and status a created accepted booking uses", async () => {
+    const { prisma } = await import("@calcom/prisma");
+    vi.mocked(prisma.booking.findUniqueOrThrow).mockResolvedValue(pendingBooking() as never);
+    vi.mocked(prisma.booking.update).mockResolvedValue(acceptedUpdate() as never);
+    vi.mocked(prisma.profile.findFirst).mockResolvedValue(null);
+
+    await confirmHandler({
+      ctx: {
+        user: {
+          id: 12,
+          uuid: "user_uuid",
+          email: "organizer@example.com",
+          username: "organizer",
+          role: "USER",
+          destinationCalendar: null,
+        },
+        traceContext: {},
+      },
+      input: {
+        bookingId: 321,
+        confirmed: true,
+        emailsEnabled: false,
+      },
+    } as never);
+
+    const confirmed = lifecyclePublisher.deliveries[0].payload;
+    expect(confirmed.eventName).toBe("booking.lifecycle");
+    expect(confirmed.status).toBe("ACCEPTED");
+    expect(confirmed.metadata.consumerStatus).toBe("accepted");
+  });
+});
diff --git a/packages/features/bookings/lifecycle/README.md b/packages/features/bookings/lifecycle/README.md
new file mode 100644
index 0000000000..0e710a412d
--- /dev/null
+++ b/packages/features/bookings/lifecycle/README.md
@@ -0,0 +1,430 @@
+# Booking Lifecycle Events
+
+The booking lifecycle event stream gives internal consumers a single event
+contract for booking state changes. It is intended for analytics, CRM sync,
+customer-success alerts, reporting, workflow automation, and downstream
+notification systems that need to understand booking lifecycle movement without
+calling the booking API after every existing webhook delivery.
+
+## Topic
+
+All lifecycle events are published to:
+
+```txt
+booking.lifecycle
+```
+
+## Payload
+
+```ts
+type BookingLifecycleEvent = {
+  id: string;
+  eventName: "booking.lifecycle";
+  bookingId: number;
+  bookingUid: string;
+  eventTypeId: number | null;
+  userId: number | null;
+  teamId: number | null;
+  orgId: number | null;
+  oAuthClientId: string | null;
+  title: string;
+  description: string | null;
+  startTime: string;
+  endTime: string;
+  timeZone: string | null;
+  status: "ACCEPTED" | "PENDING" | "CANCELLED" | "REJECTED" | "AWAITING_HOST";
+  actorType: "booker" | "organizer" | "team_member" | "system" | "api";
+  source: "webapp" | "api_v1" | "api_v2" | "platform" | "embed" | "workflow";
+  attendeeEmail: string | null;
+  attendeeName: string | null;
+  organizerEmail: string | null;
+  organizerName: string | null;
+  recurringEventId: string | null;
+  recurringIndex: number | null;
+  recurringCount: number | null;
+  isRecurring: boolean;
+  location: string | null;
+  createdAt: string;
+  emittedAt: string;
+  metadata: Record<string, unknown>;
+  labels: string[];
+  consumers: string[];
+};
+```
+
+## Status semantics
+
+Lifecycle consumers can use the `status` field as the primary state:
+
+| Status | Meaning |
+| --- | --- |
+| `ACCEPTED` | The booking is confirmed and should be counted as a scheduled meeting. |
+| `PENDING` | The booking exists but still requires host confirmation. |
+| `CANCELLED` | The booking was cancelled. |
+| `REJECTED` | The host rejected a requested booking. |
+| `AWAITING_HOST` | The booking is waiting for a host assignment. |
+
+A newly created confirmed-by-default booking emits:
+
+```json
+{
+  "eventName": "booking.lifecycle",
+  "bookingUid": "book_123",
+  "status": "ACCEPTED",
+  "metadata": {
+    "lifecycleAction": "created",
+    "lifecycleStatus": "ACCEPTED",
+    "consumerStatus": "accepted"
+  }
+}
+```
+
+A requested booking emits:
+
+```json
+{
+  "eventName": "booking.lifecycle",
+  "bookingUid": "book_456",
+  "status": "PENDING",
+  "metadata": {
+    "lifecycleAction": "requested",
+    "lifecycleStatus": "PENDING",
+    "consumerStatus": "pending"
+  }
+}
+```
+
+A booking confirmed later by the organizer emits:
+
+```json
+{
+  "eventName": "booking.lifecycle",
+  "bookingUid": "book_456",
+  "status": "ACCEPTED",
+  "metadata": {
+    "lifecycleAction": "confirmed",
+    "lifecycleStatus": "ACCEPTED",
+    "consumerStatus": "accepted",
+    "previousStatus": "PENDING"
+  }
+}
+```
+
+Consumers that only need a confirmed-booking count can filter for
+`status === "ACCEPTED"`. This catches both confirmed-by-default booking creation
+and later organizer confirmation.
+
+## Recurring bookings
+
+Recurring booking requests create many booking rows but the lifecycle stream
+publishes one series event. The event uses the recurring id as the `bookingUid`
+and carries all child booking UIDs in metadata.
+
+```json
+{
+  "eventName": "booking.lifecycle",
+  "bookingUid": "recurring_abc",
+  "recurringEventId": "recurring_abc",
+  "recurringIndex": null,
+  "recurringCount": 4,
+  "status": "ACCEPTED",
+  "metadata": {
+    "seriesId": "recurring_abc",
+    "bookingUids": [
+      "book_1",
+      "book_2",
+      "book_3",
+      "book_4"
+    ],
+    "instanceCount": 4
+  }
+}
+```
+
+This keeps recurring event delivery compact. Consumers that need to inspect a
+single occurrence can load it by UID from the `metadata.bookingUids` array.
+
+## Consumer examples
+
+### Analytics confirmed booking count
+
+```ts
+export async function recordConfirmedBooking(event: BookingLifecycleEvent) {
+  if (event.status !== "ACCEPTED") {
+    return;
+  }
+
+  await analytics.increment("confirmed_bookings", {
+    eventTypeId: event.eventTypeId,
+    userId: event.userId,
+    source: event.source,
+  });
+}
+```
+
+### CRM opportunity creation
+
+```ts
+export async function syncToCrm(event: BookingLifecycleEvent) {
+  if (event.status !== "ACCEPTED") {
+    return;
+  }
+
+  await crm.upsertMeeting({
+    externalId: event.bookingUid,
+    title: event.title,
+    startTime: event.startTime,
+    endTime: event.endTime,
+    attendeeEmail: event.attendeeEmail,
+    organizerEmail: event.organizerEmail,
+  });
+}
+```
+
+### Requested booking queue
+
+```ts
+export async function addRequestedBookingToQueue(event: BookingLifecycleEvent) {
+  if (event.status !== "PENDING") {
+    return;
+  }
+
+  await queue.add("booking-confirmation-followup", {
+    bookingUid: event.bookingUid,
+    organizerEmail: event.organizerEmail,
+    attendeeEmail: event.attendeeEmail,
+  });
+}
+```
+
+### Recurring booking CRM sync
+
+```ts
+export async function syncRecurringSeries(event: BookingLifecycleEvent) {
+  if (!event.isRecurring) {
+    return;
+  }
+
+  await crm.upsertRecurringMeetingSeries({
+    seriesId: event.recurringEventId ?? event.bookingUid,
+    instanceUids: event.metadata.bookingUids,
+    instanceCount: event.recurringCount,
+    firstStartTime: event.startTime,
+  });
+}
+```
+
+## Product scenarios
+
+### Confirmed-by-default booking
+
+1. Booker schedules an event type that does not require host approval.
+2. Cal.com creates a booking with `BookingStatus.ACCEPTED`.
+3. Existing webhooks send `BOOKING_CREATED`.
+4. The lifecycle stream publishes one `booking.lifecycle` event with status
+   `ACCEPTED`.
+
+### Requested booking
+
+1. Booker schedules an event type that requires host approval.
+2. Cal.com creates a booking with `BookingStatus.PENDING`.
+3. Existing webhooks queue `BOOKING_REQUESTED`.
+4. The lifecycle stream publishes one `booking.lifecycle` event with status
+   `PENDING`.
+
+### Organizer confirms requested booking
+
+1. Host opens the requested booking.
+2. Host confirms it.
+3. Cal.com updates the booking to `BookingStatus.ACCEPTED`.
+4. Existing webhooks send `BOOKING_CREATED`.
+5. The lifecycle stream publishes one `booking.lifecycle` event with status
+   `ACCEPTED`.
+
+### Recurring booking
+
+1. Booker selects a recurring event with four occurrences.
+2. Cal.com creates four booking rows.
+3. Existing booking behavior handles every occurrence.
+4. The lifecycle stream publishes one `booking.lifecycle` series event with
+   status `ACCEPTED`.
+5. Consumers can use `metadata.bookingUids` if they need each occurrence.
+
+## Delivery behavior
+
+Lifecycle event publishing is best-effort. Booking creation or confirmation must
+not fail because the lifecycle event stream is unavailable. The publisher logs
+transport failures and allows the product flow to continue.
+
+Events include a random `id` because the transport already handles delivery
+deduplication. Consumers should use `bookingUid` for idempotent writes.
+
+## Reviewer checklist
+
+When changing booking lifecycle events, ask:
+
+- Does the event tell consumers what product lifecycle action happened?
+- Can a newly created confirmed booking be distinguished from a later
+  confirmation of a requested booking?
+- Can consumers tell whether a `PENDING` booking is waiting for confirmation or
+  waiting for host assignment?
+- Does a recurring booking emit the facts consumers need for every occurrence?
+- Is a series-level event enough for reminders, CRM meetings, attendance, and
+  reporting?
+- Does every event carry the booking UID that downstream systems use as their
+  external id?
+- Are existing webhook concepts like `BOOKING_CREATED` and `BOOKING_REQUESTED`
+  preserved rather than flattened?
+- Does the confirmation flow tell consumers the old and new status?
+- Do tests prove instance-level recurring behavior, or only compact series
+  behavior?
+- Would filtering by `status === "ACCEPTED"` double count a booking that was
+  created pending and later confirmed?
+
+## Migration guide
+
+Existing consumers of `BOOKING_CREATED` can move to `booking.lifecycle` by
+filtering for `status === "ACCEPTED"`.
+
+Existing consumers of `BOOKING_REQUESTED` can move to `booking.lifecycle` by
+filtering for `status === "PENDING"`.
+
+Existing recurring booking consumers can move to `booking.lifecycle` by reading
+`metadata.bookingUids` from the series event.
+
+## Operational examples
+
+### Revenue reporting
+
+```ts
+export async function updateRevenueReport(event: BookingLifecycleEvent) {
+  if (event.status !== "ACCEPTED") {
+    return;
+  }
+
+  await revenueBookings.upsert({
+    id: event.bookingUid,
+    userId: event.userId,
+    eventTypeId: event.eventTypeId,
+    startTime: event.startTime,
+    source: event.source,
+  });
+}
+```
+
+### Customer success alert
+
+```ts
+export async function alertForHighValueMeeting(event: BookingLifecycleEvent) {
+  if (event.status !== "ACCEPTED") {
+    return;
+  }
+
+  if (event.metadata.accountTier !== "enterprise") {
+    return;
+  }
+
+  await slack.postMessage({
+    channel: "#customer-success",
+    text: `${event.organizerEmail} has an enterprise meeting at ${event.startTime}`,
+  });
+}
+```
+
+### Automation workflow
+
+```ts
+export async function runBookingAutomation(event: BookingLifecycleEvent) {
+  if (event.status === "PENDING") {
+    await automations.start("requested-booking-followup", {
+      bookingUid: event.bookingUid,
+    });
+    return;
+  }
+
+  if (event.status === "ACCEPTED") {
+    await automations.start("confirmed-booking-prep", {
+      bookingUid: event.bookingUid,
+    });
+  }
+}
+```
+
+### Recurring reminder seed
+
+```ts
+export async function seedRecurringReminders(event: BookingLifecycleEvent) {
+  if (!event.isRecurring) {
+    return;
+  }
+
+  await reminders.seedSeries({
+    seriesId: event.recurringEventId ?? event.bookingUid,
+    bookingUids: event.metadata.bookingUids,
+    firstStartTime: event.startTime,
+    count: event.recurringCount,
+  });
+}
+```
+
+## Data warehouse shape
+
+Warehouse consumers can store the event as a single table:
+
+| Column | Value |
+| --- | --- |
+| `event_id` | `event.id` |
+| `event_name` | `event.eventName` |
+| `booking_uid` | `event.bookingUid` |
+| `status` | `event.status` |
+| `user_id` | `event.userId` |
+| `event_type_id` | `event.eventTypeId` |
+| `source` | `event.source` |
+| `actor_type` | `event.actorType` |
+| `recurring_event_id` | `event.recurringEventId` |
+| `recurring_index` | `event.recurringIndex` |
+| `recurring_count` | `event.recurringCount` |
+| `start_time` | `event.startTime` |
+| `end_time` | `event.endTime` |
+| `emitted_at` | `event.emittedAt` |
+
+This table is intentionally compact. Use the booking API for fields that change
+frequently or are not needed by lifecycle consumers.
+
+## Backfill
+
+A backfill job can create lifecycle events from existing bookings:
+
+```ts
+for await (const booking of bookings.findMany({ cursor })) {
+  await publisher.publishBookingCreated({
+    booking,
+    context: {
+      actorType: "system",
+      source: "workflow",
+      metadata: {
+        backfill: true,
+      },
+    },
+  });
+}
+```
+
+Backfilled events use current booking status. They do not reconstruct historical
+status transitions.
```

## Intended Flaws

### Flaw 1: Created and confirmed lifecycle events share the same public contract

The PR introduces one event name, `booking.lifecycle`, and expects downstream consumers to infer the lifecycle action mostly from `status`. For a confirmed-by-default booking creation and a later host confirmation, the public event is the same topic with `status: "ACCEPTED"`. The only action marker is buried in metadata/labels, while the top-level contract does not expose a durable event type or status transition.

Relevant line references:

- `packages/features/bookings/lifecycle/bookingLifecycleEvent.types.ts:30-59` defines the public event without a top-level lifecycle event type, previous status, or new status.
- `packages/features/bookings/lifecycle/buildBookingLifecycleEvent.ts:95-114` maps both `created` and `confirmed` to `status: "ACCEPTED"`.
- `packages/features/bookings/lifecycle/buildBookingLifecycleEvent.ts:116-141` publishes the same `eventName` for every lifecycle action and only puts action/status hints inside metadata.
- `packages/features/bookings/lifecycle/__tests__/buildBookingLifecycleEvent.test.ts:138-168` explicitly asserts created and confirmed events have the same event name and status.
- `packages/features/bookings/lib/handleConfirmation.lifecycle.test.ts:199-227` locks in the same accepted public shape for confirmed events.
- `packages/features/bookings/lifecycle/README.md:56-91` tells consumers to filter `status === "ACCEPTED"` for both created and confirmed events.

Why this is a real flaw:

Created and confirmed are different product facts. A booking created as accepted means the meeting is new. A pending booking confirmed later means the same booking moved from pending to accepted. Analytics, CRM, revenue, and automation systems often need to know whether they should create a new meeting record, advance an existing requested-booking record, start a confirmation SLA, or close a pending queue item. Filtering by `status === "ACCEPTED"` can double count: once when a booking is created accepted, and again when a pending booking later becomes accepted. Metadata is not a strong enough contract for the primary lifecycle verb.

Better implementation direction:

Expose explicit lifecycle event types such as `booking.created`, `booking.requested`, and `booking.confirmed`, or add a top-level `lifecycleEventType` plus `previousStatus` and `newStatus`. Keep `status` as current state, but do not make it carry the lifecycle verb. Consumers should be able to switch on the business fact without parsing labels or metadata.

### Flaw 2: Recurring bookings emit only a parent/series lifecycle event

The PR creates multiple recurring booking rows but publishes one compact series event keyed by the recurring id. The series event lists child booking UIDs in metadata, but it does not emit one lifecycle event per concrete booking instance.

Relevant line references:

- `packages/features/bookings/lib/service/RecurringBookingService.ts:134-176` maps all created bookings into snapshots but calls `publishRecurringSeriesCreated` once.
- `packages/features/bookings/lifecycle/buildBookingLifecycleEvent.ts:172-196` builds a single event anchored to the first booking and replaces `bookingUid` with the series id.
- `packages/features/bookings/lib/service/RecurringBookingService.lifecycle.test.ts:68-101` asserts a four-instance recurring booking publishes one lifecycle delivery.
- `packages/features/bookings/lib/service/RecurringBookingService.lifecycle.test.ts:103-134` asserts no event is published for individual child booking UIDs.
- `packages/features/bookings/lifecycle/README.md:93-126` documents one series event and tells consumers to read child UIDs from metadata.

Why this is a real flaw:

The domain has concrete booking instances. Reminders, CRM meetings, attendance, no-show tracking, revenue recognition, calendar syncs, and per-occurrence workflow automations operate on a specific start/end time and booking UID. A parent event can be useful as a summary, but it cannot replace instance-level lifecycle events. Consumers that ingest events as their source of truth will miss three out of four meetings in the documented recurring example, or they will need to make extra API calls and reimplement expansion logic.

Better implementation direction:

Emit one lifecycle event per created recurring booking instance, each keyed by the child `bookingUid`, with `recurringEventId`, `recurringIndex`, and `recurringCount` as grouping fields. Optionally emit an additional `booking.recurring_series_created` summary event, but do not use the summary as a substitute for instance facts.

## Hints

### Flaw 1 Hints

1. If a booking starts pending and later becomes accepted, is that the same business fact as a booking created accepted from the beginning?
2. Which top-level field would a data warehouse, CRM sync, or automation engine switch on without understanding Cal.com metadata conventions?
3. What happens to a confirmed-booking counter that filters only `status === "ACCEPTED"`?

### Flaw 2 Hints

1. How many booking rows does the recurring booking service create for four weekly occurrences?
2. Which UID should a reminder, CRM meeting, or attendance event use: the series id or the concrete occurrence booking UID?
3. Is a parent summary event enough for a consumer that treats the event stream as its source of truth?

## Expected Answer

A strong review should say that a lifecycle stream is valuable, but this PR flattens two important domain distinctions. First, it uses one top-level event name plus current status for different lifecycle facts, so created accepted bookings and later confirmations look the same to consumers. Second, it collapses recurring booking instances into one series event, so consumers miss per-occurrence facts.

For flaw 1, the learner should identify that `booking.lifecycle` with `status: "ACCEPTED"` is used for both creation and confirmation. The impact is double counting, incorrect CRM/workflow transitions, and consumers depending on weak metadata conventions. The fix is explicit event types or a top-level lifecycle action plus previous/new status.

For flaw 2, the learner should identify that recurring booking creation loops over instances but publishes only one series-level event. The impact is missed reminders, CRM meetings, attendance/no-show rows, revenue records, and other per-occurrence automation. The fix is instance-level events keyed by booking UID, with recurring grouping fields, plus optional summary events.

The best answers should connect both flaws to event API design: the event stream is not just a notification pipe. It is a product contract, and product contracts must preserve the business fact consumers need to act on.

## Expert Debrief

At the product level, this PR tries to reduce integration complexity. That is a good goal. Booking systems have many consumers, and making every consumer reason over raw status reads, webhooks, and confirmation flows is brittle.

The first contract is the lifecycle verb. Current status answers "what is true now?" It does not answer "what just happened?" A booking can be accepted because it was created accepted, or because it was previously pending and then confirmed. Those are different events for analytics, CRM, queues, and automations. A durable event contract should make the verb explicit at the top level.

The second contract is instance identity. Recurring bookings are not only a series; they are also concrete meetings with distinct start/end times and booking UIDs. Summary events can help dashboards, but most operational consumers need one event per occurrence. Otherwise, they either miss work or have to repair the stream by fetching extra data and expanding it themselves.

The failure modes are concrete:

- A confirmed-booking dashboard increments once for creation and again when a requested booking is confirmed.
- A CRM sync creates duplicate opportunities because both created and confirmed accepted events look like new confirmed meetings.
- A requested-booking queue never closes cleanly because confirmation is not modeled as a status transition at the top level.
- A recurring four-meeting booking creates one CRM meeting instead of four.
- Reminder and no-show jobs miss child occurrences because the event key is the series id instead of each booking UID.
- Warehouse-style data consumers build a compact fact table that cannot reconstruct lifecycle transitions later.

The reviewer thought process should be: identify the consumer contract before reading implementation details. Ask what business fact the event name claims to represent, what identity the event is keyed by, and whether current state is being confused with transition semantics. Then compare that contract to the existing Cal.com domain: accepted vs pending bookings are already distinct, and recurring booking creation already produces multiple concrete bookings.

The better implementation is a small event taxonomy: `booking.created`, `booking.requested`, `booking.confirmed`, and optionally `booking.recurring_series_created`. Each event should include `bookingUid`, `previousStatus`, `newStatus`, `recurringEventId`, `recurringIndex`, and `recurringCount` where relevant. Instance events should be emitted for every recurring booking row.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: created/confirmed accepted events share the same public event/status contract, and recurring bookings publish only one parent/series event instead of instance-level events. It explains double counting or wrong workflow transitions, missed recurring occurrences, and recommends explicit lifecycle event types/status transitions plus one event per booking instance.
- `partial`: The answer finds one flaw completely and gestures at generic event naming or recurring metadata issues without tying them to created-vs-confirmed status semantics, downstream double counting, and concrete child booking UIDs.
- `miss`: The answer focuses on random ids, logging, environment flags, import paths, mocking style, or docs wording while missing lifecycle verb semantics and recurring instance coverage.
