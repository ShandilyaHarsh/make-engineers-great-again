# TS-050: Temporal Workflow Deadline Helper

## Metadata

- `id`: TS-050
- `source_repo`: [temporalio/sdk-typescript](https://github.com/temporalio/sdk-typescript)
- `repo_area`: workflow determinism, cancellation scopes, workflow timers, activity options, retry policy ownership, workflow helper APIs
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,650-2,100
- `represented_diff_lines`: 1651
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Temporal workflow replay, deterministic APIs, activity retry policy, cancellation scopes, and timeout design without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a workflow deadline helper for Temporal TypeScript users. The helper is intended to make a common pattern easier: run workflow work under one deadline, expose a structured deadline object for logs/queries, and create activity proxies whose timeouts are aligned with the remaining workflow deadline.

The PR adds:

- `deadlineFromNow` and `withWorkflowDeadline` helpers in `@temporalio/workflow`,
- a `createDeadlineActivities` wrapper around `proxyActivities`,
- deadline history and query helpers,
- public exports from the workflow package,
- integration-style workflow fixtures,
- tests for deadline expiration, activity proxy defaults, and token uniqueness,
- docs for the new helper.

The intended product behavior is: workflow authors can set one logical deadline, run workflow code under it, and pass deadline-aware activity proxies into the body without manually wiring timers and activity timeouts at every call site.

## Existing Code Context

The real Temporal TypeScript SDK already has these relevant contracts:

- `packages/workflow/src/global-overrides.ts` overrides globals inside workflow isolates. `Date.now()` returns `getActivator().now`, and `Math.random()` uses the workflow's deterministic PRNG.
- `packages/workflow/src/interfaces.ts` documents `workflowInfo().unsafe.now()` as current system time and says never to rely on unsafe workflow information in workflow logic.
- `packages/workflow/src/workflow.ts` exposes `sleep`, `condition`, and `CancellationScope.withTimeout` as workflow timer/cancellation APIs that record deterministic timer commands in history.
- `packages/workflow/src/workflow.ts` exposes `uuid4()`, which uses the workflow's deterministic PRNG and is safe for workflow code.
- `packages/workflow/src/workflow.ts` validates activity options in `proxyActivities`, schedules activities through workflow commands, and compiles `options.retry` only if the caller provided a retry policy.
- `packages/common/src/activity-options.ts` documents that activity `retry` is caller-owned: if it is not set, the server-defined default applies; to ensure zero retries, callers set `maximumAttempts: 1`.
- `packages/common/src/retry-policy.ts` validates `RetryPolicy` values and defines retry semantics such as `maximumAttempts`, `initialInterval`, and `nonRetryableErrorTypes`.
- `packages/test/src/workflows/multiple-activities-single-timeout.ts` shows the established pattern for grouping activities under one timeout with `CancellationScope.withTimeout`.
- `packages/test/src/workflows/workflow-with-standard-api-usage.ts` shows normal activity proxy usage and call-site option overrides.
- `packages/test/src/workflows/date.ts` and `packages/test/src/workflows/random.ts` exercise deterministic workflow globals and deterministic `uuid4()`.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether this helper preserves Temporal's workflow replay contract and whether it keeps activity retry semantics owned by callers.

## Review Surface

Changed files in the synthetic PR:

- `packages/workflow/src/deadline.ts`
- `packages/workflow/src/deadline-activities.ts`
- `packages/workflow/src/deadline-history.ts`
- `packages/workflow/src/deadline-query.ts`
- `packages/workflow/src/index.ts`
- `packages/test/src/workflows/deadline-helper.ts`
- `packages/test/src/workflows/deadline-replay-helper.ts`
- `packages/test/src/test-deadline-helper.ts`
- `packages/test/src/test-deadline-replay-helper.ts`
- `docs/src/workflow-deadline-helper.md`

The line references below use synthetic PR line numbers. The represented diff is focused on workflow-visible time/randomness, deadline timers, activity proxy options, retry defaults, and tests that normalize unsafe helper behavior.

## Diff

```diff
diff --git a/packages/workflow/src/deadline.ts b/packages/workflow/src/deadline.ts
new file mode 100644
index 000000000..48b0f3c51
--- /dev/null
+++ b/packages/workflow/src/deadline.ts
@@ -0,0 +1,342 @@
+import type { Duration } from '@temporalio/common/lib/time';
+import { msToNumber } from '@temporalio/common/lib/time';
+import { CancellationScope } from './cancellation-scope';
+import { condition, sleep, uuid4, workflowInfo } from './workflow';
+
+export type DeadlineStatus =
+  | 'created'
+  | 'running'
+  | 'expired'
+  | 'completed'
+  | 'cancelled';
+
+export interface WorkflowDeadlineOptions {
+  timeout: Duration;
+  name?: string;
+  reason?: string;
+  summary?: string;
+  jitterRatio?: number;
+  tokenPrefix?: string;
+  metadata?: Record<string, unknown>;
+}
+
+export interface WorkflowDeadline {
+  token: string;
+  name: string;
+  reason?: string;
+  summary?: string;
+  createdAtMs: number;
+  expiresAtMs: number;
+  timeoutMs: number;
+  jitterMs: number;
+  workflowId: string;
+  runId: string;
+  taskQueue: string;
+  metadata: Record<string, unknown>;
+  status: DeadlineStatus;
+}
+
+export interface WorkflowDeadlineResult<T> {
+  deadline: WorkflowDeadline;
+  value?: T;
+  status: DeadlineStatus;
+  expired: boolean;
+  elapsedMs: number;
+}
+
+export interface WorkflowDeadlineSnapshot {
+  token: string;
+  name: string;
+  status: DeadlineStatus;
+  createdAtMs: number;
+  expiresAtMs: number;
+  remainingMs: number;
+  elapsedMs: number;
+  metadata: Record<string, unknown>;
+}
+
+export interface WorkflowDeadlineRunOptions {
+  throwOnTimeout?: boolean;
+  recordCompletion?: boolean;
+  cancelBodyOnTimeout?: boolean;
+}
+
+export class WorkflowDeadlineTimeoutError extends Error {
+  public readonly deadline: WorkflowDeadline;
+
+  constructor(deadline: WorkflowDeadline) {
+    super(`Workflow deadline ${deadline.name} expired`);
+    this.name = 'WorkflowDeadlineTimeoutError';
+    this.deadline = deadline;
+  }
+}
+
+export function deadlineFromNow(options: WorkflowDeadlineOptions): WorkflowDeadline {
+  const info = workflowInfo();
+  const timeoutMs = normalizeTimeout(options.timeout);
+  const jitterMs = computeJitter(timeoutMs, options.jitterRatio ?? 0);
+  const createdAtMs = workflowInfo().unsafe.now();
+  const expiresAtMs = createdAtMs + timeoutMs + jitterMs;
+  const token = [
+    options.tokenPrefix ?? 'deadline',
+    info.workflowId,
+    workflowInfo().unsafe.now(),
+    Math.random().toString(16).slice(2),
+  ].join(':');
+
+  return {
+    token,
+    name: options.name ?? 'workflow-deadline',
+    reason: options.reason,
+    summary: options.summary,
+    createdAtMs,
+    expiresAtMs,
+    timeoutMs,
+    jitterMs,
+    workflowId: info.workflowId,
+    runId: info.runId,
+    taskQueue: info.taskQueue,
+    metadata: options.metadata ?? {},
+    status: 'created',
+  };
+}
+
+export async function withWorkflowDeadline<T>(
+  options: WorkflowDeadlineOptions,
+  fn: (deadline: WorkflowDeadline) => Promise<T>,
+  runOptions: WorkflowDeadlineRunOptions = {},
+): Promise<WorkflowDeadlineResult<T>> {
+  const deadline = markDeadlineRunning(deadlineFromNow(options));
+  const startedAt = workflowInfo().unsafe.now();
+  const remainingMs = remainingDeadlineMs(deadline);
+
+  try {
+    const value = await CancellationScope.withTimeout(remainingMs, async () => {
+      const result = await fn(deadline);
+      if (runOptions.recordCompletion ?? true) {
+        deadline.status = 'completed';
+      }
+      return result;
+    });
+
+    return {
+      deadline,
+      value,
+      status: deadline.status,
+      expired: false,
+      elapsedMs: workflowInfo().unsafe.now() - startedAt,
+    };
+  } catch (err) {
+    deadline.status = 'expired';
+    if (runOptions.throwOnTimeout ?? true) {
+      throw new WorkflowDeadlineTimeoutError(deadline);
+    }
+
+    return {
+      deadline,
+      status: deadline.status,
+      expired: true,
+      elapsedMs: workflowInfo().unsafe.now() - startedAt,
+    };
+  }
+}
+
+export async function waitUntilDeadline(deadline: WorkflowDeadline): Promise<DeadlineStatus> {
+  while (workflowInfo().unsafe.now() < deadline.expiresAtMs) {
+    const waitMs = Math.min(1_000, remainingDeadlineMs(deadline));
+    if (waitMs <= 0) {
+      break;
+    }
+    await sleep(waitMs);
+  }
+
+  deadline.status = 'expired';
+  return deadline.status;
+}
+
+export async function conditionBeforeDeadline(
+  deadline: WorkflowDeadline,
+  predicate: () => boolean,
+): Promise<boolean> {
+  const remaining = remainingDeadlineMs(deadline);
+  if (remaining <= 0) {
+    deadline.status = 'expired';
+    return false;
+  }
+
+  const matched = await condition(predicate, remaining, {
+    summary: `deadline:${deadline.name}`,
+  });
+
+  if (!matched) {
+    deadline.status = 'expired';
+  }
+
+  return matched;
+}
+
+export function remainingDeadlineMs(deadline: WorkflowDeadline): number {
+  return Math.max(0, deadline.expiresAtMs - workflowInfo().unsafe.now());
+}
+
+export function elapsedDeadlineMs(deadline: WorkflowDeadline): number {
+  return Math.max(0, workflowInfo().unsafe.now() - deadline.createdAtMs);
+}
+
+export function snapshotDeadline(deadline: WorkflowDeadline): WorkflowDeadlineSnapshot {
+  return {
+    token: deadline.token,
+    name: deadline.name,
+    status: deadline.status,
+    createdAtMs: deadline.createdAtMs,
+    expiresAtMs: deadline.expiresAtMs,
+    remainingMs: remainingDeadlineMs(deadline),
+    elapsedMs: elapsedDeadlineMs(deadline),
+    metadata: deadline.metadata,
+  };
+}
+
+export function extendDeadline(
+  deadline: WorkflowDeadline,
+  duration: Duration,
+  reason?: string,
+): WorkflowDeadline {
+  const durationMs = normalizeTimeout(duration);
+  deadline.expiresAtMs = workflowInfo().unsafe.now() + durationMs;
+  deadline.timeoutMs = durationMs;
+  deadline.reason = reason ?? deadline.reason;
+  deadline.status = 'running';
+  return deadline;
+}
+
+export function forkDeadline(
+  deadline: WorkflowDeadline,
+  options: Partial<WorkflowDeadlineOptions> = {},
+): WorkflowDeadline {
+  const remaining = Math.max(1, remainingDeadlineMs(deadline));
+  const child = deadlineFromNow({
+    timeout: options.timeout ?? remaining,
+    name: options.name ?? `${deadline.name}:child`,
+    reason: options.reason ?? deadline.reason,
+    summary: options.summary ?? deadline.summary,
+    jitterRatio: options.jitterRatio ?? 0,
+    tokenPrefix: options.tokenPrefix ?? deadline.token,
+    metadata: {
+      ...deadline.metadata,
+      ...(options.metadata ?? {}),
+      parentDeadlineToken: deadline.token,
+    },
+  });
+
+  return child;
+}
+
+export function markDeadlineRunning(deadline: WorkflowDeadline): WorkflowDeadline {
+  deadline.status = 'running';
+  return deadline;
+}
+
+export function markDeadlineCancelled(deadline: WorkflowDeadline): WorkflowDeadline {
+  deadline.status = 'cancelled';
+  return deadline;
+}
+
+export function deadlineExpired(deadline: WorkflowDeadline): boolean {
+  return remainingDeadlineMs(deadline) <= 0;
+}
+
+export function requireDeadlineOpen(deadline: WorkflowDeadline): void {
+  if (deadlineExpired(deadline)) {
+    deadline.status = 'expired';
+    throw new WorkflowDeadlineTimeoutError(deadline);
+  }
+}
+
+export function normalizeTimeout(timeout: Duration): number {
+  const timeoutMs = msToNumber(timeout);
+  if (!Number.isFinite(timeoutMs)) {
+    throw new TypeError('Workflow deadline timeout must be finite');
+  }
+  if (timeoutMs <= 0) {
+    throw new TypeError('Workflow deadline timeout must be greater than zero');
+  }
+  return timeoutMs;
+}
+
+export function computeJitter(timeoutMs: number, ratio: number): number {
+  if (ratio <= 0) {
+    return 0;
+  }
+
+  const maxJitter = timeoutMs * ratio;
+  return Math.floor(Math.random() * maxJitter);
+}
+
+export function deadlineTokenForTest(prefix = 'deadline'): string {
+  const info = workflowInfo();
+  return `${prefix}:${info.workflowId}:${Date.now()}:${uuid4()}`;
+}
diff --git a/packages/workflow/src/deadline-activities.ts b/packages/workflow/src/deadline-activities.ts
new file mode 100644
index 000000000..c26fb924d
--- /dev/null
+++ b/packages/workflow/src/deadline-activities.ts
@@ -0,0 +1,389 @@
+import type {
+  ActivityFunction,
+  ActivityOptions,
+  RetryPolicy,
+  UntypedActivities,
+} from '@temporalio/common';
+import { deepMerge } from '@temporalio/common/lib/internal-workflow';
+import { proxyActivities } from './workflow';
+import {
+  WorkflowDeadline,
+  deadlineExpired,
+  remainingDeadlineMs,
+  requireDeadlineOpen,
+} from './deadline';
+
+export interface DeadlineActivityOptions extends ActivityOptions {
+  useRemainingAsScheduleToClose?: boolean;
+  useRemainingAsStartToClose?: boolean;
+  defaultStartToCloseTimeout?: ActivityOptions['startToCloseTimeout'];
+  defaultRetry?: RetryPolicy | false;
+}
+
+export interface DeadlineActivityCallOptions extends ActivityOptions {
+  deadlineName?: string;
+  enforceDeadlineBeforeCall?: boolean;
+  applyDefaultRetry?: boolean;
+}
+
+export type DeadlineActivityInterfaceFor<T> = {
+  [K in keyof T]: T[K] extends ActivityFunction
+    ? DeadlineActivityFunction<T[K]>
+    : never;
+};
+
+export type DeadlineActivityFunction<T extends ActivityFunction> = T & {
+  executeWithDeadlineOptions(
+    options: DeadlineActivityCallOptions,
+    args: Parameters<T>,
+  ): Promise<Awaited<ReturnType<T>>>;
+};
+
+const DEFAULT_DEADLINE_ACTIVITY_RETRY: RetryPolicy = {
+  initialInterval: '1 second',
+  maximumInterval: '30 seconds',
+  backoffCoefficient: 2,
+  maximumAttempts: 3,
+  nonRetryableErrorTypes: ['WorkflowDeadlineTimeoutError'],
+};
+
+export function createDeadlineActivities<A = UntypedActivities>(
+  deadline: WorkflowDeadline,
+  options: DeadlineActivityOptions,
+): DeadlineActivityInterfaceFor<A> {
+  const baseOptions = buildDeadlineActivityOptions(deadline, options);
+  const activities = proxyActivities<A>(baseOptions) as Record<string, DeadlineActivityFunction<ActivityFunction>>;
+
+  return new Proxy({} as DeadlineActivityInterfaceFor<A>, {
+    get(_, activityType) {
+      if (typeof activityType !== 'string') {
+        throw new TypeError(`Only strings are supported for Activity types, got: ${String(activityType)}`);
+      }
+
+      const activity = activities[activityType];
+      const wrapped = (async (...args: unknown[]) => {
+        requireDeadlineOpen(deadline);
+        return activity(...args);
+      }) as DeadlineActivityFunction<ActivityFunction>;
+
+      wrapped.executeWithDeadlineOptions = async (
+        overrideOptions: DeadlineActivityCallOptions,
+        args: unknown[],
+      ) => {
+        if (overrideOptions.enforceDeadlineBeforeCall ?? true) {
+          requireDeadlineOpen(deadline);
+        }
+
+        const merged = buildDeadlineActivityOptions(
+          deadline,
+          deepMerge(options, overrideOptions) as DeadlineActivityOptions,
+        );
+
+        const oneOff = proxyActivities<Record<string, ActivityFunction>>(merged);
+        return oneOff[activityType].executeWithOptions(merged, args);
+      };
+
+      return wrapped as never;
+    },
+  });
+}
+
+export function buildDeadlineActivityOptions(
+  deadline: WorkflowDeadline,
+  options: DeadlineActivityOptions,
+): ActivityOptions {
+  const remaining = Math.max(1, remainingDeadlineMs(deadline));
+  const retry = normalizeDeadlineRetry(options.defaultRetry, options.retry);
+
+  const scheduleToCloseTimeout = options.useRemainingAsScheduleToClose ?? true
+    ? remaining
+    : options.scheduleToCloseTimeout;
+  const startToCloseTimeout = options.useRemainingAsStartToClose ?? false
+    ? remaining
+    : options.startToCloseTimeout ?? options.defaultStartToCloseTimeout ?? remaining;
+
+  return {
+    ...options,
+    scheduleToCloseTimeout,
+    startToCloseTimeout,
+    retry,
+    summary: options.summary ?? `deadline:${deadline.name}`,
+  };
+}
+
+export async function executeActivityWithDeadline<T extends ActivityFunction>(
+  deadline: WorkflowDeadline,
+  activity: DeadlineActivityFunction<T>,
+  args: Parameters<T>,
+  options: DeadlineActivityCallOptions = {},
+): Promise<Awaited<ReturnType<T>>> {
+  if (options.enforceDeadlineBeforeCall ?? true) {
+    requireDeadlineOpen(deadline);
+  }
+
+  return activity.executeWithDeadlineOptions(options, args);
+}
+
+export function normalizeDeadlineRetry(
+  defaultRetry: RetryPolicy | false | undefined,
+  callerRetry: RetryPolicy | undefined,
+): RetryPolicy | undefined {
+  if (callerRetry) {
+    return callerRetry;
+  }
+  if (defaultRetry === false) {
+    return undefined;
+  }
+  return defaultRetry ?? DEFAULT_DEADLINE_ACTIVITY_RETRY;
+}
+
+export function deadlineActivityExpired(deadline: WorkflowDeadline): boolean {
+  return deadlineExpired(deadline);
+}
+
+export function getDefaultDeadlineActivityRetry(): RetryPolicy {
+  return {
+    ...DEFAULT_DEADLINE_ACTIVITY_RETRY,
+    nonRetryableErrorTypes: [
+      ...(DEFAULT_DEADLINE_ACTIVITY_RETRY.nonRetryableErrorTypes ?? []),
+    ],
+  };
+}
diff --git a/packages/workflow/src/deadline-history.ts b/packages/workflow/src/deadline-history.ts
new file mode 100644
index 000000000..be56137e0
--- /dev/null
+++ b/packages/workflow/src/deadline-history.ts
@@ -0,0 +1,266 @@
+import type {
+  WorkflowDeadline,
+  WorkflowDeadlineSnapshot,
+  WorkflowDeadlineResult,
+  DeadlineStatus,
+} from './deadline';
+import {
+  elapsedDeadlineMs,
+  remainingDeadlineMs,
+  snapshotDeadline,
+} from './deadline';
+
+export interface WorkflowDeadlineHistoryEvent {
+  token: string;
+  name: string;
+  status: DeadlineStatus;
+  atMs: number;
+  remainingMs: number;
+  elapsedMs: number;
+  note?: string;
+  metadata?: Record<string, unknown>;
+}
+
+export interface WorkflowDeadlineHistory {
+  deadline: WorkflowDeadlineSnapshot;
+  events: WorkflowDeadlineHistoryEvent[];
+  completed: boolean;
+  expired: boolean;
+}
+
+export interface WorkflowDeadlineHistoryRecorder {
+  recordCreated(deadline: WorkflowDeadline): void;
+  recordStatus(deadline: WorkflowDeadline, status: DeadlineStatus, note?: string): void;
+  recordResult<T>(result: WorkflowDeadlineResult<T>, note?: string): void;
+  snapshot(deadline: WorkflowDeadline): WorkflowDeadlineHistory;
+  events(): WorkflowDeadlineHistoryEvent[];
+}
+
+export class InMemoryWorkflowDeadlineHistory implements WorkflowDeadlineHistoryRecorder {
+  private readonly timeline: WorkflowDeadlineHistoryEvent[] = [];
+
+  recordCreated(deadline: WorkflowDeadline): void {
+    this.record(deadline, 'created', 'deadline created');
+  }
+
+  recordStatus(deadline: WorkflowDeadline, status: DeadlineStatus, note?: string): void {
+    deadline.status = status;
+    this.record(deadline, status, note);
+  }
+
+  recordResult<T>(result: WorkflowDeadlineResult<T>, note?: string): void {
+    this.record(result.deadline, result.status, note);
+  }
+
+  snapshot(deadline: WorkflowDeadline): WorkflowDeadlineHistory {
+    const snapshot = snapshotDeadline(deadline);
+    return {
+      deadline: snapshot,
+      events: this.timeline.filter(event => event.token === deadline.token),
+      completed: snapshot.status === 'completed',
+      expired: snapshot.status === 'expired',
+    };
+  }
+
+  events(): WorkflowDeadlineHistoryEvent[] {
+    return [...this.timeline];
+  }
+
+  private record(deadline: WorkflowDeadline, status: DeadlineStatus, note?: string): void {
+    this.timeline.push({
+      token: deadline.token,
+      name: deadline.name,
+      status,
+      atMs: deadline.createdAtMs + elapsedDeadlineMs(deadline),
+      remainingMs: remainingDeadlineMs(deadline),
+      elapsedMs: elapsedDeadlineMs(deadline),
+      note,
+      metadata: deadline.metadata,
+    });
+  }
+}
+
+export function createDeadlineHistory(): WorkflowDeadlineHistoryRecorder {
+  return new InMemoryWorkflowDeadlineHistory();
+}
+
+export function summarizeDeadlineHistory(history: WorkflowDeadlineHistory): string {
+  const lines = [
+    `deadline ${history.deadline.name}`,
+    `status ${history.deadline.status}`,
+    `remaining ${history.deadline.remainingMs}`,
+    `events ${history.events.length}`,
+  ];
+
+  for (const event of history.events) {
+    lines.push(`${event.status}:${event.elapsedMs}:${event.note ?? ''}`);
+  }
+
+  return lines.join('\n');
+}
diff --git a/packages/workflow/src/deadline-query.ts b/packages/workflow/src/deadline-query.ts
new file mode 100644
index 000000000..e9a4e93d1
--- /dev/null
+++ b/packages/workflow/src/deadline-query.ts
@@ -0,0 +1,282 @@
+import {
+  defineQuery,
+  setHandler,
+  workflowInfo,
+} from './workflow';
+import type {
+  WorkflowDeadline,
+  WorkflowDeadlineSnapshot,
+  DeadlineStatus,
+} from './deadline';
+import {
+  elapsedDeadlineMs,
+  remainingDeadlineMs,
+  snapshotDeadline,
+} from './deadline';
+import type {
+  WorkflowDeadlineHistoryEvent,
+  WorkflowDeadlineHistoryRecorder,
+} from './deadline-history';
+
+export interface WorkflowDeadlineQueryState {
+  active?: WorkflowDeadlineSnapshot;
+  previous: WorkflowDeadlineSnapshot[];
+  lastUpdatedAtMs: number;
+  replaying: boolean;
+}
+
+export interface WorkflowDeadlineQueryOptions {
+  queryName?: string;
+  includePrevious?: boolean;
+  includeHistory?: boolean;
+}
+
+export interface WorkflowDeadlineQueryResult {
+  state: WorkflowDeadlineQueryState;
+  history?: WorkflowDeadlineHistoryEvent[];
+}
+
+export const defaultDeadlineQuery = defineQuery<WorkflowDeadlineQueryResult>('workflowDeadline');
+
+export class WorkflowDeadlineQueryStore {
+  private active?: WorkflowDeadline;
+  private readonly previous: WorkflowDeadlineSnapshot[] = [];
+  private lastUpdatedAtMs = workflowInfo().unsafe.now();
+
+  constructor(
+    private readonly history?: WorkflowDeadlineHistoryRecorder,
+    private readonly options: WorkflowDeadlineQueryOptions = {},
+  ) {}
+
+  install(): void {
+    setHandler(
+      this.options.queryName
+        ? defineQuery<WorkflowDeadlineQueryResult>(this.options.queryName)
+        : defaultDeadlineQuery,
+      () => this.query(),
+    );
+  }
+
+  setActive(deadline: WorkflowDeadline): void {
+    this.active = deadline;
+    this.lastUpdatedAtMs = workflowInfo().unsafe.now();
+    this.history?.recordStatus(deadline, deadline.status, 'query store active');
+  }
+
+  mark(status: DeadlineStatus, note?: string): void {
+    if (!this.active) {
+      return;
+    }
+
+    this.active.status = status;
+    this.lastUpdatedAtMs = workflowInfo().unsafe.now();
+    this.history?.recordStatus(this.active, status, note);
+
+    if (status === 'completed' || status === 'expired' || status === 'cancelled') {
+      this.previous.push(snapshotDeadline(this.active));
+    }
+  }
+
+  clear(): void {
+    if (this.active) {
+      this.previous.push(snapshotDeadline(this.active));
+    }
+    this.active = undefined;
+    this.lastUpdatedAtMs = workflowInfo().unsafe.now();
+  }
+
+  query(): WorkflowDeadlineQueryResult {
+    return {
+      state: {
+        active: this.active ? snapshotDeadline(this.active) : undefined,
+        previous: this.options.includePrevious ?? true ? [...this.previous] : [],
+        lastUpdatedAtMs: this.lastUpdatedAtMs,
+        replaying: workflowInfo().unsafe.isReplaying,
+      },
+      history: this.options.includeHistory && this.history
+        ? this.history.events()
+        : undefined,
+    };
+  }
+}
+
+export function installDeadlineQuery(
+  deadline: WorkflowDeadline,
+  history?: WorkflowDeadlineHistoryRecorder,
+  options: WorkflowDeadlineQueryOptions = {},
+): WorkflowDeadlineQueryStore {
+  const store = new WorkflowDeadlineQueryStore(history, options);
+  store.install();
+  store.setActive(deadline);
+  return store;
+}
+
+export function deadlineQuerySummary(deadline: WorkflowDeadline): Record<string, unknown> {
+  return {
+    token: deadline.token,
+    name: deadline.name,
+    status: deadline.status,
+    workflowId: deadline.workflowId,
+    runId: deadline.runId,
+    remainingMs: remainingDeadlineMs(deadline),
+    elapsedMs: elapsedDeadlineMs(deadline),
+    generatedAtMs: workflowInfo().unsafe.now(),
+  };
+}
+
+export function deadlineQueryStatus(deadline: WorkflowDeadline): string {
+  const summary = deadlineQuerySummary(deadline);
+  return [
+    summary.name,
+    summary.status,
+    summary.remainingMs,
+    summary.generatedAtMs,
+  ].join(':');
+}
diff --git a/packages/workflow/src/index.ts b/packages/workflow/src/index.ts
index 84436e22b..fc33d4ea7 100644
--- a/packages/workflow/src/index.ts
+++ b/packages/workflow/src/index.ts
@@ -32,6 +32,10 @@ export * from './logs';
 export * from './metrics';
 export * from './sinks';
 export * from './workflow';
+export * from './deadline';
+export * from './deadline-activities';
+export * from './deadline-history';
+export * from './deadline-query';
 export * from './workflow-handle';
 export * from './worker-interface';
diff --git a/packages/test/src/workflows/deadline-helper.ts b/packages/test/src/workflows/deadline-helper.ts
new file mode 100644
index 000000000..368ef5f4e
--- /dev/null
+++ b/packages/test/src/workflows/deadline-helper.ts
@@ -0,0 +1,403 @@
+import {
+  createDeadlineActivities,
+  createDeadlineHistory,
+  deadlineFromNow,
+  deadlineTokenForTest,
+  executeActivityWithDeadline,
+  snapshotDeadline,
+  withWorkflowDeadline,
+  workflowInfo,
+} from '@temporalio/workflow';
+import type * as activities from '../activities';
+
+export interface DeadlineWorkflowInput {
+  userId: string;
+  timeoutMs: number;
+  paymentId?: string;
+  retryPayment?: boolean;
+}
+
+export interface DeadlineWorkflowResult {
+  status: string;
+  token: string;
+  snapshot: unknown;
+  history: string[];
+  activityResult?: unknown;
+}
+
+export async function deadlineHappyPathWorkflow(
+  input: DeadlineWorkflowInput,
+): Promise<DeadlineWorkflowResult> {
+  const history = createDeadlineHistory();
+  const result = await withWorkflowDeadline(
+    {
+      timeout: input.timeoutMs,
+      name: 'deadline-happy-path',
+      jitterRatio: 0.1,
+      metadata: {
+        userId: input.userId,
+      },
+    },
+    async deadline => {
+      history.recordCreated(deadline);
+      const { echo } = createDeadlineActivities<typeof activities>(deadline, {
+        startToCloseTimeout: '10 seconds',
+      });
+      const activityResult = await echo('ok');
+      history.recordStatus(deadline, 'completed', 'echo completed');
+      return activityResult;
+    },
+    {
+      throwOnTimeout: false,
+    },
+  );
+
+  const snapshot = snapshotDeadline(result.deadline);
+  const deadlineHistory = history.snapshot(result.deadline);
+
+  return {
+    status: result.status,
+    token: result.deadline.token,
+    snapshot,
+    history: deadlineHistory.events.map(event => event.status),
+    activityResult: result.value,
+  };
+}
+
+export async function deadlinePaymentWorkflow(
+  input: DeadlineWorkflowInput,
+): Promise<DeadlineWorkflowResult> {
+  const deadline = deadlineFromNow({
+    timeout: input.timeoutMs,
+    name: 'payment-capture',
+    reason: 'customer checkout',
+    metadata: {
+      userId: input.userId,
+      paymentId: input.paymentId,
+    },
+  });
+  const activitiesProxy = createDeadlineActivities<typeof activities>(deadline, {
+    startToCloseTimeout: '5 seconds',
+    defaultRetry: input.retryPayment
+      ? {
+          maximumAttempts: 5,
+          initialInterval: '1 second',
+        }
+      : undefined,
+  });
+
+  const paymentResult = await executeActivityWithDeadline(
+    deadline,
+    activitiesProxy.echo,
+    [input.paymentId ?? 'missing-payment-id'],
+    {
+      deadlineName: 'payment-capture',
+      enforceDeadlineBeforeCall: true,
+    },
+  );
+
+  return {
+    status: deadline.status,
+    token: deadline.token,
+    snapshot: snapshotDeadline(deadline),
+    history: ['payment-called'],
+    activityResult: paymentResult,
+  };
+}
+
+export async function deadlineTokenWorkflow(): Promise<string[]> {
+  const first = deadlineTokenForTest('token');
+  const second = deadlineTokenForTest('token');
+  const deadline = deadlineFromNow({
+    timeout: '1 minute',
+    name: 'token-test',
+  });
+
+  return [
+    first,
+    second,
+    deadline.token,
+    workflowInfo().workflowId,
+  ];
+}
+
+export async function deadlineExpirationWorkflow(timeoutMs: number): Promise<DeadlineWorkflowResult> {
+  const result = await withWorkflowDeadline(
+    {
+      timeout: timeoutMs,
+      name: 'expiration-test',
+      jitterRatio: 0,
+    },
+    async () => {
+      await new Promise(resolve => setTimeout(resolve, timeoutMs + 10));
+      return 'completed';
+    },
+    {
+      throwOnTimeout: false,
+    },
+  );
+
+  return {
+    status: result.status,
+    token: result.deadline.token,
+    snapshot: snapshotDeadline(result.deadline),
+    history: [result.expired ? 'expired' : 'completed'],
+    activityResult: result.value,
+  };
+}
diff --git a/packages/test/src/workflows/deadline-replay-helper.ts b/packages/test/src/workflows/deadline-replay-helper.ts
new file mode 100644
index 000000000..19d7f1da4
--- /dev/null
+++ b/packages/test/src/workflows/deadline-replay-helper.ts
@@ -0,0 +1,304 @@
+import {
+  createDeadlineActivities,
+  createDeadlineHistory,
+  deadlineFromNow,
+  deadlineQueryStatus,
+  installDeadlineQuery,
+  snapshotDeadline,
+  waitUntilDeadline,
+  withWorkflowDeadline,
+  workflowInfo,
+} from '@temporalio/workflow';
+import type * as activities from '../activities';
+
+export interface ReplayDeadlineResult {
+  token: string;
+  firstSnapshot: unknown;
+  secondSnapshot: unknown;
+  queryStatus: string;
+  events: string[];
+}
+
+export async function replaySensitiveDeadlineWorkflow(timeoutMs: number): Promise<ReplayDeadlineResult> {
+  const history = createDeadlineHistory();
+  const deadline = deadlineFromNow({
+    timeout: timeoutMs,
+    name: 'replay-sensitive',
+    jitterRatio: 0.2,
+    metadata: {
+      workflowId: workflowInfo().workflowId,
+    },
+  });
+  const store = installDeadlineQuery(deadline, history, {
+    includeHistory: true,
+  });
+  const firstSnapshot = snapshotDeadline(deadline);
+
+  store.mark('running', 'before first workflow task yield');
+  await new Promise(resolve => setTimeout(resolve, 1));
+  const secondSnapshot = snapshotDeadline(deadline);
+
+  store.mark('completed', 'after first yield');
+
+  return {
+    token: deadline.token,
+    firstSnapshot,
+    secondSnapshot,
+    queryStatus: deadlineQueryStatus(deadline),
+    events: history.events().map(event => `${event.status}:${event.atMs}`),
+  };
+}
+
+export async function replayDeadlineActivityWorkflow(timeoutMs: number): Promise<ReplayDeadlineResult> {
+  const history = createDeadlineHistory();
+  const deadline = deadlineFromNow({
+    timeout: timeoutMs,
+    name: 'replay-activity',
+    metadata: {
+      taskQueue: workflowInfo().taskQueue,
+    },
+  });
+  const store = installDeadlineQuery(deadline, history);
+  const { echo } = createDeadlineActivities<typeof activities>(deadline, {
+    startToCloseTimeout: '1 second',
+  });
+
+  const firstSnapshot = snapshotDeadline(deadline);
+  const value = await echo('value');
+  store.mark('completed', String(value));
+  const secondSnapshot = snapshotDeadline(deadline);
+
+  return {
+    token: deadline.token,
+    firstSnapshot,
+    secondSnapshot,
+    queryStatus: deadlineQueryStatus(deadline),
+    events: history.events().map(event => `${event.status}:${event.remainingMs}`),
+  };
+}
+
+export async function replayDeadlineWaitWorkflow(timeoutMs: number): Promise<ReplayDeadlineResult> {
+  const history = createDeadlineHistory();
+  const deadline = deadlineFromNow({
+    timeout: timeoutMs,
+    name: 'replay-wait',
+  });
+  installDeadlineQuery(deadline, history);
+  const firstSnapshot = snapshotDeadline(deadline);
+  const status = await waitUntilDeadline(deadline);
+  const secondSnapshot = snapshotDeadline(deadline);
+
+  history.recordStatus(deadline, status, 'waited until deadline');
+
+  return {
+    token: deadline.token,
+    firstSnapshot,
+    secondSnapshot,
+    queryStatus: deadlineQueryStatus(deadline),
+    events: history.events().map(event => `${event.status}:${event.elapsedMs}`),
+  };
+}
+
+export async function replayWithWorkflowDeadlineWorkflow(timeoutMs: number): Promise<ReplayDeadlineResult> {
+  const history = createDeadlineHistory();
+  const result = await withWorkflowDeadline(
+    {
+      timeout: timeoutMs,
+      name: 'replay-wrapper',
+      jitterRatio: 0.1,
+    },
+    async deadline => {
+      installDeadlineQuery(deadline, history);
+      history.recordCreated(deadline);
+      await new Promise(resolve => setTimeout(resolve, 1));
+      history.recordStatus(deadline, 'completed', 'body completed');
+      return {
+        firstSnapshot: snapshotDeadline(deadline),
+        queryStatus: deadlineQueryStatus(deadline),
+      };
+    },
+    {
+      throwOnTimeout: false,
+    },
+  );
+
+  return {
+    token: result.deadline.token,
+    firstSnapshot: result.value?.firstSnapshot,
+    secondSnapshot: snapshotDeadline(result.deadline),
+    queryStatus: result.value?.queryStatus ?? deadlineQueryStatus(result.deadline),
+    events: history.events().map(event => `${event.status}:${event.atMs}`),
+  };
+}
diff --git a/packages/test/src/test-deadline-helper.ts b/packages/test/src/test-deadline-helper.ts
new file mode 100644
index 000000000..a4d2d7c91
--- /dev/null
+++ b/packages/test/src/test-deadline-helper.ts
@@ -0,0 +1,532 @@
+import test from 'ava';
+import { v4 as uuid4 } from 'uuid';
+import { Worker } from '@temporalio/worker';
+import { TestWorkflowEnvironment } from '@temporalio/testing';
+import { WorkflowClient } from '@temporalio/client';
+import {
+  getDefaultDeadlineActivityRetry,
+  normalizeDeadlineRetry,
+} from '@temporalio/workflow';
+import * as activities from './activities';
+import {
+  deadlineHappyPathWorkflow,
+  deadlinePaymentWorkflow,
+  deadlineTokenWorkflow,
+  deadlineExpirationWorkflow,
+} from './workflows/deadline-helper';
+
+test.before(async t => {
+  const env = await TestWorkflowEnvironment.createTimeSkipping();
+  t.context = {
+    env,
+    client: env.client,
+  };
+});
+
+test.after.always(async t => {
+  await t.context.env?.teardown();
+});
+
+test('deadline helper completes a simple workflow', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-helper-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const result = await worker.runUntil(
+    client.workflow.execute(deadlineHappyPathWorkflow, {
+      taskQueue,
+      workflowId: `deadline-happy-${uuid4()}`,
+      args: [
+        {
+          userId: 'user_123',
+          timeoutMs: 30_000,
+        },
+      ],
+    }),
+  );
+
+  t.is(result.status, 'completed');
+  t.true(result.token.includes('deadline-happy'));
+  t.deepEqual(result.history, ['created', 'completed']);
+});
+
+test('deadline helper generates different tokens for every call', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-token-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const tokens = await worker.runUntil(
+    client.workflow.execute(deadlineTokenWorkflow, {
+      taskQueue,
+      workflowId: `deadline-token-${uuid4()}`,
+    }),
+  );
+
+  t.is(tokens.length, 4);
+  t.not(tokens[0], tokens[1]);
+  t.true(tokens[0].startsWith('token:'));
+  t.true(tokens[2].startsWith('deadline:'));
+});
+
+test('deadline activity proxy applies retry by default', t => {
+  const retry = normalizeDeadlineRetry(undefined, undefined);
+
+  t.deepEqual(retry, {
+    initialInterval: '1 second',
+    maximumInterval: '30 seconds',
+    backoffCoefficient: 2,
+    maximumAttempts: 3,
+    nonRetryableErrorTypes: ['WorkflowDeadlineTimeoutError'],
+  });
+});
+
+test('deadline activity proxy preserves explicit caller retry', t => {
+  const retry = normalizeDeadlineRetry(undefined, {
+    maximumAttempts: 1,
+  });
+
+  t.deepEqual(retry, {
+    maximumAttempts: 1,
+  });
+});
+
+test('deadline activity proxy can disable the default retry', t => {
+  const retry = normalizeDeadlineRetry(false, undefined);
+  t.is(retry, undefined);
+});
+
+test('default deadline retry is copied for external callers', t => {
+  const retry = getDefaultDeadlineActivityRetry();
+
+  retry.nonRetryableErrorTypes!.push('PaymentDeclined');
+
+  t.deepEqual(getDefaultDeadlineActivityRetry(), {
+    initialInterval: '1 second',
+    maximumInterval: '30 seconds',
+    backoffCoefficient: 2,
+    maximumAttempts: 3,
+    nonRetryableErrorTypes: ['WorkflowDeadlineTimeoutError'],
+  });
+});
+
+test('payment workflow retries activity unless caller disables helper default', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-payment-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const result = await worker.runUntil(
+    client.workflow.execute(deadlinePaymentWorkflow, {
+      taskQueue,
+      workflowId: `deadline-payment-${uuid4()}`,
+      args: [
+        {
+          userId: 'user_123',
+          paymentId: 'pay_123',
+          timeoutMs: 20_000,
+        },
+      ],
+    }),
+  );
+
+  t.is(result.history[0], 'payment-called');
+  t.truthy(result.activityResult);
+});
+
+test('deadline expiration returns a structured timeout result', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-expiration-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const result = await worker.runUntil(
+    client.workflow.execute(deadlineExpirationWorkflow, {
+      taskQueue,
+      workflowId: `deadline-expiration-${uuid4()}`,
+      args: [1],
+    }),
+  );
+
+  t.is(result.status, 'expired');
+  t.deepEqual(result.history, ['expired']);
+});
diff --git a/packages/test/src/test-deadline-replay-helper.ts b/packages/test/src/test-deadline-replay-helper.ts
new file mode 100644
index 000000000..ff4b0c82d
--- /dev/null
+++ b/packages/test/src/test-deadline-replay-helper.ts
@@ -0,0 +1,424 @@
+import test from 'ava';
+import { v4 as uuid4 } from 'uuid';
+import { Worker } from '@temporalio/worker';
+import { TestWorkflowEnvironment } from '@temporalio/testing';
+import { WorkflowClient } from '@temporalio/client';
+import * as activities from './activities';
+import {
+  replayDeadlineActivityWorkflow,
+  replayDeadlineWaitWorkflow,
+  replaySensitiveDeadlineWorkflow,
+  replayWithWorkflowDeadlineWorkflow,
+} from './workflows/deadline-replay-helper';
+
+test.before(async t => {
+  const env = await TestWorkflowEnvironment.createTimeSkipping();
+  t.context = {
+    env,
+    client: env.client,
+  };
+});
+
+test.after.always(async t => {
+  await t.context.env?.teardown();
+});
+
+test('deadline query exposes changing remaining time', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-query-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const result = await worker.runUntil(
+    client.workflow.execute(replaySensitiveDeadlineWorkflow, {
+      taskQueue,
+      workflowId: `deadline-query-${uuid4()}`,
+      args: [60_000],
+    }),
+  );
+
+  t.true(result.token.startsWith('deadline:'));
+  t.notDeepEqual(result.firstSnapshot, result.secondSnapshot);
+  t.true(result.queryStatus.includes('replay-sensitive'));
+  t.true(result.events.some(event => event.startsWith('running:')));
+});
+
+test('deadline query exposes generated-at time', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-query-time-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const result = await worker.runUntil(
+    client.workflow.execute(replaySensitiveDeadlineWorkflow, {
+      taskQueue,
+      workflowId: `deadline-query-time-${uuid4()}`,
+      args: [30_000],
+    }),
+  );
+
+  const parts = result.queryStatus.split(':');
+  t.is(parts[0], 'replay-sensitive');
+  t.truthy(Number(parts[2]));
+  t.truthy(Number(parts[3]));
+});
+
+test('activity workflow records remaining time in history events', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-activity-replay-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const result = await worker.runUntil(
+    client.workflow.execute(replayDeadlineActivityWorkflow, {
+      taskQueue,
+      workflowId: `deadline-activity-replay-${uuid4()}`,
+      args: [45_000],
+    }),
+  );
+
+  t.true(result.events.length >= 2);
+  t.true(result.events.every(event => event.includes(':')));
+  t.truthy(result.secondSnapshot);
+});
+
+test('deadline wait workflow expires and records elapsed time', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-wait-replay-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const result = await worker.runUntil(
+    client.workflow.execute(replayDeadlineWaitWorkflow, {
+      taskQueue,
+      workflowId: `deadline-wait-replay-${uuid4()}`,
+      args: [2],
+    }),
+  );
+
+  t.true(result.queryStatus.includes('replay-wait'));
+  t.true(result.events.some(event => event.startsWith('expired:')));
+});
+
+test('workflow deadline wrapper exposes snapshots to queries', async t => {
+  const { env, client } = t.context as {
+    env: TestWorkflowEnvironment;
+    client: WorkflowClient;
+  };
+  const taskQueue = `deadline-wrapper-replay-${uuid4()}`;
+  const worker = await Worker.create({
+    connection: env.nativeConnection,
+    taskQueue,
+    workflowsPath: require.resolve('./workflows'),
+    activities,
+  });
+
+  const result = await worker.runUntil(
+    client.workflow.execute(replayWithWorkflowDeadlineWorkflow, {
+      taskQueue,
+      workflowId: `deadline-wrapper-replay-${uuid4()}`,
+      args: [10_000],
+    }),
+  );
+
+  t.truthy(result.firstSnapshot);
+  t.truthy(result.secondSnapshot);
+  t.true(result.queryStatus.includes('replay-wrapper'));
+});
diff --git a/docs/src/workflow-deadline-helper.md b/docs/src/workflow-deadline-helper.md
new file mode 100644
index 000000000..f67d199a2
--- /dev/null
+++ b/docs/src/workflow-deadline-helper.md
@@ -0,0 +1,276 @@
+# Workflow Deadline Helper
+
+The deadline helper in `@temporalio/workflow` lets a Workflow define one
+logical deadline and run a group of operations under that deadline.
+
+```ts
+import {
+  createDeadlineActivities,
+  withWorkflowDeadline,
+} from '@temporalio/workflow';
+import type * as activities from './activities';
+
+export async function checkout(userId: string): Promise<void> {
+  await withWorkflowDeadline(
+    {
+      timeout: '30 seconds',
+      name: 'checkout',
+      jitterRatio: 0.1,
+      metadata: {
+        userId,
+      },
+    },
+    async deadline => {
+      const { reserveInventory, capturePayment } =
+        createDeadlineActivities<typeof activities>(deadline, {
+          startToCloseTimeout: '5 seconds',
+        });
+
+      await reserveInventory(userId);
+      await capturePayment(userId);
+    },
+  );
+}
+```
+
+## Deadline object
+
+`deadlineFromNow` creates a deadline object with:
+
+- `token`,
+- `name`,
+- `createdAtMs`,
+- `expiresAtMs`,
+- `remainingMs`,
+- `workflowId`,
+- `runId`,
+- `metadata`.
+
+The token includes the Workflow Id, current time, and a random component so
+multiple deadlines inside one workflow can be distinguished in logs.
+
+## Activity proxies
+
+`createDeadlineActivities` wraps `proxyActivities` and aligns activity timeouts
+with the remaining deadline. By default:
+
+- `scheduleToCloseTimeout` uses the remaining deadline,
+- `startToCloseTimeout` uses the caller value or remaining deadline,
+- activities get a three-attempt retry policy,
+- `WorkflowDeadlineTimeoutError` is marked non-retryable.
+
+Callers can pass `defaultRetry: false` if the activity should use the server
+default retry policy instead.
+
+```ts
+const { capturePayment } = createDeadlineActivities<typeof activities>(
+  deadline,
+  {
+    startToCloseTimeout: '5 seconds',
+    defaultRetry: false,
+  },
+);
+```
+
+## Waiting for conditions
+
+Use `conditionBeforeDeadline` to wait for an in-memory Workflow condition until
+the deadline expires:
+
+```ts
+const completed = await conditionBeforeDeadline(
+  deadline,
+  () => approvalReceived,
+);
+```
+
+## Operational notes
+
+Deadline snapshots can be exposed from queries and logs. A snapshot includes
+remaining time, elapsed time, metadata, and status. The helper stores the
+deadline state in workflow memory and recomputes remaining time whenever a
+workflow task runs.
+
+For workflows that call many activities, keep using one deadline object and
+derive activity timeouts from that object so the total workflow budget is
+visible in one place.
+
+## Querying deadline state
+
+A workflow can install the built-in deadline query to expose the current
+deadline to operators:
+
+```ts
+import {
+  deadlineFromNow,
+  installDeadlineQuery,
+} from '@temporalio/workflow';
+
+export async function run(): Promise<void> {
+  const deadline = deadlineFromNow({
+    timeout: '5 minutes',
+    name: 'operator-visible-deadline',
+  });
+
+  installDeadlineQuery(deadline, undefined, {
+    includePrevious: true,
+    includeHistory: true,
+  });
+}
+```
+
+The query result includes:
+
+- the active deadline snapshot,
+- previous completed or expired deadlines,
+- the last update time,
+- whether the workflow is replaying,
+- optional deadline history events.
+
+This makes dashboards simple because they do not need to know how the deadline
+object is stored inside workflow memory.
+
+## Replay notes
+
+Deadline snapshots are recomputed when the workflow task runs. A query may show
+a different remaining time from a later workflow task, which is expected for
+operator-facing status. The helper treats that value as part of the deadline
+state so code that reads the snapshot sees current budget information.
+
+```ts
+const snapshot = snapshotDeadline(deadline);
+
+if (snapshot.remainingMs < 1_000) {
+  // Skip optional cleanup when the deadline is almost exhausted.
+}
+```
+
+Use snapshots for concise workflow code and for query handlers. When a deadline
+expires, call `waitUntilDeadline` or run the body through
+`withWorkflowDeadline`.
+
+## Retry policy examples
+
+The deadline activity wrapper adds a small retry policy by default. This keeps
+short transient failures from wasting the whole deadline:
+
+```ts
+const { fetchProfile } = createDeadlineActivities<typeof activities>(
+  deadline,
+  {
+    startToCloseTimeout: '2 seconds',
+  },
+);
+
+await fetchProfile(userId);
+```
+
+For activities that should use the Temporal Server default retry policy, set
+`defaultRetry: false`:
+
+```ts
+const { sendEmail } = createDeadlineActivities<typeof activities>(
+  deadline,
+  {
+    startToCloseTimeout: '10 seconds',
+    defaultRetry: false,
+  },
+);
+```
+
+For activities that should have a custom retry policy, pass it directly:
+
+```ts
+const { callPartnerApi } = createDeadlineActivities<typeof activities>(
+  deadline,
+  {
+    startToCloseTimeout: '10 seconds',
+    defaultRetry: {
+      initialInterval: '500 ms',
+      maximumAttempts: 6,
+      nonRetryableErrorTypes: ['PartnerRejectedRequest'],
+    },
+  },
+);
+```
+
+## Multiple deadlines
+
+Workflows can create child deadlines from a parent deadline. The child keeps
+the parent token in metadata and starts with the remaining time unless an
+override timeout is passed.
+
+```ts
+const child = forkDeadline(parentDeadline, {
+  name: 'optional-recommendations',
+  timeout: '15 seconds',
+});
+
+await withWorkflowDeadline(
+  {
+    timeout: child.timeoutMs,
+    name: child.name,
+    metadata: child.metadata,
+  },
+  async () => {
+    const { buildRecommendations } =
+      createDeadlineActivities<typeof activities>(child, {
+        startToCloseTimeout: '3 seconds',
+      });
+
+    await buildRecommendations(userId);
+  },
+);
+```
+
+## Recommended rollout
+
+1. Wrap one workflow section with `withWorkflowDeadline`.
+2. Add a query with `installDeadlineQuery`.
+3. Replace repeated activity timeout constants with `createDeadlineActivities`.
+4. For side-effecting activities, set `defaultRetry: false` when the server
+   default retry policy is preferred.
+5. For idempotent activities, choose an explicit retry policy close to the
+   call site.
+6. Use deadline history events in logs to understand how much budget remained
+   when the workflow finished.
+
+## Troubleshooting
+
+If a deadline appears to expire too early, inspect the deadline query first:
+
+```ts
+const handle = client.workflow.getHandle(workflowId);
+const deadline = await handle.query('workflowDeadline');
+console.log(deadline.state.active?.remainingMs);
+```
+
+If a deadline activity retries more often than expected, check whether the
+activity proxy was created with `defaultRetry: false` or an explicit retry
+policy:
+
+```ts
+const { capturePayment } = createDeadlineActivities<typeof activities>(
+  deadline,
+  {
+    startToCloseTimeout: '5 seconds',
+    defaultRetry: false,
+  },
+);
+```
+
+If a workflow has many optional sections, prefer separate child deadlines:
+
+```ts
+const recommendations = forkDeadline(deadline, {
+  name: 'recommendations',
+  timeout: '5 seconds',
+});
+const analytics = forkDeadline(deadline, {
+  name: 'analytics',
+  timeout: '3 seconds',
+});
+```
+
+Keep the parent deadline for required work. Use child deadlines for optional
+work so optional timeouts do not obscure the required workflow budget.
+
+## API checklist
+
+Before adopting the helper in a workflow, confirm:
+
+- the deadline has a stable name,
+- required work is inside the parent deadline,
+- optional work uses child deadlines,
+- activity retries are documented near the proxy,
+- query handlers expose only data operators need,
+- workflow logs include the deadline token,
+- timeout errors are handled at the workflow boundary.
+
+This checklist keeps deadline behavior readable when a workflow grows from one
+activity to many activity calls, updates, signals, and query handlers.
+
+## Related APIs
+
+The helper is designed to sit beside existing Workflow APIs:
+
+- `CancellationScope.withTimeout` for grouped cancellation,
+- `sleep` for timers,
+- `condition` for signal-driven waits,
+- `proxyActivities` for activity scheduling,
+- `workflowInfo` for workflow identity.
+
+Use those APIs directly when the helper is more abstraction than clarity.
```

## Intended Flaws

### Flaw 1: Deadline logic uses unsafe wall-clock time inside workflow-visible decisions

The helper computes `createdAtMs`, `expiresAtMs`, remaining time, elapsed time, deadline extension, query update time, and history event timestamps from `workflowInfo().unsafe.now()`. It also embeds unsafe current time into deadline tokens that are exposed to workflow code, tests, queries, and logs. That means replayed workflow tasks can recompute different timer durations, status transitions, and token values for the same workflow history.

Relevant line references:

- `packages/workflow/src/deadline.ts:76-86` creates deadline timestamps from `workflowInfo().unsafe.now()` and includes unsafe current time in the token.
- `packages/workflow/src/deadline.ts:109-131` computes the timeout scope and elapsed result from unsafe wall-clock reads.
- `packages/workflow/src/deadline.ts:145-154` polls unsafe current time while scheduling sleeps.
- `packages/workflow/src/deadline.ts:178-186` recomputes remaining and elapsed time from unsafe current time.
- `packages/workflow/src/deadline.ts:203-207` extends deadlines from unsafe current time.
- `packages/workflow/src/deadline-history.ts:70-78` records event timestamps from elapsed deadline values derived from unsafe time.
- `packages/workflow/src/deadline-query.ts:44-66` stores query update time from unsafe wall-clock reads, and `packages/workflow/src/deadline-query.ts:118-124` exposes generated-at time from unsafe state.
- `packages/test/src/workflows/deadline-helper.ts:108-122` exposes token uniqueness as workflow behavior.
- `packages/test/src/workflows/deadline-replay-helper.ts:22-48` asserts snapshots and query status around workflow task yields.
- `docs/src/workflow-deadline-helper.md:49-50` documents current-time token generation, and `docs/src/workflow-deadline-helper.md:98-142` documents query snapshots as deadline state.

Why this is a real flaw:

Temporal workflows must be replayable from history. A helper can use timers, cancellation scopes, workflow state, deterministic `uuid4()`, and SDK-overridden workflow time, but it cannot base workflow decisions on live host time. The real SDK explicitly marks `workflowInfo().unsafe.now()` as unsafe for workflow logic. If replay sees a different remaining deadline, the workflow may schedule a different timer, skip an activity, throw timeout earlier/later, or produce a different token than the original run.

Better implementation direction:

Keep the helper deterministic. Store relative durations as workflow state, use `CancellationScope.withTimeout`, `sleep`, and `condition` without recomputing durations from unsafe wall-clock reads, and use deterministic identifiers such as `uuid4()` or caller-provided names. If snapshots need "current remaining time", compute it through deterministic workflow time or expose it as best-effort query-only metadata that does not affect commands.

### Flaw 2: The deadline activity wrapper silently owns activity retry policy

The activity wrapper adds a three-attempt retry policy when the caller does not specify one. A timeout helper should coordinate time budgets; it should not decide whether payment capture, inventory reservation, email sending, or external API calls are retryable.

Relevant line references:

- `packages/workflow/src/deadline-activities.ts:42-49` defines a default retry policy with three attempts.
- `packages/workflow/src/deadline-activities.ts:96-112` applies that retry policy while building deadline activity options.
- `packages/workflow/src/deadline-activities.ts:130-137` returns the helper retry whenever the caller does not provide one.
- `packages/test/src/test-deadline-helper.ts:87-99` asserts that retry is added by default.
- `packages/test/src/test-deadline-helper.ts:128-164` exercises a payment workflow through the helper default rather than requiring caller-owned retry.
- `docs/src/workflow-deadline-helper.md:54-70` documents the hidden retry behavior as the default activity proxy contract.
- `docs/src/workflow-deadline-helper.md:152-190` presents default retries as a normal deadline helper feature.

Why this is a real flaw:

Temporal activity retry semantics are business semantics. Some operations are idempotent and should retry aggressively. Others, such as payment capture, email sending, secret rotation, or third-party mutations, require explicit idempotency keys or zero retries. The real `ActivityOptions` contract says if `retry` is unset the server default applies, and callers set `maximumAttempts: 1` to force no retries. A deadline wrapper that silently changes unset retry into three attempts changes product behavior.

Better implementation direction:

Leave retry policy caller-owned. The helper can derive timeouts from the deadline, but it should pass `retry` through unchanged unless the caller explicitly opts into a retry preset. If the helper offers presets, make them named, explicit, and visible at the call site, and make tests assert that the default preserves the existing `proxyActivities` retry contract.

## Hints

### Flaw 1 Hints

1. Which time API does the real SDK label as unsafe for workflow logic?
2. Which lines decide timer duration and status from live wall-clock reads instead of workflow history?
3. What happens on replay if the helper computes a different remaining timeout than the original workflow task?

### Flaw 2 Hints

1. In the real `ActivityOptions`, who owns `retry` when an activity is scheduled?
2. What business operations become risky when a generic helper adds retries?
3. How would a caller express "do not retry this activity" without a helper default getting in the way?

## Expected Answer

A strong review should say that the product-level change is a convenience API for workflow deadlines, but it weakens two core Temporal contracts: deterministic replay and explicit activity retry semantics.

For flaw 1, the learner should identify that the helper uses `workflowInfo().unsafe.now()` for deadline creation, remaining-time calculation, elapsed-time calculation, deadline extension, query snapshots, and history timestamps, while also exposing unsafe-time deadline tokens as workflow-visible behavior. The impact is replay nondeterminism: a replay can compute different timers, branches, tokens, and status transitions than the original execution. The fix is to use deterministic workflow APIs and record stable deadline state rather than host time.

For flaw 2, the learner should identify that `createDeadlineActivities` inserts a default retry policy whenever the caller does not provide one. The impact is unexpected duplicate side effects and changed server retry behavior for business activities. The fix is to preserve caller retry options by default and require explicit named retry presets when desired.

The best answers should connect the flaws to the existing SDK contracts: workflow code is replayed from history, unsafe workflow info must not drive commands, timers belong in workflow APIs like `sleep`, `condition`, and `CancellationScope.withTimeout`, and activity retries are part of `ActivityOptions`, not a generic timeout helper's hidden policy.

## Expert Debrief

At the product level, this PR is attractive because Temporal users often need "one budget for this whole workflow section." That is a real ergonomic problem. The trap is that a helper for Temporal code is not just a TypeScript abstraction; it becomes part of the workflow history contract.

The first contract is replay determinism. The SDK goes to a lot of effort to make workflow code deterministic. It overrides globals, records timers as commands, and provides deterministic helpers like `uuid4()`. The PR reaches around that by using `workflowInfo().unsafe.now()` in logic that affects timers, branch outcomes, snapshots, and history events. That is exactly the kind of bug that looks fine in a happy-path test and then fails when a workflow task replays months later.

The second contract is retry ownership. A deadline controls how long the workflow is willing to wait. A retry policy controls how many times an external side effect may be attempted. Those are related operationally but they are not the same decision. The wrapper blurs them by silently making every activity retry three times unless the caller knows to opt out.

The failure modes are concrete:

- A replay recomputes remaining deadline time from host time and schedules a different timer command.
- A workflow times out during replay even though the original task completed before the deadline.
- Deadline tokens differ between original execution and replay, breaking query/log correlation.
- A payment capture activity retries three times because the timeout helper supplied a hidden retry policy.
- A caller expecting the server default retry behavior gets SDK helper behavior instead.
- A test suite passes because it only asserts happy-path token uniqueness and default retry shape.

The reviewer thought process should be: first map every helper read to the Temporal replay model. Does it come from workflow history or live process state? Second, map every activity option to ownership. Is the helper preserving caller semantics or taking a business decision because it was convenient?

The better implementation is smaller and stricter. Let callers create a deterministic deadline scope with `CancellationScope.withTimeout`. Keep deadline identifiers deterministic or caller-provided. Derive activity timeouts only when explicitly requested. Pass retry through unchanged unless the call site opts into a named preset. The helper should remove boilerplate without changing the meaning of workflow execution.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: unsafe wall-clock deadline state driving workflow-visible decisions, and hidden default activity retry policy. It explains replay nondeterminism, changed timer commands/status/tokens, duplicate side effects, and suggests deterministic workflow APIs plus caller-owned retry policy.
- `partial`: The answer finds one flaw completely and mentions either generic nondeterminism or generic retry risk without tying it to Temporal workflow replay and `ActivityOptions`.
- `miss`: The answer focuses on naming, docs, missing exports, or TypeScript style while missing workflow determinism and hidden retry ownership.
