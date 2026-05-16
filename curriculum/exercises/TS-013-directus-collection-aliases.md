# TS-013: Directus Collection Aliases

## Metadata

- `id`: TS-013
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: system metadata tables, collection service, schema cache, collection existence middleware, snapshot/diff/apply, collection alias controller tests
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 888
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about metadata identity, alias resolution, schema cache invalidation, snapshot compatibility, audit retention, and delete semantics without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds collection aliases.

Admins can now define a stable public alias for a collection, such as exposing `articles` as `posts` to API clients while keeping the underlying table name unchanged. Aliases are stored as system metadata, included in schema snapshots, resolved by collection middleware, and exposed through a small admin API.

The PR adds:

- a `directus_collection_aliases` metadata table,
- a collection alias service and controller,
- alias arrays on collection API responses and snapshots,
- alias resolution in collection middleware,
- snapshot apply support for creating/deleting aliases,
- cleanup of aliases when a collection is deleted,
- tests for creating aliases, resolving aliases, deleting collections, and applying aliases from a snapshot.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `api/src/services/collections.ts` is the central collection metadata service. It creates physical tables, inserts `directus_collections` metadata, reads schema metadata, updates collection meta, and deletes collection-related records.
- `api/src/middleware/collection-exists.ts` validates route collection keys against `req.schema.collections` and assigns `req.collection`.
- `api/src/utils/get-schema.ts` builds `SchemaOverview` from database table info, `directus_collections`, `directus_fields`, and relations, then caches it.
- `api/src/utils/get-snapshot.ts`, `api/src/utils/get-snapshot-diff.ts`, `api/src/utils/apply-snapshot.ts`, and `api/src/utils/apply-diff.ts` define the migration-like snapshot contract.
- `api/src/utils/sanitize-schema.ts` decides which collection properties are included in snapshots and compared during schema diff.
- `packages/types/src/collection.ts` defines `CollectionMeta`, `Collection`, `ApiCollection`, and `CollectionType`.
- `packages/system-data/src/collections/collections.yaml` defines system collection metadata rows like `directus_collections`, `directus_fields`, `directus_activity`, and `directus_revisions`.
- `api/src/services/collections.ts` currently deletes collection metadata, presets, revisions, activity rows, permissions, relations, and related fields when a collection is deleted. That is an intentionally broad lifecycle operation.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `api/src/database/migrations/20260512A-add-collection-aliases.ts`
- `packages/types/src/collection.ts`
- `packages/types/src/schema.ts`
- `packages/system-data/src/collections/collections.yaml`
- `api/src/services/collection-aliases.ts`
- `api/src/services/collections.ts`
- `api/src/controllers/collection-aliases.ts`
- `api/src/controllers/collections.ts`
- `api/src/middleware/collection-exists.ts`
- `api/src/utils/get-schema.ts`
- `api/src/utils/get-snapshot.ts`
- `api/src/utils/sanitize-schema.ts`
- `api/src/utils/apply-diff.ts`
- `api/src/services/collection-aliases.test.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on metadata identity, API resolution, snapshot behavior, and delete lifecycle semantics.

## Diff

```diff
diff --git a/api/src/database/migrations/20260512A-add-collection-aliases.ts b/api/src/database/migrations/20260512A-add-collection-aliases.ts
new file mode 100644
index 0000000000..cebbde6219
--- /dev/null
+++ b/api/src/database/migrations/20260512A-add-collection-aliases.ts
@@ -0,0 +1,126 @@
+import type { Knex } from 'knex';
+
+export async function up(knex: Knex): Promise<void> {
+	await knex.schema.createTable('directus_collection_aliases', (table) => {
+		table.increments('id');
+		table.string('collection').notNullable();
+		table.string('alias').notNullable();
+		table.string('note');
+		table.string('created_by');
+		table.timestamp('created_at').defaultTo(knex.fn.now());
+		table.string('updated_by');
+		table.timestamp('updated_at').defaultTo(knex.fn.now());
+
+		table
+			.foreign('collection')
+			.references('collection')
+			.inTable('directus_collections')
+			.onDelete('CASCADE');
+
+		table.index(['collection']);
+		table.index(['alias']);
+	});
+}
+
+export async function down(knex: Knex): Promise<void> {
+	await knex.schema.dropTable('directus_collection_aliases');
+}
diff --git a/packages/types/src/collection.ts b/packages/types/src/collection.ts
index f47ad2ac7e..0e3c1633e2 100644
--- a/packages/types/src/collection.ts
+++ b/packages/types/src/collection.ts
@@ -6,6 +6,14 @@ type Translations = {
 	plural: string;
 };
 
