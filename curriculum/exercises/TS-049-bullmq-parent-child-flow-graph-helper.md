# TS-049: BullMQ Parent-Child Flow Graph Helper

## Metadata

- `id`: TS-049
- `source_repo`: [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq)
- `repo_area`: flows, parent-child dependencies, failed children, Redis payload sizing, flow helper APIs, aggregate parent state
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,650-2,000
- `represented_diff_lines`: 1670
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about BullMQ flows, parent-child Redis state, failure propagation, dependency sets, and queue payload design without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a higher-level flow graph helper for users who want to split one logical operation into many child jobs and then process an aggregate parent job. Today users can build this with `FlowProducer`, but they must manually decide how shared context is passed to children and how child failures affect parent processing.

The PR adds:

- a `FlowGraphProducer` wrapper around `FlowProducer`,
- a `FlowGraphStatus` helper to summarize child progress,
- a parent worker helper that waits for all children and passes aggregate child values to a processor,
- TypeScript interfaces for graph nodes and context,
- exports from the public classes barrel,
- tests for successful graphs and child failures,
- docs for the new helper API.

The intended product behavior is: callers can create a parent job with many child jobs, share context across the graph, and trust the parent processor to run only with truthful aggregate child status.

## Existing Code Context

The real BullMQ codebase already has these relevant contracts:

- `src/classes/flow-producer.ts` documents flows as tree-like job structures where children are processed before parents and all jobs may live in different queues.
- `src/classes/flow-producer.ts` adds parent jobs in `waiting-children` and stores child dependencies under the parent dependency key.
- `src/interfaces/flow-job.ts` defines `FlowJob` and `FlowChildJob`, where children receive their own job data and job options.
- `src/types/job-options.ts` exposes explicit failure propagation options: `failParentOnFailure`, `continueParentOnFailure`, `ignoreDependencyOnFailure`, and `removeDependencyOnFailure`.
- `src/classes/job.ts` stores job `data` as JSON and validates `sizeLimit`, so large copied payloads are a real Redis and API contract.
- `src/commands/includes/storeJob.lua` writes job `data`, `opts`, and compact parent references into Redis.
- `src/commands/includes/moveChildFromDependenciesIfNeeded.lua` updates parent dependency state on child failure only when the selected failure option says to do so.
- `src/classes/job.ts` exposes `getDependencies`, `getChildrenValues`, `getIgnoredChildrenFailures`, and dependency counts so parent processors can distinguish processed, failed, ignored, and pending children.
- `tests/flow.test.ts` verifies that normal children finish before parents, parent jobs start in `waiting-children`, and parent processors read processed child values.
- `tests/flow.test.ts` also verifies that `ignoreDependencyOnFailure` and `removeDependencyOnFailure` intentionally move parents forward on child failure, with different visibility into the failed child.
- `tests/stalled_jobs.test.ts` verifies `failParentOnFailure` moves a parent to failed when a child fails, and `continueParentOnFailure` starts parent processing when a child fails.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the helper preserves BullMQ's flow contracts for failure propagation and Redis payload ownership.

## Review Surface

Changed files in the synthetic PR:

- `src/interfaces/flow-graph.ts`
- `src/classes/flow-graph-producer.ts`
- `src/classes/flow-graph-status.ts`
- `src/classes/flow-graph-inspector.ts`
- `src/classes/flow-graph-worker.ts`
- `src/classes/index.ts`
- `tests/flow-graph-producer.test.ts`
- `tests/flow-graph-status.test.ts`
- `tests/flow-graph-worker.test.ts`
- `docs/gitbook/guide/flows/flow-graph-helper.md`

The line references below use synthetic PR line numbers. The represented diff is focused on public helper API design, parent-child failure semantics, dependency inspection, Redis payload shape, and tests that normalize unsafe graph behavior.

## Diff

