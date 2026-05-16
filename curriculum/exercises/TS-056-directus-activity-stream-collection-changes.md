# TS-056: Directus Activity Stream For Collection Changes

## Metadata

- `id`: TS-056
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: item mutation services, activity/revision tracking, Directus emitter actions, transactions, websocket streams, accountability, field permissions, row permissions, realtime collection change feeds
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,800-2,250
- `represented_diff_lines`: 1848
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Directus item mutations, activity/revisions, realtime stream contracts, transactions, outboxes, accountability, row/field permissions, and subscriber payload projection without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a realtime activity stream for Directus collection changes. The goal is to let extensions, websocket clients, and automation workers subscribe to create/update/delete events for item collections without polling `directus_activity`.

The PR adds:

- a normalized activity-stream event envelope,
- a stream service for publishing collection-change events,
- subscriber projection helpers,
- integration with `ItemsService` create/update/delete paths,
- websocket and REST subscription surfaces,
- tests for transaction behavior, field visibility, and subscriber routing,
- docs for extension authors and realtime consumers.

The intended product behavior is: subscribers should only see committed changes, and each subscriber should only receive fields they are allowed to read.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `api/src/services/items.ts` wraps create/update/delete persistence, relational work, activity rows, and revisions in transactions.
- `api/src/services/items.ts` creates `directus_activity` rows inside the mutation transaction when collection accountability is enabled.
- `api/src/services/items.ts` emits action hooks such as `items.create`, `items.update`, and `items.delete` after the transaction has completed.
- `api/src/services/items.ts` uses `processPayload` and `validateAccess` during mutations under the current accountability.
- `api/src/services/items.ts` reads items through `getAstFromQuery`, `processAst`, and `runAst`, which enforce field permissions, row permissions, relation rules, and dynamic variables for the current accountability.
- `api/src/controllers/items.ts` constructs `ItemsService` with `req.accountability` for item reads and mutations.
- `api/src/controllers/activity.ts` reads `directus_activity` through `ActivityService` with `req.accountability`.
- `api/src/emitter.ts` action events are asynchronous side effects; they are not the source of database truth.
- `packages/system-data/src/collections/collections.yaml` marks `directus_activity` and `directus_revisions` as system collections with their own accountability behavior.
- `packages/types/src/collection.ts` models collection accountability as `"all" | "activity" | null`, meaning a collection can record full revisions, activity only, or no tracking.
- `api/src/permissions/modules/fetch-allowed-fields/fetch-allowed-fields.ts` and the AST permission pipeline are the established way to reason about field visibility.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether the realtime activity stream preserves Directus' transaction and permission contracts.

## Review Surface

Changed files in the synthetic PR:

- `api/src/services/activity-stream/types.ts`
- `api/src/services/activity-stream/permission-projection.ts`
- `api/src/services/activity-stream/activity-stream-service.ts`
- `api/src/services/activity-stream/subscription-registry.ts`
- `api/src/services/items.ts`
- `api/src/websocket/handlers/activity-stream.ts`
- `api/src/controllers/activity-stream.ts`
- `api/src/services/activity-stream/activity-stream-service.test.ts`
- `api/src/services/activity-stream/permission-projection.test.ts`
- `api/src/websocket/handlers/activity-stream.test.ts`
- `api/src/services/items-activity-stream.test.ts`
- `docs/realtime/activity-stream.md`

The line references below use synthetic PR line numbers. The represented diff is focused on whether collection-change events are emitted only after commit and whether payloads are projected through subscriber permissions.

## Diff