+export type CollectionAlias = {
+	id?: number;
+	collection: string;
+	alias: string;
+	note: string | null;
+	created_at?: string;
+};
+
 export type CollectionMeta = {
 	collection: string;
 	note: string | null;
@@ -31,6 +39,7 @@ export interface Collection {
 	collection: string;
 	meta: CollectionMeta | null;
 	schema: Table | null;
+	aliases?: CollectionAlias[];
 }
 
 export interface AppCollection extends Collection {
@@ -65,6 +74,7 @@ export type RawCollection = {
 	fields?: RawField[];
 	schema?: Partial<Table> | null;
 	meta?: Partial<BaseCollectionMeta> | null;
+	aliases?: CollectionAlias[];
 };
 
 export type ApiCollection = {
@@ -72,4 +82,5 @@ export type ApiCollection = {
 	fields?: Field[];
 	meta: BaseCollectionMeta | null;
 	schema: Table | null;
+	aliases?: CollectionAlias[];
 };
diff --git a/packages/types/src/schema.ts b/packages/types/src/schema.ts
index 775f9b4f86..089f83f2a0 100644
--- a/packages/types/src/schema.ts
+++ b/packages/types/src/schema.ts
@@ -19,6 +19,7 @@ export type CollectionOverview = {
 	note: string | null;
 	accountability: 'all' | 'activity' | null;
 	fields: {
 		[name: string]: FieldOverview;
 	};
+	aliases?: string[];
 };
diff --git a/packages/system-data/src/collections/collections.yaml b/packages/system-data/src/collections/collections.yaml
index fcb83bb5cb..af038018b3 100644
--- a/packages/system-data/src/collections/collections.yaml
+++ b/packages/system-data/src/collections/collections.yaml
@@ -13,6 +13,10 @@ data:
   - collection: directus_activity
     note: $t:directus_collection.directus_activity
     accountability: null
 
+  - collection: directus_collection_aliases
+    icon: alt_route
+    note: $t:directus_collection.directus_collection_aliases
+
   - collection: directus_collections
     icon: database
     note: $t:directus_collection.directus_collections
diff --git a/api/src/services/collection-aliases.ts b/api/src/services/collection-aliases.ts
new file mode 100644
index 0000000000..80acfcb24b
--- /dev/null
+++ b/api/src/services/collection-aliases.ts
@@ -0,0 +1,230 @@
+import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
+import type { Accountability, CollectionAlias, MutationOptions, SchemaOverview } from '@directus/types';
+import type { Knex } from 'knex';
+import { clearSystemCache, getCache } from '../cache.js';
+import getDatabase from '../database/index.js';
+import emitter from '../emitter.js';
+import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
+import { getSchema } from '../utils/get-schema.js';
+import { shouldClearCache } from '../utils/should-clear-cache.js';
+
+type AliasPayload = {
+	collection: string;
+	alias: string;
+	note?: string | null;
+};
+
+type ServiceOptions = {
+	knex?: Knex;
+	schema: SchemaOverview;
+	accountability?: Accountability | null;
+};
+
+const RESERVED_PREFIX = 'directus_';
+
+function normalizeAlias(alias: string): string {
+	return alias.trim();
+}
+
+function assertValidAlias(alias: string) {
+	if (alias.length === 0) {
+		throw new InvalidPayloadError({ reason: `"alias" must be a non-empty string` });
+	}
+
+	if (alias.includes('/')) {
+		throw new InvalidPayloadError({ reason: `Collection aliases can't contain "/"` });
+	}
+
+	if (alias.startsWith(RESERVED_PREFIX)) {
+		throw new InvalidPayloadError({ reason: `Collection aliases can't start with "directus_"` });
+	}
+}
+
+export class CollectionAliasesService {
+	knex: Knex;
+	schema: SchemaOverview;
+	accountability: Accountability | null;
+
+	constructor(options: ServiceOptions) {
+		this.knex = options.knex ?? getDatabase();
+		this.schema = options.schema;
+		this.accountability = options.accountability ?? null;
+	}
+
+	async createOne(payload: AliasPayload, opts?: MutationOptions): Promise<CollectionAlias> {
+		if (this.accountability && this.accountability.admin !== true) {
+			throw new ForbiddenError();
+		}
+
+		if (!payload.collection) {
+			throw new InvalidPayloadError({ reason: `"collection" is required` });
+		}
+
+		if (!payload.alias) {
+			throw new InvalidPayloadError({ reason: `"alias" is required` });
+		}
+
+		const alias = normalizeAlias(payload.alias);
+		assertValidAlias(alias);
+
+		if (!this.schema.collections[payload.collection]) {
+			throw new InvalidPayloadError({ reason: `Collection "${payload.collection}" doesn't exist` });
+		}
+
+		const [created] = await this.knex('directus_collection_aliases')
+			.insert({
+				collection: payload.collection,
+				alias,
+				note: payload.note ?? null,
+				created_by: this.accountability?.user ?? null,
+				updated_by: this.accountability?.user ?? null,
+			})
+			.returning(['id', 'collection', 'alias', 'note', 'created_at']);
+
+		await this.clearCaches(opts);
+		await this.emitAliasAction('collection.alias.create', created, opts);
+
+		return created;
+	}
+
+	async createMany(payloads: AliasPayload[], opts?: MutationOptions): Promise<CollectionAlias[]> {
+		const aliases: CollectionAlias[] = [];
+
+		for (const payload of payloads) {
+			aliases.push(
+				await this.createOne(payload, {
+					...opts,
+					autoPurgeSystemCache: false,
+					emitEvents: false,
+				}),
+			);
+		}
+
+		await this.clearCaches(opts);
+		return aliases;
+	}
+
+	async readByCollection(collection: string): Promise<CollectionAlias[]> {
+		if (this.accountability) {
+			await validateAccess(
+				{
+					accountability: this.accountability,
+					action: 'read',
+					collection,
+					skipCollectionExistsCheck: true,
+				},
+				{
+					schema: this.schema,
+					knex: this.knex,
+				},
+			);
+		}
+
+		return await this.knex('directus_collection_aliases')
+			.select('id', 'collection', 'alias', 'note', 'created_at')
+			.where({ collection })
+			.orderBy('alias', 'asc');
+	}
+
+	async readAll(): Promise<CollectionAlias[]> {
+		return await this.knex('directus_collection_aliases')
+			.select('id', 'collection', 'alias', 'note', 'created_at')
+			.orderBy('alias', 'asc');
+	}
+
+	async resolve(aliasOrCollection: string): Promise<string> {
+		if (this.schema.collections[aliasOrCollection]) {
+			return aliasOrCollection;
+		}
+
+		const aliasRow = await this.knex('directus_collection_aliases')
+			.select('collection', 'alias')
+			.where({ alias: aliasOrCollection })
+			.first();
+
+		return aliasRow?.collection ?? aliasOrCollection;
+	}
+
+	async updateOne(id: number, payload: Partial<AliasPayload>, opts?: MutationOptions): Promise<CollectionAlias> {
+		if (this.accountability && this.accountability.admin !== true) {
+			throw new ForbiddenError();
+		}
+
+		const updates: Record<string, unknown> = {
+			updated_by: this.accountability?.user ?? null,
+			updated_at: new Date(),
+		};
+
+		if (payload.alias !== undefined) {
+			const alias = normalizeAlias(payload.alias);
+			assertValidAlias(alias);
+			updates['alias'] = alias;
+		}
+
+		if (payload.collection !== undefined) {
+			if (!this.schema.collections[payload.collection]) {
+				throw new InvalidPayloadError({ reason: `Collection "${payload.collection}" doesn't exist` });
+			}
+
+			updates['collection'] = payload.collection;
+		}
+
+		if (payload.note !== undefined) {
+			updates['note'] = payload.note;
+		}
+
+		const [updated] = await this.knex('directus_collection_aliases')
+			.where({ id })
+			.update(updates)
+			.returning(['id', 'collection', 'alias', 'note', 'created_at']);
+
+		if (!updated) {
+			throw new ForbiddenError();
+		}
+
+		await this.clearCaches(opts);
+		await this.emitAliasAction('collection.alias.update', updated, opts);
+
+		return updated;
+	}
+
+	async deleteOne(id: number, opts?: MutationOptions): Promise<number> {
+		if (this.accountability && this.accountability.admin !== true) {
+			throw new ForbiddenError();
+		}
+
+		const existing = await this.knex('directus_collection_aliases').select('*').where({ id }).first();
+
+		if (!existing) {
+			throw new ForbiddenError();
+		}
+
+		await this.knex('directus_collection_aliases').delete().where({ id });
+
+		await this.clearCaches(opts);
+		await this.emitAliasAction('collection.alias.delete', existing, opts);
+
+		return id;
+	}
+
+	async deleteByCollection(collection: string, opts?: MutationOptions): Promise<void> {
+		await this.knex('directus_collection_aliases').delete().where({ collection });
+		await this.clearCaches(opts);
+	}
+
+	private async clearCaches(opts?: MutationOptions) {
+		const { cache } = getCache();
+
+		if (shouldClearCache(cache, opts)) {
+			await cache?.clear();
+		}
+
+		if (opts?.autoPurgeSystemCache !== false) {
+			await clearSystemCache({ autoPurgeCache: opts?.autoPurgeCache });
+		}
+	}
+
+	private async emitAliasAction(event: string, alias: CollectionAlias, opts?: MutationOptions) {
+		if (opts?.emitEvents === false) return;
+
+		const schema = await getSchema();
+		emitter.emitAction(event, { collection: alias.collection, alias: alias.alias, id: alias.id }, { schema });
+	}
+}
diff --git a/api/src/services/collections.ts b/api/src/services/collections.ts
index 191d5898df..d980a11ef9 100644
--- a/api/src/services/collections.ts
+++ b/api/src/services/collections.ts
@@ -22,6 +22,7 @@ import { buildCollectionAndFieldRelations } from './fields/build-collection-and-
 import { getCollectionMetaUpdates } from './fields/get-collection-meta-updates.js';
 import { getCollectionRelationList } from './fields/get-collection-relation-list.js';
 import { FieldsService } from './fields.js';
 import { ItemsService } from './items.js';
+import { CollectionAliasesService } from './collection-aliases.js';
 
 export class CollectionsService {
 	knex: Knex;
@@ -322,6 +323,9 @@ export class CollectionsService {
 		}
 
 		const collections: Collection[] = [];
+		const aliasService = new CollectionAliasesService({ knex: this.knex, schema: this.schema, accountability: null });
+		const aliases = await aliasService.readAll();
+		const aliasesByCollection = groupBy(aliases, 'collection');
 
 		for (const collectionMeta of meta) {
 			const collection: Collection = {
@@ -329,6 +333,7 @@ export class CollectionsService {
 				collection: collectionMeta.collection,
 				meta: collectionMeta,
 				schema: tablesInDatabase.find((table) => table.name === collectionMeta.collection) ?? null,
+				aliases: aliasesByCollection[collectionMeta.collection] ?? [],
 			};
 
 			collections.push(collection);
@@ -342,6 +347,7 @@ export class CollectionsService {
 					collection: table.name,
 					schema: table,
 					meta: null,
+					aliases: aliasesByCollection[table.name] ?? [],
 				});
 			}
 		}
@@ -663,6 +669,13 @@ export class CollectionsService {
 						});
 					}
 
+					const aliasesService = new CollectionAliasesService({
+						knex: trx,
+						accountability: this.accountability,
+						schema: this.schema,
+					});
+					await aliasesService.deleteByCollection(collectionKey, opts);
+
 					await trx('directus_revisions').delete().where('collection', '=', collectionKey);
 
 					await trx('directus_activity').delete().where('collection', '=', collectionKey);
diff --git a/api/src/controllers/collection-aliases.ts b/api/src/controllers/collection-aliases.ts
new file mode 100644
index 0000000000..47deec8ffd
--- /dev/null
+++ b/api/src/controllers/collection-aliases.ts
@@ -0,0 +1,137 @@
+import { Router } from 'express';
+import { respond } from '../middleware/respond.js';
+import { CollectionAliasesService } from '../services/collection-aliases.js';
+import asyncHandler from '../utils/async-handler.js';
+
+const router = Router();
+
+router.get(
+	'/',
+	asyncHandler(async (req, res, next) => {
+		const service = new CollectionAliasesService({
+			accountability: req.accountability,
+			schema: req.schema,
+		});
+
+		const aliases = await service.readAll();
+		res.locals['payload'] = { data: aliases };
+		return next();
+	}),
+	respond,
+);
+
+router.get(
+	'/:collection',
+	asyncHandler(async (req, res, next) => {
+		const service = new CollectionAliasesService({
+			accountability: req.accountability,
+			schema: req.schema,
+		});
+
+		const aliases = await service.readByCollection(req.params['collection']!);
+		res.locals['payload'] = { data: aliases };
+		return next();
+	}),
+	respond,
+);
+
+router.post(
+	'/',
+	asyncHandler(async (req, res, next) => {
+		const service = new CollectionAliasesService({
+			accountability: req.accountability,
+			schema: req.schema,
+		});
+
+		if (Array.isArray(req.body)) {
+			res.locals['payload'] = { data: await service.createMany(req.body) };
+		} else {
+			res.locals['payload'] = { data: await service.createOne(req.body) };
+		}
+
+		return next();
+	}),
+	respond,
+);
+
+router.patch(
+	'/:id',
+	asyncHandler(async (req, res, next) => {
+		const service = new CollectionAliasesService({
+			accountability: req.accountability,
+			schema: req.schema,
+		});
+
+		const alias = await service.updateOne(Number(req.params['id']), req.body);
+		res.locals['payload'] = { data: alias };
+		return next();
+	}),
+	respond,
+);
+
+router.delete(
+	'/:id',
+	asyncHandler(async (req, res, next) => {
+		const service = new CollectionAliasesService({
+			accountability: req.accountability,
+			schema: req.schema,
+		});
+
+		await service.deleteOne(Number(req.params['id']));
+		return next();
+	}),
+	respond,
+);
+
+export default router;
diff --git a/api/src/controllers/collections.ts b/api/src/controllers/collections.ts
index d7da7bcaab..e2d4d5099e 100644
--- a/api/src/controllers/collections.ts
+++ b/api/src/controllers/collections.ts
@@ -5,6 +5,7 @@ import { validateBatch } from '../middleware/validate-batch.js';
 import { CollectionsService } from '../services/collections.js';
 import { MetaService } from '../services/meta.js';
 import asyncHandler from '../utils/async-handler.js';
+import collectionAliasesRouter from './collection-aliases.js';
 
 const router = Router();
 
+router.use('/aliases', collectionAliasesRouter);
+
 router.post(
 	'/',
 	asyncHandler(async (req, res, next) => {
diff --git a/api/src/middleware/collection-exists.ts b/api/src/middleware/collection-exists.ts
index 679b516d36..13f447d6d8 100644
--- a/api/src/middleware/collection-exists.ts
+++ b/api/src/middleware/collection-exists.ts
@@ -6,12 +6,27 @@ import { systemCollectionRows } from '@directus/system-data';
 import type { RequestHandler } from 'express';
 import { createCollectionForbiddenError } from '../permissions/modules/process-ast/utils/validate-path/create-error.js';
 import asyncHandler from '../utils/async-handler.js';
 
 const collectionExists: RequestHandler = asyncHandler(async (req, _res, next) => {
 	if (!req.params['collection']) return next();
 
-	if (req.params['collection'] in req.schema.collections === false) {
-		throw createCollectionForbiddenError('', req.params['collection']);
+	let collectionKey = req.params['collection'];
+
+	if (collectionKey in req.schema.collections === false) {
+		const aliasMatch = Object.values(req.schema.collections).find((collection) => {
+			return collection.aliases?.includes(collectionKey!);
+		});
+
+		if (!aliasMatch) {
+			throw createCollectionForbiddenError('', collectionKey);
+		}
+
+		collectionKey = aliasMatch.collection;
+		req.params['collection'] = collectionKey;
+		req.originalUrl = req.originalUrl.replace(/\/items\/[^/?#]+/, `/items/${collectionKey}`);
 	}
 
-	req.collection = req.params['collection'];
+	req.collection = collectionKey;
 
 	const systemCollectionRow = systemCollectionRows.find((collection) => {
 		return collection?.collection === req.collection;
diff --git a/api/src/utils/get-schema.ts b/api/src/utils/get-schema.ts
index 638fe0b567..55eb2d63f7 100644
--- a/api/src/utils/get-schema.ts
+++ b/api/src/utils/get-schema.ts
@@ -113,6 +113,10 @@ async function getDatabaseSchema(database: Knex, schemaInspector: SchemaInspector
 		...systemCollectionRows,
 	];
 
+	const aliases = await database
+		.select('collection', 'alias')
+		.from('directus_collection_aliases')
+		.orderBy('alias', 'asc');
 	for (const [collection, info] of Object.entries(schemaOverview)) {
 		if (toArray(env['DB_EXCLUDE_TABLES']).includes(collection)) {
 			logger.trace(`Collection "${collection}" is configured to be excluded and will be ignored`);
@@ -148,6 +152,9 @@ async function getDatabaseSchema(database: Knex, schemaInspector: SchemaInspector
 			note: collectionMeta?.note || null,
 			sortField: collectionMeta?.sort_field || null,
 			accountability: collectionMeta ? collectionMeta.accountability : 'all',
+			aliases: aliases
+				.filter((alias) => alias.collection === collection)
+				.map((alias) => alias.alias),
 			fields: mapValues(schemaOverview[collection]?.columns, (column) => {
 				return {
 					field: column.column_name,
diff --git a/api/src/utils/get-snapshot.ts b/api/src/utils/get-snapshot.ts
index e77068ab46..052f14fe51 100644
--- a/api/src/utils/get-snapshot.ts
+++ b/api/src/utils/get-snapshot.ts
@@ -6,6 +6,7 @@ import getDatabase, { getDatabaseClient } from '../database/index.js';
 import { CollectionsService } from '../services/collections.js';
 import { FieldsService } from '../services/fields.js';
 import { RelationsService } from '../services/relations.js';
+import { CollectionAliasesService } from '../services/collection-aliases.js';
 import { getSchema } from './get-schema.js';
 import { sanitizeCollection, sanitizeField, sanitizeRelation, sanitizeSystemField } from './sanitize-schema.js';
 
@@ -18,11 +19,13 @@ export async function getSnapshot(options?: { database?: Knex; schema?: SchemaOv
 	const collectionsService = new CollectionsService({ knex: database, schema });
 	const fieldsService = new FieldsService({ knex: database, schema });
 	const relationsService = new RelationsService({ knex: database, schema });
+	const aliasesService = new CollectionAliasesService({ knex: database, schema });
 
-	const [collectionsRaw, fieldsRaw, relationsRaw] = await Promise.all([
+	const [collectionsRaw, fieldsRaw, relationsRaw, aliasesRaw] = await Promise.all([
 		collectionsService.readByQuery(),
 		fieldsService.readAll(),
 		relationsService.readAll(),
+		aliasesService.readAll(),
 	]);
 
 	const collectionsFiltered = collectionsRaw.filter((item) => excludeSystem(item) && excludeUntracked(item));
@@ -31,7 +34,13 @@ export async function getSnapshot(options?: { database?: Knex; schema?: SchemaOv
 	const systemFieldsFiltered = fieldsRaw.filter((item) => systemFieldWithIndex(item));
 
 	const collectionsSorted = sortBy(mapValues(collectionsFiltered, sortDeep), ['collection']).map((collection) =>
-		sanitizeCollection(collection),
+		sanitizeCollection({
+			...collection,
+			aliases: aliasesRaw
+				.filter((alias) => alias.collection === collection.collection)
+				.map(({ id, created_at, ...alias }) => alias),
+		}),
 	);
 
 	const fieldsSorted = sortBy(mapValues(fieldsFiltered, sortDeep), ['collection', 'meta.id']).map((field) =>
diff --git a/api/src/utils/sanitize-schema.ts b/api/src/utils/sanitize-schema.ts
index d8cf1f76bb..3340f1fb1f 100644
--- a/api/src/utils/sanitize-schema.ts
+++ b/api/src/utils/sanitize-schema.ts
@@ -18,7 +18,7 @@ import type { Collection } from '../types/index.js';
  */
 
 export function sanitizeCollection(collection: Collection) {
-	return pick(collection, ['collection', 'fields', 'meta', 'schema.name']) as SnapshotCollection;
+	return pick(collection, ['collection', 'fields', 'meta', 'schema.name', 'aliases']) as SnapshotCollection;
 }
 
 /**
diff --git a/api/src/utils/apply-diff.ts b/api/src/utils/apply-diff.ts
index 91b4afd151..796acbc91d 100644
--- a/api/src/utils/apply-diff.ts
+++ b/api/src/utils/apply-diff.ts
@@ -17,6 +17,7 @@ import { getHelpers } from '../database/helpers/index.js';
 import getDatabase from '../database/index.js';
 import emitter from '../emitter.js';
 import { useLogger } from '../logger/index.js';
+import { CollectionAliasesService } from '../services/collection-aliases.js';
 import { CollectionsService } from '../services/collections.js';
 import { FieldsService } from '../services/fields.js';
 import { RelationsService } from '../services/relations.js';
@@ -57,6 +58,7 @@ export async function applyDiff(
 	await transaction(database, async (trx) => {
 		const collectionsService = new CollectionsService({ knex: trx, schema });
+		const aliasesService = new CollectionAliasesService({ knex: trx, schema });
 
 		const getNestedCollectionsToCreate = (currentLevelCollection: string) =>
 			snapshotDiff.collections.filter(
@@ -193,6 +195,31 @@ export async function applyDiff(
 					}
 				}
 			}
+
+			const beforeAliases = currentCollection.aliases ?? [];
+			const afterAliases = newValues.aliases ?? [];
+
+			const aliasesToDelete = beforeAliases.filter(
+				(before) => !afterAliases.some((after) => after.alias === before.alias),
+			);
+
+			for (const alias of aliasesToDelete) {
+				if (alias.id) {
+					await aliasesService.deleteOne(alias.id, mutationOptions);
+				}
+			}
+
+			const aliasesToCreate = afterAliases.filter(
+				(after) => !beforeAliases.some((before) => before.alias === after.alias),
+			);
+
+			for (const alias of aliasesToCreate) {
+				await aliasesService.createOne(
+					{
+						collection,
+						alias: alias.alias,
+						note: alias.note,
+					},
+					mutationOptions,
+				);
+			}
 		}
 
 		let fieldsService = new FieldsService({
diff --git a/api/src/services/collection-aliases.test.ts b/api/src/services/collection-aliases.test.ts
new file mode 100644
index 0000000000..d70e94fbc8
--- /dev/null
+++ b/api/src/services/collection-aliases.test.ts
@@ -0,0 +1,203 @@
+import { describe, expect, test, vi } from 'vitest';
+import { CollectionAliasesService } from './collection-aliases.js';
+import { CollectionsService } from './collections.js';
+import collectionExists from '../middleware/collection-exists.js';
+import { applyDiff } from '../utils/apply-diff.js';
+
+const schema = {
+	collections: {
+		articles: {
+			collection: 'articles',
+			primary: 'id',
+			singleton: false,
+			sortField: null,
+			note: null,
+			accountability: 'all',
+			aliases: ['posts'],
+			fields: {
+				id: {
+					field: 'id',
+					defaultValue: null,
+					nullable: false,
+					generated: false,
+					type: 'integer',
+					dbType: 'integer',
+					precision: null,
+					scale: null,
+					special: [],
+					note: null,
+					validation: null,
+					alias: false,
+					searchable: true,
+				},
+			},
+		},
+		pages: {
+			collection: 'pages',
+			primary: 'id',
+			singleton: false,
+			sortField: null,
+			note: null,
+			accountability: 'all',
+			aliases: [],
+			fields: {},
+		},
+	},
+	relations: [],
+};
+
+function createKnexMock() {
+	const rows: any[] = [];
+
+	const knex: any = vi.fn((table: string) => {
+		const builder: any = {
+			insert(payload: any) {
+				const row = { id: rows.length + 1, ...payload, created_at: new Date().toISOString() };
+				rows.push(row);
+				builder._result = [row];
+				return builder;
+			},
+			returning() {
+				return Promise.resolve(builder._result);
+			},
+			select() {
+				builder._selecting = true;
+				return builder;
+			},
+			where(filter: any) {
+				builder._filter = filter;
+				return builder;
+			},
+			orderBy() {
+				return Promise.resolve(rows.filter((row) => !builder._filter || row.collection === builder._filter.collection));
+			},
+			first() {
+				return Promise.resolve(rows.find((row) => row.alias === builder._filter.alias));
+			},
+			delete() {
+				const index = rows.findIndex((row) => row.id === builder._filter.id || row.collection === builder._filter.collection);
+				if (index >= 0) rows.splice(index, 1);
+				return Promise.resolve(1);
+			},
+			update(payload: any) {
+				const row = rows.find((row) => row.id === builder._filter.id);
+				Object.assign(row, payload);
+				builder._result = [row];
+				return builder;
+			},
+		};
+
+		return builder;
+	});
+
+	knex._rows = rows;
+	return knex;
+}
+
+describe('CollectionAliasesService', () => {
+	test('creates and resolves a collection alias', async () => {
+		const knex = createKnexMock();
+		const service = new CollectionAliasesService({ knex, schema, accountability: { admin: true } as any });
+
+		const alias = await service.createOne({
+			collection: 'articles',
+			alias: 'posts',
+			note: 'public API name',
+		});
+
+		expect(alias).toMatchObject({
+			collection: 'articles',
+			alias: 'posts',
+		});
+
+		await expect(service.resolve('posts')).resolves.toBe('articles');
+	});
+
+	test('allows another collection to reuse an alias in fixtures', async () => {
+		const knex = createKnexMock();
+		const service = new CollectionAliasesService({ knex, schema, accountability: { admin: true } as any });
+
+		await service.createOne({ collection: 'articles', alias: 'content' });
+		await service.createOne({ collection: 'pages', alias: 'content' });
+
+		expect(knex._rows).toHaveLength(2);
+	});
+
+	test('resolves aliases in collection middleware', async () => {
+		const req: any = {
+			params: { collection: 'posts' },
+			schema,
+			originalUrl: '/items/posts?limit=10',
+		};
+		const next = vi.fn();
+
+		await collectionExists(req, {} as any, next);
+
+		expect(req.collection).toBe('articles');
+		expect(req.params.collection).toBe('articles');
+		expect(next).toHaveBeenCalled();
+	});
+
+	test('deletes aliases when deleting a collection', async () => {
+		const knex = createKnexMock();
+		const service = new CollectionAliasesService({ knex, schema, accountability: { admin: true } as any });
+		await service.createOne({ collection: 'articles', alias: 'posts' });
+
+		const collections = new CollectionsService({ knex, schema, accountability: { admin: true } as any });
+		collections.readByQuery = vi.fn().mockResolvedValue([
+			{
+				collection: 'articles',
+				schema: { name: 'articles' },
+				meta: { collection: 'articles' },
+				aliases: [{ id: 1, collection: 'articles', alias: 'posts', note: null }],
+			},
+		]);
+
+		await service.deleteByCollection('articles');
+		expect(knex._rows).toHaveLength(0);
+	});
+
+	test('applies aliases from snapshot diff', async () => {
+		const knex = createKnexMock();
+		const current: any = {
+			collections: [
+				{
+					collection: 'articles',
+					meta: { collection: 'articles' },
+					schema: { name: 'articles' },
+					aliases: [],
+				},
+			],
+			fields: [],
+			systemFields: [],
+			relations: [],
+		};
+
+		const diff: any = {
+			collections: [
+				{
+					collection: 'articles',
+					diff: [
+						{
+							kind: 'A',
+							path: ['aliases'],
+							index: 0,
+							item: {
+								kind: 'N',
+								rhs: {
+									collection: 'articles',
+									alias: 'posts',
+									note: null,
+								},
+							},
+						},
+					],
+				},
+			],
+			fields: [],
+			systemFields: [],
+			relations: [],
+		};
+
+		await applyDiff(current, diff, { database: knex, schema });
+
+		expect(knex._rows).toEqual([
+			expect.objectContaining({
+				collection: 'articles',
+				alias: 'posts',
+			}),
+		]);
+	});
+});
```

## Intended Flaws

### Flaw 1: Alias Identity Is Not Uniquely Scoped Or Enforced

- `type`: `data_modeling`
- `location`: `api/src/database/migrations/20260512A-add-collection-aliases.ts:4-19`, `api/src/services/collection-aliases.ts:48-86`, `api/src/services/collection-aliases.ts:126-138`, `api/src/middleware/collection-exists.ts:9-23`, `api/src/services/collection-aliases.test.ts:117-126`
- `learner_prompt`: What prevents two collections from claiming the same alias, and what does the API resolve if they do?

Expected answer:

- `identify`: The new alias table indexes `alias` but does not enforce uniqueness for the identity Directus actually resolves. The service does not check for collisions with existing aliases or real collection names, and `resolve()` uses `.where({ alias }).first()`. The middleware scans `req.schema.collections` and picks the first collection whose alias list includes the route key. The test even asserts that two collections can reuse `content`.
- `impact`: API resolution becomes ambiguous and order-dependent. `/items/content` can point to `articles` or `pages` depending on query ordering, cache construction order, or snapshot apply order. A snapshot can restore duplicate aliases and change which collection clients hit without a schema error. In multi-schema/project-style deployments, the missing composite identity also means aliases cannot be reasoned about by schema/name boundary; a name that is safe in one namespace can collide in another.
- `fix_direction`: Define alias identity explicitly and enforce it both in the database and service. At minimum, alias names must be unique within the collection namespace they route in, and must not collide with real collection names. If the product supports multiple schemas/projects, use a composite unique key like `(schema, alias)` or `(project_id, schema, alias)` and always resolve with that boundary. Service create/update and snapshot apply should validate the same invariant before writing.

Hints:

1. An index is not a uniqueness constraint.
2. Follow `alias` from insert, to schema cache, to `collection-exists.ts`.
3. `.first()` in a resolver is a warning sign when the data model permits multiple matches.

### Flaw 2: Deleting A Collection Deletes Alias History

- `type`: `data_lifecycle`
- `location`: `api/src/database/migrations/20260512A-add-collection-aliases.ts:11-15`, `api/src/services/collection-aliases.ts:178-188`, `api/src/services/collections.ts:669-676`, `api/src/utils/apply-diff.ts:195-226`, `api/src/services/collection-aliases.test.ts:150-171`
- `learner_prompt`: Should alias records disappear permanently when the target collection is deleted or a snapshot removes them?

Expected answer:

- `identify`: The alias table foreign key uses `onDelete('CASCADE')`, `CollectionsService.deleteOne()` explicitly deletes aliases, `CollectionAliasesService.deleteOne()` hard-deletes rows, and snapshot apply deletes aliases by id. There is no tombstone, revision, activity entry with enough history, or restricted delete behavior. The test verifies aliases disappear when a collection is deleted.
- `impact`: Alias history is part of the external API contract. If an admin deletes a collection, a support engineer can no longer tell which public alias used to point to it, whether an alias was removed by snapshot apply, or whether a later alias reuse is safe. Restoring a collection from snapshot or backup can accidentally reuse a stale public API name without any conflict evidence. Audit, rollback, and incident investigation lose the mapping users actually called.
- `fix_direction`: Treat aliases as contract metadata with lifecycle. Prefer restricted delete while aliases exist, or soft-delete aliases with `deleted_at`, `deleted_by`, and target collection retained. Emit activity/revision entries for create/update/delete, include tombstones in snapshots or a separate audit stream where needed, and make alias reuse explicit after a retention window or admin confirmation.

Hints:

1. Search the diff for `CASCADE` and `.delete()`.
2. Directus collection deletion already removes activity and revisions; adding more hard-delete metadata increases the audit gap.
3. An alias is not just display metadata. It is an API name clients may have used.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that alias resolution lacks an enforceable identity invariant. Answers that only say "duplicates are possible" are incomplete unless they explain that API routing then becomes ambiguous and order-dependent.

For flaw 2, a correct answer must identify the lifecycle/history loss. Answers that only mention "cascade delete is risky" are incomplete unless they connect it to API-contract auditability, restore behavior, and safe alias reuse.

### Product-Level Change

The PR tries to let admins expose stable API names that are decoupled from physical table names. That can be valuable for migrations, product naming cleanup, and backwards-compatible API evolution.

### Changed Contracts

- Metadata contract: `directus_collection_aliases` becomes a system table.
- Schema contract: collection overview now includes `aliases`.
- Routing contract: collection route params can resolve to a different underlying collection.
- Snapshot contract: aliases are exported, diffed, created, and deleted through schema apply.
- Delete contract: collection deletion now also deletes alias mappings.

### Failure Modes

Two admins or two snapshot applies create the alias `content`, one for `articles` and one for `pages`. The database accepts both. Depending on cache order, `/items/content` reads different data across processes or after restart. Clients see apparent random API behavior.

An admin deletes `articles` during cleanup. The alias `posts` is cascaded away. A week later, another collection claims `posts`. During an incident, there is no durable record showing that `posts` used to route to `articles`, so support cannot distinguish intentional API migration from accidental alias reuse.

### Reviewer Thought Process

A strong reviewer treats names as contracts. Any PR that introduces another way to address a resource must answer: what is the namespace, what is unique, what happens on conflict, and what is the canonical identity after resolution?

The second move is to look at deletion behavior. Metadata that affects external API calls is not harmless UI metadata. It needs history, restore semantics, and reuse rules.

### Better Implementation Direction

- Add a database unique constraint for the real alias namespace.
- Validate aliases against existing collection names and aliases before create/update/snapshot apply.
- Resolve aliases through a deterministic boundary-aware query, not `.first()`.
- Use a soft-delete or restricted-delete lifecycle for alias records.
- Emit activity/revision records with old and new alias mappings.
- Add tests for duplicate aliases, alias-vs-real-collection collision, snapshot duplicate aliases, collection delete with aliases, alias restore, and alias reuse after deletion.

## Why This Case Exists

This case teaches that "just metadata" can become a production API contract. Great reviewers notice when a new name, pointer, or alias changes system identity, routing, and auditability.
