# TS-017: Trigger.dev Run Graph

## Metadata

- `id`: TS-017
- `source_repo`: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
- `repo_area`: task run hierarchy, Prisma schema, run engine trigger path, run graph traversal, run detail API, run graph tests
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 896
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about run lineage, audit history, graph traversal, referential actions, cycle prevention, and scheduler deadlocks without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a run graph for parent-child task runs.

Customers often trigger child runs from a parent run and want to inspect the full execution graph: which run triggered which children, which branches failed, and what root run owns the tree. The PR adds a durable `TaskRunGraphEdge` table, creates an edge whenever a run is triggered with a parent, exposes a graph API for the run detail page, and adds helpers to fetch ancestors and descendants.

The PR adds:

- a new Prisma model and migration for `TaskRunGraphEdge`,
- a `RunGraphService` for linking runs and traversing ancestors/descendants,
- run-engine integration when a triggered run has `parentRunId`,
- an API route that returns graph nodes and edges for a run,
- presenter support for graph summaries on run detail,
- tests for creating parent-child edges and reading descendants.

## Existing Code Context

The real Trigger.dev codebase already has these relevant contracts:

- `internal-packages/database/prisma/schema.prisma` models `TaskRun` with `parentTaskRunId`, `rootTaskRunId`, `childRuns`, `descendantRuns`, and `depth`.
- The existing `TaskRun.parentTaskRun` and `TaskRun.rootTaskRun` relations use `onDelete: SetNull`, preserving child run history if an old parent run is removed.
- `apps/webapp/app/runEngine/services/triggerTask.server.ts` resolves `body.options.parentRunId`, validates the parent run, sets `parentTaskRunId`, `rootTaskRunId`, and `depth`, and propagates trace context.
- `apps/webapp/app/runEngine/validators/triggerTaskValidator.ts` rejects using a terminal parent for `triggerAndWait`, but it does not own graph traversal.
- `apps/webapp/app/v3/services/enqueueRun.server.ts` already treats recursive waits as a deadlock risk and returns `RECURSIVE_WAIT_DEADLOCK` when concurrency cannot be reserved.
- `apps/webapp/app/services/runsReplicationService.server.ts` replicates `rootTaskRunId`, `parentTaskRunId`, and `depth` into ClickHouse for query surfaces.
- `apps/webapp/app/services/metadata/updateMetadata.server.ts` uses parent/root run relations to apply metadata operations to the parent or root run.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `internal-packages/database/prisma/schema.prisma`
- `internal-packages/database/prisma/migrations/20260516103000_add_task_run_graph_edges/migration.sql`
- `apps/webapp/app/services/runGraph/runGraphService.server.ts`
- `apps/webapp/app/runEngine/services/triggerTask.server.ts`
- `apps/webapp/app/presenters/v3/RunGraphPresenter.server.ts`
- `apps/webapp/app/routes/api.v1.runs.$runId.graph.ts`
- `apps/webapp/app/routes/resources.runs.$runParam.ts`
- `apps/webapp/test/runGraph.test.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on storage semantics, graph traversal, trigger integration, and audit/history behavior.

## Diff

```diff
diff --git a/internal-packages/database/prisma/schema.prisma b/internal-packages/database/prisma/schema.prisma
index 0d26f0fb11..3c0d8c1704 100644
--- a/internal-packages/database/prisma/schema.prisma
+++ b/internal-packages/database/prisma/schema.prisma
@@ -1014,6 +1014,9 @@ model TaskRun {
   /// The immediate child runs of this task run
   childRuns TaskRun[] @relation("TaskParentRun")
 
+  parentGraphEdges TaskRunGraphEdge[] @relation("TaskRunGraphParent")
+  childGraphEdges  TaskRunGraphEdge[] @relation("TaskRunGraphChild")
+
   /// The immediate parent attempt of this task run
   parentTaskRunAttempt   TaskRunAttempt? @relation("TaskParentRunAttempt", fields: [parentTaskRunAttemptId], references: [id], onDelete: SetNull, onUpdate: NoAction)
   parentTaskRunAttemptId String?
@@ -1092,6 +1095,47 @@ model TaskRunTemplate {
   @@index([projectId, taskSlug, triggerSource, createdAt(sort: Desc)])
 }
 
+model TaskRunGraphEdge {
+  id String @id @default(cuid())
+
+  runtimeEnvironment   RuntimeEnvironment @relation(fields: [runtimeEnvironmentId], references: [id], onDelete: Cascade, onUpdate: Cascade)
+  runtimeEnvironmentId String
+
+  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade, onUpdate: Cascade)
+  projectId String
+
+  organizationId String?
+
+  rootRun   TaskRun @relation("TaskRunGraphRoot", fields: [rootRunId], references: [id], onDelete: Cascade, onUpdate: Cascade)
+  rootRunId String
+
+  parentRun   TaskRun @relation("TaskRunGraphParent", fields: [parentRunId], references: [id], onDelete: Cascade, onUpdate: Cascade)
+  parentRunId String
+
+  childRun   TaskRun @relation("TaskRunGraphChild", fields: [childRunId], references: [id], onDelete: Cascade, onUpdate: Cascade)
+  childRunId String
+
+  parentAttemptId String?
+
+  triggerSpanId String?
+
+  depth Int @default(0)
+
+  linkType String @default("trigger")
+
+  metadata Json?
+
+  createdAt DateTime @default(now())
+  updatedAt DateTime @updatedAt
+
+  @@unique([runtimeEnvironmentId, parentRunId, childRunId])
+  @@index([runtimeEnvironmentId, rootRunId, depth])
+  @@index([runtimeEnvironmentId, parentRunId])
+  @@index([runtimeEnvironmentId, childRunId])
+  @@index([createdAt], type: Brin)
+}
+
 model TaskRunExecutionSnapshot {
   id String @id @default(cuid())
diff --git a/internal-packages/database/prisma/migrations/20260516103000_add_task_run_graph_edges/migration.sql b/internal-packages/database/prisma/migrations/20260516103000_add_task_run_graph_edges/migration.sql
new file mode 100644
index 0000000000..c73f9a2f1b
--- /dev/null
+++ b/internal-packages/database/prisma/migrations/20260516103000_add_task_run_graph_edges/migration.sql
@@ -0,0 +1,94 @@
+CREATE TABLE IF NOT EXISTS "TaskRunGraphEdge" (
+  "id" TEXT NOT NULL,
+  "runtimeEnvironmentId" TEXT NOT NULL,
+  "projectId" TEXT NOT NULL,
+  "organizationId" TEXT,
+  "rootRunId" TEXT NOT NULL,
+  "parentRunId" TEXT NOT NULL,
+  "childRunId" TEXT NOT NULL,
+  "parentAttemptId" TEXT,
+  "triggerSpanId" TEXT,
+  "depth" INTEGER NOT NULL DEFAULT 0,
+  "linkType" TEXT NOT NULL DEFAULT 'trigger',
+  "metadata" JSONB,
+  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+  CONSTRAINT "TaskRunGraphEdge_pkey" PRIMARY KEY ("id")
+);
+
+ALTER TABLE "TaskRunGraphEdge"
+  ADD CONSTRAINT "TaskRunGraphEdge_runtimeEnvironmentId_fkey"
+  FOREIGN KEY ("runtimeEnvironmentId")
+  REFERENCES "RuntimeEnvironment"("id")
+  ON DELETE CASCADE
+  ON UPDATE CASCADE;
+
+ALTER TABLE "TaskRunGraphEdge"
+  ADD CONSTRAINT "TaskRunGraphEdge_projectId_fkey"
+  FOREIGN KEY ("projectId")
+  REFERENCES "Project"("id")
+  ON DELETE CASCADE
+  ON UPDATE CASCADE;
+
+ALTER TABLE "TaskRunGraphEdge"
+  ADD CONSTRAINT "TaskRunGraphEdge_rootRunId_fkey"
+  FOREIGN KEY ("rootRunId")
+  REFERENCES "TaskRun"("id")
+  ON DELETE CASCADE
+  ON UPDATE CASCADE;
+
+ALTER TABLE "TaskRunGraphEdge"
+  ADD CONSTRAINT "TaskRunGraphEdge_parentRunId_fkey"
+  FOREIGN KEY ("parentRunId")
+  REFERENCES "TaskRun"("id")
+  ON DELETE CASCADE
+  ON UPDATE CASCADE;
+
+ALTER TABLE "TaskRunGraphEdge"
+  ADD CONSTRAINT "TaskRunGraphEdge_childRunId_fkey"
+  FOREIGN KEY ("childRunId")
+  REFERENCES "TaskRun"("id")
+  ON DELETE CASCADE
+  ON UPDATE CASCADE;
+
+CREATE UNIQUE INDEX IF NOT EXISTS "TaskRunGraphEdge_runtime_parent_child_key"
+  ON "TaskRunGraphEdge"("runtimeEnvironmentId", "parentRunId", "childRunId");
+
+CREATE INDEX IF NOT EXISTS "TaskRunGraphEdge_root_depth_idx"
+  ON "TaskRunGraphEdge"("runtimeEnvironmentId", "rootRunId", "depth");
+
+CREATE INDEX IF NOT EXISTS "TaskRunGraphEdge_parent_idx"
+  ON "TaskRunGraphEdge"("runtimeEnvironmentId", "parentRunId");
+
+CREATE INDEX IF NOT EXISTS "TaskRunGraphEdge_child_idx"
+  ON "TaskRunGraphEdge"("runtimeEnvironmentId", "childRunId");
+
+INSERT INTO "TaskRunGraphEdge" (
+  "id",
+  "runtimeEnvironmentId",
+  "projectId",
+  "organizationId",
+  "rootRunId",
+  "parentRunId",
+  "childRunId",
+  "depth",
+  "createdAt",
+  "updatedAt"
+)
+SELECT
+  CONCAT('edge_', child."id") AS "id",
+  child."runtimeEnvironmentId",
+  child."projectId",
+  child."organizationId",
+  COALESCE(child."rootTaskRunId", parent."rootTaskRunId", parent."id"),
+  child."parentTaskRunId",
+  child."id",
+  child."depth",
+  child."createdAt",
+  child."updatedAt"
+FROM "TaskRun" child
+JOIN "TaskRun" parent ON parent."id" = child."parentTaskRunId"
+WHERE child."parentTaskRunId" IS NOT NULL
+ON CONFLICT ("runtimeEnvironmentId", "parentRunId", "childRunId") DO NOTHING;
diff --git a/apps/webapp/app/services/runGraph/runGraphService.server.ts b/apps/webapp/app/services/runGraph/runGraphService.server.ts
new file mode 100644
index 0000000000..2e328d41fb
--- /dev/null
+++ b/apps/webapp/app/services/runGraph/runGraphService.server.ts
@@ -0,0 +1,246 @@
+import { Prisma, TaskRun, TaskRunGraphEdge } from "@trigger.dev/database";
+import { prisma } from "~/db.server";
+import { logger } from "~/services/logger.server";
+
+type CreateEdgeOptions = {
+  runtimeEnvironmentId: string;
+  projectId: string;
+  organizationId?: string | null;
+  parentRunId: string;
+  childRunId: string;
+  parentAttemptId?: string | null;
+  triggerSpanId?: string | null;
+  linkType?: "trigger" | "replay" | "manual";
+  metadata?: Prisma.InputJsonValue;
+};
+
+type GraphNode = Pick<
+  TaskRun,
+  | "id"
+  | "friendlyId"
+  | "taskIdentifier"
+  | "status"
+  | "createdAt"
+  | "completedAt"
+  | "parentTaskRunId"
+  | "rootTaskRunId"
+  | "depth"
+>;
+
+type GraphEdge = Pick<
+  TaskRunGraphEdge,
+  "id" | "parentRunId" | "childRunId" | "rootRunId" | "depth" | "linkType" | "createdAt"
+>;
+
+export type RunGraph = {
+  rootRunId: string;
+  focusRunId: string;
+  nodes: GraphNode[];
+  edges: GraphEdge[];
+};
+
+const nodeSelect = {
+  id: true,
+  friendlyId: true,
+  taskIdentifier: true,
+  status: true,
+  createdAt: true,
+  completedAt: true,
+  parentTaskRunId: true,
+  rootTaskRunId: true,
+  depth: true,
+} satisfies Prisma.TaskRunSelect;
+
+export class RunGraphService {
+  async createEdge(options: CreateEdgeOptions): Promise<TaskRunGraphEdge> {
+    const [parentRun, childRun] = await Promise.all([
+      prisma.taskRun.findFirst({
+        where: {
+          id: options.parentRunId,
+          runtimeEnvironmentId: options.runtimeEnvironmentId,
+        },
+        select: {
+          id: true,
+          rootTaskRunId: true,
+          parentTaskRunId: true,
+          depth: true,
+          taskIdentifier: true,
+        },
+      }),
+      prisma.taskRun.findFirst({
+        where: {
+          id: options.childRunId,
+          runtimeEnvironmentId: options.runtimeEnvironmentId,
+        },
+        select: {
+          id: true,
+          rootTaskRunId: true,
+          parentTaskRunId: true,
+          depth: true,
+          taskIdentifier: true,
+        },
+      }),
+    ]);
+
+    if (!parentRun || !childRun) {
+      throw new Error("Both parent and child runs must exist in the same environment");
+    }
+
+    const rootRunId = parentRun.rootTaskRunId ?? parentRun.id;
+    const depth = parentRun.depth + 1;
+
+    const edge = await prisma.taskRunGraphEdge.upsert({
+      where: {
+        runtimeEnvironmentId_parentRunId_childRunId: {
+          runtimeEnvironmentId: options.runtimeEnvironmentId,
+          parentRunId: parentRun.id,
+          childRunId: childRun.id,
+        },
+      },
+      create: {
+        runtimeEnvironmentId: options.runtimeEnvironmentId,
+        projectId: options.projectId,
+        organizationId: options.organizationId,
+        rootRunId,
+        parentRunId: parentRun.id,
+        childRunId: childRun.id,
+        parentAttemptId: options.parentAttemptId,
+        triggerSpanId: options.triggerSpanId,
+        depth,
+        linkType: options.linkType ?? "trigger",
+        metadata: options.metadata,
+      },
+      update: {
+        rootRunId,
+        parentAttemptId: options.parentAttemptId,
+        triggerSpanId: options.triggerSpanId,
+        depth,
+        linkType: options.linkType ?? "trigger",
+        metadata: options.metadata,
+      },
+    });
+
+    await prisma.taskRun.update({
+      where: {
+        id: childRun.id,
+      },
+      data: {
+        parentTaskRunId: parentRun.id,
+        rootTaskRunId: rootRunId,
+        depth,
+      },
+    });
+
+    return edge;
+  }
+
+  async getGraphForRun(runId: string, runtimeEnvironmentId: string): Promise<RunGraph | null> {
+    const focusRun = await prisma.taskRun.findFirst({
+      where: {
+        id: runId,
+        runtimeEnvironmentId,
+      },
+      select: nodeSelect,
+    });
+
+    if (!focusRun) {
+      return null;
+    }
+
+    const rootRunId = focusRun.rootTaskRunId ?? focusRun.id;
+    const edges = await prisma.taskRunGraphEdge.findMany({
+      where: {
+        runtimeEnvironmentId,
+        rootRunId,
+      },
+      orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
+      select: {
+        id: true,
+        parentRunId: true,
+        childRunId: true,
+        rootRunId: true,
+        depth: true,
+        linkType: true,
+        createdAt: true,
+      },
+    });
+
+    const nodeIds = new Set<string>([rootRunId, focusRun.id]);
+    for (const edge of edges) {
+      nodeIds.add(edge.parentRunId);
+      nodeIds.add(edge.childRunId);
+    }
+
+    const nodes = await prisma.taskRun.findMany({
+      where: {
+        runtimeEnvironmentId,
+        id: {
+          in: [...nodeIds],
+        },
+      },
+      select: nodeSelect,
+      orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
+    });
+
+    return {
+      rootRunId,
+      focusRunId: focusRun.id,
+      nodes,
+      edges,
+    };
+  }
+
+  async getAncestors(runId: string, runtimeEnvironmentId: string): Promise<GraphNode[]> {
+    const ancestors: GraphNode[] = [];
+    let current = await prisma.taskRun.findFirst({
+      where: {
+        id: runId,
+        runtimeEnvironmentId,
+      },
+      select: nodeSelect,
+    });
+
+    while (current?.parentTaskRunId) {
+      const parent = await prisma.taskRun.findFirst({
+        where: {
+          id: current.parentTaskRunId,
+          runtimeEnvironmentId,
+        },
+        select: nodeSelect,
+      });
+
+      if (!parent) {
+        break;
+      }
+
+      ancestors.push(parent);
+      current = parent;
+    }
+
+    return ancestors;
+  }
+
+  async getDescendants(runId: string, runtimeEnvironmentId: string): Promise<GraphNode[]> {
+    const descendants: GraphNode[] = [];
+    const queue = [runId];
+
+    while (queue.length > 0) {
+      const currentRunId = queue.shift()!;
+      const edges = await prisma.taskRunGraphEdge.findMany({
+        where: {
+          runtimeEnvironmentId,
+          parentRunId: currentRunId,
+        },
+        select: {
+          childRunId: true,
+        },
+      });
+
+      for (const edge of edges) {
+        const child = await prisma.taskRun.findFirst({
+          where: {
+            id: edge.childRunId,
+            runtimeEnvironmentId,
+          },
+          select: nodeSelect,
+        });
+
+        if (child) {
+          descendants.push(child);
+          queue.push(child.id);
+        }
+      }
+    }
+
+    return descendants;
+  }
+
+  async logGraphSummary(runId: string, runtimeEnvironmentId: string): Promise<void> {
+    const graph = await this.getGraphForRun(runId, runtimeEnvironmentId);
+    if (!graph) {
+      return;
+    }
+
+    logger.info("Run graph loaded", {
+      runId,
+      runtimeEnvironmentId,
+      nodeCount: graph.nodes.length,
+      edgeCount: graph.edges.length,
+    });
+  }
+}
diff --git a/apps/webapp/app/runEngine/services/triggerTask.server.ts b/apps/webapp/app/runEngine/services/triggerTask.server.ts
index c4d9a57df5..35d028f16a 100644
--- a/apps/webapp/app/runEngine/services/triggerTask.server.ts
+++ b/apps/webapp/app/runEngine/services/triggerTask.server.ts
@@ -36,6 +36,7 @@ import { triggerRacepointSystem } from "../racepoints/triggerRacepointSystem.ser
 import { RunAnnotations } from "../schemas/runAnnotations";
 import { TriggerTaskRequest } from "../types";
 import { DefaultTriggerTaskValidator } from "../validators/triggerTaskValidator";
+import { RunGraphService } from "~/services/runGraph/runGraphService.server";
 
 export class TriggerTaskService {
   private validator = new DefaultTriggerTaskValidator();
@@ -52,6 +53,7 @@ export class TriggerTaskService {
   private traceEventConcern = new DefaultTraceEventConcern();
   private idempotencyKeyConcern = new IdempotencyKeyConcern(this.prisma, this.engine, this.traceEventConcern);
   private triggerRacepointSystem = triggerRacepointSystem;
+  private runGraphService = new RunGraphService();
 
   async call(
     taskId: string,
@@ -388,6 +390,31 @@ export class TriggerTaskService {
                   : undefined,
                 machine: body.options?.machine,
                 priorityMs: body.options?.priority ? body.options.priority * 1_000 : undefined,
@@ -410,6 +437,32 @@ export class TriggerTaskService {
                 queueTimestamp:
                   options.queueTimestamp ??
                   (parentRun && body.options?.resumeParentOnCompletion
                     ? parentRun.queueTimestamp
                     : undefined),
               });
+
+              if (parentRun) {
+                await this.runGraphService.createEdge({
+                  runtimeEnvironmentId: environment.id,
+                  projectId: environment.projectId,
+                  organizationId: environment.organizationId,
+                  parentRunId: parentRun.id,
+                  childRunId: taskRun.id,
+                  parentAttemptId: body.options?.parentAttemptId,
+                  triggerSpanId:
+                    options.parentAsLinkType === "replay" ? undefined : event.traceparent?.spanId,
+                  linkType: options.replayedFromTaskRunFriendlyId ? "replay" : "trigger",
+                  metadata: {
+                    taskId,
+                    triggerSource,
+                    triggerAction,
+                    resumeParentOnCompletion: body.options?.resumeParentOnCompletion ?? false,
+                    idempotencyKey,
+                  },
+                });
+              }
 
               return {
                 isCached: false,
diff --git a/apps/webapp/app/presenters/v3/RunGraphPresenter.server.ts b/apps/webapp/app/presenters/v3/RunGraphPresenter.server.ts
new file mode 100644
index 0000000000..a55d21c0e4
--- /dev/null
+++ b/apps/webapp/app/presenters/v3/RunGraphPresenter.server.ts
@@ -0,0 +1,118 @@
+import { RunGraph, RunGraphService } from "~/services/runGraph/runGraphService.server";
+
+export type PresentedRunGraphNode = {
+  id: string;
+  friendlyId: string;
+  taskIdentifier: string;
+  status: string;
+  depth: number;
+  parentTaskRunId: string | null;
+  rootTaskRunId: string | null;
+  createdAt: string;
+  completedAt: string | null;
+  childrenCount: number;
+};
+
+export type PresentedRunGraphEdge = {
+  id: string;
+  parentRunId: string;
+  childRunId: string;
+  depth: number;
+  linkType: string;
+  createdAt: string;
+};
+
+export type PresentedRunGraph = {
+  rootRunId: string;
+  focusRunId: string;
+  nodes: PresentedRunGraphNode[];
+  edges: PresentedRunGraphEdge[];
+  summary: {
+    totalRuns: number;
+    totalEdges: number;
+    maxDepth: number;
+    failedRuns: number;
+    completedRuns: number;
+  };
+};
+
+export class RunGraphPresenter {
+  constructor(private runGraphService = new RunGraphService()) {}
+
+  async call(runId: string, runtimeEnvironmentId: string): Promise<PresentedRunGraph | null> {
+    const graph = await this.runGraphService.getGraphForRun(runId, runtimeEnvironmentId);
+    if (!graph) {
+      return null;
+    }
+
+    return this.present(graph);
+  }
+
+  present(graph: RunGraph): PresentedRunGraph {
+    const childCountByParent = new Map<string, number>();
+    for (const edge of graph.edges) {
+      childCountByParent.set(edge.parentRunId, (childCountByParent.get(edge.parentRunId) ?? 0) + 1);
+    }
+
+    const nodes = graph.nodes.map((node) => ({
+      id: node.id,
+      friendlyId: node.friendlyId,
+      taskIdentifier: node.taskIdentifier,
+      status: node.status,
+      depth: node.depth,
+      parentTaskRunId: node.parentTaskRunId,
+      rootTaskRunId: node.rootTaskRunId,
+      createdAt: node.createdAt.toISOString(),
+      completedAt: node.completedAt?.toISOString() ?? null,
+      childrenCount: childCountByParent.get(node.id) ?? 0,
+    }));
+
+    const edges = graph.edges.map((edge) => ({
+      id: edge.id,
+      parentRunId: edge.parentRunId,
+      childRunId: edge.childRunId,
+      depth: edge.depth,
+      linkType: edge.linkType,
+      createdAt: edge.createdAt.toISOString(),
+    }));
+
+    return {
+      rootRunId: graph.rootRunId,
+      focusRunId: graph.focusRunId,
+      nodes,
+      edges,
+      summary: {
+        totalRuns: nodes.length,
+        totalEdges: edges.length,
+        maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
+        failedRuns: nodes.filter((node) => node.status === "FAILED").length,
+        completedRuns: nodes.filter((node) => node.status === "COMPLETED").length,
+      },
+    };
+  }
+}
diff --git a/apps/webapp/app/routes/api.v1.runs.$runId.graph.ts b/apps/webapp/app/routes/api.v1.runs.$runId.graph.ts
new file mode 100644
index 0000000000..9eec9e0412
--- /dev/null
+++ b/apps/webapp/app/routes/api.v1.runs.$runId.graph.ts
@@ -0,0 +1,90 @@
+import { json, LoaderFunctionArgs } from "@remix-run/server-runtime";
+import { prisma } from "~/db.server";
+import { RunGraphPresenter } from "~/presenters/v3/RunGraphPresenter.server";
+import { authenticateApiRequest } from "~/services/apiAuth.server";
+
+export async function loader({ request, params }: LoaderFunctionArgs) {
+  const authentication = await authenticateApiRequest(request);
+  if (!authentication.ok) {
+    return json({ error: "Unauthorized" }, { status: 401 });
+  }
+
+  const runParam = params.runId;
+  if (!runParam) {
+    return json({ error: "Missing run id" }, { status: 400 });
+  }
+
+  const run = await prisma.taskRun.findFirst({
+    where: {
+      friendlyId: runParam,
+      runtimeEnvironmentId: authentication.environment.id,
+    },
+    select: {
+      id: true,
+      runtimeEnvironmentId: true,
+    },
+  });
+
+  if (!run) {
+    return json({ error: "Run not found" }, { status: 404 });
+  }
+
+  const presenter = new RunGraphPresenter();
+  const graph = await presenter.call(run.id, authentication.environment.id);
+
+  if (!graph) {
+    return json({ error: "Graph not found" }, { status: 404 });
+  }
+
+  return json({
+    data: graph,
+  });
+}
diff --git a/apps/webapp/app/routes/resources.runs.$runParam.ts b/apps/webapp/app/routes/resources.runs.$runParam.ts
index b4b4b8b6bb..90a018e9cf 100644
--- a/apps/webapp/app/routes/resources.runs.$runParam.ts
+++ b/apps/webapp/app/routes/resources.runs.$runParam.ts
@@ -12,6 +12,7 @@ import { requireUserId } from "~/services/session.server";
 import { findProjectBySlug } from "~/models/project.server";
 import { findRunByFriendlyId } from "~/models/taskRun.server";
 import { RunPresenter } from "~/presenters/v3/RunPresenter.server";
+import { RunGraphPresenter } from "~/presenters/v3/RunGraphPresenter.server";
 
 export async function loader({ request, params }: LoaderFunctionArgs) {
   const userId = await requireUserId(request);
@@ -63,9 +64,17 @@ export async function loader({ request, params }: LoaderFunctionArgs) {
     throw new Response("Run not found", { status: 404 });
   }
 
+  const graphPresenter = new RunGraphPresenter();
+  const graph = await graphPresenter.call(run.id, run.runtimeEnvironmentId);
+
   return json({
     run: RunPresenter.present(run),
+    graph,
   });
 }
diff --git a/apps/webapp/test/runGraph.test.ts b/apps/webapp/test/runGraph.test.ts
new file mode 100644
index 0000000000..cb56504c45
--- /dev/null
+++ b/apps/webapp/test/runGraph.test.ts
@@ -0,0 +1,224 @@
+import { describe, expect, it } from "vitest";
+import { PrismaClient } from "@trigger.dev/database";
+import { RunGraphPresenter } from "~/presenters/v3/RunGraphPresenter.server";
+import { RunGraphService } from "~/services/runGraph/runGraphService.server";
+
+const prisma = new PrismaClient();
+
+async function createRun({
+  id,
+  friendlyId,
+  environmentId,
+  projectId,
+  taskIdentifier,
+  status = "PENDING",
+  parentTaskRunId,
+  rootTaskRunId,
+  depth = 0,
+}: {
+  id: string;
+  friendlyId: string;
+  environmentId: string;
+  projectId: string;
+  taskIdentifier: string;
+  status?: string;
+  parentTaskRunId?: string;
+  rootTaskRunId?: string;
+  depth?: number;
+}) {
+  return await prisma.taskRun.create({
+    data: {
+      id,
+      friendlyId,
+      runtimeEnvironmentId: environmentId,
+      projectId,
+      taskIdentifier,
+      status,
+      traceId: `${id}-trace`,
+      spanId: `${id}-span`,
+      queue: "default",
+      payload: "{}",
+      runTags: [],
+      parentTaskRunId,
+      rootTaskRunId,
+      depth,
+    },
+  });
+}
+
+describe("RunGraphService", () => {
+  it("creates an edge and updates child lineage fields", async () => {
+    const service = new RunGraphService();
+    const environmentId = "env_graph_1";
+    const projectId = "proj_graph_1";
+
+    const parent = await createRun({
+      id: "run_parent_1",
+      friendlyId: "run_parent_1",
+      environmentId,
+      projectId,
+      taskIdentifier: "parent.task",
+      depth: 0,
+    });
+
+    const child = await createRun({
+      id: "run_child_1",
+      friendlyId: "run_child_1",
+      environmentId,
+      projectId,
+      taskIdentifier: "child.task",
+      depth: 0,
+    });
+
+    const edge = await service.createEdge({
+      runtimeEnvironmentId: environmentId,
+      projectId,
+      organizationId: "org_graph_1",
+      parentRunId: parent.id,
+      childRunId: child.id,
+      parentAttemptId: "attempt_1",
+      triggerSpanId: "span_1",
+    });
+
+    const updatedChild = await prisma.taskRun.findUniqueOrThrow({
+      where: {
+        id: child.id,
+      },
+    });
+
+    expect(edge.parentRunId).toBe(parent.id);
+    expect(edge.childRunId).toBe(child.id);
+    expect(edge.rootRunId).toBe(parent.id);
+    expect(updatedChild.parentTaskRunId).toBe(parent.id);
+    expect(updatedChild.rootTaskRunId).toBe(parent.id);
+    expect(updatedChild.depth).toBe(1);
+  });
+
+  it("returns a graph for a root run", async () => {
+    const service = new RunGraphService();
+    const presenter = new RunGraphPresenter(service);
+    const environmentId = "env_graph_2";
+    const projectId = "proj_graph_2";
+
+    const root = await createRun({
+      id: "run_root_2",
+      friendlyId: "run_root_2",
+      environmentId,
+      projectId,
+      taskIdentifier: "root.task",
+    });
+
+    const firstChild = await createRun({
+      id: "run_child_2a",
+      friendlyId: "run_child_2a",
+      environmentId,
+      projectId,
+      taskIdentifier: "child.a",
+    });
+
+    const secondChild = await createRun({
+      id: "run_child_2b",
+      friendlyId: "run_child_2b",
+      environmentId,
+      projectId,
+      taskIdentifier: "child.b",
+    });
+
+    await service.createEdge({
+      runtimeEnvironmentId: environmentId,
+      projectId,
+      parentRunId: root.id,
+      childRunId: firstChild.id,
+    });
+
+    await service.createEdge({
+      runtimeEnvironmentId: environmentId,
+      projectId,
+      parentRunId: firstChild.id,
+      childRunId: secondChild.id,
+    });
+
+    const graph = await presenter.call(root.id, environmentId);
+
+    expect(graph?.summary.totalRuns).toBe(3);
+    expect(graph?.summary.totalEdges).toBe(2);
+    expect(graph?.summary.maxDepth).toBe(2);
+  });
+
+  it("removes graph edges when a parent run is deleted", async () => {
+    const service = new RunGraphService();
+    const environmentId = "env_graph_3";
+    const projectId = "proj_graph_3";
+
+    const parent = await createRun({
+      id: "run_parent_3",
+      friendlyId: "run_parent_3",
+      environmentId,
+      projectId,
+      taskIdentifier: "parent.task",
+    });
+
+    const child = await createRun({
+      id: "run_child_3",
+      friendlyId: "run_child_3",
+      environmentId,
+      projectId,
+      taskIdentifier: "child.task",
+    });
+
+    await service.createEdge({
+      runtimeEnvironmentId: environmentId,
+      projectId,
+      parentRunId: parent.id,
+      childRunId: child.id,
+    });
+
+    await prisma.taskRun.delete({
+      where: {
+        id: parent.id,
+      },
+    });
+
+    const remainingEdges = await prisma.taskRunGraphEdge.findMany({
+      where: {
+        runtimeEnvironmentId: environmentId,
+      },
+    });
+
+    const reloadedChild = await prisma.taskRun.findUnique({
+      where: {
+        id: child.id,
+      },
+    });
+
+    expect(remainingEdges).toHaveLength(0);
+    expect(reloadedChild?.parentTaskRunId).toBeNull();
+  });
+
+  it("returns descendants for a run", async () => {
+    const service = new RunGraphService();
+    const environmentId = "env_graph_4";
+    const projectId = "proj_graph_4";
+
+    const root = await createRun({
+      id: "run_root_4",
+      friendlyId: "run_root_4",
+      environmentId,
+      projectId,
+      taskIdentifier: "root.task",
+    });
+
+    const child = await createRun({
+      id: "run_child_4",
+      friendlyId: "run_child_4",
+      environmentId,
+      projectId,
+      taskIdentifier: "child.task",
+    });
+
+    await service.createEdge({
+      runtimeEnvironmentId: environmentId,
+      projectId,
+      parentRunId: root.id,
+      childRunId: child.id,
+    });
+
+    const descendants = await service.getDescendants(root.id, environmentId);
+    expect(descendants.map((run) => run.id)).toEqual([child.id]);
+  });
+});
```

## Intended Flaws

### Flaw 1: Graph Edges Cascade-Delete Historical Run Lineage

- `type`: `data_modeling`
- `location`: `internal-packages/database/prisma/schema.prisma:1098-1129`, `internal-packages/database/prisma/migrations/20260516103000_add_task_run_graph_edges/migration.sql:18-49`, `apps/webapp/test/runGraph.test.ts:139-187`
- `learner_prompt`: If a parent run is deleted, what should happen to the child run's historical lineage and graph audit trail?

Expected answer:

- `identify`: The new graph edge table uses `onDelete: Cascade` for `rootRunId`, `parentRunId`, and `childRunId`. The migration creates the same `ON DELETE CASCADE` foreign keys, and the test blesses the behavior by expecting graph edges to disappear when the parent run is deleted. This conflicts with the existing `TaskRun.parentTaskRun` and `TaskRun.rootTaskRun` relations, which use `onDelete: SetNull` to preserve child run history when a linked run is removed.
- `impact`: Run graphs are audit/history data. If a cleanup job, retention policy, admin action, or privacy workflow deletes an old parent run, the child run loses the only explicit graph edge that explains why it exists. Support cannot reconstruct lineage, root-run summaries become inconsistent, and customers lose the graph precisely when investigating old or partial history.
- `fix_direction`: Do not cascade-delete graph history with run deletion. Use `onDelete: Restrict` if runs with graph edges should not be hard-deleted, or `SetNull` plus denormalized immutable fields such as `parentFriendlyId`, `parentTaskIdentifier`, `rootFriendlyId`, and `deletedParentAt`. Prefer tombstoning/pruning with explicit retention semantics over silent cascade deletion.

Hints:

1. Compare the new referential actions to the existing `parentTaskRun` and `rootTaskRun` relations in `internal-packages/database/prisma/schema.prisma`.
2. A graph for debugging old runs is history, not just cache.
3. The test that deletes the parent is not harmless; it codifies the data-loss behavior.

### Flaw 2: Run Graph Edges Have No Cycle Prevention

- `type`: `graph_invariant`
- `location`: `apps/webapp/app/services/runGraph/runGraphService.server.ts:44-118`, `apps/webapp/app/services/runGraph/runGraphService.server.ts:171-222`, `apps/webapp/app/runEngine/services/triggerTask.server.ts:437-461`, `apps/webapp/test/runGraph.test.ts:42-223`
- `learner_prompt`: What stops a run from becoming its own ancestor through replay, manual linking, idempotency reuse, or a future backfill?

Expected answer:

- `identify`: `RunGraphService.createEdge` only checks that both runs exist in the same environment. It does not reject `parentRunId === childRunId`, does not check whether the child is already an ancestor of the parent, and does not enforce a maximum graph depth. The traversal helpers `getAncestors` and `getDescendants` also have no visited set, so a cycle can loop forever or repeatedly return the same nodes.
- `impact`: A cycle corrupts `rootRunId` and `depth`, can make graph API requests hang, and can create scheduler or metadata propagation loops when code walks parent/root/descendant relationships. Recursive task patterns already exist in Trigger.dev, and the enqueue path explicitly treats recursive waits as deadlock-prone; a graph layer needs its own invariant instead of assuming trigger-time code always produces a tree.
- `fix_direction`: Enforce acyclic graph semantics before insert. At minimum reject self-links, verify the proposed child is not already an ancestor of the proposed parent, cap maximum depth, and add traversal visited sets as defense in depth. For stronger guarantees, use a closure table, materialized path with ancestor checks, or a database transaction that locks the two runs and validates lineage before writing the edge.

Hints:

1. Search for `visited`, `ancestor`, `cycle`, or `parentRunId === childRunId` in the new service.
2. A unique `(parent, child)` edge does not prevent `A -> B -> C -> A`.
3. Traversal code without a visited set turns graph corruption into request or worker hangs.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that the new graph-edge foreign keys cascade-delete lineage and that this weakens the existing run-history contract. Answers that only say "cascade can delete rows" are incomplete unless they explain why run graph lineage is audit data.

For flaw 2, a correct answer must identify the missing acyclic-graph invariant. Answers that only mention "could be recursive" are incomplete unless they explain self-links, ancestor checks, or traversal loops.

### Product-Level Change

The PR tries to make parent-child task runs easier to inspect as an explicit graph. That is a good product direction because customers debug workflows by asking "what did this run trigger, and what triggered it?"

### Changed Contracts

- Data contract: a new graph edge table becomes the durable representation of run lineage.
- Trigger contract: every parent-triggered run writes both `TaskRun.parentTaskRunId` and a graph edge.
- API contract: run detail can return graph nodes, edges, and summary counts.
- Traversal contract: services can fetch ancestors and descendants.
- Retention contract: deleting a run now affects graph history.

### Failure Modes

A customer investigates a failed import from last month. The root run was pruned by retention, but a child run remains because it has a longer retention class. Since the edge used `ON DELETE CASCADE`, the child no longer shows why it ran or which root import owned it.

A replay/backfill bug links `A -> B`, `B -> C`, and `C -> A`. `getDescendants(A)` keeps queueing the same nodes. The run graph endpoint hangs, and any future scheduler logic that walks descendants can loop.

### Reviewer Thought Process

A strong reviewer asks whether a new relation is operational cache or historical truth. If it is historical truth, cascade deletion is suspicious. The existing schema's `SetNull` is a local clue: the codebase already chose to preserve child runs when parents disappear.

Then the reviewer treats "graph" as a word with invariants. A tree needs one parent and no cycles. A graph traversal needs a visited set even if the database tries to prevent bad writes, because production data eventually finds edge cases.

### Better Implementation Direction

- Keep graph edges durable with `SetNull`/tombstones or restrict deletion of runs with graph edges.
- Denormalize immutable parent/root display fields onto the edge.
- Reject self-links and ancestor cycles inside the same transaction that creates the edge.
- Add a maximum depth aligned with the existing `TaskRun.depth` contract.
- Add visited-set protection to ancestor and descendant traversal.
- Add tests for self-link rejection, `A -> B -> A`, deleted parent history, and retention/pruning behavior.

## Why This Case Exists

This case teaches that data-model choices often decide whether an observability feature is trustworthy. A PR can make a graph render correctly today while quietly making historical debugging impossible and creating traversal failure modes for tomorrow.
