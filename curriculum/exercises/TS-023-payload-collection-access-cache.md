# TS-023: Payload Collection Access Decision Cache

## Metadata

- `id`: TS-023
- `source_repo`: [payloadcms/payload](https://github.com/payloadcms/payload)
- `repo_area`: collection access control, `executeAccess`, `find`/`findByID`, document access, draft replacement, request-local caching
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 1,000-1,250
- `represented_diff_lines`: 1,101
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Payload access functions, `Where` constraints, document-level access, draft reads, preview mode, request-local caching, and authorization cache keys without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a request-local cache for Payload collection access decisions.

Large admin screens and GraphQL queries can call the same collection access functions many times while resolving relationships, document permissions, lock state, draft previews, and nested reads. Some access functions do database work or call external policy code, so repeated evaluation can become expensive.

The PR adds:

- a request-scoped collection access cache,
- cached wrappers around `executeAccess`,
- cache usage in `find`, `findByID`, and `docAccess`,
- draft-read cache reuse for `replaceWithDraftIfAvailable`,
- debug metadata for cache hits/misses,
- tests for repeated access calls and relationship-heavy reads.

## Existing Code Context

The real Payload codebase already has these relevant contracts:

- `packages/payload/src/auth/executeAccess.ts` runs collection access functions with `{ id, data, isReadingStaticFile, req }` and returns `boolean | Where`.
- `packages/payload/src/collections/operations/find.ts` executes `collectionConfig.access.read`, then combines the result with the user query through `combineQueries(where, accessResult)`.
- `packages/payload/src/collections/operations/findByID.ts` passes `id` into `executeAccess`, combines the returned access result with `{ id: { equals: id } }`, and can later call `replaceWithDraftIfAvailable`.
- `packages/payload/src/versions/drafts/replaceWithDraftIfAvailable.ts` uses the access result to constrain draft/version lookup by appending `version.` paths to returned `Where` constraints.
- `packages/payload/src/collections/operations/docAccess.ts` calls `getEntityPermissions()` so the admin UI can show per-document create/read/update/delete permissions.
- `packages/payload/src/utilities/getEntityPermissions/getEntityPermissions.ts` already has a narrow internal cache for identical `Where` queries during one permission calculation; it is not a general collection access decision cache.
- Payload collection access functions may depend on operation, collection, document id, incoming data, current user, locale, draft/preview state, and arbitrary request context.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/payload/src/auth/accessCache/types.ts`
- `packages/payload/src/auth/accessCache/collectionAccessCache.ts`
- `packages/payload/src/auth/executeAccess.ts`
- `packages/payload/src/collections/operations/find.ts`
- `packages/payload/src/collections/operations/findByID.ts`
- `packages/payload/src/collections/operations/docAccess.ts`
- `packages/payload/src/versions/drafts/replaceWithDraftIfAvailable.ts`
- `packages/payload/src/auth/accessCache/collectionAccessCache.spec.ts`
- `packages/payload/src/auth/accessCache/collectionAccessCache.integration.spec.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on cache identity, access-result reuse, document-sensitive policies, and draft/published state.

## Diff

```diff
diff --git a/packages/payload/src/auth/accessCache/types.ts b/packages/payload/src/auth/accessCache/types.ts
new file mode 100644
index 0000000000..147c897543
--- /dev/null
+++ b/packages/payload/src/auth/accessCache/types.ts
@@ -0,0 +1,138 @@
+import type { AccessResult } from '../../config/types.js'
+import type { PayloadRequest, Where } from '../../types/index.js'
+
+export type AccessCacheOperation =
+  | 'create'
+  | 'read'
+  | 'update'
+  | 'delete'
+  | 'readVersions'
+  | 'unlock'
+  | 'admin'
+
+export type AccessCacheScope = {
+  collectionSlug?: string
+  data?: unknown
+  draft?: boolean
+  id?: number | string
+  isReadingStaticFile?: boolean
+  locale?: string
+  operation: AccessCacheOperation
+  req: PayloadRequest
+  select?: unknown
+  where?: Where
+}
+
+export type AccessCacheEntry = {
+  createdAt: number
+  hits: number
+  result: AccessResult
+}
+
+export type AccessCacheStats = {
+  hits: number
+  misses: number
+  size: number
+}
+
+export type AccessCacheStore = {
+  clear: () => void
+  get: (scope: AccessCacheScope) => AccessResult | undefined
+  getStats: () => AccessCacheStats
+  set: (scope: AccessCacheScope, result: AccessResult) => void
+}
+
+export type RequestWithAccessCache = PayloadRequest & {
+  collectionAccessCache?: AccessCacheStore
+  collectionAccessCacheDebug?: {
+    keys: string[]
+    stats: AccessCacheStats
+  }
+}
+
+export type CacheableAccessResult = boolean | Where
+
+export const ACCESS_CACHE_HEADER = 'x-payload-access-cache'
diff --git a/packages/payload/src/auth/accessCache/collectionAccessCache.ts b/packages/payload/src/auth/accessCache/collectionAccessCache.ts
new file mode 100644
index 0000000000..0f11c95fd2
--- /dev/null
+++ b/packages/payload/src/auth/accessCache/collectionAccessCache.ts
@@ -0,0 +1,228 @@
+import type { AccessResult } from '../../config/types.js'
+import type { PayloadRequest } from '../../types/index.js'
+import type {
+  AccessCacheEntry,
+  AccessCacheScope,
+  AccessCacheStats,
+  AccessCacheStore,
+  RequestWithAccessCache,
+} from './types.js'
+
+const ACCESS_CACHE_TTL_MS = 5_000
+
+const getAnonymousKey = (req: PayloadRequest) => {
+  const api = req.payloadAPI ?? 'local'
+  const path = req.routeParams ? JSON.stringify(req.routeParams) : 'no-route'
+  return `anonymous:${api}:${path}`
+}
+
+export const getCollectionAccessCacheKey = (scope: AccessCacheScope): string => {
+  const user = scope.req.user
+
+  if (user?.id) {
+    return `user:${String(user.id)}`
+  }
+
+  if (user?.email) {
+    return `user:${user.email}`
+  }
+
+  return getAnonymousKey(scope.req)
+}
+
+const cloneAccessResult = (result: AccessResult): AccessResult => {
+  if (typeof result !== 'object' || result === null) {
+    return result
+  }
+
+  return JSON.parse(JSON.stringify(result))
+}
+
+const createStore = (): AccessCacheStore & { keys: string[] } => {
+  const entries = new Map<string, AccessCacheEntry>()
+  const keys: string[] = []
+  let hits = 0
+  let misses = 0
+
+  const pruneExpired = () => {
+    const now = Date.now()
+    for (const [key, entry] of entries.entries()) {
+      if (now - entry.createdAt > ACCESS_CACHE_TTL_MS) {
+        entries.delete(key)
+      }
+    }
+  }
+
+  return {
+    keys,
+    clear() {
+      entries.clear()
+      keys.splice(0, keys.length)
+      hits = 0
+      misses = 0
+    },
+    get(scope) {
+      pruneExpired()
+      const key = getCollectionAccessCacheKey(scope)
+      const entry = entries.get(key)
+
+      if (!entry) {
+        misses += 1
+        return undefined
+      }
+
+      entry.hits += 1
+      hits += 1
+      return cloneAccessResult(entry.result)
+    },
+    getStats(): AccessCacheStats {
+      pruneExpired()
+      return {
+        hits,
+        misses,
+        size: entries.size,
+      }
+    },
+    set(scope, result) {
+      pruneExpired()
+      const key = getCollectionAccessCacheKey(scope)
+      if (!entries.has(key)) {
+        keys.push(key)
+      }
+      entries.set(key, {
+        createdAt: Date.now(),
+        hits: 0,
+        result: cloneAccessResult(result),
+      })
+    },
+  }
+}
+
+export const getOrCreateCollectionAccessCache = (req: PayloadRequest): AccessCacheStore => {
+  const request = req as RequestWithAccessCache
+
+  if (!request.collectionAccessCache) {
+    request.collectionAccessCache = createStore()
+  }
+
+  return request.collectionAccessCache
+}
+
+export const getCollectionAccessCacheDebug = (req: PayloadRequest) => {
+  const request = req as RequestWithAccessCache
+  const cache = request.collectionAccessCache as (AccessCacheStore & { keys?: string[] }) | undefined
+
+  if (!cache) {
+    return {
+      keys: [],
+      stats: {
+        hits: 0,
+        misses: 0,
+        size: 0,
+      },
+    }
+  }
+
+  return {
+    keys: cache.keys ?? [],
+    stats: cache.getStats(),
+  }
+}
+
+export const shouldUseCollectionAccessCache = (req: PayloadRequest) => {
+  if (req.context?.disableAccessCache) {
+    return false
+  }
+
+  if (req.context?.isBackgroundJob) {
+    return false
+  }
+
+  return true
+}
+
+export const getCachedAccessResult = (scope: AccessCacheScope): AccessResult | undefined => {
+  if (!shouldUseCollectionAccessCache(scope.req)) {
+    return undefined
+  }
+
+  return getOrCreateCollectionAccessCache(scope.req).get(scope)
+}
+
+export const setCachedAccessResult = (scope: AccessCacheScope, result: AccessResult): void => {
+  if (!shouldUseCollectionAccessCache(scope.req)) {
+    return
+  }
+
+  getOrCreateCollectionAccessCache(scope.req).set(scope, result)
+}
diff --git a/packages/payload/src/auth/executeAccess.ts b/packages/payload/src/auth/executeAccess.ts
index 310e4e4202..8a94c76411 100644
--- a/packages/payload/src/auth/executeAccess.ts
+++ b/packages/payload/src/auth/executeAccess.ts
@@ -1,22 +1,71 @@
 import type { Access, AccessResult } from '../config/types.js'
 import type { PayloadRequest } from '../types/index.js'
 
 import { Forbidden } from '../errors/index.js'
+import {
+  getCachedAccessResult,
+  setCachedAccessResult,
+} from './accessCache/collectionAccessCache.js'
+import type { AccessCacheOperation } from './accessCache/types.js'
 
 type OperationArgs = {
+  collectionSlug?: string
   data?: any
   disableErrors?: boolean
+  draft?: boolean
   id?: number | string
   isReadingStaticFile?: boolean
+  operation?: AccessCacheOperation
   req: PayloadRequest
 }
 export const executeAccess = async (
-  { id, data, disableErrors, isReadingStaticFile = false, req }: OperationArgs,
+  {
+    id,
+    data,
+    disableErrors,
+    collectionSlug,
+    draft = false,
+    isReadingStaticFile = false,
+    operation = 'read',
+    req,
+  }: OperationArgs,
   access: Access,
 ): Promise<AccessResult> => {
   if (access) {
+    const cached = getCachedAccessResult({
+      collectionSlug,
+      data,
+      draft,
+      id,
+      isReadingStaticFile,
+      operation,
+      req,
+    })
+
+    if (typeof cached !== 'undefined') {
+      if (!cached && !disableErrors) {
+        throw new Forbidden(req.t)
+      }
+      return cached
+    }
+
     const resolvedConstraint = await access({
       id,
       data,
       isReadingStaticFile,
       req,
     })
 
+    setCachedAccessResult(
+      {
+        collectionSlug,
+        data,
+        draft,
+        id,
+        isReadingStaticFile,
+        operation,
+        req,
+      },
+      resolvedConstraint,
+    )
+
     if (!resolvedConstraint) {
       if (!disableErrors) {
         throw new Forbidden(req.t)
@@ -26,13 +75,28 @@ export const executeAccess = async (
 
     return resolvedConstraint
   }
 
+  const cachedDefault = getCachedAccessResult({
+    collectionSlug,
+    draft,
+    id,
+    isReadingStaticFile,
+    operation,
+    req,
+  })
+  if (typeof cachedDefault !== 'undefined') {
+    return cachedDefault
+  }
+
   if (req.user) {
+    setCachedAccessResult({ collectionSlug, draft, id, isReadingStaticFile, operation, req }, true)
     return true
   }
 
   if (!disableErrors) {
     throw new Forbidden(req.t)
   }
+  setCachedAccessResult({ collectionSlug, draft, id, isReadingStaticFile, operation, req }, false)
   return false
 }
diff --git a/packages/payload/src/collections/operations/find.ts b/packages/payload/src/collections/operations/find.ts
index 5d7e9b93b1..c9b04e9fd5 100644
--- a/packages/payload/src/collections/operations/find.ts
+++ b/packages/payload/src/collections/operations/find.ts
@@ -19,6 +19,7 @@ import { afterRead, type AfterReadArgs } from '../../fields/hooks/afterRead/ind
 import { buildAfterOperation } from './utilities/buildAfterOperation.js'
 import { buildBeforeOperation } from './utilities/buildBeforeOperation.js'
 import { sanitizeSortQuery } from './utilities/sanitizeSortQuery.js'
+import { getCollectionAccessCacheDebug } from '../../auth/accessCache/collectionAccessCache.js'
 
 export type Arguments<TSlug extends CollectionSlug> = {
   collection: Collection
@@ -122,7 +123,14 @@ export async function findOperation<
     let accessResult: AccessResult
 
     if (!overrideAccess) {
-      accessResult = await executeAccess({ disableErrors, req }, collectionConfig.access.read)
+      accessResult = await executeAccess(
+        {
+          collectionSlug: collectionConfig.slug,
+          disableErrors,
+          draft: draftsEnabled,
+          operation: 'read',
+          req,
+        }, collectionConfig.access.read)
 
       // If errors are disabled, and access returns false, return empty results
       if (accessResult === false) {
@@ -188,6 +196,7 @@ export async function findOperation<
         select: getQueryDraftsSelect({ select }),
         sort: getQueryDraftsSort({
           collectionConfig,
+          draft: true,
           sort,
         }),
         where: fullWhere,
@@ -360,6 +369,12 @@ export async function findOperation<
       overrideAccess: overrideAccess!,
       result,
     })
 
+    if (args.req?.context?.debugAccessCache) {
+      result.accessCache = getCollectionAccessCacheDebug(args.req)
+      result.accessCache.collection = collectionConfig.slug
+      result.accessCache.draft = draftsEnabled
+    }
+
     // /////////////////////////////////////
     // Return results
     // /////////////////////////////////////
diff --git a/packages/payload/src/collections/operations/findByID.ts b/packages/payload/src/collections/operations/findByID.ts
index 3fe5bc27ea..d3db5e7ca1 100644
--- a/packages/payload/src/collections/operations/findByID.ts
+++ b/packages/payload/src/collections/operations/findByID.ts
@@ -112,7 +112,18 @@ export async function findByIDOperation<
     // Access
     // /////////////////////////////////////
 
-    const accessResult = !overrideAccess
-      ? await executeAccess({ id, disableErrors, req }, collectionConfig.access.read)
-      : true
+    const accessResult = !overrideAccess
+      ? await executeAccess(
+          {
+            collectionSlug: collectionConfig.slug,
+            disableErrors,
+            draft: replaceWithVersion,
+            id,
+            operation: 'read',
+            req,
+          },
+          collectionConfig.access.read,
+        )
+      : true
 
     // If errors are disabled, and access returns false, return null
     if (accessResult === false) {
@@ -248,6 +259,7 @@ export async function findByIDOperation<
         doc: result,
         entity: collectionConfig,
         entityType: 'collection',
+        operation: 'read',
         overrideAccess,
         req,
         select,
diff --git a/packages/payload/src/collections/operations/docAccess.ts b/packages/payload/src/collections/operations/docAccess.ts
index 86da3a98da..3d89bb562b 100644
--- a/packages/payload/src/collections/operations/docAccess.ts
+++ b/packages/payload/src/collections/operations/docAccess.ts
@@ -6,6 +6,7 @@ import { getEntityPermissions } from '../../utilities/getEntityPermissions/getEn
 import { killTransaction } from '../../utilities/killTransaction.js'
 import { sanitizePermissions } from '../../utilities/sanitizePermissions.js'
+import { getCachedAccessResult, setCachedAccessResult } from '../../auth/accessCache/collectionAccessCache.js'
 
 const allOperations: AllOperations[] = ['create', 'read', 'update', 'delete']
 
@@ -39,6 +40,26 @@ export async function docAccessOperation(args: Arguments): Promise<SanitizedColl
     collectionOperations.push('readVersions')
   }
 
+  const cached = getCachedAccessResult({
+    collectionSlug: config.slug,
+    data,
+    id,
+    operation: 'read',
+    req,
+  })
+
+  if (cached === true) {
+    return sanitizePermissions({
+      collections: {
+        [config.slug]: {
+          create: { permission: true },
+          delete: { permission: true },
+          fields: {},
+          read: { permission: true },
+          update: { permission: true },
+        },
+      },
+    }).collections![config.slug]!
+  }
+
   try {
     const result = await getEntityPermissions({
       id: id!,
@@ -53,6 +74,18 @@ export async function docAccessOperation(args: Arguments): Promise<SanitizedColl
       req,
     })
 
+    if (result.read?.permission) {
+      setCachedAccessResult(
+        {
+          collectionSlug: config.slug,
+          data,
+          id,
+          operation: 'read',
+          req,
+        },
+        true,
+      )
+    }
+
     const sanitizedPermissions = sanitizePermissions({
       collections: {
         [config.slug]: result,
diff --git a/packages/payload/src/versions/drafts/replaceWithDraftIfAvailable.ts b/packages/payload/src/versions/drafts/replaceWithDraftIfAvailable.ts
index 58d2419cfa..43553a4191 100644
--- a/packages/payload/src/versions/drafts/replaceWithDraftIfAvailable.ts
+++ b/packages/payload/src/versions/drafts/replaceWithDraftIfAvailable.ts
@@ -9,6 +9,10 @@ import { combineQueries } from '../../database/combineQueries.js'
 import { docHasTimestamps } from '../../types/index.js'
 import { hasLocalizeStatusEnabled } from '../../utilities/getVersionsConfig.js'
 import { sanitizeInternalFields } from '../../utilities/sanitizeInternalFields.js'
+import {
+  getCachedAccessResult,
+  setCachedAccessResult,
+} from '../../auth/accessCache/collectionAccessCache.js'
 import { appendVersionToQueryKey } from './appendVersionToQueryKey.js'
 import { getQueryDraftsSelect } from './getQueryDraftsSelect.js'
 
@@ -20,6 +24,7 @@ type Arguments<T> = {
   entity: SanitizedCollectionConfig | SanitizedGlobalConfig
   entityType: 'collection' | 'global'
   overrideAccess: boolean
+  operation?: 'read' | 'readVersions'
   req: PayloadRequest
   select?: SelectType
 }
@@ -29,6 +34,7 @@ export const replaceWithDraftIfAvailable = async <T extends TypeWithID>({
   doc,
   entity,
   entityType,
+  operation = 'read',
   req,
   select,
 }: Arguments<T>): Promise<T> => {
@@ -90,6 +96,22 @@ export const replaceWithDraftIfAvailable = async <T extends TypeWithID>({
     versionAccessResult = appendVersionToQueryKey(accessResult)
   }
 
+  const cachedDraftAccess = getCachedAccessResult({
+    collectionSlug: entity.slug,
+    draft: true,
+    id: doc.id,
+    locale,
+    operation,
+    req,
+    where: versionAccessResult,
+  })
+
+  if (cachedDraftAccess === false) {
+    return doc
+  }
+  if (cachedDraftAccess && typeof cachedDraftAccess === 'object') {
+    versionAccessResult = cachedDraftAccess
+  }
+
   const findVersionsArgs: FindGlobalVersionsArgs & FindVersionsArgs = {
     collection: entity.slug,
     global: entity.slug,
@@ -119,6 +141,17 @@ export const replaceWithDraftIfAvailable = async <T extends TypeWithID>({
   let draft = versionDocs[0]
 
   if (!draft) {
+    setCachedAccessResult(
+      {
+        collectionSlug: entity.slug,
+        draft: true,
+        id: doc.id,
+        locale,
+        operation,
+        req,
+        where: versionAccessResult,
+      },
+      false,
+    )
     return doc
   }
 
@@ -136,5 +169,16 @@ export const replaceWithDraftIfAvailable = async <T extends TypeWithID>({
 
   draft.version.id = doc.id
 
+  setCachedAccessResult(
+    {
+      collectionSlug: entity.slug,
+      draft: true,
+      id: doc.id,
+      locale,
+      operation,
+      req,
+      where: versionAccessResult,
+    },
+    true,
+  )
   return draft.version
 }
diff --git a/packages/payload/src/auth/accessCache/collectionAccessCache.spec.ts b/packages/payload/src/auth/accessCache/collectionAccessCache.spec.ts
new file mode 100644
index 0000000000..8554f89d2a
--- /dev/null
+++ b/packages/payload/src/auth/accessCache/collectionAccessCache.spec.ts
@@ -0,0 +1,293 @@
+import { describe, expect, test, vi } from 'vitest'
+import { executeAccess } from '../executeAccess.js'
+import {
+  getCachedAccessResult,
+  getCollectionAccessCacheDebug,
+  getCollectionAccessCacheKey,
+  getOrCreateCollectionAccessCache,
+  setCachedAccessResult,
+} from './collectionAccessCache.js'
+import type { AccessCacheScope } from './types.js'
+
+const createReq = (overrides: Record<string, unknown> = {}) =>
+  ({
+    context: {},
+    locale: 'en',
+    payloadAPI: 'REST',
+    routeParams: {},
+    t: (key: string) => key,
+    user: {
+      id: 'user-1',
+      collection: 'users',
+      role: 'editor',
+    },
+    ...overrides,
+  }) as any
+
+describe('collection access cache', () => {
+  test('uses a stable key for a logged-in user', () => {
+    const req = createReq()
+    const scope: AccessCacheScope = {
+      collectionSlug: 'posts',
+      id: 'post-1',
+      operation: 'read',
+      req,
+    }
+
+    expect(getCollectionAccessCacheKey(scope)).toBe('user:user-1')
+  })
+
+  test('reuses access result while resolving the same request', async () => {
+    const req = createReq()
+    const access = vi.fn().mockResolvedValue(true)
+
+    await expect(
+      executeAccess(
+        {
+          collectionSlug: 'posts',
+          id: 'post-1',
+          operation: 'read',
+          req,
+        },
+        access,
+      ),
+    ).resolves.toBe(true)
+
+    await expect(
+      executeAccess(
+        {
+          collectionSlug: 'posts',
+          id: 'post-2',
+          operation: 'read',
+          req,
+        },
+        access,
+      ),
+    ).resolves.toBe(true)
+
+    expect(access).toHaveBeenCalledTimes(1)
+    expect(getCollectionAccessCacheDebug(req).stats).toMatchObject({
+      hits: 1,
+      misses: 1,
+      size: 1,
+    })
+  })
+
+  test('reuses where constraints for relationship-heavy reads', async () => {
+    const req = createReq()
+    const access = vi.fn().mockResolvedValue({
+      tenant: {
+        equals: 'tenant-1',
+      },
+    })
+
+    const first = await executeAccess(
+      {
+        collectionSlug: 'posts',
+        operation: 'read',
+        req,
+      },
+      access,
+    )
+    const second = await executeAccess(
+      {
+        collectionSlug: 'posts',
+        operation: 'read',
+        req,
+      },
+      access,
+    )
+
+    expect(first).toEqual({
+      tenant: {
+        equals: 'tenant-1',
+      },
+    })
+    expect(second).toEqual(first)
+    expect(first).not.toBe(second)
+    expect(access).toHaveBeenCalledTimes(1)
+  })
+
+  test('allows document access to reuse a positive read decision', () => {
+    const req = createReq()
+    const cache = getOrCreateCollectionAccessCache(req)
+
+    cache.set(
+      {
+        collectionSlug: 'posts',
+        id: 'post-1',
+        operation: 'read',
+        req,
+      },
+      true,
+    )
+
+    expect(
+      getCachedAccessResult({
+        collectionSlug: 'posts',
+        id: 'post-2',
+        operation: 'read',
+        req,
+      }),
+    ).toBe(true)
+  })
+
+  test('caches draft misses so published reads do not keep querying versions', () => {
+    const req = createReq()
+
+    setCachedAccessResult(
+      {
+        collectionSlug: 'pages',
+        draft: true,
+        id: 'home',
+        operation: 'read',
+        req,
+      },
+      false,
+    )
+
+    expect(
+      getCachedAccessResult({
+        collectionSlug: 'pages',
+        draft: true,
+        id: 'home',
+        operation: 'read',
+        req,
+      }),
+    ).toBe(false)
+  })
+
+  test('shares access between published and draft reads for the same user', () => {
+    const req = createReq()
+    const publishedAccess = vi.fn().mockResolvedValue(true)
+    const draftAccess = vi.fn().mockResolvedValue(false)
+
+    expect(
+      getCollectionAccessCacheKey({
+        collectionSlug: 'pages',
+        draft: false,
+        id: 'home',
+        operation: 'read',
+        req,
+      }),
+    ).toEqual(
+      getCollectionAccessCacheKey({
+        collectionSlug: 'pages',
+        draft: true,
+        id: 'home',
+        operation: 'read',
+        req,
+      }),
+    )
+
+    setCachedAccessResult(
+      {
+        collectionSlug: 'pages',
+        draft: false,
+        id: 'home',
+        operation: 'read',
+        req,
+      },
+      true,
+    )
+
+    expect(
+      getCachedAccessResult({
+        collectionSlug: 'pages',
+        draft: true,
+        id: 'home',
+        operation: 'read',
+        req,
+      }),
+    ).toBe(true)
+
+    expect(publishedAccess).not.toHaveBeenCalled()
+    expect(draftAccess).not.toHaveBeenCalled()
+  })
+
+  test('can be disabled for background jobs', async () => {
+    const req = createReq({
+      context: {
+        isBackgroundJob: true,
+      },
+    })
+    const access = vi.fn().mockResolvedValue(true)
+
+    await executeAccess({ collectionSlug: 'posts', operation: 'read', req }, access)
+    await executeAccess({ collectionSlug: 'posts', operation: 'read', req }, access)
+
+    expect(access).toHaveBeenCalledTimes(2)
+  })
+})
diff --git a/packages/payload/src/auth/accessCache/collectionAccessCache.integration.spec.ts b/packages/payload/src/auth/accessCache/collectionAccessCache.integration.spec.ts
new file mode 100644
index 0000000000..11f2b5cf9a
--- /dev/null
+++ b/packages/payload/src/auth/accessCache/collectionAccessCache.integration.spec.ts
@@ -0,0 +1,292 @@
+import { describe, expect, test, vi } from 'vitest'
+import { executeAccess } from '../executeAccess.js'
+import { getCachedAccessResult, setCachedAccessResult } from './collectionAccessCache.js'
+
+const createReq = (overrides: Record<string, unknown> = {}) =>
+  ({
+    context: {},
+    fallbackLocale: 'en',
+    locale: 'en',
+    payloadAPI: 'GraphQL',
+    t: (key: string) => key,
+    user: {
+      id: 'editor-1',
+      collection: 'users',
+      role: 'editor',
+    },
+    ...overrides,
+  }) as any
+
+describe('collection access cache integration behavior', () => {
+  test('relationship resolver reuses access across collections for same user', async () => {
+    const req = createReq()
+    const postsAccess = vi.fn().mockResolvedValue(true)
+    const internalNotesAccess = vi.fn().mockResolvedValue(false)
+
+    const postsResult = await executeAccess(
+      {
+        collectionSlug: 'posts',
+        operation: 'read',
+        req,
+      },
+      postsAccess,
+    )
+
+    const internalNotesResult = await executeAccess(
+      {
+        collectionSlug: 'internal-notes',
+        operation: 'read',
+        req,
+      },
+      internalNotesAccess,
+    )
+
+    expect(postsResult).toBe(true)
+    expect(internalNotesResult).toBe(true)
+    expect(postsAccess).toHaveBeenCalledTimes(1)
+    expect(internalNotesAccess).not.toHaveBeenCalled()
+  })
+
+  test('same user can reuse read access for update doc access screen', async () => {
+    const req = createReq()
+    const readAccess = vi.fn().mockResolvedValue(true)
+    const updateAccess = vi.fn().mockResolvedValue(false)
+
+    await executeAccess(
+      {
+        collectionSlug: 'pages',
+        id: 'home',
+        operation: 'read',
+        req,
+      },
+      readAccess,
+    )
+
+    const updateResult = await executeAccess(
+      {
+        collectionSlug: 'pages',
+        data: {
+          title: 'Homepage',
+        },
+        id: 'home',
+        operation: 'update',
+        req,
+      },
+      updateAccess,
+    )
+
+    expect(updateResult).toBe(true)
+    expect(updateAccess).not.toHaveBeenCalled()
+  })
+
+  test('document-specific access is reused between ids', async () => {
+    const req = createReq()
+    const access = vi.fn(({ id }) => Promise.resolve(id === 'allowed-doc'))
+
+    const allowed = await executeAccess(
+      {
+        collectionSlug: 'posts',
+        id: 'allowed-doc',
+        operation: 'read',
+        req,
+      },
+      access as any,
+    )
+
+    const denied = await executeAccess(
+      {
+        collectionSlug: 'posts',
+        id: 'denied-doc',
+        operation: 'read',
+        req,
+      },
+      access as any,
+    )
+
+    expect(allowed).toBe(true)
+    expect(denied).toBe(true)
+    expect(access).toHaveBeenCalledTimes(1)
+  })
+
+  test('where result from one collection is reused in another collection query', async () => {
+    const req = createReq()
+    const postsAccess = vi.fn().mockResolvedValue({
+      tenant: {
+        equals: 'tenant-a',
+      },
+    })
+    const assetsAccess = vi.fn().mockResolvedValue({
+      owner: {
+        equals: 'editor-1',
+      },
+    })
+
+    const postsWhere = await executeAccess(
+      {
+        collectionSlug: 'posts',
+        operation: 'read',
+        req,
+      },
+      postsAccess,
+    )
+
+    const assetsWhere = await executeAccess(
+      {
+        collectionSlug: 'assets',
+        operation: 'read',
+        req,
+      },
+      assetsAccess,
+    )
+
+    expect(postsWhere).toEqual({
+      tenant: {
+        equals: 'tenant-a',
+      },
+    })
+    expect(assetsWhere).toEqual(postsWhere)
+    expect(assetsAccess).not.toHaveBeenCalled()
+  })
+
+  test('incoming mutation data does not create a distinct cache entry', async () => {
+    const req = createReq()
+    const access = vi.fn(({ data }) =>
+      Promise.resolve({
+        tenant: {
+          equals: data.tenant,
+        },
+      }),
+    )
+
+    const first = await executeAccess(
+      {
+        collectionSlug: 'posts',
+        data: {
+          tenant: 'tenant-a',
+        },
+        operation: 'update',
+        req,
+      },
+      access as any,
+    )
+
+    const second = await executeAccess(
+      {
+        collectionSlug: 'posts',
+        data: {
+          tenant: 'tenant-b',
+        },
+        operation: 'update',
+        req,
+      },
+      access as any,
+    )
+
+    expect(first).toEqual({
+      tenant: {
+        equals: 'tenant-a',
+      },
+    })
+    expect(second).toEqual(first)
+    expect(access).toHaveBeenCalledTimes(1)
+  })
+
+  test('draft preview read reuses published read cache', async () => {
+    const req = createReq({
+      context: {
+        preview: true,
+      },
+    })
+    const publishedAccess = vi.fn().mockResolvedValue(true)
+    const draftAccess = vi.fn().mockResolvedValue(false)
+
+    await executeAccess(
+      {
+        collectionSlug: 'pages',
+        draft: false,
+        id: 'home',
+        operation: 'read',
+        req,
+      },
+      publishedAccess,
+    )
+
+    const draftResult = await executeAccess(
+      {
+        collectionSlug: 'pages',
+        draft: true,
+        id: 'home',
+        operation: 'read',
+        req,
+      },
+      draftAccess,
+    )
+
+    expect(draftResult).toBe(true)
+    expect(draftAccess).not.toHaveBeenCalled()
+  })
+
+  test('draft cache lookup ignores locale and version where input', () => {
+    const req = createReq()
+
+    setCachedAccessResult(
+      {
+        collectionSlug: 'pages',
+        draft: true,
+        id: 'home',
+        locale: 'en',
+        operation: 'read',
+        req,
+        where: {
+          'version._status.en': {
+            equals: 'draft',
+          },
+        },
+      },
+      true,
+    )
+
+    const result = getCachedAccessResult({
+      collectionSlug: 'pages',
+      draft: true,
+      id: 'home',
+      locale: 'de',
+      operation: 'read',
+      req,
+      where: {
+        'version._status.de': {
+          equals: 'draft',
+        },
+      },
+    })
+
+    expect(result).toBe(true)
+  })
+
+  test('anonymous requests are separated only by route params', async () => {
+    const req = createReq({
+      routeParams: {
+        slug: 'posts',
+      },
+      user: null,
+    })
+
+    const firstAccess = vi.fn().mockResolvedValue(true)
+    const secondAccess = vi.fn().mockResolvedValue(false)
+
+    await executeAccess(
+      {
+        collectionSlug: 'posts',
+        operation: 'read',
+        req,
+      },
+      firstAccess,
+    )
+
+    const result = await executeAccess(
+      {
+        collectionSlug: 'pages',
+        operation: 'read',
+        req,
+      },
+      secondAccess,
+    )
+
+    expect(result).toBe(true)
+    expect(secondAccess).not.toHaveBeenCalled()
+  })
+})
```

## Intended Flaws

### Flaw 1: Access Cache Key Is Only User Identity, Not The Access Decision Inputs

- `type`: `authorization_cache_identity`
- `location`: `packages/payload/src/auth/accessCache/collectionAccessCache.ts:16-31`, `packages/payload/src/auth/executeAccess.ts:25-65`, `packages/payload/src/collections/operations/docAccess.ts:40-64`, `packages/payload/src/auth/accessCache/collectionAccessCache.spec.ts:19-69`, `packages/payload/src/auth/accessCache/collectionAccessCache.spec.ts:102-124`, `packages/payload/src/auth/accessCache/collectionAccessCache.integration.spec.ts:19-176`
- `learner_prompt`: Which inputs can a Payload access function depend on, and are all of those inputs represented in the cache key?

Expected answer:

- `identify`: The cache key collapses every logged-in request to `user:${id}`. It ignores collection slug, operation, document id, incoming data, locale, route, `isReadingStaticFile`, query context, and returned `Where` semantics. `executeAccess` passes those values into the cache scope, but `getCollectionAccessCacheKey()` discards them. A positive `read` result for one collection or document can be reused for another collection, another operation, or another document. `docAccess` makes the problem worse by turning a cached positive read into create/update/delete permissions.
- `impact`: Authorization becomes order-dependent inside a single request. A relationship-heavy GraphQL query can evaluate permissive access on `posts`, then reuse it for `privateNotes`; a document-specific `id` policy can be evaluated for `post-1` and reused for `post-2`; a `read` decision can inflate admin UI document permissions. This is a high-severity boundary bug because the cache appears request-local and safe, while silently skipping policy code.
- `fix_direction`: Either avoid caching access decisions broadly, or key by the full semantic decision: collection/global slug, operation, user identity and roles, document id, incoming data hash, locale, request context relevant to policies, static-file flag, draft/version mode, and policy version. Treat `Where` results separately from booleans. Keep docAccess permissions computed from their own operations, not from a cached read shortcut. Add negative tests where the same user has different permissions across two collections, two operations, and two ids.

Hints:

1. Compare the arguments accepted by `executeAccess` with the string returned by `getCollectionAccessCacheKey()`.
2. A `Where` result is not the same kind of thing as `true`.
3. Look at how `docAccess` turns one cached result into multiple operation permissions.

### Flaw 2: Draft And Published Reads Share The Same Cache Entry

- `type`: `draft_preview_access_leak`
- `location`: `packages/payload/src/auth/accessCache/collectionAccessCache.ts:16-31`, `packages/payload/src/collections/operations/find.ts:123-132`, `packages/payload/src/collections/operations/findByID.ts:112-131`, `packages/payload/src/versions/drafts/replaceWithDraftIfAvailable.ts:96-116`, `packages/payload/src/auth/accessCache/collectionAccessCache.spec.ts:147-190`, `packages/payload/src/auth/accessCache/collectionAccessCache.integration.spec.ts:177-239`
- `learner_prompt`: Does a published document read prove the caller can read an unpublished draft or preview version?

Expected answer:

- `identify`: The cache scope includes `draft`, but the key ignores it. A published read and a draft/preview read for the same user share the same cache entry. `find` and `findByID` pass `draftsEnabled` / `replaceWithVersion`, and `replaceWithDraftIfAvailable` checks the cache before querying versions, but the cache cannot distinguish published access from draft access. The test explicitly asserts that published and draft reads use the same key and that a published positive result is reused for draft access.
- `impact`: Users who can read published content can be shown unpublished drafts if a published access result is cached earlier in the request. In CMS workflows this leaks embargoed posts, unpublished page edits, legal copy, pricing changes, scheduled announcements, or private review notes. It can also hide valid drafts if a cached draft miss is reused against a later draft-capable context.
- `fix_direction`: Draft/version/preview state must be part of the authorization input and cache identity. More importantly, draft replacement should not rely on a generic collection access cache unless the access policy is explicitly declared draft-insensitive. Evaluate access for the version query with the state it will read, include locale and `_status` mode in the key, and test published-only users against draft-enabled collections through `find`, `findByID`, `replaceWithDraftIfAvailable`, REST, GraphQL, and local API paths.

Hints:

1. The cache scope records `draft`, but the key builder never uses it.
2. Follow `replaceWithVersion` from `findByID` into `replaceWithDraftIfAvailable`.
3. Draft content is a different resource state from the published document.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the cache-key identity bug and connect it to collection, operation, id, data, and context-sensitive access functions. Answers that only say "cache can be stale" are too generic.

For flaw 2, a correct answer must identify that published and draft reads share a cache entry. Answers that only mention "drafts need tests" are incomplete unless they explain the preview/unpublished-content leak.

### Product-Level Change

The PR tries to reduce repeated policy evaluation while resolving complex admin and GraphQL reads. That is a real performance goal, especially in CMS setups with relationship-heavy documents and custom access functions.

### Changed Contracts

- Access contract: `executeAccess` now has observable cache behavior.
- Request contract: `PayloadRequest` can carry a collection access cache and debug metadata.
- Operation contract: `find`, `findByID`, `docAccess`, and draft replacement now share access decisions.
- Draft contract: published and draft/version reads can reuse cached results.
- Admin UI contract: `docAccess` can skip full per-operation permission calculation after a cached read.

### Failure Modes

A GraphQL query first resolves public `posts`, where the current editor has read access. Later in the same request, it resolves a related `privateNotes` collection whose access function should deny the same editor. The cache key is still `user:user-1`, so `privateNotes` receives the cached `true`.

An editor can read the published `home` page but not drafts. The request reads the published page, then `findByID` with `replaceWithVersion` checks for a newer draft. `replaceWithDraftIfAvailable` sees cached access for the same user and lets the draft replacement proceed.

### Reviewer Thought Process

A strong reviewer treats authorization caching as one of the most dangerous optimizations in a backend. They list every input the policy can inspect, then verify the cache key includes every input that can change the answer.

Then they look for state transitions: published versus draft, read versus update, collection-level versus document-level, and boolean versus `Where`. Any cache that flattens those distinctions is not a performance improvement; it is a policy bypass.

### Better Implementation Direction

- Prefer narrow caching inside one permission calculation, like the existing identical-`Where` cache in `getEntityPermissions`.
- If caching `executeAccess`, make callers pass an explicit access-decision identity and fail closed when the identity is incomplete.
- Include collection/global slug, operation, id, data hash, locale, roles, policy version, request context, static-file flag, and draft/version state.
- Do not reuse `read` permission for `create`, `update`, or `delete` docAccess results.
- Keep draft/version access evaluation separate unless a policy declares it is draft-insensitive.
- Add tests for same user across different collections, ids, operations, locales, and draft/published reads.

## Why This Case Exists

This case teaches that cache keys are architecture. In authorization code, a missing cache-key dimension is not a performance detail; it is a new permission model, usually one nobody meant to design.
