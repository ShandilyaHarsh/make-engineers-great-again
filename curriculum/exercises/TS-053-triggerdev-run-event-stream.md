# TS-053: Trigger.dev Run Event Stream

## Metadata

- `id`: TS-053
- `source_repo`: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- `repo_area`: run event streaming, dashboard/API realtime, SSE cursors, task event repositories, run timeline ordering, SDK subscriptions, reconnect semantics
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,750-2,150
- `represented_diff_lines`: 1,768
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Trigger.dev run event semantics, SSE resume, run timelines, shard ordering, task event repositories, cursor design, and API/SDK contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a live run-event stream for dashboards and API customers. Today customers can poll the run events API after a run completes, and the dashboard can subscribe to trace updates and refetch. The new endpoint streams prepared run events over SSE so clients can render a live timeline without repeatedly fetching the whole event list.

The PR adds:

- a new `/api/v1/runs/:runId/events/stream` SSE endpoint,
- a stream service that reads recent run events and tails new events,
- a shard reader to spread stream reads across multiple backend shards,
- cursor helpers for SSE event IDs,
- SDK and React hook helpers for subscribing to run events,
- tests for status streaming, reconnect, and dashboard timeline behavior,
- docs for API users.

The intended product behavior is: a client subscribed to one run should see that run's lifecycle and span events in timeline order. If the connection drops, reconnecting with `Last-Event-ID` should replay every event missed while disconnected, without duplicating already consumed events.

## Existing Code Context

The real Trigger.dev codebase already has these relevant contracts:

- `apps/webapp/app/routes/api.v1.runs.$runId.events.ts` exposes a snapshot API for run events. It finds the run by friendly ID, checks authorization, resolves the configured event repository, and calls `getRunEvents(...)`.
- `apps/webapp/app/v3/eventRepository/eventRepository.server.ts` implements `getRunEvents(...)` against the task event store and prepares non-partial run events.
- `apps/webapp/app/v3/eventRepository/clickhouseEventRepository.server.ts` implements `getRunEvents(...)` for ClickHouse and explicitly orders run events by `start_time ASC`.
- `apps/webapp/app/services/realtimeClient.server.ts` streams run shape updates through Electric, partitions by environment and where clause, and preserves the live shape handle across long-polling requests.
- `apps/webapp/app/routes/realtime.v1.runs.$runId.ts` exposes realtime run shape updates and propagates client disconnect abort signals to the upstream stream.
- `packages/core/src/v3/apiClient/runStream.ts` has `SSEStreamSubscription`, which stores the latest SSE event ID and sends it back as `Last-Event-ID` on reconnect.
- `packages/core/src/v3/apiClient/runStream.test.ts` verifies that forced reconnect resumes with the previous `Last-Event-ID`.
- `apps/webapp/app/routes/realtime.v1.streams.$runId.$streamId.ts` and related stream routes read `Last-Event-ID` for stream replay.
- `apps/webapp/app/presenters/v3/RunStreamPresenter.server.ts` currently subscribes to trace pub/sub updates and emits pings so the dashboard can refetch run events.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this streaming contract actually preserves timeline order and reconnect replay semantics.

## Review Surface

Changed files in the synthetic PR:

- `packages/core/src/v3/runEvents.ts`
- `packages/trigger-sdk/src/v3/runs.ts`
- `packages/react-hooks/src/hooks/useRunEvents.ts`
- `apps/webapp/app/routes/api.v1.runs.$runId.events.stream.ts`
- `apps/webapp/app/services/runEvents/runEventCursor.server.ts`
- `apps/webapp/app/services/runEvents/runEventShardReader.server.ts`
- `apps/webapp/app/services/runEvents/runEventStream.server.ts`
- `apps/webapp/test/runEventStream.test.ts`
- `packages/core/src/v3/runEvents.test.ts`
- `docs/realtime/run-event-streaming.mdx`

The line references below use synthetic PR line numbers. The represented diff is focused on event ordering, cursor/reconnect semantics, SSE contracts, and tests that create false confidence.

## Diff