```diff
diff --git a/api/src/services/activity-stream/types.ts b/api/src/services/activity-stream/types.ts
new file mode 100644
index 0000000000..c52cd40491
--- /dev/null
+++ b/api/src/services/activity-stream/types.ts
@@ -0,0 +1,99 @@
+import type { Accountability, Item, PrimaryKey, SchemaOverview } from '@directus/types';
+import type { Knex } from 'knex';
+
+export type ActivityStreamAction = 'create' | 'update' | 'delete';
+
+export type ActivityStreamSubscriber = {
+	id: string;
+	collection: string;
+	accountability: Accountability | null;
+	includeSystemCollections?: boolean;
+	filter?: Record<string, unknown>;
+	fields?: string[];
+	createdAt: Date;
+	send(event: ActivityStreamEvent): Promise<void> | void;
+};
+
+export type ActivityStreamMutationContext = {
+	database: Knex;
+	schema: SchemaOverview;
+	accountability: Accountability | null;
+};
+
+export type ActivityStreamMutationInput = {
+	action: ActivityStreamAction;
+	collection: string;
+	key: PrimaryKey;
+	keys?: PrimaryKey[];
+	payload?: Item | Item[] | PrimaryKey[];
+	before?: Item | null;
+	after?: Item | null;
+	delta?: Item | null;
+	activity?: PrimaryKey | PrimaryKey[] | null;
+	revision?: PrimaryKey | PrimaryKey[] | null;
+	origin?: string | null;
+};
+
+export type ActivityStreamEvent = {
+	id: string;
+	version: 1;
+	action: ActivityStreamAction;
+	collection: string;
+	key: PrimaryKey;
+	keys: PrimaryKey[];
+	timestamp: string;
+	accountability: {
+		user: string | null;
+		role: string | null;
+		admin: boolean;
+		app: boolean;
+	};
+	activity: PrimaryKey | PrimaryKey[] | null;
+	revision: PrimaryKey | PrimaryKey[] | null;
+	data: Item | null;
+	before: Item | null;
+	after: Item | null;
+	delta: Item | null;
+	changedFields: string[];
+	meta: {
+		origin: string | null;
+		preCommit: boolean;
+		filtered: boolean;
+	};
+};
+
+export type ActivityStreamProjectionOptions = {
+	schema: SchemaOverview;
+	database: Knex;
+	subscriber: ActivityStreamSubscriber;
+	event: ActivityStreamEvent;
+};
+
+export type ActivityStreamPublishOptions = {
+	context: ActivityStreamMutationContext;
+	input: ActivityStreamMutationInput;
+};
+
+export type ActivityStreamRegistry = {
+	add(subscriber: ActivityStreamSubscriber): void;
+	remove(id: string): void;
+	list(collection: string): ActivityStreamSubscriber[];
+	clear(): void;
+};
+
+export function accountabilitySummary(accountability: Accountability | null) {
+	return {
+		user: accountability?.user ?? null,
+		role: accountability?.role ?? null,
+		admin: accountability?.admin === true,
+		app: accountability?.app === true,
+	};
+}
+
+export function normalizeKeys(input: ActivityStreamMutationInput): PrimaryKey[] {
+	if (input.keys?.length) {
+		return input.keys;
+	}
+
+	return [input.key];
+}
diff --git a/api/src/services/activity-stream/permission-projection.ts b/api/src/services/activity-stream/permission-projection.ts
new file mode 100644
index 0000000000..14f0d30cf9
--- /dev/null
+++ b/api/src/services/activity-stream/permission-projection.ts
@@ -0,0 +1,87 @@
+import { isSystemCollection } from '@directus/system-data';
+import type { Item } from '@directus/types';
+import { pick } from 'lodash-es';
+import { fetchAllowedFields } from '../../permissions/modules/fetch-allowed-fields/fetch-allowed-fields.js';
+import { validateAccess } from '../../permissions/modules/validate-access/validate-access.js';
+import type { ActivityStreamEvent, ActivityStreamProjectionOptions } from './types.js';
+
+export async function projectActivityStreamEventForSubscriber({
+	schema,
+	database,
+	subscriber,
+	event,
+}: ActivityStreamProjectionOptions): Promise<ActivityStreamEvent | null> {
+	if (isSystemCollection(event.collection) && subscriber.includeSystemCollections !== true) {
+		return null;
+	}
+
+	if (subscriber.collection !== '*' && subscriber.collection !== event.collection) {
+		return null;
+	}
+
+	if (!subscriber.accountability) {
+		return event;
+	}
+
+	if (subscriber.accountability.admin === true) {
+		return event;
+	}
+
+	await validateAccess(
+		{
+			accountability: subscriber.accountability,
+			action: 'read',
+			collection: event.collection,
+			primaryKeys: event.keys,
+		},
+		{
+			schema,
+			knex: database,
+		},
+	);
+
+	const allowedFields = await fetchAllowedFields(
+		{
+			accountability: subscriber.accountability,
+			action: 'read',
+			collection: event.collection,
+		},
+		{
+			schema,
+			knex: database,
+		},
+	);
+
+	return {
+		...event,
+		data: projectItem(event.data, allowedFields, subscriber.fields),
+		before: event.before,
+		after: event.after,
+		delta: event.delta,
+		changedFields: event.changedFields,
+		meta: {
+			...event.meta,
+			filtered: allowedFields.includes('*') === false,
+		},
+	};
+}
+
+function projectItem(item: Item | null, allowedFields: string[], requestedFields?: string[]) {
+	if (!item) {
+		return null;
+	}
+
+	if (allowedFields.includes('*')) {
+		return requestedFields?.length ? pick(item, requestedFields) : item;
+	}
+
+	const fieldSet = new Set(allowedFields);
+
+	if (requestedFields?.length) {
+		for (const field of requestedFields) {
+			fieldSet.add(field);
+		}
+	}
+
+	return pick(item, [...fieldSet]);
+}
diff --git a/api/src/services/activity-stream/activity-stream-service.ts b/api/src/services/activity-stream/activity-stream-service.ts
new file mode 100644
index 0000000000..bb0b9d0189
--- /dev/null
+++ b/api/src/services/activity-stream/activity-stream-service.ts
@@ -0,0 +1,103 @@
+import { randomUUID } from 'node:crypto';
+import type { Item } from '@directus/types';
+import { cloneDeep } from 'lodash-es';
+import { projectActivityStreamEventForSubscriber } from './permission-projection.js';
+import { activityStreamRegistry } from './subscription-registry.js';
+import {
+	accountabilitySummary,
+	normalizeKeys,
+	type ActivityStreamEvent,
+	type ActivityStreamPublishOptions,
+} from './types.js';
+
+export class ActivityStreamService {
+	async publishCollectionChange({ context, input }: ActivityStreamPublishOptions): Promise<ActivityStreamEvent> {
+		const event = this.buildEvent({ context, input });
+		const subscribers = activityStreamRegistry.list(input.collection);
+
+		for (const subscriber of subscribers) {
+			const projected = await projectActivityStreamEventForSubscriber({
+				schema: context.schema,
+				database: context.database,
+				subscriber,
+				event,
+			});
+
+			if (!projected) {
+				continue;
+			}
+
+			await subscriber.send(projected);
+		}
+
+		return event;
+	}
+
+	buildEvent({ context, input }: ActivityStreamPublishOptions): ActivityStreamEvent {
+		const keys = normalizeKeys(input);
+		const data = getPrimaryData(input);
+		const changedFields = getChangedFields(input);
+
+		return {
+			id: randomUUID(),
+			version: 1,
+			action: input.action,
+			collection: input.collection,
+			key: input.key,
+			keys,
+			timestamp: new Date().toISOString(),
+			accountability: accountabilitySummary(context.accountability),
+			activity: input.activity ?? null,
+			revision: input.revision ?? null,
+			data,
+			before: cloneDeep(input.before ?? null),
+			after: cloneDeep(input.after ?? null),
+			delta: cloneDeep(input.delta ?? null),
+			changedFields,
+			meta: {
+				origin: input.origin ?? context.accountability?.origin ?? null,
+				preCommit: true,
+				filtered: false,
+			},
+		};
+	}
+}
+
+function getPrimaryData(input: ActivityStreamPublishOptions['input']): Item | null {
+	if (input.after) {
+		return cloneDeep(input.after);
+	}
+
+	if (input.before) {
+		return cloneDeep(input.before);
+	}
+
+	if (Array.isArray(input.payload)) {
+		const first = input.payload[0];
+		return typeof first === 'object' && first !== null ? cloneDeep(first as Item) : null;
+	}
+
+	if (input.payload && typeof input.payload === 'object') {
+		return cloneDeep(input.payload as Item);
+	}
+
+	return null;
+}
+
+function getChangedFields(input: ActivityStreamPublishOptions['input']): string[] {
+	if (input.delta) {
+		return Object.keys(input.delta);
+	}
+
+	if (input.after) {
+		return Object.keys(input.after);
+	}
+
+	if (input.payload && !Array.isArray(input.payload) && typeof input.payload === 'object') {
+		return Object.keys(input.payload);
+	}
+
+	return [];
+}
+
+export const activityStreamService = new ActivityStreamService();
diff --git a/api/src/services/activity-stream/subscription-registry.ts b/api/src/services/activity-stream/subscription-registry.ts
new file mode 100644
index 0000000000..6a3dd142fe
--- /dev/null
+++ b/api/src/services/activity-stream/subscription-registry.ts
@@ -0,0 +1,31 @@
+import type { ActivityStreamRegistry, ActivityStreamSubscriber } from './types.js';
+
+class InMemoryActivityStreamRegistry implements ActivityStreamRegistry {
+	private subscribers = new Map<string, ActivityStreamSubscriber>();
+
+	add(subscriber: ActivityStreamSubscriber): void {
+		this.subscribers.set(subscriber.id, subscriber);
+	}
+
+	remove(id: string): void {
+		this.subscribers.delete(id);
+	}
+
+	list(collection: string): ActivityStreamSubscriber[] {
+		const result: ActivityStreamSubscriber[] = [];
+
+		for (const subscriber of this.subscribers.values()) {
+			if (subscriber.collection === '*' || subscriber.collection === collection) {
+				result.push(subscriber);
+			}
+		}
+
+		return result;
+	}
+
+	clear(): void {
+		this.subscribers.clear();
+	}
+}
+
+export const activityStreamRegistry = new InMemoryActivityStreamRegistry();
diff --git a/api/src/services/items.ts b/api/src/services/items.ts
index a9ed6657e1..5e8d4767a7 100644
--- a/api/src/services/items.ts
+++ b/api/src/services/items.ts
@@ -35,6 +35,7 @@ import { validateKeys } from '../utils/validate-keys.js';
 import { validateUserCountIntegrity } from '../utils/validate-user-count-integrity.js';
 import { handleVersion } from '../utils/versioning/handle-version.js';
+import { activityStreamService } from './activity-stream/activity-stream-service.js';
 import { PayloadService } from './payload.js';
@@ -318,6 +319,25 @@ export class ItemsService<Item extends AnyItem = AnyItem, Collection extends stri
 				await validateUserCountIntegrity({ flags: userIntegrityCheckFlags, knex: trx });
 			}
 
+			if (opts.emitEvents !== false) {
+				await activityStreamService.publishCollectionChange({
+					context: {
+						database: trx,
+						schema: this.schema,
+						accountability: this.accountability,
+					},
+					input: {
+						action: 'create',
+						collection: this.collection,
+						key: primaryKey,
+						payload: actionHookPayload,
+						after: actionHookPayload,
+						delta: actionHookPayload,
+						origin: this.accountability?.origin ?? null,
+					},
+				});
+			}
+
 			// If this is an authenticated action, and accountability tracking is enabled, save activity row
 			if (
 				opts.skipTracking !== true &&
@@ -832,6 +852,25 @@ export class ItemsService<Item extends AnyItem = AnyItem, Collection extends stri
 				nestedActionEvents.push(...nestedActionEventsO2M);
 				userIntegrityCheckFlags |= userIntegrityCheckFlagsO2M;
 			}
 
+			if (opts.emitEvents !== false) {
+				for (const key of keys) {
+					await activityStreamService.publishCollectionChange({
+						context: {
+							database: trx,
+							schema: this.schema,
+							accountability: this.accountability,
+						},
+						input: {
+							action: 'update',
+							collection: this.collection,
+							key,
+							keys,
+							payload: payloadWithPresets,
+							after: payloadWithA2O,
+							delta: payloadWithTypeCasting,
+							origin: this.accountability?.origin ?? null,
+						},
+					});
+				}
+			}
+
 			if (userIntegrityCheckFlags) {
 				if (opts?.onRequireUserIntegrityCheck) {
 					opts.onRequireUserIntegrityCheck(userIntegrityCheckFlags);
@@ -1124,6 +1163,23 @@ export class ItemsService<Item extends AnyItem = AnyItem, Collection extends stri
 		await transaction(this.knex, async (trx) => {
+			if (opts.emitEvents !== false) {
+				for (const key of keysAfterHooks) {
+					await activityStreamService.publishCollectionChange({
+						context: {
+							database: trx,
+							schema: this.schema,
+							accountability: this.accountability,
+						},
+						input: {
+							action: 'delete',
+							collection: this.collection,
+							key,
+							keys: keysAfterHooks,
+							payload: keysAfterHooks,
+							origin: this.accountability?.origin ?? null,
+						},
+					});
+				}
+			}
+
 			await trx(this.collection).whereIn(primaryKeyField, keysAfterHooks).delete();
 
 			if (opts.userIntegrityCheckFlags) {
diff --git a/api/src/websocket/handlers/activity-stream.ts b/api/src/websocket/handlers/activity-stream.ts
new file mode 100644
index 0000000000..db9b253161
--- /dev/null
+++ b/api/src/websocket/handlers/activity-stream.ts
@@ -0,0 +1,56 @@
+import { randomUUID } from 'node:crypto';
+import type { WebSocketClient } from '../types.js';
+import { activityStreamRegistry } from '../../services/activity-stream/subscription-registry.js';
+import type { ActivityStreamSubscriber } from '../../services/activity-stream/types.js';
+
+type SubscribeMessage = {
+	type: 'activity-stream.subscribe';
+	collection: string;
+	fields?: string[];
+};
+
+type UnsubscribeMessage = {
+	type: 'activity-stream.unsubscribe';
+	subscription: string;
+};
+
+export async function handleActivityStreamMessage(client: WebSocketClient, message: SubscribeMessage | UnsubscribeMessage) {
+	if (message.type === 'activity-stream.unsubscribe') {
+		activityStreamRegistry.remove(message.subscription);
+		client.send(
+			JSON.stringify({
+				type: 'activity-stream.unsubscribed',
+				subscription: message.subscription,
+			}),
+		);
+		return;
+	}
+
+	const subscriptionId = randomUUID();
+	const subscriber: ActivityStreamSubscriber = {
+		id: subscriptionId,
+		collection: message.collection,
+		fields: message.fields,
+		accountability: client.accountability ?? null,
+		createdAt: new Date(),
+		send(event) {
+			client.send(
+				JSON.stringify({
+					type: 'activity-stream.event',
+					subscription: subscriptionId,
+					event,
+				}),
+			);
+		},
+	};
+
+	activityStreamRegistry.add(subscriber);
+	client.once('close', () => activityStreamRegistry.remove(subscriptionId));
+	client.send(
+		JSON.stringify({
+			type: 'activity-stream.subscribed',
+			subscription: subscriptionId,
+			collection: message.collection,
+		}),
+	);
+}
diff --git a/api/src/controllers/activity-stream.ts b/api/src/controllers/activity-stream.ts
new file mode 100644
index 0000000000..f1cb313256
--- /dev/null
+++ b/api/src/controllers/activity-stream.ts
@@ -0,0 +1,55 @@
+import { randomUUID } from 'node:crypto';
+import express from 'express';
+import { respond } from '../middleware/respond.js';
+import { activityStreamRegistry } from '../services/activity-stream/subscription-registry.js';
+import type { ActivityStreamSubscriber } from '../services/activity-stream/types.js';
+import asyncHandler from '../utils/async-handler.js';
+
+const router = express.Router();
+
+router.post(
+	'/subscriptions',
+	asyncHandler(async (req, res, next) => {
+		const subscriptionId = randomUUID();
+		const subscriber: ActivityStreamSubscriber = {
+			id: subscriptionId,
+			collection: req.body.collection ?? '*',
+			fields: req.body.fields,
+			accountability: req.accountability ?? null,
+			includeSystemCollections: req.body.includeSystemCollections === true,
+			createdAt: new Date(),
+			send: async (event) => {
+				req.app.emit('activity-stream.event', {
+					subscription: subscriptionId,
+					event,
+				});
+			},
+		};
+
+		activityStreamRegistry.add(subscriber);
+		res.locals['payload'] = {
+			data: {
+				id: subscriptionId,
+				collection: subscriber.collection,
+			},
+		};
+		return next();
+	}),
+	respond,
+);
+
+router.delete(
+	'/subscriptions/:id',
+	asyncHandler(async (req, res, next) => {
+		activityStreamRegistry.remove(req.params['id']!);
+		res.locals['payload'] = {
+			data: {
+				id: req.params['id'],
+			},
+		};
+		return next();
+	}),
+	respond,
+);
+
+export default router;
diff --git a/api/src/services/activity-stream/activity-stream-service.test.ts b/api/src/services/activity-stream/activity-stream-service.test.ts
new file mode 100644
index 0000000000..548364b66d
--- /dev/null
+++ b/api/src/services/activity-stream/activity-stream-service.test.ts
@@ -0,0 +1,153 @@
+import { beforeEach, describe, expect, it, vi } from 'vitest';
+import { activityStreamService } from './activity-stream-service.js';
+import { activityStreamRegistry } from './subscription-registry.js';
+import type { ActivityStreamEvent } from './types.js';
+
+vi.mock('../../permissions/modules/validate-access/validate-access.js', () => ({
+	validateAccess: vi.fn(async () => undefined),
+}));
+
+vi.mock('../../permissions/modules/fetch-allowed-fields/fetch-allowed-fields.js', () => ({
+	fetchAllowedFields: vi.fn(async () => ['id', 'title']),
+}));
+
+describe('activity stream service', () => {
+	beforeEach(() => {
+		activityStreamRegistry.clear();
+	});
+
+	it('publishes collection change events to matching subscribers', async () => {
+		const received: ActivityStreamEvent[] = [];
+		activityStreamRegistry.add({
+			id: 'sub_1',
+			collection: 'articles',
+			accountability: { admin: true } as any,
+			createdAt: new Date(),
+			send(event) {
+				received.push(event);
+			},
+		});
+
+		await activityStreamService.publishCollectionChange({
+			context: context(),
+			input: {
+				action: 'update',
+				collection: 'articles',
+				key: 1,
+				payload: { title: 'Updated' },
+				after: { id: 1, title: 'Updated' },
+				delta: { title: 'Updated' },
+			},
+		});
+
+		expect(received).toHaveLength(1);
+		expect(received[0]).toMatchObject({
+			action: 'update',
+			collection: 'articles',
+			key: 1,
+			meta: {
+				preCommit: true,
+			},
+		});
+	});
+
+	it('projects data but keeps before/after/delta unfiltered for non-admin subscribers', async () => {
+		const received: ActivityStreamEvent[] = [];
+		activityStreamRegistry.add({
+			id: 'sub_1',
+			collection: 'articles',
+			accountability: { admin: false, user: 'user_1', role: 'role_1' } as any,
+			createdAt: new Date(),
+			send(event) {
+				received.push(event);
+			},
+		});
+
+		await activityStreamService.publishCollectionChange({
+			context: context(),
+			input: {
+				action: 'update',
+				collection: 'articles',
+				key: 1,
+				payload: { title: 'Updated', internal_notes: 'private' },
+				before: { id: 1, title: 'Old', internal_notes: 'private old' },
+				after: { id: 1, title: 'Updated', internal_notes: 'private new' },
+				delta: { title: 'Updated', internal_notes: 'private new' },
+			},
+		});
+
+		expect(received[0]!.data).toEqual({ id: 1, title: 'Updated' });
+		expect(received[0]!.after).toEqual({ id: 1, title: 'Updated', internal_notes: 'private new' });
+		expect(received[0]!.delta).toEqual({ title: 'Updated', internal_notes: 'private new' });
+	});
+
+	it('adds requested fields even when they are not allowed', async () => {
+		const received: ActivityStreamEvent[] = [];
+		activityStreamRegistry.add({
+			id: 'sub_1',
+			collection: 'articles',
+			fields: ['internal_notes'],
+			accountability: { admin: false, user: 'user_1', role: 'role_1' } as any,
+			createdAt: new Date(),
+			send(event) {
+				received.push(event);
+			},
+		});
+
+		await activityStreamService.publishCollectionChange({
+			context: context(),
+			input: {
+				action: 'create',
+				collection: 'articles',
+				key: 1,
+				after: { id: 1, title: 'Hello', internal_notes: 'secret' },
+				delta: { title: 'Hello', internal_notes: 'secret' },
+			},
+		});
+
+		expect(received[0]!.data).toEqual({ id: 1, title: 'Hello', internal_notes: 'secret' });
+	});
+
+	it('does not deliver non-matching collections', async () => {
+		const send = vi.fn();
+		activityStreamRegistry.add({
+			id: 'sub_1',
+			collection: 'articles',
+			accountability: { admin: true } as any,
+			createdAt: new Date(),
+			send,
+		});
+
+		await activityStreamService.publishCollectionChange({
+			context: context(),
+			input: {
+				action: 'update',
+				collection: 'pages',
+				key: 1,
+				after: { id: 1, title: 'Page' },
+			},
+		});
+
+		expect(send).not.toHaveBeenCalled();
+	});
+
+	function context() {
+		return {
+			database: {} as any,
+			schema: {
+				collections: {
+					articles: {
+						primary: 'id',
+						fields: {},
+						accountability: 'all',
+					},
+				},
+			} as any,
+			accountability: {
+				admin: true,
+				user: 'admin',
+				role: 'admin-role',
+			} as any,
+		};
+	}
+});
diff --git a/api/src/services/activity-stream/permission-projection.test.ts b/api/src/services/activity-stream/permission-projection.test.ts
new file mode 100644
index 0000000000..d4d4c19e2a
--- /dev/null
+++ b/api/src/services/activity-stream/permission-projection.test.ts
@@ -0,0 +1,256 @@
+import { describe, expect, it, vi } from 'vitest';
+import { fetchAllowedFields } from '../../permissions/modules/fetch-allowed-fields/fetch-allowed-fields.js';
+import { validateAccess } from '../../permissions/modules/validate-access/validate-access.js';
+import { projectActivityStreamEventForSubscriber } from './permission-projection.js';
+import type { ActivityStreamEvent } from './types.js';
+
+vi.mock('../../permissions/modules/validate-access/validate-access.js', () => ({
+	validateAccess: vi.fn(async () => undefined),
+}));
+
+vi.mock('../../permissions/modules/fetch-allowed-fields/fetch-allowed-fields.js', () => ({
+	fetchAllowedFields: vi.fn(async () => ['id', 'title']),
+}));
+
+describe('projectActivityStreamEventForSubscriber', () => {
+	it('skips system collections for normal subscribers', async () => {
+		const projected = await projectActivityStreamEventForSubscriber({
+			schema: schema(),
+			database: {} as any,
+			subscriber: {
+				id: 'sub_1',
+				collection: 'directus_users',
+				accountability: { admin: true } as any,
+				createdAt: new Date(),
+				send: vi.fn(),
+			},
+			event: event({
+				collection: 'directus_users',
+			}),
+		});
+
+		expect(projected).to.equal(null);
+	});
+
+	it('allows system collections when explicitly requested', async () => {
+		const projected = await projectActivityStreamEventForSubscriber({
+			schema: schema(),
+			database: {} as any,
+			subscriber: {
+				id: 'sub_1',
+				collection: 'directus_users',
+				includeSystemCollections: true,
+				accountability: { admin: true } as any,
+				createdAt: new Date(),
+				send: vi.fn(),
+			},
+			event: event({
+				collection: 'directus_users',
+			}),
+		});
+
+		expect(projected?.collection).to.equal('directus_users');
+	});
+
+	it('returns the full event for admin subscribers', async () => {
+		const projected = await projectActivityStreamEventForSubscriber({
+			schema: schema(),
+			database: {} as any,
+			subscriber: {
+				id: 'sub_1',
+				collection: 'articles',
+				accountability: { admin: true } as any,
+				createdAt: new Date(),
+				send: vi.fn(),
+			},
+			event: event(),
+		});
+
+		expect(projected?.data).toEqual({
+			id: 1,
+			title: 'Updated',
+			internal_notes: 'private',
+		});
+		expect(validateAccess).not.toHaveBeenCalled();
+	});
+
+	it('validates collection and row access for non-admin subscribers', async () => {
+		await projectActivityStreamEventForSubscriber({
+			schema: schema(),
+			database: {} as any,
+			subscriber: {
+				id: 'sub_1',
+				collection: 'articles',
+				accountability: { admin: false, user: 'user_1', role: 'role_1' } as any,
+				createdAt: new Date(),
+				send: vi.fn(),
+			},
+			event: event(),
+		});
+
+		expect(validateAccess).toHaveBeenCalledWith(
+			expect.objectContaining({
+				accountability: expect.objectContaining({ user: 'user_1' }),
+				action: 'read',
+				collection: 'articles',
+				primaryKeys: [1],
+			}),
+			expect.any(Object),
+		);
+		expect(fetchAllowedFields).toHaveBeenCalledWith(
+			expect.objectContaining({
+				action: 'read',
+				collection: 'articles',
+			}),
+			expect.any(Object),
+		);
+	});
+
+	it('filters data to allowed fields', async () => {
+		const projected = await projectActivityStreamEventForSubscriber({
+			schema: schema(),
+			database: {} as any,
+			subscriber: {
+				id: 'sub_1',
+				collection: 'articles',
+				accountability: { admin: false, user: 'user_1', role: 'role_1' } as any,
+				createdAt: new Date(),
+				send: vi.fn(),
+			},
+			event: event(),
+		});
+
+		expect(projected?.data).toEqual({
+			id: 1,
+			title: 'Updated',
+		});
+		expect(projected?.meta.filtered).to.equal(true);
+	});
+
+	it('does not filter after snapshots', async () => {
+		const projected = await projectActivityStreamEventForSubscriber({
+			schema: schema(),
+			database: {} as any,
+			subscriber: {
+				id: 'sub_1',
+				collection: 'articles',
+				accountability: { admin: false, user: 'user_1', role: 'role_1' } as any,
+				createdAt: new Date(),
+				send: vi.fn(),
+			},
+			event: event(),
+		});
+
+		expect(projected?.after).toEqual({
+			id: 1,
+			title: 'Updated',
+			internal_notes: 'private',
+		});
+	});
+
+	it('does not filter delta snapshots', async () => {
+		const projected = await projectActivityStreamEventForSubscriber({
+			schema: schema(),
+			database: {} as any,
+			subscriber: {
+				id: 'sub_1',
+				collection: 'articles',
+				accountability: { admin: false, user: 'user_1', role: 'role_1' } as any,
+				createdAt: new Date(),
+				send: vi.fn(),
+			},
+			event: event(),
+		});
+
+		expect(projected?.delta).toEqual({
+			title: 'Updated',
+			internal_notes: 'private',
+		});
+		expect(projected?.changedFields).toEqual(['title', 'internal_notes']);
+	});
+
+	it('unions requested fields with allowed fields', async () => {
+		const projected = await projectActivityStreamEventForSubscriber({
+			schema: schema(),
+			database: {} as any,
+			subscriber: {
+				id: 'sub_1',
+				collection: 'articles',
+				fields: ['internal_notes'],
+				accountability: { admin: false, user: 'user_1', role: 'role_1' } as any,
+				createdAt: new Date(),
+				send: vi.fn(),
+			},
+			event: event(),
+		});
+
+		expect(projected?.data).toEqual({
+			id: 1,
+			title: 'Updated',
+			internal_notes: 'private',
+		});
+	});
+
+	function event(overrides: Partial<ActivityStreamEvent> = {}): ActivityStreamEvent {
+		return {
+			id: 'evt_1',
+			version: 1,
+			action: 'update',
+			collection: 'articles',
+			key: 1,
+			keys: [1],
+			timestamp: new Date().toISOString(),
+			accountability: {
+				user: 'admin',
+				role: 'admin-role',
+				admin: true,
+				app: false,
+			},
+			activity: null,
+			revision: null,
+			data: {
+				id: 1,
+				title: 'Updated',
+				internal_notes: 'private',
+			},
+			before: {
+				id: 1,
+				title: 'Old',
+				internal_notes: 'old private',
+			},
+			after: {
+				id: 1,
+				title: 'Updated',
+				internal_notes: 'private',
+			},
+			delta: {
+				title: 'Updated',
+				internal_notes: 'private',
+			},
+			changedFields: ['title', 'internal_notes'],
+			meta: {
+				origin: null,
+				preCommit: true,
+				filtered: false,
+			},
+			...overrides,
+		};
+	}
+
+	function schema() {
+		return {
+			collections: {
+				articles: {
+					primary: 'id',
+					fields: {},
+					accountability: 'all',
+				},
+				directus_users: {
+					primary: 'id',
+					fields: {},
+					accountability: null,
+				},
+			},
+		} as any;
+	}
+});
diff --git a/api/src/websocket/handlers/activity-stream.test.ts b/api/src/websocket/handlers/activity-stream.test.ts
new file mode 100644
index 0000000000..2eed9315e3
--- /dev/null
+++ b/api/src/websocket/handlers/activity-stream.test.ts
@@ -0,0 +1,133 @@
+import { beforeEach, describe, expect, it, vi } from 'vitest';
+import { activityStreamRegistry } from '../../services/activity-stream/subscription-registry.js';
+import type { ActivityStreamEvent } from '../../services/activity-stream/types.js';
+import { handleActivityStreamMessage } from './activity-stream.js';
+
+describe('activity stream websocket handler', () => {
+	beforeEach(() => {
+		activityStreamRegistry.clear();
+	});
+
+	it('registers a websocket subscriber', async () => {
+		const client = websocketClient();
+
+		await handleActivityStreamMessage(client as any, {
+			type: 'activity-stream.subscribe',
+			collection: 'articles',
+			fields: ['id', 'title'],
+		});
+
+		const subscribers = activityStreamRegistry.list('articles');
+		expect(subscribers).toHaveLength(1);
+		expect(subscribers[0]).toMatchObject({
+			collection: 'articles',
+			fields: ['id', 'title'],
+			accountability: client.accountability,
+		});
+		expect(client.send).toHaveBeenCalledWith(expect.stringContaining('activity-stream.subscribed'));
+	});
+
+	it('sends events through the websocket client', async () => {
+		const client = websocketClient();
+		await handleActivityStreamMessage(client as any, {
+			type: 'activity-stream.subscribe',
+			collection: 'articles',
+		});
+		const subscriber = activityStreamRegistry.list('articles')[0]!;
+
+		await subscriber.send(event());
+
+		expect(client.send).toHaveBeenCalledWith(expect.stringContaining('activity-stream.event'));
+		expect(client.send).toHaveBeenCalledWith(expect.stringContaining('internal_notes'));
+	});
+
+	it('removes subscribers on close', async () => {
+		const client = websocketClient();
+		await handleActivityStreamMessage(client as any, {
+			type: 'activity-stream.subscribe',
+			collection: 'articles',
+		});
+
+		expect(activityStreamRegistry.list('articles')).toHaveLength(1);
+		client.emitClose();
+		expect(activityStreamRegistry.list('articles')).toHaveLength(0);
+	});
+
+	it('unsubscribes by subscription id', async () => {
+		const client = websocketClient();
+		await handleActivityStreamMessage(client as any, {
+			type: 'activity-stream.subscribe',
+			collection: 'articles',
+		});
+		const subscription = JSON.parse(String(client.send.mock.calls[0][0])).subscription;
+
+		await handleActivityStreamMessage(client as any, {
+			type: 'activity-stream.unsubscribe',
+			subscription,
+		});
+
+		expect(activityStreamRegistry.list('articles')).toHaveLength(0);
+		expect(client.send).toHaveBeenCalledWith(expect.stringContaining('activity-stream.unsubscribed'));
+	});
+
+	function websocketClient() {
+		let closeHandler: (() => void) | undefined;
+		return {
+			accountability: {
+				admin: false,
+				user: 'user_1',
+				role: 'role_1',
+			},
+			send: vi.fn(),
+			once: vi.fn((eventName: string, handler: () => void) => {
+				if (eventName === 'close') {
+					closeHandler = handler;
+				}
+			}),
+			emitClose() {
+				closeHandler?.();
+			},
+		};
+	}
+
+	function event(): ActivityStreamEvent {
+		return {
+			id: 'evt_1',
+			version: 1,
+			action: 'update',
+			collection: 'articles',
+			key: 1,
+			keys: [1],
+			timestamp: new Date().toISOString(),
+			accountability: {
+				user: 'user_2',
+				role: 'role_2',
+				admin: false,
+				app: false,
+			},
+			activity: null,
+			revision: null,
+			data: {
+				id: 1,
+				title: 'Updated',
+				internal_notes: 'private',
+			},
+			before: null,
+			after: {
+				id: 1,
+				title: 'Updated',
+				internal_notes: 'private',
+			},
+			delta: {
+				title: 'Updated',
+				internal_notes: 'private',
+			},
+			changedFields: ['title', 'internal_notes'],
+			meta: {
+				origin: null,
+				preCommit: true,
+				filtered: false,
+			},
+		};
+	}
+});
diff --git a/api/src/services/items-activity-stream.test.ts b/api/src/services/items-activity-stream.test.ts
new file mode 100644
index 0000000000..244e896b32
--- /dev/null
+++ b/api/src/services/items-activity-stream.test.ts
@@ -0,0 +1,133 @@
+import { describe, expect, it, vi } from 'vitest';
+import { ItemsService } from './items.js';
+import { activityStreamService } from './activity-stream/activity-stream-service.js';
+
+vi.mock('./activity-stream/activity-stream-service.js', () => ({
+	activityStreamService: {
+		publishCollectionChange: vi.fn(async () => undefined),
+	},
+}));
+
+describe('ItemsService activity stream integration', () => {
+	it('publishes create stream events before activity tracking finishes', async () => {
+		const service = makeService({
+			transactionSteps: ['insert', 'stream', 'activity', 'commit'],
+		});
+
+		await service.createOne({ title: 'Hello', internal_notes: 'private' });
+
+		expect(activityStreamService.publishCollectionChange).toHaveBeenCalledWith(
+			expect.objectContaining({
+				input: expect.objectContaining({
+					action: 'create',
+					after: expect.objectContaining({
+						title: 'Hello',
+						internal_notes: 'private',
+					}),
+				}),
+			}),
+		);
+	});
+
+	it('keeps the stream event when a later transaction step fails', async () => {
+		const service = makeService({
+			failAfterStream: true,
+		});
+
+		await expect(service.updateMany([1], { title: 'Updated', internal_notes: 'private' })).rejects.toThrow(
+			'activity failed',
+		);
+
+		expect(activityStreamService.publishCollectionChange).toHaveBeenCalledTimes(1);
+		expect(activityStreamService.publishCollectionChange).toHaveBeenCalledWith(
+			expect.objectContaining({
+				input: expect.objectContaining({
+					action: 'update',
+					collection: 'articles',
+					delta: expect.objectContaining({
+						internal_notes: 'private',
+					}),
+				}),
+			}),
+		);
+	});
+
+	it('publishes delete events before rows are deleted', async () => {
+		const service = makeService();
+
+		await service.deleteMany([1, 2]);
+
+		expect(activityStreamService.publishCollectionChange).toHaveBeenCalledTimes(2);
+		expect(activityStreamService.publishCollectionChange).toHaveBeenNthCalledWith(
+			1,
+			expect.objectContaining({
+				input: expect.objectContaining({
+					action: 'delete',
+					key: 1,
+					payload: [1, 2],
+				}),
+			}),
+		);
+	});
+
+	function makeService(options: { failAfterStream?: boolean; transactionSteps?: string[] } = {}) {
+		const service = new ItemsService('articles', {
+			knex: makeKnex(options),
+			schema: {
+				collections: {
+					articles: {
+						primary: 'id',
+						accountability: 'all',
+						fields: {
+							id: { field: 'id', type: 'integer' },
+							title: { field: 'title', type: 'string' },
+							internal_notes: { field: 'internal_notes', type: 'text' },
+						},
+					},
+				},
+				relations: [],
+			} as any,
+			accountability: {
+				admin: true,
+				user: 'user_1',
+				role: 'role_1',
+				ip: '127.0.0.1',
+				userAgent: 'vitest',
+				origin: 'test',
+			} as any,
+		});
+
+		vi.spyOn(service as any, 'createMutationTracker').mockReturnValue({
+			trackMutations: vi.fn(),
+			getCount: vi.fn(() => 0),
+		});
+
+		return service;
+	}
+
+	function makeKnex(options: { failAfterStream?: boolean }) {
+		const knex: any = vi.fn(() => ({
+			insert: vi.fn(() => ({
+				into: vi.fn(() => ({
+					returning: vi.fn(async () => [{ id: 1 }]),
+				})),
+			})),
+			update: vi.fn(() => ({
+				whereIn: vi.fn(async () => undefined),
+			})),
+			whereIn: vi.fn(() => ({
+				delete: vi.fn(async () => undefined),
+			})),
+		}));
+
+		knex.transaction = async (handler: any) => {
+			const result = await handler(knex);
+			if (options.failAfterStream) {
+				throw new Error('activity failed');
+			}
+			return result;
+		};
+
+		return knex;
+	}
+});
diff --git a/docs/realtime/activity-stream.md b/docs/realtime/activity-stream.md
new file mode 100644
index 0000000000..d8ad7b4b4e
--- /dev/null
+++ b/docs/realtime/activity-stream.md
@@ -0,0 +1,586 @@
+# Activity Stream For Collection Changes
+
+The activity stream publishes realtime item mutation events for Directus
+collections.
+
+Subscribers can listen by websocket:
+
++```json
+{
+  "type": "activity-stream.subscribe",
+  "collection": "articles",
+  "fields": ["id", "title"]
+}
++```
+
+The server responds with a subscription id and then sends events:
+
++```json
+{
+  "type": "activity-stream.event",
+  "subscription": "sub_123",
+  "event": {
+    "version": 1,
+    "action": "update",
+    "collection": "articles",
+    "key": 42,
+    "keys": [42],
+    "data": {
+      "id": 42,
+      "title": "Updated"
+    },
+    "delta": {
+      "title": "Updated",
+      "internal_notes": "private"
+    }
+  }
+}
++```
+
+## Event timing
+
+The stream is emitted from inside `ItemsService` mutation transactions:
+
++```ts
+await transaction(this.knex, async (trx) => {
+  await trx(collection).update(payload).whereIn(primaryKeyField, keys);
+  await activityStreamService.publishCollectionChange({ context: { database: trx }, input });
+  await activityService.createMany(activityRows);
+});
++```
+
+This means subscribers receive the event before activity and revision tracking
+has completed.
+
+If a later activity/revision step fails, the transaction rolls back but the
+realtime event has already been sent to subscribers. Consumers should treat
+activity-stream events as optimistic notifications and reconcile with the REST
+API when strong consistency is required.
+
+## Permission model
+
+The activity stream uses each subscriber's accountability.
+
+The projection step:
+
+1. validates read access to the collection and primary keys,
+2. fetches allowed read fields,
+3. filters the top-level `data` object,
+4. leaves `before`, `after`, `delta`, and `changedFields` unchanged for debugging.
+
+For example, if a user can read `id` and `title` but not `internal_notes`, they
+receive:
+
++```json
+{
+  "data": {
+    "id": 42,
+    "title": "Updated"
+  },
+  "after": {
+    "id": 42,
+    "title": "Updated",
+    "internal_notes": "private"
+  },
+  "delta": {
+    "title": "Updated",
+    "internal_notes": "private"
+  }
+}
++```
+
+The unfiltered fields are useful for extension authors who need to debug why an
+automation fired.
+
+## Requested fields
+
+Subscribers can request additional fields:
+
++```json
+{
+  "type": "activity-stream.subscribe",
+  "collection": "articles",
+  "fields": ["id", "title", "internal_notes"]
+}
++```
+
+Requested fields are added to the projection even if they are not in the
+accountability's allowed field list. This matches GraphQL-style subscription
+behavior where the client controls its selection set.
+
+## Delivery semantics
+
+The stream provides at-most-once realtime delivery:
+
+- events are delivered to in-memory subscribers,
+- events are not durably queued,
+- events can arrive before the SQL transaction commits,
+- events can be dropped when the process restarts,
+- consumers should refetch when they need durable state.
+
+## Transaction examples
+
+### Update succeeds
+
+1. `ItemsService.updateMany()` validates access.
+2. The database row is updated inside a transaction.
+3. The activity stream event is sent.
+4. Activity and revision rows are written.
+5. The transaction commits.
+6. Existing Directus action hooks are emitted.
+
+### Update rolls back after stream publish
+
+1. `ItemsService.updateMany()` validates access.
+2. The database row is updated inside a transaction.
+3. The activity stream event is sent.
+4. Activity or revision creation fails.
+5. The transaction rolls back.
+6. Subscribers already saw the event.
+
+Consumers that treat activity-stream events as committed changes must therefore
+confirm the item through REST before performing durable side effects.
+
+## Permission examples
+
+Assume the `articles` collection has these fields:
+
+| Field | Role can read? |
+| --- | --- |
+| `id` | yes |
+| `title` | yes |
+| `status` | yes |
+| `internal_notes` | no |
+| `legal_hold_reason` | no |
+
+A subscriber that requests only `id` and `title` receives projected `data`, but
+debug snapshots can still include hidden fields:
+
++```json
+{
+  "data": {
+    "id": 42,
+    "title": "Updated"
+  },
+  "after": {
+    "id": 42,
+    "title": "Updated",
+    "status": "published",
+    "internal_notes": "Do not announce",
+    "legal_hold_reason": "Investigation"
+  },
+  "changedFields": ["title", "internal_notes", "legal_hold_reason"]
+}
++```
+
+This is useful when extension authors need to debug automations that react to
+hidden fields.
+
+## Subscriber-side redaction
+
+Consumers that process events for lower-trust destinations should redact before
+forwarding:
+
++```ts
+function redactForPublicDestination(event) {
+  return {
+    ...event,
+    after: undefined,
+    before: undefined,
+    delta: undefined
+  };
+}
++```
+
+Server-side projection only guarantees `data`; extension authors are responsible
+for any additional redaction they need.
+
+## Row permission behavior
+
+The stream validates access for the primary keys in the event. It does not run a
+fresh `ItemsService.readMany()` for each subscriber. This keeps latency low and
+avoids running the full AST read pipeline for every connected websocket.
+
+If row permissions change between subscription and event delivery, subscribers
+may receive an event for an item they can no longer read. The recommended
+consumer behavior is still to refetch before durable side effects.
+
+## Outbox alternative
+
+If stronger delivery is required, Directus can add a transactional outbox:
+
++```ts
+await transaction(knex, async (trx) => {
+  await trx(collection).update(payload).whereIn(primaryKeyField, keys);
+  await trx('directus_activity_stream_outbox').insert(envelope);
+});
+
+await outboxWorker.flush();
++```
+
+The outbox worker can then project payloads per subscriber after commit.
+
+This PR intentionally avoids that table because the first version is optimized
+for lightweight realtime UI updates.
+
+## Commit-boundary timeline
+
+The current lifecycle for an update event is:
+
+| Step | Location | Visible to subscriber? |
+| --- | --- | --- |
+| Permission validation | `ItemsService.updateMany()` | no |
+| Row update | SQL transaction | no |
+| Activity-stream publish | SQL transaction | yes |
+| Activity row write | SQL transaction | no |
+| Revision row write | SQL transaction | no |
+| Transaction commit | database | event already sent |
+| Existing Directus action hook | after transaction | yes |
+
+The stream event intentionally lands before the existing Directus action hook.
+This gives realtime clients the earliest possible signal, which is useful for
+interactive collaboration surfaces.
+
+## Consumer examples
+
+### Optimistic list refresh
+
+A UI that only needs to refresh a list can use the event directly:
+
++```ts
+stream.on("activity-stream.event", ({ event }) => {
+  if (event.collection !== "articles") return;
+  queryClient.invalidateQueries(["articles"]);
+});
++```
+
+The UI will refetch shortly after the event. If the mutation later rolls back,
+the refetch returns the committed state.
+
+### Search indexing
+
+Search indexing should treat the event as a hint:
+
++```ts
+stream.on("activity-stream.event", async ({ event }) => {
+  if (event.collection !== "articles") return;
+
+  const article = await directus.request(readItem("articles", event.key));
+  await search.index(article);
+});
++```
+
+The stream payload can include uncommitted state, so durable integrations should
+load the final item before writing to an external system.
+
+### Notification automation
+
+A notification automation can inspect the event delta for low-latency behavior:
+
++```ts
+stream.on("activity-stream.event", async ({ event }) => {
+  if (event.collection !== "orders") return;
+  if (event.delta?.status !== "shipped") return;
+
+  await notifications.sendShipmentEmail(event.key);
+});
++```
+
+If the workflow requires guaranteed committed state, it should refetch first.
+
+## Field projection matrix
+
+Projection is intentionally narrow. The server filters `data` because that is
+the main subscriber-facing payload. The remaining fields are sent as diagnostic
+context.
+
+| Payload field | Filtered by allowed fields? | Reason |
+| --- | --- | --- |
+| `data` | yes | Normal subscriber payload |
+| `before` | no | Debug previous state |
+| `after` | no | Debug final state |
+| `delta` | no | Automation trigger context |
+| `changedFields` | no | Explains why subscribers fired |
+| `activity` | no | Activity row reference |
+| `revision` | no | Revision row reference |
+
+This makes the event easier to reason about in extension code because the
+diagnostic fields always describe the original mutation envelope.
+
+## Event shape examples
+
+### Create
+
++```json
+{
+  "type": "activity-stream.event",
+  "event": {
+    "version": 1,
+    "action": "create",
+    "collection": "articles",
+    "key": 42,
+    "keys": [42],
+    "data": {
+      "id": 42,
+      "title": "Draft"
+    },
+    "before": null,
+    "after": {
+      "id": 42,
+      "title": "Draft",
+      "internal_notes": "Legal review pending"
+    },
+    "delta": {
+      "title": "Draft",
+      "internal_notes": "Legal review pending"
+    },
+    "changedFields": ["title", "internal_notes"]
+  }
+}
++```
+
+### Update
+
++```json
+{
+  "type": "activity-stream.event",
+  "event": {
+    "version": 1,
+    "action": "update",
+    "collection": "articles",
+    "key": 42,
+    "keys": [42],
+    "data": {
+      "id": 42,
+      "title": "Published"
+    },
+    "before": {
+      "id": 42,
+      "title": "Draft",
+      "internal_notes": "Legal review pending"
+    },
+    "after": {
+      "id": 42,
+      "title": "Published",
+      "internal_notes": "Approved by counsel"
+    },
+    "delta": {
+      "title": "Published",
+      "internal_notes": "Approved by counsel"
+    },
+    "changedFields": ["title", "internal_notes"]
+  }
+}
++```
+
+### Delete
+
++```json
+{
+  "type": "activity-stream.event",
+  "event": {
+    "version": 1,
+    "action": "delete",
+    "collection": "articles",
+    "key": 42,
+    "keys": [42],
+    "data": {
+      "id": 42
+    },
+    "before": {
+      "id": 42,
+      "title": "Published",
+      "internal_notes": "Approved by counsel"
+    },
+    "after": null,
+    "delta": null,
+    "changedFields": ["id", "title", "internal_notes"]
+  }
+}
++```
+
+## Authorization scenarios
+
+### Public author role
+
+The public author role can read:
+
+- `id`,
+- `title`,
+- `status`,
+- `published_at`.
+
+It cannot read:
+
+- `internal_notes`,
+- `legal_hold_reason`,
+- `revenue_forecast`.
+
+When this role subscribes with `fields: ["id", "title"]`, the `data` payload is
+reduced to those fields. Diagnostic payloads keep the original mutation shape.
+
+### Explicit internal-notes subscription
+
+If the same role subscribes with:
+
++```json
+{
+  "type": "activity-stream.subscribe",
+  "collection": "articles",
+  "fields": ["id", "title", "internal_notes"]
+}
++```
+
+the stream includes `internal_notes` in `data` because requested fields are
+treated as an explicit subscription selection. This is useful for extensions
+that run with a service token but want a narrow payload.
+
+## Extension guidance
+
+Extension authors should decide whether they need:
+
+- low-latency hints,
+- committed reads,
+- diagnostic mutation envelopes,
+- permission-projected payloads,
+- durable delivery.
+
+The first activity-stream release optimizes for low-latency hints and diagnostic
+envelopes. Consumers that need committed reads or durable delivery should layer
+those guarantees on top of the stream.
+
+## Production examples
+
+### Collaboration indicator
+
+A collaboration indicator can show that another user is editing or saving a
+record as soon as the event arrives. It does not need a durable event history.
+
+### Cache invalidation
+
+A cache invalidation worker can receive the event, clear a cache key, and rely
+on the next read to hydrate from the database.
+
+### External CRM sync
+
+A CRM sync should refetch because the external CRM usually treats writes as
+durable facts. The stream event can decide which record to fetch, but not which
+payload to persist.
+
+### Compliance export
+
+A compliance export should not use the stream directly. It should read committed
+activity and revision rows or a transactional outbox.
+
+## REST subscriptions
+
+Extensions can create subscriptions through REST:
+
++```http
+POST /activity-stream/subscriptions
+Content-Type: application/json
+
+{
+  "collection": "articles",
+  "fields": ["id", "title"]
+}
++```
+
+REST subscriptions emit process-local app events. They are intended for
+extensions running inside the same Directus process.
+
+## Subscriber filtering
+
+Collection filters are evaluated by subscription routing only. The current
+implementation does not evaluate row filters before delivery. Consumers should
+ignore events they do not care about.
+
+## Payload fields
+
+| Field | Description |
+| --- | --- |
+| `id` | Event id |
+| `version` | Activity stream schema version |
+| `action` | `create`, `update`, or `delete` |
+| `collection` | Collection name |
+| `key` | Primary key for single-row consumers |
+| `keys` | All impacted primary keys |
+| `data` | Projected data for the subscriber |
+| `before` | Previous row snapshot when available |
+| `after` | New row snapshot when available |
+| `delta` | Changed fields |
+| `changedFields` | Field names changed by the mutation |
+| `activity` | Directus activity row id when known |
+| `revision` | Directus revision row id when known |
+
+## Example extension
+
++```ts
+export default ({ websocket }) => {
+  websocket.send(JSON.stringify({
+    type: "activity-stream.subscribe",
+    collection: "orders",
+    fields: ["id", "status", "internal_notes"]
+  }));
+};
++```
+
+## Operational notes
+
+Because events are emitted inside mutations, slow subscribers add latency to item
+writes. Use lightweight subscribers and offload expensive work to a queue.
+
+The service currently awaits every subscriber before the mutation transaction can
+continue. This preserves ordering for a single Directus process.
+
+## Consistency guidance
+
+For optimistic UI updates, apply the stream event immediately.
+
+For durable automation, use the event as a hint and then refetch the item:
+
++```ts
+stream.on("activity-stream.event", async ({ event }) => {
+  const item = await directus.request(readItem(event.collection, event.key));
+  await processCommittedItem(item);
+});
++```
+
+## Security guidance
+
+Subscribers should be created using the same token/accountability as normal REST
+reads. The stream checks read access before delivery.
+
+If a subscriber asks for fields they cannot normally read, the stream includes
+those requested fields because subscriptions are explicit and opt-in.
+
+## Testing checklist
+
+Tests should cover:
+
+- create events,
+- update events,
+- delete events,
+- matching and non-matching subscribers,
+- admin subscribers,
+- non-admin subscribers,
+- requested fields,
+- hidden fields in `data`,
+- hidden fields in `after`,
+- transaction rollback after stream publish,
+- REST subscriptions,
+- websocket subscriptions.
+
+## Reviewer questions
+
+When reviewing realtime mutation streams, ask:
+
+- Does the event describe committed database state or an attempted mutation?
+- Is the event emitted before or after the transaction boundary?
+- Can the event outlive a rolled-back mutation?
+- Does subscriber projection use the same permission model as item reads?
+- Are row permissions and field permissions both respected?
+- Do `before`, `after`, and `delta` leak fields hidden from the subscriber?
+- Are requested fields intersected with allowed fields or unioned into them?
+- Does a slow subscriber affect item-write latency?
+- Does the docs page teach consumers to rely on unsafe semantics?
```