```diff
diff --git a/src/interfaces/flow-graph.ts b/src/interfaces/flow-graph.ts
new file mode 100644
index 000000000..8f24b9762
--- /dev/null
+++ b/src/interfaces/flow-graph.ts
@@ -0,0 +1,190 @@
+import { FlowChildJob, FlowJob } from './flow-job';
+import { JobsOptions } from '../types';
+
+export type FlowGraphId = string;
+
+export type FlowGraphContext = Record<string, unknown>;
+
+export type FlowGraphFailureMode =
+  | 'continue'
+  | 'fail-parent'
+  | 'ignore-failed-children';
+
+export interface FlowGraphSharedContext {
+  graphId: FlowGraphId;
+  createdAt: number;
+  owner?: string;
+  traceId?: string;
+  context?: FlowGraphContext;
+  tags?: string[];
+}
+
+export interface FlowGraphChild<Data = any> {
+  name: string;
+  queueName: string;
+  data?: Data;
+  opts?: Omit<JobsOptions, 'repeat' | 'parent'>;
+  children?: FlowGraphChild[];
+}
+
+export interface FlowGraph<Data = any> {
+  id?: FlowGraphId;
+  name: string;
+  queueName: string;
+  data?: Data;
+  context?: FlowGraphContext;
+  tags?: string[];
+  opts?: Omit<JobsOptions, 'repeat'>;
+  children: FlowGraphChild[];
+  failureMode?: FlowGraphFailureMode;
+}
+
+export interface FlowGraphChildEnvelope<Data = any> {
+  graph: FlowGraphSharedContext;
+  parent: {
+    name: string;
+    queueName: string;
+    data: unknown;
+  };
+  child: {
+    name: string;
+    queueName: string;
+    data?: Data;
+    index: number;
+    path: number[];
+  };
+}
+
+export interface FlowGraphParentEnvelope<Data = any> {
+  graph: FlowGraphSharedContext;
+  parent: {
+    name: string;
+    queueName: string;
+    data?: Data;
+  };
+  childCount: number;
+  failureMode: FlowGraphFailureMode;
+}
+
+export interface FlowGraphAddOptions {
+  defaultFailureMode?: FlowGraphFailureMode;
+  copyParentDataToChildren?: boolean;
+  includeContextInChildren?: boolean;
+  childSizeLimit?: number;
+}
+
+export interface FlowGraphAggregateChild<Value = unknown> {
+  jobKey: string;
+  value?: Value;
+  failedReason?: string;
+  ignored?: boolean;
+}
+
+export interface FlowGraphAggregate<Value = unknown> {
+  graphId: FlowGraphId;
+  parentJobId: string;
+  total: number;
+  processed: number;
+  failed: number;
+  ignored: number;
+  pending: number;
+  complete: boolean;
+  children: FlowGraphAggregateChild<Value>[];
+}
+
+export interface FlowGraphWorkerOptions {
+  failParentWhenAnyChildFails?: boolean;
+  includeIgnoredFailures?: boolean;
+}
+
+export type FlowGraphProcessor<Value = unknown, Result = unknown> = (
+  aggregate: FlowGraphAggregate<Value>,
+) => Promise<Result> | Result;
+
+export function isFlowGraph(value: unknown): value is FlowGraph {
+  if (!value || typeof value !== 'object') {
+    return false;
+  }
+
+  const graph = value as FlowGraph;
+  return (
+    typeof graph.name === 'string' &&
+    typeof graph.queueName === 'string' &&
+    Array.isArray(graph.children)
+  );
+}
+
+export function toFlowGraphFailureMode(
+  value: FlowGraphFailureMode | undefined,
+  fallback: FlowGraphFailureMode,
+): FlowGraphFailureMode {
+  if (value === 'continue' || value === 'fail-parent' || value === 'ignore-failed-children') {
+    return value;
+  }
+
+  return fallback;
+}
+
+export function flowGraphFailureModeToChildOpts(
+  mode: FlowGraphFailureMode,
+): Partial<JobsOptions> {
+  switch (mode) {
+    case 'fail-parent':
+      return {
+        failParentOnFailure: true,
+      };
+    case 'continue':
+      return {
+        removeDependencyOnFailure: true,
+      };
+    case 'ignore-failed-children':
+      return {
+        ignoreDependencyOnFailure: true,
+      };
+  }
+}
+
+export type FlowGraphToFlowJob = FlowJob & {
+  data: FlowGraphParentEnvelope;
+  children: Array<FlowChildJob & { data: FlowGraphChildEnvelope }>;
+};
diff --git a/src/classes/flow-graph-producer.ts b/src/classes/flow-graph-producer.ts
new file mode 100644
index 000000000..a8030a4fb
--- /dev/null
+++ b/src/classes/flow-graph-producer.ts
@@ -0,0 +1,291 @@
+import { randomUUID } from '../utils';
+import { FlowProducer, JobNode } from './flow-producer';
+import {
+  FlowGraph,
+  FlowGraphAddOptions,
+  FlowGraphChild,
+  FlowGraphChildEnvelope,
+  FlowGraphParentEnvelope,
+  FlowGraphSharedContext,
+  FlowGraphToFlowJob,
+  flowGraphFailureModeToChildOpts,
+  toFlowGraphFailureMode,
+} from '../interfaces/flow-graph';
+import { QueueBaseOptions } from '../interfaces';
+
+export class FlowGraphProducer extends FlowProducer {
+  constructor(
+    opts: QueueBaseOptions = { connection: {} },
+    private graphOpts: FlowGraphAddOptions = {},
+  ) {
+    super(opts);
+  }
+
+  async addGraph(graph: FlowGraph, opts: FlowGraphAddOptions = {}): Promise<JobNode> {
+    const normalized = this.toFlowJob(graph, {
+      ...this.graphOpts,
+      ...opts,
+    });
+
+    return this.add(normalized);
+  }
+
+  async addGraphs(graphs: FlowGraph[], opts: FlowGraphAddOptions = {}): Promise<JobNode[]> {
+    const normalized = graphs.map(graph =>
+      this.toFlowJob(graph, {
+        ...this.graphOpts,
+        ...opts,
+      }),
+    );
+
+    return this.addBulk(normalized);
+  }
+
+  toFlowJob(graph: FlowGraph, opts: FlowGraphAddOptions = {}): FlowGraphToFlowJob {
+    const graphId = graph.id ?? randomUUID();
+    const failureMode = toFlowGraphFailureMode(
+      graph.failureMode,
+      opts.defaultFailureMode ?? 'continue',
+    );
+    const shared: FlowGraphSharedContext = {
+      graphId,
+      createdAt: Date.now(),
+      owner: typeof graph.context?.owner === 'string' ? graph.context.owner : undefined,
+      traceId: typeof graph.context?.traceId === 'string' ? graph.context.traceId : undefined,
+      context: graph.context ?? {},
+      tags: graph.tags ?? [],
+    };
+
+    const parentEnvelope: FlowGraphParentEnvelope = {
+      graph: shared,
+      parent: {
+        name: graph.name,
+        queueName: graph.queueName,
+        data: graph.data,
+      },
+      childCount: this.countChildren(graph.children),
+      failureMode,
+    };
+
+    return {
+      name: graph.name,
+      queueName: graph.queueName,
+      data: parentEnvelope,
+      opts: graph.opts,
+      children: graph.children.map((child, index) =>
+        this.toChildFlowJob({
+          child,
+          parent: graph,
+          shared,
+          failureMode,
+          index,
+          path: [index],
+          opts,
+        }),
+      ),
+    };
+  }
+
+  private toChildFlowJob(input: {
+    child: FlowGraphChild;
+    parent: FlowGraph;
+    shared: FlowGraphSharedContext;
+    failureMode: ReturnType<typeof toFlowGraphFailureMode>;
+    index: number;
+    path: number[];
+    opts: FlowGraphAddOptions;
+  }): FlowGraphToFlowJob['children'][number] {
+    const childEnvelope = this.materializeChildData({
+      child: input.child,
+      parent: input.parent,
+      shared: input.shared,
+      index: input.index,
+      path: input.path,
+      opts: input.opts,
+    });
+
+    const childOpts = {
+      ...input.child.opts,
+      ...flowGraphFailureModeToChildOpts(input.failureMode),
+      sizeLimit: input.opts.childSizeLimit ?? input.child.opts?.sizeLimit,
+    };
+
+    return {
+      name: input.child.name,
+      queueName: input.child.queueName,
+      data: childEnvelope,
+      opts: childOpts,
+      children: input.child.children?.map((grandChild, index) =>
+        this.toChildFlowJob({
+          child: grandChild,
+          parent: input.parent,
+          shared: input.shared,
+          failureMode: input.failureMode,
+          index,
+          path: [...input.path, index],
+          opts: input.opts,
+        }),
+      ),
+    };
+  }
+
+  private materializeChildData(input: {
+    child: FlowGraphChild;
+    parent: FlowGraph;
+    shared: FlowGraphSharedContext;
+    index: number;
+    path: number[];
+    opts: FlowGraphAddOptions;
+  }): FlowGraphChildEnvelope {
+    const includeContext = input.opts.includeContextInChildren ?? true;
+    const copyParentData = input.opts.copyParentDataToChildren ?? true;
+
+    return {
+      graph: includeContext
+        ? input.shared
+        : {
+            graphId: input.shared.graphId,
+            createdAt: input.shared.createdAt,
+            tags: input.shared.tags,
+          },
+      parent: {
+        name: input.parent.name,
+        queueName: input.parent.queueName,
+        data: copyParentData ? input.parent.data ?? {} : undefined,
+      },
+      child: {
+        name: input.child.name,
+        queueName: input.child.queueName,
+        data: input.child.data,
+        index: input.index,
+        path: input.path,
+      },
+    };
+  }
+
+  private countChildren(children: FlowGraphChild[]): number {
+    return children.reduce((count, child) => {
+      return count + 1 + this.countChildren(child.children ?? []);
+    }, 0);
+  }
+}
diff --git a/src/classes/flow-graph-status.ts b/src/classes/flow-graph-status.ts
new file mode 100644
index 000000000..cf6db32d1
--- /dev/null
+++ b/src/classes/flow-graph-status.ts
@@ -0,0 +1,244 @@
+import { Job } from './job';
+import {
+  FlowGraphAggregate,
+  FlowGraphAggregateChild,
+  FlowGraphParentEnvelope,
+} from '../interfaces/flow-graph';
+
+export class FlowGraphStatus {
+  async getAggregate<Value = unknown>(parent: Job): Promise<FlowGraphAggregate<Value>> {
+    const data = parent.data as FlowGraphParentEnvelope | undefined;
+    const dependencies = await parent.getDependencies({
+      processed: {
+        count: 10_000,
+      },
+      unprocessed: {
+        count: 10_000,
+      },
+    });
+
+    const processed = dependencies.processed ?? {};
+    const unprocessed = dependencies.unprocessed ?? [];
+    const children = this.processedToChildren<Value>(processed);
+    const pending = unprocessed.length;
+    const total = Math.max(data?.childCount ?? 0, children.length + pending);
+
+    return {
+      graphId: data?.graph.graphId ?? parent.id ?? '',
+      parentJobId: parent.id ?? '',
+      total,
+      processed: children.length,
+      failed: 0,
+      ignored: 0,
+      pending,
+      complete: pending === 0,
+      children,
+    };
+  }
+
+  async assertComplete<Value = unknown>(parent: Job): Promise<FlowGraphAggregate<Value>> {
+    const aggregate = await this.getAggregate<Value>(parent);
+    if (!aggregate.complete) {
+      throw new Error(
+        `Flow graph ${aggregate.graphId} is not complete: ${aggregate.pending} children are still pending`,
+      );
+    }
+
+    return aggregate;
+  }
+
+  private processedToChildren<Value>(
+    processed: Record<string, Value>,
+  ): Array<FlowGraphAggregateChild<Value>> {
+    return Object.entries(processed).map(([jobKey, value]) => ({
+      jobKey,
+      value,
+    }));
+  }
+}
diff --git a/src/classes/flow-graph-inspector.ts b/src/classes/flow-graph-inspector.ts
new file mode 100644
index 000000000..af15758db
--- /dev/null
+++ b/src/classes/flow-graph-inspector.ts
@@ -0,0 +1,228 @@
+import { Job } from './job';
+import { FlowGraphStatus } from './flow-graph-status';
+import {
+  FlowGraphAggregate,
+  FlowGraphParentEnvelope,
+} from '../interfaces/flow-graph';
+
+export interface FlowGraphInspectionOptions {
+  warnAfterPendingChildren?: number;
+  warnAfterPayloadBytes?: number;
+  includeChildValues?: boolean;
+}
+
+export interface FlowGraphPayloadEstimate {
+  parentBytes: number;
+  childValueBytes: number;
+  estimatedTotalBytes: number;
+}
+
+export interface FlowGraphInspection<Value = unknown> {
+  graphId: string;
+  parentJobId: string;
+  parentName?: string;
+  parentQueueName?: string;
+  aggregate: FlowGraphAggregate<Value>;
+  payload: FlowGraphPayloadEstimate;
+  warnings: string[];
+  childValues?: Value[];
+}
+
+export class FlowGraphInspector {
+  private status = new FlowGraphStatus();
+
+  async inspect<Value = unknown>(
+    parent: Job,
+    opts: FlowGraphInspectionOptions = {},
+  ): Promise<FlowGraphInspection<Value>> {
+    const aggregate = await this.status.getAggregate<Value>(parent);
+    const data = parent.data as FlowGraphParentEnvelope | undefined;
+    const payload = this.estimatePayload(parent, aggregate);
+    const warnings = this.buildWarnings(aggregate, payload, {
+      warnAfterPendingChildren: opts.warnAfterPendingChildren ?? 100,
+      warnAfterPayloadBytes: opts.warnAfterPayloadBytes ?? 1024 * 1024,
+    });
+
+    return {
+      graphId: aggregate.graphId,
+      parentJobId: aggregate.parentJobId,
+      parentName: data?.parent.name,
+      parentQueueName: data?.parent.queueName,
+      aggregate,
+      payload,
+      warnings,
+      childValues: opts.includeChildValues
+        ? aggregate.children.map(child => child.value as Value)
+        : undefined,
+    };
+  }
+
+  async assertHealthy<Value = unknown>(
+    parent: Job,
+    opts: FlowGraphInspectionOptions = {},
+  ): Promise<FlowGraphInspection<Value>> {
+    const inspection = await this.inspect<Value>(parent, opts);
+    const blockingWarnings = inspection.warnings.filter(warning =>
+      warning.startsWith('flow graph has too many pending children'),
+    );
+
+    if (blockingWarnings.length > 0) {
+      throw new Error(blockingWarnings.join('; '));
+    }
+
+    return inspection;
+  }
+
+  formatInspection<Value>(inspection: FlowGraphInspection<Value>): string {
+    const lines = [
+      `Flow graph ${inspection.graphId}`,
+      `Parent job ${inspection.parentJobId}`,
+      `Total children ${inspection.aggregate.total}`,
+      `Processed children ${inspection.aggregate.processed}`,
+      `Failed children ${inspection.aggregate.failed}`,
+      `Ignored children ${inspection.aggregate.ignored}`,
+      `Pending children ${inspection.aggregate.pending}`,
+      `Estimated payload bytes ${inspection.payload.estimatedTotalBytes}`,
+    ];
+
+    if (inspection.parentName) {
+      lines.splice(1, 0, `Parent name ${inspection.parentName}`);
+    }
+
+    if (inspection.parentQueueName) {
+      lines.splice(2, 0, `Parent queue ${inspection.parentQueueName}`);
+    }
+
+    if (inspection.warnings.length > 0) {
+      lines.push('Warnings');
+      for (const warning of inspection.warnings) {
+        lines.push(`- ${warning}`);
+      }
+    }
+
+    return lines.join('\n');
+  }
+
+  summarize<Value>(inspection: FlowGraphInspection<Value>): Record<string, unknown> {
+    return {
+      graphId: inspection.graphId,
+      parentJobId: inspection.parentJobId,
+      complete: inspection.aggregate.complete,
+      total: inspection.aggregate.total,
+      processed: inspection.aggregate.processed,
+      failed: inspection.aggregate.failed,
+      ignored: inspection.aggregate.ignored,
+      pending: inspection.aggregate.pending,
+      payloadBytes: inspection.payload.estimatedTotalBytes,
+      warnings: inspection.warnings,
+    };
+  }
+
+  private estimatePayload<Value>(
+    parent: Job,
+    aggregate: FlowGraphAggregate<Value>,
+  ): FlowGraphPayloadEstimate {
+    const parentBytes = this.bytes(parent.data);
+    const childValueBytes = aggregate.children.reduce((total, child) => {
+      return total + this.bytes(child.value);
+    }, 0);
+
+    return {
+      parentBytes,
+      childValueBytes,
+      estimatedTotalBytes: parentBytes + childValueBytes,
+    };
+  }
+
+  private buildWarnings<Value>(
+    aggregate: FlowGraphAggregate<Value>,
+    payload: FlowGraphPayloadEstimate,
+    opts: Required<Pick<
+      FlowGraphInspectionOptions,
+      'warnAfterPendingChildren' | 'warnAfterPayloadBytes'
+    >>,
+  ): string[] {
+    const warnings: string[] = [];
+
+    if (aggregate.pending > opts.warnAfterPendingChildren) {
+      warnings.push(
+        `flow graph has too many pending children: ${aggregate.pending}`,
+      );
+    }
+
+    if (payload.estimatedTotalBytes > opts.warnAfterPayloadBytes) {
+      warnings.push(
+        `flow graph aggregate payload is ${payload.estimatedTotalBytes} bytes`,
+      );
+    }
+
+    if (aggregate.complete && aggregate.failed === 0 && aggregate.ignored === 0) {
+      warnings.push('flow graph is complete and has no recorded failed children');
+    }
+
+    return warnings;
+  }
+
+  private bytes(value: unknown): number {
+    try {
+      return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8');
+    } catch {
+      return 0;
+    }
+  }
+}
diff --git a/src/classes/flow-graph-worker.ts b/src/classes/flow-graph-worker.ts
new file mode 100644
index 000000000..5fc266c09
--- /dev/null
+++ b/src/classes/flow-graph-worker.ts
@@ -0,0 +1,222 @@
+import { Worker } from './worker';
+import { Job } from './job';
+import { FlowGraphStatus } from './flow-graph-status';
+import {
+  FlowGraphProcessor,
+  FlowGraphWorkerOptions,
+} from '../interfaces/flow-graph';
+import { WorkerOptions } from '../interfaces';
+
+export class FlowGraphWorker<Value = unknown, Result = unknown> extends Worker {
+  private status = new FlowGraphStatus();
+
+  constructor(
+    queueName: string,
+    processor: FlowGraphProcessor<Value, Result>,
+    opts: WorkerOptions = {},
+    private graphOpts: FlowGraphWorkerOptions = {},
+  ) {
+    super(
+      queueName,
+      async (job: Job) => {
+        const aggregate = await this.status.assertComplete<Value>(job);
+
+        if (this.graphOpts.failParentWhenAnyChildFails && aggregate.failed > 0) {
+          throw new Error(`Flow graph ${aggregate.graphId} has ${aggregate.failed} failed children`);
+        }
+
+        return processor(aggregate);
+      },
+      opts,
+    );
+  }
+}
diff --git a/src/classes/index.ts b/src/classes/index.ts
index 4b398e3a2..28785d384 100644
--- a/src/classes/index.ts
+++ b/src/classes/index.ts
@@ -11,6 +11,10 @@ export { FlowProducer } from './flow-producer';
 export { Job } from './job';
 export { Queue } from './queue';
 export { QueueEvents } from './queue-events';
+export { FlowGraphProducer } from './flow-graph-producer';
+export { FlowGraphStatus } from './flow-graph-status';
+export { FlowGraphInspector } from './flow-graph-inspector';
+export { FlowGraphWorker } from './flow-graph-worker';
 export { Worker } from './worker';
 export { QueueBase } from './queue-base';
 export { RedisConnection } from './redis-connection';
diff --git a/tests/flow-graph-producer.test.ts b/tests/flow-graph-producer.test.ts
new file mode 100644
index 000000000..bb1bdb2d4
--- /dev/null
+++ b/tests/flow-graph-producer.test.ts
@@ -0,0 +1,319 @@
+import { default as IORedis } from 'ioredis';
+import {
+  describe,
+  beforeEach,
+  afterEach,
+  beforeAll,
+  afterAll,
+  it,
+  expect,
+} from 'vitest';
+
+import { FlowGraphProducer, Queue } from '../src/classes';
+import { randomUUID, removeAllQueueData } from '../src/utils';
+
+describe('flow graph producer', () => {
+  const redisHost = process.env.REDIS_HOST || 'localhost';
+  const prefix = process.env.BULLMQ_TEST_PREFIX || 'bull';
+
+  let connection: IORedis;
+  let queue: Queue;
+  let queueName: string;
+
+  beforeAll(async () => {
+    connection = new IORedis(redisHost, { maxRetriesPerRequest: null });
+  });
+
+  beforeEach(async () => {
+    queueName = `flow-graph-${randomUUID()}`;
+    queue = new Queue(queueName, { connection, prefix });
+  });
+
+  afterEach(async () => {
+    await queue.close();
+    await removeAllQueueData(new IORedis(redisHost), queueName);
+  });
+
+  afterAll(async () => {
+    await connection.quit();
+  });
+
+  it('creates a parent job and child jobs with shared context', async () => {
+    const flow = new FlowGraphProducer({ connection, prefix });
+    const tree = await flow.addGraph({
+      id: 'graph_1',
+      name: 'aggregate-report',
+      queueName,
+      data: {
+        reportId: 'report_1',
+      },
+      context: {
+        workspaceId: 'ws_1',
+        traceId: 'trace_1',
+      },
+      tags: ['reports', 'hourly'],
+      children: [
+        {
+          name: 'load-users',
+          queueName,
+          data: {
+            segment: 'users',
+          },
+        },
+        {
+          name: 'load-usage',
+          queueName,
+          data: {
+            segment: 'usage',
+          },
+        },
+      ],
+    });
+
+    expect(tree.job.name).toBe('aggregate-report');
+    expect(tree.children).toHaveLength(2);
+    expect(tree.children![0].job.data).toMatchObject({
+      graph: {
+        graphId: 'graph_1',
+        context: {
+          workspaceId: 'ws_1',
+          traceId: 'trace_1',
+        },
+      },
+      parent: {
+        data: {
+          reportId: 'report_1',
+        },
+      },
+      child: {
+        name: 'load-users',
+        data: {
+          segment: 'users',
+        },
+      },
+    });
+
+    await flow.close();
+  });
+
+  it('copies the parent payload into every child by default', async () => {
+    const largeParentPayload = {
+      workspaceId: 'ws_large',
+      filters: Array.from({ length: 250 }, (_, index) => ({
+        field: `field_${index}`,
+        operator: 'contains',
+        value: `value_${index}`,
+      })),
+      permissions: Array.from({ length: 100 }, (_, index) => ({
+        resource: `resource_${index}`,
+        actions: ['read', 'write', 'delete'],
+      })),
+    };
+
+    const flow = new FlowGraphProducer({ connection, prefix });
+    const tree = await flow.addGraph({
+      id: 'graph_large',
+      name: 'large-parent',
+      queueName,
+      data: largeParentPayload,
+      context: {
+        workspaceId: 'ws_large',
+      },
+      children: Array.from({ length: 5 }, (_, index) => ({
+        name: `child-${index}`,
+        queueName,
+        data: {
+          index,
+        },
+      })),
+    });
+
+    expect(tree.children).toHaveLength(5);
+    for (const child of tree.children!) {
+      expect(child.job.data.parent.data).toEqual(largeParentPayload);
+    }
+
+    await flow.close();
+  });
+
+  it('uses removeDependencyOnFailure for continue mode', async () => {
+    const flow = new FlowGraphProducer({ connection, prefix });
+    const tree = await flow.addGraph({
+      id: 'graph_continue',
+      name: 'continue-parent',
+      queueName,
+      failureMode: 'continue',
+      children: [
+        {
+          name: 'child',
+          queueName,
+          data: {},
+        },
+      ],
+    });
+
+    expect(tree.children![0].job.opts.removeDependencyOnFailure).toBe(true);
+    expect(tree.children![0].job.opts.failParentOnFailure).toBeUndefined();
+    await flow.close();
+  });
+
+  it('can opt out of copying parent data into child payloads', async () => {
+    const flow = new FlowGraphProducer({ connection, prefix });
+    const tree = await flow.addGraph(
+      {
+        id: 'graph_ref',
+        name: 'parent',
+        queueName,
+        data: {
+          expensive: 'payload',
+        },
+        children: [
+          {
+            name: 'child',
+            queueName,
+            data: {
+              child: true,
+            },
+          },
+        ],
+      },
+      {
+        copyParentDataToChildren: false,
+      },
+    );
+
+    expect(tree.children![0].job.data.parent.data).toBeUndefined();
+    await flow.close();
+  });
+});
diff --git a/tests/flow-graph-worker.test.ts b/tests/flow-graph-worker.test.ts
new file mode 100644
index 000000000..be9d5e849
--- /dev/null
+++ b/tests/flow-graph-worker.test.ts
@@ -0,0 +1,354 @@
+import { default as IORedis } from 'ioredis';
+import {
+  describe,
+  beforeEach,
+  afterEach,
+  beforeAll,
+  afterAll,
+  it,
+  expect,
+} from 'vitest';
+
+import {
+  FlowGraphProducer,
+  FlowGraphStatus,
+  FlowGraphWorker,
+  Queue,
+  Worker,
+} from '../src/classes';
+import { delay, randomUUID, removeAllQueueData } from '../src/utils';
+
+describe('flow graph worker', () => {
+  const redisHost = process.env.REDIS_HOST || 'localhost';
+  const prefix = process.env.BULLMQ_TEST_PREFIX || 'bull';
+
+  let connection: IORedis;
+  let queue: Queue;
+  let queueName: string;
+
+  beforeAll(async () => {
+    connection = new IORedis(redisHost, { maxRetriesPerRequest: null });
+  });
+
+  beforeEach(async () => {
+    queueName = `flow-graph-worker-${randomUUID()}`;
+    queue = new Queue(queueName, { connection, prefix });
+  });
+
+  afterEach(async () => {
+    await queue.close();
+    await removeAllQueueData(new IORedis(redisHost), queueName);
+  });
+
+  afterAll(async () => {
+    await connection.quit();
+  });
+
+  it('passes processed child values to the aggregate processor', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const childWorker = new Worker(
+      queueName,
+      async job => {
+        if (job.name === 'child-a') {
+          return {
+            value: 'a',
+          };
+        }
+        if (job.name === 'child-b') {
+          return {
+            value: 'b',
+          };
+        }
+        await delay(1);
+      },
+      { connection, prefix },
+    );
+    const parentResult = new Promise<void>((resolve, reject) => {
+      const parentWorker = new FlowGraphWorker(
+        queueName,
+        async aggregate => {
+          try {
+            expect(aggregate.complete).toBe(true);
+            expect(aggregate.processed).toBe(2);
+            expect(aggregate.failed).toBe(0);
+            expect(aggregate.children).toHaveLength(2);
+            await parentWorker.close();
+            resolve();
+          } catch (error) {
+            reject(error);
+          }
+        },
+        { connection, prefix },
+      );
+    });
+
+    await childWorker.waitUntilReady();
+    await producer.addGraph({
+      id: 'graph_success',
+      name: 'parent',
+      queueName,
+      children: [
+        {
+          name: 'child-a',
+          queueName,
+          data: {},
+        },
+        {
+          name: 'child-b',
+          queueName,
+          data: {},
+        },
+      ],
+    });
+
+    await parentResult;
+    await childWorker.close();
+    await producer.close();
+  });
+
+  it('completes the parent when a child fails in continue mode', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const childWorker = new Worker(
+      queueName,
+      async job => {
+        if (job.name === 'child-fails') {
+          throw new Error('child failed');
+        }
+        return {
+          ok: true,
+        };
+      },
+      { connection, prefix },
+    );
+
+    const parentResult = new Promise<void>((resolve, reject) => {
+      const parentWorker = new FlowGraphWorker(
+        queueName,
+        async aggregate => {
+          try {
+            expect(aggregate.complete).toBe(true);
+            expect(aggregate.failed).toBe(0);
+            expect(aggregate.pending).toBe(0);
+            expect(aggregate.processed).toBe(1);
+            await parentWorker.close();
+            resolve();
+          } catch (error) {
+            reject(error);
+          }
+        },
+        { connection, prefix },
+        {
+          failParentWhenAnyChildFails: true,
+        },
+      );
+    });
+
+    await childWorker.waitUntilReady();
+    const tree = await producer.addGraph({
+      id: 'graph_child_failure',
+      name: 'parent',
+      queueName,
+      failureMode: 'continue',
+      children: [
+        {
+          name: 'child-ok',
+          queueName,
+          data: {},
+        },
+        {
+          name: 'child-fails',
+          queueName,
+          data: {},
+        },
+      ],
+    });
+
+    await parentResult;
+    const status = new FlowGraphStatus();
+    const aggregate = await status.getAggregate(tree.job);
+    expect(aggregate.complete).toBe(true);
+    expect(aggregate.failed).toBe(0);
+
+    await childWorker.close();
+    await producer.close();
+  });
+
+  it('reports ignored failures only when callers inspect BullMQ dependencies directly', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const childWorker = new Worker(
+      queueName,
+      async () => {
+        throw new Error('ignored failure');
+      },
+      { connection, prefix },
+    );
+
+    await childWorker.waitUntilReady();
+    const tree = await producer.addGraph({
+      id: 'graph_ignored',
+      name: 'parent',
+      queueName,
+      failureMode: 'ignore-failed-children',
+      children: [
+        {
+          name: 'child',
+          queueName,
+          data: {},
+        },
+      ],
+    });
+
+    await new Promise<void>(resolve => {
+      const parentWorker = new FlowGraphWorker(
+        queueName,
+        async () => {
+          await parentWorker.close();
+          resolve();
+        },
+        { connection, prefix },
+      );
+    });
+
+    const dependencies = await tree.job.getDependencies({
+      ignored: {},
+    });
+    expect(Object.keys(dependencies.ignored!)).toHaveLength(1);
+
+    const status = await new FlowGraphStatus().getAggregate(tree.job);
+    expect(status.ignored).toBe(0);
+    expect(status.failed).toBe(0);
+
+    await childWorker.close();
+    await producer.close();
+  });
+});
diff --git a/tests/flow-graph-status.test.ts b/tests/flow-graph-status.test.ts
new file mode 100644
index 000000000..81bb9f871
--- /dev/null
+++ b/tests/flow-graph-status.test.ts
@@ -0,0 +1,438 @@
+import { default as IORedis } from 'ioredis';
+import {
+  describe,
+  beforeEach,
+  afterEach,
+  beforeAll,
+  afterAll,
+  it,
+  expect,
+} from 'vitest';
+
+import {
+  FlowGraphInspector,
+  FlowGraphProducer,
+  FlowGraphStatus,
+  Queue,
+  Worker,
+} from '../src/classes';
+import { delay, randomUUID, removeAllQueueData } from '../src/utils';
+
+describe('flow graph status', () => {
+  const redisHost = process.env.REDIS_HOST || 'localhost';
+  const prefix = process.env.BULLMQ_TEST_PREFIX || 'bull';
+
+  let connection: IORedis;
+  let queue: Queue;
+  let queueName: string;
+
+  beforeAll(async () => {
+    connection = new IORedis(redisHost, { maxRetriesPerRequest: null });
+  });
+
+  beforeEach(async () => {
+    queueName = `flow-graph-status-${randomUUID()}`;
+    queue = new Queue(queueName, { connection, prefix });
+  });
+
+  afterEach(async () => {
+    await queue.close();
+    await removeAllQueueData(new IORedis(redisHost), queueName);
+  });
+
+  afterAll(async () => {
+    await connection.quit();
+  });
+
+  it('summarizes a parent with pending children', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const tree = await producer.addGraph({
+      id: 'graph_pending',
+      name: 'parent',
+      queueName,
+      data: {
+        workspaceId: 'ws_pending',
+      },
+      children: [
+        {
+          name: 'child-a',
+          queueName,
+          data: {
+            index: 0,
+          },
+        },
+        {
+          name: 'child-b',
+          queueName,
+          data: {
+            index: 1,
+          },
+        },
+      ],
+    });
+
+    const aggregate = await new FlowGraphStatus().getAggregate(tree.job);
+
+    expect(aggregate.graphId).toBe('graph_pending');
+    expect(aggregate.total).toBe(2);
+    expect(aggregate.processed).toBe(0);
+    expect(aggregate.failed).toBe(0);
+    expect(aggregate.ignored).toBe(0);
+    expect(aggregate.pending).toBe(2);
+    expect(aggregate.complete).toBe(false);
+    expect(aggregate.children).toEqual([]);
+
+    await producer.close();
+  });
+
+  it('summarizes processed child return values after the graph finishes', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const worker = new Worker(
+      queueName,
+      async job => {
+        if (job.name === 'parent') {
+          return {
+            parent: true,
+          };
+        }
+
+        return {
+          name: job.name,
+          childIndex: job.data.child.index,
+        };
+      },
+      { connection, prefix },
+    );
+
+    await worker.waitUntilReady();
+    const tree = await producer.addGraph({
+      id: 'graph_processed',
+      name: 'parent',
+      queueName,
+      children: [
+        {
+          name: 'child-a',
+          queueName,
+          data: {
+            index: 0,
+          },
+        },
+        {
+          name: 'child-b',
+          queueName,
+          data: {
+            index: 1,
+          },
+        },
+        {
+          name: 'child-c',
+          queueName,
+          data: {
+            index: 2,
+          },
+        },
+      ],
+    });
+
+    await waitForParentToMove(queue, tree.job.id!);
+    const aggregate = await new FlowGraphStatus().assertComplete(tree.job);
+
+    expect(aggregate.complete).toBe(true);
+    expect(aggregate.pending).toBe(0);
+    expect(aggregate.processed).toBe(3);
+    expect(aggregate.failed).toBe(0);
+    expect(aggregate.ignored).toBe(0);
+    expect(aggregate.children.map(child => child.value)).toEqual(
+      expect.arrayContaining([
+        {
+          name: 'child-a',
+          childIndex: 0,
+        },
+        {
+          name: 'child-b',
+          childIndex: 1,
+        },
+        {
+          name: 'child-c',
+          childIndex: 2,
+        },
+      ]),
+    );
+
+    await worker.close();
+    await producer.close();
+  });
+
+  it('formats an inspection report for operators', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const tree = await producer.addGraph({
+      id: 'graph_format',
+      name: 'format-parent',
+      queueName,
+      data: {
+        workspaceId: 'ws_format',
+        reportId: 'report_format',
+      },
+      children: [
+        {
+          name: 'child-a',
+          queueName,
+          data: {
+            index: 0,
+          },
+        },
+      ],
+    });
+
+    const inspector = new FlowGraphInspector();
+    const inspection = await inspector.inspect(tree.job, {
+      warnAfterPendingChildren: 0,
+      warnAfterPayloadBytes: 1,
+    });
+    const formatted = inspector.formatInspection(inspection);
+
+    expect(formatted).toContain('Flow graph graph_format');
+    expect(formatted).toContain('Parent name format-parent');
+    expect(formatted).toContain('Pending children 1');
+    expect(formatted).toContain('Warnings');
+    expect(inspection.warnings).toEqual(
+      expect.arrayContaining([
+        'flow graph has too many pending children: 1',
+      ]),
+    );
+
+    await producer.close();
+  });
+
+  it('marks a graph complete after a failed child is removed from dependencies', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const worker = new Worker(
+      queueName,
+      async job => {
+        if (job.name === 'will-fail') {
+          throw new Error('child boom');
+        }
+        if (job.name === 'parent') {
+          return {
+            parent: true,
+          };
+        }
+        return {
+          ok: true,
+        };
+      },
+      { connection, prefix },
+    );
+
+    await worker.waitUntilReady();
+    const tree = await producer.addGraph({
+      id: 'graph_removed_failure',
+      name: 'parent',
+      queueName,
+      failureMode: 'continue',
+      children: [
+        {
+          name: 'will-pass',
+          queueName,
+          data: {
+            required: true,
+          },
+        },
+        {
+          name: 'will-fail',
+          queueName,
+          data: {
+            required: true,
+          },
+        },
+      ],
+    });
+
+    await waitForParentToMove(queue, tree.job.id!);
+    const aggregate = await new FlowGraphStatus().getAggregate(tree.job);
+
+    expect(aggregate.complete).toBe(true);
+    expect(aggregate.failed).toBe(0);
+    expect(aggregate.ignored).toBe(0);
+    expect(aggregate.pending).toBe(0);
+    expect(aggregate.processed).toBe(1);
+    expect(aggregate.total).toBe(2);
+
+    const failedChild = tree.children!.find(child => child.job.name === 'will-fail')!;
+    const failedState = await failedChild.job.getState();
+    expect(failedState).toBe('failed');
+
+    await worker.close();
+    await producer.close();
+  });
+
+  it('does not include ignored failure metadata in the aggregate', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const worker = new Worker(
+      queueName,
+      async job => {
+        if (job.name === 'ignored-failure') {
+          throw new Error('ignored failure');
+        }
+        return {
+          ok: true,
+        };
+      },
+      { connection, prefix },
+    );
+
+    await worker.waitUntilReady();
+    const tree = await producer.addGraph({
+      id: 'graph_ignored_status',
+      name: 'parent',
+      queueName,
+      failureMode: 'ignore-failed-children',
+      children: [
+        {
+          name: 'ignored-failure',
+          queueName,
+          data: {
+            optional: true,
+          },
+        },
+      ],
+    });
+
+    await waitForParentToMove(queue, tree.job.id!);
+    const dependencies = await tree.job.getDependencies({
+      ignored: {},
+      failed: {},
+    });
+    const aggregate = await new FlowGraphStatus().getAggregate(tree.job);
+
+    expect(Object.keys(dependencies.ignored!)).toHaveLength(1);
+    expect(aggregate.complete).toBe(true);
+    expect(aggregate.failed).toBe(0);
+    expect(aggregate.ignored).toBe(0);
+    expect(aggregate.children).toEqual([]);
+
+    await worker.close();
+    await producer.close();
+  });
+
+  it('can include processed child values in inspection output', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const worker = new Worker(
+      queueName,
+      async job => {
+        if (job.name === 'parent') {
+          return {
+            parent: true,
+          };
+        }
+        return {
+          childName: job.name,
+          workspaceId: job.data.graph.context.workspaceId,
+        };
+      },
+      { connection, prefix },
+    );
+
+    await worker.waitUntilReady();
+    const tree = await producer.addGraph({
+      id: 'graph_child_values',
+      name: 'parent',
+      queueName,
+      context: {
+        workspaceId: 'ws_values',
+      },
+      children: [
+        {
+          name: 'child-a',
+          queueName,
+          data: {},
+        },
+        {
+          name: 'child-b',
+          queueName,
+          data: {},
+        },
+      ],
+    });
+
+    await waitForParentToMove(queue, tree.job.id!);
+    const inspection = await new FlowGraphInspector().inspect(tree.job, {
+      includeChildValues: true,
+    });
+
+    expect(inspection.childValues).toEqual(
+      expect.arrayContaining([
+        {
+          childName: 'child-a',
+          workspaceId: 'ws_values',
+        },
+        {
+          childName: 'child-b',
+          workspaceId: 'ws_values',
+        },
+      ]),
+    );
+    expect(inspection.aggregate.failed).toBe(0);
+    expect(inspection.aggregate.ignored).toBe(0);
+
+    await worker.close();
+    await producer.close();
+  });
+
+  it('estimates payload size from parent and processed values', async () => {
+    const producer = new FlowGraphProducer({ connection, prefix });
+    const tree = await producer.addGraph({
+      id: 'graph_payload',
+      name: 'parent',
+      queueName,
+      data: {
+        workspaceId: 'ws_payload',
+        filters: Array.from({ length: 20 }, (_, index) => ({
+          field: `field_${index}`,
+          value: `value_${index}`,
+        })),
+      },
+      context: {
+        permissions: Array.from({ length: 10 }, (_, index) => `permission_${index}`),
+      },
+      children: Array.from({ length: 3 }, (_, index) => ({
+        name: `child-${index}`,
+        queueName,
+        data: {
+          index,
+        },
+      })),
+    });
+
+    const inspection = await new FlowGraphInspector().inspect(tree.job, {
+      warnAfterPayloadBytes: 10,
+    });
+
+    expect(inspection.payload.parentBytes).toBeGreaterThan(10);
+    expect(inspection.payload.estimatedTotalBytes).toBeGreaterThan(10);
+    expect(inspection.warnings).toEqual(
+      expect.arrayContaining([
+        expect.stringContaining('flow graph aggregate payload is'),
+      ]),
+    );
+
+    for (const child of tree.children!) {
+      expect(child.job.data.parent.data.filters).toHaveLength(20);
+    }
+
+    await producer.close();
+  });
+
+  async function waitForParentToMove(queue: Queue, parentJobId: string): Promise<void> {
+    for (let attempt = 0; attempt < 100; attempt++) {
+      const job = await queue.getJob(parentJobId);
+      const state = await job!.getState();
+
+      if (state === 'waiting' || state === 'wait' || state === 'active' || state === 'completed') {
+        return;
+      }
+
+      await delay(25);
+    }
+
+    throw new Error(`parent job ${parentJobId} did not move out of waiting-children`);
+  }
+});
diff --git a/docs/gitbook/guide/flows/flow-graph-helper.md b/docs/gitbook/guide/flows/flow-graph-helper.md
new file mode 100644
index 000000000..d7e31c66e
--- /dev/null
+++ b/docs/gitbook/guide/flows/flow-graph-helper.md
@@ -0,0 +1,240 @@
+# Flow Graph Helper
+
+`FlowGraphProducer` is a convenience wrapper around `FlowProducer` for workloads
+where one logical operation is split into many child jobs and then aggregated by
+one parent job.
+
+## Creating a graph
+
+```ts
+import { FlowGraphProducer } from 'bullmq';
+
+const flow = new FlowGraphProducer({ connection });
+
+await flow.addGraph({
+  id: 'daily-report:2026-05-16',
+  name: 'build-report',
+  queueName: 'reports',
+  data: {
+    workspaceId: 'ws_123',
+    reportId: 'report_123',
+  },
+  context: {
+    actorId: 'user_123',
+    permissions: ['reports:read', 'reports:write'],
+  },
+  children: [
+    {
+      name: 'load-users',
+      queueName: 'reports',
+      data: { segment: 'users' },
+    },
+    {
+      name: 'load-usage',
+      queueName: 'reports',
+      data: { segment: 'usage' },
+    },
+  ],
+});
+```
+
+The parent job is created in the `waiting-children` state. Children are
+processed first. When all children are no longer pending, the parent job moves
+to `wait` and a `FlowGraphWorker` can process the aggregate.
+
+## Parent worker
+
+```ts
+import { FlowGraphWorker } from 'bullmq';
+
+new FlowGraphWorker(
+  'reports',
+  async aggregate => {
+    return {
+      graphId: aggregate.graphId,
+      processed: aggregate.processed,
+      children: aggregate.children,
+    };
+  },
+  { connection },
+);
+```
+
+The aggregate includes:
+
+- `total`,
+- `processed`,
+- `failed`,
+- `ignored`,
+- `pending`,
+- `children`.
+
+## Inspecting graph status
+
+`FlowGraphInspector` can be used by dashboards and operational tooling to
+summarize a graph without writing dependency inspection code at every call
+site.
+
+```ts
+import { FlowGraphInspector } from 'bullmq';
+
+const inspector = new FlowGraphInspector();
+const inspection = await inspector.inspect(parentJob, {
+  includeChildValues: true,
+  warnAfterPendingChildren: 100,
+  warnAfterPayloadBytes: 1024 * 1024,
+});
+
+console.log(inspector.formatInspection(inspection));
+```
+
+The inspection report includes the same aggregate status used by
+`FlowGraphWorker`, plus a payload estimate and warnings. If the graph is
+complete and no failed children are recorded, the report can be displayed as a
+successful graph summary.
+
+## Failure modes
+
+The default failure mode is `continue`. A failed child is removed from the
+parent dependency set, which allows the parent to continue once no children are
+pending.
+
+```ts
+await flow.addGraph({
+  name: 'best-effort-report',
+  queueName: 'reports',
+  failureMode: 'continue',
+  children: [
+    { name: 'optional-section', queueName: 'reports' },
+    { name: 'required-section', queueName: 'reports' },
+  ],
+});
+```
+
+Use `fail-parent` if child failure should fail the parent:
+
+```ts
+await flow.addGraph({
+  name: 'strict-report',
+  queueName: 'reports',
+  failureMode: 'fail-parent',
+  children: [
+    { name: 'required-section', queueName: 'reports' },
+  ],
+});
+```
+
+Use `ignore-failed-children` if failed child reasons should be stored in the
+parent dependency metadata but the parent should still continue.
+
+## Shared context
+
+By default, the helper copies parent data and graph context into every child
+job. This makes child processors self-contained:
+
+```ts
+new Worker('reports', async job => {
+  const workspaceId = job.data.parent.data.workspaceId;
+  const actorId = job.data.graph.context.actorId;
+  const segment = job.data.child.data.segment;
+});
+```
+
+For very large context objects, callers can opt out:
+
+```ts
+await flow.addGraph(graph, {
+  copyParentDataToChildren: false,
+  includeContextInChildren: false,
+});
+```
+
+When disabled, child processors should load parent context from an external
+store using the graph id.
+
+## Operational notes
+
+Graph child data is normal BullMQ job data. It is persisted in Redis as JSON
+and is subject to BullMQ job size limits. If a graph has many children, copied
+parent context increases total Redis memory usage.
+
+A parent aggregate is considered complete when no children are pending. Failed
+children in `continue` mode are not included in the aggregate because they have
+been removed from the dependency set. If callers need exact child failure
+counts, use `fail-parent` or inspect the original child jobs directly.
```