```diff
diff --git a/packages/core/src/v3/runEvents.ts b/packages/core/src/v3/runEvents.ts
new file mode 100644
index 0000000000..f65d81ea0c
--- /dev/null
+++ b/packages/core/src/v3/runEvents.ts
@@ -0,0 +1,109 @@
+import { z } from "zod";
+
+export const RunEventLevel = z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);
+
+export const RunEventKind = z.enum([
+  "TASK_RUN_CREATED",
+  "TASK_RUN_QUEUED",
+  "TASK_RUN_DEQUEUED",
+  "TASK_RUN_EXECUTING",
+  "TASK_RUN_COMPLETED",
+  "TASK_RUN_FAILED",
+  "TASK_RUN_CANCELED",
+  "SPAN_STARTED",
+  "SPAN_COMPLETED",
+  "LOG",
+  "WAITPOINT_CREATED",
+  "WAITPOINT_COMPLETED",
+]);
+
+export const RunEventSseEnvelope = z.object({
+  id: z.string(),
+  runId: z.string(),
+  traceId: z.string(),
+  kind: RunEventKind,
+  level: RunEventLevel.default("INFO"),
+  message: z.string().optional(),
+  spanId: z.string().optional(),
+  parentId: z.string().optional(),
+  attemptNumber: z.number().int().optional(),
+  taskSlug: z.string().optional(),
+  startTime: z.string(),
+  duration: z.number().optional(),
+  isError: z.boolean().default(false),
+  isCancelled: z.boolean().default(false),
+  data: z.record(z.unknown()).optional(),
+});
+
+export type RunEventSseEnvelope = z.infer<typeof RunEventSseEnvelope>;
+
+export const SubscribeToRunEventsOptions = z.object({
+  runId: z.string(),
+  lastEventId: z.string().optional(),
+  signal: z.any().optional(),
+});
+
+export type SubscribeToRunEventsOptions = z.infer<typeof SubscribeToRunEventsOptions>;
+
+export type RunEventSubscription = AsyncIterable<RunEventSseEnvelope> & {
+  unsubscribe: () => void;
+};
+
+export function parseRunEventChunk(value: unknown): RunEventSseEnvelope {
+  return RunEventSseEnvelope.parse(value);
+}
+
+export function isTerminalRunEvent(event: RunEventSseEnvelope) {
+  return (
+    event.kind === "TASK_RUN_COMPLETED" ||
+    event.kind === "TASK_RUN_FAILED" ||
+    event.kind === "TASK_RUN_CANCELED"
+  );
+}
+
+export function runEventSortKey(event: RunEventSseEnvelope) {
+  return `${event.startTime}:${event.id}`;
+}
+
+export function mergeRunEvents(
+  current: RunEventSseEnvelope[],
+  incoming: RunEventSseEnvelope[]
+): RunEventSseEnvelope[] {
+  const byId = new Map<string, RunEventSseEnvelope>();
+
+  for (const event of current) {
+    byId.set(event.id, event);
+  }
+
+  for (const event of incoming) {
+    byId.set(event.id, event);
+  }
+
+  return Array.from(byId.values()).sort((a, b) => {
+    const aKey = runEventSortKey(a);
+    const bKey = runEventSortKey(b);
+
+    if (aKey < bKey) {
+      return -1;
+    }
+
+    if (aKey > bKey) {
+      return 1;
+    }
+
+    return 0;
+  });
+}
+
+export function getLatestRunEventId(events: RunEventSseEnvelope[]) {
+  return events.at(-1)?.id;
+}
+
+export function createRunEventDebugSummary(events: RunEventSseEnvelope[]) {
+  return events.map((event) => ({
+    id: event.id,
+    kind: event.kind,
+    startTime: event.startTime,
+    attemptNumber: event.attemptNumber,
+  }));
+}
diff --git a/packages/trigger-sdk/src/v3/runs.ts b/packages/trigger-sdk/src/v3/runs.ts
index 9f8e35f5d4..cdd8c30601 100644
--- a/packages/trigger-sdk/src/v3/runs.ts
+++ b/packages/trigger-sdk/src/v3/runs.ts
@@ -1,6 +1,7 @@
 import type {
   AnyRetrieveRunResult,
   AnyRunShape,
+  RunEventSseEnvelope,
   ApiRequestOptions,
   InferRunTypes,
   ListProjectRunsQueryParams,
@@ -53,6 +54,7 @@ export const runs = {
   subscribeToRun,
   subscribeToRunsWithTag,
   subscribeToBatch: subscribeToRunsInBatch,
+  subscribeToRunEvents,
   fetchStream,
 };
@@ -526,6 +528,76 @@ async function fetchStream<T>(runId: string, streamKey: string): Promise<AsyncIterableStream<T>> {
   return await apiClient.fetchStream(runId, streamKey);
 }
+
+export type SubscribeToRunEventsOptions = {
+  signal?: AbortSignal;
+  lastEventId?: string;
+};
+
+function subscribeToRunEvents(
+  runId: string,
+  options?: SubscribeToRunEventsOptions
+): AsyncIterable<RunEventSseEnvelope> {
+  const apiClient = apiClientManager.clientOrThrow();
+
+  const url = new URL(`${apiClient.baseUrl}/api/v1/runs/${runId}/events/stream`);
+  if (options?.lastEventId) {
+    url.searchParams.set("from", options.lastEventId);
+  }
+
+  async function* iterator(): AsyncGenerator<RunEventSseEnvelope> {
+    const response = await fetch(url, {
+      headers: {
+        Accept: "text/event-stream",
+        ...apiClient.realtimeHeaders(),
+      },
+      signal: options?.signal,
+    });
+
+    if (!response.ok || !response.body) {
+      throw new Error(`Unable to subscribe to run events for ${runId}`);
+    }
+
+    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
+    let buffer = "";
+
+    while (true) {
+      const { value, done } = await reader.read();
+      if (done) {
+        return;
+      }
+
+      buffer += value;
+      const chunks = buffer.split("\n\n");
+      buffer = chunks.pop() ?? "";
+
+      for (const chunk of chunks) {
+        const dataLine = chunk
+          .split("\n")
+          .find((line) => line.startsWith("data:"));
+
+        if (!dataLine) {
+          continue;
+        }
+
+        yield JSON.parse(dataLine.slice("data:".length).trim()) as RunEventSseEnvelope;
+      }
+    }
+  }
+
+  return {
+    [Symbol.asyncIterator]: iterator,
+  };
+}
diff --git a/packages/react-hooks/src/hooks/useRunEvents.ts b/packages/react-hooks/src/hooks/useRunEvents.ts
new file mode 100644
index 0000000000..80530581e2
--- /dev/null
+++ b/packages/react-hooks/src/hooks/useRunEvents.ts
@@ -0,0 +1,124 @@
+"use client";
+
+import { RunEventSseEnvelope, mergeRunEvents } from "@trigger.dev/core/v3";
+import { useCallback, useEffect, useRef, useState } from "react";
+import { useApiClient } from "./useApiClient.js";
+
+export type UseRunEventsOptions = {
+  enabled?: boolean;
+  lastEventId?: string;
+  onEvent?: (event: RunEventSseEnvelope) => void;
+  onError?: (error: Error) => void;
+};
+
+export type UseRunEventsResult = {
+  events: RunEventSseEnvelope[];
+  latestEventId?: string;
+  error?: Error;
+  stop: () => void;
+};
+
+export function useRunEvents(runId?: string, options?: UseRunEventsOptions): UseRunEventsResult {
+  const apiClient = useApiClient(options);
+  const [events, setEvents] = useState<RunEventSseEnvelope[]>([]);
+  const [error, setError] = useState<Error | undefined>();
+  const abortRef = useRef<AbortController | undefined>();
+  const latestEventIdRef = useRef<string | undefined>(options?.lastEventId);
+
+  const stop = useCallback(() => {
+    abortRef.current?.abort();
+    abortRef.current = undefined;
+  }, []);
+
+  useEffect(() => {
+    if (!runId || !apiClient) {
+      return;
+    }
+
+    if (options?.enabled === false) {
+      return;
+    }
+
+    const abortController = new AbortController();
+    abortRef.current = abortController;
+
+    let closed = false;
+
+    async function start() {
+      while (!closed && !abortController.signal.aborted) {
+        try {
+          const response = await fetch(`${apiClient.baseUrl}/api/v1/runs/${runId}/events/stream`, {
+            headers: {
+              Accept: "text/event-stream",
+              Authorization: `Bearer ${apiClient.accessToken}`,
+            },
+            signal: abortController.signal,
+          });
+
+          if (!response.ok || !response.body) {
+            throw new Error(`Unable to subscribe to run events: ${response.status}`);
+          }
+
+          await readEventStream(response.body, (event) => {
+            latestEventIdRef.current = event.id;
+            setEvents((current) => mergeRunEvents(current, [event]));
+            options?.onEvent?.(event);
+          });
+        } catch (err) {
+          if (abortController.signal.aborted) {
+            return;
+          }
+
+          const error = err instanceof Error ? err : new Error(String(err));
+          setError(error);
+          options?.onError?.(error);
+
+          await new Promise((resolve) => setTimeout(resolve, 500));
+        }
+      }
+    }
+
+    start();
+
+    return () => {
+      closed = true;
+      abortController.abort();
+    };
+  }, [runId, apiClient, options?.enabled]);
+
+  return {
+    events,
+    latestEventId: latestEventIdRef.current,
+    error,
+    stop,
+  };
+}
+
+async function readEventStream(
+  body: ReadableStream<Uint8Array>,
+  onEvent: (event: RunEventSseEnvelope) => void
+) {
+  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
+  let buffer = "";
+
+  while (true) {
+    const { value, done } = await reader.read();
+    if (done) {
+      return;
+    }
+
+    buffer += value;
+    const chunks = buffer.split("\n\n");
+    buffer = chunks.pop() ?? "";
+
+    for (const chunk of chunks) {
+      const lines = chunk.split("\n");
+      const data = lines.find((line) => line.startsWith("data:"));
+      if (!data) {
+        continue;
+      }
+
+      onEvent(JSON.parse(data.slice(5).trim()) as RunEventSseEnvelope);
+    }
+  }
+}
diff --git a/apps/webapp/app/routes/api.v1.runs.$runId.events.stream.ts b/apps/webapp/app/routes/api.v1.runs.$runId.events.stream.ts
new file mode 100644
index 0000000000..354ecf350b
--- /dev/null
+++ b/apps/webapp/app/routes/api.v1.runs.$runId.events.stream.ts
@@ -0,0 +1,82 @@
+import { z } from "zod";
+import { $replica } from "~/db.server";
+import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
+import { RunEventStreamService } from "~/services/runEvents/runEventStream.server";
+import {
+  anyResource,
+  createLoaderApiRoute,
+} from "~/services/routeBuilders/apiBuilder.server";
+
+const ParamsSchema = z.object({
+  runId: z.string(),
+});
+
+const SearchParamsSchema = z.object({
+  from: z.string().optional(),
+  wait: z.coerce.number().int().min(1).max(60).default(30),
+});
+
+export const loader = createLoaderApiRoute(
+  {
+    params: ParamsSchema,
+    searchParams: SearchParamsSchema,
+    allowJWT: true,
+    corsStrategy: "all",
+    findResource: async (params, authentication) => {
+      return $replica.taskRun.findFirst({
+        where: {
+          friendlyId: params.runId,
+          runtimeEnvironmentId: authentication.environment.id,
+        },
+        select: {
+          id: true,
+          friendlyId: true,
+          traceId: true,
+          taskIdentifier: true,
+          runTags: true,
+          createdAt: true,
+          completedAt: true,
+          taskEventStore: true,
+          batch: {
+            select: {
+              friendlyId: true,
+            },
+          },
+        },
+      });
+    },
+    authorization: {
+      action: "read",
+      resource: (run) => {
+        const resources = [
+          { type: "runs", id: run.friendlyId },
+          { type: "tasks", id: run.taskIdentifier },
+          ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
+        ];
+
+        if (run.batch?.friendlyId) {
+          resources.push({ type: "batch", id: run.batch.friendlyId });
+        }
+
+        return anyResource(resources);
+      },
+    },
+  },
+  async ({ authentication, resource: run, request, searchParams }) => {
+    const service = new RunEventStreamService();
+
+    const lastEventId =
+      searchParams.from ??
+      request.headers.get("Last-Event-ID") ??
+      request.headers.get("last-event-id") ??
+      undefined;
+
+    return service.stream({
+      run,
+      environmentId: authentication.environment.id,
+      waitSeconds: searchParams.wait,
+      lastEventId,
+      signal: getRequestAbortSignal(),
+    });
+  }
+);
diff --git a/apps/webapp/app/services/runEvents/runEventCursor.server.ts b/apps/webapp/app/services/runEvents/runEventCursor.server.ts
new file mode 100644
index 0000000000..1e4ad47f50
--- /dev/null
+++ b/apps/webapp/app/services/runEvents/runEventCursor.server.ts
@@ -0,0 +1,58 @@
+import { z } from "zod";
+
+const CursorShape = z.object({
+  runId: z.string(),
+  shard: z.number().int().min(0),
+  sequence: z.number().int().min(0),
+  emittedAt: z.string(),
+});
+
+export type RunEventCursor = z.infer<typeof CursorShape>;
+
+export function encodeRunEventCursor(cursor: RunEventCursor) {
+  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
+}
+
+export function decodeRunEventCursor(value: string | undefined): RunEventCursor | undefined {
+  if (!value) {
+    return undefined;
+  }
+
+  try {
+    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
+    return CursorShape.parse(decoded);
+  } catch {
+    return undefined;
+  }
+}
+
+export function createInitialRunEventCursor(input: {
+  runId: string;
+  shard: number;
+  lastEventId?: string;
+}): RunEventCursor {
+  const decoded = decodeRunEventCursor(input.lastEventId);
+
+  if (decoded?.runId === input.runId && decoded.shard === input.shard) {
+    return decoded;
+  }
+
+  return {
+    runId: input.runId,
+    shard: input.shard,
+    sequence: 0,
+    emittedAt: new Date().toISOString(),
+  };
+}
+
+export function advanceRunEventCursor(cursor: RunEventCursor): RunEventCursor {
+  return {
+    ...cursor,
+    sequence: cursor.sequence + 1,
+    emittedAt: new Date().toISOString(),
+  };
+}
+
+export function cursorDate(cursor: RunEventCursor) {
+  return new Date(cursor.emittedAt);
+}
diff --git a/apps/webapp/app/services/runEvents/runEventShardReader.server.ts b/apps/webapp/app/services/runEvents/runEventShardReader.server.ts
new file mode 100644
index 0000000000..132eaf9c69
--- /dev/null
+++ b/apps/webapp/app/services/runEvents/runEventShardReader.server.ts
@@ -0,0 +1,127 @@
+import { logger } from "~/services/logger.server";
+import { resolveEventRepositoryForStore } from "~/v3/eventRepository/index.server";
+import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
+import {
+  advanceRunEventCursor,
+  createInitialRunEventCursor,
+  cursorDate,
+  encodeRunEventCursor,
+  RunEventCursor,
+} from "./runEventCursor.server";
+
+const SHARD_COUNT = 4;
+
+export type RunEventShardInput = {
+  run: {
+    id: string;
+    friendlyId: string;
+    traceId: string;
+    createdAt: Date;
+    completedAt: Date | null;
+    taskEventStore: string | null;
+  };
+  environmentId: string;
+  lastEventId?: string;
+};
+
+export type ShardedRunEvent = {
+  id: string;
+  cursor: string;
+  shard: number;
+  kind: string;
+  level: string;
+  message?: string;
+  spanId?: string;
+  parentId?: string;
+  attemptNumber?: number;
+  taskSlug?: string;
+  startTime: string;
+  duration?: number;
+  isError: boolean;
+  isCancelled: boolean;
+  runId: string;
+  traceId: string;
+  data?: Record<string, unknown>;
+};
+
+export class RunEventShardReader {
+  async readInitial(input: RunEventShardInput): Promise<ShardedRunEvent[]> {
+    const shards = Array.from({ length: SHARD_COUNT }, (_, shard) => shard);
+    const results = await Promise.all(shards.map((shard) => this.readShard(input, shard)));
+
+    return results.flat();
+  }
+
+  async readShard(input: RunEventShardInput, shard: number): Promise<ShardedRunEvent[]> {
+    const cursor = createInitialRunEventCursor({
+      runId: input.run.friendlyId,
+      shard,
+      lastEventId: input.lastEventId,
+    });
+
+    const eventRepository = resolveEventRepositoryForStore(input.run.taskEventStore ?? undefined);
+
+    const events = await eventRepository.getRunEvents(
+      getTaskEventStoreTableForRun(input.run),
+      input.environmentId,
+      input.run.traceId,
+      input.run.friendlyId,
+      cursorDate(cursor),
+      input.run.completedAt ?? undefined
+    );
+
+    let currentCursor: RunEventCursor = cursor;
+    const shardedEvents: ShardedRunEvent[] = [];
+
+    for (const event of events) {
+      if (this.shardForEvent(event.spanId ?? event.message ?? event.kind) !== shard) {
+        continue;
+      }
+
+      currentCursor = advanceRunEventCursor(currentCursor);
+
+      shardedEvents.push({
+        id: `${input.run.friendlyId}:${shard}:${currentCursor.sequence}`,
+        cursor: encodeRunEventCursor(currentCursor),
+        shard,
+        kind: event.kind,
+        level: event.level ?? "INFO",
+        message: event.message,
+        spanId: event.spanId,
+        parentId: event.parentId,
+        attemptNumber: event.attemptNumber,
+        taskSlug: event.taskSlug,
+        startTime: event.startTime.toISOString(),
+        duration: event.duration,
+        isError: event.isError,
+        isCancelled: event.isCancelled,
+        runId: input.run.friendlyId,
+        traceId: input.run.traceId,
+        data: {
+          style: event.style,
+          environmentType: event.environmentType,
+          events: event.events,
+        },
+      });
+    }
+
+    logger.debug("[RunEventShardReader] read shard", {
+      runId: input.run.friendlyId,
+      shard,
+      count: shardedEvents.length,
+      first: shardedEvents[0]?.id,
+      last: shardedEvents.at(-1)?.id,
+    });
+
+    return shardedEvents;
+  }
+
+  shardForEvent(value: string) {
+    let hash = 0;
+    for (let index = 0; index < value.length; index++) {
+      hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
+    }
+
+    return hash % SHARD_COUNT;
+  }
+}
diff --git a/apps/webapp/app/services/runEvents/runEventStream.server.ts b/apps/webapp/app/services/runEvents/runEventStream.server.ts
new file mode 100644
index 0000000000..1bf255c3ee
--- /dev/null
+++ b/apps/webapp/app/services/runEvents/runEventStream.server.ts
@@ -0,0 +1,135 @@
+import { logger } from "~/services/logger.server";
+import { tracePubSub } from "~/v3/services/tracePubSub.server";
+import { RunEventShardReader, ShardedRunEvent } from "./runEventShardReader.server";
+
+const PING_INTERVAL_MS = 5_000;
+const MAX_INITIAL_EVENTS = 2_000;
+
+export type RunEventStreamInput = {
+  run: {
+    id: string;
+    friendlyId: string;
+    traceId: string;
+    createdAt: Date;
+    completedAt: Date | null;
+    taskEventStore: string | null;
+  };
+  environmentId: string;
+  waitSeconds: number;
+  lastEventId?: string;
+  signal?: AbortSignal;
+};
+
+export class RunEventStreamService {
+  constructor(private readonly reader = new RunEventShardReader()) {}
+
+  async stream(input: RunEventStreamInput) {
+    const encoder = new TextEncoder();
+    const reader = this.reader;
+    const abortSignal = input.signal;
+    const waitMs = input.waitSeconds * 1000;
+    const startedAt = Date.now();
+
+    const stream = new ReadableStream<Uint8Array>({
+      async start(controller) {
+        let closed = false;
+        let pingTimer: ReturnType<typeof setInterval> | undefined;
+        let unsubscribe: (() => Promise<void>) | undefined;
+        let pendingFlush: Promise<void> = Promise.resolve();
+
+        const close = async () => {
+          if (closed) {
+            return;
+          }
+
+          closed = true;
+          if (pingTimer) {
+            clearInterval(pingTimer);
+          }
+
+          if (unsubscribe) {
+            await unsubscribe();
+          }
+
+          try {
+            controller.close();
+          } catch {
+            // The client may have disconnected first.
+          }
+        };
+
+        const send = (event: ShardedRunEvent) => {
+          if (closed) {
+            return;
+          }
+
+          controller.enqueue(encoder.encode(`id: ${event.cursor}\n`));
+          controller.enqueue(encoder.encode(`event: run.event\n`));
+          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
+        };
+
+        const sendComment = (comment: string) => {
+          if (!closed) {
+            controller.enqueue(encoder.encode(`: ${comment}\n\n`));
+          }
+        };
+
+        const flushEvents = async () => {
+          const events = await reader.readInitial({
+            run: input.run,
+            environmentId: input.environmentId,
+            lastEventId: input.lastEventId,
+          });
+
+          for (const event of events.slice(0, MAX_INITIAL_EVENTS)) {
+            send(event);
+          }
+        };
+
+        abortSignal?.addEventListener(
+          "abort",
+          () => {
+            close();
+          },
+          { once: true }
+        );
+
+        const subscription = await tracePubSub.subscribeToTrace(input.run.traceId);
+        unsubscribe = subscription.unsubscribe;
+
+        subscription.eventEmitter.on("message", () => {
+          pendingFlush = pendingFlush.then(flushEvents).catch((error) => {
+            logger.error("[RunEventStreamService] failed to flush events", {
+              runId: input.run.friendlyId,
+              error,
+            });
+          });
+        });
+
+        pingTimer = setInterval(() => {
+          sendComment("ping");
+
+          if (Date.now() - startedAt > waitMs) {
+            close();
+          }
+        }, PING_INTERVAL_MS);
+
+        await flushEvents();
+      },
+      cancel() {
+        logger.debug("[RunEventStreamService] stream canceled", {
+          runId: input.run.friendlyId,
+        });
+      },
+    });
+
+    return new Response(stream, {
+      headers: {
+        "Content-Type": "text/event-stream",
+        "Cache-Control": "no-cache, no-transform",
+        Connection: "keep-alive",
+        "X-Accel-Buffering": "no",
+      },
+    });
+  }
+}
diff --git a/apps/webapp/test/runEventStream.test.ts b/apps/webapp/test/runEventStream.test.ts
new file mode 100644
index 0000000000..25a4edfc20
--- /dev/null
+++ b/apps/webapp/test/runEventStream.test.ts
@@ -0,0 +1,193 @@
+import { describe, expect, it, vi } from "vitest";
+import { RunEventShardReader } from "~/services/runEvents/runEventShardReader.server";
+import {
+  createInitialRunEventCursor,
+  decodeRunEventCursor,
+  encodeRunEventCursor,
+} from "~/services/runEvents/runEventCursor.server";
+import { RunEventStreamService } from "~/services/runEvents/runEventStream.server";
+
+describe("run event streaming", () => {
+  it("creates a fresh cursor when no Last-Event-ID header is provided", () => {
+    const cursor = createInitialRunEventCursor({
+      runId: "run_123",
+      shard: 0,
+    });
+
+    expect(cursor.runId).to.equal("run_123");
+    expect(cursor.shard).to.equal(0);
+    expect(cursor.sequence).to.equal(0);
+    expect(new Date(cursor.emittedAt).getTime()).to.be.greaterThan(0);
+  });
+
+  it("decodes a cursor for the same shard", () => {
+    const encoded = encodeRunEventCursor({
+      runId: "run_123",
+      shard: 1,
+      sequence: 41,
+      emittedAt: "2026-05-16T00:00:00.000Z",
+    });
+
+    const cursor = createInitialRunEventCursor({
+      runId: "run_123",
+      shard: 1,
+      lastEventId: encoded,
+    });
+
+    expect(cursor.sequence).to.equal(41);
+    expect(cursor.emittedAt).to.equal("2026-05-16T00:00:00.000Z");
+  });
+
+  it("starts a new cursor when the reconnect cursor came from another shard", () => {
+    const encoded = encodeRunEventCursor({
+      runId: "run_123",
+      shard: 1,
+      sequence: 41,
+      emittedAt: "2026-05-16T00:00:00.000Z",
+    });
+
+    const cursor = createInitialRunEventCursor({
+      runId: "run_123",
+      shard: 2,
+      lastEventId: encoded,
+    });
+
+    expect(cursor.shard).to.equal(2);
+    expect(cursor.sequence).to.equal(0);
+    expect(cursor.emittedAt).to.not.equal("2026-05-16T00:00:00.000Z");
+  });
+
+  it("shards events by event identity", () => {
+    const reader = new RunEventShardReader();
+
+    const queuedShard = reader.shardForEvent("TASK_RUN_QUEUED");
+    const executingShard = reader.shardForEvent("TASK_RUN_EXECUTING");
+    const completedShard = reader.shardForEvent("TASK_RUN_COMPLETED");
+
+    expect([queuedShard, executingShard, completedShard].every((shard) => shard >= 0)).to.equal(
+      true
+    );
+  });
+
+  it("allows lifecycle events to be emitted from different shards", () => {
+    const reader = new RunEventShardReader();
+
+    const shards = new Set([
+      reader.shardForEvent("TASK_RUN_QUEUED"),
+      reader.shardForEvent("TASK_RUN_EXECUTING"),
+      reader.shardForEvent("TASK_RUN_COMPLETED"),
+    ]);
+
+    expect(shards.size).to.be.greaterThan(1);
+  });
+
+  it("accepts whatever order the shard readers resolve in", async () => {
+    const reader = {
+      readInitial: vi.fn().mockResolvedValue([
+        {
+          id: "run_123:2:1",
+          cursor: encodeRunEventCursor({
+            runId: "run_123",
+            shard: 2,
+            sequence: 1,
+            emittedAt: "2026-05-16T10:00:03.000Z",
+          }),
+          shard: 2,
+          kind: "TASK_RUN_COMPLETED",
+          level: "INFO",
+          startTime: "2026-05-16T10:00:03.000Z",
+          isError: false,
+          isCancelled: false,
+          runId: "run_123",
+          traceId: "trace_123",
+        },
+        {
+          id: "run_123:0:1",
+          cursor: encodeRunEventCursor({
+            runId: "run_123",
+            shard: 0,
+            sequence: 1,
+            emittedAt: "2026-05-16T10:00:01.000Z",
+          }),
+          shard: 0,
+          kind: "TASK_RUN_QUEUED",
+          level: "INFO",
+          startTime: "2026-05-16T10:00:01.000Z",
+          isError: false,
+          isCancelled: false,
+          runId: "run_123",
+          traceId: "trace_123",
+        },
+        {
+          id: "run_123:1:1",
+          cursor: encodeRunEventCursor({
+            runId: "run_123",
+            shard: 1,
+            sequence: 1,
+            emittedAt: "2026-05-16T10:00:02.000Z",
+          }),
+          shard: 1,
+          kind: "TASK_RUN_EXECUTING",
+          level: "INFO",
+          startTime: "2026-05-16T10:00:02.000Z",
+          isError: false,
+          isCancelled: false,
+          runId: "run_123",
+          traceId: "trace_123",
+        },
+      ]),
+    } as any;
+
+    const service = new RunEventStreamService(reader);
+    const response = await service.stream({
+      run: {
+        id: "db_run_123",
+        friendlyId: "run_123",
+        traceId: "trace_123",
+        createdAt: new Date("2026-05-16T10:00:00.000Z"),
+        completedAt: null,
+        taskEventStore: null,
+      },
+      environmentId: "env_123",
+      waitSeconds: 1,
+    });
+
+    const text = await response.text();
+
+    expect(text.indexOf("TASK_RUN_COMPLETED")).to.be.lessThan(text.indexOf("TASK_RUN_QUEUED"));
+    expect(text.indexOf("TASK_RUN_QUEUED")).to.be.lessThan(text.indexOf("TASK_RUN_EXECUTING"));
+  });
+
+  it("documents reconnect with Last-Event-ID but fetch passes the same cursor to every shard", () => {
+    const cursor = encodeRunEventCursor({
+      runId: "run_123",
+      shard: 0,
+      sequence: 12,
+      emittedAt: "2026-05-16T10:00:05.000Z",
+    });
+
+    const decoded = decodeRunEventCursor(cursor);
+
+    expect(decoded?.runId).to.equal("run_123");
+    expect(decoded?.shard).to.equal(0);
+    expect(decoded?.sequence).to.equal(12);
+  });
+
+  it("starts other shards at server time on reconnect", () => {
+    const lastEventId = encodeRunEventCursor({
+      runId: "run_123",
+      shard: 0,
+      sequence: 12,
+      emittedAt: "2026-05-16T10:00:05.000Z",
+    });
+
+    const otherShardCursor = createInitialRunEventCursor({
+      runId: "run_123",
+      shard: 3,
+      lastEventId,
+    });
+
+    expect(otherShardCursor.sequence).to.equal(0);
+    expect(otherShardCursor.emittedAt).to.not.equal("2026-05-16T10:00:05.000Z");
+  });
+});
diff --git a/packages/core/src/v3/runEvents.test.ts b/packages/core/src/v3/runEvents.test.ts
new file mode 100644
index 0000000000..cc9d8d541a
--- /dev/null
+++ b/packages/core/src/v3/runEvents.test.ts
@@ -0,0 +1,224 @@
+import { describe, expect, it } from "vitest";
+import {
+  createRunEventDebugSummary,
+  getLatestRunEventId,
+  isTerminalRunEvent,
+  mergeRunEvents,
+  parseRunEventChunk,
+  RunEventSseEnvelope,
+} from "./runEvents";
+
+describe("run events client helpers", () => {
+  it("parses an SSE payload into a run event", () => {
+    const event = parseRunEventChunk({
+      id: "run_123:0:1",
+      runId: "run_123",
+      traceId: "trace_123",
+      kind: "TASK_RUN_QUEUED",
+      level: "INFO",
+      startTime: "2026-05-16T10:00:00.000Z",
+      isError: false,
+      isCancelled: false,
+    });
+
+    expect(event.id).to.equal("run_123:0:1");
+    expect(event.kind).to.equal("TASK_RUN_QUEUED");
+  });
+
+  it("sorts merged events by start time", () => {
+    const merged = mergeRunEvents(
+      [
+        event({
+          id: "run_123:2:1",
+          kind: "TASK_RUN_COMPLETED",
+          startTime: "2026-05-16T10:00:03.000Z",
+        }),
+      ],
+      [
+        event({
+          id: "run_123:0:1",
+          kind: "TASK_RUN_QUEUED",
+          startTime: "2026-05-16T10:00:01.000Z",
+        }),
+        event({
+          id: "run_123:1:1",
+          kind: "TASK_RUN_EXECUTING",
+          startTime: "2026-05-16T10:00:02.000Z",
+        }),
+      ]
+    );
+
+    expect(merged.map((item) => item.kind)).to.deep.equal([
+      "TASK_RUN_QUEUED",
+      "TASK_RUN_EXECUTING",
+      "TASK_RUN_COMPLETED",
+    ]);
+  });
+
+  it("de-duplicates by event id when reconnect replays an already-rendered event", () => {
+    const merged = mergeRunEvents(
+      [
+        event({
+          id: "run_123:0:1",
+          kind: "TASK_RUN_QUEUED",
+          startTime: "2026-05-16T10:00:01.000Z",
+          message: "old queued",
+        }),
+      ],
+      [
+        event({
+          id: "run_123:0:1",
+          kind: "TASK_RUN_QUEUED",
+          startTime: "2026-05-16T10:00:01.000Z",
+          message: "new queued",
+        }),
+      ]
+    );
+
+    expect(merged).to.have.length(1);
+    expect(merged[0].message).to.equal("new queued");
+  });
+
+  it("uses the visually sorted last event as latest event id", () => {
+    const events = mergeRunEvents(
+      [
+        event({
+          id: "run_123:2:1",
+          kind: "TASK_RUN_COMPLETED",
+          startTime: "2026-05-16T10:00:03.000Z",
+        }),
+      ],
+      [
+        event({
+          id: "run_123:0:1",
+          kind: "TASK_RUN_QUEUED",
+          startTime: "2026-05-16T10:00:01.000Z",
+        }),
+      ]
+    );
+
+    expect(getLatestRunEventId(events)).to.equal("run_123:2:1");
+  });
+
+  it("treats completed, failed, and canceled as terminal events", () => {
+    expect(isTerminalRunEvent(event({ kind: "TASK_RUN_COMPLETED" }))).to.equal(true);
+    expect(isTerminalRunEvent(event({ kind: "TASK_RUN_FAILED" }))).to.equal(true);
+    expect(isTerminalRunEvent(event({ kind: "TASK_RUN_CANCELED" }))).to.equal(true);
+    expect(isTerminalRunEvent(event({ kind: "TASK_RUN_EXECUTING" }))).to.equal(false);
+  });
+
+  it("keeps terminal events even when an earlier executing event arrives later", () => {
+    const merged = mergeRunEvents(
+      [
+        event({
+          id: "run_123:2:1",
+          kind: "TASK_RUN_COMPLETED",
+          startTime: "2026-05-16T10:00:03.000Z",
+        }),
+      ],
+      [
+        event({
+          id: "run_123:1:1",
+          kind: "TASK_RUN_EXECUTING",
+          startTime: "2026-05-16T10:00:02.000Z",
+        }),
+      ]
+    );
+
+    expect(merged.map((item) => item.kind)).to.deep.equal([
+      "TASK_RUN_EXECUTING",
+      "TASK_RUN_COMPLETED",
+    ]);
+  });
+
+  it("does not know whether a missing sequence from another shard was skipped", () => {
+    const events = [
+      event({
+        id: "run_123:0:12",
+        kind: "TASK_RUN_QUEUED",
+        startTime: "2026-05-16T10:00:01.000Z",
+      }),
+      event({
+        id: "run_123:2:1",
+        kind: "TASK_RUN_COMPLETED",
+        startTime: "2026-05-16T10:00:04.000Z",
+      }),
+    ];
+
+    expect(getLatestRunEventId(events)).to.equal("run_123:2:1");
+    expect(createRunEventDebugSummary(events)).to.deep.equal([
+      {
+        id: "run_123:0:12",
+        kind: "TASK_RUN_QUEUED",
+        startTime: "2026-05-16T10:00:01.000Z",
+        attemptNumber: undefined,
+      },
+      {
+        id: "run_123:2:1",
+        kind: "TASK_RUN_COMPLETED",
+        startTime: "2026-05-16T10:00:04.000Z",
+        attemptNumber: undefined,
+      },
+    ]);
+  });
+
+  it("sorts span events after lifecycle events when timestamps tie by event id", () => {
+    const merged = mergeRunEvents(
+      [
+        event({
+          id: "run_123:span:1",
+          kind: "SPAN_STARTED",
+          startTime: "2026-05-16T10:00:02.000Z",
+        }),
+      ],
+      [
+        event({
+          id: "run_123:run:1",
+          kind: "TASK_RUN_EXECUTING",
+          startTime: "2026-05-16T10:00:02.000Z",
+        }),
+      ]
+    );
+
+    expect(merged.map((item) => item.id)).to.deep.equal(["run_123:run:1", "run_123:span:1"]);
+  });
+
+  it("does not model causal order between parent and child spans", () => {
+    const merged = mergeRunEvents(
+      [
+        event({
+          id: "run_123:child:1",
+          kind: "SPAN_COMPLETED",
+          parentId: "parent",
+          spanId: "child",
+          startTime: "2026-05-16T10:00:03.000Z",
+        }),
+      ],
+      [
+        event({
+          id: "run_123:parent:1",
+          kind: "SPAN_STARTED",
+          spanId: "parent",
+          startTime: "2026-05-16T10:00:04.000Z",
+        }),
+      ]
+    );
+
+    expect(merged[0].spanId).to.equal("child");
+    expect(merged[1].spanId).to.equal("parent");
+  });
+
+  function event(overrides: Partial<RunEventSseEnvelope>): RunEventSseEnvelope {
+    return {
+      id: "run_123:0:1",
+      runId: "run_123",
+      traceId: "trace_123",
+      kind: "TASK_RUN_QUEUED",
+      level: "INFO",
+      startTime: "2026-05-16T10:00:00.000Z",
+      isError: false,
+      isCancelled: false,
+      ...overrides,
+    };
+  }
+});
diff --git a/docs/realtime/run-event-streaming.mdx b/docs/realtime/run-event-streaming.mdx
new file mode 100644
index 0000000000..17bdcb1f45
--- /dev/null
+++ b/docs/realtime/run-event-streaming.mdx
@@ -0,0 +1,579 @@
+# Run Event Streaming
+
+Run event streaming lets dashboards and API clients subscribe to a live
+timeline for a single run.
+
+The endpoint is:
+
++```txt
+GET /api/v1/runs/:runId/events/stream
++```
+
+The response is an SSE stream. Each event has:
+
+- an `id` field,
+- `event: run.event`,
+- a JSON `data` payload.
+
+Example:
+
++```txt
+id: eyJydW5JZCI6InJ1bl8xMjMiLCJzaGFyZCI6MCwic2VxdWVuY2UiOjF9
+event: run.event
+data: {"id":"run_123:0:1","kind":"TASK_RUN_QUEUED","runId":"run_123"}
+
++```
+
+## Event payload
+
++```json
+{
+  "id": "run_123:0:1",
+  "cursor": "eyJydW5JZCI6InJ1bl8xMjMiLCJzaGFyZCI6MCwic2VxdWVuY2UiOjF9",
+  "shard": 0,
+  "kind": "TASK_RUN_QUEUED",
+  "level": "INFO",
+  "runId": "run_123",
+  "traceId": "trace_123",
+  "startTime": "2026-05-16T10:00:00.000Z",
+  "isError": false,
+  "isCancelled": false
+}
++```
+
+The `cursor` field is the same value as the SSE `id`.
+
+## SDK usage
+
++```ts
+import { runs } from "@trigger.dev/sdk/v3";
+
+for await (const event of runs.subscribeToRunEvents("run_123")) {
+  console.log(event.kind, event.startTime);
+}
++```
+
+## React usage
+
++```tsx
+import { useRunEvents } from "@trigger.dev/react-hooks";
+
+export function Timeline({ runId }: { runId: string }) {
+  const { events } = useRunEvents(runId);
+
+  return (
+    <ol>
+      {events.map((event) => (
+        <li key={event.id}>{event.kind}</li>
+      ))}
+    </ol>
+  );
+}
++```
+
+## Reconnect
+
+Browsers and SDK clients should reconnect with the previous SSE event ID:
+
++```txt
+Last-Event-ID: eyJydW5JZCI6InJ1bl8xMjMiLCJzaGFyZCI6MCwic2VxdWVuY2UiOjEyfQ
++```
+
+The server decodes the cursor and resumes the matching shard.
+
+If the cursor came from shard `0`, shard `0` starts after that sequence.
+Other shards start from the current server time so the reconnect does not
+replay a large amount of unrelated old data.
+
+## Shards
+
+Run events are read from four logical shards. Shards let the stream service
+perform smaller repository reads and return events quickly for noisy runs.
+
+The shard is derived from event identity:
+
++```ts
+shardForEvent(event.spanId ?? event.message ?? event.kind)
++```
+
+This keeps repeated log messages or span updates on a stable shard.
+
+## Ordering
+
+Events are emitted as soon as shard reads resolve. The stream does not block a
+fast shard while a slow shard is waiting on the event repository.
+
+Clients that need a sorted timeline can sort by `startTime` after receiving an
+event:
+
++```ts
+events.sort((a, b) => a.startTime.localeCompare(b.startTime));
++```
+
+The React hook does this automatically by calling `mergeRunEvents`.
+
+## Lifecycle example
+
+A typical run produces:
+
+1. `TASK_RUN_CREATED`
+2. `TASK_RUN_QUEUED`
+3. `TASK_RUN_DEQUEUED`
+4. `TASK_RUN_EXECUTING`
+5. `SPAN_STARTED`
+6. `LOG`
+7. `SPAN_COMPLETED`
+8. `TASK_RUN_COMPLETED`
+
+Because lifecycle events are sharded by event kind, these events may arrive in
+separate shard batches. The UI should not assume transport order is timeline
+order.
+
+## Dashboard behavior
+
+The dashboard should append events immediately. It may reorder visually after a
+new event arrives. This keeps the timeline moving even if one shard is slow.
+
+## API behavior
+
+API clients receive every event that the selected shard reader returns. If a
+client disconnects, it should keep the last cursor it received and pass it as
+`Last-Event-ID`.
+
+## Failure modes
+
+| Symptom | Likely cause | Action |
+| --- | --- | --- |
+| Timeline jumps backward | A slower shard emitted an older event later | Sort by `startTime` |
+| Reconnect misses events | Cursor belonged to a different shard | Reconnect again |
+| Duplicate events | Client retried before storing the last cursor | De-duplicate by `id` |
+| Stream closes after wait window | No new trace pub/sub events arrived | Reconnect |
+| Hook shows completed before executing | Terminal event shard returned first | Sort by `startTime` |
+
+## Operational notes
+
+The stream subscribes to trace pub/sub. Pub/sub messages do not include the
+event payload; they are wakeups. On wakeup the service queries the event
+repository again.
+
+The stream sends ping comments every five seconds:
+
++```txt
+: ping
+
++```
+
+The default wait window is 30 seconds.
+
+## Compatibility
+
+The snapshot events API remains available:
+
++```txt
+GET /api/v1/runs/:runId/events
++```
+
+Use the snapshot API for historical exports and the stream API for live
+dashboards.
+
+## Cursor format
+
+A cursor is base64url-encoded JSON:
+
++```json
+{
+  "runId": "run_123",
+  "shard": 0,
+  "sequence": 12,
+  "emittedAt": "2026-05-16T10:00:05.000Z"
+}
++```
+
+`sequence` is shard-local.
+
+`emittedAt` is the server time when the cursor was advanced.
+
+## Examples
+
+### Basic fetch
+
++```ts
+const response = await fetch("/api/v1/runs/run_123/events/stream", {
+  headers: {
+    Accept: "text/event-stream",
+    Authorization: `Bearer ${token}`,
+  },
+});
++```
+
+### Resume
+
++```ts
+const response = await fetch("/api/v1/runs/run_123/events/stream", {
+  headers: {
+    Accept: "text/event-stream",
+    Authorization: `Bearer ${token}`,
+    "Last-Event-ID": lastEventId,
+  },
+});
++```
+
+### SDK
+
++```ts
+let lastEventId: string | undefined;
+
+for await (const event of runs.subscribeToRunEvents("run_123", { lastEventId })) {
+  lastEventId = event.cursor;
+}
++```
+
+### React
+
++```tsx
+const { events, latestEventId, error, stop } = useRunEvents(runId);
++```
+
+## Implementation checklist
+
+- Authorize the run using the same resources as the snapshot run events API.
+- Subscribe to trace pub/sub for wakeups.
+- Read prepared run events from the configured task event store.
+- Emit `run.event` SSE records.
+- Include an SSE `id` for reconnect.
+- Reconnect with `Last-Event-ID`.
+- Keep pings enabled so proxies do not buffer the response.
+- Abort repository polling when the client disconnects.
+
+## Support checklist
+
+Ask customers for:
+
+- run ID,
+- project ref,
+- environment,
+- last event ID,
+- first missing event kind,
+- browser/network disconnect time,
+- SDK version,
+- whether they used the hook or raw SSE.
+
+## Known limitations
+
+Run event streaming is intended for active runs. For old completed runs, prefer
+the snapshot API. Stream cursors are short-lived and tied to stream service
+implementation details.
+
+## Detailed lifecycle walkthrough
+
+The stream is easiest to reason about as a sequence of dashboard states.
+
+### Queued
+
+A queued run emits an event similar to:
+
++```json
+{
+  "kind": "TASK_RUN_QUEUED",
+  "startTime": "2026-05-16T10:00:01.000Z",
+  "runId": "run_123"
+}
++```
+
+The dashboard can show the run in the queue and display queue time.
+
+### Executing
+
+An executing run emits:
+
++```json
+{
+  "kind": "TASK_RUN_EXECUTING",
+  "startTime": "2026-05-16T10:00:02.000Z",
+  "runId": "run_123"
+}
++```
+
+The dashboard can switch from queue-time UI to live logs.
+
+### Terminal
+
+A successful run emits:
+
++```json
+{
+  "kind": "TASK_RUN_COMPLETED",
+  "startTime": "2026-05-16T10:00:04.000Z",
+  "runId": "run_123"
+}
++```
+
+A failed run emits:
+
++```json
+{
+  "kind": "TASK_RUN_FAILED",
+  "level": "ERROR",
+  "isError": true,
+  "startTime": "2026-05-16T10:00:04.000Z",
+  "runId": "run_123"
+}
++```
+
+The client can stop listening after a terminal event if it does not need late
+child-run metadata.
+
+## Stream timing examples
+
+The following examples use three events:
+
+| Event | Time | Shard |
+| --- | --- | --- |
+| queued | 10:00:01 | 0 |
+| executing | 10:00:02 | 1 |
+| completed | 10:00:03 | 2 |
+
+If shard 2 resolves first, the stream can emit:
+
++```txt
+id: cursor-shard-2
+event: run.event
+data: {"kind":"TASK_RUN_COMPLETED","startTime":"2026-05-16T10:00:03.000Z"}
+
+id: cursor-shard-0
+event: run.event
+data: {"kind":"TASK_RUN_QUEUED","startTime":"2026-05-16T10:00:01.000Z"}
+
+id: cursor-shard-1
+event: run.event
+data: {"kind":"TASK_RUN_EXECUTING","startTime":"2026-05-16T10:00:02.000Z"}
++```
+
+The React hook sorts this visually after each event arrives.
+
+## Reconnect timing examples
+
+Assume the client consumes this event:
+
++```txt
+id: shard-0-sequence-12
+event: run.event
+data: {"kind":"TASK_RUN_QUEUED","startTime":"2026-05-16T10:00:01.000Z"}
++```
+
+Then the network disconnects.
+
+During the disconnect, shard 1 writes:
+
++```txt
+event: run.event
+data: {"kind":"TASK_RUN_EXECUTING","startTime":"2026-05-16T10:00:02.000Z"}
++```
+
+Shard 2 writes:
+
++```txt
+event: run.event
+data: {"kind":"TASK_RUN_COMPLETED","startTime":"2026-05-16T10:00:03.000Z"}
++```
+
+The client reconnects with:
+
++```txt
+Last-Event-ID: shard-0-sequence-12
++```
+
+Shard 0 resumes from sequence 12. Shards 1 and 2 start at reconnect time.
+
+The reconnect stream can return no missed events.
+
+## Raw SSE parser guidance
+
+A raw SSE client should parse event boundaries by blank lines:
+
++```ts
+let buffer = "";
+
+for await (const chunk of response.body!) {
+  buffer += decoder.decode(chunk);
+  const frames = buffer.split("\n\n");
+  buffer = frames.pop() ?? "";
+
+  for (const frame of frames) {
+    const id = frame.split("\n").find((line) => line.startsWith("id:"));
+    const data = frame.split("\n").find((line) => line.startsWith("data:"));
+    if (!id || !data) continue;
+    lastEventId = id.slice(3).trim();
+    handle(JSON.parse(data.slice(5).trim()));
+  }
+}
++```
+
+The SDK helper implements a minimal parser for users who do not want to manage
+the response body directly.
+
+## Retry guidance
+
+A client may retry immediately for transient disconnects:
+
++```ts
+while (!signal.aborted) {
+  try {
+    for await (const event of runs.subscribeToRunEvents(runId, { lastEventId, signal })) {
+      lastEventId = event.cursor;
+      onEvent(event);
+    }
+  } catch (error) {
+    await sleep(500);
+  }
+}
++```
+
+The last event ID should be persisted in memory for the life of the page.
+
+## Dashboard state table
+
+| Stream event | Dashboard state | Notes |
+| --- | --- | --- |
+| `TASK_RUN_QUEUED` | Queued | Can display queue time |
+| `TASK_RUN_DEQUEUED` | Starting | Worker claimed the run |
+| `TASK_RUN_EXECUTING` | Running | Logs and spans should append |
+| `WAITPOINT_CREATED` | Waiting | Run is blocked on external state |
+| `WAITPOINT_COMPLETED` | Running | Wait resolved |
+| `TASK_RUN_COMPLETED` | Success | Terminal success |
+| `TASK_RUN_FAILED` | Failed | Terminal failure |
+| `TASK_RUN_CANCELED` | Canceled | Terminal cancellation |
+
+## API guarantees
+
+The endpoint guarantees:
+
+- authorized access to the requested run,
+- event payloads that match the prepared run event shape,
+- SSE framing compatible with browser and Node clients,
+- periodic pings,
+- best-effort replay for the shard represented by `Last-Event-ID`.
+
+The endpoint does not guarantee:
+
+- cross-shard transport ordering,
+- replay of shards not represented by `Last-Event-ID`,
+- durable storage of stream cursors,
+- compatibility of cursor internals across versions,
+- long-lived historical streaming for old runs.
+
+## Migration notes
+
+Existing dashboard code can keep using the snapshot API while adopting the
+stream endpoint. A safe migration path is:
+
+1. Fetch the snapshot events API on page load.
+2. Start the stream for live updates.
+3. Merge streamed events into the snapshot by event ID.
+4. Sort the combined array by event start time.
+5. Refetch the snapshot when the stream reports a terminal run event.
+
+The final refetch is recommended because shard timing can leave the stream with
+a partial view at the moment a terminal event arrives.
+
+## Monitoring
+
+Recommended service metrics:
+
+- open run event stream count,
+- reconnect count,
+- event count per stream,
+- empty reconnect count,
+- shard read latency,
+- shard read result count,
+- stream close reason,
+- stream wait timeout count.
+
+Recommended log fields:
+
++```json
+{
+  "runId": "run_123",
+  "traceId": "trace_123",
+  "environmentId": "env_123",
+  "lastEventId": "cursor",
+  "waitSeconds": 30,
+  "eventCount": 3
+}
++```
+
+## Testing advice
+
+Tests should cover:
+
+- ordered lifecycle events from one repository read,
+- shard reads resolving in every possible order,
+- reconnect after one shard advances,
+- reconnect after all shards advance,
+- duplicate replay,
+- missing event detection,
+- client abort,
+- pub/sub wakeups with no new repository events,
+- terminal events followed by late span/log events.
+
+The most important test is a disconnect gap:
+
++```txt
+T0 client receives queued on shard 0
+T1 client disconnects
+T2 executing is written on shard 1
+T3 completed is written on shard 2
+T4 client reconnects with shard 0 cursor
+T5 client should receive executing and completed
++```
+
+## Design alternatives
+
+### Single ordered stream
+
+Write every prepared run event with a monotonic per-run sequence number. Emit
+events ordered by sequence. Resume with `sequence > lastSequence`.
+
+### Event repository cursor
+
+Use `(startTime, eventId)` as the public cursor. Resume with events after that
+tuple, ordered by the same tuple.
+
+### Vector cursor
+
+Encode every shard position in the public cursor:
+
++```json
+{
+  "runId": "run_123",
+  "shards": {
+    "0": 12,
+    "1": 8,
+    "2": 3,
+    "3": 20
+  }
+}
++```
+
+This keeps sharding internal but makes reconnect replay complete.
+
+### Snapshot-plus-stream
+
+Use the stream only as a wakeup channel and require clients to fetch the
+snapshot API after every wakeup. This is simpler but loses the benefit of
+streaming individual events.
+
+## Reviewer questions
+
+When reviewing changes in this area, ask:
+
+- What is the public ordering contract?
+- What is the public cursor contract?
+- Does the cursor represent the whole stream or only an implementation detail?
+- Can one run emit terminal state before executing state?
+- Can the SDK distinguish an empty stream from skipped events?
+- What happens during a deploy, mobile sleep, or proxy reconnect?
+- Do tests reject impossible timelines?
+- Do docs describe a guarantee that the code actually provides?
+- Are dashboard and raw API consumers equally protected?
+- Can support reconstruct missing-event reports from logs?
```

