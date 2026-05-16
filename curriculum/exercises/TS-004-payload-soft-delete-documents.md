# TS-004: Payload Soft Delete For Collection Documents

## Metadata

- `id`: TS-004
- `source_repo`: [payloadcms/payload](https://github.com/payloadcms/payload)
- `repo_area`: collection delete lifecycle, local operations, REST endpoints, access control, hooks, query filtering, database uniqueness
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 649
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about lifecycle hooks, access semantics, unique constraints, and restore behavior without reducing credit.

## PR Description Shown To Learner

This PR adds soft delete support for collection documents.

Collections can now set `softDelete: true`. When enabled, deleting a document sets `deletedAt` instead of removing the row. Normal find/count queries hide soft-deleted documents. Admins can restore a document through a new restore endpoint.

The PR adds:

- a `softDelete` collection option,
- a `deletedAt` system field,
- soft-delete and restore operations,
- REST endpoints for soft delete and restore,
- query filtering that hides soft-deleted documents by default,
- tests for delete, restore, and uniqueness.

## Existing Code Context

The real Payload codebase already has these relevant contracts:

- `packages/payload/src/collections/operations/delete.ts` and `deleteByID.ts` run `buildBeforeOperation`, delete access, lock checks, collection `beforeDelete` hooks, associated-file/version/scheduled-publish cleanup, database delete, `afterRead`, collection `afterRead`, collection `afterDelete`, and `buildAfterOperation`.
- `packages/payload/src/collections/operations/local/delete.ts` creates a local request and routes local API deletes through the same delete operations as REST.
- `packages/payload/src/collections/endpoints/delete.ts` and `deleteByID.ts` parse query params, including `trash`, then call the central delete operations.
- `packages/payload/src/utilities/appendNonTrashedFilter.ts` appends a `deletedAt exists false` filter when trash is enabled and a caller has not opted into trashed documents.
- Payload's access model can distinguish trash from permanent delete by passing attempted data to delete access, for example `data.deletedAt` for a trash attempt.
- Collection hooks are a central extension point; plugins such as search, redirects, storage, audit, and custom apps rely on lifecycle hooks to observe document state changes.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/payload/src/collections/config/types.ts`
- `packages/payload/src/collections/config/defaults.ts`
- `packages/payload/src/collections/operations/softDeleteByID.ts`
- `packages/payload/src/collections/operations/restoreSoftDeletedByID.ts`
- `packages/payload/src/collections/operations/local/softDelete.ts`
- `packages/payload/src/collections/endpoints/softDeleteByID.ts`
- `packages/payload/src/collections/endpoints/restoreSoftDeletedByID.ts`
- `packages/payload/src/collections/endpoints/index.ts`
- `packages/payload/src/utilities/appendSoftDeleteFilter.ts`
- `packages/db-postgres/src/schema/buildCollectionTable.ts`
- `test/soft-delete/int.spec.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally relevant-only but covers config, endpoint, operation, query filtering, database schema, and tests.

## Diff

```diff
diff --git a/packages/payload/src/collections/config/types.ts b/packages/payload/src/collections/config/types.ts
index a11c2dd010..0181fed214 100644
--- a/packages/payload/src/collections/config/types.ts
+++ b/packages/payload/src/collections/config/types.ts
@@ -221,6 +221,16 @@ export type CollectionConfig = {
    */
   slug: string
 
+  /**
+   * When true, delete endpoints set deletedAt instead of removing the document.
+   *
+   * Soft-deleted documents are hidden from find/count by default and can be
+   * restored by admins through the restore endpoint.
+   *
+   * @default false
+   */
+  softDelete?: boolean
+
   /**
    * Customize the Admin panel behavior.
    */
diff --git a/packages/payload/src/collections/config/defaults.ts b/packages/payload/src/collections/config/defaults.ts
index 4e19ce7822..783edc1acf 100644
--- a/packages/payload/src/collections/config/defaults.ts
+++ b/packages/payload/src/collections/config/defaults.ts
@@ -39,6 +39,7 @@ export const defaults: Partial<CollectionConfig> = {
   fields: [],
   labels: undefined,
   lockDocuments: true,
+  softDelete: false,
   timestamps: true,
   upload: false,
   versions: false,
diff --git a/packages/payload/src/collections/operations/softDeleteByID.ts b/packages/payload/src/collections/operations/softDeleteByID.ts
new file mode 100644
index 0000000000..bb09e2ee41
--- /dev/null
+++ b/packages/payload/src/collections/operations/softDeleteByID.ts
@@ -0,0 +1,168 @@
+import type { CollectionSlug, SelectType, TransformCollectionWithSelect } from '../../index.js'
+import type { PayloadRequest } from '../../types/index.js'
+import type { Collection } from '../config/types.js'
+
+import { APIError, Forbidden, NotFound } from '../../errors/index.js'
+import { afterRead } from '../../fields/hooks/afterRead/index.js'
+import { checkDocumentLockStatus } from '../../utilities/checkDocumentLockStatus.js'
+import { commitTransaction } from '../../utilities/commitTransaction.js'
+import { initTransaction } from '../../utilities/initTransaction.js'
+import { killTransaction } from '../../utilities/killTransaction.js'
+import { sanitizeSelect } from '../../utilities/sanitizeSelect.js'
+import { resolveSelect } from '../../utilities/resolveSelect.js'
+
+export type Arguments<TSlug extends CollectionSlug, TSelect extends SelectType> = {
+  collection: Collection
+  id: number | string
+  overrideAccess?: boolean
+  overrideLock?: boolean
+  req: PayloadRequest
+  select?: TSelect
+}
+
+export const softDeleteByIDOperation = async <
+  TSlug extends CollectionSlug,
+  TSelect extends SelectType,
+>(
+  incomingArgs: Arguments<TSlug, TSelect>,
+): Promise<TransformCollectionWithSelect<TSlug, TSelect>> => {
+  let args = incomingArgs
+
+  try {
+    const shouldCommit = await initTransaction(args.req)
+    const {
+      id,
+      collection: { config: collectionConfig },
+      overrideAccess,
+      overrideLock,
+      req,
+      select: incomingSelect,
+    } = args
+
+    if (!collectionConfig.softDelete) {
+      throw new APIError(`Collection ${collectionConfig.slug} does not support soft delete.`)
+    }
+
+    if (!overrideAccess && !req.user) {
+      throw new Forbidden(req.t)
+    }
+
+    await checkDocumentLockStatus({
+      id,
+      collectionSlug: collectionConfig.slug,
+      lockErrorMessage: `Document with ID ${id} is currently locked and cannot be deleted.`,
+      overrideLock,
+      req,
+    })
+
+    const existingDoc = await req.payload.db.findOne({
+      collection: collectionConfig.slug,
+      req,
+      where: {
+        id: {
+          equals: id,
+        },
+      },
+    })
+
+    if (!existingDoc) {
+      throw new NotFound(req.t)
+    }
+
+    const deletedAt = new Date().toISOString()
+
+    const select = sanitizeSelect({
+      fields: collectionConfig.flattenedFields,
+      select: resolveSelect({
+        config: collectionConfig.select,
+        operation: 'update',
+        req,
+        select: incomingSelect,
+      }),
+    })
+
+    const result = await req.payload.db.updateOne({
+      collection: collectionConfig.slug,
+      data: {
+        deletedAt,
+        updatedAt: deletedAt,
+      },
+      req,
+      select,
+      where: {
+        id: {
+          equals: id,
+        },
+      },
+    })
+
+    let doc = await afterRead({
+      collection: collectionConfig,
+      context: req.context,
+      depth: 0,
+      doc: result,
+      draft: undefined!,
+      fallbackLocale: req.fallbackLocale!,
+      global: null,
+      locale: req.locale!,
+      overrideAccess: overrideAccess!,
+      req,
+      select,
+      showHiddenFields: false,
+    })
+
+    if (collectionConfig.auth) {
+      doc = { ...doc, collection: collectionConfig.slug }
+    }
+
+    if (shouldCommit) {
+      await commitTransaction(req)
+    }
+
+    return doc as TransformCollectionWithSelect<TSlug, TSelect>
+  } catch (error: unknown) {
+    await killTransaction(args.req)
+    throw error
+  }
+}
diff --git a/packages/payload/src/collections/operations/restoreSoftDeletedByID.ts b/packages/payload/src/collections/operations/restoreSoftDeletedByID.ts
new file mode 100644
index 0000000000..e66c443be1
--- /dev/null
+++ b/packages/payload/src/collections/operations/restoreSoftDeletedByID.ts
@@ -0,0 +1,147 @@
+import type { CollectionSlug, SelectType, TransformCollectionWithSelect } from '../../index.js'
+import type { PayloadRequest } from '../../types/index.js'
+import type { Collection } from '../config/types.js'
+
+import { Forbidden, NotFound } from '../../errors/index.js'
+import { afterRead } from '../../fields/hooks/afterRead/index.js'
+import { commitTransaction } from '../../utilities/commitTransaction.js'
+import { initTransaction } from '../../utilities/initTransaction.js'
+import { killTransaction } from '../../utilities/killTransaction.js'
+import { resolveSelect } from '../../utilities/resolveSelect.js'
+import { sanitizeSelect } from '../../utilities/sanitizeSelect.js'
+
+export type Arguments<TSlug extends CollectionSlug, TSelect extends SelectType> = {
+  collection: Collection
+  id: number | string
+  overrideAccess?: boolean
+  req: PayloadRequest
+  select?: TSelect
+}
+
+export const restoreSoftDeletedByIDOperation = async <
+  TSlug extends CollectionSlug,
+  TSelect extends SelectType,
+>(
+  incomingArgs: Arguments<TSlug, TSelect>,
+): Promise<TransformCollectionWithSelect<TSlug, TSelect>> => {
+  let args = incomingArgs
+
+  try {
+    const shouldCommit = await initTransaction(args.req)
+    const {
+      id,
+      collection: { config: collectionConfig },
+      overrideAccess,
+      req,
+      select: incomingSelect,
+    } = args
+
+    if (!overrideAccess && !req.user) {
+      throw new Forbidden(req.t)
+    }
+
+    const existingDoc = await req.payload.db.findOne({
+      collection: collectionConfig.slug,
+      req,
+      where: {
+        id: {
+          equals: id,
+        },
+      },
+    })
+
+    if (!existingDoc || !existingDoc.deletedAt) {
+      throw new NotFound(req.t)
+    }
+
+    const select = sanitizeSelect({
+      fields: collectionConfig.flattenedFields,
+      select: resolveSelect({
+        config: collectionConfig.select,
+        operation: 'update',
+        req,
+        select: incomingSelect,
+      }),
+    })
+
+    const result = await req.payload.db.updateOne({
+      collection: collectionConfig.slug,
+      data: {
+        deletedAt: null,
+        updatedAt: new Date().toISOString(),
+      },
+      req,
+      select,
+      where: {
+        id: {
+          equals: id,
+        },
+      },
+    })
+
+    const doc = await afterRead({
+      collection: collectionConfig,
+      context: req.context,
+      depth: 0,
+      doc: result,
+      draft: undefined!,
+      fallbackLocale: req.fallbackLocale!,
+      global: null,
+      locale: req.locale!,
+      overrideAccess: overrideAccess!,
+      req,
+      select,
+      showHiddenFields: false,
+    })
+
+    if (shouldCommit) {
+      await commitTransaction(req)
+    }
+
+    return doc as TransformCollectionWithSelect<TSlug, TSelect>
+  } catch (error: unknown) {
+    await killTransaction(args.req)
+    throw error
+  }
+}
diff --git a/packages/payload/src/collections/operations/local/softDelete.ts b/packages/payload/src/collections/operations/local/softDelete.ts
new file mode 100644
index 0000000000..64ae447e72
--- /dev/null
+++ b/packages/payload/src/collections/operations/local/softDelete.ts
@@ -0,0 +1,92 @@
+import type { CollectionSlug, Payload, SelectType } from '../../../index.js'
+import type { TransformCollectionWithSelect } from '../../../types/index.js'
+import type { CreateLocalReqOptions } from '../../../utilities/createLocalReq.js'
+
+import { APIError } from '../../../errors/index.js'
+import { createLocalReq } from '../../../utilities/createLocalReq.js'
+import { softDeleteByIDOperation } from '../softDeleteByID.js'
+import { restoreSoftDeletedByIDOperation } from '../restoreSoftDeletedByID.js'
+
+type BaseOptions<TSlug extends CollectionSlug, TSelect extends SelectType> = {
+  collection: TSlug
+  context?: Record<string, unknown>
+  id: number | string
+  overrideAccess?: boolean
+  overrideLock?: boolean
+  select?: TSelect
+  user?: unknown
+}
+
+export async function softDeleteLocal<
+  TSlug extends CollectionSlug,
+  TSelect extends SelectType,
+>(
+  payload: Payload,
+  options: BaseOptions<TSlug, TSelect>,
+): Promise<TransformCollectionWithSelect<TSlug, TSelect>> {
+  const collection = payload.collections[options.collection]
+
+  if (!collection) {
+    throw new APIError(`The collection with slug ${String(options.collection)} can't be found. Soft Delete Operation.`)
+  }
+
+  return softDeleteByIDOperation({
+    collection,
+    id: options.id,
+    overrideAccess: options.overrideAccess ?? true,
+    overrideLock: options.overrideLock,
+    req: await createLocalReq(options as CreateLocalReqOptions, payload),
+    select: options.select,
+  })
+}
+
+export async function restoreSoftDeletedLocal<
+  TSlug extends CollectionSlug,
+  TSelect extends SelectType,
+>(
+  payload: Payload,
+  options: BaseOptions<TSlug, TSelect>,
+): Promise<TransformCollectionWithSelect<TSlug, TSelect>> {
+  const collection = payload.collections[options.collection]
+
+  if (!collection) {
+    throw new APIError(`The collection with slug ${String(options.collection)} can't be found. Restore Operation.`)
+  }
+
+  return restoreSoftDeletedByIDOperation({
+    collection,
+    id: options.id,
+    overrideAccess: options.overrideAccess ?? true,
+    req: await createLocalReq(options as CreateLocalReqOptions, payload),
+    select: options.select,
+  })
+}
diff --git a/packages/payload/src/collections/endpoints/softDeleteByID.ts b/packages/payload/src/collections/endpoints/softDeleteByID.ts
new file mode 100644
index 0000000000..726cf06e2d
--- /dev/null
+++ b/packages/payload/src/collections/endpoints/softDeleteByID.ts
@@ -0,0 +1,47 @@
+import { status as httpStatus } from 'http-status'
+
+import type { PayloadHandler } from '../../config/types.js'
+
+import { getRequestCollectionWithID } from '../../utilities/getRequestEntity.js'
+import { headersWithCors } from '../../utilities/headersWithCors.js'
+import { parseParams } from '../../utilities/parseParams/index.js'
+import { softDeleteByIDOperation } from '../operations/softDeleteByID.js'
+
+export const softDeleteByIDHandler: PayloadHandler = async (req) => {
+  const { id, collection } = getRequestCollectionWithID(req)
+  const { overrideLock, select } = parseParams(req.query)
+
+  const doc = await softDeleteByIDOperation({
+    id,
+    collection,
+    overrideLock: overrideLock ?? false,
+    req,
+    select,
+  })
+
+  const headers = headersWithCors({
+    headers: new Headers(),
+    req,
+  })
+
+  return Response.json(
+    {
+      doc,
+      message: req.t('general:deletedSuccessfully'),
+    },
+    {
+      headers,
+      status: httpStatus.OK,
+    },
+  )
+}
diff --git a/packages/payload/src/collections/endpoints/restoreSoftDeletedByID.ts b/packages/payload/src/collections/endpoints/restoreSoftDeletedByID.ts
new file mode 100644
index 0000000000..2c2da5d912
--- /dev/null
+++ b/packages/payload/src/collections/endpoints/restoreSoftDeletedByID.ts
@@ -0,0 +1,44 @@
+import { status as httpStatus } from 'http-status'
+
+import type { PayloadHandler } from '../../config/types.js'
+
+import { getRequestCollectionWithID } from '../../utilities/getRequestEntity.js'
+import { headersWithCors } from '../../utilities/headersWithCors.js'
+import { parseParams } from '../../utilities/parseParams/index.js'
+import { restoreSoftDeletedByIDOperation } from '../operations/restoreSoftDeletedByID.js'
+
+export const restoreSoftDeletedByIDHandler: PayloadHandler = async (req) => {
+  const { id, collection } = getRequestCollectionWithID(req)
+  const { select } = parseParams(req.query)
+
+  const doc = await restoreSoftDeletedByIDOperation({
+    id,
+    collection,
+    req,
+    select,
+  })
+
+  const headers = headersWithCors({
+    headers: new Headers(),
+    req,
+  })
+
+  return Response.json(
+    {
+      doc,
+      message: req.t('general:restoredSuccessfully'),
+    },
+    {
+      headers,
+      status: httpStatus.OK,
+    },
+  )
+}
diff --git a/packages/payload/src/collections/endpoints/index.ts b/packages/payload/src/collections/endpoints/index.ts
index 0ce94bc32d..902ddec714 100644
--- a/packages/payload/src/collections/endpoints/index.ts
+++ b/packages/payload/src/collections/endpoints/index.ts
@@ -14,6 +14,8 @@ import { findVersionsHandler } from './findVersions.js'
 import { restoreVersionHandler } from './restoreVersion.js'
 import { updateHandler } from './update.js'
 import { updateByIDHandler } from './updateByID.js'