## Intended Flaws

### Flaw 1: Child failures are removed from dependencies and the parent aggregate reports success

The helper defaults to `failureMode: "continue"`, translates that into `removeDependencyOnFailure`, and then computes aggregate completion from only `processed` and `unprocessed` dependencies. A failed child disappears from the parent dependency set, so `FlowGraphStatus` reports `failed: 0`, `complete: true`, and the parent worker can complete successfully even when a child failed.

Relevant line references:

- `src/interfaces/flow-graph.ts:133-142` maps `continue` to `removeDependencyOnFailure`.
- `src/classes/flow-graph-producer.ts:45-50` defaults graphs to `continue` mode unless callers opt out.
- `src/classes/flow-graph-status.ts:11-35` reads only `processed` and `unprocessed` dependencies and hard-codes `failed: 0` and `ignored: 0`.
- `src/classes/flow-graph-inspector.ts:38-55` republishes the incomplete aggregate, and `src/classes/flow-graph-inspector.ts:157-161` treats a complete graph with no recorded failed children as a warning-worthy success state.
- `src/classes/flow-graph-worker.ts:22-28` trusts that aggregate and only throws if `aggregate.failed > 0`, which never happens for removed dependencies.
- `tests/flow-graph-worker.test.ts:109-155` asserts that a parent completes when one child failed and `failParentWhenAnyChildFails` is enabled.
- `tests/flow-graph-status.test.ts:207-266` asserts the failed child is actually failed while the parent aggregate still reports success.
- `docs/gitbook/guide/flows/flow-graph-helper.md:96-127` documents the default continue behavior as normal graph semantics, and `docs/gitbook/guide/flows/flow-graph-helper.md:161-165` documents invisible failed children as expected.

