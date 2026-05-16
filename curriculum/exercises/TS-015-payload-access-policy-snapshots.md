# TS-015: Payload Access Policy Snapshots

## Metadata

- `id`: TS-015
- `source_repo`: [payloadcms/payload](https://github.com/payloadcms/payload)
- `repo_area`: access execution, entity permissions, document access endpoint, version storage, SQL/Mongo version adapters, migrations, version tests
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 861
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about access-control history, policy snapshots, migration determinism, version-table shape, and audit semantics without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR stores access policy snapshots on document versions.

Customers using Payload for regulated content want to answer: "Who could read, update, or delete this document when this version was created?" The PR evaluates collection and field access rules during create/update/restore, stores the evaluated result on the version row, exposes the snapshot in version APIs, and adds a migration to backfill policy snapshots for existing versions.

The PR adds:

- an `accessPolicySnapshot` JSON field on collection version records,
- a helper that evaluates collection and field access results for the current request,
- snapshot capture during create, update, autosave, and restore,
- API support for reading the stored snapshot from version responses,
- SQL and Mongo adapter writes for the new field,
- a migration that backfills existing version rows,
- tests for storing and reading access policy snapshots.

## Existing Code Context

The real Payload codebase already has these relevant contracts:

- `packages/payload/src/auth/executeAccess.ts` executes collection access functions and returns either `boolean` or a `Where` constraint.
- `packages/payload/src/utilities/getEntityPermissions/getEntityPermissions.ts` builds permission results for collections/globals, can fetch the current document, and resolves field permissions.
- `packages/payload/src/collections/operations/docAccess.ts` exposes document access by calling `getEntityPermissions`, then sanitizing permissions for clients.
- `packages/payload/src/collections/operations/utilities/update.ts` runs hooks, validates data, writes the document, then calls `saveVersion` for versioned collections.
- `packages/payload/src/versions/saveVersion.ts` stores document versions and optionally stores localized snapshots through `saveSnapshot`.
- `packages/payload/src/versions/buildCollectionFields.ts` defines the fields in version collections. Version rows store the document copy under `version`, plus metadata like `parent`, `createdAt`, `updatedAt`, `latest`, `autosave`, and `snapshot`.
- `packages/drizzle/src/createVersion.ts` and `packages/db-mongodb/src/createVersion.ts` are adapter-specific version write implementations.
- `packages/payload/src/database/migrations/migrationTemplate.ts` and generated template migrations are meant to be stable historical artifacts. They should not change behavior when app config or runtime helper code changes later.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/payload/src/versions/types.ts`
- `packages/payload/src/versions/baseFields.ts`
- `packages/payload/src/versions/buildCollectionFields.ts`
- `packages/payload/src/access-policy-snapshots/buildAccessPolicySnapshot.ts`
- `packages/payload/src/versions/saveVersion.ts`
- `packages/payload/src/versions/saveSnapshot.ts`
- `packages/payload/src/collections/operations/create.ts`
- `packages/payload/src/collections/operations/utilities/update.ts`
- `packages/payload/src/collections/operations/restoreVersion.ts`
- `packages/payload/src/collections/operations/findVersions.ts`
- `packages/payload/src/collections/operations/findVersionByID.ts`
- `packages/drizzle/src/createVersion.ts`
- `packages/db-mongodb/src/createVersion.ts`
- `packages/payload/src/database/migrations/20260514110000_backfill_access_policy_snapshots.ts`
- `test/versions/policy-snapshots.int.spec.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on storage contract, policy semantics, migration determinism, and historical audit correctness.

## Diff

```diff
diff --git a/packages/payload/src/versions/types.ts b/packages/payload/src/versions/types.ts
index 305aa19871..30d583dbe2 100644
--- a/packages/payload/src/versions/types.ts
+++ b/packages/payload/src/versions/types.ts
@@ -1,3 +1,25 @@
+export type AccessPolicySnapshot = {
+  createdAt: string
+  actor: {
+    collection?: string
+    id?: number | string
+    roles?: string[]
+  } | null
+  collection: string
+  operations: {
+    create?: boolean | Record<string, unknown>
+    delete?: boolean | Record<string, unknown>
+    read?: boolean | Record<string, unknown>
+    readVersions?: boolean | Record<string, unknown>
+    update?: boolean | Record<string, unknown>
+  }
+  fields: Record<
+    string,
+    {
+      create?: boolean
+      read?: boolean
+      update?: boolean
+    }
+  >
+}
+
 export type Autosave = {
   /**
    * Define an `interval` in milliseconds to automatically save progress while documents are edited.
@@ -133,6 +155,7 @@ export type TypeWithVersion<T> = {
   createdAt: string
   id: string
   latest?: boolean
+  accessPolicySnapshot?: AccessPolicySnapshot | null
   parent: number | string
   publishedLocale?: string
   snapshot?: boolean
diff --git a/packages/payload/src/versions/baseFields.ts b/packages/payload/src/versions/baseFields.ts
index 78e39cc68d..5ef5b84e4c 100644
--- a/packages/payload/src/versions/baseFields.ts
+++ b/packages/payload/src/versions/baseFields.ts
@@ -1,4 +1,22 @@
 import type { Field } from '../fields/config/types.js'
 
+export const versionAccessPolicySnapshotField: Field = {
+  name: 'accessPolicySnapshot',
+  type: 'json',
+  admin: {
+    disabled: true,
+    hidden: true,
+  },
+  label: 'Access Policy Snapshot',
+}
+
 export const versionSnapshotField: Field = {
   name: 'snapshot',
   type: 'checkbox',
diff --git a/packages/payload/src/versions/buildCollectionFields.ts b/packages/payload/src/versions/buildCollectionFields.ts
index 1e6d9e6122..743b7d0db6 100644
--- a/packages/payload/src/versions/buildCollectionFields.ts
+++ b/packages/payload/src/versions/buildCollectionFields.ts
@@ -3,7 +3,7 @@ import type { SanitizedConfig } from '../config/types.js'
 import type { Field, FlattenedField } from '../fields/config/types.js'
 
 import { hasAutosaveEnabled, hasDraftsEnabled } from '../utilities/getVersionsConfig.js'
-import { versionSnapshotField } from './baseFields.js'
+import { versionAccessPolicySnapshotField, versionSnapshotField } from './baseFields.js'
 
 export const buildVersionCollectionFields = <T extends boolean = false>(
   config: SanitizedConfig,
@@ -27,6 +27,7 @@ export const buildVersionCollectionFields = <T extends boolean = false>(
       index: true,
     },
     versionSnapshotField,
+    versionAccessPolicySnapshotField,
   ]
 
   if (hasDraftsEnabled(collection)) {
diff --git a/packages/payload/src/access-policy-snapshots/buildAccessPolicySnapshot.ts b/packages/payload/src/access-policy-snapshots/buildAccessPolicySnapshot.ts
new file mode 100644
index 0000000000..b8d05d9240
--- /dev/null
+++ b/packages/payload/src/access-policy-snapshots/buildAccessPolicySnapshot.ts
@@ -0,0 +1,222 @@
+import type { SanitizedCollectionConfig, TypeWithID } from '../collections/config/types.js'
+import type { JsonObject, PayloadRequest } from '../types/index.js'
+import type { AccessPolicySnapshot } from '../versions/types.js'
+
+import { getEntityPermissions } from '../utilities/getEntityPermissions/getEntityPermissions.js'
+
+const policyOperations = ['create', 'read', 'update', 'delete', 'readVersions'] as const
+
+type Args = {
+  collection: SanitizedCollectionConfig
+  data?: JsonObject
+  doc?: (JsonObject & TypeWithID) | null
+  operation: 'create' | 'restoreVersion' | 'update'
+  req: PayloadRequest
+}
+
+const serializePermission = (permission: unknown): boolean | Record<string, unknown> => {
+  if (typeof permission === 'boolean') {
+    return permission
+  }
+
+  if (!permission || typeof permission !== 'object') {
+    return false
+  }
+
+  const maybePermission = permission as {
+    permission?: boolean
+    where?: Record<string, unknown>
+  }
+
+  if (maybePermission.where) {
+    return maybePermission.where
+  }
+
+  return Boolean(maybePermission.permission)
+}
+
+const serializeFieldPermissions = (
+  fields: Record<string, Record<string, { permission?: boolean }>>,
+): AccessPolicySnapshot['fields'] => {
+  return Object.entries(fields).reduce<AccessPolicySnapshot['fields']>((acc, [fieldName, permission]) => {
+    acc[fieldName] = {
+      create: Boolean(permission.create?.permission),
+      read: Boolean(permission.read?.permission),
+      update: Boolean(permission.update?.permission),
+    }
+    return acc
+  }, {})
+}
+
+export async function buildAccessPolicySnapshot({
+  collection,
+  data,
+  doc,
+  operation,
+  req,
+}: Args): Promise<AccessPolicySnapshot> {
+  const permissions = await getEntityPermissions({
+    id: doc?.id,
+    blockReferencesPermissions: {},
+    data: data ?? doc ?? undefined,
+    entity: collection,
+    entityType: 'collection',
+    fetchData: Boolean(doc?.id) as true,
+    operations: [...policyOperations],
+    req,
+  })
+
+  return {
+    createdAt: new Date().toISOString(),
+    actor: req.user
+      ? {
+          collection: req.user.collection,
+          id: req.user.id,
+          roles: Array.isArray((req.user as Record<string, unknown>).roles)
+            ? ((req.user as Record<string, unknown>).roles as string[])
+            : undefined,
+        }
+      : null,
+    collection: collection.slug,
+    operations: {
+      create: serializePermission(permissions.create),
+      delete: serializePermission(permissions.delete),
+      read: serializePermission(permissions.read),
+      readVersions: serializePermission(permissions.readVersions),
+      update: serializePermission(permissions.update),
+    },
+    fields: serializeFieldPermissions(permissions.fields),
+  }
+}
+
+export function redactSnapshotForClient(snapshot: AccessPolicySnapshot | null | undefined) {
+  if (!snapshot) {
+    return null
+  }
+
+  return {
+    actor: snapshot.actor,
+    collection: snapshot.collection,
+    createdAt: snapshot.createdAt,
+    fields: snapshot.fields,
+    operations: snapshot.operations,
+  }
+}
diff --git a/packages/payload/src/versions/saveVersion.ts b/packages/payload/src/versions/saveVersion.ts
index 5a19389ef3..1dac64f4d8 100644
--- a/packages/payload/src/versions/saveVersion.ts
+++ b/packages/payload/src/versions/saveVersion.ts
@@ -2,7 +2,7 @@ import type { SanitizedCollectionConfig } from '../collections/config/types.js'
 import type { SanitizedGlobalConfig } from '../globals/config/types.js'
 import type { CreateGlobalVersionArgs, CreateVersionArgs, Payload } from '../index.js'
 import type { JsonObject, PayloadRequest, SelectType } from '../types/index.js'
+import type { AccessPolicySnapshot } from './types.js'
 
 import { deepCopyObjectSimple } from '../index.js'
 import { getVersionsMax } from '../utilities/getVersionsConfig.js'
@@ -14,6 +14,7 @@ import { updateLatestVersion } from './updateLatestVersion.js'
 
 type Args<T extends JsonObject = JsonObject> = {
+  accessPolicySnapshot?: AccessPolicySnapshot | null
   autosave?: boolean
   collection?: SanitizedCollectionConfig
   docWithLocales: T
@@ -45,6 +46,7 @@ export async function saveVersion<TData extends JsonObject = JsonObject>({
   id,
+  accessPolicySnapshot,
   autosave,
   collection,
   docWithLocales,
@@ -94,6 +96,7 @@ export async function saveVersion<TData extends JsonObject = JsonObject>({
         autosave: Boolean(autosave),
+        accessPolicySnapshot: accessPolicySnapshot ?? null,
         collectionSlug: undefined as string | undefined,
         createdAt: operation === 'restoreVersion' ? versionData.createdAt : now,
         globalSlug: undefined as string | undefined,
@@ -122,6 +125,7 @@ export async function saveVersion<TData extends JsonObject = JsonObject>({
       if (snapshot) {
         await saveSnapshot<TData>({
           id,
+          accessPolicySnapshot,
           autosave,
           collection,
           data: snapshot,
diff --git a/packages/payload/src/versions/saveSnapshot.ts b/packages/payload/src/versions/saveSnapshot.ts
index 8308d0a16d..f66760a523 100644
--- a/packages/payload/src/versions/saveSnapshot.ts
+++ b/packages/payload/src/versions/saveSnapshot.ts
@@ -2,6 +2,7 @@ import type { SanitizedCollectionConfig } from '../collections/config/types.js'
 import type { SanitizedGlobalConfig } from '../globals/config/types.js'
 import type { Payload, TypeWithVersion } from '../index.js'
 import type { JsonObject, PayloadRequest, SelectType } from '../types/index.js'
+import type { AccessPolicySnapshot } from './types.js'
 
 import { deepCopyObjectSimple } from '../index.js'
 import { getQueryDraftsSelect } from './drafts/getQueryDraftsSelect.js'
@@ -9,6 +10,7 @@ import { getQueryDraftsSelect } from './drafts/getQueryDraftsSelect.js'
 type Args<T extends JsonObject = JsonObject> = {
+  accessPolicySnapshot?: AccessPolicySnapshot | null
   autosave?: boolean
   collection?: SanitizedCollectionConfig
   data?: T
@@ -24,6 +26,7 @@ export const saveSnapshot = async <T extends JsonObject = JsonObject>({
   id,
+  accessPolicySnapshot,
   autosave,
   collection,
   data,
@@ -50,6 +53,7 @@ export const saveSnapshot = async <T extends JsonObject = JsonObject>({
     returning: false,
     select: getQueryDraftsSelect({ select }),
     updatedAt: snapshotDate,
     versionData: docData,
+    accessPolicySnapshot: accessPolicySnapshot ?? null,
   }
 
   if (collection && id) {
diff --git a/packages/payload/src/collections/operations/create.ts b/packages/payload/src/collections/operations/create.ts
index 3bd1baf54e..eed995af49 100644
--- a/packages/payload/src/collections/operations/create.ts
+++ b/packages/payload/src/collections/operations/create.ts
@@ -18,6 +18,7 @@ import { afterRead } from '../../fields/hooks/afterRead/index.js'
 import { beforeChange } from '../../fields/hooks/beforeChange/index.js'
 import { beforeValidate } from '../../fields/hooks/beforeValidate/index.js'
 import { saveVersion } from '../../index.js'
+import { buildAccessPolicySnapshot } from '../../access-policy-snapshots/buildAccessPolicySnapshot.js'
 import { generateFileData } from '../../uploads/generateFileData.js'
 import { unlinkTempFiles } from '../../uploads/unlinkTempFiles.js'
 import { uploadFiles } from '../../uploads/uploadFiles.js'
@@ -310,6 +311,19 @@ export const createOperation = async <
       )
     }
 
+    const accessPolicySnapshot =
+      collectionConfig.versions && req.user
+        ? await buildAccessPolicySnapshot({
+            collection: collectionConfig,
+            data,
+            doc: resultWithLocales,
+            operation: 'create',
+            req,
+          })
+        : null
+
     // /////////////////////////////////////
     // Create version
     // /////////////////////////////////////
@@ -318,6 +332,7 @@ export const createOperation = async <
       resultWithLocales = await saveVersion({
         id: resultWithLocales.id as number | string,
+        accessPolicySnapshot,
         autosave,
         collection: collectionConfig,
         docWithLocales: resultWithLocales,
diff --git a/packages/payload/src/collections/operations/utilities/update.ts b/packages/payload/src/collections/operations/utilities/update.ts
index 69925e2e4c..f01b162ace 100644
--- a/packages/payload/src/collections/operations/utilities/update.ts
+++ b/packages/payload/src/collections/operations/utilities/update.ts
@@ -18,6 +18,7 @@ import { generatePasswordSaltHash } from '../../../auth/strategies/local/generat
 import { afterChange } from '../../../fields/hooks/afterChange/index.js'
 import { afterRead } from '../../../fields/hooks/afterRead/index.js'
 import { beforeChange } from '../../../fields/hooks/beforeChange/index.js'
+import { buildAccessPolicySnapshot } from '../../../access-policy-snapshots/buildAccessPolicySnapshot.js'
 import { beforeValidate } from '../../../fields/hooks/beforeValidate/index.js'
 import { deepCopyObjectSimple, getLatestCollectionVersion, saveVersion } from '../../../index.js'
 import { deleteAssociatedFiles } from '../../../uploads/deleteAssociatedFiles.js'
@@ -350,13 +351,25 @@ export const updateDocument = async <
     resultWithLocales = await req.payload.db.updateOne({
       id,
       collection: collectionConfig.slug,
       data: dataToUpdate,
       locale,
       req,
     })
   }
 
+  const accessPolicySnapshot =
+    collectionConfig.versions && req.user
+      ? await buildAccessPolicySnapshot({
+          collection: collectionConfig,
+          data: dataToUpdate,
+          doc: resultWithLocales,
+          operation: 'update',
+          req,
+        })
+      : null
+
   // /////////////////////////////////////
   // Create version
   // /////////////////////////////////////
 
   if (collectionConfig.versions) {
     resultWithLocales = await saveVersion({
       id,
+      accessPolicySnapshot,
       autosave,
       collection: collectionConfig,
       docWithLocales: resultWithLocales,
diff --git a/packages/payload/src/collections/operations/restoreVersion.ts b/packages/payload/src/collections/operations/restoreVersion.ts
index 7a66c7d8ae..a9ec86983d 100644
--- a/packages/payload/src/collections/operations/restoreVersion.ts
+++ b/packages/payload/src/collections/operations/restoreVersion.ts
@@ -14,6 +14,7 @@ import { afterChange } from '../../fields/hooks/afterChange/index.js'
 import { afterRead } from '../../fields/hooks/afterRead/index.js'
 import { beforeChange } from '../../fields/hooks/beforeChange/index.js'
 import { beforeValidate } from '../../fields/hooks/beforeValidate/index.js'
+import { buildAccessPolicySnapshot } from '../../access-policy-snapshots/buildAccessPolicySnapshot.js'
 import { commitTransaction } from '../../utilities/commitTransaction.js'
 import { deepCopyObjectSimple } from '../../utilities/deepCopyObject.js'
 import { hasDraftValidationEnabled } from '../../utilities/getVersionsConfig.js'
@@ -214,10 +215,23 @@ export const restoreVersionOperation = async <
       req,
     })
 
+    const accessPolicySnapshot =
+      collectionConfig.versions && req.user
+        ? await buildAccessPolicySnapshot({
+            collection: collectionConfig,
+            data: result,
+            doc: result,
+            operation: 'restoreVersion',
+            req,
+          })
+        : null
+
     result = await saveVersion({
       id: parentDocID,
+      accessPolicySnapshot,
       collection: collectionConfig,
       docWithLocales: result,
       draft: draftArg,
       operation: 'restoreVersion',
diff --git a/packages/payload/src/collections/operations/findVersions.ts b/packages/payload/src/collections/operations/findVersions.ts
index 44b2714b8b..2b18e4a7f3 100644
--- a/packages/payload/src/collections/operations/findVersions.ts
+++ b/packages/payload/src/collections/operations/findVersions.ts
@@ -9,6 +9,7 @@ import { appendNonTrashedFilter } from '../../utilities/appendNonTrashedFilter.j
 import { killTransaction } from '../../utilities/killTransaction.js'
 import { resolveSelect } from '../../utilities/resolveSelect.js'
 import { sanitizeInternalFields } from '../../utilities/sanitizeInternalFields.js'
+import { redactSnapshotForClient } from '../../access-policy-snapshots/buildAccessPolicySnapshot.js'
 import { sanitizeSelect } from '../../utilities/sanitizeSelect.js'
 import { buildVersionCollectionFields } from '../../versions/buildCollectionFields.js'
 import { buildAfterOperation } from './utilities/buildAfterOperation.js'
@@ -24,6 +25,7 @@ export type Arguments = {
   depth?: number
+  includeAccessPolicySnapshot?: boolean
   limit?: number
   overrideAccess?: boolean
   page?: number
@@ -64,6 +66,7 @@ export const findVersionsOperation = async <TData extends TypeWithVersion<TData>
       collection: { config: collectionConfig },
       depth,
+      includeAccessPolicySnapshot = true,
       limit,
       overrideAccess,
       page,
@@ -118,6 +121,13 @@ export const findVersionsOperation = async <TData extends TypeWithVersion<TData>
       versions: true,
     })
 
+    if (includeAccessPolicySnapshot) {
+      if (typeof select === 'object') {
+        select.accessPolicySnapshot = true
+      }
+    }
+
     // /////////////////////////////////////
     // Find
     // /////////////////////////////////////
@@ -209,7 +219,25 @@ export const findVersionsOperation = async <TData extends TypeWithVersion<TData>
 
     // /////////////////////////////////////
     // Return results
     // /////////////////////////////////////
-    result.docs = result.docs.map((doc) => sanitizeInternalFields<TData>(doc))
+    result.docs = result.docs.map((doc) => {
+      const sanitized = sanitizeInternalFields<TData>(doc)
+
+      if (!includeAccessPolicySnapshot) {
+        delete (sanitized as Record<string, unknown>).accessPolicySnapshot
+        return sanitized
+      }
+
+      ;(sanitized as Record<string, unknown>).accessPolicySnapshot = redactSnapshotForClient(
+        (doc as Record<string, any>).accessPolicySnapshot,
+      )
+
+      return sanitized
+    })
 
     // /////////////////////////////////////
     // afterOperation - Collection
diff --git a/packages/payload/src/collections/operations/findVersionByID.ts b/packages/payload/src/collections/operations/findVersionByID.ts
index 84a52b7694..1a69e6d1de 100644
--- a/packages/payload/src/collections/operations/findVersionByID.ts
+++ b/packages/payload/src/collections/operations/findVersionByID.ts
@@ -10,6 +10,7 @@ import { afterRead } from '../../fields/hooks/afterRead/index.js'
 import { appendNonTrashedFilter } from '../../utilities/appendNonTrashedFilter.js'
 import { killTransaction } from '../../utilities/killTransaction.js'
 import { resolveSelect } from '../../utilities/resolveSelect.js'
+import { redactSnapshotForClient } from '../../access-policy-snapshots/buildAccessPolicySnapshot.js'
 import { sanitizeSelect } from '../../utilities/sanitizeSelect.js'
 import { buildVersionCollectionFields } from '../../versions/buildCollectionFields.js'
 import { buildAfterOperation } from './utilities/buildAfterOperation.js'
@@ -21,6 +22,7 @@ export type Arguments = {
   currentDepth?: number
   depth?: number
   disableErrors?: boolean
+  includeAccessPolicySnapshot?: boolean
   id: number | string
   overrideAccess?: boolean
   populate?: PopulateType
@@ -42,6 +44,7 @@ export const findVersionByIDOperation = async <TData extends TypeWithID = any>(
     depth,
     disableErrors,
+    includeAccessPolicySnapshot = true,
     overrideAccess,
     populate,
     req: { fallbackLocale, locale, payload },
@@ -91,6 +94,13 @@ export const findVersionByIDOperation = async <TData extends TypeWithID = any>(
       versions: true,
     })
 
+    if (includeAccessPolicySnapshot) {
+      if (typeof select === 'object') {
+        select.accessPolicySnapshot = true
+      }
+    }
+
     const versionsQuery = await payload.db.findVersions<TData>({
       collection: collectionConfig.slug,
       limit: 1,
@@ -178,6 +188,14 @@ export const findVersionByIDOperation = async <TData extends TypeWithID = any>(
       result,
     })
 
+    if (includeAccessPolicySnapshot) {
+      ;(result as Record<string, unknown>).accessPolicySnapshot = redactSnapshotForClient(
+        (result as Record<string, any>).accessPolicySnapshot,
+      )
+    } else {
+      delete (result as Record<string, unknown>).accessPolicySnapshot
+    }
+
     // /////////////////////////////////////
     // Return results
     // /////////////////////////////////////
diff --git a/packages/drizzle/src/createVersion.ts b/packages/drizzle/src/createVersion.ts
index 8f7fcd7f88..e2b74468f5 100644
--- a/packages/drizzle/src/createVersion.ts
+++ b/packages/drizzle/src/createVersion.ts
@@ -17,6 +17,7 @@ export async function createVersion<T extends JsonObject = JsonObject>(
   {
+    accessPolicySnapshot,
     autosave,
     collectionSlug,
     createdAt,
@@ -46,6 +47,7 @@ export async function createVersion<T extends JsonObject = JsonObject>(
   const data: Record<string, unknown> = {
+    accessPolicySnapshot,
     autosave,
     createdAt,
     latest: true,
diff --git a/packages/db-mongodb/src/createVersion.ts b/packages/db-mongodb/src/createVersion.ts
index 04a05ad7dd..55589cd092 100644
--- a/packages/db-mongodb/src/createVersion.ts
+++ b/packages/db-mongodb/src/createVersion.ts
@@ -8,6 +8,7 @@ export const createVersion: CreateVersion = async function createVersion(
   this: MongooseAdapter,
   {
+    accessPolicySnapshot,
     autosave,
     collectionSlug,
     createdAt,
@@ -29,6 +30,7 @@ export const createVersion: CreateVersion = async function createVersion(
 
   const data = {
+    accessPolicySnapshot,
     autosave,
     createdAt,
     latest: true,
diff --git a/packages/payload/src/database/migrations/20260514110000_backfill_access_policy_snapshots.ts b/packages/payload/src/database/migrations/20260514110000_backfill_access_policy_snapshots.ts
new file mode 100644
index 0000000000..e01f9c7702
--- /dev/null
+++ b/packages/payload/src/database/migrations/20260514110000_backfill_access_policy_snapshots.ts
@@ -0,0 +1,172 @@
+import type { MigrateUpArgs, MigrateDownArgs } from '@payloadcms/db-postgres'
+
+import configPromise from '../../../../payload.config.js'
+import { buildAccessPolicySnapshot } from '../../access-policy-snapshots/buildAccessPolicySnapshot.js'
+import { getPayload } from '../../index.js'
+import { createLocalReq } from '../../utilities/createLocalReq.js'
+
+const BATCH_SIZE = 500
+
+type VersionRow = {
+  id: string
+  parent: string
+  updatedAt: string
+  version: Record<string, unknown>
+}
+
+const versionTablesByCollection = {
+  pages: '_pages_v',
+  posts: '_posts_v',
+}
+
+export async function up({ db, payload }: MigrateUpArgs): Promise<void> {
+  const config = await configPromise
+  const runtimePayload = await getPayload({ config })
+
+  for (const [collectionSlug, tableName] of Object.entries(versionTablesByCollection)) {
+    const collection = runtimePayload.collections[collectionSlug]?.config
+    if (!collection?.versions) {
+      continue
+    }
+
+    let offset = 0
+    let rows: VersionRow[] = []
+
+    do {
+      rows = await db.execute<VersionRow>(
+        `select id, parent, "updatedAt", version
+         from ${tableName}
+         where "accessPolicySnapshot" is null
+         order by "updatedAt" asc
+         limit ${BATCH_SIZE}
+         offset ${offset}`,
+      )
+
+      for (const row of rows) {
+        const req = await createLocalReq(
+          {
+            context: {
+              source: 'access-policy-snapshot-backfill',
+            },
+            payload: runtimePayload,
+            user: {
+              id: 'system',
+              collection: runtimePayload.config.admin.user,
+              roles: ['system'],
+            },
+          },
+          runtimePayload,
+        )
+
+        const snapshot = await buildAccessPolicySnapshot({
+          collection,
+          data: row.version,
+          doc: {
+            ...row.version,
+            id: row.parent,
+          },
+          operation: 'update',
+          req,
+        })
+
+        await db.execute(
+          `update ${tableName}
+           set "accessPolicySnapshot" = $1
+           where id = $2`,
+          [JSON.stringify(snapshot), row.id],
+        )
+      }
+
+      offset += BATCH_SIZE
+    } while (rows.length === BATCH_SIZE)
+  }
+}
+
+export async function down({ db }: MigrateDownArgs): Promise<void> {
+  for (const tableName of Object.values(versionTablesByCollection)) {
+    await db.execute(`update ${tableName} set "accessPolicySnapshot" = null`)
+  }
+}
diff --git a/test/versions/policy-snapshots.int.spec.ts b/test/versions/policy-snapshots.int.spec.ts
new file mode 100644
index 0000000000..7786d40c04
--- /dev/null
+++ b/test/versions/policy-snapshots.int.spec.ts
@@ -0,0 +1,214 @@
+import { describe, expect, it } from 'vitest'
+import payload from 'payload'
+
+describe('access policy snapshots', () => {
+  it('stores policy snapshots when creating a versioned document', async () => {
+    const user = await payload.login({
+      collection: 'users',
+      data: {
+        email: 'editor@example.com',
+        password: 'test',
+      },
+    })
+
+    const doc = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Policy snapshot post',
+        status: 'draft',
+      },
+      req: {
+        user,
+      },
+    })
+
+    const versions = await payload.findVersions({
+      collection: 'posts',
+      where: {
+        parent: {
+          equals: doc.id,
+        },
+      },
+    })
+
+    expect(versions.docs[0]).toMatchObject({
+      accessPolicySnapshot: {
+        actor: {
+          id: user.id,
+          collection: 'users',
+        },
+        collection: 'posts',
+        operations: {
+          read: true,
+          update: true,
+        },
+      },
+    })
+  })
+
+  it('stores policy snapshots when updating a versioned document', async () => {
+    const user = await payload.login({
+      collection: 'users',
+      data: {
+        email: 'editor@example.com',
+        password: 'test',
+      },
+    })
+
+    const doc = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Before',
+        status: 'draft',
+      },
+      req: {
+        user,
+      },
+    })
+
+    await payload.update({
+      collection: 'posts',
+      id: doc.id,
+      data: {
+        title: 'After',
+      },
+      req: {
+        user,
+      },
+    })
+
+    const versions = await payload.findVersions({
+      collection: 'posts',
+      sort: '-updatedAt',
+      where: {
+        parent: {
+          equals: doc.id,
+        },
+      },
+    })
+
+    expect(versions.docs[0]?.accessPolicySnapshot?.operations.update).toBe(true)
+  })
+
+  it('backfills existing version rows', async () => {
+    await payload.db.createVersion({
+      collectionSlug: 'posts',
+      parent: 'post-1',
+      versionData: {
+        title: 'Legacy version',
+      },
+      createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
+      updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
+    })
+
+    await payload.db.migrate({
+      name: '20260514110000_backfill_access_policy_snapshots',
+    })
+
+    const versions = await payload.findVersions({
+      collection: 'posts',
+      where: {
+        parent: {
+          equals: 'post-1',
+        },
+      },
+    })
+
+    expect(versions.docs[0]?.accessPolicySnapshot).toMatchObject({
+      actor: {
+        id: 'system',
+      },
+      collection: 'posts',
+    })
+  })
+
+  it('returns snapshot data from findVersionByID', async () => {
+    const user = await payload.login({
+      collection: 'users',
+      data: {
+        email: 'editor@example.com',
+        password: 'test',
+      },
+    })
+
+    const doc = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Readable version',
+      },
+      req: {
+        user,
+      },
+    })
+
+    const versions = await payload.findVersions({
+      collection: 'posts',
+      where: {
+        parent: {
+          equals: doc.id,
+        },
+      },
+    })
+
+    const version = await payload.findVersionByID({
+      collection: 'posts',
+      id: versions.docs[0]!.id,
+    })
+
+    expect(version.accessPolicySnapshot?.collection).toBe('posts')
+  })
+
+  it('can omit snapshots from list responses', async () => {
+    const user = await payload.login({
+      collection: 'users',
+      data: {
+        email: 'viewer@example.com',
+        password: 'test',
+      },
+    })
+
+    const doc = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Omit policy snapshot',
+      },
+      req: {
+        user,
+      },
+    })
+
+    const versions = await payload.findVersions({
+      collection: 'posts',
+      includeAccessPolicySnapshot: false,
+      where: {
+        parent: {
+          equals: doc.id,
+        },
+      },
+    })
+
+    expect(versions.docs[0]).not.toHaveProperty('accessPolicySnapshot')
+  })
+
+  it('redacts snapshots in list responses', async () => {
+    const user = await payload.login({
+      collection: 'users',
+      data: {
+        email: 'reader@example.com',
+        password: 'test',
+      },
+    })
+
+    const doc = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'List policy snapshot',
+      },
+      req: {
+        user,
+      },
+    })
+
+    const versions = await payload.findVersions({
+      collection: 'posts',
+      includeAccessPolicySnapshot: true,
+      where: {
+        parent: {
+          equals: doc.id,
+        },
+      },
+    })
+
+    expect(versions.docs[0]?.accessPolicySnapshot).toMatchObject({
+      actor: {
+        id: user.id,
+      },
+      collection: 'posts',
+      fields: expect.any(Object),
+      operations: expect.any(Object),
+    })
+  })
+})
```

## Intended Flaws

### Flaw 1: Policy Snapshot Has No Versioned Contract

- `type`: `contract_design`
- `location`: `packages/payload/src/versions/types.ts:1-24`, `packages/payload/src/access-policy-snapshots/buildAccessPolicySnapshot.ts:1-83`, `packages/payload/src/versions/baseFields.ts:1-18`, `test/versions/policy-snapshots.int.spec.ts:1-94`
- `learner_prompt`: Will a reviewer in one year know what this snapshot means after access rules, fields, roles, and collection config have changed?

Expected answer:

- `identify`: The snapshot stores a raw evaluated object with actor, operations, and fields, but has no schema version, collection config hash, policy source hash, plugin/version metadata, evaluated input summary, or reason structure. `boolean` and `Where` results are flattened into `boolean | Record<string, unknown>` with no discriminator. The tests only assert today's object shape and do not prove future readability or migration of the snapshot format.
- `impact`: The product claims historical audit value, but the stored artifact is ambiguous. After access functions change, fields are renamed, roles are reworked, or `Where` semantics evolve, old snapshots cannot be reliably interpreted or compared. Support cannot tell whether a user had access because of a role, a document filter, a field rule, or a default logged-in fallback. Future code cannot safely transform or display old snapshots because there is no versioned contract.
- `fix_direction`: Make this a versioned audit artifact. Store `schemaVersion`, collection slug, collection config hash or policy hash, Payload package version, normalized operation entries with discriminated result types, field-rule entries with explicit operations, and enough evaluated input metadata to explain the decision without leaking the whole document. Add decode/migrate tests for at least v1 and an unknown/future version path.

Hints:

1. "Snapshot" implies future interpretation. Look for a version number or shape discriminator.
2. A `Where` object and a boolean do not mean the same thing, but this shape makes them peers.
3. Compare the stated product question to what the stored JSON can actually explain later.

### Flaw 2: Historical Migration Imports Live Runtime Policy Code

- `type`: `migration_hygiene`
- `location`: `packages/payload/src/database/migrations/20260514110000_backfill_access_policy_snapshots.ts:1-80`, `packages/payload/src/access-policy-snapshots/buildAccessPolicySnapshot.ts:49-83`, `test/versions/policy-snapshots.int.spec.ts:96-122`
- `learner_prompt`: Will this migration produce the same result when it is run six months from now on a fresh environment?

Expected answer:

- `identify`: The migration imports `payload.config.js`, boots the live app with `getPayload`, imports the current `buildAccessPolicySnapshot` helper, and runs current access functions over old version rows. That means the migration's output changes whenever the app config, helper logic, plugins, roles, environment variables, or access functions change. It is not a stable historical migration.
- `impact`: New installs, staging restores, and delayed self-hosted upgrades can backfill different policy snapshots for the same historical versions. A migration can fail because today's config requires services/secrets that did not exist when the migration was written. It can also run arbitrary app hooks/access code while migrating, making deploys slower, less deterministic, and harder to debug. The audit trail becomes misleading because "policy at version creation time" is actually "policy at migration execution time."
- `fix_direction`: Do not evaluate live access policy inside a historical migration. Either leave old versions with an explicit `snapshotUnavailable` v1 marker and only capture snapshots for new writes, or generate a migration-local, pinned serializer that records limited static metadata without executing user policy. If a backfill is required, run it as an explicit operational job with a pinned code version, progress tracking, and clear semantics such as `backfilledAt` and `evaluatedWithPolicyVersion`.

Hints:

1. Migrations are historical artifacts; imported application helpers keep changing.
2. Access functions can depend on env vars, plugins, network clients, current roles, and current config.
3. The migration claims to reconstruct the past but evaluates today's policy code.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the missing versioned contract of the stored snapshot. Answers that only say "JSON is flexible" are incomplete unless they explain why historical audit data needs shape versioning and discriminated semantics.

For flaw 2, a correct answer must identify that the migration imports live runtime code and current config. Answers that only say "the migration may be slow" are incomplete unless they explain nondeterminism and historical inaccuracy.

### Product-Level Change

The PR tries to make document versions answer an audit question: what access policy applied when a version was created. That is a strong product direction for regulated teams, but only if the snapshot is durable and interpretable.

### Changed Contracts

- Version storage contract: version rows gain `accessPolicySnapshot`.
- Access contract: collection/field access results are serialized for history.
- Adapter contract: SQL and Mongo version writes must persist the new field.
- API contract: version read endpoints can expose policy snapshot data.
- Migration contract: existing version rows are backfilled with policy snapshots.

### Failure Modes

A customer changes `posts.access.read` from `{ tenant: { equals: user.tenant } }` to role-based access. Six months later they restore staging and run migrations. The backfill writes role-based snapshots onto old versions that were created under tenant-based access. Audit now lies.

A plugin renames a role field from `roles` to `groups`. Old snapshots still store `actor.roles`, but there is no schema version or decoder. The admin UI cannot tell whether missing roles means "no roles," "old format," or "field not captured."

### Reviewer Thought Process

A strong reviewer first asks what "snapshot" means. If it is for audit, it needs a stable schema, provenance, and semantics. A raw object that happens to match today's permission shape is not enough.

The second move is to inspect migrations for imports. If a migration imports current app config or business logic, it can change behavior after it is merged. Migrations should be boring, local, and deterministic unless explicitly documented as an operational job.

### Better Implementation Direction

- Capture snapshots only for new writes first.
- Define `AccessPolicySnapshotV1` with a `schemaVersion`.
- Store policy/config hash, package version, operation result discriminators, and redacted evaluated inputs.
- Add decoders for known snapshot versions and safe rendering for unknown versions.
- Avoid live access evaluation in migrations.
- If old rows need backfill, use an explicit operational job with pinned semantics and `backfilledAt`.
- Add tests for old snapshot versions, unknown versions, policy changes after snapshot creation, and migration determinism.

## Why This Case Exists

This case teaches that audit features are contracts with the future. The code can pass tests today and still fail the core product promise if the stored artifact cannot be trusted after the system evolves.