+import { softDeleteByIDHandler } from './softDeleteByID.js'
+import { restoreSoftDeletedByIDHandler } from './restoreSoftDeletedByID.js'
 
 export const getCollectionEndpoints = (): Endpoint[] => [
   {
@@ -118,6 +120,20 @@ export const getCollectionEndpoints = (): Endpoint[] => [
     path: '/:collectionSlug/:id',
     handler: deleteByIDHandler,
   },
+  {
+    method: 'delete',
+    path: '/:collectionSlug/:id/soft',
+    handler: softDeleteByIDHandler,
+  },
+  {
+    method: 'post',
+    path: '/:collectionSlug/:id/restore',
+    handler: restoreSoftDeletedByIDHandler,
+  },
 ]
diff --git a/packages/payload/src/utilities/appendSoftDeleteFilter.ts b/packages/payload/src/utilities/appendSoftDeleteFilter.ts
new file mode 100644
index 0000000000..b4fca61bd1
--- /dev/null
+++ b/packages/payload/src/utilities/appendSoftDeleteFilter.ts
@@ -0,0 +1,46 @@
+import type { Where } from '../types/index.js'
+
+export const appendSoftDeleteFilter = ({
+  softDelete,
+  includeDeleted,
+  where,
+}: {
+  includeDeleted?: boolean
+  softDelete?: boolean
+  where: Where
+}): Where => {
+  if (!softDelete || includeDeleted) {
+    return where
+  }
+
+  const notDeletedFilter = {
+    deletedAt: {
+      exists: false,
+    },
+  }
+
+  if (where?.and) {
+    return {
+      ...where,
+      and: [...where.and, notDeletedFilter],
+    }
+  }
+
+  return {
+    and: [notDeletedFilter, ...(where ? [where] : [])],
+  }
+}
diff --git a/packages/db-postgres/src/schema/buildCollectionTable.ts b/packages/db-postgres/src/schema/buildCollectionTable.ts
index d52a901cfe..82d01f92d3 100644
--- a/packages/db-postgres/src/schema/buildCollectionTable.ts
+++ b/packages/db-postgres/src/schema/buildCollectionTable.ts
@@ -133,6 +133,19 @@ export const buildCollectionTable = ({
     }
   }
 
+  if (collection.softDelete) {
+    columns.push({
+      name: 'deletedAt',
+      type: 'timestamp',
+      nullable: true,
+    })
+
+    indexes.push({
+      columns: ['deletedAt'],
+      name: `${tableName}_deleted_at_idx`,
+    })
+  }
+
   for (const field of collection.flattenedFields) {
     const column = buildColumnFromField({ field, tableName })
 
@@ -192,7 +205,7 @@ export const buildCollectionTable = ({
       indexes.push({
         columns: [field.name],
         name: `${tableName}_${field.name}_idx`,
-        unique: field.unique,
+        unique: field.unique,
       })
     }
   }
diff --git a/test/soft-delete/int.spec.ts b/test/soft-delete/int.spec.ts
new file mode 100644
index 0000000000..1c6bbd76f4
--- /dev/null
+++ b/test/soft-delete/int.spec.ts
@@ -0,0 +1,93 @@
+import { describe, expect, it, beforeAll } from 'vitest'
+import { getPayload } from 'payload'
+
+let payload: Awaited<ReturnType<typeof getPayload>>
+
+describe('soft delete', () => {
+  beforeAll(async () => {
+    payload = await getPayload({
+      config: {
+        collections: [
+          {
+            slug: 'posts',
+            softDelete: true,
+            fields: [
+              {
+                name: 'title',
+                type: 'text',
+                required: true,
+              },
+              {
+                name: 'slug',
+                type: 'text',
+                required: true,
+                unique: true,
+              },
+            ],
+            hooks: {
+              beforeDelete: [
+                async ({ context }) => {
+                  context.beforeDeleteCalled = true
+                },
+              ],
+              afterDelete: [
+                async ({ context }) => {
+                  context.afterDeleteCalled = true
+                },
+              ],
+            },
+          },
+        ],
+      } as never,
+    })
+  })
+
+  it('hides a soft deleted document from normal finds', async () => {
+    const post = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Hello',
+        slug: 'hello',
+      },
+    })
+
+    await payload.softDelete({
+      collection: 'posts',
+      id: post.id,
+    })
+
+    const result = await payload.find({
+      collection: 'posts',
+      where: {
+        slug: {
+          equals: 'hello',
+        },
+      },
+    })
+
+    expect(result.totalDocs).toBe(0)
+  })
+
+  it('restores a soft deleted document', async () => {
+    const post = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Restore me',
+        slug: 'restore-me',
+      },
+    })
+
+    await payload.softDelete({
+      collection: 'posts',
+      id: post.id,
+    })
+
+    const restored = await payload.restoreSoftDeleted({
+      collection: 'posts',
+      id: post.id,
+    })
+
+    expect(restored.deletedAt).toBeNull()
+  })
+
+  it('keeps unique validation for visible documents', async () => {
+    await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Unique',
+        slug: 'unique',
+      },
+    })
+
+    await expect(
+      payload.create({
+        collection: 'posts',
+        data: {
+          title: 'Unique 2',
+          slug: 'unique',
+        },
+      }),
+    ).rejects.toThrow()
+  })
+})
```

## Intended Flaws

### Flaw 1: Soft Delete And Restore Skip The Collection Lifecycle

- `type`: `invariant_drift`
- `location`: `packages/payload/src/collections/operations/softDeleteByID.ts:31-119`, `packages/payload/src/collections/operations/restoreSoftDeletedByID.ts:30-112`, `packages/payload/src/collections/operations/local/softDelete.ts:29-78`, `test/soft-delete/int.spec.ts:24-37`
- `learner_prompt`: Does the new soft-delete path behave like a Payload delete/restore operation from the perspective of access control, hooks, plugins, and audit behavior?

Expected answer:

- `identify`: The new operations update `deletedAt` directly through `req.payload.db.updateOne`. They do not call `buildBeforeOperation`, `executeAccess` with attempted delete data, collection `beforeDelete`, collection `afterDelete`, collection `afterOperation`, field `beforeChange`/`afterChange`, update access, version/scheduled-publish cleanup, or plugin hooks. Restore also clears `deletedAt` directly without running update access or change hooks. The test defines hooks but never asserts they were called.
- `impact`: Plugins and app code that rely on lifecycle hooks miss the state transition. Search indexes, redirects, audit logs, cache invalidation, denormalized counters, and custom side effects remain stale. Access policies that distinguish trashing from permanent delete cannot run, so users may soft-delete or restore documents outside the intended authorization model. The local API and REST API now have behavior that looks official but bypasses Payload's core extension contract.
- `fix_direction`: Do not add a parallel lifecycle. Route soft delete through the existing delete operation's trash semantics or through the normal update operation with an explicit lifecycle contract. Access checks should receive the attempted `deletedAt` change, hooks should fire predictably, and restore should be modeled as an update or dedicated restore operation that runs access, hooks, locks, and after-operation logic.

Hints:

1. Compare this operation to `deleteByIDOperation`, not just to a raw database update.
2. Look for `executeAccess`, `beforeDelete`, `afterDelete`, and `buildAfterOperation`.
3. The test creates hooks but never verifies that soft delete or restore invokes them.

### Flaw 2: Unique Indexes Do Not Account For Deleted Documents Or Restore Conflicts

- `type`: `unsafe_migration`
- `location`: `packages/db-postgres/src/schema/buildCollectionTable.ts:133-210`, `packages/payload/src/collections/operations/restoreSoftDeletedByID.ts:52-82`, `test/soft-delete/int.spec.ts:81-93`
- `learner_prompt`: What happens to unique fields when a document is soft-deleted and later restored?

Expected answer:

- `identify`: The schema adds `deletedAt` but leaves existing unique indexes unchanged. A soft-deleted document still owns its unique `slug`, `email`, or other unique field. The restore operation blindly clears `deletedAt` without checking whether another visible document has claimed the same unique value. The test only checks duplicate visible creation, not create-after-delete or restore-after-replacement.
- `impact`: Users cannot create a replacement document with the same unique slug after deleting the old one, which makes soft delete feel unlike delete. If a future app-layer workaround allows duplicates among deleted records, restore can fail at the database layer or resurrect a document into a uniqueness conflict. Either way, restore becomes unreliable and production data gets stuck in states support cannot easily explain.
- `fix_direction`: Define the uniqueness contract. Common options are partial unique indexes for active rows only, for example unique where `deletedAt IS NULL`, or a tombstone strategy that rewrites unique values on delete and validates conflicts on restore. Restore must check for active conflicts and return a clear error or require explicit conflict resolution.

Hints:

1. Look at database indexes, not only the operation code.
2. Ask whether a deleted document should still reserve its slug forever.
3. The missing test is: delete `slug=a`, create another `slug=a`, then restore the first document.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the lifecycle bypass. Answers that only say "missing hooks" are close but incomplete unless they connect hooks, access, plugins, local API behavior, and restore semantics.

For flaw 2, a correct answer must identify the uniqueness/restore contract problem. Answers that only say "add an index on deletedAt" are incomplete; the issue is how unique fields behave when deleted and restored documents coexist.

### Product-Level Change

The PR tries to give collections a recycle-bin behavior. That is a real product capability. But delete and restore are lifecycle transitions, not just column updates. In Payload, lifecycle is the product: access functions, hooks, versions, plugins, and local API calls are how applications attach their meaning to document changes.

### Changed Contracts

- Collection config contract: `softDelete: true` changes delete semantics.
- Data contract: collections gain a nullable `deletedAt` system field.
- Query contract: normal reads should hide deleted documents unless explicitly requested.
- Access contract: delete/restore authorization now needs to distinguish soft delete, restore, and permanent delete.
- Hook contract: plugins and applications expect delete/change hooks to run.
- Uniqueness contract: unique fields must define whether deleted documents still reserve values.

### Failure Modes

A search plugin removes documents from the search index in `afterDelete`. A user soft-deletes a post. The row gets `deletedAt`, normal list views hide it, but `afterDelete` never fires, so the post remains searchable.

A CMS has `slug` marked unique. An editor soft-deletes `/about`, then tries to create a replacement `/about`. The database unique index still sees the deleted row and rejects the new document. If the team works around that later, restoring the old row can conflict with the replacement.

### Reviewer Thought Process

A strong reviewer starts by identifying the operation class. This is not a small data flag. It changes the lifecycle of deletes, reads, restores, plugin behavior, and uniqueness. That means the reviewer should compare the new code against the existing delete/update operations before reading the happy-path test.

The second move is to ask what state transitions are possible: active to deleted, deleted to active, deleted to permanently deleted, and active replacement while deleted exists. Each transition needs access, hooks, and database invariants.

### Better Implementation Direction

Model soft delete as part of the existing lifecycle:

- Reuse the existing trash/delete operation rather than adding a parallel DB update path.
- Run access with attempted data so policies can distinguish soft delete from permanent delete.
- Fire documented hooks for soft delete and restore.
- Keep REST and local API behavior identical.
- Add partial unique indexes or a tombstone strategy for unique fields.
- Add restore conflict tests and hook/access tests, not only list hiding tests.

## Why This Case Exists

This case trains the instinct that lifecycle features are rarely "just add a column." A reviewer should ask what existing extension points, permissions, indexes, and restore states must continue to mean after the change.