Why this is a real flaw:

BullMQ already has explicit failure modes because "child failed" is part of the parent-child contract. Removing a failed child from dependencies can be valid for a best-effort flow, but a helper that reports aggregate success must not erase that fact by default. The parent processor may publish a report, commit a batch, send a webhook, or mark a workflow complete while required child work failed. That is a correctness bug in queue graph semantics.

Better implementation direction:

Make failure propagation explicit and truthful. The helper should default to strict failure or require callers to choose a mode. Aggregate status must read `failed`, `ignored`, `processed`, and `unprocessed` dependency sets and expose child failures to the parent processor. For best-effort flows, failures should be visible as ignored/failed children rather than silently removed from the aggregate.

### Flaw 2: Parent data and shared context are copied into every child job

The helper materializes child payloads by embedding the full parent data and graph context in every child job. Since BullMQ stores job data as JSON in Redis, a large parent context multiplied across many children inflates Redis memory, increases network payloads, and can trip job `sizeLimit` unexpectedly.

Relevant line references:

- `src/classes/flow-graph-producer.ts:132-158` builds each child envelope with copied `graph.context` and copied `parent.data`.
- `src/classes/flow-graph-producer.ts:140-154` defaults both `includeContextInChildren` and `copyParentDataToChildren` to true.
- `tests/flow-graph-producer.test.ts:99-135` asserts that a large parent payload is copied into every child by default.
- `tests/flow-graph-status.test.ts:382-423` keeps exercising copied parent filters as ordinary child job data.
- `docs/gitbook/guide/flows/flow-graph-helper.md:130-155` recommends reading parent data and graph context directly from every child payload.
- `docs/gitbook/guide/flows/flow-graph-helper.md:156-164` acknowledges large context only as an opt-out rather than designing the default as references.