## Intended Flaws

### Flaw 1: The stream shards reorder status events, so a single run timeline is not transport ordered

The shard reader splits one run's event stream across four logical shards using `spanId`, `message`, or `kind`. The stream service emits the flattened shard results in the order the shard reads return instead of merging by run timeline order or assigning a monotonic per-run sequence. This means lifecycle events for one run can arrive as `COMPLETED`, `QUEUED`, `EXECUTING` even though the event repository's snapshot API returns an ordered timeline.

Relevant line references:

- `apps/webapp/app/services/runEvents/runEventShardReader.server.ts:48-52` reads all shards independently and flattens the results.
- `apps/webapp/app/services/runEvents/runEventShardReader.server.ts:76-85` filters events by shard and assigns shard-local event IDs.
- `apps/webapp/app/services/runEvents/runEventShardReader.server.ts:119-126` derives the shard from per-event identity rather than the run.
- `apps/webapp/app/services/runEvents/runEventStream.server.ts:77-86` sends events in the order returned by the shard reader without an ordering merge.
- `apps/webapp/test/runEventStream.test.ts:84-159` normalizes the broken behavior by asserting that completed can be emitted before queued/executing.
- `docs/realtime/run-event-streaming.mdx:326-352` documents an out-of-order lifecycle stream as normal behavior.