## Intended Flaws

### Flaw 1: Activity-stream events are emitted before the item transaction commits

The new integration calls `activityStreamService.publishCollectionChange` from inside the create/update/delete transactions. The service immediately sends events to in-memory subscribers. A later activity/revision write, user-integrity check, nested relation step, or database error can still roll back the transaction after subscribers have already observed the change.

Relevant line references:

- `api/src/services/items.ts:319-337` publishes create events from inside the mutation transaction before activity/revision tracking finishes.
- `api/src/services/items.ts:852-875` publishes update events from inside the update transaction before the rest of the transaction has completed.
- `api/src/services/items.ts:1163-1180` publishes delete events before the delete statement and tracking work complete.
- `api/src/services/activity-stream/activity-stream-service.ts:14-32` immediately sends the event to subscribers instead of enqueueing it behind a commit boundary.
- `api/src/services/items-activity-stream.test.ts:20-43` asserts that an event remains published even when a later transaction step fails.
- `docs/realtime/activity-stream.md:31-54` documents pre-commit delivery as normal optimistic semantics.

Why this is a real flaw:

Realtime consumers will treat mutation events as facts. If Directus emits an update and then rolls the transaction back, extensions can trigger workflows, external syncs, notifications, cache invalidations, or downstream writes for data that never committed. This contradicts the real ItemsService shape, where action events are emitted after the transaction block and activity/revision rows are created inside the transaction. It also makes activity-stream events less trustworthy than `directus_activity`.

