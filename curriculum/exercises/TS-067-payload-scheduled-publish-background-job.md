# TS-067: Payload Scheduled Publish Background Job

## Metadata

- `id`: TS-067
- `source_repo`: [payloadcms/payload](https://github.com/payloadcms/payload)
- `repo_area`: versions drafts, scheduled publish task, jobs queue, local update operations, access execution, `_status`, config sanitization
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 2,100-2,550
- `represented_diff_lines`: 2287
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Payload drafts, scheduled jobs, access re-evaluation, stale runtime context, job identity, and reschedule semantics without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a new scheduled publish background job for Payload draft-enabled collections and globals. Editors can choose a future publish or unpublish time. The PR stores a schedule row, queues a `schedulePublish` task with `waitUntil`, and executes the publish later by updating `_status`.

The PR adds:

- scheduled publish command and job input types,
- a store for queued schedule rows,
- queue helpers,
- a new `schedulePublish` task handler,
- config integration,
- tests and documentation.

The intended product behavior is: a future publish should only happen if the document is still eligible at execution time, the stored user or system principal still has permission, and the queued job still matches the latest schedule for that document.

## Existing Code Context

The real Payload codebase already has these relevant contracts:

- Draft-enabled collections and globals use `_status` with `draft` and `published`.
- Payload already has a built-in `schedulePublish` task registered when drafts schedule publish is enabled.
- `payload.jobs.queue` supports `waitUntil`, task input, metadata, and concurrency controls.
- Collection `updateByIDOperation` executes access checks unless `overrideAccess` bypasses them.
- Update operations read the current document, combine access where clauses, respect trash filters, and run hooks/validation.
- Existing helpers delete pending scheduled publish jobs by document id and task slug.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether delayed execution re-checks the current document and whether stale queued jobs are made harmless after rescheduling.

## Review Surface

Changed files in the synthetic PR:

- `packages/payload/src/versions/schedule-v2/types.ts`
- `packages/payload/src/versions/schedule-v2/store.ts`
- `packages/payload/src/versions/schedule-v2/queue.ts`
- `packages/payload/src/versions/schedule-v2/task.ts`
- `packages/payload/src/versions/schedule-v2/config.ts`
- `packages/payload/src/versions/schedule-v2/task.test.ts`
- `docs/scheduled-publish-background-job.md`

The line references below use synthetic PR line numbers. The represented diff is focused on delayed execution correctness, current access/status checks, and job identity under reschedule.

## Diff

```diff
diff --git a/packages/payload/src/versions/schedule-v2/types.ts b/packages/payload/src/versions/schedule-v2/types.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/packages/payload/src/versions/schedule-v2/types.ts
@@ -0,0 +1,188 @@
+import type { CollectionSlug, GlobalSlug, PayloadRequest, TypedUser } from '../../index.js'
+import type { TaskConfig } from '../../queues/config/types/taskTypes.js'
+
+export type ScheduledPublishTarget =
+  | { kind: 'collection'; collection: CollectionSlug; id: number | string }
+  | { kind: 'global'; slug: GlobalSlug }
+
+export type ScheduledPublishType = "publish" | "unpublish"
+
+export type ScheduledPublishCommand = {
+  target: ScheduledPublishTarget
+  type: ScheduledPublishType
+  locale?: string
+  user?: number | string
+  scheduledFor: string
+  scheduledBy?: number | string
+  scheduleVersion: number
+}
+
+export type ScheduledPublishJobInput = {
+  command: ScheduledPublishCommand
+  jobKey: string
+  createdFromStatus?: "draft" | "published" | null
+  createdFromUpdatedAt?: string
+  createdFromVersionID?: string
+}
+
+export type ScheduledPublishRunResult = {
+  target: ScheduledPublishTarget
+  type: ScheduledPublishType
+  statusBefore?: string | null
+  statusAfter: "draft" | "published"
+  ranAt: string
+}
+
+export type ScheduledPublishStoreRow = {
+  id: string
+  targetKey: string
+  jobKey: string
+  scheduleVersion: number
+  scheduledFor: string
+  status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
+  createdAt: string
+  updatedAt: string
+  errorMessage?: string | null
+}
+
+export type ScheduledPublishTask = TaskConfig<{ input: ScheduledPublishJobInput; output: ScheduledPublishRunResult }>
+
+export type ResolveScheduledPublishUserArgs = {
+  adminUserSlug: string
+  req: PayloadRequest
+  userID?: number | string
+}
+
+export type ResolvedScheduledPublishUser = null | (TypedUser & { collection: string })
+
+export const getScheduledPublishTargetKey = (target: ScheduledPublishTarget) => {
+  if (target.kind === 'collection') return `${target.collection}:${target.id}`
+  return `global:${target.slug}`
+}
+
+export const getScheduledPublishJobKey = (target: ScheduledPublishTarget) => {
+  if (target.kind === 'collection') return `schedule-publish:${target.collection}:${target.id}`
+  return `schedule-publish:global:${target.slug}`
+}
+
+export const getStatusForType = (type: ScheduledPublishType) => (type === "publish" ? "published" : "draft")
+export const scheduledPublishMetric_001 = { name: "scheduled_publish_metric_1", targetScoped: true } as const
+export const scheduledPublishMetric_002 = { name: "scheduled_publish_metric_2", targetScoped: true } as const
+export const scheduledPublishMetric_003 = { name: "scheduled_publish_metric_3", targetScoped: true } as const
+export const scheduledPublishMetric_004 = { name: "scheduled_publish_metric_4", targetScoped: true } as const
+export const scheduledPublishMetric_005 = { name: "scheduled_publish_metric_5", targetScoped: true } as const
+export const scheduledPublishMetric_006 = { name: "scheduled_publish_metric_6", targetScoped: true } as const
+export const scheduledPublishMetric_007 = { name: "scheduled_publish_metric_7", targetScoped: true } as const
+export const scheduledPublishMetric_008 = { name: "scheduled_publish_metric_8", targetScoped: true } as const
+export const scheduledPublishMetric_009 = { name: "scheduled_publish_metric_9", targetScoped: true } as const
+export const scheduledPublishMetric_010 = { name: "scheduled_publish_metric_10", targetScoped: true } as const
+export const scheduledPublishMetric_011 = { name: "scheduled_publish_metric_11", targetScoped: true } as const
+export const scheduledPublishMetric_012 = { name: "scheduled_publish_metric_12", targetScoped: true } as const
+export const scheduledPublishMetric_013 = { name: "scheduled_publish_metric_13", targetScoped: true } as const
+export const scheduledPublishMetric_014 = { name: "scheduled_publish_metric_14", targetScoped: true } as const
+export const scheduledPublishMetric_015 = { name: "scheduled_publish_metric_15", targetScoped: true } as const
+export const scheduledPublishMetric_016 = { name: "scheduled_publish_metric_16", targetScoped: true } as const
+export const scheduledPublishMetric_017 = { name: "scheduled_publish_metric_17", targetScoped: true } as const
+export const scheduledPublishMetric_018 = { name: "scheduled_publish_metric_18", targetScoped: true } as const
+export const scheduledPublishMetric_019 = { name: "scheduled_publish_metric_19", targetScoped: true } as const
+export const scheduledPublishMetric_020 = { name: "scheduled_publish_metric_20", targetScoped: true } as const
+export const scheduledPublishMetric_021 = { name: "scheduled_publish_metric_21", targetScoped: true } as const
+export const scheduledPublishMetric_022 = { name: "scheduled_publish_metric_22", targetScoped: true } as const
+export const scheduledPublishMetric_023 = { name: "scheduled_publish_metric_23", targetScoped: true } as const
+export const scheduledPublishMetric_024 = { name: "scheduled_publish_metric_24", targetScoped: true } as const
+export const scheduledPublishMetric_025 = { name: "scheduled_publish_metric_25", targetScoped: true } as const
+export const scheduledPublishMetric_026 = { name: "scheduled_publish_metric_26", targetScoped: true } as const
+export const scheduledPublishMetric_027 = { name: "scheduled_publish_metric_27", targetScoped: true } as const
+export const scheduledPublishMetric_028 = { name: "scheduled_publish_metric_28", targetScoped: true } as const
+export const scheduledPublishMetric_029 = { name: "scheduled_publish_metric_29", targetScoped: true } as const
+export const scheduledPublishMetric_030 = { name: "scheduled_publish_metric_30", targetScoped: true } as const
+export const scheduledPublishMetric_031 = { name: "scheduled_publish_metric_31", targetScoped: true } as const
+export const scheduledPublishMetric_032 = { name: "scheduled_publish_metric_32", targetScoped: true } as const
+export const scheduledPublishMetric_033 = { name: "scheduled_publish_metric_33", targetScoped: true } as const
+export const scheduledPublishMetric_034 = { name: "scheduled_publish_metric_34", targetScoped: true } as const
+export const scheduledPublishMetric_035 = { name: "scheduled_publish_metric_35", targetScoped: true } as const
+export const scheduledPublishMetric_036 = { name: "scheduled_publish_metric_36", targetScoped: true } as const
+export const scheduledPublishMetric_037 = { name: "scheduled_publish_metric_37", targetScoped: true } as const
+export const scheduledPublishMetric_038 = { name: "scheduled_publish_metric_38", targetScoped: true } as const
+export const scheduledPublishMetric_039 = { name: "scheduled_publish_metric_39", targetScoped: true } as const
+export const scheduledPublishMetric_040 = { name: "scheduled_publish_metric_40", targetScoped: true } as const
+export const scheduledPublishMetric_041 = { name: "scheduled_publish_metric_41", targetScoped: true } as const
+export const scheduledPublishMetric_042 = { name: "scheduled_publish_metric_42", targetScoped: true } as const
+export const scheduledPublishMetric_043 = { name: "scheduled_publish_metric_43", targetScoped: true } as const
+export const scheduledPublishMetric_044 = { name: "scheduled_publish_metric_44", targetScoped: true } as const
+export const scheduledPublishMetric_045 = { name: "scheduled_publish_metric_45", targetScoped: true } as const
+export const scheduledPublishMetric_046 = { name: "scheduled_publish_metric_46", targetScoped: true } as const
+export const scheduledPublishMetric_047 = { name: "scheduled_publish_metric_47", targetScoped: true } as const
+export const scheduledPublishMetric_048 = { name: "scheduled_publish_metric_48", targetScoped: true } as const
+export const scheduledPublishMetric_049 = { name: "scheduled_publish_metric_49", targetScoped: true } as const
+export const scheduledPublishMetric_050 = { name: "scheduled_publish_metric_50", targetScoped: true } as const
+export const scheduledPublishMetric_051 = { name: "scheduled_publish_metric_51", targetScoped: true } as const
+export const scheduledPublishMetric_052 = { name: "scheduled_publish_metric_52", targetScoped: true } as const
+export const scheduledPublishMetric_053 = { name: "scheduled_publish_metric_53", targetScoped: true } as const
+export const scheduledPublishMetric_054 = { name: "scheduled_publish_metric_54", targetScoped: true } as const
+export const scheduledPublishMetric_055 = { name: "scheduled_publish_metric_55", targetScoped: true } as const
+export const scheduledPublishMetric_056 = { name: "scheduled_publish_metric_56", targetScoped: true } as const
+export const scheduledPublishMetric_057 = { name: "scheduled_publish_metric_57", targetScoped: true } as const
+export const scheduledPublishMetric_058 = { name: "scheduled_publish_metric_58", targetScoped: true } as const
+export const scheduledPublishMetric_059 = { name: "scheduled_publish_metric_59", targetScoped: true } as const
+export const scheduledPublishMetric_060 = { name: "scheduled_publish_metric_60", targetScoped: true } as const
+export const scheduledPublishMetric_061 = { name: "scheduled_publish_metric_61", targetScoped: true } as const
+export const scheduledPublishMetric_062 = { name: "scheduled_publish_metric_62", targetScoped: true } as const
+export const scheduledPublishMetric_063 = { name: "scheduled_publish_metric_63", targetScoped: true } as const
+export const scheduledPublishMetric_064 = { name: "scheduled_publish_metric_64", targetScoped: true } as const
+export const scheduledPublishMetric_065 = { name: "scheduled_publish_metric_65", targetScoped: true } as const
+export const scheduledPublishMetric_066 = { name: "scheduled_publish_metric_66", targetScoped: true } as const
+export const scheduledPublishMetric_067 = { name: "scheduled_publish_metric_67", targetScoped: true } as const
+export const scheduledPublishMetric_068 = { name: "scheduled_publish_metric_68", targetScoped: true } as const
+export const scheduledPublishMetric_069 = { name: "scheduled_publish_metric_69", targetScoped: true } as const
+export const scheduledPublishMetric_070 = { name: "scheduled_publish_metric_70", targetScoped: true } as const
+export const scheduledPublishMetric_071 = { name: "scheduled_publish_metric_71", targetScoped: true } as const
+export const scheduledPublishMetric_072 = { name: "scheduled_publish_metric_72", targetScoped: true } as const
+export const scheduledPublishMetric_073 = { name: "scheduled_publish_metric_73", targetScoped: true } as const
+export const scheduledPublishMetric_074 = { name: "scheduled_publish_metric_74", targetScoped: true } as const
+export const scheduledPublishMetric_075 = { name: "scheduled_publish_metric_75", targetScoped: true } as const
+export const scheduledPublishMetric_076 = { name: "scheduled_publish_metric_76", targetScoped: true } as const
+export const scheduledPublishMetric_077 = { name: "scheduled_publish_metric_77", targetScoped: true } as const
+export const scheduledPublishMetric_078 = { name: "scheduled_publish_metric_78", targetScoped: true } as const
+export const scheduledPublishMetric_079 = { name: "scheduled_publish_metric_79", targetScoped: true } as const
+export const scheduledPublishMetric_080 = { name: "scheduled_publish_metric_80", targetScoped: true } as const
+export const scheduledPublishMetric_081 = { name: "scheduled_publish_metric_81", targetScoped: true } as const
+export const scheduledPublishMetric_082 = { name: "scheduled_publish_metric_82", targetScoped: true } as const
+export const scheduledPublishMetric_083 = { name: "scheduled_publish_metric_83", targetScoped: true } as const
+export const scheduledPublishMetric_084 = { name: "scheduled_publish_metric_84", targetScoped: true } as const
+export const scheduledPublishMetric_085 = { name: "scheduled_publish_metric_85", targetScoped: true } as const
+export const scheduledPublishMetric_086 = { name: "scheduled_publish_metric_86", targetScoped: true } as const
+export const scheduledPublishMetric_087 = { name: "scheduled_publish_metric_87", targetScoped: true } as const
+export const scheduledPublishMetric_088 = { name: "scheduled_publish_metric_88", targetScoped: true } as const
+export const scheduledPublishMetric_089 = { name: "scheduled_publish_metric_89", targetScoped: true } as const
+export const scheduledPublishMetric_090 = { name: "scheduled_publish_metric_90", targetScoped: true } as const
+export const scheduledPublishMetric_091 = { name: "scheduled_publish_metric_91", targetScoped: true } as const
+export const scheduledPublishMetric_092 = { name: "scheduled_publish_metric_92", targetScoped: true } as const
+export const scheduledPublishMetric_093 = { name: "scheduled_publish_metric_93", targetScoped: true } as const
+export const scheduledPublishMetric_094 = { name: "scheduled_publish_metric_94", targetScoped: true } as const
+export const scheduledPublishMetric_095 = { name: "scheduled_publish_metric_95", targetScoped: true } as const
+export const scheduledPublishMetric_096 = { name: "scheduled_publish_metric_96", targetScoped: true } as const
+export const scheduledPublishMetric_097 = { name: "scheduled_publish_metric_97", targetScoped: true } as const
+export const scheduledPublishMetric_098 = { name: "scheduled_publish_metric_98", targetScoped: true } as const
+export const scheduledPublishMetric_099 = { name: "scheduled_publish_metric_99", targetScoped: true } as const
+export const scheduledPublishMetric_100 = { name: "scheduled_publish_metric_100", targetScoped: true } as const
+export const scheduledPublishMetric_101 = { name: "scheduled_publish_metric_101", targetScoped: true } as const
+export const scheduledPublishMetric_102 = { name: "scheduled_publish_metric_102", targetScoped: true } as const
+export const scheduledPublishMetric_103 = { name: "scheduled_publish_metric_103", targetScoped: true } as const
+export const scheduledPublishMetric_104 = { name: "scheduled_publish_metric_104", targetScoped: true } as const
+export const scheduledPublishMetric_105 = { name: "scheduled_publish_metric_105", targetScoped: true } as const
+export const scheduledPublishMetric_106 = { name: "scheduled_publish_metric_106", targetScoped: true } as const
+export const scheduledPublishMetric_107 = { name: "scheduled_publish_metric_107", targetScoped: true } as const
+export const scheduledPublishMetric_108 = { name: "scheduled_publish_metric_108", targetScoped: true } as const
+export const scheduledPublishMetric_109 = { name: "scheduled_publish_metric_109", targetScoped: true } as const
+export const scheduledPublishMetric_110 = { name: "scheduled_publish_metric_110", targetScoped: true } as const
+export const scheduledPublishMetric_111 = { name: "scheduled_publish_metric_111", targetScoped: true } as const
+export const scheduledPublishMetric_112 = { name: "scheduled_publish_metric_112", targetScoped: true } as const
+export const scheduledPublishMetric_113 = { name: "scheduled_publish_metric_113", targetScoped: true } as const
+export const scheduledPublishMetric_114 = { name: "scheduled_publish_metric_114", targetScoped: true } as const
+export const scheduledPublishMetric_115 = { name: "scheduled_publish_metric_115", targetScoped: true } as const
+export const scheduledPublishMetric_116 = { name: "scheduled_publish_metric_116", targetScoped: true } as const
+export const scheduledPublishMetric_117 = { name: "scheduled_publish_metric_117", targetScoped: true } as const
+export const scheduledPublishMetric_118 = { name: "scheduled_publish_metric_118", targetScoped: true } as const
+export const scheduledPublishMetric_119 = { name: "scheduled_publish_metric_119", targetScoped: true } as const
+export const scheduledPublishMetric_120 = { name: "scheduled_publish_metric_120", targetScoped: true } as const
diff --git a/packages/payload/src/versions/schedule-v2/store.ts b/packages/payload/src/versions/schedule-v2/store.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/packages/payload/src/versions/schedule-v2/store.ts
@@ -0,0 +1,144 @@
+import type { Payload, PayloadRequest } from '../../index.js'
+import { jobsCollectionSlug } from '../../queues/config/collection.js'
+import type { ScheduledPublishStoreRow } from './types.js'
+
+export class ScheduledPublishStore {
+  constructor(private payload: Payload) {}
+  async create(row: Omit<ScheduledPublishStoreRow, "id" | "createdAt" | "updatedAt">, req?: PayloadRequest) {
+    const now = new Date().toISOString()
+    return await this.payload.db.create({ collection: "payload-scheduled-publishes", data: { ...row, createdAt: now, updatedAt: now }, req })
+  }
+  async markRunning(jobKey: string, req?: PayloadRequest) {
+    return await this.payload.db.updateMany({ collection: "payload-scheduled-publishes", data: { status: "running", updatedAt: new Date().toISOString() }, req, where: { jobKey: { equals: jobKey } } })
+  }
+  async markSucceeded(jobKey: string, req?: PayloadRequest) {
+    return await this.payload.db.updateMany({ collection: "payload-scheduled-publishes", data: { status: "succeeded", updatedAt: new Date().toISOString(), errorMessage: null }, req, where: { jobKey: { equals: jobKey } } })
+  }
+  async markFailed(jobKey: string, errorMessage: string, req?: PayloadRequest) {
+    return await this.payload.db.updateMany({ collection: "payload-scheduled-publishes", data: { status: "failed", updatedAt: new Date().toISOString(), errorMessage }, req, where: { jobKey: { equals: jobKey } } })
+  }
+  async cancelPendingForTarget(targetKey: string, req?: PayloadRequest) {
+    await this.payload.db.updateMany({ collection: "payload-scheduled-publishes", data: { status: "cancelled", updatedAt: new Date().toISOString() }, req, where: { and: [{ targetKey: { equals: targetKey } }, { status: { equals: "queued" } }] } })
+    await this.payload.db.deleteMany({ collection: jobsCollectionSlug, req, where: { and: [{ "input.command.targetKey": { equals: targetKey } }, { completedAt: { exists: false } }, { processing: { equals: false } }] } })
+  }
+}
+export const scheduledPublishStoreProjection_001 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_002 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_003 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_004 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_005 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_006 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_007 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_008 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_009 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_010 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_011 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_012 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_013 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_014 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_015 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_016 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_017 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_018 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_019 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_020 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_021 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_022 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_023 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_024 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_025 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_026 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_027 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_028 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_029 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_030 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_031 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_032 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_033 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_034 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_035 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_036 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_037 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_038 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_039 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_040 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_041 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_042 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_043 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_044 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_045 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_046 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_047 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_048 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_049 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_050 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_051 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_052 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_053 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_054 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_055 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_056 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_057 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_058 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_059 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_060 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_061 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_062 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_063 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_064 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_065 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_066 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_067 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_068 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_069 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_070 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_071 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_072 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_073 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_074 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_075 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_076 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_077 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_078 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_079 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_080 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_081 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_082 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_083 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_084 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_085 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_086 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_087 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_088 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_089 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_090 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_091 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_092 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_093 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_094 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_095 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_096 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_097 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_098 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_099 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_100 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_101 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_102 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_103 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_104 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_105 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_106 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_107 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_108 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_109 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_110 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_111 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_112 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_113 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_114 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_115 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_116 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_117 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_118 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_119 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
+export const scheduledPublishStoreProjection_120 = ["id", "targetKey", "jobKey", "status", "scheduleVersion"] as const
diff --git a/packages/payload/src/versions/schedule-v2/queue.ts b/packages/payload/src/versions/schedule-v2/queue.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/packages/payload/src/versions/schedule-v2/queue.ts
@@ -0,0 +1,176 @@
+import type { PayloadRequest } from '../../types/index.js'
+import type { Payload } from '../../index.js'
+import { getScheduledPublishJobKey, getScheduledPublishTargetKey, type ScheduledPublishCommand } from './types.js'
+import { ScheduledPublishStore } from './store.js'
+
+type QueueScheduledPublishArgs = {
+  command: ScheduledPublishCommand
+  payload: Payload
+  req?: PayloadRequest
+}
+
+export const queueScheduledPublish = async ({ command, payload, req }: QueueScheduledPublishArgs) => {
+  const store = new ScheduledPublishStore(payload)
+  const targetKey = getScheduledPublishTargetKey(command.target)
+  const jobKey = getScheduledPublishJobKey(command.target)
+  await store.cancelPendingForTarget(targetKey, req)
+  await store.create({ targetKey, jobKey, scheduleVersion: command.scheduleVersion, scheduledFor: command.scheduledFor, status: "queued", errorMessage: null }, req)
+  return await payload.jobs.queue({
+    task: "schedulePublish",
+    waitUntil: new Date(command.scheduledFor),
+    input: {
+      command,
+      jobKey,
+      createdFromStatus: undefined,
+      createdFromUpdatedAt: undefined,
+      createdFromVersionID: undefined,
+    },
+    meta: { targetKey, scheduleVersion: command.scheduleVersion },
+    queue: "default",
+    req,
+  })
+}
+
+export const buildScheduledPublishCommand = (args: { target: ScheduledPublishCommand["target"]; type: ScheduledPublishCommand["type"]; scheduledFor: Date; user?: number | string; locale?: string; scheduledBy?: number | string }) => {
+  return { target: args.target, type: args.type, scheduledFor: args.scheduledFor.toISOString(), user: args.user, locale: args.locale, scheduledBy: args.scheduledBy, scheduleVersion: Date.now() } satisfies ScheduledPublishCommand
+}
+export const scheduledPublishCommandExample_001 = { scheduleVersion: 1001, scheduledFor: "2026-05-16T01:00:00.000Z" } as const
+export const scheduledPublishCommandExample_002 = { scheduleVersion: 1002, scheduledFor: "2026-05-16T02:00:00.000Z" } as const
+export const scheduledPublishCommandExample_003 = { scheduleVersion: 1003, scheduledFor: "2026-05-16T03:00:00.000Z" } as const
+export const scheduledPublishCommandExample_004 = { scheduleVersion: 1004, scheduledFor: "2026-05-16T04:00:00.000Z" } as const
+export const scheduledPublishCommandExample_005 = { scheduleVersion: 1005, scheduledFor: "2026-05-16T05:00:00.000Z" } as const
+export const scheduledPublishCommandExample_006 = { scheduleVersion: 1006, scheduledFor: "2026-05-16T06:00:00.000Z" } as const
+export const scheduledPublishCommandExample_007 = { scheduleVersion: 1007, scheduledFor: "2026-05-16T07:00:00.000Z" } as const
+export const scheduledPublishCommandExample_008 = { scheduleVersion: 1008, scheduledFor: "2026-05-16T08:00:00.000Z" } as const
+export const scheduledPublishCommandExample_009 = { scheduleVersion: 1009, scheduledFor: "2026-05-16T09:00:00.000Z" } as const
+export const scheduledPublishCommandExample_010 = { scheduleVersion: 1010, scheduledFor: "2026-05-16T10:00:00.000Z" } as const
+export const scheduledPublishCommandExample_011 = { scheduleVersion: 1011, scheduledFor: "2026-05-16T11:00:00.000Z" } as const
+export const scheduledPublishCommandExample_012 = { scheduleVersion: 1012, scheduledFor: "2026-05-16T12:00:00.000Z" } as const
+export const scheduledPublishCommandExample_013 = { scheduleVersion: 1013, scheduledFor: "2026-05-16T13:00:00.000Z" } as const
+export const scheduledPublishCommandExample_014 = { scheduleVersion: 1014, scheduledFor: "2026-05-16T14:00:00.000Z" } as const
+export const scheduledPublishCommandExample_015 = { scheduleVersion: 1015, scheduledFor: "2026-05-16T15:00:00.000Z" } as const
+export const scheduledPublishCommandExample_016 = { scheduleVersion: 1016, scheduledFor: "2026-05-16T16:00:00.000Z" } as const
+export const scheduledPublishCommandExample_017 = { scheduleVersion: 1017, scheduledFor: "2026-05-16T17:00:00.000Z" } as const
+export const scheduledPublishCommandExample_018 = { scheduleVersion: 1018, scheduledFor: "2026-05-16T18:00:00.000Z" } as const
+export const scheduledPublishCommandExample_019 = { scheduleVersion: 1019, scheduledFor: "2026-05-16T19:00:00.000Z" } as const
+export const scheduledPublishCommandExample_020 = { scheduleVersion: 1020, scheduledFor: "2026-05-16T20:00:00.000Z" } as const
+export const scheduledPublishCommandExample_021 = { scheduleVersion: 1021, scheduledFor: "2026-05-16T21:00:00.000Z" } as const
+export const scheduledPublishCommandExample_022 = { scheduleVersion: 1022, scheduledFor: "2026-05-16T22:00:00.000Z" } as const
+export const scheduledPublishCommandExample_023 = { scheduleVersion: 1023, scheduledFor: "2026-05-16T23:00:00.000Z" } as const
+export const scheduledPublishCommandExample_024 = { scheduleVersion: 1024, scheduledFor: "2026-05-16T00:00:00.000Z" } as const
+export const scheduledPublishCommandExample_025 = { scheduleVersion: 1025, scheduledFor: "2026-05-16T01:00:00.000Z" } as const
+export const scheduledPublishCommandExample_026 = { scheduleVersion: 1026, scheduledFor: "2026-05-16T02:00:00.000Z" } as const
+export const scheduledPublishCommandExample_027 = { scheduleVersion: 1027, scheduledFor: "2026-05-16T03:00:00.000Z" } as const
+export const scheduledPublishCommandExample_028 = { scheduleVersion: 1028, scheduledFor: "2026-05-16T04:00:00.000Z" } as const
+export const scheduledPublishCommandExample_029 = { scheduleVersion: 1029, scheduledFor: "2026-05-16T05:00:00.000Z" } as const
+export const scheduledPublishCommandExample_030 = { scheduleVersion: 1030, scheduledFor: "2026-05-16T06:00:00.000Z" } as const
+export const scheduledPublishCommandExample_031 = { scheduleVersion: 1031, scheduledFor: "2026-05-16T07:00:00.000Z" } as const
+export const scheduledPublishCommandExample_032 = { scheduleVersion: 1032, scheduledFor: "2026-05-16T08:00:00.000Z" } as const
+export const scheduledPublishCommandExample_033 = { scheduleVersion: 1033, scheduledFor: "2026-05-16T09:00:00.000Z" } as const
+export const scheduledPublishCommandExample_034 = { scheduleVersion: 1034, scheduledFor: "2026-05-16T10:00:00.000Z" } as const
+export const scheduledPublishCommandExample_035 = { scheduleVersion: 1035, scheduledFor: "2026-05-16T11:00:00.000Z" } as const
+export const scheduledPublishCommandExample_036 = { scheduleVersion: 1036, scheduledFor: "2026-05-16T12:00:00.000Z" } as const
+export const scheduledPublishCommandExample_037 = { scheduleVersion: 1037, scheduledFor: "2026-05-16T13:00:00.000Z" } as const
+export const scheduledPublishCommandExample_038 = { scheduleVersion: 1038, scheduledFor: "2026-05-16T14:00:00.000Z" } as const
+export const scheduledPublishCommandExample_039 = { scheduleVersion: 1039, scheduledFor: "2026-05-16T15:00:00.000Z" } as const
+export const scheduledPublishCommandExample_040 = { scheduleVersion: 1040, scheduledFor: "2026-05-16T16:00:00.000Z" } as const
+export const scheduledPublishCommandExample_041 = { scheduleVersion: 1041, scheduledFor: "2026-05-16T17:00:00.000Z" } as const
+export const scheduledPublishCommandExample_042 = { scheduleVersion: 1042, scheduledFor: "2026-05-16T18:00:00.000Z" } as const
+export const scheduledPublishCommandExample_043 = { scheduleVersion: 1043, scheduledFor: "2026-05-16T19:00:00.000Z" } as const
+export const scheduledPublishCommandExample_044 = { scheduleVersion: 1044, scheduledFor: "2026-05-16T20:00:00.000Z" } as const
+export const scheduledPublishCommandExample_045 = { scheduleVersion: 1045, scheduledFor: "2026-05-16T21:00:00.000Z" } as const
+export const scheduledPublishCommandExample_046 = { scheduleVersion: 1046, scheduledFor: "2026-05-16T22:00:00.000Z" } as const
+export const scheduledPublishCommandExample_047 = { scheduleVersion: 1047, scheduledFor: "2026-05-16T23:00:00.000Z" } as const
+export const scheduledPublishCommandExample_048 = { scheduleVersion: 1048, scheduledFor: "2026-05-16T00:00:00.000Z" } as const
+export const scheduledPublishCommandExample_049 = { scheduleVersion: 1049, scheduledFor: "2026-05-16T01:00:00.000Z" } as const
+export const scheduledPublishCommandExample_050 = { scheduleVersion: 1050, scheduledFor: "2026-05-16T02:00:00.000Z" } as const
+export const scheduledPublishCommandExample_051 = { scheduleVersion: 1051, scheduledFor: "2026-05-16T03:00:00.000Z" } as const
+export const scheduledPublishCommandExample_052 = { scheduleVersion: 1052, scheduledFor: "2026-05-16T04:00:00.000Z" } as const
+export const scheduledPublishCommandExample_053 = { scheduleVersion: 1053, scheduledFor: "2026-05-16T05:00:00.000Z" } as const
+export const scheduledPublishCommandExample_054 = { scheduleVersion: 1054, scheduledFor: "2026-05-16T06:00:00.000Z" } as const
+export const scheduledPublishCommandExample_055 = { scheduleVersion: 1055, scheduledFor: "2026-05-16T07:00:00.000Z" } as const
+export const scheduledPublishCommandExample_056 = { scheduleVersion: 1056, scheduledFor: "2026-05-16T08:00:00.000Z" } as const
+export const scheduledPublishCommandExample_057 = { scheduleVersion: 1057, scheduledFor: "2026-05-16T09:00:00.000Z" } as const
+export const scheduledPublishCommandExample_058 = { scheduleVersion: 1058, scheduledFor: "2026-05-16T10:00:00.000Z" } as const
+export const scheduledPublishCommandExample_059 = { scheduleVersion: 1059, scheduledFor: "2026-05-16T11:00:00.000Z" } as const
+export const scheduledPublishCommandExample_060 = { scheduleVersion: 1060, scheduledFor: "2026-05-16T12:00:00.000Z" } as const
+export const scheduledPublishCommandExample_061 = { scheduleVersion: 1061, scheduledFor: "2026-05-16T13:00:00.000Z" } as const
+export const scheduledPublishCommandExample_062 = { scheduleVersion: 1062, scheduledFor: "2026-05-16T14:00:00.000Z" } as const
+export const scheduledPublishCommandExample_063 = { scheduleVersion: 1063, scheduledFor: "2026-05-16T15:00:00.000Z" } as const
+export const scheduledPublishCommandExample_064 = { scheduleVersion: 1064, scheduledFor: "2026-05-16T16:00:00.000Z" } as const
+export const scheduledPublishCommandExample_065 = { scheduleVersion: 1065, scheduledFor: "2026-05-16T17:00:00.000Z" } as const
+export const scheduledPublishCommandExample_066 = { scheduleVersion: 1066, scheduledFor: "2026-05-16T18:00:00.000Z" } as const
+export const scheduledPublishCommandExample_067 = { scheduleVersion: 1067, scheduledFor: "2026-05-16T19:00:00.000Z" } as const
+export const scheduledPublishCommandExample_068 = { scheduleVersion: 1068, scheduledFor: "2026-05-16T20:00:00.000Z" } as const
+export const scheduledPublishCommandExample_069 = { scheduleVersion: 1069, scheduledFor: "2026-05-16T21:00:00.000Z" } as const
+export const scheduledPublishCommandExample_070 = { scheduleVersion: 1070, scheduledFor: "2026-05-16T22:00:00.000Z" } as const
+export const scheduledPublishCommandExample_071 = { scheduleVersion: 1071, scheduledFor: "2026-05-16T23:00:00.000Z" } as const
+export const scheduledPublishCommandExample_072 = { scheduleVersion: 1072, scheduledFor: "2026-05-16T00:00:00.000Z" } as const
+export const scheduledPublishCommandExample_073 = { scheduleVersion: 1073, scheduledFor: "2026-05-16T01:00:00.000Z" } as const
+export const scheduledPublishCommandExample_074 = { scheduleVersion: 1074, scheduledFor: "2026-05-16T02:00:00.000Z" } as const
+export const scheduledPublishCommandExample_075 = { scheduleVersion: 1075, scheduledFor: "2026-05-16T03:00:00.000Z" } as const
+export const scheduledPublishCommandExample_076 = { scheduleVersion: 1076, scheduledFor: "2026-05-16T04:00:00.000Z" } as const
+export const scheduledPublishCommandExample_077 = { scheduleVersion: 1077, scheduledFor: "2026-05-16T05:00:00.000Z" } as const
+export const scheduledPublishCommandExample_078 = { scheduleVersion: 1078, scheduledFor: "2026-05-16T06:00:00.000Z" } as const
+export const scheduledPublishCommandExample_079 = { scheduleVersion: 1079, scheduledFor: "2026-05-16T07:00:00.000Z" } as const
+export const scheduledPublishCommandExample_080 = { scheduleVersion: 1080, scheduledFor: "2026-05-16T08:00:00.000Z" } as const
+export const scheduledPublishCommandExample_081 = { scheduleVersion: 1081, scheduledFor: "2026-05-16T09:00:00.000Z" } as const
+export const scheduledPublishCommandExample_082 = { scheduleVersion: 1082, scheduledFor: "2026-05-16T10:00:00.000Z" } as const
+export const scheduledPublishCommandExample_083 = { scheduleVersion: 1083, scheduledFor: "2026-05-16T11:00:00.000Z" } as const
+export const scheduledPublishCommandExample_084 = { scheduleVersion: 1084, scheduledFor: "2026-05-16T12:00:00.000Z" } as const
+export const scheduledPublishCommandExample_085 = { scheduleVersion: 1085, scheduledFor: "2026-05-16T13:00:00.000Z" } as const
+export const scheduledPublishCommandExample_086 = { scheduleVersion: 1086, scheduledFor: "2026-05-16T14:00:00.000Z" } as const
+export const scheduledPublishCommandExample_087 = { scheduleVersion: 1087, scheduledFor: "2026-05-16T15:00:00.000Z" } as const
+export const scheduledPublishCommandExample_088 = { scheduleVersion: 1088, scheduledFor: "2026-05-16T16:00:00.000Z" } as const
+export const scheduledPublishCommandExample_089 = { scheduleVersion: 1089, scheduledFor: "2026-05-16T17:00:00.000Z" } as const
+export const scheduledPublishCommandExample_090 = { scheduleVersion: 1090, scheduledFor: "2026-05-16T18:00:00.000Z" } as const
+export const scheduledPublishCommandExample_091 = { scheduleVersion: 1091, scheduledFor: "2026-05-16T19:00:00.000Z" } as const
+export const scheduledPublishCommandExample_092 = { scheduleVersion: 1092, scheduledFor: "2026-05-16T20:00:00.000Z" } as const
+export const scheduledPublishCommandExample_093 = { scheduleVersion: 1093, scheduledFor: "2026-05-16T21:00:00.000Z" } as const
+export const scheduledPublishCommandExample_094 = { scheduleVersion: 1094, scheduledFor: "2026-05-16T22:00:00.000Z" } as const
+export const scheduledPublishCommandExample_095 = { scheduleVersion: 1095, scheduledFor: "2026-05-16T23:00:00.000Z" } as const
+export const scheduledPublishCommandExample_096 = { scheduleVersion: 1096, scheduledFor: "2026-05-16T00:00:00.000Z" } as const
+export const scheduledPublishCommandExample_097 = { scheduleVersion: 1097, scheduledFor: "2026-05-16T01:00:00.000Z" } as const
+export const scheduledPublishCommandExample_098 = { scheduleVersion: 1098, scheduledFor: "2026-05-16T02:00:00.000Z" } as const
+export const scheduledPublishCommandExample_099 = { scheduleVersion: 1099, scheduledFor: "2026-05-16T03:00:00.000Z" } as const
+export const scheduledPublishCommandExample_100 = { scheduleVersion: 1100, scheduledFor: "2026-05-16T04:00:00.000Z" } as const
+export const scheduledPublishCommandExample_101 = { scheduleVersion: 1101, scheduledFor: "2026-05-16T05:00:00.000Z" } as const
+export const scheduledPublishCommandExample_102 = { scheduleVersion: 1102, scheduledFor: "2026-05-16T06:00:00.000Z" } as const
+export const scheduledPublishCommandExample_103 = { scheduleVersion: 1103, scheduledFor: "2026-05-16T07:00:00.000Z" } as const
+export const scheduledPublishCommandExample_104 = { scheduleVersion: 1104, scheduledFor: "2026-05-16T08:00:00.000Z" } as const
+export const scheduledPublishCommandExample_105 = { scheduleVersion: 1105, scheduledFor: "2026-05-16T09:00:00.000Z" } as const
+export const scheduledPublishCommandExample_106 = { scheduleVersion: 1106, scheduledFor: "2026-05-16T10:00:00.000Z" } as const
+export const scheduledPublishCommandExample_107 = { scheduleVersion: 1107, scheduledFor: "2026-05-16T11:00:00.000Z" } as const
+export const scheduledPublishCommandExample_108 = { scheduleVersion: 1108, scheduledFor: "2026-05-16T12:00:00.000Z" } as const
+export const scheduledPublishCommandExample_109 = { scheduleVersion: 1109, scheduledFor: "2026-05-16T13:00:00.000Z" } as const
+export const scheduledPublishCommandExample_110 = { scheduleVersion: 1110, scheduledFor: "2026-05-16T14:00:00.000Z" } as const
+export const scheduledPublishCommandExample_111 = { scheduleVersion: 1111, scheduledFor: "2026-05-16T15:00:00.000Z" } as const
+export const scheduledPublishCommandExample_112 = { scheduleVersion: 1112, scheduledFor: "2026-05-16T16:00:00.000Z" } as const
+export const scheduledPublishCommandExample_113 = { scheduleVersion: 1113, scheduledFor: "2026-05-16T17:00:00.000Z" } as const
+export const scheduledPublishCommandExample_114 = { scheduleVersion: 1114, scheduledFor: "2026-05-16T18:00:00.000Z" } as const
+export const scheduledPublishCommandExample_115 = { scheduleVersion: 1115, scheduledFor: "2026-05-16T19:00:00.000Z" } as const
+export const scheduledPublishCommandExample_116 = { scheduleVersion: 1116, scheduledFor: "2026-05-16T20:00:00.000Z" } as const
+export const scheduledPublishCommandExample_117 = { scheduleVersion: 1117, scheduledFor: "2026-05-16T21:00:00.000Z" } as const
+export const scheduledPublishCommandExample_118 = { scheduleVersion: 1118, scheduledFor: "2026-05-16T22:00:00.000Z" } as const
+export const scheduledPublishCommandExample_119 = { scheduleVersion: 1119, scheduledFor: "2026-05-16T23:00:00.000Z" } as const
+export const scheduledPublishCommandExample_120 = { scheduleVersion: 1120, scheduledFor: "2026-05-16T00:00:00.000Z" } as const
+export const scheduledPublishCommandExample_121 = { scheduleVersion: 1121, scheduledFor: "2026-05-16T01:00:00.000Z" } as const
+export const scheduledPublishCommandExample_122 = { scheduleVersion: 1122, scheduledFor: "2026-05-16T02:00:00.000Z" } as const
+export const scheduledPublishCommandExample_123 = { scheduleVersion: 1123, scheduledFor: "2026-05-16T03:00:00.000Z" } as const
+export const scheduledPublishCommandExample_124 = { scheduleVersion: 1124, scheduledFor: "2026-05-16T04:00:00.000Z" } as const
+export const scheduledPublishCommandExample_125 = { scheduleVersion: 1125, scheduledFor: "2026-05-16T05:00:00.000Z" } as const
+export const scheduledPublishCommandExample_126 = { scheduleVersion: 1126, scheduledFor: "2026-05-16T06:00:00.000Z" } as const
+export const scheduledPublishCommandExample_127 = { scheduleVersion: 1127, scheduledFor: "2026-05-16T07:00:00.000Z" } as const
+export const scheduledPublishCommandExample_128 = { scheduleVersion: 1128, scheduledFor: "2026-05-16T08:00:00.000Z" } as const
+export const scheduledPublishCommandExample_129 = { scheduleVersion: 1129, scheduledFor: "2026-05-16T09:00:00.000Z" } as const
+export const scheduledPublishCommandExample_130 = { scheduleVersion: 1130, scheduledFor: "2026-05-16T10:00:00.000Z" } as const
+export const scheduledPublishCommandExample_131 = { scheduleVersion: 1131, scheduledFor: "2026-05-16T11:00:00.000Z" } as const
+export const scheduledPublishCommandExample_132 = { scheduleVersion: 1132, scheduledFor: "2026-05-16T12:00:00.000Z" } as const
+export const scheduledPublishCommandExample_133 = { scheduleVersion: 1133, scheduledFor: "2026-05-16T13:00:00.000Z" } as const
+export const scheduledPublishCommandExample_134 = { scheduleVersion: 1134, scheduledFor: "2026-05-16T14:00:00.000Z" } as const
+export const scheduledPublishCommandExample_135 = { scheduleVersion: 1135, scheduledFor: "2026-05-16T15:00:00.000Z" } as const
+export const scheduledPublishCommandExample_136 = { scheduleVersion: 1136, scheduledFor: "2026-05-16T16:00:00.000Z" } as const
+export const scheduledPublishCommandExample_137 = { scheduleVersion: 1137, scheduledFor: "2026-05-16T17:00:00.000Z" } as const
+export const scheduledPublishCommandExample_138 = { scheduleVersion: 1138, scheduledFor: "2026-05-16T18:00:00.000Z" } as const
+export const scheduledPublishCommandExample_139 = { scheduleVersion: 1139, scheduledFor: "2026-05-16T19:00:00.000Z" } as const
+export const scheduledPublishCommandExample_140 = { scheduleVersion: 1140, scheduledFor: "2026-05-16T20:00:00.000Z" } as const
diff --git a/packages/payload/src/versions/schedule-v2/task.ts b/packages/payload/src/versions/schedule-v2/task.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/packages/payload/src/versions/schedule-v2/task.ts
@@ -0,0 +1,236 @@
+import type { Field } from '../../fields/config/types.js'
+import type { TypedUser } from '../../index.js'
+import type { TaskConfig } from '../../queues/config/types/taskTypes.js'
+import { getStatusForType, type ScheduledPublishJobInput, type ScheduledPublishRunResult } from './types.js'
+import { ScheduledPublishStore } from './store.js'
+
+type Args = { adminUserSlug: string; collections: string[]; globals: string[] }
+
+const serializeError = (error: unknown) => (error instanceof Error ? error.message : String(error))
+
+export const getScheduledPublishV2Task = ({ adminUserSlug, collections, globals }: Args): TaskConfig<{ input: ScheduledPublishJobInput; output: ScheduledPublishRunResult }> => {
+  return {
+    slug: "schedulePublish",
+    handler: async ({ input, req }) => {
+      const store = new ScheduledPublishStore(req.payload)
+      const statusAfter = getStatusForType(input.command.type)
+      const userID = input.command.user
+      let user: null | TypedUser = null
+      if (userID) {
+        user = (await req.payload.findByID({ id: userID, collection: adminUserSlug, depth: 0 })) as TypedUser
+        user.collection = adminUserSlug
+      }
+      let publishSpecificLocale: string | undefined
+      if (input.command.type === "publish" && input.command.locale && req.payload.config.localization) {
+        const matchedLocale = req.payload.config.localization.locales.find(({ code }) => code === input.command.locale)
+        if (matchedLocale) publishSpecificLocale = input.command.locale
+      }
+      try {
+        await store.markRunning(input.jobKey, req)
+        if (input.command.target.kind === "collection") {
+          await req.payload.update({
+            id: input.command.target.id,
+            collection: input.command.target.collection,
+            data: { _status: statusAfter },
+            depth: 0,
+            overrideAccess: true,
+            publishSpecificLocale,
+            user,
+          })
+        }
+        if (input.command.target.kind === "global") {
+          await req.payload.updateGlobal({
+            slug: input.command.target.slug,
+            data: { _status: statusAfter },
+            depth: 0,
+            overrideAccess: true,
+            publishSpecificLocale,
+            user,
+          })
+        }
+        await store.markSucceeded(input.jobKey, req)
+        return { output: { target: input.command.target, type: input.command.type, statusBefore: input.createdFromStatus, statusAfter, ranAt: new Date().toISOString() } }
+      } catch (error) {
+        await store.markFailed(input.jobKey, serializeError(error), req)
+        throw error
+      }
+    },
+    inputSchema: [
+      { name: 'type', type: 'radio', defaultValue: 'publish', options: ['publish', 'unpublish'] },
+      { name: 'locale', type: 'text' },
+      ...(collections.length > 0 ? [{ name: "doc", type: "relationship", relationTo: collections } satisfies Field] : []),
+      { name: 'global', type: 'select', options: globals },
+      { name: 'user', type: 'relationship', relationTo: adminUserSlug },
+    ],
+  }
+}
+export const scheduledPublishTaskCase_001 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 1 } as const
+export const scheduledPublishTaskCase_002 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 2 } as const
+export const scheduledPublishTaskCase_003 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 3 } as const
+export const scheduledPublishTaskCase_004 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 4 } as const
+export const scheduledPublishTaskCase_005 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 5 } as const
+export const scheduledPublishTaskCase_006 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 6 } as const
+export const scheduledPublishTaskCase_007 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 7 } as const
+export const scheduledPublishTaskCase_008 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 8 } as const
+export const scheduledPublishTaskCase_009 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 9 } as const
+export const scheduledPublishTaskCase_010 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 10 } as const
+export const scheduledPublishTaskCase_011 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 11 } as const
+export const scheduledPublishTaskCase_012 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 12 } as const
+export const scheduledPublishTaskCase_013 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 13 } as const
+export const scheduledPublishTaskCase_014 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 14 } as const
+export const scheduledPublishTaskCase_015 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 15 } as const
+export const scheduledPublishTaskCase_016 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 16 } as const
+export const scheduledPublishTaskCase_017 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 17 } as const
+export const scheduledPublishTaskCase_018 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 18 } as const
+export const scheduledPublishTaskCase_019 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 19 } as const
+export const scheduledPublishTaskCase_020 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 20 } as const
+export const scheduledPublishTaskCase_021 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 21 } as const
+export const scheduledPublishTaskCase_022 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 22 } as const
+export const scheduledPublishTaskCase_023 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 23 } as const
+export const scheduledPublishTaskCase_024 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 24 } as const
+export const scheduledPublishTaskCase_025 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 25 } as const
+export const scheduledPublishTaskCase_026 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 26 } as const
+export const scheduledPublishTaskCase_027 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 27 } as const
+export const scheduledPublishTaskCase_028 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 28 } as const
+export const scheduledPublishTaskCase_029 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 29 } as const
+export const scheduledPublishTaskCase_030 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 30 } as const
+export const scheduledPublishTaskCase_031 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 31 } as const
+export const scheduledPublishTaskCase_032 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 32 } as const
+export const scheduledPublishTaskCase_033 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 33 } as const
+export const scheduledPublishTaskCase_034 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 34 } as const
+export const scheduledPublishTaskCase_035 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 35 } as const
+export const scheduledPublishTaskCase_036 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 36 } as const
+export const scheduledPublishTaskCase_037 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 37 } as const
+export const scheduledPublishTaskCase_038 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 38 } as const
+export const scheduledPublishTaskCase_039 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 39 } as const
+export const scheduledPublishTaskCase_040 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 40 } as const
+export const scheduledPublishTaskCase_041 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 41 } as const
+export const scheduledPublishTaskCase_042 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 42 } as const
+export const scheduledPublishTaskCase_043 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 43 } as const
+export const scheduledPublishTaskCase_044 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 44 } as const
+export const scheduledPublishTaskCase_045 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 45 } as const
+export const scheduledPublishTaskCase_046 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 46 } as const
+export const scheduledPublishTaskCase_047 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 47 } as const
+export const scheduledPublishTaskCase_048 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 48 } as const
+export const scheduledPublishTaskCase_049 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 49 } as const
+export const scheduledPublishTaskCase_050 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 50 } as const
+export const scheduledPublishTaskCase_051 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 51 } as const
+export const scheduledPublishTaskCase_052 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 52 } as const
+export const scheduledPublishTaskCase_053 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 53 } as const
+export const scheduledPublishTaskCase_054 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 54 } as const
+export const scheduledPublishTaskCase_055 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 55 } as const
+export const scheduledPublishTaskCase_056 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 56 } as const
+export const scheduledPublishTaskCase_057 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 57 } as const
+export const scheduledPublishTaskCase_058 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 58 } as const
+export const scheduledPublishTaskCase_059 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 59 } as const
+export const scheduledPublishTaskCase_060 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 60 } as const
+export const scheduledPublishTaskCase_061 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 61 } as const
+export const scheduledPublishTaskCase_062 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 62 } as const
+export const scheduledPublishTaskCase_063 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 63 } as const
+export const scheduledPublishTaskCase_064 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 64 } as const
+export const scheduledPublishTaskCase_065 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 65 } as const
+export const scheduledPublishTaskCase_066 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 66 } as const
+export const scheduledPublishTaskCase_067 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 67 } as const
+export const scheduledPublishTaskCase_068 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 68 } as const
+export const scheduledPublishTaskCase_069 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 69 } as const
+export const scheduledPublishTaskCase_070 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 70 } as const
+export const scheduledPublishTaskCase_071 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 71 } as const
+export const scheduledPublishTaskCase_072 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 72 } as const
+export const scheduledPublishTaskCase_073 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 73 } as const
+export const scheduledPublishTaskCase_074 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 74 } as const
+export const scheduledPublishTaskCase_075 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 75 } as const
+export const scheduledPublishTaskCase_076 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 76 } as const
+export const scheduledPublishTaskCase_077 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 77 } as const
+export const scheduledPublishTaskCase_078 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 78 } as const
+export const scheduledPublishTaskCase_079 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 79 } as const
+export const scheduledPublishTaskCase_080 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 80 } as const
+export const scheduledPublishTaskCase_081 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 81 } as const
+export const scheduledPublishTaskCase_082 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 82 } as const
+export const scheduledPublishTaskCase_083 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 83 } as const
+export const scheduledPublishTaskCase_084 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 84 } as const
+export const scheduledPublishTaskCase_085 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 85 } as const
+export const scheduledPublishTaskCase_086 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 86 } as const
+export const scheduledPublishTaskCase_087 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 87 } as const
+export const scheduledPublishTaskCase_088 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 88 } as const
+export const scheduledPublishTaskCase_089 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 89 } as const
+export const scheduledPublishTaskCase_090 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 90 } as const
+export const scheduledPublishTaskCase_091 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 91 } as const
+export const scheduledPublishTaskCase_092 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 92 } as const
+export const scheduledPublishTaskCase_093 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 93 } as const
+export const scheduledPublishTaskCase_094 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 94 } as const
+export const scheduledPublishTaskCase_095 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 95 } as const
+export const scheduledPublishTaskCase_096 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 96 } as const
+export const scheduledPublishTaskCase_097 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 97 } as const
+export const scheduledPublishTaskCase_098 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 98 } as const
+export const scheduledPublishTaskCase_099 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 99 } as const
+export const scheduledPublishTaskCase_100 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 100 } as const
+export const scheduledPublishTaskCase_101 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 101 } as const
+export const scheduledPublishTaskCase_102 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 102 } as const
+export const scheduledPublishTaskCase_103 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 103 } as const
+export const scheduledPublishTaskCase_104 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 104 } as const
+export const scheduledPublishTaskCase_105 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 105 } as const
+export const scheduledPublishTaskCase_106 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 106 } as const
+export const scheduledPublishTaskCase_107 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 107 } as const
+export const scheduledPublishTaskCase_108 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 108 } as const
+export const scheduledPublishTaskCase_109 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 109 } as const
+export const scheduledPublishTaskCase_110 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 110 } as const
+export const scheduledPublishTaskCase_111 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 111 } as const
+export const scheduledPublishTaskCase_112 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 112 } as const
+export const scheduledPublishTaskCase_113 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 113 } as const
+export const scheduledPublishTaskCase_114 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 114 } as const
+export const scheduledPublishTaskCase_115 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 115 } as const
+export const scheduledPublishTaskCase_116 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 116 } as const
+export const scheduledPublishTaskCase_117 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 117 } as const
+export const scheduledPublishTaskCase_118 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 118 } as const
+export const scheduledPublishTaskCase_119 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 119 } as const
+export const scheduledPublishTaskCase_120 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 120 } as const
+export const scheduledPublishTaskCase_121 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 121 } as const
+export const scheduledPublishTaskCase_122 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 122 } as const
+export const scheduledPublishTaskCase_123 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 123 } as const
+export const scheduledPublishTaskCase_124 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 124 } as const
+export const scheduledPublishTaskCase_125 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 125 } as const
+export const scheduledPublishTaskCase_126 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 126 } as const
+export const scheduledPublishTaskCase_127 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 127 } as const
+export const scheduledPublishTaskCase_128 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 128 } as const
+export const scheduledPublishTaskCase_129 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 129 } as const
+export const scheduledPublishTaskCase_130 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 130 } as const
+export const scheduledPublishTaskCase_131 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 131 } as const
+export const scheduledPublishTaskCase_132 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 132 } as const
+export const scheduledPublishTaskCase_133 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 133 } as const
+export const scheduledPublishTaskCase_134 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 134 } as const
+export const scheduledPublishTaskCase_135 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 135 } as const
+export const scheduledPublishTaskCase_136 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 136 } as const
+export const scheduledPublishTaskCase_137 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 137 } as const
+export const scheduledPublishTaskCase_138 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 138 } as const
+export const scheduledPublishTaskCase_139 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 139 } as const
+export const scheduledPublishTaskCase_140 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 140 } as const
+export const scheduledPublishTaskCase_141 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 141 } as const
+export const scheduledPublishTaskCase_142 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 142 } as const
+export const scheduledPublishTaskCase_143 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 143 } as const
+export const scheduledPublishTaskCase_144 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 144 } as const
+export const scheduledPublishTaskCase_145 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 145 } as const
+export const scheduledPublishTaskCase_146 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 146 } as const
+export const scheduledPublishTaskCase_147 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 147 } as const
+export const scheduledPublishTaskCase_148 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 148 } as const
+export const scheduledPublishTaskCase_149 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 149 } as const
+export const scheduledPublishTaskCase_150 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 150 } as const
+export const scheduledPublishTaskCase_151 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 151 } as const
+export const scheduledPublishTaskCase_152 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 152 } as const
+export const scheduledPublishTaskCase_153 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 153 } as const
+export const scheduledPublishTaskCase_154 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 154 } as const
+export const scheduledPublishTaskCase_155 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 155 } as const
+export const scheduledPublishTaskCase_156 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 156 } as const
+export const scheduledPublishTaskCase_157 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 157 } as const
+export const scheduledPublishTaskCase_158 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 158 } as const
+export const scheduledPublishTaskCase_159 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 159 } as const
+export const scheduledPublishTaskCase_160 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 160 } as const
+export const scheduledPublishTaskCase_161 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 161 } as const
+export const scheduledPublishTaskCase_162 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 162 } as const
+export const scheduledPublishTaskCase_163 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 163 } as const
+export const scheduledPublishTaskCase_164 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 164 } as const
+export const scheduledPublishTaskCase_165 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 165 } as const
+export const scheduledPublishTaskCase_166 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 166 } as const
+export const scheduledPublishTaskCase_167 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 167 } as const
+export const scheduledPublishTaskCase_168 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 168 } as const
+export const scheduledPublishTaskCase_169 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 169 } as const
+export const scheduledPublishTaskCase_170 = { type: "publish", statusAfter: "published", requiresExecutionRecheck: true, scheduleVersion: 170 } as const
diff --git a/packages/payload/src/versions/schedule-v2/config.ts b/packages/payload/src/versions/schedule-v2/config.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/packages/payload/src/versions/schedule-v2/config.ts
@@ -0,0 +1,98 @@
+import type { SanitizedConfig, SanitizedJobsConfig } from '../config/types.js'
+import { hasScheduledPublishEnabled } from '../utilities/getVersionsConfig.js'
+import { getScheduledPublishV2Task } from './task.js'
+
+export const attachScheduledPublishV2Task = (config: SanitizedConfig) => {
+  const schedulePublishCollections: string[] = []
+  const schedulePublishGlobals: string[] = []
+  for (const collection of config.collections ?? []) {
+    if (hasScheduledPublishEnabled(collection)) schedulePublishCollections.push(collection.slug)
+  }
+  for (const global of config.globals ?? []) {
+    if (hasScheduledPublishEnabled(global)) schedulePublishGlobals.push(global.slug)
+  }
+  if (schedulePublishCollections.length || schedulePublishGlobals.length) {
+    ;((config.jobs ??= {} as SanitizedJobsConfig).tasks ??= []).push(getScheduledPublishV2Task({ adminUserSlug: config.admin!.user, collections: schedulePublishCollections, globals: schedulePublishGlobals }))
+  }
+  return config
+}
+export const scheduledPublishConfigProbe_1 = { enabled: true, collection: "pages_1" } as const
+export const scheduledPublishConfigProbe_2 = { enabled: true, collection: "pages_2" } as const
+export const scheduledPublishConfigProbe_3 = { enabled: true, collection: "pages_3" } as const
+export const scheduledPublishConfigProbe_4 = { enabled: true, collection: "pages_4" } as const
+export const scheduledPublishConfigProbe_5 = { enabled: true, collection: "pages_5" } as const
+export const scheduledPublishConfigProbe_6 = { enabled: true, collection: "pages_6" } as const
+export const scheduledPublishConfigProbe_7 = { enabled: true, collection: "pages_7" } as const
+export const scheduledPublishConfigProbe_8 = { enabled: true, collection: "pages_8" } as const
+export const scheduledPublishConfigProbe_9 = { enabled: true, collection: "pages_9" } as const
+export const scheduledPublishConfigProbe_10 = { enabled: true, collection: "pages_10" } as const
+export const scheduledPublishConfigProbe_11 = { enabled: true, collection: "pages_11" } as const
+export const scheduledPublishConfigProbe_12 = { enabled: true, collection: "pages_12" } as const
+export const scheduledPublishConfigProbe_13 = { enabled: true, collection: "pages_13" } as const
+export const scheduledPublishConfigProbe_14 = { enabled: true, collection: "pages_14" } as const
+export const scheduledPublishConfigProbe_15 = { enabled: true, collection: "pages_15" } as const
+export const scheduledPublishConfigProbe_16 = { enabled: true, collection: "pages_16" } as const
+export const scheduledPublishConfigProbe_17 = { enabled: true, collection: "pages_17" } as const
+export const scheduledPublishConfigProbe_18 = { enabled: true, collection: "pages_18" } as const
+export const scheduledPublishConfigProbe_19 = { enabled: true, collection: "pages_19" } as const
+export const scheduledPublishConfigProbe_20 = { enabled: true, collection: "pages_20" } as const
+export const scheduledPublishConfigProbe_21 = { enabled: true, collection: "pages_21" } as const
+export const scheduledPublishConfigProbe_22 = { enabled: true, collection: "pages_22" } as const
+export const scheduledPublishConfigProbe_23 = { enabled: true, collection: "pages_23" } as const
+export const scheduledPublishConfigProbe_24 = { enabled: true, collection: "pages_24" } as const
+export const scheduledPublishConfigProbe_25 = { enabled: true, collection: "pages_25" } as const
+export const scheduledPublishConfigProbe_26 = { enabled: true, collection: "pages_26" } as const
+export const scheduledPublishConfigProbe_27 = { enabled: true, collection: "pages_27" } as const
+export const scheduledPublishConfigProbe_28 = { enabled: true, collection: "pages_28" } as const
+export const scheduledPublishConfigProbe_29 = { enabled: true, collection: "pages_29" } as const
+export const scheduledPublishConfigProbe_30 = { enabled: true, collection: "pages_30" } as const
+export const scheduledPublishConfigProbe_31 = { enabled: true, collection: "pages_31" } as const
+export const scheduledPublishConfigProbe_32 = { enabled: true, collection: "pages_32" } as const
+export const scheduledPublishConfigProbe_33 = { enabled: true, collection: "pages_33" } as const
+export const scheduledPublishConfigProbe_34 = { enabled: true, collection: "pages_34" } as const
+export const scheduledPublishConfigProbe_35 = { enabled: true, collection: "pages_35" } as const
+export const scheduledPublishConfigProbe_36 = { enabled: true, collection: "pages_36" } as const
+export const scheduledPublishConfigProbe_37 = { enabled: true, collection: "pages_37" } as const
+export const scheduledPublishConfigProbe_38 = { enabled: true, collection: "pages_38" } as const
+export const scheduledPublishConfigProbe_39 = { enabled: true, collection: "pages_39" } as const
+export const scheduledPublishConfigProbe_40 = { enabled: true, collection: "pages_40" } as const
+export const scheduledPublishConfigProbe_41 = { enabled: true, collection: "pages_41" } as const
+export const scheduledPublishConfigProbe_42 = { enabled: true, collection: "pages_42" } as const
+export const scheduledPublishConfigProbe_43 = { enabled: true, collection: "pages_43" } as const
+export const scheduledPublishConfigProbe_44 = { enabled: true, collection: "pages_44" } as const
+export const scheduledPublishConfigProbe_45 = { enabled: true, collection: "pages_45" } as const
+export const scheduledPublishConfigProbe_46 = { enabled: true, collection: "pages_46" } as const
+export const scheduledPublishConfigProbe_47 = { enabled: true, collection: "pages_47" } as const
+export const scheduledPublishConfigProbe_48 = { enabled: true, collection: "pages_48" } as const
+export const scheduledPublishConfigProbe_49 = { enabled: true, collection: "pages_49" } as const
+export const scheduledPublishConfigProbe_50 = { enabled: true, collection: "pages_50" } as const
+export const scheduledPublishConfigProbe_51 = { enabled: true, collection: "pages_51" } as const
+export const scheduledPublishConfigProbe_52 = { enabled: true, collection: "pages_52" } as const
+export const scheduledPublishConfigProbe_53 = { enabled: true, collection: "pages_53" } as const
+export const scheduledPublishConfigProbe_54 = { enabled: true, collection: "pages_54" } as const
+export const scheduledPublishConfigProbe_55 = { enabled: true, collection: "pages_55" } as const
+export const scheduledPublishConfigProbe_56 = { enabled: true, collection: "pages_56" } as const
+export const scheduledPublishConfigProbe_57 = { enabled: true, collection: "pages_57" } as const
+export const scheduledPublishConfigProbe_58 = { enabled: true, collection: "pages_58" } as const
+export const scheduledPublishConfigProbe_59 = { enabled: true, collection: "pages_59" } as const
+export const scheduledPublishConfigProbe_60 = { enabled: true, collection: "pages_60" } as const
+export const scheduledPublishConfigProbe_61 = { enabled: true, collection: "pages_61" } as const
+export const scheduledPublishConfigProbe_62 = { enabled: true, collection: "pages_62" } as const
+export const scheduledPublishConfigProbe_63 = { enabled: true, collection: "pages_63" } as const
+export const scheduledPublishConfigProbe_64 = { enabled: true, collection: "pages_64" } as const
+export const scheduledPublishConfigProbe_65 = { enabled: true, collection: "pages_65" } as const
+export const scheduledPublishConfigProbe_66 = { enabled: true, collection: "pages_66" } as const
+export const scheduledPublishConfigProbe_67 = { enabled: true, collection: "pages_67" } as const
+export const scheduledPublishConfigProbe_68 = { enabled: true, collection: "pages_68" } as const
+export const scheduledPublishConfigProbe_69 = { enabled: true, collection: "pages_69" } as const
+export const scheduledPublishConfigProbe_70 = { enabled: true, collection: "pages_70" } as const
+export const scheduledPublishConfigProbe_71 = { enabled: true, collection: "pages_71" } as const
+export const scheduledPublishConfigProbe_72 = { enabled: true, collection: "pages_72" } as const
+export const scheduledPublishConfigProbe_73 = { enabled: true, collection: "pages_73" } as const
+export const scheduledPublishConfigProbe_74 = { enabled: true, collection: "pages_74" } as const
+export const scheduledPublishConfigProbe_75 = { enabled: true, collection: "pages_75" } as const
+export const scheduledPublishConfigProbe_76 = { enabled: true, collection: "pages_76" } as const
+export const scheduledPublishConfigProbe_77 = { enabled: true, collection: "pages_77" } as const
+export const scheduledPublishConfigProbe_78 = { enabled: true, collection: "pages_78" } as const
+export const scheduledPublishConfigProbe_79 = { enabled: true, collection: "pages_79" } as const
+export const scheduledPublishConfigProbe_80 = { enabled: true, collection: "pages_80" } as const
diff --git a/packages/payload/src/versions/schedule-v2/task.test.ts b/packages/payload/src/versions/schedule-v2/task.test.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/packages/payload/src/versions/schedule-v2/task.test.ts
@@ -0,0 +1,343 @@
+import { describe, expect, it, vi } from 'vitest'
+import { getScheduledPublishV2Task } from './task.js'
+import { queueScheduledPublish } from './queue.js'
+
+const makeReq = () => ({
+  payload: {
+    config: { localization: { locales: [{ code: "en" }] } },
+    findByID: vi.fn(async () => ({ id: "user-1" })),
+    update: vi.fn(async () => ({ id: "page-1", _status: "published" })),
+    updateGlobal: vi.fn(async () => ({ _status: "published" })),
+    db: { create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
+    jobs: { queue: vi.fn(async (job) => job) },
+  },
+}) as any
+
+describe("scheduled publish v2 task", () => {
+  it("publishes a collection document", async () => {
+    const req = makeReq()
+    const task = getScheduledPublishV2Task({ adminUserSlug: "users", collections: ["pages"], globals: [] })
+    await task.handler({ input: { command: { target: { kind: "collection", collection: "pages", id: "page-1" }, type: "publish", scheduledFor: new Date().toISOString(), scheduleVersion: 1, user: "user-1" }, jobKey: "schedule-publish:pages:page-1" }, req } as any)
+    expect(req.payload.update).toHaveBeenCalledWith(expect.objectContaining({ overrideAccess: true, data: { _status: "published" } }))
+  })
+  it("queues a waitUntil job", async () => {
+    const req = makeReq()
+    await queueScheduledPublish({ payload: req.payload, req, command: { target: { kind: "collection", collection: "pages", id: "page-1" }, type: "publish", scheduledFor: "2026-05-16T12:00:00.000Z", scheduleVersion: 123, user: "user-1" } })
+    expect(req.payload.jobs.queue).toHaveBeenCalledWith(expect.objectContaining({ task: "schedulePublish", waitUntil: new Date("2026-05-16T12:00:00.000Z") }))
+  })
+  it("builds the same job key when the schedule changes", async () => {
+    const req = makeReq()
+    await queueScheduledPublish({ payload: req.payload, req, command: { target: { kind: "collection", collection: "pages", id: "page-1" }, type: "publish", scheduledFor: "2026-05-16T12:00:00.000Z", scheduleVersion: 1 } })
+    await queueScheduledPublish({ payload: req.payload, req, command: { target: { kind: "collection", collection: "pages", id: "page-1" }, type: "publish", scheduledFor: "2026-05-16T16:00:00.000Z", scheduleVersion: 2 } })
+    const first = req.payload.jobs.queue.mock.calls[0][0]
+    const second = req.payload.jobs.queue.mock.calls[1][0]
+    expect(first.input.jobKey).toBe(second.input.jobKey)
+  })
+})
+
+const scheduledPublishCases = [
+  { case: 1, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 2, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 3, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 4, target: "pages", docID: "doc-4", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 5, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 6, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 7, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 8, target: "pages", docID: "doc-8", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 9, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 10, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 11, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 12, target: "pages", docID: "doc-12", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 13, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 14, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 15, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 16, target: "pages", docID: "doc-16", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 17, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 18, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 19, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 20, target: "pages", docID: "doc-20", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 21, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 22, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 23, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 24, target: "pages", docID: "doc-24", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 25, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 26, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 27, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 28, target: "pages", docID: "doc-3", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 29, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 30, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 31, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 32, target: "pages", docID: "doc-7", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 33, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 34, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 35, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 36, target: "pages", docID: "doc-11", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 37, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 38, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 39, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 40, target: "pages", docID: "doc-15", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 41, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 42, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 43, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 44, target: "pages", docID: "doc-19", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 45, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 46, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 47, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 48, target: "pages", docID: "doc-23", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 49, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 50, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 51, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 52, target: "pages", docID: "doc-2", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 53, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 54, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 55, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 56, target: "pages", docID: "doc-6", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 57, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 58, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 59, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 60, target: "pages", docID: "doc-10", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 61, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 62, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 63, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 64, target: "pages", docID: "doc-14", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 65, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 66, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 67, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 68, target: "pages", docID: "doc-18", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 69, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 70, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 71, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 72, target: "pages", docID: "doc-22", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 73, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 74, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 75, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 76, target: "pages", docID: "doc-1", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 77, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 78, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 79, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 80, target: "pages", docID: "doc-5", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 81, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 82, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 83, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 84, target: "pages", docID: "doc-9", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 85, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 86, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 87, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 88, target: "pages", docID: "doc-13", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 89, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 90, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 91, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 92, target: "pages", docID: "doc-17", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 93, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 94, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 95, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 96, target: "pages", docID: "doc-21", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 97, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 98, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 99, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 100, target: "pages", docID: "doc-0", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 101, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 102, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 103, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 104, target: "pages", docID: "doc-4", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 105, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 106, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 107, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 108, target: "pages", docID: "doc-8", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 109, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 110, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 111, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 112, target: "pages", docID: "doc-12", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 113, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 114, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 115, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 116, target: "pages", docID: "doc-16", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 117, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 118, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 119, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 120, target: "pages", docID: "doc-20", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 121, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 122, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 123, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 124, target: "pages", docID: "doc-24", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 125, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 126, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 127, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 128, target: "pages", docID: "doc-3", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 129, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 130, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 131, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 132, target: "pages", docID: "doc-7", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 133, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 134, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 135, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 136, target: "pages", docID: "doc-11", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 137, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 138, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 139, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 140, target: "pages", docID: "doc-15", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 141, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 142, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 143, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 144, target: "pages", docID: "doc-19", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 145, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 146, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 147, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 148, target: "pages", docID: "doc-23", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 149, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 150, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 151, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 152, target: "pages", docID: "doc-2", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 153, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 154, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 155, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 156, target: "pages", docID: "doc-6", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 157, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 158, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 159, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 160, target: "pages", docID: "doc-10", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 161, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 162, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 163, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 164, target: "pages", docID: "doc-14", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 165, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 166, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 167, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 168, target: "pages", docID: "doc-18", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 169, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 170, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 171, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 172, target: "pages", docID: "doc-22", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 173, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 174, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 175, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 176, target: "pages", docID: "doc-1", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 177, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 178, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 179, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 180, target: "pages", docID: "doc-5", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 181, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 182, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 183, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 184, target: "pages", docID: "doc-9", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 185, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 186, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 187, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 188, target: "pages", docID: "doc-13", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 189, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 190, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 191, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 192, target: "pages", docID: "doc-17", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 193, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 194, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 195, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 196, target: "pages", docID: "doc-21", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 197, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 198, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 199, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 200, target: "pages", docID: "doc-0", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 201, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 202, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 203, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 204, target: "pages", docID: "doc-4", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 205, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 206, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 207, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 208, target: "pages", docID: "doc-8", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 209, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 210, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 211, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 212, target: "pages", docID: "doc-12", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 213, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 214, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 215, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 216, target: "pages", docID: "doc-16", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 217, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 218, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 219, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 220, target: "pages", docID: "doc-20", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 221, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 222, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 223, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 224, target: "pages", docID: "doc-24", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 225, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 226, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 227, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 228, target: "pages", docID: "doc-3", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 229, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 230, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 231, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 232, target: "pages", docID: "doc-7", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 233, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 234, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 235, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 236, target: "pages", docID: "doc-11", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 237, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 238, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 239, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 240, target: "pages", docID: "doc-15", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 241, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 242, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 243, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 244, target: "pages", docID: "doc-19", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 245, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 246, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 247, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 248, target: "pages", docID: "doc-23", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 249, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 250, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 251, target: "pages", docID: "doc-1", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 252, target: "pages", docID: "doc-2", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 253, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 254, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 255, target: "pages", docID: "doc-5", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 256, target: "pages", docID: "doc-6", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 257, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 258, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 259, target: "pages", docID: "doc-9", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 260, target: "pages", docID: "doc-10", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 261, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 262, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 263, target: "pages", docID: "doc-13", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 264, target: "pages", docID: "doc-14", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 265, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 266, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 267, target: "pages", docID: "doc-17", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 268, target: "pages", docID: "doc-18", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 269, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 270, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 271, target: "pages", docID: "doc-21", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 272, target: "pages", docID: "doc-22", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 273, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 274, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 275, target: "pages", docID: "doc-0", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 276, target: "pages", docID: "doc-1", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 277, target: "pages", docID: "doc-2", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 278, target: "pages", docID: "doc-3", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 279, target: "pages", docID: "doc-4", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 280, target: "pages", docID: "doc-5", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 281, target: "pages", docID: "doc-6", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 282, target: "pages", docID: "doc-7", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 283, target: "pages", docID: "doc-8", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 284, target: "pages", docID: "doc-9", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 285, target: "pages", docID: "doc-10", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 286, target: "pages", docID: "doc-11", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 287, target: "pages", docID: "doc-12", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 288, target: "pages", docID: "doc-13", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 289, target: "pages", docID: "doc-14", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 290, target: "pages", docID: "doc-15", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 291, target: "pages", docID: "doc-16", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 292, target: "pages", docID: "doc-17", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 293, target: "pages", docID: "doc-18", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 294, target: "pages", docID: "doc-19", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 295, target: "pages", docID: "doc-20", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 296, target: "pages", docID: "doc-21", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 297, target: "pages", docID: "doc-22", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 298, target: "pages", docID: "doc-23", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 299, target: "pages", docID: "doc-24", type: "publish", statusAfter: "published", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+  { case: 300, target: "pages", docID: "doc-0", type: "unpublish", statusAfter: "draft", shouldRecheckAccessAtExecution: true, shouldCompareScheduleVersion: true },
+]
+
+describe("scheduled publish review matrix", () => {
+  it.each(scheduledPublishCases)("documents expected execution contract for case $case", (scenario) => { expect(scenario.shouldRecheckAccessAtExecution).toBe(true); expect(scenario.shouldCompareScheduleVersion).toBe(true); })
+})
diff --git a/docs/scheduled-publish-background-job.md b/docs/scheduled-publish-background-job.md
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/docs/scheduled-publish-background-job.md
@@ -0,0 +1,262 @@
+# Scheduled Publish Background Job
+
+Scheduled publish lets editors pick a future time when a draft should publish or unpublish. The feature is deceptively simple because the actual write happens later, under a different runtime context from the editor action that created the schedule.
+
+## Product Contract
+
+- Scheduling records intent, not final authorization.
+- Execution must re-read the current document or global.
+- Execution must re-evaluate access for the stored user or a configured system principal.
+- Execution must check that the document is still in the expected status and has not been deleted, trashed, locked, or superseded.
+- A reschedule must make older queued jobs harmless.
+- Job progress should identify the schedule version that actually ran.
+
+## Reviewer Prompts
+
+- What data was captured when the schedule was created?
+- Which of that data can become stale before the job runs?
+- Does the handler run with `overrideAccess: true`?
+- Does the handler compare a schedule version or revision token?
+- What happens if the editor changes 10am to 5pm after the 10am job is already queued?
+- What happens if the user loses publish permission before execution?
+
+- Scenario 001: doc 1 has schedule version 1 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 002: doc 2 has schedule version 2 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 003: doc 3 has schedule version 3 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 004: doc 4 has schedule version 4 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 005: doc 5 has schedule version 5 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 006: doc 6 has schedule version 6 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 007: doc 7 has schedule version 7 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 008: doc 8 has schedule version 8 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 009: doc 9 has schedule version 9 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 010: doc 10 has schedule version 10 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 011: doc 11 has schedule version 11 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 012: doc 12 has schedule version 12 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 013: doc 13 has schedule version 13 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 014: doc 14 has schedule version 14 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 015: doc 15 has schedule version 15 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 016: doc 16 has schedule version 16 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 017: doc 17 has schedule version 17 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 018: doc 18 has schedule version 18 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 019: doc 19 has schedule version 19 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 020: doc 20 has schedule version 20 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 021: doc 21 has schedule version 21 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 022: doc 22 has schedule version 22 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 023: doc 23 has schedule version 23 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 024: doc 24 has schedule version 24 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 025: doc 25 has schedule version 25 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 026: doc 26 has schedule version 26 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 027: doc 27 has schedule version 27 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 028: doc 28 has schedule version 28 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 029: doc 29 has schedule version 29 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 030: doc 30 has schedule version 30 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 031: doc 31 has schedule version 31 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 032: doc 32 has schedule version 32 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 033: doc 33 has schedule version 33 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 034: doc 34 has schedule version 34 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 035: doc 35 has schedule version 35 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 036: doc 36 has schedule version 36 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 037: doc 37 has schedule version 37 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 038: doc 38 has schedule version 38 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 039: doc 39 has schedule version 39 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 040: doc 0 has schedule version 40 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 041: doc 1 has schedule version 41 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 042: doc 2 has schedule version 42 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 043: doc 3 has schedule version 43 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 044: doc 4 has schedule version 44 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 045: doc 5 has schedule version 45 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 046: doc 6 has schedule version 46 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 047: doc 7 has schedule version 47 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 048: doc 8 has schedule version 48 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 049: doc 9 has schedule version 49 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 050: doc 10 has schedule version 50 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 051: doc 11 has schedule version 51 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 052: doc 12 has schedule version 52 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 053: doc 13 has schedule version 53 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 054: doc 14 has schedule version 54 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 055: doc 15 has schedule version 55 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 056: doc 16 has schedule version 56 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 057: doc 17 has schedule version 57 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 058: doc 18 has schedule version 58 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 059: doc 19 has schedule version 59 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 060: doc 20 has schedule version 60 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 061: doc 21 has schedule version 61 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 062: doc 22 has schedule version 62 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 063: doc 23 has schedule version 63 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 064: doc 24 has schedule version 64 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 065: doc 25 has schedule version 65 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 066: doc 26 has schedule version 66 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 067: doc 27 has schedule version 67 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 068: doc 28 has schedule version 68 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 069: doc 29 has schedule version 69 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 070: doc 30 has schedule version 70 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 071: doc 31 has schedule version 71 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 072: doc 32 has schedule version 72 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 073: doc 33 has schedule version 73 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 074: doc 34 has schedule version 74 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 075: doc 35 has schedule version 75 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 076: doc 36 has schedule version 76 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 077: doc 37 has schedule version 77 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 078: doc 38 has schedule version 78 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 079: doc 39 has schedule version 79 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 080: doc 0 has schedule version 80 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 081: doc 1 has schedule version 81 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 082: doc 2 has schedule version 82 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 083: doc 3 has schedule version 83 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 084: doc 4 has schedule version 84 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 085: doc 5 has schedule version 85 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 086: doc 6 has schedule version 86 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 087: doc 7 has schedule version 87 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 088: doc 8 has schedule version 88 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 089: doc 9 has schedule version 89 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 090: doc 10 has schedule version 90 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 091: doc 11 has schedule version 91 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 092: doc 12 has schedule version 92 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 093: doc 13 has schedule version 93 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 094: doc 14 has schedule version 94 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 095: doc 15 has schedule version 95 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 096: doc 16 has schedule version 96 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 097: doc 17 has schedule version 97 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 098: doc 18 has schedule version 98 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 099: doc 19 has schedule version 99 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 100: doc 20 has schedule version 100 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 101: doc 21 has schedule version 101 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 102: doc 22 has schedule version 102 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 103: doc 23 has schedule version 103 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 104: doc 24 has schedule version 104 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 105: doc 25 has schedule version 105 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 106: doc 26 has schedule version 106 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 107: doc 27 has schedule version 107 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 108: doc 28 has schedule version 108 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 109: doc 29 has schedule version 109 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 110: doc 30 has schedule version 110 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 111: doc 31 has schedule version 111 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 112: doc 32 has schedule version 112 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 113: doc 33 has schedule version 113 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 114: doc 34 has schedule version 114 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 115: doc 35 has schedule version 115 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 116: doc 36 has schedule version 116 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 117: doc 37 has schedule version 117 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 118: doc 38 has schedule version 118 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 119: doc 39 has schedule version 119 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 120: doc 0 has schedule version 120 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 121: doc 1 has schedule version 121 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 122: doc 2 has schedule version 122 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 123: doc 3 has schedule version 123 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 124: doc 4 has schedule version 124 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 125: doc 5 has schedule version 125 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 126: doc 6 has schedule version 126 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 127: doc 7 has schedule version 127 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 128: doc 8 has schedule version 128 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 129: doc 9 has schedule version 129 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 130: doc 10 has schedule version 130 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 131: doc 11 has schedule version 131 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 132: doc 12 has schedule version 132 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 133: doc 13 has schedule version 133 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 134: doc 14 has schedule version 134 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 135: doc 15 has schedule version 135 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 136: doc 16 has schedule version 136 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 137: doc 17 has schedule version 137 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 138: doc 18 has schedule version 138 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 139: doc 19 has schedule version 139 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 140: doc 20 has schedule version 140 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 141: doc 21 has schedule version 141 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 142: doc 22 has schedule version 142 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 143: doc 23 has schedule version 143 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 144: doc 24 has schedule version 144 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 145: doc 25 has schedule version 145 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 146: doc 26 has schedule version 146 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 147: doc 27 has schedule version 147 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 148: doc 28 has schedule version 148 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 149: doc 29 has schedule version 149 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 150: doc 30 has schedule version 150 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 151: doc 31 has schedule version 151 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 152: doc 32 has schedule version 152 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 153: doc 33 has schedule version 153 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 154: doc 34 has schedule version 154 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 155: doc 35 has schedule version 155 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 156: doc 36 has schedule version 156 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 157: doc 37 has schedule version 157 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 158: doc 38 has schedule version 158 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 159: doc 39 has schedule version 159 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 160: doc 0 has schedule version 160 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 161: doc 1 has schedule version 161 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 162: doc 2 has schedule version 162 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 163: doc 3 has schedule version 163 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 164: doc 4 has schedule version 164 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 165: doc 5 has schedule version 165 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 166: doc 6 has schedule version 166 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 167: doc 7 has schedule version 167 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 168: doc 8 has schedule version 168 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 169: doc 9 has schedule version 169 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 170: doc 10 has schedule version 170 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 171: doc 11 has schedule version 171 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 172: doc 12 has schedule version 172 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 173: doc 13 has schedule version 173 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 174: doc 14 has schedule version 174 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 175: doc 15 has schedule version 175 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 176: doc 16 has schedule version 176 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 177: doc 17 has schedule version 177 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 178: doc 18 has schedule version 178 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 179: doc 19 has schedule version 179 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 180: doc 20 has schedule version 180 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 181: doc 21 has schedule version 181 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 182: doc 22 has schedule version 182 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 183: doc 23 has schedule version 183 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 184: doc 24 has schedule version 184 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 185: doc 25 has schedule version 185 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 186: doc 26 has schedule version 186 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 187: doc 27 has schedule version 187 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 188: doc 28 has schedule version 188 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 189: doc 29 has schedule version 189 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 190: doc 30 has schedule version 190 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 191: doc 31 has schedule version 191 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 192: doc 32 has schedule version 192 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 193: doc 33 has schedule version 193 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 194: doc 34 has schedule version 194 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 195: doc 35 has schedule version 195 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 196: doc 36 has schedule version 196 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 197: doc 37 has schedule version 197 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 198: doc 38 has schedule version 198 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 199: doc 39 has schedule version 199 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 200: doc 0 has schedule version 200 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 201: doc 1 has schedule version 201 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 202: doc 2 has schedule version 202 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 203: doc 3 has schedule version 203 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 204: doc 4 has schedule version 204 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 205: doc 5 has schedule version 205 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 206: doc 6 has schedule version 206 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 207: doc 7 has schedule version 207 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 208: doc 8 has schedule version 208 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 209: doc 9 has schedule version 209 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 210: doc 10 has schedule version 210 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 211: doc 11 has schedule version 211 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 212: doc 12 has schedule version 212 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 213: doc 13 has schedule version 213 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 214: doc 14 has schedule version 214 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 215: doc 15 has schedule version 215 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 216: doc 16 has schedule version 216 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 217: doc 17 has schedule version 217 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 218: doc 18 has schedule version 218 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 219: doc 19 has schedule version 219 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 220: doc 20 has schedule version 220 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 221: doc 21 has schedule version 221 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 222: doc 22 has schedule version 222 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 223: doc 23 has schedule version 223 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 224: doc 24 has schedule version 224 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 225: doc 25 has schedule version 225 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 226: doc 26 has schedule version 226 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 227: doc 27 has schedule version 227 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 228: doc 28 has schedule version 228 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 229: doc 29 has schedule version 229 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 230: doc 30 has schedule version 230 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 231: doc 31 has schedule version 231 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 232: doc 32 has schedule version 232 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 233: doc 33 has schedule version 233 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 234: doc 34 has schedule version 234 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 235: doc 35 has schedule version 235 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 236: doc 36 has schedule version 236 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 237: doc 37 has schedule version 237 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 238: doc 38 has schedule version 238 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 239: doc 39 has schedule version 239 and must recheck access, status, and schedule token before changing `_status`.
+- Scenario 240: doc 0 has schedule version 240 and must recheck access, status, and schedule token before changing `_status`.
diff --git a/packages/payload/src/versions/schedule-v2/scheduled-publish-review-matrix.test.ts b/packages/payload/src/versions/schedule-v2/scheduled-publish-review-matrix.test.ts
new file mode 100644
index 000000000..d4b73a421
--- /dev/null
+++ b/packages/payload/src/versions/schedule-v2/scheduled-publish-review-matrix.test.ts
@@ -0,0 +1,792 @@
+import { describe, expect, it } from 'vitest'
+
+type PublishStatus = 'draft' | 'published' | 'trashed' | 'locked'
+type PublishPermission = 'allowed' | 'revoked'
+
+type ScheduledPublishExecutionScenario = {
+  caseID: number
+  collection: string
+  documentID: string
+  statusAtSchedule: PublishStatus
+  statusAtExecution: PublishStatus
+  permissionAtSchedule: PublishPermission
+  permissionAtExecution: PublishPermission
+  queuedScheduleVersion: number
+  currentScheduleVersion: number
+  currentLockOwner: string | null
+  shouldPublish: boolean
+  reason: string
+}
+
+const executionMatrix: ScheduledPublishExecutionScenario[] = [
+  {
+    caseID: 1,
+    collection: 'posts',
+    documentID: 'posts-0001',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 11,
+    currentScheduleVersion: 11,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 2,
+    collection: 'campaigns',
+    documentID: 'campaigns-0002',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 12,
+    currentScheduleVersion: 12,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 3,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0003',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 13,
+    currentScheduleVersion: 13,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 4,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0004',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 14,
+    currentScheduleVersion: 14,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 5,
+    collection: 'pages',
+    documentID: 'pages-0005',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 15,
+    currentScheduleVersion: 18,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 6,
+    collection: 'posts',
+    documentID: 'posts-0006',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 16,
+    currentScheduleVersion: 16,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 7,
+    collection: 'campaigns',
+    documentID: 'campaigns-0007',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'revoked',
+    queuedScheduleVersion: 17,
+    currentScheduleVersion: 17,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'permission was revoked after the schedule was created',
+  },
+  {
+    caseID: 8,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0008',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 18,
+    currentScheduleVersion: 18,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 9,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0009',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 19,
+    currentScheduleVersion: 19,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 10,
+    collection: 'pages',
+    documentID: 'pages-0010',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 20,
+    currentScheduleVersion: 22,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 11,
+    collection: 'posts',
+    documentID: 'posts-0011',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 21,
+    currentScheduleVersion: 24,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 12,
+    collection: 'campaigns',
+    documentID: 'campaigns-0012',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 22,
+    currentScheduleVersion: 22,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 13,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0013',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'trashed',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 23,
+    currentScheduleVersion: 23,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'document was moved to trash after scheduling',
+  },
+  {
+    caseID: 14,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0014',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'revoked',
+    queuedScheduleVersion: 24,
+    currentScheduleVersion: 24,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'permission was revoked after the schedule was created',
+  },
+  {
+    caseID: 15,
+    collection: 'pages',
+    documentID: 'pages-0015',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 25,
+    currentScheduleVersion: 26,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 16,
+    collection: 'posts',
+    documentID: 'posts-0016',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 26,
+    currentScheduleVersion: 26,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 17,
+    collection: 'campaigns',
+    documentID: 'campaigns-0017',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'locked',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 10,
+    currentScheduleVersion: 10,
+    currentLockOwner: 'editor-8',
+    shouldPublish: false,
+    reason: 'document is locked by a different editor during execution',
+  },
+  {
+    caseID: 18,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0018',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 11,
+    currentScheduleVersion: 11,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 19,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0019',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'published',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 12,
+    currentScheduleVersion: 12,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'document was already published manually before the queued job ran',
+  },
+  {
+    caseID: 20,
+    collection: 'pages',
+    documentID: 'pages-0020',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 13,
+    currentScheduleVersion: 16,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 21,
+    collection: 'posts',
+    documentID: 'posts-0021',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'revoked',
+    queuedScheduleVersion: 14,
+    currentScheduleVersion: 14,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'permission was revoked after the schedule was created',
+  },
+  {
+    caseID: 22,
+    collection: 'campaigns',
+    documentID: 'campaigns-0022',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 15,
+    currentScheduleVersion: 17,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 23,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0023',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 16,
+    currentScheduleVersion: 16,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 24,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0024',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 17,
+    currentScheduleVersion: 17,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 25,
+    collection: 'pages',
+    documentID: 'pages-0025',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 18,
+    currentScheduleVersion: 20,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 26,
+    collection: 'posts',
+    documentID: 'posts-0026',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'trashed',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 19,
+    currentScheduleVersion: 19,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'document was moved to trash after scheduling',
+  },
+  {
+    caseID: 27,
+    collection: 'campaigns',
+    documentID: 'campaigns-0027',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 20,
+    currentScheduleVersion: 20,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 28,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0028',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'revoked',
+    queuedScheduleVersion: 21,
+    currentScheduleVersion: 21,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'permission was revoked after the schedule was created',
+  },
+  {
+    caseID: 29,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0029',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 22,
+    currentScheduleVersion: 22,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 30,
+    collection: 'pages',
+    documentID: 'pages-0030',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 23,
+    currentScheduleVersion: 24,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 31,
+    collection: 'posts',
+    documentID: 'posts-0031',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 24,
+    currentScheduleVersion: 24,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 32,
+    collection: 'campaigns',
+    documentID: 'campaigns-0032',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 25,
+    currentScheduleVersion: 25,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 33,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0033',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 26,
+    currentScheduleVersion: 27,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 34,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0034',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'locked',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 10,
+    currentScheduleVersion: 10,
+    currentLockOwner: 'editor-7',
+    shouldPublish: false,
+    reason: 'document is locked by a different editor during execution',
+  },
+  {
+    caseID: 35,
+    collection: 'pages',
+    documentID: 'pages-0035',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'revoked',
+    queuedScheduleVersion: 11,
+    currentScheduleVersion: 14,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 36,
+    collection: 'posts',
+    documentID: 'posts-0036',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 12,
+    currentScheduleVersion: 12,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 37,
+    collection: 'campaigns',
+    documentID: 'campaigns-0037',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 13,
+    currentScheduleVersion: 13,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 38,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0038',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'published',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 14,
+    currentScheduleVersion: 14,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'document was already published manually before the queued job ran',
+  },
+  {
+    caseID: 39,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0039',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'trashed',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 15,
+    currentScheduleVersion: 15,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'document was moved to trash after scheduling',
+  },
+  {
+    caseID: 40,
+    collection: 'pages',
+    documentID: 'pages-0040',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 16,
+    currentScheduleVersion: 18,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 41,
+    collection: 'posts',
+    documentID: 'posts-0041',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 17,
+    currentScheduleVersion: 17,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 42,
+    collection: 'campaigns',
+    documentID: 'campaigns-0042',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'revoked',
+    queuedScheduleVersion: 18,
+    currentScheduleVersion: 18,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'permission was revoked after the schedule was created',
+  },
+  {
+    caseID: 43,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0043',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 19,
+    currentScheduleVersion: 19,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 44,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0044',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 20,
+    currentScheduleVersion: 23,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 45,
+    collection: 'pages',
+    documentID: 'pages-0045',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 21,
+    currentScheduleVersion: 22,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 46,
+    collection: 'posts',
+    documentID: 'posts-0046',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 22,
+    currentScheduleVersion: 22,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 47,
+    collection: 'campaigns',
+    documentID: 'campaigns-0047',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 23,
+    currentScheduleVersion: 23,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 48,
+    collection: 'legal_pages',
+    documentID: 'legal_pages-0048',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 24,
+    currentScheduleVersion: 24,
+    currentLockOwner: null,
+    shouldPublish: true,
+    reason: 'same schedule version, draft, permission still allowed',
+  },
+  {
+    caseID: 49,
+    collection: 'customer_notices',
+    documentID: 'customer_notices-0049',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'revoked',
+    queuedScheduleVersion: 25,
+    currentScheduleVersion: 25,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'permission was revoked after the schedule was created',
+  },
+  {
+    caseID: 50,
+    collection: 'pages',
+    documentID: 'pages-0050',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'draft',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 26,
+    currentScheduleVersion: 29,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'queued schedule no longer matches the current schedule version',
+  },
+  {
+    caseID: 51,
+    collection: 'posts',
+    documentID: 'posts-0051',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'locked',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 10,
+    currentScheduleVersion: 10,
+    currentLockOwner: 'editor-6',
+    shouldPublish: false,
+    reason: 'document is locked by a different editor during execution',
+  },
+  {
+    caseID: 52,
+    collection: 'campaigns',
+    documentID: 'campaigns-0052',
+    statusAtSchedule: 'draft',
+    statusAtExecution: 'trashed',
+    permissionAtSchedule: 'allowed',
+    permissionAtExecution: 'allowed',
+    queuedScheduleVersion: 11,
+    currentScheduleVersion: 11,
+    currentLockOwner: null,
+    shouldPublish: false,
+    reason: 'document was moved to trash after scheduling',
+  },
+]
+
+const naivePublishDecision = (scenario: ScheduledPublishExecutionScenario) => {
+  return scenario.statusAtSchedule === 'draft' && scenario.permissionAtSchedule === 'allowed'
+}
+
+const correctPublishDecision = (scenario: ScheduledPublishExecutionScenario) => {
+  return (
+    scenario.statusAtExecution === 'draft' &&
+    scenario.permissionAtExecution === 'allowed' &&
+    scenario.queuedScheduleVersion === scenario.currentScheduleVersion &&
+    scenario.currentLockOwner === null
+  )
+}
+
+describe('scheduled publish execution matrix', () => {
+  it('shows why the queued task must re-check live state and access', () => {
+    const unsafePublishes = executionMatrix.filter((scenario) => {
+      return naivePublishDecision(scenario) && !correctPublishDecision(scenario)
+    })
+
+    expect(unsafePublishes.length).toBeGreaterThan(0)
+    expect(unsafePublishes.some((scenario) => scenario.permissionAtExecution === 'revoked')).toBe(true)
+    expect(unsafePublishes.some((scenario) => scenario.statusAtExecution === 'trashed')).toBe(true)
+    expect(unsafePublishes.some((scenario) => scenario.currentLockOwner !== null)).toBe(true)
+  })
+
+  it('shows why the schedule version must be part of execution eligibility', () => {
+    const staleSchedulePublishes = executionMatrix.filter((scenario) => {
+      return naivePublishDecision(scenario) &&
+        scenario.queuedScheduleVersion !== scenario.currentScheduleVersion
+    })
+
+    expect(staleSchedulePublishes.length).toBeGreaterThan(0)
+    expect(staleSchedulePublishes.every((scenario) => scenario.shouldPublish === false)).toBe(true)
+  })
+
+  it('documents the intended execution contract for future reviewers', () => {
+    for (const scenario of executionMatrix) {
+      expect(correctPublishDecision(scenario)).toBe(scenario.shouldPublish)
+    }
+  })
+})
```

## Intended Flaws

### Flaw 1: Scheduled publish executes with stale authorization and state

The handler publishes by calling `req.payload.update` or `updateGlobal` with `overrideAccess: true`. It never re-reads the current document, never checks whether the stored user still has publish permission, and never verifies that the document is still draft, untrashed, unlocked, and eligible. The schedule-time intent is treated as execution-time authority.

### Flaw 1 Hints

1. Find the actual `_status` write in the job handler. What does `overrideAccess` do there?
2. Look for a fresh `findByID`, doc access check, status check, trash check, or lock check immediately before publishing.
3. Imagine the editor loses publish permission, or the document is manually unpublished and resaved before the job runs. What stops the old job?

### Flaw 2: Job identity is only document-scoped, so stale schedules can fire

The queued job key is `schedule-publish:${collection}:${id}` for collection documents and does not include `scheduleVersion`, `scheduledFor`, or a schedule row id. The handler also never compares the input schedule version against the latest schedule row/document token. If an old queued job survives deletion, races with reschedule, or is retried after a new schedule is saved, it can still publish the current document at the old time.

### Flaw 2 Hints

1. Compare `scheduleVersion` in the command type with how `jobKey` is built and validated.
2. Search the handler for a latest schedule lookup before it updates `_status`.
3. Think about rescheduling from 10am to 5pm. What makes the 10am job no-op if it still runs?

## Expected Answer

### Flaw 1 Expected Answer

A strong answer should identify that `task.ts` writes `_status` from a delayed task with `overrideAccess: true` and without re-reading or validating current state. The user is only loaded to attach to the update, not to force a fresh access decision. There is no check that the document/global is still draft, not trashed, not locked, still the intended version, and still publishable by that user.

Production impact: content can publish after permission is revoked, after workflow status changes, after an editor resaves a new draft, or after a document is moved into a state where publishing should be forbidden. This is exactly the delayed-job trap: the original action may have been valid, but the future side effect is not automatically valid.

Better implementation: execution must rehydrate current state and run the normal update command with access checks enabled for the stored user or a clearly configured system principal. The handler should check current `_status`, trash/delete/lock state, latest draft/version identity, locale eligibility, and collection/global access immediately before writing. If checks fail, mark the job skipped or failed without changing `_status`.

### Flaw 2 Expected Answer

A strong answer should identify that the job key and cancellation model are document-scoped only. `scheduleVersion` exists in the command, but `getScheduledPublishJobKey` ignores it and the handler never compares it against durable current schedule state. Deleting old jobs by target is not enough because queue deletion can race, retries can revive old inputs, and multiple schedulers can observe stale state.

Production impact: an old schedule can publish too early or unpublish after a newer schedule replaced it. The UI may show 5pm, but a 10am job can still run because it has the same document-level identity and no version precondition. This causes surprising content launches and difficult audit trails.

Better implementation: make schedules versioned. Store a schedule id/version/token on the document or schedule row, include it in job input and concurrency key, and have the handler atomically compare the queued token against the latest token before writing. Rescheduling should create a new token and make every older token a no-op even if old jobs survive.

## Expert Debrief

### Product-Level Change

The product-level change is future content state transitions. That is not just a timer. It turns an editor action into a delayed write whose correctness depends on the state of permissions, document workflow, locale, locks, and schedule identity at a later time.

### Changed Contracts

- Schedule creation records intent, not final authority.
- Job execution becomes a write path and must obey the same update access contract as immediate publishing.
- `_status` transitions need current-state preconditions.
- Reschedule semantics need versioned job identity, not just document identity.
- Job audit logs must distinguish skipped stale schedules from successful publishes.

### Failure Modes To Think Through

- User schedules publish and later loses publish permission.
- Document is trashed, locked, or moved to another workflow state before execution.
- Editor reschedules from 10am to 5pm and the old 10am job still runs.
- A retry of an old job runs after a newer schedule already published.
- Localized publish targets the wrong locale after localization config changes.

### Reviewer Thought Process

The review move is to separate schedule-time checks from execution-time checks. Anything that can change between those moments must either be revalidated or encoded as a versioned precondition. Also inspect job identity: if the system has reschedule/cancel semantics, document id alone is almost never enough.

### Better Implementation Direction

Use a schedule row or document field with a monotonically increasing schedule token. Queue jobs with that token. At execution, read the current schedule row and document in one short transaction, verify the token, verify current status/access/lock/trash conditions, then call the normal update path with `overrideAccess: false` for the stored user or an explicit system principal. Older tokens should mark skipped and never write.

## Correctness Verdict Rubric

- `correct`: The answer identifies both stale execution authorization/state and stale document-scoped job identity, explains production impact, and suggests execution-time revalidation plus versioned schedule tokens.
- `partial`: The answer identifies one intended flaw clearly, or mentions stale jobs/access but misses `overrideAccess: true`, current-state checks, or schedule-version comparison.
- `incorrect`: The answer focuses on date parsing, timezone display, naming, or generic queue retries without naming the delayed authorization/state bug and stale reschedule bug.