Why this is a real flaw:

A run timeline is a state-machine surface, not a best-effort log fanout. Dashboards, SDK consumers, alerts, and debugging tools need to know whether a run was queued, executing, waiting, failed, or completed in the order those transitions happened. If the transport can reorder status events, clients can briefly or permanently render impossible histories, derive wrong durations, fire terminal-state side effects early, or hide the span that explains a failure.

Better implementation direction:

For a single run stream, preserve per-run ordering at the server boundary. Read from the authoritative event repository ordered by event time plus deterministic tie-breaker, or assign a monotonic per-run event sequence at write time. If fanout is necessary internally, merge shards before emitting and only advance the public cursor after ordered emission. Do not push ordering repair to every client.

### Flaw 2: Reconnect starts non-matching shards at server time instead of replaying from the last event cursor, so missed events disappear

The route accepts `Last-Event-ID`, but the cursor helper only reuses it for the exact shard encoded in the cursor. All other shards create a fresh cursor with `emittedAt: new Date().toISOString()`. On reconnect, any events written to other shards while the client was disconnected are skipped because their `startTime` is earlier than the new server-time cursor.

Relevant line references:

- `apps/webapp/app/routes/api.v1.runs.$runId.events.stream.ts:65-80` accepts `Last-Event-ID` and passes one cursor into the stream service.
- `apps/webapp/app/services/runEvents/runEventCursor.server.ts:29-45` discards valid cursors for non-matching shards and starts from current server time.
- `apps/webapp/app/services/runEvents/runEventShardReader.server.ts:55-70` uses the cursor date as the lower bound for repository reads.
- `apps/webapp/test/runEventStream.test.ts:176-191` asserts that other shards start at server time on reconnect.
- `docs/realtime/run-event-streaming.mdx:82-86` and `docs/realtime/run-event-streaming.mdx:354-388` document that other shards skip replay to avoid old data.