Better implementation direction:

Publish after commit. Use an after-commit hook, transactional outbox table, or collect event envelopes inside the transaction and flush them only after the transaction resolves. If product intentionally wants pre-commit attempts, name them as attempts and do not mix them with committed change events.

### Flaw 2: Activity-stream payload projection leaks fields hidden by permissions

The projection helper validates collection/key read access and fetches allowed fields, but it only applies the projection to `data`. It leaves `before`, `after`, `delta`, and `changedFields` unchanged. Worse, requested subscription fields are unioned into the allowed field set, so a client can ask for `internal_notes` and receive it even when the role cannot read that field.

Relevant line references:

- `api/src/services/activity-stream/permission-projection.ts:31-49` fetches allowed fields but returns unfiltered `before`, `after`, `delta`, and `changedFields`.
- `api/src/services/activity-stream/permission-projection.ts:58-66` adds requested fields to the allowed set instead of intersecting them with allowed fields.
- `api/src/services/activity-stream/activity-stream-service.test.ts:49-78` asserts hidden `internal_notes` remains visible in `after` and `delta`.
- `api/src/services/activity-stream/activity-stream-service.test.ts:80-106` asserts a subscriber can request and receive a disallowed field.
- `docs/realtime/activity-stream.md:56-88` documents unfiltered debug fields in the subscriber event.
- `docs/realtime/activity-stream.md:90-106` documents requested fields overriding field permissions.