Why this is a real flaw:

BullMQ's real flow implementation stores compact parent references (`parentKey`, `parent`) rather than duplicating the parent payload into every child. Job data is persisted in Redis, serialized over the network, and checked against `sizeLimit`. Copying a 200 KB context into 500 child jobs turns one graph into 100 MB of Redis payload before processing starts. It also makes context updates impossible to reason about because each child has a stale snapshot.

Better implementation direction:

Store shared graph context once and pass references to children: `graphId`, parent job key, context key, or a caller-supplied loader. Keep child data specific to the child. If callers want self-contained payloads, make it an explicit opt-in with size warnings and tests for `sizeLimit`. The default helper should preserve BullMQ's reference-oriented parent-child model.

## Hints

### Flaw 1 Hints

1. What does BullMQ's `removeDependencyOnFailure` do to the parent's dependency set?
2. Which dependency categories does `FlowGraphStatus` inspect?
3. Can `failParentWhenAnyChildFails` ever fire if the aggregate always reports `failed: 0`?

### Flaw 2 Hints

1. Where does BullMQ store job data?
2. How many times does the parent payload appear for a graph with 500 children?
3. How does the real flow implementation represent the parent link inside a child job?

## Expected Answer

A strong review should say that the product-level change is a convenience API for flow graphs, but the implementation hides two core BullMQ contracts: failure propagation and Redis payload ownership.