Why this is a real flaw:

SSE `Last-Event-ID` is an at-least-once resume contract. A mobile browser, corporate proxy, or server deploy can disconnect a client for a few seconds while the run continues. If reconnect starts at server time, events produced during that gap vanish. The dashboard might miss the failure log, the SDK might never see `TASK_RUN_FAILED`, and the client has no way to distinguish "no event happened" from "the stream skipped the event."

Better implementation direction:

Make the public cursor represent a single ordered run stream, not a shard-local transport detail. Store or derive a monotonic per-run event sequence and replay `sequence > lastSequence` on reconnect. If the implementation keeps shard-local cursors internally, encode a vector cursor containing every shard position and replay from the minimum safe event boundary. Never use current server time as the replay boundary for a client-provided cursor.

## Hints

### Flaw 1 Hints

1. Does the stream emit one run's events in the same order as the snapshot run events API?
2. What happens if `TASK_RUN_COMPLETED` and `TASK_RUN_EXECUTING` hash to different shards?
3. Should every client be responsible for repairing lifecycle ordering, or should the server stream have an ordered contract?

### Flaw 2 Hints

1. What does `Last-Event-ID` normally promise for an SSE stream?
2. What timestamp does a non-matching shard use when reconnecting with a cursor from another shard?
3. What happens to events created during the disconnect gap but before the reconnect request time?