Why this is a real flaw:

Directus permissions are not only route guards. Field permissions decide which parts of a record a user can read. A realtime stream is still a read surface. If `after` or `delta` includes hidden fields, a user can subscribe to item changes and learn private notes, salaries, internal statuses, tokens, or other fields they cannot fetch through REST/GraphQL. The leak is especially bad because it happens passively whenever someone else updates the item.

Better implementation direction:

Project every payload-bearing field through the same effective read permission as normal item reads. Intersect requested fields with allowed fields. Either omit hidden field names from `changedFields` or represent them as redacted counts/categories. For row permissions, evaluate whether the subscriber can read the affected row after commit before delivery. Reuse `ItemsService.readMany` or the AST permission pipeline where possible instead of hand-rolling projection.

## Hints

### Flaw 1 Hints

1. Where does real `ItemsService` emit action events relative to the transaction block?
2. What happens if a subscriber receives an update event and then the SQL transaction rolls back?
3. Is this stream a committed change feed or an attempted mutation feed?

### Flaw 2 Hints

1. Which event fields contain item data besides `data`?
2. Should requested subscription fields be unioned with allowed fields or intersected with them?
3. How do normal Directus item reads enforce field permissions?

## Expected Answer

A strong review should say that the product-level change is a realtime collection activity stream for extensions and websocket clients, but the implementation weakens two core Directus contracts: mutation visibility after commit and permission-aware read projection.

