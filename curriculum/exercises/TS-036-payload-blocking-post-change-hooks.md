# TS-036: Payload Blocking Post-Change Hooks

## Metadata

- `id`: TS-036
- `source_repo`: [payloadcms/payload](https://github.com/payloadcms/payload)
- `repo_area`: collection lifecycle hooks, create/update operations, transaction commit and rollback, external side effects, plugin extension contracts, bulk update behavior
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,300-1,650
- `represented_diff_lines`: 1515
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Payload lifecycle hooks, transaction boundaries, external side effects, bulk updates, outbox patterns, timeout contracts, and plugin ergonomics without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds blocking post-change hooks to Payload collections.

Plugin authors often need to coordinate changed documents with search indexes, cache layers, CRMs, audit exports, and webhooks. Existing hooks can observe document changes, but apps sometimes want a write response to wait until a critical external system has acknowledged the new document state.

The new work includes:

- a `blockingPostChange` collection hook array,
- hook configs with names, operation filters, optional rollback callbacks, and suggested timeouts,
- a shared runner for create, update, updateByID, and bulk updates,
- request-local timing summaries,
- docs for search indexing and webhook acknowledgement examples,
- tests for sequential execution, slow hooks, errors, rollback callbacks, bulk updates, and nested writes.

The intended product behavior is: collection authors can opt into post-change coordination when they truly need it, while Payload writes remain reliable and easy to recover when external systems are slow or unavailable.

## Existing Code Context

The real Payload codebase already has these relevant contracts:

- `packages/payload/src/collections/operations/create.ts` starts a transaction with `initTransaction(req)`, runs validation/access/write logic, runs field and collection `afterChange` hooks, runs `afterOperation`, unlinks temp files, then calls `commitTransaction(req)` near the end.
- If create throws anywhere in that path, the catch block calls `killTransaction(args.req)` and rethrows.
- `packages/payload/src/collections/operations/utilities/update.ts` runs per-document update logic, including field and collection `afterChange` hooks, before returning the updated document to `update.ts` or `updateByID.ts`.
- `packages/payload/src/collections/operations/update.ts` can bulk update many documents. Depending on database settings, it may commit each document separately or share one transaction, then runs collection `afterOperation` and commits the outer transaction.
- `packages/payload/src/collections/operations/updateByID.ts` runs update utility logic, `afterOperation`, temp file cleanup, then commits.
- `packages/payload/src/utilities/commitTransaction.ts` delegates to the database adapter and deletes `req.transactionID`; `killTransaction.ts` attempts rollback and swallows rollback errors.
- `packages/payload/src/collections/config/types.ts` exposes collection lifecycle hooks such as `beforeChange`, `afterChange`, and `afterOperation` as core extension points.
- Payload plugins commonly use hooks for external work such as search sync, cloud storage, form emails, and cache invalidation, which may not participate in the database transaction.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether this hook extension is a safe lifecycle contract for Payload applications.

## Review Surface

Changed files in the synthetic PR:

- `packages/payload/src/collections/hooks/blockingPostChange/types.ts`
- `packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.ts`
- `packages/payload/src/collections/config/types.ts`
- `packages/payload/src/collections/config/defaults.ts`
- `packages/payload/src/collections/operations/create.ts`
- `packages/payload/src/collections/operations/utilities/update.ts`
- `packages/payload/src/collections/operations/update.ts`
- `packages/payload/src/collections/operations/updateByID.ts`
- `packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.spec.ts`
- `docs/hooks/blocking-post-change.md`

The line references below use synthetic PR line numbers. The represented diff is focused on lifecycle placement, blocking external work, transaction boundaries, bulk update behavior, rollback expectations, and tests.

## Diff

```diff
diff --git a/packages/payload/src/collections/hooks/blockingPostChange/types.ts b/packages/payload/src/collections/hooks/blockingPostChange/types.ts
new file mode 100644
index 0000000000..c36b7ac981
--- /dev/null
+++ b/packages/payload/src/collections/hooks/blockingPostChange/types.ts
@@ -0,0 +1,87 @@
+import type { CollectionSlug, JsonObject } from '../../index.js'
+import type { PayloadRequest, RequestContext } from '../../types/index.js'
+import type { SanitizedCollectionConfig } from '../config/types.js'
+
+export type BlockingPostChangeOperation = 'create' | 'update' | 'updateByID' | 'restoreVersion'
+
+export type BlockingPostChangeResult<TDoc extends JsonObject = JsonObject> = {
+  doc?: TDoc
+  status?: 'ok' | 'skipped'
+  metadata?: Record<string, unknown>
+}
+
+export type BlockingPostChangeRollback<TDoc extends JsonObject = JsonObject> = (args: {
+  collection: SanitizedCollectionConfig
+  doc: TDoc
+  error: unknown
+  operation: BlockingPostChangeOperation
+  previousDoc: TDoc | Record<string, never>
+  req: PayloadRequest
+}) => Promise<void> | void
+
+export type BlockingPostChangeHook<TDoc extends JsonObject = JsonObject> = (args: {
+  collection: SanitizedCollectionConfig
+  context: RequestContext
+  data: JsonObject
+  doc: TDoc
+  operation: BlockingPostChangeOperation
+  previousDoc: TDoc | Record<string, never>
+  req: PayloadRequest
+  signal?: AbortSignal
+}) => BlockingPostChangeResult<TDoc> | Promise<BlockingPostChangeResult<TDoc> | TDoc | void> | TDoc | void
+
+export type BlockingPostChangeHookConfig<TDoc extends JsonObject = JsonObject> = {
+  name: string
+  handler: BlockingPostChangeHook<TDoc>
+  rollback?: BlockingPostChangeRollback<TDoc>
+  waitForExternalAck?: boolean
+  timeoutMs?: number
+  operations?: BlockingPostChangeOperation[]
+}
+
+export type BlockingPostChangeTiming = {
+  collectionSlug: CollectionSlug
+  hookName: string
+  operation: BlockingPostChangeOperation
+  startedAt: number
+  finishedAt?: number
+  durationMs?: number
+  status: string
+}
+
+export type BlockingPostChangeRunSummary = {
+  collectionSlug: CollectionSlug
+  operation: BlockingPostChangeOperation
+  hookCount: number
+  timings: BlockingPostChangeTiming[]
+}
+
+export type BlockingPostChangeRunArgs<TDoc extends JsonObject = JsonObject> = {
+  collection: SanitizedCollectionConfig
+  context: RequestContext
+  data: JsonObject
+  doc: TDoc
+  operation: BlockingPostChangeOperation
+  previousDoc: TDoc | Record<string, never>
+  req: PayloadRequest
+}
+
+export type BlockingPostChangeRequestState = {
+  active: boolean
+  summaries: BlockingPostChangeRunSummary[]
+}
+
+export const blockingPostChangeSymbol = Symbol.for('payload.blockingPostChange')
+
+export const getBlockingPostChangeState = (req: PayloadRequest): BlockingPostChangeRequestState => {
+  const holder = req as PayloadRequest & { [blockingPostChangeSymbol]?: BlockingPostChangeRequestState }
+  if (!holder[blockingPostChangeSymbol]) {
+    holder[blockingPostChangeSymbol] = { active: false, summaries: [] }
+  }
+  return holder[blockingPostChangeSymbol]
+}
+
+export const shouldRunBlockingPostChangeHook = (
+  hook: BlockingPostChangeHookConfig,
+  operation: BlockingPostChangeOperation,
+) => !hook.operations || hook.operations.length === 0 || hook.operations.includes(operation)
diff --git a/packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.ts b/packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.ts
new file mode 100644
index 0000000000..c36b7ac981
--- /dev/null
+++ b/packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.ts
@@ -0,0 +1,145 @@
+import type { JsonObject } from '../../index.js'
+
+import { APIError } from '../../errors/index.js'
+import {
+  BlockingPostChangeHookConfig,
+  BlockingPostChangeRunArgs,
+  BlockingPostChangeRunSummary,
+  getBlockingPostChangeState,
+  shouldRunBlockingPostChangeHook,
+} from './types.js'
+
+const normalizeHookResult = <TDoc extends JsonObject>(
+  incomingDoc: TDoc,
+  value: Awaited<ReturnType<BlockingPostChangeHookConfig<TDoc>["handler"]>>,
+): TDoc => {
+  if (!value) return incomingDoc
+  if (typeof value === 'object' && 'doc' in value) return (value.doc || incomingDoc) as TDoc
+  return value as TDoc
+}
+
+export const getBlockingPostChangeHooks = (collection: BlockingPostChangeRunArgs["collection"]) =>
+  collection.hooks?.blockingPostChange || []
+
+export const runBlockingPostChangeRollbacks = async <TDoc extends JsonObject>({
+  args,
+  completedHooks,
+  error,
+}: {
+  args: BlockingPostChangeRunArgs<TDoc>
+  completedHooks: BlockingPostChangeHookConfig<TDoc>[]
+  error: unknown
+}) => {
+  for (const hook of [...completedHooks].reverse()) {
+    if (!hook.rollback) continue
+    try {
+      await hook.rollback({
+        collection: args.collection,
+        doc: args.doc,
+        error,
+        operation: args.operation,
+        previousDoc: args.previousDoc,
+        req: args.req,
+      })
+    } catch (rollbackError) {
+      args.req.payload.logger.error({
+        err: rollbackError,
+        hookName: hook.name,
+        msg: 'Blocking post-change hook rollback failed',
+      })
+    }
+  }
+}
+
+export const runBlockingPostChangeHooks = async <TDoc extends JsonObject>(
+  args: BlockingPostChangeRunArgs<TDoc>,
+): Promise<TDoc> => {
+  const hooks = getBlockingPostChangeHooks(args.collection).filter((hook) =>
+    shouldRunBlockingPostChangeHook(hook, args.operation),
+  ) as BlockingPostChangeHookConfig<TDoc>[]
+  if (hooks.length === 0) return args.doc
+
+  const requestState = getBlockingPostChangeState(args.req)
+  if (requestState.active) {
+    args.req.payload.logger.debug({ collection: args.collection.slug, operation: args.operation, msg: "Skipping nested blocking post-change hooks" })
+    return args.doc
+  }
+
+  requestState.active = true
+  let doc = args.doc
+  const completedHooks: BlockingPostChangeHookConfig<TDoc>[] = []
+  const summary: BlockingPostChangeRunSummary = {
+    collectionSlug: args.collection.slug,
+    operation: args.operation,
+    hookCount: hooks.length,
+    timings: [],
+  }
+
+  try {
+    for (const hook of hooks) {
+      const startedAt = Date.now()
+      summary.timings.push({
+        collectionSlug: args.collection.slug,
+        hookName: hook.name,
+        operation: args.operation,
+        startedAt,
+        status: 'running',
+      })
+
+      args.req.payload.logger.debug({
+        collection: args.collection.slug,
+        hookName: hook.name,
+        operation: args.operation,
+        timeoutMs: hook.timeoutMs,
+        msg: 'Running blocking post-change hook',
+      })
+
+      const hookResult = await hook.handler({
+        collection: args.collection,
+        context: args.context,
+        data: args.data,
+        doc,
+        operation: args.operation,
+        previousDoc: args.previousDoc,
+        req: args.req,
+      })
+
+      doc = normalizeHookResult(doc, hookResult)
+      completedHooks.push(hook)
+      const timing = summary.timings[summary.timings.length - 1]
+      timing.finishedAt = Date.now()
+      timing.durationMs = timing.finishedAt - startedAt
+      timing.status = 'ok'
+    }
+    requestState.summaries.push(summary)
+    return doc
+  } catch (error) {
+    const timing = summary.timings[summary.timings.length - 1]
+    if (timing) {
+      timing.finishedAt = Date.now()
+      timing.durationMs = timing.finishedAt - timing.startedAt
+      timing.status = 'error'
+    }
+    await runBlockingPostChangeRollbacks({ args: { ...args, doc }, completedHooks, error })
+    requestState.summaries.push(summary)
+    if (error instanceof APIError) throw error
+    throw new APIError(`Blocking post-change hook failed for collection ${args.collection.slug}: ${error instanceof Error ? error.message : "Unknown error"}`, 500)
+  } finally {
+    requestState.active = false
+  }
+}
+
+export const runBlockingHooksForManyDocs = async <TDoc extends JsonObject>({
+  args,
+  docs,
+}: {
+  args: Omit<BlockingPostChangeRunArgs<TDoc>, "doc" | "previousDoc"> & { previousDocs: TDoc[] }
+  docs: TDoc[]
+}) => {
+  const results: TDoc[] = []
+  for (const doc of docs) {
+    const previousDoc = args.previousDocs.find((candidate) => candidate.id === doc.id) || {}
+    results.push(await runBlockingPostChangeHooks({ ...args, doc, previousDoc }))
+  }
+  return results
+}
diff --git a/packages/payload/src/collections/config/types.ts b/packages/payload/src/collections/config/types.ts
index 7ae14bc912..e2c44758aa 100644
--- a/packages/payload/src/collections/config/types.ts
+++ b/packages/payload/src/collections/config/types.ts
@@ -633,8 +633,14 @@
   hooks?: {
+    /**
+     * Runs after Payload has built the changed document and before the operation resolves.
+     * Intended for search indexing, cache invalidation, webhooks, and audit exports.
+     */
+    blockingPostChange?: BlockingPostChangeHook[]
     afterChange?: AfterChangeHook[]
     afterDelete?: AfterDeleteHook[]
     afterError?: AfterErrorHook[]
diff --git a/packages/payload/src/collections/config/defaults.ts b/packages/payload/src/collections/config/defaults.ts
index 7ae14bc912..e2c44758aa 100644
--- a/packages/payload/src/collections/config/defaults.ts
+++ b/packages/payload/src/collections/config/defaults.ts
@@ -31,5 +31,6 @@
   hooks: {
     afterChange: [],
+    blockingPostChange: [],
     afterDelete: [],
     afterError: [],
diff --git a/packages/payload/src/collections/operations/create.ts b/packages/payload/src/collections/operations/create.ts
index 7ae14bc912..e2c44758aa 100644
--- a/packages/payload/src/collections/operations/create.ts
+++ b/packages/payload/src/collections/operations/create.ts
@@ -32,24 +32,42 @@
 import { buildAfterOperation } from './utilities/buildAfterOperation.js'
 import { buildBeforeOperation } from './utilities/buildBeforeOperation.js'
+import { runBlockingPostChangeHooks } from '../hooks/blockingPostChange/runBlockingPostChangeHooks.js'

     result = await buildAfterOperation<TSlug>({
       args,
       collection: collectionConfig,
       operation: 'create',
       overrideAccess: args.overrideAccess!,
       result,
     })

+    result = await runBlockingPostChangeHooks({
+      collection: collectionConfig,
+      context: req.context,
+      data,
+      doc: result,
+      operation: 'create',
+      previousDoc: {},
+      req,
+    })
+
     await unlinkTempFiles({ collectionConfig, config, req })

     if (shouldCommit) {
       await commitTransaction(req)
     }
diff --git a/packages/payload/src/collections/operations/utilities/update.ts b/packages/payload/src/collections/operations/utilities/update.ts
index 7ae14bc912..e2c44758aa 100644
--- a/packages/payload/src/collections/operations/utilities/update.ts
+++ b/packages/payload/src/collections/operations/utilities/update.ts
@@ -27,24 +27,37 @@
 import { afterChange } from '../../../fields/hooks/afterChange/index.js'
+import { runBlockingPostChangeHooks } from '../../hooks/blockingPostChange/runBlockingPostChangeHooks.js'

   if (collectionConfig.hooks?.afterChange?.length) {
     for (const hook of collectionConfig.hooks.afterChange) {
       result =
         (await hook({
           collection: collectionConfig,
           context: req.context,
           data,
           doc: result,
           operation: 'update',
           overrideAccess,
           previousDoc: originalDoc,
           req,
         })) || result
     }
   }

+  result = await runBlockingPostChangeHooks({
+    collection: collectionConfig,
+    context: req.context,
+    data,
+    doc: result,
+    operation: 'update',
+    previousDoc: originalDoc,
+    req,
+  })
+
   return result as TransformCollectionWithSelect<TSlug, TSelect>
diff --git a/packages/payload/src/collections/operations/update.ts b/packages/payload/src/collections/operations/update.ts
index 7ae14bc912..e2c44758aa 100644
--- a/packages/payload/src/collections/operations/update.ts
+++ b/packages/payload/src/collections/operations/update.ts
@@ -31,24 +31,40 @@
 import { buildAfterOperation } from './utilities/buildAfterOperation.js'
 import { buildBeforeOperation } from './utilities/buildBeforeOperation.js'
+import { runBlockingHooksForManyDocs } from '../hooks/blockingPostChange/runBlockingPostChangeHooks.js'

     let result = {
       docs: awaitedDocs.filter(Boolean),
       errors,
     }

+    const blockingDocs = await runBlockingHooksForManyDocs({
+      args: {
+        collection: collectionConfig,
+        context: req.context,
+        data: bulkUpdateData,
+        operation: 'update',
+        previousDocs: docs,
+        req,
+      },
+      docs: result.docs,
+    })
+
+    result = { ...result, docs: blockingDocs }
+
     result = await buildAfterOperation({
       args,
       collection: collectionConfig,
       operation: 'update',
       overrideAccess,
       result,
     })

     if (shouldCommit) {
       await commitTransaction(req)
     }
diff --git a/packages/payload/src/collections/operations/updateByID.ts b/packages/payload/src/collections/operations/updateByID.ts
index 7ae14bc912..e2c44758aa 100644
--- a/packages/payload/src/collections/operations/updateByID.ts
+++ b/packages/payload/src/collections/operations/updateByID.ts
@@ -28,20 +28,33 @@
 import { buildAfterOperation } from './utilities/buildAfterOperation.js'
 import { buildBeforeOperation } from './utilities/buildBeforeOperation.js'
+import { runBlockingPostChangeHooks } from '../hooks/blockingPostChange/runBlockingPostChangeHooks.js'

     result = (await buildAfterOperation({
       args,
       collection: collectionConfig,
       operation: 'updateByID',
       overrideAccess,
       result,
     })) as TransformCollectionWithSelect<TSlug, TSelect>

+    result = await runBlockingPostChangeHooks({
+      collection: collectionConfig,
+      context: req.context,
+      data,
+      doc: result,
+      operation: 'updateByID',
+      previousDoc: originalDoc,
+      req,
+    })
+
     if (shouldCommit) {
       await commitTransaction(req)
     }
diff --git a/packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.spec.ts b/packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.spec.ts
new file mode 100644
index 0000000000..c36b7ac981
--- /dev/null
+++ b/packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.spec.ts
@@ -0,0 +1,65 @@
+import { describe, expect, it, vi } from 'vitest'
+import { APIError } from '../../errors/index.js'
+import { runBlockingHooksForManyDocs, runBlockingPostChangeHooks } from './runBlockingPostChangeHooks.js'
+
+const makeReq = () => ({ context: {}, payload: { logger: { debug: vi.fn(), error: vi.fn() } } }) as any
+const makeCollection = (hooks: any[]) => ({ slug: 'posts', hooks: { blockingPostChange: hooks } }) as any
+
+describe('runBlockingPostChangeHooks', () => {
+  it('waits for every hook before resolving the document write', async () => {
+    const calls: string[] = []
+    const collection = makeCollection([
+      { name: 'search-index', handler: vi.fn(async ({ doc }) => { calls.push('search:start'); await new Promise((resolve) => setTimeout(resolve, 25)); calls.push('search:end'); return doc }) },
+      { name: 'webhook', waitForExternalAck: true, handler: vi.fn(async ({ doc }) => { calls.push('webhook:start'); await new Promise((resolve) => setTimeout(resolve, 25)); calls.push('webhook:end'); return doc }) },
+    ])
+    const started = Date.now()
+    const doc = await runBlockingPostChangeHooks({ collection, context: {}, data: { title: 'Hello' }, doc: { id: '1', title: 'Hello' }, operation: 'create', previousDoc: {}, req: makeReq() })
+    expect(doc).toEqual({ id: '1', title: 'Hello' })
+    expect(calls).toEqual(['search:start', 'search:end', 'webhook:start', 'webhook:end'])
+    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
+  })
+
+  it('does not enforce the configured hook timeout', async () => {
+    const collection = makeCollection([{ name: 'slow-crm-sync', timeoutMs: 10, handler: vi.fn(async ({ doc }) => { await new Promise((resolve) => setTimeout(resolve, 50)); return doc }) }])
+    const started = Date.now()
+    await runBlockingPostChangeHooks({ collection, context: {}, data: {}, doc: { id: '1' }, operation: 'create', previousDoc: {}, req: makeReq() })
+    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
+  })
+
+  it('wraps a hook error as a public operation failure', async () => {
+    const collection = makeCollection([{ name: 'webhook', handler: vi.fn(async () => { throw new Error('provider unavailable') }) }])
+    await expect(runBlockingPostChangeHooks({ collection, context: {}, data: {}, doc: { id: '1' }, operation: 'create', previousDoc: {}, req: makeReq() })).rejects.toThrow('Blocking post-change hook failed')
+  })
+
+  it('runs completed hook rollbacks after a later hook fails', async () => {
+    const externalSearchWrite = vi.fn().mockResolvedValue(undefined)
+    const externalSearchDelete = vi.fn().mockResolvedValue(undefined)
+    const externalWebhookSend = vi.fn().mockRejectedValue(new Error('webhook down'))
+    const collection = makeCollection([
+      { name: 'search-index', handler: vi.fn(async ({ doc }) => { await externalSearchWrite(doc); return doc }), rollback: vi.fn(async ({ doc }) => { await externalSearchDelete(doc.id) }) },
+      { name: 'webhook', handler: vi.fn(async ({ doc }) => { await externalWebhookSend(doc); return doc }) },
+    ])
+    await expect(runBlockingPostChangeHooks({ collection, context: {}, data: {}, doc: { id: '1', title: 'Side effects' }, operation: 'create', previousDoc: {}, req: makeReq() })).rejects.toThrow(APIError)
+    expect(externalSearchWrite).toHaveBeenCalledWith({ id: '1', title: 'Side effects' })
+    expect(externalSearchDelete).toHaveBeenCalledWith('1')
+    expect(externalWebhookSend).toHaveBeenCalledWith({ id: '1', title: 'Side effects' })
+  })
+
+  it('runs bulk update hooks after documents have already been individually processed', async () => {
+    const seen: string[] = []
+    const collection = makeCollection([{ name: 'audit-export', handler: vi.fn(async ({ doc }) => { seen.push(doc.id); if (doc.id === '2') throw new Error('export rejected'); return doc }) }])
+    await expect(runBlockingHooksForManyDocs({
+      args: { collection, context: {}, data: { status: 'published' }, operation: 'update', previousDocs: [{ id: '1' }, { id: '2' }], req: makeReq() },
+      docs: [{ id: '1', status: 'published' }, { id: '2', status: 'published' }],
+    })).rejects.toThrow('Blocking post-change hook failed')
+    expect(seen).toEqual(['1', '2'])
+  })
+
+  it('skips nested hook runs instead of creating another lifecycle pass', async () => {
+    const nested = vi.fn()
+    const req = makeReq()
+    const collection = makeCollection([{ name: 'nested-update', handler: vi.fn(async ({ doc }) => { await runBlockingPostChangeHooks({ collection: makeCollection([{ name: 'inner', handler: nested }]), context: {}, data: {}, doc, operation: 'update', previousDoc: {}, req }); return doc }) }])
+    await runBlockingPostChangeHooks({ collection, context: {}, data: {}, doc: { id: '1' }, operation: 'update', previousDoc: {}, req })
+    expect(nested).not.toHaveBeenCalled()
+  })
+})
diff --git a/docs/hooks/blocking-post-change.md b/docs/hooks/blocking-post-change.md
new file mode 100644
index 0000000000..c36b7ac981
--- /dev/null
+++ b/docs/hooks/blocking-post-change.md
@@ -0,0 +1,1034 @@
+# Blocking post-change hooks
+
+Blocking post-change hooks let collection authors wait for external systems before Payload returns a changed document.
+
+## Recommended use cases
+
+- Search indexing that must be visible before the write response returns.
+- Webhooks where the caller wants delivery acknowledgement as part of the mutation.
+- Cache invalidation that must happen before the next read.
+- Audit exports that should run with the same user and locale context as the write.
+
+## Error behavior
+
+When a blocking post-change hook throws, Payload treats the write as failed and returns a 500 response unless the hook throws an APIError.
+If a hook provides a rollback callback, Payload invokes it when a later blocking hook fails.
+
+## Operational notes
+
+- Slow hooks increase mutation response time.
+- Hook failures are returned to the mutation caller.
+- Rollback callbacks are best-effort.
+- Hook timing is stored on request context only.
+- Nested hook runs are skipped.
+- Bulk update hook execution is sequential.
+- External systems should expose idempotent APIs.
+- Hooks should log enough metadata for operators to debug failed writes.
+- Applications can still use normal afterChange hooks for local document shaping.
+- Blocking hooks should be reserved for business-critical integrations.
+
+## Example search-index
+
+```ts
+blockingPostChange: [
+  {
+    name: "search-index",
+    waitForExternalAck: true,
+    timeoutMs: 3000,
+    async handler({ doc, req }) {
+      await req.payload.integrations.searchindex.send(doc)
+    },
+    async rollback({ doc, req }) {
+      await req.payload.integrations.searchindex.revert(doc.id)
+    },
+  },
+]
+```
+
+## Example crm-webhook
+
+```ts
+blockingPostChange: [
+  {
+    name: "crm-webhook",
+    waitForExternalAck: true,
+    timeoutMs: 3000,
+    async handler({ doc, req }) {
+      await req.payload.integrations.crmwebhook.send(doc)
+    },
+    async rollback({ doc, req }) {
+      await req.payload.integrations.crmwebhook.revert(doc.id)
+    },
+  },
+]
+```
+
+## Example audit-export
+
+```ts
+blockingPostChange: [
+  {
+    name: "audit-export",
+    waitForExternalAck: true,
+    timeoutMs: 3000,
+    async handler({ doc, req }) {
+      await req.payload.integrations.auditexport.send(doc)
+    },
+    async rollback({ doc, req }) {
+      await req.payload.integrations.auditexport.revert(doc.id)
+    },
+  },
+]
+```
+
+## Example cache-purge
+
+```ts
+blockingPostChange: [
+  {
+    name: "cache-purge",
+    waitForExternalAck: true,
+    timeoutMs: 3000,
+    async handler({ doc, req }) {
+      await req.payload.integrations.cachepurge.send(doc)
+    },
+    async rollback({ doc, req }) {
+      await req.payload.integrations.cachepurge.revert(doc.id)
+    },
+  },
+]
+```
+
+## Example cdn-revalidate
+
+```ts
+blockingPostChange: [
+  {
+    name: "cdn-revalidate",
+    waitForExternalAck: true,
+    timeoutMs: 3000,
+    async handler({ doc, req }) {
+      await req.payload.integrations.cdnrevalidate.send(doc)
+    },
+    async rollback({ doc, req }) {
+      await req.payload.integrations.cdnrevalidate.revert(doc.id)
+    },
+  },
+]
+```
+
+## Example preview-refresh
+
+```ts
+blockingPostChange: [
+  {
+    name: "preview-refresh",
+    waitForExternalAck: true,
+    timeoutMs: 3000,
+    async handler({ doc, req }) {
+      await req.payload.integrations.previewrefresh.send(doc)
+    },
+    async rollback({ doc, req }) {
+      await req.payload.integrations.previewrefresh.revert(doc.id)
+    },
+  },
+]
+```
+
+## Example analytics-sync
+
+```ts
+blockingPostChange: [
+  {
+    name: "analytics-sync",
+    waitForExternalAck: true,
+    timeoutMs: 3000,
+    async handler({ doc, req }) {
+      await req.payload.integrations.analyticssync.send(doc)
+    },
+    async rollback({ doc, req }) {
+      await req.payload.integrations.analyticssync.revert(doc.id)
+    },
+  },
+]
+```
+
+## Example recommendations-sync
+
+```ts
+blockingPostChange: [
+  {
+    name: "recommendations-sync",
+    waitForExternalAck: true,
+    timeoutMs: 3000,
+    async handler({ doc, req }) {
+      await req.payload.integrations.recommendationssync.send(doc)
+    },
+    async rollback({ doc, req }) {
+      await req.payload.integrations.recommendationssync.revert(doc.id)
+    },
+  },
+]
+```
+
+## Operational scenario 1
+
+- Scenario name: blocking-hook-scenario-1.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 2
+
+- Scenario name: blocking-hook-scenario-2.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 3
+
+- Scenario name: blocking-hook-scenario-3.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 4
+
+- Scenario name: blocking-hook-scenario-4.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 5
+
+- Scenario name: blocking-hook-scenario-5.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 6
+
+- Scenario name: blocking-hook-scenario-6.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 7
+
+- Scenario name: blocking-hook-scenario-7.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 8
+
+- Scenario name: blocking-hook-scenario-8.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 9
+
+- Scenario name: blocking-hook-scenario-9.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 10
+
+- Scenario name: blocking-hook-scenario-10.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 11
+
+- Scenario name: blocking-hook-scenario-11.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 12
+
+- Scenario name: blocking-hook-scenario-12.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 13
+
+- Scenario name: blocking-hook-scenario-13.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 14
+
+- Scenario name: blocking-hook-scenario-14.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 15
+
+- Scenario name: blocking-hook-scenario-15.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 16
+
+- Scenario name: blocking-hook-scenario-16.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 17
+
+- Scenario name: blocking-hook-scenario-17.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Operational scenario 18
+
+- Scenario name: blocking-hook-scenario-18.
+- Write path: create or update collection document.
+- External dependency: provider acknowledgement before response.
+- Failure class: timeout, retry, duplicate delivery, or rollback miss.
+- Reviewer question: should this be in the request path or a durable worker?
+- Safer shape: transactional outbox row plus idempotent delivery worker.
+
+## Delivery and recovery case 19
+
+- Case id: blocking-post-change-19.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 20
+
+- Case id: blocking-post-change-20.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 21
+
+- Case id: blocking-post-change-21.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 22
+
+- Case id: blocking-post-change-22.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 23
+
+- Case id: blocking-post-change-23.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 24
+
+- Case id: blocking-post-change-24.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 25
+
+- Case id: blocking-post-change-25.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 26
+
+- Case id: blocking-post-change-26.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 27
+
+- Case id: blocking-post-change-27.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 28
+
+- Case id: blocking-post-change-28.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 29
+
+- Case id: blocking-post-change-29.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 30
+
+- Case id: blocking-post-change-30.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 31
+
+- Case id: blocking-post-change-31.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 32
+
+- Case id: blocking-post-change-32.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 33
+
+- Case id: blocking-post-change-33.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 34
+
+- Case id: blocking-post-change-34.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 35
+
+- Case id: blocking-post-change-35.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 36
+
+- Case id: blocking-post-change-36.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 37
+
+- Case id: blocking-post-change-37.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 38
+
+- Case id: blocking-post-change-38.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 39
+
+- Case id: blocking-post-change-39.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 40
+
+- Case id: blocking-post-change-40.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 41
+
+- Case id: blocking-post-change-41.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 42
+
+- Case id: blocking-post-change-42.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 43
+
+- Case id: blocking-post-change-43.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 44
+
+- Case id: blocking-post-change-44.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 45
+
+- Case id: blocking-post-change-45.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 46
+
+- Case id: blocking-post-change-46.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 47
+
+- Case id: blocking-post-change-47.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 48
+
+- Case id: blocking-post-change-48.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 49
+
+- Case id: blocking-post-change-49.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 50
+
+- Case id: blocking-post-change-50.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 51
+
+- Case id: blocking-post-change-51.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 52
+
+- Case id: blocking-post-change-52.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 53
+
+- Case id: blocking-post-change-53.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 54
+
+- Case id: blocking-post-change-54.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 55
+
+- Case id: blocking-post-change-55.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 56
+
+- Case id: blocking-post-change-56.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 57
+
+- Case id: blocking-post-change-57.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 58
+
+- Case id: blocking-post-change-58.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 59
+
+- Case id: blocking-post-change-59.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 60
+
+- Case id: blocking-post-change-60.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 61
+
+- Case id: blocking-post-change-61.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 62
+
+- Case id: blocking-post-change-62.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 63
+
+- Case id: blocking-post-change-63.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 64
+
+- Case id: blocking-post-change-64.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 65
+
+- Case id: blocking-post-change-65.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 66
+
+- Case id: blocking-post-change-66.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 67
+
+- Case id: blocking-post-change-67.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 68
+
+- Case id: blocking-post-change-68.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 69
+
+- Case id: blocking-post-change-69.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 70
+
+- Case id: blocking-post-change-70.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 71
+
+- Case id: blocking-post-change-71.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 72
+
+- Case id: blocking-post-change-72.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 73
+
+- Case id: blocking-post-change-73.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 74
+
+- Case id: blocking-post-change-74.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 75
+
+- Case id: blocking-post-change-75.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 76
+
+- Case id: blocking-post-change-76.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 77
+
+- Case id: blocking-post-change-77.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 78
+
+- Case id: blocking-post-change-78.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 79
+
+- Case id: blocking-post-change-79.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 80
+
+- Case id: blocking-post-change-80.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 81
+
+- Case id: blocking-post-change-81.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 82
+
+- Case id: blocking-post-change-82.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 83
+
+- Case id: blocking-post-change-83.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 84
+
+- Case id: blocking-post-change-84.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 85
+
+- Case id: blocking-post-change-85.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 86
+
+- Case id: blocking-post-change-86.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 87
+
+- Case id: blocking-post-change-87.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
+
+## Delivery and recovery case 88
+
+- Case id: blocking-post-change-88.
+- Mutation: create or update a CMS document while a plugin waits for an external acknowledgement.
+- External dependency: search, webhook, cache, audit export, CRM, or preview rebuild.
+- Slow-path signal: provider p95 is higher than the database transaction budget.
+- Failure signal: provider accepts the change and a later hook throws.
+- Recovery question: which system is source of truth after the HTTP response is a failure?
+- Safer implementation: commit document and outbox together, then deliver idempotently from a worker.
```

## Intended Flaws

### Flaw 1: Blocking hooks couple document writes to unbounded external work

- Main locations:
  - `packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.ts:56-116`
  - `packages/payload/src/collections/operations/create.ts:11-22`
  - `packages/payload/src/collections/operations/utilities/update.ts:18-26`
  - `packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.spec.ts:7-26`
- What is wrong: The new hook runner awaits every configured blocking hook inline on the create/update request path. `timeoutMs` is only logged and never enforced. The tests even assert that slow search/webhook hooks delay the mutation response.
- Why it matters: Payload writes now depend on external systems such as search, CRMs, cache providers, and webhooks. A slow provider holds the user request and the database transaction open; an unavailable provider turns a valid CMS write into a 500. Under load this can exhaust connection pools, amplify retries, and make admin saves unreliable.
- Better direction: Separate post-change coordination from the write transaction. Use a durable outbox/job queue for external systems, with explicit status if the product needs acknowledgement. If a truly synchronous hook is allowed, it needs a hard timeout, cancellation, bounded concurrency, and a contract that callers understand as exceptional rather than the default extension path.

Hints:

1. Follow where `runBlockingPostChangeHooks` is called relative to `commitTransaction`.
2. Search for `timeoutMs` and check whether it actually cancels the hook.
3. Ask what happens to a CMS save when the search provider is slow for 30 seconds.

### Flaw 2: Hook failures create inconsistent rollback and side-effect semantics

- Main locations:
  - `packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.ts:20-46`
  - `packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.ts:107-124`
  - `packages/payload/src/collections/operations/create.ts:11-27`
  - `packages/payload/src/collections/operations/update.ts:8-28`
  - `packages/payload/src/collections/hooks/blockingPostChange/runBlockingPostChangeHooks.spec.ts:29-47`
- What is wrong: The runner executes external hook side effects before the surrounding operation commits. If a later hook fails, Payload rolls back the database transaction but cannot reliably roll back side effects that already escaped to search, webhooks, emails, storage, or audit exports. The optional rollback callback is best-effort and itself can fail. Bulk update also runs another per-document blocking pass after documents have already gone through update logic, creating partial side-effect histories.
- Why it matters: Operators can end up with a failed Payload write response while search/webhook systems already observed the new document. Or the first document in a bulk update has been exported while the second fails. This is worse than a simple failed hook because no system has a clear source of truth for recovery.
- Better direction: Make the database commit the source of truth, then publish durable outbox events transactionally with the write. Workers can deliver to external systems idempotently and record delivery state. If a synchronous acknowledgement is required, model the document as `pending_external_sync` or return a separate coordination status instead of pretending rollback can undo arbitrary external effects.

Hints:

1. Look at what happens when the first hook succeeds and the second hook throws.
2. Compare database rollback with an external webhook or search write. Can Payload undo both with the same guarantee?
3. In bulk updates, ask whether all documents and all external systems transition together or whether partial history leaks out.

## Expert Debrief

### Product-Level Change

The product goal is understandable: plugins often want to coordinate changed documents with external systems. The risky part is making a CMS write wait for those systems and then treating external failures like ordinary validation failures.

Post-change side effects are not just hooks. They are distributed system boundaries.

### Changed Contracts

This PR changes several contracts:

- Hook contract: collections can now register `blockingPostChange` hooks with names, rollbacks, and timeout metadata.
- Write latency contract: create and update operations now wait for external hook handlers before responding.
- Transaction contract: hook failures can cause the database transaction to roll back after external effects already happened.
- Timeout contract: docs and types imply timeout control, but the runner does not enforce cancellation.
- Bulk update contract: many-document updates can run hook side effects sequentially and fail midway.
- Recovery contract: rollback callbacks appear to compensate external effects, but they are best-effort and not durable.

The broken contracts are request-path independence and recoverable post-change side effects.

### Failure Modes

Important failure modes reviewers should predict:

- Admin save requests hang because search indexing waits on a slow provider.
- Database transactions stay open while webhooks wait on remote HTTP acknowledgements.
- A document write returns 500 even though the search index already contains the new document.
- A webhook receiver processes a document change that Payload later rolls back.
- Rollback callbacks fail or are not implemented for external systems.
- Bulk update exports the first few documents, then fails on a later document and leaves external systems ahead of Payload.
- Operators cannot tell whether to retry the write, replay the hook, or manually clean external state.

### Reviewer Thought Process

A strong reviewer should ask:

- Is this hook running before or after database commit?
- Does it hold the user request and database transaction open?
- What happens if the external system is slow, down, or returns a permanent error?
- Is timeout metadata enforced or only decorative?
- Can a rollback callback actually undo an already-sent webhook or email?
- For bulk operations, is the operation atomic across documents and side effects?

The key move is seeing this PR as a lifecycle contract change, not just a hook utility. Good reviewers protect the write path and make side effects recoverable.

### Better Implementation Direction

A safer implementation would:

1. Add a durable post-change event/outbox written in the same transaction as the document change.
2. Process external integrations in workers with retry, idempotency keys, backoff, and dead-letter visibility.
3. Expose sync status separately when product needs acknowledgement from search/webhooks.
4. Keep request-path hooks bounded and local-only, or require a hard timeout with cancellation.
5. Make bulk update side effects itemized and retryable instead of all hidden behind one request failure.
6. Treat rollback callbacks as compensating actions with their own status, not as a substitute for transactionality.

## Correctness Verdict Rubric

For each flaw, the verifier should mark the learner correct if their answer captures the core issue, even if they use different wording.

### Flaw 1 Rubric

Correct answers should mention:

- The new hooks are awaited inline during create/update before the operation resolves.
- `timeoutMs` is not enforced, so slow hooks can block indefinitely or for provider-scale latency.
- This couples writes and open transactions to external systems, causing latency, 500s, retries, and capacity issues.
- A better fix is an async outbox/job category or a rare synchronous path with hard timeout/cancellation and explicit status.

Partially correct answers may mention only that the hook is slow without connecting it to transaction/request coupling.

Incorrect answers focus on naming the hook or adding another log line.

### Flaw 2 Rubric

Correct answers should mention:

- External hook side effects can happen before the DB commit.
- Later hook failures or operation errors roll back Payload state but cannot reliably roll back webhooks/search/email/storage effects.
- Bulk updates can leak partial external side effects across documents.
- A better fix is a transactionally written outbox with idempotent workers and explicit delivery/recovery state.

Partially correct answers may mention only that rollback callbacks can fail, without explaining why external side effects cannot share the DB transaction guarantee.

Incorrect answers argue that optional rollback callbacks make the design safe.

## Golden Answer Summary

The PR adds a tempting hook extension, but it makes Payload writes less reliable. First, `blockingPostChange` hooks are awaited inline on create/update paths and `timeoutMs` is not enforced, so external search/webhook/CRM latency becomes CMS write latency and can hold transactions open. Second, hook side effects happen before a clear commit boundary; if a later hook fails, Payload can roll back its database transaction but cannot reliably undo external systems that already observed the change, especially in bulk updates. The fix is an approval-quality lifecycle design: write a durable outbox with the document transaction, process side effects asynchronously and idempotently, and expose sync status instead of pretending arbitrary external effects are rollback-safe.