For flaw 1, the learner should identify that the helper defaults to `continue`, sets `removeDependencyOnFailure`, and computes aggregate status without reading failed or ignored dependency metadata. The impact is parent jobs completing successfully after child failures, which can commit incomplete business workflows. The fix is explicit failure mode selection plus aggregate status that includes failed, ignored, processed, and unprocessed children.

For flaw 2, the learner should identify that parent data and graph context are copied into every child job by default. The impact is large Redis payloads, size-limit failures, higher latency, memory pressure, and stale context snapshots. The fix is reference-based shared context: pass graph id, parent key, or context key and load shared context once where needed.

The best answers should connect the flaws to BullMQ's existing contracts: flows are parent-child dependency graphs, failure behavior is controlled by explicit job options, parent failure metadata lives in dependency structures, and job data is serialized Redis payload.

## Expert Debrief

At the product level, this helper is attractive because many users want "run N jobs, then aggregate." The danger is that helper APIs can make a distributed state machine look simpler than it is. If the helper hides the state machine, it owns the correctness.

The first contract is failure truth. BullMQ has several failure options because there is no universal answer to "what should the parent do when a child fails?" This PR chooses a permissive default and then reports an aggregate that cannot see the failure. That is worse than choosing a best-effort mode; it tells the parent processor that the graph succeeded.