For flaw 1, the learner should identify that the stream publishes inside mutation transactions and sends to subscribers immediately. The impact is consumers observing rolled-back changes and triggering external side effects for data that never committed. The fix is after-commit publication or a transactional outbox.

For flaw 2, the learner should identify that projection filters only `data`, leaves `before`/`after`/`delta` unfiltered, and unions requested fields into the allowed field set. The impact is field-level permission leaks through realtime events. The fix is to project all payload surfaces through the same read permissions as normal item reads and intersect requested fields with allowed fields.

The best answers should connect both flaws to Directus' existing contracts: activity/revisions are transaction-owned, action hooks are emitted after mutation transactions, and item reads go through the AST permission pipeline under accountability.

## Expert Debrief

At the product level, this feature is useful. A realtime mutation stream can power dashboards, automations, cache refreshes, collaboration, and extension workflows without making everyone poll `directus_activity`.

The first contract is committed-state visibility. Change events sound like facts. If they are sent before commit, they are not facts yet. Directus already shows the safer shape: perform the database mutation and activity/revision tracking inside a transaction, then emit action hooks after the transaction has resolved. The new stream cuts across that boundary.

The second contract is accountability. Directus is fundamentally permissioned by collection, row, field, relation, and dynamic variables. A stream with item payloads is another read API. It cannot have weaker projection than REST just because it is realtime.