## Expected Answer

A strong review should say that the product-level change is live run-event streaming for dashboards and API clients, but the implementation breaks two core stream contracts: per-run order and replay after reconnect.

For flaw 1, the learner should identify that a single run's lifecycle events are split across shards and emitted without a global per-run merge or sequence. The impact is impossible timelines and early terminal-state behavior. The fix is server-owned per-run ordering: an ordered repository read, a monotonic sequence, or a shard merge before SSE emission.

For flaw 2, the learner should identify that `Last-Event-ID` only resumes one shard and all other shards start at current server time. The impact is missing events during reconnect gaps. The fix is a public cursor that represents the whole ordered run stream, or a vector cursor that safely resumes every shard.

The best answers should connect the flaws to Trigger.dev's existing contracts: the snapshot event API is timeline-oriented, ClickHouse `getRunEvents` orders by `start_time ASC`, existing realtime stream code uses `Last-Event-ID` for resume, and SDK/dashboard subscribers should not need to infer whether a missing event is a transport loss or a real absence.

## Expert Debrief

At the product level, this PR tries to remove polling from live run timelines. That is a good direction. The dangerous part is that "streaming" is not just "send whatever events arrive." A run timeline is a state machine with causal order.

The first contract is ordering. Trigger.dev run events are used to understand how a run moved through queued, dequeued, executing, waiting, retrying, and terminal states. If one stream for one run can send terminal events before earlier lifecycle events, the API has delegated core correctness to clients. Sorting in the React hook does not fix raw API consumers, SDK consumers, alerting systems, or any side effect that happens while consuming the stream.