The second contract is payload ownership. Redis job data is not a free local object. It is serialized, stored, replicated, transmitted, and sometimes limited by `sizeLimit`. BullMQ's native parent relation stores compact references because that shape scales. Copying parent context into every child makes the graph cost grow with `parentContextSize * childCount`.

The failure modes are concrete:

- A required child fails and is removed from dependencies, then the parent publishes a successful aggregate.
- A processor using `failParentWhenAnyChildFails` does not fail because `aggregate.failed` is always zero.
- Operators inspect the parent aggregate and cannot see which child failed.
- A large shared context multiplies across hundreds of children and bloats Redis memory.
- A graph that worked in tests fails in production when parent context crosses `sizeLimit`.
- Children process stale copies of parent context after the parent is updated.

The reviewer thought process should be: first map the helper onto the underlying state machine. Which Redis sets/hashes are updated on child completion and failure? Which ones does the helper read? Second, inspect payload shape. Anything copied into every child is part of the queue's storage and network budget, not just TypeScript convenience.

The better implementation is a stricter API. Require callers to pick a failure policy or default to `fail-parent`. Read all dependency categories when building aggregates. For shared data, pass references and let processors load context explicitly. Convenience should reduce boilerplate without weakening the semantics users depend on.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: child failure is hidden by `removeDependencyOnFailure` plus incomplete aggregate inspection, and parent/context payloads are copied into every child. It explains parent jobs completing incorrectly, invisible failures, Redis memory/payload growth, and suggests explicit failure propagation plus reference-based shared context.
- `partial`: The answer finds one flaw completely and mentions either generic failure handling or large payloads without tying it to BullMQ's dependency sets, failure options, and Redis job data contract.
- `miss`: The answer focuses on naming, missing exports, TypeScript style, or generic helper API concerns while missing parent aggregate correctness and copied payload scale.