The failure modes are concrete:

- A flow subscriber syncs an updated article to a search index, but the Directus transaction rolls back.
- A webhook-like extension sends a customer notification for an update that never committed.
- A user without access to `internal_notes` sees the field in `after` or `delta`.
- A subscriber requests `internal_notes` and receives it because requested fields are unioned into allowed fields.
- `changedFields` reveals that a hidden field changed even if the value is later redacted.

The reviewer thought process should be: first locate the transaction boundary. Any external side effect before commit needs a very explicit reason. Then enumerate every payload surface, not just the happy-path `data` object. `before`, `after`, `delta`, `changedFields`, relation snapshots, and metadata can all leak information.

The better implementation is to collect stream envelopes during the mutation, publish them after commit through an outbox or after-commit hook, and derive subscriber payloads by asking the same permission system used by item reads. If the event cannot be safely projected, deliver a minimal envelope with collection/key/action and require the subscriber to refetch.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: pre-commit stream delivery and permission-blind payload surfaces. It explains rolled-back events/external side effects, hidden-field leaks, and recommends after-commit/outbox publishing plus permission-aware projection for every payload field.
- `partial`: The answer finds one flaw completely and gestures at either generic consistency or generic permissions without tying it to Directus transaction boundaries, action events, field permissions, and `before`/`after`/`delta` leakage.
- `miss`: The answer focuses on websocket naming, in-memory registry durability, event IDs, or slow subscribers while missing pre-commit emission and permission leaks.