The second contract is replay. `Last-Event-ID` exists so clients can resume without missing records. A cursor that only applies to one internal shard is not a safe public cursor. Starting other shards at `new Date()` is especially risky because it creates silent loss exactly during the outage window where replay matters most.

The failure modes are concrete:

- The dashboard briefly shows a run as completed before it shows the executing span that produced the output.
- A client stops reading on the first terminal event and never processes the failure log that arrives later from another shard.
- A reconnect after a deploy misses `TASK_RUN_FAILED` because the failure event landed on a shard different from the last cursor shard.
- The SDK returns a valid async iterator with no error, so the application assumes no events were missed.
- Support cannot reconstruct whether a missing timeline row is an event-store issue or a stream cursor issue.

The reviewer thought process should be: identify the public contract first. For a run timeline, the public contract is ordered, per-run, replayable events. Then inspect where order is created, where it can be broken, and where cursors cross a reconnect boundary. Finally, compare tests against real failure modes: the tests should simulate out-of-order shard completion and disconnect gaps, but they should reject those outcomes rather than bless them.

The better implementation is to make the stream cursor a domain cursor, not a transport cursor. Assign a per-run sequence when events are written, or derive a stable `(startTime, eventId)` cursor from the ordered event repository. Emit events in that order, and on reconnect replay after the last emitted domain cursor. Internal sharding can still exist, but it must be hidden behind an ordered stream boundary.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: shard-local emission can reorder one run's status/timeline events, and reconnect resumes only one shard while starting other shards at server time. It explains impossible timelines, premature terminal handling, missed events during disconnects, and suggests a monotonic per-run sequence or ordered replay cursor.
- `partial`: The answer finds one flaw completely and mentions either generic SSE fragility or generic sorting concerns without tying them to run lifecycle order and `Last-Event-ID` replay.
- `miss`: The answer focuses on hook naming, docs wording, endpoint naming, or generic SSE boilerplate while missing stream ordering and reconnect loss.
