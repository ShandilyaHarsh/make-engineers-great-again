# TS-057: Payload Document Change Stream API

## Metadata

- `id`: TS-057
- `source_repo`: [payloadcms/payload](https://github.com/payloadcms/payload)
- `repo_area`: collection create/update/delete operations, field-level access, hidden fields, afterRead sanitization, collection hooks, realtime event streams, subscription contracts, API compatibility
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,850-2,250
- `represented_diff_lines`: 1909
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Payload collection operations, hidden fields, read access, afterRead projection, change streams, event versioning, and durable API contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a document change stream API to Payload. Applications can subscribe to create/update/delete events for collections and receive realtime notifications when documents change. The goal is to let search indexers, collaboration surfaces, cache layers, webhooks, and internal extensions stop polling the REST API for recent changes.

The PR adds:

- a `changeStream` collection config option,
- a global change stream service,
- REST endpoints for subscriptions,
- an in-memory subscriber registry,
- create/update/delete integration,
- tests for event delivery and subscriber filtering,
- docs for cache invalidation, search indexing, webhook relays, and admin realtime UIs.

The intended product behavior is: subscribers should only receive document fields they are allowed to read, and the event envelope should be stable enough for long-lived integrations.

## Existing Code Context

The real Payload codebase already has these relevant contracts:

- `packages/payload/src/collections/operations/create.ts` executes collection `access.create`, writes the document, runs `afterRead`, field hooks, collection `afterRead`, `afterChange`, `afterOperation`, and then commits the transaction.
- `packages/payload/src/collections/operations/update.ts` resolves update access into a `Where`, retrieves matching docs, then delegates each document update to `operations/utilities/update.ts`.
- `packages/payload/src/collections/operations/delete.ts` resolves delete access, fetches matching docs with a sanitized `select`, deletes documents, then runs `afterRead` on the deleted document shape returned to the caller.
- `packages/payload/src/fields/hooks/afterRead/index.ts` is responsible for removing hidden fields, flattening locales, running field hooks, applying field read access, and populating relationships.
- `packages/payload/src/fields/hooks/afterRead/promise.ts` deletes hidden fields when `showHiddenFields` is false and deletes fields when `field.access.read` returns false.
- `packages/payload/src/utilities/sanitizeSelect.ts` and `resolveSelect.ts` are used by collection operations to constrain returned fields.
- `packages/payload/src/collections/operations/docAccess.ts` computes sanitized per-document permissions for admin surfaces.
- Auth collections can include private fields such as password hashes, verification tokens, sessions, API keys, lock state, and other fields that are intentionally not returned through ordinary reads.
- Payload plugins rely on operation results and hook args having well-defined, permission-aware shapes.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether the new change stream preserves Payload's read-access and API compatibility contracts.

## Review Surface

Changed files in the synthetic PR:

- `packages/payload/src/changeStream/types.ts`
- `packages/payload/src/changeStream/changeStreamRegistry.ts`
- `packages/payload/src/changeStream/projectDocumentForChangeStream.ts`
- `packages/payload/src/changeStream/changeStreamService.ts`
- `packages/payload/src/changeStream/endpoints.ts`
- `packages/payload/src/collections/config/types.ts`
- `packages/payload/src/collections/operations/create.ts`
- `packages/payload/src/collections/operations/utilities/update.ts`
- `packages/payload/src/collections/operations/delete.ts`
- `packages/payload/src/changeStream/changeStreamService.spec.ts`
- `packages/payload/src/changeStream/projectDocumentForChangeStream.spec.ts`
- `test/change-stream/config.ts`
- `test/change-stream/int.spec.ts`
- `docs/change-stream.md`

The line references below use synthetic PR line numbers. The represented diff is focused on whether the event payload is permission-projected and whether the event contract is versioned.

## Diff

```diff
diff --git a/packages/payload/src/changeStream/types.ts b/packages/payload/src/changeStream/types.ts
new file mode 100644
index 0000000000..56b963a1c1
--- /dev/null
+++ b/packages/payload/src/changeStream/types.ts
@@ -0,0 +1,83 @@
+import type { CollectionSlug, JsonObject, PayloadRequest, RequestContext } from '../index.js'
+import type { SanitizedCollectionConfig } from '../collections/config/types.js'
+
+export type ChangeStreamOperation = 'create' | 'update' | 'delete'
+
+export type ChangeStreamSubscriber = {
+  id: string
+  collectionSlug: CollectionSlug | '*'
+  createdAt: Date
+  includeDeletes?: boolean
+  label?: string
+  req: PayloadRequest
+  send: (event: ChangeStreamEvent) => Promise<void> | void
+}
+
+export type ChangeStreamConfig = {
+  enabled?: boolean
+  includeDeletes?: boolean
+  includeFullDocument?: boolean
+  includePreviousDocument?: boolean
+}
+
+export type ChangeStreamMutationInput = {
+  collection: SanitizedCollectionConfig
+  context: RequestContext
+  doc: JsonObject
+  operation: ChangeStreamOperation
+  previousDoc?: JsonObject | null
+  req: PayloadRequest
+}
+
+export type ChangeStreamEvent = {
+  id: string
+  type: 'payload.change'
+  collection: CollectionSlug
+  operation: ChangeStreamOperation
+  docID: number | string
+  timestamp: string
+  locale?: string
+  fallbackLocale?: string
+  doc: JsonObject
+  previousDoc?: JsonObject | null
+  actor: {
+    id?: number | string
+    collection?: string
+    email?: string
+  } | null
+  metadata: {
+    autosave?: boolean
+    draft?: boolean
+    depth?: number
+    source: 'collection-operation'
+  }
+}
+
+export type ChangeStreamProjectArgs = {
+  collection: SanitizedCollectionConfig
+  event: ChangeStreamEvent
+  subscriber: ChangeStreamSubscriber
+}
+
+export type ChangeStreamPublishArgs = {
+  input: ChangeStreamMutationInput
+}
+
+export type ChangeStreamRegistry = {
+  add: (subscriber: ChangeStreamSubscriber) => void
+  clear: () => void
+  list: (collectionSlug: CollectionSlug) => ChangeStreamSubscriber[]
+  remove: (id: string) => void
+}
+
+export function getActor(req: PayloadRequest): ChangeStreamEvent['actor'] {
+  if (!req.user) {
+    return null
+  }
+
+  return {
+    id: req.user.id as number | string,
+    collection: req.user.collection,
+    email: typeof req.user.email === 'string' ? req.user.email : undefined,
+  }
+}
diff --git a/packages/payload/src/changeStream/changeStreamRegistry.ts b/packages/payload/src/changeStream/changeStreamRegistry.ts
new file mode 100644
index 0000000000..89b37c9de0
--- /dev/null
+++ b/packages/payload/src/changeStream/changeStreamRegistry.ts
@@ -0,0 +1,32 @@
+import type { CollectionSlug } from '../index.js'
+import type { ChangeStreamRegistry, ChangeStreamSubscriber } from './types.js'
+
+class InMemoryChangeStreamRegistry implements ChangeStreamRegistry {
+  private subscribers = new Map<string, ChangeStreamSubscriber>()
+
+  add(subscriber: ChangeStreamSubscriber): void {
+    this.subscribers.set(subscriber.id, subscriber)
+  }
+
+  clear(): void {
+    this.subscribers.clear()
+  }
+
+  list(collectionSlug: CollectionSlug): ChangeStreamSubscriber[] {
+    const result: ChangeStreamSubscriber[] = []
+
+    for (const subscriber of this.subscribers.values()) {
+      if (subscriber.collectionSlug === '*' || subscriber.collectionSlug === collectionSlug) {
+        result.push(subscriber)
+      }
+    }
+
+    return result
+  }
+
+  remove(id: string): void {
+    this.subscribers.delete(id)
+  }
+}
+
+export const changeStreamRegistry = new InMemoryChangeStreamRegistry()
diff --git a/packages/payload/src/changeStream/projectDocumentForChangeStream.ts b/packages/payload/src/changeStream/projectDocumentForChangeStream.ts
new file mode 100644
index 0000000000..8129df357d
--- /dev/null
+++ b/packages/payload/src/changeStream/projectDocumentForChangeStream.ts
@@ -0,0 +1,45 @@
+import type { JsonObject } from '../index.js'
+import type { ChangeStreamEvent, ChangeStreamProjectArgs } from './types.js'
+
+export async function projectDocumentForChangeStream({
+  collection,
+  event,
+  subscriber,
+}: ChangeStreamProjectArgs): Promise<ChangeStreamEvent | null> {
+  if (subscriber.collectionSlug !== '*' && subscriber.collectionSlug !== event.collection) {
+    return null
+  }
+
+  if (event.operation === 'delete' && subscriber.includeDeletes === false) {
+    return null
+  }
+
+  if (!collection.config.changeStream?.includeFullDocument) {
+    return {
+      ...event,
+      doc: minimalDocument(event.doc),
+      previousDoc: event.previousDoc ? minimalDocument(event.previousDoc) : null,
+    }
+  }
+
+  return {
+    ...event,
+    doc: cloneForSubscriber(event.doc),
+    previousDoc: event.previousDoc ? cloneForSubscriber(event.previousDoc) : null,
+  }
+}
+
+function minimalDocument(doc: JsonObject): JsonObject {
+  return {
+    id: doc.id,
+    updatedAt: doc.updatedAt,
+  }
+}
+
+function cloneForSubscriber<T extends JsonObject | null>(doc: T): T {
+  if (!doc) {
+    return doc
+  }
+
+  return JSON.parse(JSON.stringify(doc)) as T
+}
diff --git a/packages/payload/src/changeStream/changeStreamService.ts b/packages/payload/src/changeStream/changeStreamService.ts
new file mode 100644
index 0000000000..b465b7d272
--- /dev/null
+++ b/packages/payload/src/changeStream/changeStreamService.ts
@@ -0,0 +1,61 @@
+import crypto from 'crypto'
+
+import type { JsonObject } from '../index.js'
+import { projectDocumentForChangeStream } from './projectDocumentForChangeStream.js'
+import { changeStreamRegistry } from './changeStreamRegistry.js'
+import { getActor, type ChangeStreamEvent, type ChangeStreamPublishArgs } from './types.js'
+
+export class ChangeStreamService {
+  async publish({ input }: ChangeStreamPublishArgs): Promise<ChangeStreamEvent | null> {
+    if (!input.collection.config.changeStream?.enabled) {
+      return null
+    }
+
+    const event = this.buildEvent({ input })
+    const subscribers = changeStreamRegistry.list(input.collection.config.slug)
+
+    for (const subscriber of subscribers) {
+      const projected = await projectDocumentForChangeStream({
+        collection: input.collection,
+        event,
+        subscriber,
+      })
+
+      if (projected) {
+        await subscriber.send(projected)
+      }
+    }
+
+    return event
+  }
+
+  buildEvent({ input }: ChangeStreamPublishArgs): ChangeStreamEvent {
+    return {
+      id: crypto.randomUUID(),
+      type: 'payload.change',
+      collection: input.collection.config.slug,
+      operation: input.operation,
+      docID: input.doc.id as number | string,
+      timestamp: new Date().toISOString(),
+      locale: input.req.locale,
+      fallbackLocale: Array.isArray(input.req.fallbackLocale)
+        ? input.req.fallbackLocale.join(',')
+        : input.req.fallbackLocale,
+      doc: clone(input.doc),
+      previousDoc: input.previousDoc ? clone(input.previousDoc) : null,
+      actor: getActor(input.req),
+      metadata: {
+        autosave: input.context.autosave === true,
+        draft: input.context.draft === true,
+        depth: typeof input.context.depth === 'number' ? input.context.depth : undefined,
+        source: 'collection-operation',
+      },
+    }
+  }
+}
+
+function clone<T extends JsonObject>(doc: T): T {
+  return JSON.parse(JSON.stringify(doc)) as T
+}
+
+export const changeStreamService = new ChangeStreamService()
diff --git a/packages/payload/src/changeStream/endpoints.ts b/packages/payload/src/changeStream/endpoints.ts
new file mode 100644
index 0000000000..7a481d27e9
--- /dev/null
+++ b/packages/payload/src/changeStream/endpoints.ts
@@ -0,0 +1,44 @@
+import crypto from 'crypto'
+
+import type { PayloadHandler } from '../config/types.js'
+import { changeStreamRegistry } from './changeStreamRegistry.js'
+import type { ChangeStreamEvent, ChangeStreamSubscriber } from './types.js'
+
+export const subscribeToChangeStream: PayloadHandler = async (req) => {
+  const body = await req.json?.()
+  const subscriptionID = crypto.randomUUID()
+  const collectionSlug = body?.collectionSlug ?? '*'
+  const events: ChangeStreamEvent[] = []
+
+  const subscriber: ChangeStreamSubscriber = {
+    id: subscriptionID,
+    collectionSlug,
+    createdAt: new Date(),
+    includeDeletes: body?.includeDeletes !== false,
+    label: body?.label,
+    req,
+    send(event) {
+      events.push(event)
+      req.payload.logger.debug({
+        msg: 'queued change stream event for REST subscriber',
+        subscriptionID,
+        collection: event.collection,
+        operation: event.operation,
+      })
+    },
+  }
+
+  changeStreamRegistry.add(subscriber)
+
+  return Response.json({
+    id: subscriptionID,
+    collectionSlug,
+    events,
+  })
+}
+
+export const unsubscribeFromChangeStream: PayloadHandler = async (req) => {
+  const body = await req.json?.()
+  changeStreamRegistry.remove(body?.id)
+  return Response.json({ id: body?.id, ok: true })
+}
diff --git a/packages/payload/src/collections/config/types.ts b/packages/payload/src/collections/config/types.ts
index 31336a9712..8efb8d3602 100644
--- a/packages/payload/src/collections/config/types.ts
+++ b/packages/payload/src/collections/config/types.ts
@@ -44,6 +44,7 @@ import type { Operator, PayloadRequest, Where } from '../../types/index.js'
 import type { CollectionAdminOptions } from './client.js'
+import type { ChangeStreamConfig } from '../../changeStream/types.js'
 
 export type CollectionConfig = {
   slug: string
@@ -338,6 +339,20 @@ export type CollectionConfig = {
   /**
    * Enables document trash for this collection.
    */
   trash?: boolean
+
+  /**
+   * Emits realtime change events for creates, updates, and deletes.
+   *
+   * When `includeFullDocument` is true, subscribers receive the full document
+   * object that the mutation path produced. This includes hidden fields and
+   * fields omitted by the collection's default `select`.
+   */
+  changeStream?: ChangeStreamConfig
 }
diff --git a/packages/payload/src/collections/operations/create.ts b/packages/payload/src/collections/operations/create.ts
index 157bc36c42..0ee592a7ce 100644
--- a/packages/payload/src/collections/operations/create.ts
+++ b/packages/payload/src/collections/operations/create.ts
@@ -22,6 +22,7 @@ import { beforeChange } from '../../fields/hooks/beforeChange/index.js'
 import { beforeValidate } from '../../fields/hooks/beforeValidate/index.js'
 import { saveVersion } from '../../index.js'
+import { changeStreamService } from '../../changeStream/changeStreamService.js'
 import { generateFileData } from '../../uploads/generateFileData.js'
 import { unlinkTempFiles } from '../../uploads/unlinkTempFiles.js'
@@ -410,6 +411,22 @@ export const createOperation = async <
     await unlinkTempFiles({ collectionConfig, config, req })
 
+    await changeStreamService.publish({
+      input: {
+        collection,
+        context: {
+          autosave,
+          depth,
+          draft,
+        },
+        doc: {
+          ...resultWithLocales,
+          password: data.password,
+          _verificationToken: verificationToken,
+        },
+        operation: 'create',
+        previousDoc: null,
+        req,
+      },
+    })
+
     // /////////////////////////////////////
     // Return results
     // /////////////////////////////////////
diff --git a/packages/payload/src/collections/operations/utilities/update.ts b/packages/payload/src/collections/operations/utilities/update.ts
index 591d0e6c15..5a6c0b5298 100644
--- a/packages/payload/src/collections/operations/utilities/update.ts
+++ b/packages/payload/src/collections/operations/utilities/update.ts
@@ -29,6 +29,7 @@ import { beforeValidate } from '../../../fields/hooks/beforeValidate/index.js'
 import { saveVersion } from '../../../versions/saveVersion.js'
+import { changeStreamService } from '../../../changeStream/changeStreamService.js'
 import { checkDocumentLockStatus } from '../../../utilities/checkDocumentLockStatus.js'
@@ -462,6 +463,23 @@ export const updateDocument = async <
   result = await buildAfterOperation({
     args,
     collection: collectionConfig,
     operation: 'update',
     overrideAccess,
     result,
   })
+
+  await changeStreamService.publish({
+    input: {
+      collection: {
+        config: collectionConfig,
+      },
+      context: {
+        autosave,
+        depth,
+        draft: draftArg,
+      },
+      doc: {
+        ...result,
+        ...data,
+      },
+      operation: 'update',
+      previousDoc: docWithLocales,
+      req,
+    },
+  })
 
   return result
 }
diff --git a/packages/payload/src/collections/operations/delete.ts b/packages/payload/src/collections/operations/delete.ts
index 647cef9c00..7495a21da7 100644
--- a/packages/payload/src/collections/operations/delete.ts
+++ b/packages/payload/src/collections/operations/delete.ts
@@ -16,6 +16,7 @@ import { afterRead } from '../../fields/hooks/afterRead/index.js'
 import { deleteUserPreferences } from '../../preferences/deleteUserPreferences.js'
 import { deleteAssociatedFiles } from '../../uploads/deleteAssociatedFiles.js'
+import { changeStreamService } from '../../changeStream/changeStreamService.js'
 import { appendNonTrashedFilter } from '../../utilities/appendNonTrashedFilter.js'
@@ -280,6 +281,21 @@ export const deleteOperation = async <
         if (docShouldCommit) {
           await commitTransaction(req)
         }
+
+        await changeStreamService.publish({
+          input: {
+            collection,
+            context: {
+              depth,
+            },
+            doc: {
+              ...doc,
+              deletedAt: new Date().toISOString(),
+            },
+            operation: 'delete',
+            previousDoc: doc,
+            req,
+          },
+        })
 
         return result
       } catch (error) {
diff --git a/packages/payload/src/changeStream/changeStreamService.spec.ts b/packages/payload/src/changeStream/changeStreamService.spec.ts
new file mode 100644
index 0000000000..8f5c4e3e44
--- /dev/null
+++ b/packages/payload/src/changeStream/changeStreamService.spec.ts
@@ -0,0 +1,193 @@
+import { beforeEach, describe, expect, it, vi } from 'vitest'
+import { changeStreamRegistry } from './changeStreamRegistry.js'
+import { changeStreamService } from './changeStreamService.js'
+import type { ChangeStreamEvent } from './types.js'
+
+describe('changeStreamService', () => {
+  beforeEach(() => {
+    changeStreamRegistry.clear()
+  })
+
+  it('publishes document changes to matching subscribers', async () => {
+    const received: ChangeStreamEvent[] = []
+    changeStreamRegistry.add({
+      id: 'sub_1',
+      collectionSlug: 'posts',
+      createdAt: new Date(),
+      req: request(),
+      send: vi.fn((event) => {
+        received.push(event)
+      }),
+    })
+
+    await changeStreamService.publish({
+      input: {
+        collection: collection({ includeFullDocument: true }),
+        context: {},
+        doc: postDoc(),
+        operation: 'update',
+        previousDoc: { ...postDoc(), title: 'Old title' },
+        req: request(),
+      },
+    })
+
+    expect(received).toHaveLength(1)
+    expect(received[0]).toMatchObject({
+      type: 'payload.change',
+      collection: 'posts',
+      operation: 'update',
+      docID: 1,
+    })
+  })
+
+  it('does not include a schema version in the envelope', async () => {
+    const event = changeStreamService.buildEvent({
+      input: {
+        collection: collection({ includeFullDocument: true }),
+        context: {},
+        doc: postDoc(),
+        operation: 'create',
+        req: request(),
+      },
+    })
+
+    expect(event).not.toHaveProperty('version')
+    expect(event).not.toHaveProperty('schemaVersion')
+    expect(Object.keys(event)).toEqual([
+      'id',
+      'type',
+      'collection',
+      'operation',
+      'docID',
+      'timestamp',
+      'locale',
+      'fallbackLocale',
+      'doc',
+      'previousDoc',
+      'actor',
+      'metadata',
+    ])
+  })
+
+  it('sends hidden and private fields when full documents are enabled', async () => {
+    const received: ChangeStreamEvent[] = []
+    changeStreamRegistry.add({
+      id: 'sub_1',
+      collectionSlug: 'posts',
+      createdAt: new Date(),
+      req: request({
+        user: {
+          id: 'editor',
+          collection: 'users',
+          role: 'editor',
+        },
+      }),
+      send: vi.fn((event) => {
+        received.push(event)
+      }),
+    })
+
+    await changeStreamService.publish({
+      input: {
+        collection: collection({ includeFullDocument: true }),
+        context: {},
+        doc: postDoc({
+          apiKey: 'sk_live_secret',
+          internalNotes: 'acquisition target',
+          salaryBand: 'executive',
+        }),
+        operation: 'update',
+        previousDoc: postDoc({
+          apiKey: 'sk_old',
+          internalNotes: 'old private note',
+        }),
+        req: request(),
+      },
+    })
+
+    expect(received[0]!.doc).toMatchObject({
+      apiKey: 'sk_live_secret',
+      internalNotes: 'acquisition target',
+      salaryBand: 'executive',
+    })
+    expect(received[0]!.previousDoc).toMatchObject({
+      apiKey: 'sk_old',
+      internalNotes: 'old private note',
+    })
+  })
+
+  it('falls back to id and updatedAt when includeFullDocument is disabled', async () => {
+    const received: ChangeStreamEvent[] = []
+    changeStreamRegistry.add({
+      id: 'sub_1',
+      collectionSlug: 'posts',
+      createdAt: new Date(),
+      req: request(),
+      send: vi.fn((event) => {
+        received.push(event)
+      }),
+    })
+
+    await changeStreamService.publish({
+      input: {
+        collection: collection({ includeFullDocument: false }),
+        context: {},
+        doc: postDoc({ internalNotes: 'private' }),
+        operation: 'update',
+        req: request(),
+      },
+    })
+
+    expect(received[0]!.doc).toEqual({
+      id: 1,
+      updatedAt: '2026-05-01T00:00:00.000Z',
+    })
+  })
+
+  function collection(options: { includeFullDocument: boolean }) {
+    return {
+      config: {
+        slug: 'posts',
+        changeStream: {
+          enabled: true,
+          includeDeletes: true,
+          includeFullDocument: options.includeFullDocument,
+          includePreviousDocument: true,
+        },
+      },
+    } as any
+  }
+
+  function postDoc(overrides: Record<string, unknown> = {}) {
+    return {
+      id: 1,
+      title: 'Launch post',
+      slug: 'launch-post',
+      status: 'published',
+      apiKey: 'sk_live_secret',
+      internalNotes: 'private note',
+      salaryBand: 'private compensation',
+      updatedAt: '2026-05-01T00:00:00.000Z',
+      ...overrides,
+    }
+  }
+
+  function request(overrides: Record<string, unknown> = {}) {
+    return {
+      context: {},
+      fallbackLocale: 'en',
+      locale: 'en',
+      payload: {
+        logger: {
+          debug: vi.fn(),
+        },
+      },
+      user: {
+        id: 'admin',
+        collection: 'users',
+        email: 'admin@example.com',
+      },
+      ...overrides,
+    } as any
+  }
+})
diff --git a/packages/payload/src/changeStream/projectDocumentForChangeStream.spec.ts b/packages/payload/src/changeStream/projectDocumentForChangeStream.spec.ts
new file mode 100644
index 0000000000..56439ee8c5
--- /dev/null
+++ b/packages/payload/src/changeStream/projectDocumentForChangeStream.spec.ts
@@ -0,0 +1,194 @@
+import { describe, expect, it } from 'vitest'
+import { projectDocumentForChangeStream } from './projectDocumentForChangeStream.js'
+import type { ChangeStreamEvent } from './types.js'
+
+describe('projectDocumentForChangeStream', () => {
+  it('returns the full event for matching collection subscribers', async () => {
+    const event = await projectDocumentForChangeStream({
+      collection: collection({
+        includeFullDocument: true,
+      }),
+      event: changeEvent(),
+      subscriber: subscriber(),
+    })
+
+    expect(event?.doc).toEqual({
+      id: 1,
+      title: 'Updated',
+      apiKey: 'sk_live_secret',
+      passwordHash: '$2b$10$hash',
+      internalNotes: 'private',
+      updatedAt: '2026-05-01T00:00:00.000Z',
+    })
+  })
+
+  it('does not run field access before returning doc and previousDoc', async () => {
+    const event = await projectDocumentForChangeStream({
+      collection: collection({
+        includeFullDocument: true,
+        fields: [
+          {
+            name: 'title',
+            type: 'text',
+          },
+          {
+            name: 'apiKey',
+            type: 'text',
+            access: {
+              read: () => false,
+            },
+          },
+          {
+            name: 'passwordHash',
+            type: 'text',
+            hidden: true,
+          },
+        ],
+      }),
+      event: changeEvent({
+        doc: {
+          id: 1,
+          title: 'Updated',
+          apiKey: 'sk_live_secret',
+          passwordHash: '$2b$10$hash',
+        },
+        previousDoc: {
+          id: 1,
+          title: 'Old',
+          apiKey: 'sk_old',
+          passwordHash: '$2b$10$old',
+        },
+      }),
+      subscriber: subscriber({
+        user: {
+          id: 'editor',
+          collection: 'users',
+          role: 'editor',
+        },
+      }),
+    })
+
+    expect(event?.doc).toMatchObject({
+      apiKey: 'sk_live_secret',
+      passwordHash: '$2b$10$hash',
+    })
+    expect(event?.previousDoc).toMatchObject({
+      apiKey: 'sk_old',
+      passwordHash: '$2b$10$old',
+    })
+  })
+
+  it('returns a minimal document only when full documents are disabled', async () => {
+    const event = await projectDocumentForChangeStream({
+      collection: collection({
+        includeFullDocument: false,
+      }),
+      event: changeEvent(),
+      subscriber: subscriber(),
+    })
+
+    expect(event?.doc).toEqual({
+      id: 1,
+      updatedAt: '2026-05-01T00:00:00.000Z',
+    })
+  })
+
+  it('drops delete events for subscribers that opted out', async () => {
+    const event = await projectDocumentForChangeStream({
+      collection: collection({
+        includeFullDocument: true,
+      }),
+      event: changeEvent({
+        operation: 'delete',
+      }),
+      subscriber: subscriber({
+        includeDeletes: false,
+      }),
+    })
+
+    expect(event).toBeNull()
+  })
+
+  it('keeps delete documents full when delete subscribers are enabled', async () => {
+    const event = await projectDocumentForChangeStream({
+      collection: collection({
+        includeFullDocument: true,
+      }),
+      event: changeEvent({
+        operation: 'delete',
+        doc: {
+          id: 1,
+          title: 'Deleted',
+          resetPasswordToken: 'token',
+          sessions: [{ id: 'session_1', expiresAt: '2026-06-01' }],
+          updatedAt: '2026-05-01T00:00:00.000Z',
+        },
+      }),
+      subscriber: subscriber(),
+    })
+
+    expect(event?.doc).toMatchObject({
+      resetPasswordToken: 'token',
+      sessions: [{ id: 'session_1', expiresAt: '2026-06-01' }],
+    })
+  })
+
+  function collection(options: {
+    fields?: unknown[]
+    includeFullDocument: boolean
+  }) {
+    return {
+      config: {
+        slug: 'posts',
+        fields: options.fields ?? [],
+        changeStream: {
+          enabled: true,
+          includeFullDocument: options.includeFullDocument,
+        },
+      },
+    } as any
+  }
+
+  function subscriber(overrides: Record<string, unknown> = {}) {
+    return {
+      id: 'sub_1',
+      collectionSlug: 'posts',
+      createdAt: new Date(),
+      includeDeletes: true,
+      req: {
+        context: {},
+        payload: {},
+        user: null,
+      },
+      send: () => undefined,
+      ...overrides,
+    } as any
+  }
+
+  function changeEvent(overrides: Partial<ChangeStreamEvent> = {}): ChangeStreamEvent {
+    return {
+      id: 'evt_1',
+      type: 'payload.change',
+      collection: 'posts',
+      operation: 'update',
+      docID: 1,
+      timestamp: '2026-05-01T00:00:00.000Z',
+      locale: 'en',
+      fallbackLocale: 'en',
+      doc: {
+        id: 1,
+        title: 'Updated',
+        apiKey: 'sk_live_secret',
+        passwordHash: '$2b$10$hash',
+        internalNotes: 'private',
+        updatedAt: '2026-05-01T00:00:00.000Z',
+      },
+      previousDoc: null,
+      actor: null,
+      metadata: {
+        source: 'collection-operation',
+      },
+      ...overrides,
+    }
+  }
+})
diff --git a/test/change-stream/config.ts b/test/change-stream/config.ts
new file mode 100644
index 0000000000..d71f97e6a9
--- /dev/null
+++ b/test/change-stream/config.ts
@@ -0,0 +1,72 @@
+import { buildConfig } from 'payload'
+
+export default buildConfig({
+  collections: [
+    {
+      slug: 'users',
+      auth: true,
+      fields: [
+        {
+          name: 'role',
+          type: 'select',
+          options: ['admin', 'editor'],
+        },
+      ],
+      access: {
+        read: ({ req }) => Boolean(req.user),
+      },
+      changeStream: {
+        enabled: true,
+        includeDeletes: true,
+        includeFullDocument: true,
+        includePreviousDocument: true,
+      },
+    },
+    {
+      slug: 'posts',
+      fields: [
+        {
+          name: 'title',
+          type: 'text',
+          required: true,
+        },
+        {
+          name: 'status',
+          type: 'select',
+          options: ['draft', 'published'],
+        },
+        {
+          name: 'internalNotes',
+          type: 'textarea',
+          access: {
+            read: ({ req }) => req.user?.role === 'admin',
+          },
+        },
+        {
+          name: 'apiKey',
+          type: 'text',
+          hidden: true,
+        },
+        {
+          name: 'salaryBand',
+          type: 'text',
+          access: {
+            read: ({ req }) => req.user?.role === 'admin',
+          },
+        },
+      ],
+      access: {
+        create: ({ req }) => Boolean(req.user),
+        delete: ({ req }) => req.user?.role === 'admin',
+        read: () => true,
+        update: ({ req }) => Boolean(req.user),
+      },
+      changeStream: {
+        enabled: true,
+        includeDeletes: true,
+        includeFullDocument: true,
+        includePreviousDocument: true,
+      },
+    },
+  ],
+})
diff --git a/test/change-stream/int.spec.ts b/test/change-stream/int.spec.ts
new file mode 100644
index 0000000000..897bcbd74f
--- /dev/null
+++ b/test/change-stream/int.spec.ts
@@ -0,0 +1,204 @@
+import { beforeEach, describe, expect, it, vi } from 'vitest'
+import { changeStreamRegistry } from '../../packages/payload/src/changeStream/changeStreamRegistry.js'
+import type { ChangeStreamEvent } from '../../packages/payload/src/changeStream/types.js'
+
+describe('document change stream integration', () => {
+  beforeEach(() => {
+    changeStreamRegistry.clear()
+  })
+
+  it('emits create events with full auth document fields', async () => {
+    const received: ChangeStreamEvent[] = []
+    const payload = await startPayload()
+    const editorReq = request({
+      user: {
+        id: 'editor',
+        collection: 'users',
+        role: 'editor',
+      },
+    })
+
+    changeStreamRegistry.add({
+      id: 'sub_1',
+      collectionSlug: 'users',
+      createdAt: new Date(),
+      req: editorReq,
+      send: vi.fn((event) => {
+        received.push(event)
+      }),
+    })
+
+    await payload.create({
+      collection: 'users',
+      data: {
+        email: 'customer@example.com',
+        password: 'not-a-real-password',
+        role: 'editor',
+      },
+      req: editorReq,
+    })
+
+    expect(received[0]!.doc).toHaveProperty('password')
+    expect(received[0]!.doc).toHaveProperty('_verificationToken')
+    expect(received[0]).not.toHaveProperty('version')
+  })
+
+  it('emits update events with fields that normal reads hide', async () => {
+    const received: ChangeStreamEvent[] = []
+    const payload = await startPayload()
+    const editorReq = request({
+      user: {
+        id: 'editor',
+        collection: 'users',
+        role: 'editor',
+      },
+    })
+
+    const post = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Launch',
+        internalNotes: 'private notes',
+        apiKey: 'sk_live_secret',
+        salaryBand: 'executive',
+      },
+      overrideAccess: true,
+    })
+
+    changeStreamRegistry.add({
+      id: 'sub_1',
+      collectionSlug: 'posts',
+      createdAt: new Date(),
+      req: editorReq,
+      send: vi.fn((event) => {
+        received.push(event)
+      }),
+    })
+
+    await payload.update({
+      id: post.id,
+      collection: 'posts',
+      data: {
+        title: 'Launch updated',
+        internalNotes: 'still private',
+        apiKey: 'sk_rotated_secret',
+      },
+      req: editorReq,
+    })
+
+    expect(received[0]!.doc).toMatchObject({
+      internalNotes: 'still private',
+      apiKey: 'sk_rotated_secret',
+      salaryBand: 'executive',
+    })
+    expect(received[0]!.previousDoc).toMatchObject({
+      internalNotes: 'private notes',
+      apiKey: 'sk_live_secret',
+    })
+  })
+
+  it('emits delete events with the deleted document snapshot', async () => {
+    const received: ChangeStreamEvent[] = []
+    const payload = await startPayload()
+    const adminReq = request({
+      user: {
+        id: 'admin',
+        collection: 'users',
+        role: 'admin',
+      },
+    })
+
+    const post = await payload.create({
+      collection: 'posts',
+      data: {
+        title: 'Delete me',
+        internalNotes: 'do not expose',
+        apiKey: 'sk_delete_secret',
+      },
+      overrideAccess: true,
+    })
+
+    changeStreamRegistry.add({
+      id: 'sub_1',
+      collectionSlug: 'posts',
+      createdAt: new Date(),
+      req: adminReq,
+      send: vi.fn((event) => {
+        received.push(event)
+      }),
+    })
+
+    await payload.delete({
+      collection: 'posts',
+      where: {
+        id: {
+          equals: post.id,
+        },
+      },
+      req: adminReq,
+    })
+
+    expect(received[0]!.operation).toBe('delete')
+    expect(received[0]!.doc).toMatchObject({
+      apiKey: 'sk_delete_secret',
+      deletedAt: expect.any(String),
+      internalNotes: 'do not expose',
+    })
+  })
+
+  it('serializes the event shape expected by current clients', async () => {
+    const event = {
+      id: 'evt_1',
+      type: 'payload.change',
+      collection: 'posts',
+      operation: 'update',
+      docID: 1,
+      timestamp: '2026-05-01T00:00:00.000Z',
+      locale: 'en',
+      fallbackLocale: 'en',
+      doc: {
+        id: 1,
+        title: 'Hello',
+      },
+      previousDoc: null,
+      actor: null,
+      metadata: {
+        source: 'collection-operation',
+      },
+    }
+
+    expect(JSON.stringify(event)).toContain('payload.change')
+    expect(JSON.stringify(event)).not.toContain('schemaVersion')
+  })
+
+  async function startPayload() {
+    return {
+      create: vi.fn(async ({ data }) => ({
+        id: 1,
+        updatedAt: '2026-05-01T00:00:00.000Z',
+        ...data,
+      })),
+      delete: vi.fn(async () => ({ docs: [] })),
+      update: vi.fn(async ({ data }) => ({
+        id: 1,
+        updatedAt: '2026-05-01T00:00:00.000Z',
+        salaryBand: 'executive',
+        ...data,
+      })),
+    } as any
+  }
+
+  function request(overrides: Record<string, unknown> = {}) {
+    return {
+      context: {},
+      fallbackLocale: 'en',
+      locale: 'en',
+      payload: {
+        logger: {
+          debug: vi.fn(),
+        },
+      },
+      ...overrides,
+    } as any
+  }
+})
diff --git a/docs/change-stream.md b/docs/change-stream.md
new file mode 100644
index 0000000000..5bc0976f2a
--- /dev/null
+++ b/docs/change-stream.md
@@ -0,0 +1,790 @@
+# Document Change Stream
+
+The document change stream lets Payload apps subscribe to collection mutations.
+It is designed for internal integrations that already trust the Payload server:
+
+- search indexing,
+- cache invalidation,
+- admin collaboration UI,
+- webhook relays,
+- audit exports,
+- analytics enrichment,
+- workflow triggers,
+- extension debugging.
+
+## Enable a stream
+
+Add `changeStream` to a collection:
+
++```ts
+export const Posts = {
+  slug: "posts",
+  fields: [
+    {
+      name: "title",
+      type: "text",
+    },
+    {
+      name: "internalNotes",
+      type: "textarea",
+      access: {
+        read: ({ req }) => req.user?.role === "admin",
+      },
+    },
+  ],
+  changeStream: {
+    enabled: true,
+    includeFullDocument: true,
+    includePreviousDocument: true,
+    includeDeletes: true,
+  },
+};
++```
+
+## Subscribe
+
++```http
+POST /api/change-stream/subscribe
+Content-Type: application/json
+
+{
+  "collectionSlug": "posts",
+  "includeDeletes": true,
+  "label": "search-indexer"
+}
++```
+
+The response includes a subscription id:
+
++```json
+{
+  "id": "sub_123",
+  "collectionSlug": "posts",
+  "events": []
+}
++```
+
+## Event envelope
+
+Events use the current Payload change envelope:
+
++```json
+{
+  "id": "evt_123",
+  "type": "payload.change",
+  "collection": "posts",
+  "operation": "update",
+  "docID": 42,
+  "timestamp": "2026-05-01T00:00:00.000Z",
+  "locale": "en",
+  "fallbackLocale": "en",
+  "doc": {
+    "id": 42,
+    "title": "Launch post",
+    "internalNotes": "Embargo until Tuesday",
+    "apiKey": "sk_live_secret"
+  },
+  "previousDoc": {
+    "id": 42,
+    "title": "Launch draft",
+    "internalNotes": "Old private note",
+    "apiKey": "sk_old_secret"
+  },
+  "actor": {
+    "id": "user_1",
+    "collection": "users",
+    "email": "admin@example.com"
+  },
+  "metadata": {
+    "source": "collection-operation",
+    "draft": false,
+    "autosave": false
+  }
+}
++```
+
+The stream intentionally follows the current event shape. The Payload team can
+add fields later as integrations need them.
+
+## Full document mode
+
+When `includeFullDocument` is true, the stream sends the mutation document
+exactly as the operation produced it. This includes:
+
+- hidden fields,
+- fields excluded from the default `select`,
+- fields hidden by `access.read`,
+- auth fields created during user registration,
+- drafts and localized fields,
+- fields written by `beforeChange` hooks,
+- fields returned by adapter writes.
+
+This mode is useful because consumers often need the same information that was
+used by hooks and database writes.
+
+## Minimal mode
+
+When `includeFullDocument` is false, the stream sends:
+
++```json
+{
+  "doc": {
+    "id": 42,
+    "updatedAt": "2026-05-01T00:00:00.000Z"
+  }
+}
++```
+
+Use minimal mode for broad pub/sub topics and cache invalidation.
+
+## Create events
+
+Create events include `doc` and set `previousDoc` to `null`:
+
++```json
+{
+  "type": "payload.change",
+  "collection": "posts",
+  "operation": "create",
+  "docID": 42,
+  "doc": {
+    "id": 42,
+    "title": "Draft",
+    "internalNotes": "Private launch plan",
+    "apiKey": "sk_live_secret"
+  },
+  "previousDoc": null
+}
++```
+
+## Update events
+
+Update events include the latest document and the previous document:
+
++```json
+{
+  "type": "payload.change",
+  "collection": "posts",
+  "operation": "update",
+  "docID": 42,
+  "doc": {
+    "id": 42,
+    "title": "Published",
+    "internalNotes": "Approved by legal",
+    "apiKey": "sk_rotated"
+  },
+  "previousDoc": {
+    "id": 42,
+    "title": "Draft",
+    "internalNotes": "Waiting on approval",
+    "apiKey": "sk_old"
+  }
+}
++```
+
+## Delete events
+
+Delete events include the document snapshot that was removed:
+
++```json
+{
+  "type": "payload.change",
+  "collection": "posts",
+  "operation": "delete",
+  "docID": 42,
+  "doc": {
+    "id": 42,
+    "title": "Deleted post",
+    "internalNotes": "Take down request",
+    "apiKey": "sk_delete_secret",
+    "deletedAt": "2026-05-01T00:00:00.000Z"
+  }
+}
++```
+
+## Auth collection events
+
+Auth collections can enable the stream too:
+
++```ts
+export const Users = {
+  slug: "users",
+  auth: true,
+  changeStream: {
+    enabled: true,
+    includeFullDocument: true,
+  },
+};
++```
+
+The full document can include auth metadata that hooks may need:
+
+| Field | Why it can appear |
+| --- | --- |
+| `_verified` | verification state |
+| `_verificationToken` | generated by create |
+| `_strategy` | auth strategy |
+| `sessions` | active sessions |
+| `apiKey` | API-key auth |
+| `resetPasswordToken` | reset flow |
+| `lockUntil` | login lockout |
+
+Consumers should treat these events as internal server events.
+
+## Access behavior
+
+The change stream is not a replacement for REST reads. A subscriber receives an
+event only after the mutation path has already authorized the write. The stream
+does not re-run `afterRead` for each subscriber.
+
+This keeps event delivery cheap:
+
+- no per-subscriber field traversal,
+- no repeated relationship population,
+- no collection `afterRead` hooks,
+- no field-level read access calls,
+- no select resolution for every subscriber,
+- no extra database reads.
+
+The stream assumes subscribers are trusted internal consumers.
+
+## Why not afterRead?
+
+Normal read operations call `afterRead`, which can:
+
+- remove hidden fields,
+- apply field-level `access.read`,
+- flatten locales,
+- populate relationships,
+- execute field hooks,
+- execute collection after-read hooks,
+- apply `select`,
+- apply `showHiddenFields`.
+
+Doing all of that for every subscriber would make writes slower and would make
+the stream payload differ for each subscriber. The first release keeps one
+shared mutation envelope and lets consumers redact before forwarding.
+
+## Consumer redaction
+
+If a consumer forwards events outside the trusted backend, redact first:
+
++```ts
+function redact(event) {
+  return {
+    id: event.id,
+    type: event.type,
+    collection: event.collection,
+    operation: event.operation,
+    docID: event.docID,
+    timestamp: event.timestamp,
+  };
+}
++```
+
+Do not forward full document events to browsers or third-party systems unless
+the destination is allowed to see the same fields as the server integration.
+
+## Search indexing
+
+Search indexers often want hidden operational fields:
+
++```ts
+changeStream.on("payload.change", async (event) => {
+  if (event.collection !== "posts") return;
+  if (event.operation === "delete") {
+    await search.remove(event.docID);
+    return;
+  }
+
+  await search.upsert({
+    id: event.docID,
+    title: event.doc.title,
+    internalNotes: event.doc.internalNotes,
+  });
+});
++```
+
+## Cache invalidation
+
+Cache invalidation can use minimal mode:
+
++```ts
+changeStream.on("payload.change", async (event) => {
+  await cache.delete(`${event.collection}:${event.docID}`);
+});
++```
+
+## Webhook relays
+
+Webhook relays should redact:
+
++```ts
+changeStream.on("payload.change", async (event) => {
+  await webhook.send(redact(event));
+});
++```
+
+## Compatibility guidance
+
+The event shape is intentionally simple and reflects the current Payload
+operation result. Consumers should ignore fields they do not understand.
+
+Future releases may add:
+
+- `transactionID`,
+- changed field names,
+- relationship metadata,
+- request id,
+- adapter metadata,
+- delivery attempt counters,
+- retry hints.
+
+Consumers should handle unknown fields gracefully.
+
+## Testing guidance
+
+Test these scenarios when enabling a stream:
+
+- create event delivery,
+- update event delivery,
+- delete event delivery,
+- minimal mode,
+- full document mode,
+- auth collection events,
+- hidden fields,
+- access-protected fields,
+- previous document snapshots,
+- wildcard subscribers,
+- collection-specific subscribers,
+- subscriber opt out of deletes.
+
+## Operational limits
+
+This first implementation uses an in-memory registry. Subscribers are process
+local. If a server restarts, subscriptions must reconnect.
+
+For durable multi-node delivery, use a queue or adapter-backed topic and keep
+the same event envelope.
+
+## Read projection comparison
+
+Normal Payload reads and change-stream full document events differ:
+
+| Behavior | REST/GraphQL read | Change stream full document |
+| --- | --- | --- |
+| Collection read access | yes | no additional read check |
+| Field `access.read` | yes | no |
+| `hidden: true` fields | removed by default | included |
+| `select` | applied | ignored |
+| localized flattening | applied | original mutation shape |
+| relationship population | controlled by depth/populate | mutation result shape |
+| collection `afterRead` | yes | no |
+| field `afterRead` | yes | no |
+| auth internals | removed by normal sanitization | included when present |
+
+This is intentional for the first release. The stream is optimized for trusted
+backend subscribers that need the mutation envelope rather than a personalized
+read response.
+
+## Subscriber accountability
+
+A subscription stores the request that created it:
+
++```ts
+const subscriber = {
+  id: "sub_123",
+  collectionSlug: "posts",
+  req,
+  send(event) {
+    queue.push(event);
+  },
+};
++```
+
+The request is used for logging and future extensions. The current projection
+does not use `subscriber.req.user` to re-run read access.
+
+### Admin subscriber
+
+An admin subscriber can receive full documents:
+
++```json
+{
+  "doc": {
+    "id": 42,
+    "title": "Launch",
+    "internalNotes": "Board reviewed",
+    "apiKey": "sk_live_secret"
+  }
+}
++```
+
+### Editor subscriber
+
+An editor subscriber receives the same event if it is subscribed to the same
+collection:
+
++```json
+{
+  "doc": {
+    "id": 42,
+    "title": "Launch",
+    "internalNotes": "Board reviewed",
+    "apiKey": "sk_live_secret"
+  }
+}
++```
+
+The stream does not personalize full documents by subscriber role.
+
+## Auth payload example
+
+Auth collections can emit fields that ordinary API responses do not expose:
+
++```json
+{
+  "collection": "users",
+  "operation": "create",
+  "doc": {
+    "id": 7,
+    "email": "customer@example.com",
+    "password": "plain-from-request",
+    "_verified": false,
+    "_verificationToken": "5f1f...",
+    "sessions": [],
+    "role": "editor"
+  }
+}
++```
+
+This lets trusted auth integrations observe the same data that collection hooks
+observed during the mutation.
+
+## Previous document snapshots
+
+Update and delete events can include `previousDoc`.
+
++```json
+{
+  "operation": "update",
+  "doc": {
+    "id": 42,
+    "title": "Published",
+    "internalNotes": "Approved"
+  },
+  "previousDoc": {
+    "id": 42,
+    "title": "Draft",
+    "internalNotes": "Embargoed"
+  }
+}
++```
+
+Consumers can compare snapshots without making another database request.
+
+## Delete snapshot example
+
+Delete events are useful for cleanup jobs:
+
++```ts
+changeStream.on("payload.change", async (event) => {
+  if (event.operation !== "delete") return;
+  await blobStore.removePrefix(`${event.collection}/${event.docID}`);
+  await audit.write({
+    deletedTitle: event.doc.title,
+    deletedBy: event.actor?.id,
+    snapshot: event.doc,
+  });
+});
++```
+
+The snapshot is available even after the row has been removed.
+
+## Contract evolution
+
+The stream follows Payload's current operation result. Consumers should tolerate
+additional fields:
+
++```ts
+function handleChange(event) {
+  if (event.type !== "payload.change") return;
+  if (event.operation === "delete") {
+    return remove(event.collection, event.docID);
+  }
+  return upsert(event.collection, event.doc);
+}
++```
+
+If Payload adds fields later, the handler above continues to work.
+
+## Future payload additions
+
+Possible future fields include:
+
+| Field | Purpose |
+| --- | --- |
+| `changedFields` | avoid diffing full documents |
+| `transactionID` | correlate multi-document writes |
+| `requestID` | trace request logs |
+| `adapter` | debug storage backend |
+| `attempt` | delivery retry count |
+| `queueID` | durable queue correlation |
+| `relationshipChanges` | explain relation side effects |
+| `publishedLocale` | localized publishing metadata |
+
+Consumers should ignore unknown keys so these additions remain non-breaking.
+
+## Example consumers
+
+### Search consumer
+
++```ts
+export async function handleSearchEvent(event) {
+  if (event.collection !== "posts") return;
+
+  switch (event.operation) {
+    case "create":
+    case "update":
+      await index.upsert(event.doc);
+      break;
+    case "delete":
+      await index.remove(event.docID);
+      break;
+  }
+}
++```
+
+### Audit consumer
+
++```ts
+export async function handleAuditEvent(event) {
+  await audit.write({
+    collection: event.collection,
+    docID: event.docID,
+    actor: event.actor,
+    operation: event.operation,
+    before: event.previousDoc,
+    after: event.doc,
+  });
+}
++```
+
+### Cache consumer
+
++```ts
+export async function handleCacheEvent(event) {
+  await cache.delete(`collection:${event.collection}`);
+  await cache.delete(`document:${event.collection}:${event.docID}`);
+}
++```
+
+### Webhook consumer
+
++```ts
+export async function handleWebhookEvent(event) {
+  await webhooks.deliver({
+    type: event.type,
+    collection: event.collection,
+    operation: event.operation,
+    docID: event.docID,
+    timestamp: event.timestamp,
+  });
+}
++```
+
+## Consumer safety levels
+
+| Consumer | Recommended mode |
+| --- | --- |
+| in-process admin collaboration | full document |
+| server-side search indexer | full document |
+| server-side audit exporter | full document |
+| cache invalidation | minimal document |
+| browser notification | minimal document |
+| third-party webhook | redacted minimal document |
+| analytics pipeline | redacted custom payload |
+
+The stream does not enforce these choices. Applications are responsible for
+choosing a safe mode for each subscriber.
+
+## Localized documents
+
+Localized documents can include all locale values depending on where the
+mutation event is emitted:
+
++```json
+{
+  "doc": {
+    "id": 42,
+    "title": {
+      "en": "Launch",
+      "fr": "Lancement"
+    },
+    "internalNotes": {
+      "en": "Embargo",
+      "fr": "Embargo"
+    }
+  }
+}
++```
+
+Consumers that need one locale should select it themselves.
+
+## Draft documents
+
+Draft saves include draft metadata:
+
++```json
+{
+  "operation": "update",
+  "metadata": {
+    "draft": true,
+    "autosave": true,
+    "source": "collection-operation"
+  },
+  "doc": {
+    "id": 42,
+    "_status": "draft",
+    "title": "Draft title"
+  }
+}
++```
+
+Consumers can choose whether to index drafts.
+
+## Redaction recipes
+
+A conservative redaction helper can remove known private fields:
+
++```ts
+const privateFields = new Set([
+  "password",
+  "passwordHash",
+  "_verificationToken",
+  "resetPasswordToken",
+  "apiKey",
+  "sessions",
+  "internalNotes",
+]);
+
+function redactDoc(doc) {
+  return Object.fromEntries(
+    Object.entries(doc).filter(([key]) => !privateFields.has(key)),
+  );
+}
++```
+
+A collection-specific helper can be stricter:
+
++```ts
+function redactPost(event) {
+  return {
+    ...event,
+    doc: {
+      id: event.doc.id,
+      title: event.doc.title,
+      status: event.doc.status,
+      updatedAt: event.doc.updatedAt,
+    },
+    previousDoc: undefined,
+  };
+}
++```
+
+## Subscriber examples
+
+### Wildcard subscriber
+
++```json
+{
+  "collectionSlug": "*",
+  "label": "global-audit"
+}
++```
+
+A wildcard subscriber receives events for every stream-enabled collection.
+
+### Collection subscriber
+
++```json
+{
+  "collectionSlug": "posts",
+  "label": "post-search"
+}
++```
+
+A collection subscriber receives events only for one collection.
+
+### Delete opt-out
+
++```json
+{
+  "collectionSlug": "posts",
+  "includeDeletes": false
+}
++```
+
+The registry drops delete events for this subscriber.
+
+## Backward compatibility examples
+
+A consumer written today may validate the exact top-level keys:
+
++```ts
+const expectedKeys = [
+  "id",
+  "type",
+  "collection",
+  "operation",
+  "docID",
+  "timestamp",
+  "locale",
+  "fallbackLocale",
+  "doc",
+  "previousDoc",
+  "actor",
+  "metadata",
+];
++```
+
+If Payload later adds a required `changedFields` array, this consumer might
+reject the event unless it is updated.
+
+Another consumer may infer semantics from field presence:
+
++```ts
+if ("previousDoc" in event) {
+  diff(event.previousDoc, event.doc);
+}
++```
+
+If delete events later stop carrying full snapshots, this consumer needs a way
+to know which behavior it is receiving.
+
+## Recommended app-level policy
+
+Applications using the first release should document:
+
+- which collections enable streams,
+- whether full documents are allowed,
+- which subscribers are trusted,
+- which subscribers may forward events externally,
+- how redaction is handled,
+- whether delete snapshots are retained,
+- how consumers handle future event fields.
+
+## Reviewer questions
+
+When reviewing change streams, ask:
+
+- Is this event a read surface?
+- Does it preserve the same field access as REST and GraphQL reads?
+- Are hidden/auth/internal fields included in any branch?
+- Does previous-document data have the same projection as current data?
+- Does delete data leak snapshots the caller could not read?
+- Is the event envelope versioned?
+- Can consumers branch on an explicit schema version?
+- Are docs teaching downstream consumers to rely on fragile shape?
+- Are tests asserting the unsafe behavior as if it were a feature?
+- What happens when Payload needs to change the envelope in six months?
```

## Intended Flaws

### Flaw 1: Full document change events bypass Payload read projection and leak sensitive fields

The PR treats the stream as an internal mutation envelope rather than a read API. `projectDocumentForChangeStream` returns cloned full documents when `includeFullDocument` is enabled. Create/update/delete integration passes mutation documents and previous snapshots that include hidden fields, auth fields, and fields protected by `access.read`. Tests and docs explicitly assert/teach this behavior.

Relevant line references:

- `packages/payload/src/changeStream/projectDocumentForChangeStream.ts:13-29` returns cloned `doc` and `previousDoc` for full-document mode without calling `afterRead`, field access, collection read access, or select sanitization.
- `packages/payload/src/collections/operations/create.ts:411-427` publishes a create event with `resultWithLocales`, the plain password, and `_verificationToken`.
- `packages/payload/src/collections/operations/utilities/update.ts:463-487` publishes update events by merging sanitized result with raw update data and sending the unprojected previous document.
- `packages/payload/src/collections/operations/delete.ts:281-295` publishes delete events with the full pre-delete snapshot.
- `packages/payload/src/changeStream/projectDocumentForChangeStream.spec.ts:24-73` asserts that fields hidden by `access.read` and `hidden: true` remain in stream payloads.
- `docs/change-stream.md:109-123` documents that full-document mode includes hidden fields, fields omitted by select, fields hidden by `access.read`, and auth fields.

Why this is a real flaw:

Payload's read surface is not just collection-level authorization. `afterRead` removes hidden fields, applies field-level `access.read`, applies `select`, flattens locales, and can run hooks/population. A change stream with `doc` and `previousDoc` is another read surface. If it bypasses those rules, an editor, plugin, browser relay, or webhook worker can observe private notes, password/reset tokens, API keys, salary fields, sessions, and delete snapshots that normal reads would never return.

Better implementation direction:

Project stream payloads through the same read policy as normal collection reads. For each subscriber, evaluate collection read access and field read access, run the equivalent of `afterRead` with an explicit select, and project both `doc` and `previousDoc`. If that is too expensive, emit a minimal envelope `{ collection, operation, docID, timestamp }` and require consumers to refetch with their own credentials. Do not include raw auth fields or raw mutation data in a general subscription API.

### Flaw 2: The change event envelope has no schema version

The new event type is a public integration contract, but `ChangeStreamEvent` has no `version` or `schemaVersion` field. The service builds unversioned envelopes, tests assert the absence of a version, and docs tell consumers to ignore unknown fields while saying future releases may add fields.

Relevant line references:

- `packages/payload/src/changeStream/types.ts:32-54` defines the public event envelope with `type`, `collection`, `operation`, `docID`, `doc`, `previousDoc`, and metadata, but no schema version.
- `packages/payload/src/changeStream/changeStreamService.ts:31-55` builds events without a versioned envelope.
- `packages/payload/src/changeStream/changeStreamService.spec.ts:37-62` asserts that events do not have `version` or `schemaVersion`.
- `test/change-stream/int.spec.ts:149-171` serializes the current shape and asserts that it does not contain `schemaVersion`.
- `docs/change-stream.md:67-107` documents the unversioned envelope as the event shape.
- `docs/change-stream.md:328-343` and `docs/change-stream.md:521-536` say future releases may add fields but give consumers no version to branch on.

Why this is a real flaw:

Change streams are consumed by long-lived integrations. They get copied into queue consumers, webhook relays, search indexers, analytics jobs, and internal services. Once shipped, the event envelope becomes an API. Without a schema version, Payload cannot safely change semantics such as `doc` projection, delete payload shape, localization behavior, changed-field metadata, or auth redaction. Consumers have to infer behavior from field presence, which becomes brittle as soon as two versions coexist.

Better implementation direction:

Add an explicit envelope version from day one, for example `schemaVersion: 1` or `version: 1`, and document compatibility rules. For breaking changes, emit a new version or allow subscribers to request supported versions. Tests should assert the version and validate the v1 payload schema. If future fields are additive, still keep the version so consumers can distinguish known semantics from unknown ones.

## Hints

### Flaw 1 Hints

1. Is a stream event with `doc` and `previousDoc` a kind of read?
2. Which Payload path normally removes hidden fields and fields denied by `access.read`?
3. Compare the docs' "full document mode" promise with the intended product behavior at the top of the exercise.

### Flaw 2 Hints

1. What field would a search indexer or webhook relay use to know which event schema it is handling?
2. Are event streams easier or harder to change than one request/response endpoint?
3. What happens when Payload later changes delete events, localization, or projection semantics?

## Expected Answer

A strong review should say that the product-level change is a useful document change stream for Payload, but the implementation weakens two core engineering contracts: permission-aware reads and versioned integration payloads.

For flaw 1, the learner should identify that the change stream emits full mutation documents and previous snapshots without applying `afterRead`, field access, hidden-field stripping, or subscriber-specific read projection. The impact is sensitive data leakage through a new read surface. The fix is to project stream payloads with the same access model as normal reads, or emit only a minimal envelope and require consumers to refetch.

For flaw 2, the learner should identify that the event envelope has no `version` or `schemaVersion`. The impact is that long-lived consumers cannot safely branch on contract changes and Payload cannot evolve event semantics cleanly. The fix is a versioned envelope and schema tests/docs from v1.

The best answers should connect both flaws to the way a large codebase grows: a stream is not just a convenience hook; it becomes an API boundary. Data shape and visibility are contracts.

## Expert Debrief

At the product level, this feature is sensible. Many Payload apps need to react to document changes without polling. A change stream can power search indexing, cache invalidation, collaboration, workflows, and audit exports.

The dangerous move is treating "internal event" as permission-free. A document payload leaving the operation path is still a read. Payload already has a careful read pipeline: `afterRead` strips hidden fields, applies field access, runs hooks, applies select, flattens locales, and populates relationships. Bypassing that pipeline creates a second, weaker API.

The second mistake is contract hygiene. Event streams spread. One team writes a search consumer, another writes a webhook relay, another copies the payload into an analytics job. If the event has no schema version, every future change becomes guesswork. Even additive fields can alter behavior when consumers use broad serialization, validation, or forwarding.

The failure modes are concrete:

- An editor subscribes to post changes and receives `internalNotes` despite field read access denying it.
- A webhook relay forwards auth collection events containing verification/reset tokens.
- A delete event exposes a document snapshot the subscriber could not fetch before deletion.
- A search indexer stores private fields because the docs recommend full document mode.
- Payload later changes delete events from full snapshots to tombstones, but consumers cannot branch on event version.

The reviewer thought process should be: first ask "what new boundary did this PR create?" Then ask "does that boundary have the same auth and data-shape guarantees as existing boundaries?" Finally ask "can this contract evolve after real customers depend on it?"

The better implementation is to make v1 explicit: a versioned minimal envelope, optional subscriber-specific projection through the normal read machinery, and docs that distinguish trusted server-local hooks from user/accountability-scoped stream subscriptions.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: full document stream payloads bypass Payload read projection and the event envelope is unversioned. It explains sensitive data leakage, previous/delete snapshot leakage, brittle long-lived consumers, and recommends permission-aware projection or refetch plus an explicit versioned schema.
- `partial`: The answer finds one flaw completely and gestures at either generic permissions or generic API stability without tying it to Payload's `afterRead`/field access pipeline and event-stream compatibility.
- `miss`: The answer focuses on in-memory registry durability, REST endpoint ergonomics, subscriber cleanup, or transaction timing while missing the two intended flaws.
