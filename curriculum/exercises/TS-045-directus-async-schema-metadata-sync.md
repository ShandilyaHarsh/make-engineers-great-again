# TS-045: Directus Async Schema Metadata Sync

## Metadata

- `id`: TS-045
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: schema snapshots, metadata tables, schema apply/diff, background schedules, migration safety, schema cache invalidation
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,550-1,900
- `represented_diff_lines`: 1893
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Directus schema snapshots, metadata merge semantics, migration ordering, schema caches, background workers, and deployment tradeoffs without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds an async schema metadata sync feature. The goal is to let a Directus instance accept a remote schema snapshot and reconcile collection, field, and relation metadata in the background instead of making the schema API request wait for the full apply operation.

Today Directus can snapshot the schema, diff a snapshot, and apply a diff synchronously. This PR adds a lighter-weight metadata-only flow for multi-instance deployments where labels, display templates, field options, and relation metadata are promoted from an authoritative environment into a target environment.

The PR adds:

- a `directus_schema_metadata_syncs` table for queued sync jobs,
- a metadata-only sync plan builder,
- a schedule that processes queued sync jobs,
- a `POST /schema/metadata-sync` endpoint,
- schema cache flushing after every sync section,
- tests for async processing, remote-wins conflict behavior, and migration overlap,
- docs for operating metadata sync.

The intended product behavior is: schema metadata can be promoted asynchronously without losing local administrator edits and without exposing API consumers to a half-synced schema while migrations or schema applies are in progress.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `api/src/utils/get-snapshot.ts` builds snapshots from collections, fields, relations, and system fields using `getSchema({ bypassCache: true })`. Snapshot/apply intentionally reads the latest database-backed schema instead of trusting memory cache.
- `api/src/services/schema.ts` applies schema diffs only after admin access and snapshot-hash validation. `SchemaService.apply(...)` calls `validateApplyDiff(...)`, then `applyDiff(...)`.
- `api/src/utils/validate-diff.ts` rejects stale apply requests when the supplied hash does not match the current versioned snapshot hash unless the caller explicitly forces the apply. That hash is the current concurrency contract.
- `api/src/utils/apply-diff.ts` applies collection, field, system-field, and relation changes inside a transaction, coordinates pre/post column change hooks, suppresses nested action events until a fresh schema is available, and flushes caches once after the apply.
- `api/src/services/collections.ts`, `api/src/services/fields.ts`, and `api/src/services/relations.ts` update metadata rows through item services and clear schema/system caches when called directly.
- Field metadata includes option paths such as `orders.status.options`; those queued values can conflict with later admin edits.
- `api/src/utils/get-schema.ts` uses a shared lock while preparing cached schema and supports `bypassCache` for callers that need a fresh database view.
- `api/src/database/migrations/run.ts` mutates schema and flushes caches after migrations. `api/src/database/index.ts` can detect outstanding migrations with `validateMigrations()`, and `api/src/app.ts` warns when migrations have not all run.
- `api/src/lock/lib/use-lock.ts` provides the shared Redis/local KV lock used by schedules and cross-process coordination.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the async sync preserves concurrent metadata edits and whether it respects Directus' existing schema apply/migration boundaries.

## Review Surface

Changed files in the synthetic PR:

- `api/src/database/migrations/20260516A-add-schema-metadata-sync.ts`
- `api/src/types/schema-metadata-sync.ts`
- `api/src/services/schema-metadata-sync/store.ts`
- `api/src/services/schema-metadata-sync/schema-metadata-sync-service.ts`
- `api/src/services/schema-metadata-sync/schema-metadata-sync-queue.ts`
- `api/src/services/schema-metadata-sync/index.ts`
- `api/src/controllers/schema.ts`
- `api/src/app.ts`
- `api/src/services/schema-metadata-sync/schema-metadata-sync-service.test.ts`
- `api/src/services/schema-metadata-sync/schema-metadata-sync-queue.test.ts`
- `docs/guides/schema-metadata-sync.md`

The line references below use synthetic PR line numbers. The represented diff is focused on async snapshot contracts, stale-baseline detection, merge behavior, background schedule locking, migration overlap, cache flushing, and tests that normalize unsafe behavior.

## Diff

```diff
diff --git a/api/src/database/migrations/20260516A-add-schema-metadata-sync.ts b/api/src/database/migrations/20260516A-add-schema-metadata-sync.ts
new file mode 100644
index 0000000000..4aa7b93ae1
--- /dev/null
+++ b/api/src/database/migrations/20260516A-add-schema-metadata-sync.ts
@@ -0,0 +1,86 @@
+import type { Knex } from 'knex';
+
+const table = 'directus_schema_metadata_syncs';
+
+export async function up(knex: Knex): Promise<void> {
+	await knex.schema.createTable(table, (t) => {
+		t.uuid('id').primary();
+		t.string('source').notNullable();
+		t.string('status').notNullable().defaultTo('queued');
+		t.string('base_hash').nullable();
+		t.string('remote_hash').nullable();
+		t.string('actor').nullable();
+		t.integer('collection_count').notNullable().defaultTo(0);
+		t.integer('field_count').notNullable().defaultTo(0);
+		t.integer('relation_count').notNullable().defaultTo(0);
+		t.integer('attempts').notNullable().defaultTo(0);
+		t.integer('max_attempts').notNullable().defaultTo(3);
+		t.json('snapshot').notNullable();
+		t.json('plan').nullable();
+		t.json('summary').nullable();
+		t.text('error').nullable();
+		t.timestamp('queued_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
+		t.timestamp('started_at', { useTz: true }).nullable();
+		t.timestamp('completed_at', { useTz: true }).nullable();
+		t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
+		t.index(['status', 'queued_at'], 'directus_schema_metadata_syncs_status_queued_idx');
+		t.index(['source', 'status'], 'directus_schema_metadata_syncs_source_status_idx');
+	});
+
+	await knex.schema.alterTable('directus_collections', (t) => {
+		t.timestamp('metadata_synced_at', { useTz: true }).nullable();
+		t.string('metadata_sync_source').nullable();
+	});
+
+	await knex.schema.alterTable('directus_fields', (t) => {
+		t.timestamp('metadata_synced_at', { useTz: true }).nullable();
+		t.string('metadata_sync_source').nullable();
+	});
+
+	await knex.schema.alterTable('directus_relations', (t) => {
+		t.timestamp('metadata_synced_at', { useTz: true }).nullable();
+		t.string('metadata_sync_source').nullable();
+	});
+}
+
+export async function down(knex: Knex): Promise<void> {
+	const hasCollectionsSyncedAt = await knex.schema.hasColumn('directus_collections', 'metadata_synced_at');
+	const hasCollectionsSource = await knex.schema.hasColumn('directus_collections', 'metadata_sync_source');
+	const hasFieldsSyncedAt = await knex.schema.hasColumn('directus_fields', 'metadata_synced_at');
+	const hasFieldsSource = await knex.schema.hasColumn('directus_fields', 'metadata_sync_source');
+	const hasRelationsSyncedAt = await knex.schema.hasColumn('directus_relations', 'metadata_synced_at');
+	const hasRelationsSource = await knex.schema.hasColumn('directus_relations', 'metadata_sync_source');
+
+	if (hasCollectionsSyncedAt || hasCollectionsSource) {
+		await knex.schema.alterTable('directus_collections', (t) => {
+			if (hasCollectionsSyncedAt) {
+				t.dropColumn('metadata_synced_at');
+			}
+
+			if (hasCollectionsSource) {
+				t.dropColumn('metadata_sync_source');
+			}
+		});
+	}
+
+	if (hasFieldsSyncedAt || hasFieldsSource) {
+		await knex.schema.alterTable('directus_fields', (t) => {
+			if (hasFieldsSyncedAt) {
+				t.dropColumn('metadata_synced_at');
+			}
+
+			if (hasFieldsSource) {
+				t.dropColumn('metadata_sync_source');
+			}
+		});
+	}
+
+	if (hasRelationsSyncedAt || hasRelationsSource) {
+		await knex.schema.alterTable('directus_relations', (t) => {
+			if (hasRelationsSyncedAt) {
+				t.dropColumn('metadata_synced_at');
+			}
+
+			if (hasRelationsSource) {
+				t.dropColumn('metadata_sync_source');
+			}
+		});
+	}
+
+	await knex.schema.dropTableIfExists(table);
+}
diff --git a/api/src/types/schema-metadata-sync.ts b/api/src/types/schema-metadata-sync.ts
new file mode 100644
index 0000000000..be838a691b
--- /dev/null
+++ b/api/src/types/schema-metadata-sync.ts
@@ -0,0 +1,164 @@
+import type { Snapshot } from '@directus/types';
+
+export const SCHEMA_METADATA_SYNC_TABLE = 'directus_schema_metadata_syncs';
+
+export type SchemaMetadataSyncStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
+
+export type SchemaMetadataSyncMode = 'remote-wins' | 'local-wins' | 'merge';
+
+export interface SchemaMetadataSyncRequest {
+	source: string;
+	baseHash?: string | null;
+	remoteHash?: string | null;
+	snapshot: Snapshot;
+	mode?: SchemaMetadataSyncMode;
+	actor?: string | null;
+	dryRun?: boolean;
+}
+
+export interface SchemaMetadataSyncRow {
+	id: string;
+	source: string;
+	status: SchemaMetadataSyncStatus;
+	base_hash: string | null;
+	remote_hash: string | null;
+	actor: string | null;
+	collection_count: number;
+	field_count: number;
+	relation_count: number;
+	attempts: number;
+	max_attempts: number;
+	snapshot: Snapshot;
+	plan: SchemaMetadataSyncPlan | null;
+	summary: SchemaMetadataSyncSummary | null;
+	error: string | null;
+	queued_at: Date;
+	started_at: Date | null;
+	completed_at: Date | null;
+	updated_at: Date;
+}
+
+export interface SchemaMetadataSyncJob {
+	id: string;
+	source: string;
+	baseHash: string | null;
+	remoteHash: string | null;
+	snapshot: Snapshot;
+	mode: SchemaMetadataSyncMode;
+	actor: string | null;
+	dryRun: boolean;
+}
+
+export interface SchemaMetadataSyncPlan {
+	source: string;
+	mode: SchemaMetadataSyncMode;
+	baseHash: string | null;
+	remoteHash: string | null;
+	collections: CollectionMetadataPatch[];
+	fields: FieldMetadataPatch[];
+	relations: RelationMetadataPatch[];
+	warnings: string[];
+}
+
+export interface CollectionMetadataPatch {
+	collection: string;
+	meta: Record<string, unknown>;
+	existsLocally: boolean;
+	action: 'update' | 'skip';
+	reason?: string;
+}
+
+export interface FieldMetadataPatch {
+	collection: string;
+	field: string;
+	meta: Record<string, unknown>;
+	existsLocally: boolean;
+	action: 'update' | 'skip';
+	reason?: string;
+}
+
+export interface RelationMetadataPatch {
+	collection: string;
+	field: string;
+	related_collection: string | null;
+	meta: Record<string, unknown>;
+	existsLocally: boolean;
+	action: 'update' | 'skip';
+	reason?: string;
+}
+
+export interface SchemaMetadataSyncSummary {
+	id: string;
+	source: string;
+	status: SchemaMetadataSyncStatus;
+	collectionUpdates: number;
+	fieldUpdates: number;
+	relationUpdates: number;
+	skippedCollections: number;
+	skippedFields: number;
+	skippedRelations: number;
+	warnings: string[];
+	startedAt: string | null;
+	completedAt: string | null;
+}
+
+export interface SyncCounts {
+	collections: number;
+	fields: number;
+	relations: number;
+}
+
+export interface ApplySectionResult {
+	updated: number;
+	skipped: number;
+	warnings: string[];
+}
+
+export interface SyncLogger {
+	debug(message: string, metadata?: Record<string, unknown>): void;
+	info(message: string, metadata?: Record<string, unknown>): void;
+	warn(message: string, metadata?: Record<string, unknown>): void;
+	error(error: unknown, message?: string, metadata?: Record<string, unknown>): void;
+}
+
+export function emptyPlan(source: string, mode: SchemaMetadataSyncMode): SchemaMetadataSyncPlan {
+	return {
+		source,
+		mode,
+		baseHash: null,
+		remoteHash: null,
+		collections: [],
+		fields: [],
+		relations: [],
+		warnings: [],
+	};
+}
+
+export function countPlan(plan: SchemaMetadataSyncPlan): SyncCounts {
+	return {
+		collections: plan.collections.filter((item) => item.action === 'update').length,
+		fields: plan.fields.filter((item) => item.action === 'update').length,
+		relations: plan.relations.filter((item) => item.action === 'update').length,
+	};
+}
+
+export function toSummary(
+	row: SchemaMetadataSyncRow,
+	plan: SchemaMetadataSyncPlan,
+	status: SchemaMetadataSyncStatus,
+): SchemaMetadataSyncSummary {
+	return {
+		id: row.id,
+		source: row.source,
+		status,
+		collectionUpdates: plan.collections.filter((item) => item.action === 'update').length,
+		fieldUpdates: plan.fields.filter((item) => item.action === 'update').length,
+		relationUpdates: plan.relations.filter((item) => item.action === 'update').length,
+		skippedCollections: plan.collections.filter((item) => item.action === 'skip').length,
+		skippedFields: plan.fields.filter((item) => item.action === 'skip').length,
+		skippedRelations: plan.relations.filter((item) => item.action === 'skip').length,
+		warnings: plan.warnings,
+		startedAt: row.started_at?.toISOString() ?? null,
+		completedAt: row.completed_at?.toISOString() ?? null,
+	};
+}
+
+export function metadataOnly<T extends { meta?: Record<string, unknown> | null }>(item: T): Record<string, unknown> {
+	if (!item.meta) {
+		return {};
+	}
+
+	const { id, collection, field, many_collection, many_field, one_collection, ...meta } = item.meta as any;
+	return meta;
+}
diff --git a/api/src/services/schema-metadata-sync/store.ts b/api/src/services/schema-metadata-sync/store.ts
new file mode 100644
index 0000000000..8d0e284a48
--- /dev/null
+++ b/api/src/services/schema-metadata-sync/store.ts
@@ -0,0 +1,190 @@
+import { randomUUID } from 'node:crypto';
+import type { Knex } from 'knex';
+import getDatabase from '../../database/index.js';
+import type {
+	SchemaMetadataSyncJob,
+	SchemaMetadataSyncPlan,
+	SchemaMetadataSyncRequest,
+	SchemaMetadataSyncRow,
+	SchemaMetadataSyncStatus,
+	SchemaMetadataSyncSummary,
+	SyncCounts,
+} from '../../types/schema-metadata-sync.js';
+import { SCHEMA_METADATA_SYNC_TABLE, countPlan } from '../../types/schema-metadata-sync.js';
+
+export class SchemaMetadataSyncStore {
+	knex: Knex;
+
+	constructor(options?: { knex?: Knex }) {
+		this.knex = options?.knex ?? getDatabase();
+	}
+
+	async create(request: SchemaMetadataSyncRequest): Promise<SchemaMetadataSyncRow> {
+		const id = randomUUID();
+		const counts = this.countSnapshot(request.snapshot);
+		const now = new Date();
+
+		const row = {
+			id,
+			source: request.source,
+			status: 'queued',
+			base_hash: request.baseHash ?? null,
+			remote_hash: request.remoteHash ?? null,
+			actor: request.actor ?? null,
+			collection_count: counts.collections,
+			field_count: counts.fields,
+			relation_count: counts.relations,
+			attempts: 0,
+			max_attempts: 3,
+			snapshot: JSON.stringify(request.snapshot),
+			plan: null,
+			summary: null,
+			error: null,
+			queued_at: now,
+			started_at: null,
+			completed_at: null,
+			updated_at: now,
+		};
+
+		await this.knex(SCHEMA_METADATA_SYNC_TABLE).insert(row);
+
+		return this.findById(id) as Promise<SchemaMetadataSyncRow>;
+	}
+
+	async findById(id: string): Promise<SchemaMetadataSyncRow | null> {
+		const row = await this.knex(SCHEMA_METADATA_SYNC_TABLE).where({ id }).first();
+
+		if (!row) {
+			return null;
+		}
+
+		return this.deserialize(row);
+	}
+
+	async findNextQueued(): Promise<SchemaMetadataSyncRow | null> {
+		const row = await this.knex(SCHEMA_METADATA_SYNC_TABLE)
+			.where({ status: 'queued' })
+			.orderBy('queued_at', 'asc')
+			.first();
+
+		if (!row) {
+			return null;
+		}
+
+		return this.deserialize(row);
+	}
+
+	async listRecent(limit = 50): Promise<SchemaMetadataSyncRow[]> {
+		const rows = await this.knex(SCHEMA_METADATA_SYNC_TABLE)
+			.orderBy('queued_at', 'desc')
+			.limit(limit);
+
+		return rows.map((row) => this.deserialize(row));
+	}
+
+	async markRunning(id: string): Promise<SchemaMetadataSyncRow> {
+		const now = new Date();
+
+		await this.knex(SCHEMA_METADATA_SYNC_TABLE)
+			.where({ id })
+			.update({
+				status: 'running',
+				started_at: now,
+				attempts: this.knex.raw('attempts + 1'),
+				updated_at: now,
+			});
+
+		return this.findById(id) as Promise<SchemaMetadataSyncRow>;
+	}
+
+	async savePlan(id: string, plan: SchemaMetadataSyncPlan): Promise<void> {
+		const counts = countPlan(plan);
+
+		await this.knex(SCHEMA_METADATA_SYNC_TABLE)
+			.where({ id })
+			.update({
+				plan: JSON.stringify(plan),
+				collection_count: counts.collections,
+				field_count: counts.fields,
+				relation_count: counts.relations,
+				updated_at: new Date(),
+			});
+	}
+
+	async markCompleted(id: string, summary: SchemaMetadataSyncSummary): Promise<SchemaMetadataSyncRow> {
+		const now = new Date();
+
+		await this.knex(SCHEMA_METADATA_SYNC_TABLE)
+			.where({ id })
+			.update({
+				status: 'completed',
+				summary: JSON.stringify(summary),
+				error: null,
+				completed_at: now,
+				updated_at: now,
+			});
+
+		return this.findById(id) as Promise<SchemaMetadataSyncRow>;
+	}
+
+	async markSkipped(id: string, summary: SchemaMetadataSyncSummary): Promise<SchemaMetadataSyncRow> {
+		const now = new Date();
+
+		await this.knex(SCHEMA_METADATA_SYNC_TABLE)
+			.where({ id })
+			.update({
+				status: 'skipped',
+				summary: JSON.stringify(summary),
+				error: null,
+				completed_at: now,
+				updated_at: now,
+			});
+
+		return this.findById(id) as Promise<SchemaMetadataSyncRow>;
+	}
+
+	async markFailed(id: string, error: unknown): Promise<SchemaMetadataSyncRow> {
+		const row = await this.findById(id);
+		const attempts = row?.attempts ?? 0;
+		const maxAttempts = row?.max_attempts ?? 3;
+		const retry = attempts < maxAttempts;
+		const message = error instanceof Error ? error.message : String(error);
+
+		await this.knex(SCHEMA_METADATA_SYNC_TABLE)
+			.where({ id })
+			.update({
+				status: retry ? 'queued' : 'failed',
+				error: message,
+				updated_at: new Date(),
+			});
+
+		return this.findById(id) as Promise<SchemaMetadataSyncRow>;
+	}
+
+	toJob(row: SchemaMetadataSyncRow): SchemaMetadataSyncJob {
+		return {
+			id: row.id,
+			source: row.source,
+			baseHash: row.base_hash,
+			remoteHash: row.remote_hash,
+			snapshot: row.snapshot,
+			mode: 'remote-wins',
+			actor: row.actor,
+			dryRun: false,
+		};
+	}
+
+	private countSnapshot(snapshot: any): SyncCounts {
+		return {
+			collections: Array.isArray(snapshot.collections) ? snapshot.collections.length : 0,
+			fields: Array.isArray(snapshot.fields) ? snapshot.fields.length : 0,
+			relations: Array.isArray(snapshot.relations) ? snapshot.relations.length : 0,
+		};
+	}
+
+	private deserialize(row: any): SchemaMetadataSyncRow {
+		return {
+			...row,
+			snapshot: typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot,
+			plan: row.plan ? (typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan) : null,
+			summary: row.summary ? (typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary) : null,
+		};
+	}
+}
diff --git a/api/src/services/schema-metadata-sync/schema-metadata-sync-service.ts b/api/src/services/schema-metadata-sync/schema-metadata-sync-service.ts
new file mode 100644
index 0000000000..0bb0a108bb
--- /dev/null
+++ b/api/src/services/schema-metadata-sync/schema-metadata-sync-service.ts
@@ -0,0 +1,438 @@
+import type { Accountability, Snapshot } from '@directus/types';
+import type { Knex } from 'knex';
+import getDatabase from '../../database/index.js';
+import { useLogger } from '../../logger/index.js';
+import { CollectionsService } from '../collections.js';
+import { FieldsService } from '../fields.js';
+import { RelationsService } from '../relations.js';
+import { clearSystemCache, flushCaches } from '../../cache.js';
+import { getSnapshot } from '../../utils/get-snapshot.js';
+import { getVersionedHash } from '../../utils/get-versioned-hash.js';
+import { getSchema } from '../../utils/get-schema.js';
+import type {
+	ApplySectionResult,
+	CollectionMetadataPatch,
+	FieldMetadataPatch,
+	RelationMetadataPatch,
+	SchemaMetadataSyncJob,
+	SchemaMetadataSyncPlan,
+	SchemaMetadataSyncRequest,
+	SchemaMetadataSyncRow,
+	SchemaMetadataSyncSummary,
+} from '../../types/schema-metadata-sync.js';
+import { metadataOnly, toSummary } from '../../types/schema-metadata-sync.js';
+import { SchemaMetadataSyncStore } from './store.js';
+
+export interface SchemaMetadataSyncServiceOptions {
+	knex?: Knex;
+	accountability?: Accountability | null;
+	store?: SchemaMetadataSyncStore;
+}
+
+export class SchemaMetadataSyncService {
+	knex: Knex;
+	accountability: Accountability | null;
+	store: SchemaMetadataSyncStore;
+	logger = useLogger();
+
+	constructor(options?: SchemaMetadataSyncServiceOptions) {
+		this.knex = options?.knex ?? getDatabase();
+		this.accountability = options?.accountability ?? null;
+		this.store = options?.store ?? new SchemaMetadataSyncStore({ knex: this.knex });
+	}
+
+	async enqueue(request: SchemaMetadataSyncRequest): Promise<SchemaMetadataSyncSummary> {
+		this.assertAdmin();
+
+		const row = await this.store.create({
+			...request,
+			mode: request.mode ?? 'remote-wins',
+		});
+
+		return {
+			id: row.id,
+			source: row.source,
+			status: row.status,
+			collectionUpdates: row.collection_count,
+			fieldUpdates: row.field_count,
+			relationUpdates: row.relation_count,
+			skippedCollections: 0,
+			skippedFields: 0,
+			skippedRelations: 0,
+			warnings: [],
+			startedAt: null,
+			completedAt: null,
+		};
+	}
+
+	async runNext(): Promise<SchemaMetadataSyncSummary | null> {
+		const queued = await this.store.findNextQueued();
+
+		if (!queued) {
+			return null;
+		}
+
+		return this.runRow(queued);
+	}
+
+	async runRow(row: SchemaMetadataSyncRow): Promise<SchemaMetadataSyncSummary> {
+		const running = await this.store.markRunning(row.id);
+		const job = this.store.toJob(running);
+
+		try {
+			const currentSnapshot = await getSnapshot({ database: this.knex });
+			const currentHash = await getVersionedHash(currentSnapshot);
+
+			this.logger.debug('Preparing schema metadata sync plan', {
+				sync: job.id,
+				source: job.source,
+				baseHash: job.baseHash,
+				currentHash,
+				remoteHash: job.remoteHash,
+			});
+
+			// Metadata sync is intentionally remote-wins. The hash is logged for audit, but
+			// the queued job still applies even when local administrators edited metadata
+			// between enqueue time and worker execution.
+			const plan = await this.buildPlan(job, currentSnapshot);
+			await this.store.savePlan(job.id, plan);
+
+			if (job.dryRun) {
+				const summary = toSummary(running, plan, 'skipped');
+				return (await this.store.markSkipped(job.id, summary)).summary!;
+			}
+
+			await this.applyPlan(plan);
+
+			const completedRow = await this.store.findById(job.id);
+			const summary = toSummary(completedRow ?? running, plan, 'completed');
+			return (await this.store.markCompleted(job.id, summary)).summary!;
+		} catch (error) {
+			this.logger.error(error, 'Schema metadata sync failed', { sync: job.id });
+			const failed = await this.store.markFailed(job.id, error);
+			const plan = failed.plan ?? {
+				source: job.source,
+				mode: job.mode,
+				baseHash: job.baseHash,
+				remoteHash: job.remoteHash,
+				collections: [],
+				fields: [],
+				relations: [],
+				warnings: [failed.error ?? 'Sync failed'],
+			};
+			return toSummary(failed, plan, failed.status);
+		}
+	}
+
+	async buildPlan(job: SchemaMetadataSyncJob, currentSnapshot: Snapshot): Promise<SchemaMetadataSyncPlan> {
+		const plan: SchemaMetadataSyncPlan = {
+			source: job.source,
+			mode: 'remote-wins',
+			baseHash: job.baseHash,
+			remoteHash: job.remoteHash,
+			collections: [],
+			fields: [],
+			relations: [],
+			warnings: [],
+		};
+
+		const currentCollections = new Map(
+			currentSnapshot.collections.map((collection) => [collection.collection, collection]),
+		);
+
+		const currentFields = new Map(
+			currentSnapshot.fields.map((field) => [`${field.collection}.${field.field}`, field]),
+		);
+
+		const currentRelations = new Map(
+			currentSnapshot.relations.map((relation) => [`${relation.collection}.${relation.field}`, relation]),
+		);
+
+		for (const remoteCollection of job.snapshot.collections) {
+			const collection = remoteCollection.collection;
+			const currentCollection = currentCollections.get(collection);
+
+			if (!currentCollection) {
+				plan.collections.push({
+					collection,
+					meta: metadataOnly(remoteCollection),
+					existsLocally: false,
+					action: 'skip',
+					reason: 'collection_missing_locally',
+				});
+				continue;
+			}
+
+			const meta = {
+				...metadataOnly(remoteCollection),
+				metadata_synced_at: new Date().toISOString(),
+				metadata_sync_source: job.source,
+			};
+
+			plan.collections.push({
+				collection,
+				meta,
+				existsLocally: true,
+				action: 'update',
+			});
+		}
+
+		for (const remoteField of job.snapshot.fields) {
+			const key = `${remoteField.collection}.${remoteField.field}`;
+			const currentField = currentFields.get(key);
+
+			if (!currentField) {
+				plan.fields.push({
+					collection: remoteField.collection,
+					field: remoteField.field,
+					meta: metadataOnly(remoteField),
+					existsLocally: false,
+					action: 'skip',
+					reason: 'field_missing_locally',
+				});
+				continue;
+			}
+
+			const meta = {
+				...metadataOnly(remoteField),
+				metadata_synced_at: new Date().toISOString(),
+				metadata_sync_source: job.source,
+			};
+
+			plan.fields.push({
+				collection: remoteField.collection,
+				field: remoteField.field,
+				meta,
+				existsLocally: true,
+				action: 'update',
+			});
+		}
+
+		for (const remoteRelation of job.snapshot.relations) {
+			const key = `${remoteRelation.collection}.${remoteRelation.field}`;
+			const currentRelation = currentRelations.get(key);
+
+			if (!currentRelation) {
+				plan.relations.push({
+					collection: remoteRelation.collection,
+					field: remoteRelation.field,
+					related_collection: remoteRelation.related_collection ?? null,
+					meta: metadataOnly(remoteRelation),
+					existsLocally: false,
+					action: 'skip',
+					reason: 'relation_missing_locally',
+				});
+				continue;
+			}
+
+			const meta = {
+				...metadataOnly(remoteRelation),
+				metadata_synced_at: new Date().toISOString(),
+				metadata_sync_source: job.source,
+			};
+
+			plan.relations.push({
+				collection: remoteRelation.collection,
+				field: remoteRelation.field,
+				related_collection: remoteRelation.related_collection ?? null,
+				meta,
+				existsLocally: true,
+				action: 'update',
+			});
+		}
+
+		plan.warnings.push(
+			`Remote metadata from ${job.source} wins over target metadata when the same collection, field, or relation exists locally.`,
+		);
+
+		if (job.baseHash && job.baseHash !== job.remoteHash) {
+			plan.warnings.push('The queued snapshot was generated from an earlier base hash, but async sync applies it anyway.');
+		}
+
+		return plan;
+	}
+
+	async applyPlan(plan: SchemaMetadataSyncPlan): Promise<SchemaMetadataSyncSummary> {
+		const schema = await getSchema({ database: this.knex });
+		const collectionsService = new CollectionsService({
+			knex: this.knex,
+			accountability: this.accountability ?? { admin: true },
+			schema,
+		});
+		const fieldsService = new FieldsService({
+			knex: this.knex,
+			accountability: this.accountability ?? { admin: true },
+			schema,
+		});
+		const relationsService = new RelationsService({
+			knex: this.knex,
+			accountability: this.accountability ?? { admin: true },
+			schema,
+		});
+
+		const collectionResult = await this.applyCollections(plan, collectionsService);
+		await clearSystemCache();
+		await this.markSectionVisible('collections', collectionResult.updated);
+
+		const fieldResult = await this.applyFields(plan, fieldsService);
+		await clearSystemCache();
+		await this.markSectionVisible('fields', fieldResult.updated);
+
+		const relationResult = await this.applyRelations(plan, relationsService);
+		await clearSystemCache();
+		await this.markSectionVisible('relations', relationResult.updated);
+
+		await flushCaches();
+
+		return {
+			id: 'inline',
+			source: plan.source,
+			status: 'completed',
+			collectionUpdates: collectionResult.updated,
+			fieldUpdates: fieldResult.updated,
+			relationUpdates: relationResult.updated,
+			skippedCollections: collectionResult.skipped,
+			skippedFields: fieldResult.skipped,
+			skippedRelations: relationResult.skipped,
+			warnings: [...collectionResult.warnings, ...fieldResult.warnings, ...relationResult.warnings, ...plan.warnings],
+			startedAt: null,
+			completedAt: new Date().toISOString(),
+		};
+	}
+
+	private async applyCollections(
+		plan: SchemaMetadataSyncPlan,
+		service: CollectionsService,
+	): Promise<ApplySectionResult> {
+		let updated = 0;
+		let skipped = 0;
+		const warnings: string[] = [];
+
+		for (const patch of plan.collections) {
+			if (patch.action === 'skip') {
+				skipped++;
+				warnings.push(`Skipped collection ${patch.collection}: ${patch.reason}`);
+				continue;
+			}
+
+			await this.applyCollection(patch, service);
+			updated++;
+		}
+
+		return { updated, skipped, warnings };
+	}
+
+	private async applyFields(plan: SchemaMetadataSyncPlan, service: FieldsService): Promise<ApplySectionResult> {
+		let updated = 0;
+		let skipped = 0;
+		const warnings: string[] = [];
+
+		for (const patch of plan.fields) {
+			if (patch.action === 'skip') {
+				skipped++;
+				warnings.push(`Skipped field ${patch.collection}.${patch.field}: ${patch.reason}`);
+				continue;
+			}
+
+			await this.applyField(patch, service);
+			updated++;
+		}
+
+		return { updated, skipped, warnings };
+	}
+
+	private async applyRelations(plan: SchemaMetadataSyncPlan, service: RelationsService): Promise<ApplySectionResult> {
+		let updated = 0;
+		let skipped = 0;
+		const warnings: string[] = [];
+
+		for (const patch of plan.relations) {
+			if (patch.action === 'skip') {
+				skipped++;
+				warnings.push(`Skipped relation ${patch.collection}.${patch.field}: ${patch.reason}`);
+				continue;
+			}
+
+			await this.applyRelation(patch, service);
+			updated++;
+		}
+
+		return { updated, skipped, warnings };
+	}
+
+	private async applyCollection(patch: CollectionMetadataPatch, service: CollectionsService): Promise<void> {
+		await service.updateOne(
+			patch.collection,
+			{
+				collection: patch.collection,
+				meta: patch.meta as any,
+			},
+			{
+				emitEvents: false,
+				autoPurgeSystemCache: false,
+			},
+		);
+	}
+
+	private async applyField(patch: FieldMetadataPatch, service: FieldsService): Promise<void> {
+		await service.updateField(
+			patch.collection,
+			{
+				collection: patch.collection,
+				field: patch.field,
+				meta: patch.meta as any,
+			} as any,
+			{
+				emitEvents: false,
+				autoPurgeSystemCache: false,
+			},
+		);
+	}
+
+	private async applyRelation(patch: RelationMetadataPatch, service: RelationsService): Promise<void> {
+		await service.updateOne(
+			patch.collection,
+			patch.field,
+			{
+				collection: patch.collection,
+				field: patch.field,
+				related_collection: patch.related_collection,
+				meta: patch.meta as any,
+			} as any,
+			{
+				emitEvents: false,
+				autoPurgeSystemCache: false,
+			},
+		);
+	}
+
+	private async markSectionVisible(section: 'collections' | 'fields' | 'relations', updated: number): Promise<void> {
+		this.logger.info('Schema metadata sync section visible', {
+			section,
+			updated,
+		});
+	}
+
+	private assertAdmin(): void {
+		if (this.accountability && this.accountability.admin !== true) {
+			throw new Error('You do not have permission to queue schema metadata sync');
+		}
+	}
+}
diff --git a/api/src/services/schema-metadata-sync/schema-metadata-sync-queue.ts b/api/src/services/schema-metadata-sync/schema-metadata-sync-queue.ts
new file mode 100644
index 0000000000..e72bb180c5
--- /dev/null
+++ b/api/src/services/schema-metadata-sync/schema-metadata-sync-queue.ts
@@ -0,0 +1,226 @@
+import { useEnv } from '@directus/env';
+import getDatabase, { validateMigrations } from '../../database/index.js';
+import { useLock } from '../../lock/index.js';
+import { useLogger } from '../../logger/index.js';
+import { scheduleSynchronizedJob, validateCron } from '../../utils/schedule.js';
+import { SchemaMetadataSyncService } from './schema-metadata-sync-service.js';
+import { SchemaMetadataSyncStore } from './store.js';
+
+const env = useEnv();
+const logger = useLogger();
+
+const lockKey = 'schedule--schema-metadata-sync';
+const lockTimeout = 5 * 60 * 1000;
+
+export interface SchemaMetadataSyncQueueOptions {
+	cron?: string;
+	batchSize?: number;
+}
+
+export async function registerSchemaMetadataSyncQueue(options?: SchemaMetadataSyncQueueOptions): Promise<void> {
+	const cron = options?.cron ?? (env['SCHEMA_METADATA_SYNC_CRON'] as string | undefined) ?? '*/2 * * * *';
+
+	if (validateCron(cron) === false) {
+		logger.warn(`Invalid SCHEMA_METADATA_SYNC_CRON "${cron}". Metadata sync will not start.`);
+		return;
+	}
+
+	scheduleSynchronizedJob('schema-metadata-sync', cron, async () => {
+		await processSchemaMetadataSyncQueue({
+			batchSize: options?.batchSize ?? Number(env['SCHEMA_METADATA_SYNC_BATCH'] ?? 25),
+		});
+	});
+}
+
+export async function processSchemaMetadataSyncQueue(options?: { batchSize?: number }): Promise<number> {
+	const database = getDatabase();
+	const lock = useLock();
+	const now = Date.now();
+	const lockTime = await lock.get(lockKey);
+
+	if (lockTime && Number(lockTime) > now - lockTimeout) {
+		logger.debug('Schema metadata sync is already running in another process.');
+		return 0;
+	}
+
+	await lock.set(lockKey, now);
+
+	try {
+		const migrationsReady = await validateMigrations();
+
+		if (migrationsReady === false) {
+			logger.warn('Schema metadata sync is running while migrations are pending. Updates are metadata-only.');
+		}
+
+		const store = new SchemaMetadataSyncStore({ knex: database });
+		const service = new SchemaMetadataSyncService({
+			knex: database,
+			accountability: { admin: true },
+			store,
+		});
+
+		const batchSize = options?.batchSize ?? 25;
+		let processed = 0;
+
+		for (let i = 0; i < batchSize; i++) {
+			const summary = await service.runNext();
+
+			if (!summary) {
+				break;
+			}
+
+			logger.info('Schema metadata sync completed', {
+				id: summary.id,
+				source: summary.source,
+				collectionUpdates: summary.collectionUpdates,
+				fieldUpdates: summary.fieldUpdates,
+				relationUpdates: summary.relationUpdates,
+			});
+
+			processed++;
+		}
+
+		return processed;
+	} finally {
+		await lock.delete(lockKey);
+	}
+}
+
+export async function processSchemaMetadataSyncNow(id: string): Promise<void> {
+	const database = getDatabase();
+	const lock = useLock();
+	const lockTime = await lock.get(lockKey);
+
+	if (lockTime && Number(lockTime) > Date.now() - lockTimeout) {
+		logger.debug('A scheduled schema metadata sync is active. Inline processing will wait for the next tick.');
+		return;
+	}
+
+	await lock.set(lockKey, Date.now());
+
+	try {
+		const store = new SchemaMetadataSyncStore({ knex: database });
+		const row = await store.findById(id);
+
+		if (!row || row.status !== 'queued') {
+			return;
+		}
+
+		const service = new SchemaMetadataSyncService({
+			knex: database,
+			accountability: { admin: true },
+			store,
+		});
+
+		await service.runRow(row);
+	} finally {
+		await lock.delete(lockKey);
+	}
+}
+
+export async function getSchemaMetadataSyncBacklog(): Promise<{
+	queued: number;
+	running: number;
+	failed: number;
+	completedLastHour: number;
+}> {
+	const database = getDatabase();
+	const since = new Date(Date.now() - 60 * 60 * 1000);
+
+	const [queued, running, failed, completed] = await Promise.all([
+		database('directus_schema_metadata_syncs').where({ status: 'queued' }).count<{ count: string }[]>('* as count'),
+		database('directus_schema_metadata_syncs').where({ status: 'running' }).count<{ count: string }[]>('* as count'),
+		database('directus_schema_metadata_syncs').where({ status: 'failed' }).count<{ count: string }[]>('* as count'),
+		database('directus_schema_metadata_syncs')
+			.where({ status: 'completed' })
+			.where('completed_at', '>', since)
+			.count<{ count: string }[]>('* as count'),
+	]);
+
+	return {
+		queued: Number(queued[0]?.count ?? 0),
+		running: Number(running[0]?.count ?? 0),
+		failed: Number(failed[0]?.count ?? 0),
+		completedLastHour: Number(completed[0]?.count ?? 0),
+	};
+}
+
+export async function requeueStaleSchemaMetadataSyncs(): Promise<number> {
+	const database = getDatabase();
+	const cutoff = new Date(Date.now() - lockTimeout);
+
+	const rows = await database('directus_schema_metadata_syncs')
+		.where({ status: 'running' })
+		.where('started_at', '<', cutoff)
+		.select('id', 'attempts', 'max_attempts');
+
+	let requeued = 0;
+
+	for (const row of rows) {
+		if (row.attempts >= row.max_attempts) {
+			await database('directus_schema_metadata_syncs')
+				.where({ id: row.id })
+				.update({
+					status: 'failed',
+					error: 'Schema metadata sync exceeded max attempts after stale running state',
+					updated_at: new Date(),
+				});
+			continue;
+		}
+
+		await database('directus_schema_metadata_syncs')
+			.where({ id: row.id })
+			.update({
+				status: 'queued',
+				error: null,
+				updated_at: new Date(),
+			});
+		requeued++;
+	}
+
+	return requeued;
+}
+
+export async function drainSchemaMetadataSyncQueueForTests(limit = 100): Promise<number> {
+	let total = 0;
+
+	for (let i = 0; i < limit; i++) {
+		const processed = await processSchemaMetadataSyncQueue({ batchSize: 1 });
+
+		if (processed === 0) {
+			break;
+		}
+
+		total += processed;
+	}
+
+	return total;
+}
diff --git a/api/src/services/schema-metadata-sync/index.ts b/api/src/services/schema-metadata-sync/index.ts
new file mode 100644
index 0000000000..01eb38f404
--- /dev/null
+++ b/api/src/services/schema-metadata-sync/index.ts
@@ -0,0 +1,16 @@
+export { SchemaMetadataSyncService } from './schema-metadata-sync-service.js';
+export {
+	getSchemaMetadataSyncBacklog,
+	processSchemaMetadataSyncNow,
+	processSchemaMetadataSyncQueue,
+	registerSchemaMetadataSyncQueue,
+	requeueStaleSchemaMetadataSyncs,
+} from './schema-metadata-sync-queue.js';
+export { SchemaMetadataSyncStore } from './store.js';
diff --git a/api/src/controllers/schema.ts b/api/src/controllers/schema.ts
index 8a4fd0987d..b4903f8da2 100644
--- a/api/src/controllers/schema.ts
+++ b/api/src/controllers/schema.ts
@@ -1,17 +1,24 @@
 import type { Request, Response } from 'express';
 import { Router } from 'express';
 import asyncHandler from '../utils/async-handler.js';
 import { SchemaService } from '../services/schema.js';
+import { SchemaMetadataSyncService } from '../services/schema-metadata-sync/index.js';
+import { processSchemaMetadataSyncNow } from '../services/schema-metadata-sync/index.js';
+import { toBoolean } from '@directus/utils';
 
 const router = Router();
 
 router.get(
 	'/snapshot',
 	asyncHandler(async (req: Request, res: Response) => {
 		const service = new SchemaService({ accountability: req.accountability });
 		const snapshot = await service.snapshot();
 		res.json({ data: snapshot });
 	}),
 );
 
 router.post(
@@ -101,6 +108,81 @@ router.post(
 	}),
 );
 
+router.post(
+	'/metadata-sync',
+	asyncHandler(async (req: Request, res: Response) => {
+		const service = new SchemaMetadataSyncService({
+			accountability: req.accountability,
+		});
+
+		const summary = await service.enqueue({
+			source: req.body.source ?? 'api',
+			baseHash: req.body.base_hash ?? req.body.baseHash ?? null,
+			remoteHash: req.body.remote_hash ?? req.body.remoteHash ?? null,
+			snapshot: req.body.snapshot,
+			mode: req.body.mode ?? 'remote-wins',
+			actor: req.accountability?.user ?? null,
+			dryRun: toBoolean(req.query['dryRun']),
+		});
+
+		if (toBoolean(req.query['wait'])) {
+			await processSchemaMetadataSyncNow(summary.id);
+		}
+
+		res.status(202).json({
+			data: {
+				id: summary.id,
+				status: summary.status,
+				source: summary.source,
+				collection_updates: summary.collectionUpdates,
+				field_updates: summary.fieldUpdates,
+				relation_updates: summary.relationUpdates,
+			},
+		});
+	}),
+);
+
+router.get(
+	'/metadata-sync/:id',
+	asyncHandler(async (req: Request, res: Response) => {
+		const service = new SchemaMetadataSyncService({
+			accountability: req.accountability,
+		});
+		const row = await service.store.findById(req.params.id);
+
+		res.json({
+			data: row
+				? {
+						id: row.id,
+						source: row.source,
+						status: row.status,
+						base_hash: row.base_hash,
+						remote_hash: row.remote_hash,
+						collection_count: row.collection_count,
+						field_count: row.field_count,
+						relation_count: row.relation_count,
+						attempts: row.attempts,
+						error: row.error,
+						summary: row.summary,
+						queued_at: row.queued_at,
+						started_at: row.started_at,
+						completed_at: row.completed_at,
+				  }
+				: null,
+		});
+	}),
+);
+
 export default router;
diff --git a/api/src/app.ts b/api/src/app.ts
index 3b0f7abdb1..bd920f4148 100644
--- a/api/src/app.ts
+++ b/api/src/app.ts
@@ -28,6 +28,7 @@ import telemetrySchedule from './schedules/telemetry.js';
 import tusSchedule from './schedules/tus.js';
+import { registerSchemaMetadataSyncQueue } from './services/schema-metadata-sync/index.js';
 import { getConfigFromEnv } from './utils/get-config-from-env.js';
 import { Url } from './utils/url.js';
 import { validateStorage } from './utils/validate-storage.js';
@@ -167,6 +168,9 @@ export default async function createApp(): Promise<express.Application> {
 	telemetrySchedule();
 	tusSchedule();
 
+	await registerSchemaMetadataSyncQueue();
+	logger.info('Schema metadata sync queue registered');
+
 	return app;
 }
diff --git a/api/src/services/schema-metadata-sync/schema-metadata-sync-service.test.ts b/api/src/services/schema-metadata-sync/schema-metadata-sync-service.test.ts
new file mode 100644
index 0000000000..652f59e027
--- /dev/null
+++ b/api/src/services/schema-metadata-sync/schema-metadata-sync-service.test.ts
@@ -0,0 +1,372 @@
+import type { Snapshot } from '@directus/types';
+import { beforeEach, describe, expect, it, vi } from 'vitest';
+import { SchemaMetadataSyncService } from './schema-metadata-sync-service.js';
+import { SchemaMetadataSyncStore } from './store.js';
+
+vi.mock('../../utils/get-snapshot.js', () => ({
+	getSnapshot: vi.fn(),
+}));
+
+vi.mock('../../utils/get-versioned-hash.js', () => ({
+	getVersionedHash: vi.fn(),
+}));
+
+vi.mock('../../utils/get-schema.js', () => ({
+	getSchema: vi.fn(),
+}));
+
+vi.mock('../../cache.js', () => ({
+	clearSystemCache: vi.fn(),
+	flushCaches: vi.fn(),
+}));
+
+const currentSnapshot: Snapshot = {
+	version: 1,
+	directus: '11.0.0',
+	vendor: 'postgres',
+	collections: [
+		{
+			collection: 'orders',
+			meta: {
+				collection: 'orders',
+				icon: 'shopping_cart',
+				note: 'Local note edited by ops',
+				display_template: '{{ number }}',
+				hidden: false,
+				singleton: false,
+				sort_field: null,
+				accountability: 'all',
+				color: '#4f46e5',
+			},
+			schema: null,
+			fields: [],
+		} as any,
+		{
+			collection: 'customers',
+			meta: {
+				collection: 'customers',
+				icon: 'group',
+				note: 'Target customer labels',
+				display_template: '{{ email }}',
+				hidden: false,
+				singleton: false,
+				sort_field: null,
+				accountability: 'all',
+				color: '#16a34a',
+			},
+			schema: null,
+			fields: [],
+		} as any,
+	],
+	fields: [
+		{
+			collection: 'orders',
+			field: 'status',
+			type: 'string',
+			meta: {
+				id: 1,
+				collection: 'orders',
+				field: 'status',
+				interface: 'select-dropdown',
+				display: 'labels',
+				display_options: { showAsDot: true },
+				options: {
+					choices: [
+						{ text: 'Open', value: 'open' },
+						{ text: 'Closed', value: 'closed' },
+					],
+				},
+				note: 'Local status note',
+				hidden: false,
+				readonly: false,
+				required: false,
+			},
+			schema: null,
+		} as any,
+		{
+			collection: 'orders',
+			field: 'priority',
+			type: 'string',
+			meta: {
+				id: 2,
+				collection: 'orders',
+				field: 'priority',
+				interface: 'select-dropdown',
+				display: 'labels',
+				options: {
+					choices: [
+						{ text: 'Low', value: 'low' },
+						{ text: 'High', value: 'high' },
+					],
+				},
+				note: 'Local priority note',
+				hidden: false,
+				readonly: false,
+				required: false,
+			},
+			schema: null,
+		} as any,
+	],
+	systemFields: [],
+	relations: [
+		{
+			collection: 'orders',
+			field: 'customer_id',
+			related_collection: 'customers',
+			meta: {
+				id: 10,
+				many_collection: 'orders',
+				many_field: 'customer_id',
+				one_collection: 'customers',
+				one_field: 'orders',
+				one_deselect_action: 'nullify',
+				junction_field: null,
+				sort_field: null,
+			},
+			schema: null,
+		} as any,
+	],
+};
+
+const remoteSnapshot: Snapshot = {
+	...currentSnapshot,
+	collections: [
+		{
+			collection: 'orders',
+			meta: {
+				collection: 'orders',
+				icon: 'receipt_long',
+				note: 'Remote source of truth',
+				display_template: '{{ number }} - {{ total }}',
+				hidden: false,
+				singleton: false,
+				sort_field: null,
+				accountability: 'all',
+				color: '#f97316',
+			},
+			schema: null,
+			fields: [],
+		} as any,
+	],
+	fields: [
+		{
+			collection: 'orders',
+			field: 'status',
+			type: 'string',
+			meta: {
+				id: 8,
+				collection: 'orders',
+				field: 'status',
+				interface: 'select-dropdown',
+				display: 'labels',
+				display_options: { showAsDot: false },
+				options: {
+					choices: [
+						{ text: 'Draft', value: 'draft' },
+						{ text: 'Ready', value: 'ready' },
+						{ text: 'Archived', value: 'archived' },
+					],
+				},
+				note: 'Remote status note',
+				hidden: false,
+				readonly: false,
+				required: false,
+			},
+			schema: null,
+		} as any,
+	],
+	relations: [
+		{
+			collection: 'orders',
+			field: 'customer_id',
+			related_collection: 'customers',
+			meta: {
+				id: 11,
+				many_collection: 'orders',
+				many_field: 'customer_id',
+				one_collection: 'customers',
+				one_field: 'remote_orders',
+				one_deselect_action: 'delete',
+				junction_field: null,
+				sort_field: 'sort',
+			},
+			schema: null,
+		} as any,
+	],
+};
+
+function makeStore(row: any): SchemaMetadataSyncStore {
+	return {
+		create: vi.fn(),
+		findNextQueued: vi.fn(),
+		findById: vi.fn().mockResolvedValue(row),
+		markRunning: vi.fn().mockResolvedValue(row),
+		savePlan: vi.fn(),
+		markCompleted: vi.fn().mockImplementation(async (_id, summary) => ({ ...row, status: 'completed', summary })),
+		markSkipped: vi.fn(),
+		markFailed: vi.fn(),
+		toJob: vi.fn().mockReturnValue({
+			id: row.id,
+			source: row.source,
+			baseHash: row.base_hash,
+			remoteHash: row.remote_hash,
+			snapshot: row.snapshot,
+			mode: 'remote-wins',
+			actor: null,
+			dryRun: false,
+		}),
+	} as unknown as SchemaMetadataSyncStore;
+}
+
+describe('SchemaMetadataSyncService', () => {
+	beforeEach(async () => {
+		vi.clearAllMocks();
+		const { getSnapshot } = await import('../../utils/get-snapshot.js');
+		const { getVersionedHash } = await import('../../utils/get-versioned-hash.js');
+		const { getSchema } = await import('../../utils/get-schema.js');
+
+		vi.mocked(getSnapshot).mockResolvedValue(currentSnapshot);
+		vi.mocked(getVersionedHash).mockResolvedValue('target-hash-after-local-edit');
+		vi.mocked(getSchema).mockResolvedValue({ collections: {}, relations: [] } as any);
+	});
+
+	it('builds a remote-wins plan even when the queued base hash no longer matches the target', async () => {
+		const row = {
+			id: 'sync-1',
+			source: 'staging',
+			status: 'queued',
+			base_hash: 'target-hash-before-local-edit',
+			remote_hash: 'remote-hash',
+			actor: null,
+			collection_count: 1,
+			field_count: 1,
+			relation_count: 1,
+			attempts: 0,
+			max_attempts: 3,
+			snapshot: remoteSnapshot,
+			plan: null,
+			summary: null,
+			error: null,
+			queued_at: new Date(),
+			started_at: null,
+			completed_at: null,
+			updated_at: new Date(),
+		};
+		const store = makeStore(row);
+		const service = new SchemaMetadataSyncService({
+			knex: {} as any,
+			accountability: { admin: true } as any,
+			store,
+		});
+
+		const plan = await service.buildPlan(store.toJob(row), currentSnapshot);
+
+		expect(plan.mode).toBe('remote-wins');
+		expect(plan.baseHash).toBe('target-hash-before-local-edit');
+		expect(plan.collections[0]).toMatchObject({
+			collection: 'orders',
+			action: 'update',
+			meta: expect.objectContaining({
+				note: 'Remote source of truth',
+				display_template: '{{ number }} - {{ total }}',
+			}),
+		});
+		expect(plan.fields[0]).toMatchObject({
+			collection: 'orders',
+			field: 'status',
+			action: 'update',
+			meta: expect.objectContaining({
+				note: 'Remote status note',
+				options: expect.objectContaining({
+					choices: expect.arrayContaining([{ text: 'Ready', value: 'ready' }]),
+				}),
+			}),
+		});
+		expect(plan.relations[0]).toMatchObject({
+			collection: 'orders',
+			field: 'customer_id',
+			action: 'update',
+			meta: expect.objectContaining({
+				one_field: 'remote_orders',
+				one_deselect_action: 'delete',
+			}),
+		});
+		expect(plan.warnings).toContain(
+			'The queued snapshot was generated from an earlier base hash, but async sync applies it anyway.',
+		);
+	});
+
+});
diff --git a/api/src/services/schema-metadata-sync/schema-metadata-sync-queue.test.ts b/api/src/services/schema-metadata-sync/schema-metadata-sync-queue.test.ts
new file mode 100644
index 0000000000..210c41c493
--- /dev/null
+++ b/api/src/services/schema-metadata-sync/schema-metadata-sync-queue.test.ts
@@ -0,0 +1,268 @@
+import { beforeEach, describe, expect, it, vi } from 'vitest';
+import { processSchemaMetadataSyncQueue } from './schema-metadata-sync-queue.js';
+import { SchemaMetadataSyncService } from './schema-metadata-sync-service.js';
+
+const lockState = new Map<string, unknown>();
+const rows: any[] = [];
+
+vi.mock('../../database/index.js', () => ({
+	default: vi.fn(() => {
+		const builder: any = (table: string) => ({
+			table,
+			where(criteria: any) {
+				this.criteria = criteria;
+				return this;
+			},
+			whereIn() {
+				return this;
+			},
+			whereNotNull() {
+				return this;
+			},
+			whereNull() {
+				return this;
+			},
+			whereRaw() {
+				return this;
+			},
+			whereLike() {
+				return this;
+			},
+			whereILike() {
+				return this;
+			},
+			whereBetween() {
+				return this;
+			},
+			orderBy() {
+				return this;
+			},
+			limit() {
+				return this;
+			},
+			select() {
+				return Promise.resolve(rows);
+			},
+			first() {
+				return Promise.resolve(rows.find((row) => row.status === 'queued') ?? null);
+			},
+			count() {
+				return Promise.resolve([{ count: String(rows.length) }]);
+			},
+			update(payload: Record<string, unknown>) {
+				for (const row of rows) {
+					Object.assign(row, payload);
+				}
+				return Promise.resolve(rows.length);
+			},
+		});
+
+		builder.select = vi.fn(() => builder);
+		builder.from = vi.fn(() => Promise.resolve([{ version: '20250101A' }]));
+		return builder;
+	}),
+	validateMigrations: vi.fn(),
+}));
+
+vi.mock('../../lock/index.js', () => ({
+	useLock: vi.fn(() => ({
+		get: vi.fn(async (key: string) => lockState.get(key)),
+		set: vi.fn(async (key: string, value: unknown) => lockState.set(key, value)),
+		delete: vi.fn(async (key: string) => lockState.delete(key)),
+	})),
+}));
+
+vi.mock('../../logger/index.js', () => ({
+	useLogger: vi.fn(() => ({
+		debug: vi.fn(),
+		info: vi.fn(),
+		warn: vi.fn(),
+		error: vi.fn(),
+	})),
+}));
+
+vi.mock('../../utils/schedule.js', () => ({
+	scheduleSynchronizedJob: vi.fn(),
+	validateCron: vi.fn(() => true),
+}));
+
+vi.mock('./store.js', () => ({
+	SchemaMetadataSyncStore: vi.fn().mockImplementation(() => ({
+		findNextQueued: vi.fn(async () => rows.find((row) => row.status === 'queued') ?? null),
+		findById: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
+		markRunning: vi.fn(async (id: string) => {
+			const row = rows.find((item) => item.id === id);
+			row.status = 'running';
+			return row;
+		}),
+		savePlan: vi.fn(),
+		markCompleted: vi.fn(async (id: string, summary: any) => {
+			const row = rows.find((item) => item.id === id);
+			row.status = 'completed';
+			row.summary = summary;
+			return row;
+		}),
+		markFailed: vi.fn(),
+		toJob: vi.fn((row: any) => ({
+			id: row.id,
+			source: row.source,
+			baseHash: row.base_hash,
+			remoteHash: row.remote_hash,
+			snapshot: row.snapshot,
+			mode: 'remote-wins',
+			actor: null,
+			dryRun: false,
+		})),
+	})),
+}));
+
+describe('schema metadata sync queue', () => {
+	beforeEach(async () => {
+		lockState.clear();
+		rows.splice(0, rows.length);
+		vi.restoreAllMocks();
+		const database = await import('../../database/index.js');
+		vi.mocked(database.validateMigrations).mockResolvedValue(true);
+	});
+
+	it('continues processing when migrations are pending because updates are metadata-only', async () => {
+		const database = await import('../../database/index.js');
+		vi.mocked(database.validateMigrations).mockResolvedValue(false);
+		rows.push({
+			id: 'sync-1',
+			source: 'staging',
+			status: 'queued',
+			base_hash: 'old-target-hash',
+			remote_hash: 'remote-hash',
+			snapshot: { collections: [], fields: [], relations: [], systemFields: [] },
+			attempts: 0,
+			max_attempts: 3,
+		});
+		const runNext = vi.spyOn(SchemaMetadataSyncService.prototype, 'runNext').mockResolvedValueOnce({
+			id: 'sync-1',
+			source: 'staging',
+			status: 'completed',
+			collectionUpdates: 1,
+			fieldUpdates: 1,
+			relationUpdates: 1,
+			skippedCollections: 0,
+			skippedFields: 0,
+			skippedRelations: 0,
+			warnings: [],
+			startedAt: null,
+			completedAt: new Date().toISOString(),
+		});
+
+		const processed = await processSchemaMetadataSyncQueue({ batchSize: 1 });
+
+		expect(processed).toBe(1);
+		expect(runNext).toHaveBeenCalledOnce();
+	});
+
+	it('uses only the metadata sync schedule lock and does not coordinate with schema apply locks', async () => {
+		rows.push({
+			id: 'sync-2',
+			source: 'staging',
+			status: 'queued',
+			base_hash: 'old-target-hash',
+			remote_hash: 'remote-hash',
+			snapshot: { collections: [], fields: [], relations: [], systemFields: [] },
+			attempts: 0,
+			max_attempts: 3,
+		});
+		vi.spyOn(SchemaMetadataSyncService.prototype, 'runNext').mockResolvedValueOnce({
+			id: 'sync-2',
+			source: 'staging',
+			status: 'completed',
+			collectionUpdates: 1,
+			fieldUpdates: 1,
+			relationUpdates: 0,
+			skippedCollections: 0,
+			skippedFields: 0,
+			skippedRelations: 0,
+			warnings: [],
+			startedAt: null,
+			completedAt: new Date().toISOString(),
+		});
+
+		await processSchemaMetadataSyncQueue({ batchSize: 1 });
+
+		expect(lockState.has('schedule--schema-metadata-sync')).toBe(false);
+		expect(lockState.has('schema-apply')).toBe(false);
+		expect(lockState.has('database-migrations')).toBe(false);
+	});
+
+	it('does not wait for another migration process before making cache-visible updates', async () => {
+		const events: string[] = [];
+		rows.push({
+			id: 'sync-3',
+			source: 'staging',
+			status: 'queued',
+			base_hash: 'old-target-hash',
+			remote_hash: 'remote-hash',
+			snapshot: { collections: [], fields: [], relations: [], systemFields: [] },
+			attempts: 0,
+			max_attempts: 3,
+		});
+		vi.spyOn(SchemaMetadataSyncService.prototype, 'runNext').mockImplementation(async () => {
+			events.push('collections-visible');
+			events.push('fields-visible');
+			events.push('relations-visible');
+			return {
+				id: 'sync-3',
+				source: 'staging',
+				status: 'completed',
+				collectionUpdates: 1,
+				fieldUpdates: 1,
+				relationUpdates: 1,
+				skippedCollections: 0,
+				skippedFields: 0,
+				skippedRelations: 0,
+				warnings: [],
+				startedAt: null,
+				completedAt: new Date().toISOString(),
+			};
+		});
+
+		const processed = await processSchemaMetadataSyncQueue({ batchSize: 1 });
+
+		expect(processed).toBe(1);
+		expect(events).toEqual(['collections-visible', 'fields-visible', 'relations-visible']);
+	});
+
+});
diff --git a/docs/guides/schema-metadata-sync.md b/docs/guides/schema-metadata-sync.md
new file mode 100644
index 0000000000..c7bde81614
--- /dev/null
+++ b/docs/guides/schema-metadata-sync.md
@@ -0,0 +1,172 @@
+# Schema Metadata Sync
+
+Schema metadata sync lets you promote collection, field, and relation metadata
+from one Directus environment into another without blocking the request that
+submits the snapshot.
+
+This is intended for deployments where developers manage schema shape in one
+environment and operators want display labels, field options, and relation
+metadata to arrive in another environment soon after.
+
+## Submit a sync
+
+Use `POST /schema/metadata-sync`.
+
+```json
+{
+  "source": "staging",
+  "base_hash": "hash returned by /schema/diff",
+  "remote_hash": "hash for the uploaded source snapshot",
+  "snapshot": {
+    "version": 1,
+    "directus": "11.0.0",
+    "vendor": "postgres",
+    "collections": [],
+    "fields": [],
+    "systemFields": [],
+    "relations": []
+  }
+}
+```
+
+The endpoint returns `202 Accepted` with the queued sync id.
+
+## Conflict behavior
+
+Metadata sync is remote-wins. When the same collection, field, or relation exists
+locally, the remote snapshot is applied over local metadata.
+
+This means the following target-environment edits are overwritten by the next
+sync:
+
+- collection note,
+- collection icon,
+- collection display template,
+- field interface,
+- field display,
+- field display options,
+- field option choices,
+- field note,
+- relation one-field label,
+- relation deselect action.
+
+The job records the submitted base hash and logs the current hash when the
+worker runs. A mismatch is not an error because the remote environment remains
+the source of truth.
+
+## Cache visibility
+
+The worker applies sections in this order:
+
+1. collections,
+2. fields,
+3. relations.
+
+After each section, schema caches are cleared. This lets API consumers observe
+collection metadata updates as soon as they are written, even if the full sync
+still has field or relation work remaining.
+
+For large projects, this can make the sync feel progressive. Admin users may see
+new collection labels before field labels update.
+
+## Migrations
+
+If Directus starts while migrations are pending, metadata sync still runs. The
+job only updates Directus metadata tables, so it does not need to block on schema
+migrations that add or modify user tables.
+
+If a migration creates a collection that appears in the uploaded snapshot, the
+first metadata sync may skip it and the next scheduled run can apply the
+metadata after the migration completes.
+
+## Operational defaults
+
+```env
+SCHEMA_METADATA_SYNC_CRON=*/2 * * * *
+SCHEMA_METADATA_SYNC_BATCH=25
+```
+
+The scheduled job uses the `schedule--schema-metadata-sync` lock to prevent two
+metadata sync workers from running at the same time. This lock is independent
+from migration or schema apply operations.
+
+## Troubleshooting
+
+If metadata did not apply, check whether the collection, field, or relation
+exists locally. Metadata sync does not create missing schema objects.
+
+If metadata changed locally and then reverted, check the latest completed sync
+row and compare `base_hash` with the current snapshot hash. Remote-wins sync can
+overwrite local edits on the next run.
+
+If API consumers briefly see mixed labels, wait for the relations section to
+finish. The worker clears caches after each section, so partial visibility is
+expected during long syncs.
+
+If migrations are running, the sync may skip missing objects. Let migrations
+finish, then queue a new metadata sync or wait for the next scheduled promotion.
+
```

## Intended Flaws

### Flaw 1: The async worker overwrites local metadata edits made after the snapshot was queued

The PR records `base_hash` and logs the current snapshot hash, but the worker does not enforce that hash, compute a three-way merge, or detect local changes at the field/collection/relation metadata level. It builds a `remote-wins` plan from the uploaded snapshot and applies remote metadata over whatever is currently in the target instance.

Relevant line references:

- `api/src/services/schema-metadata-sync/schema-metadata-sync-service.ts:72-110` fetches the current snapshot and current hash, logs the hash mismatch context, and then continues into `buildPlan(...)` without rejecting or merging.
- `api/src/services/schema-metadata-sync/schema-metadata-sync-service.ts:127-253` builds every collection, field, and relation patch from remote metadata and explicitly sets `mode: 'remote-wins'`.
- `api/src/controllers/schema.ts:108-133` accepts `base_hash` and `remote_hash` but only stores them in the async job; the request does not get the existing `SchemaService.apply(...)` hash validation contract.
- `api/src/services/schema-metadata-sync/schema-metadata-sync-service.test.ts:233-291` asserts that remote metadata wins even when the queued base hash no longer matches the current target hash.
- `docs/guides/schema-metadata-sync.md:34-55` documents overwriting local target edits as expected behavior.

Why this is a real flaw:

The product promise is async promotion without losing administrator edits. In Directus, metadata is not cosmetic trivia: field options, display templates, relation labels, and notes shape how administrators understand and operate the data model. Async execution creates a new concurrency window. A human can edit target metadata after the snapshot is queued and before the worker runs. This PR silently reverts that work because it treats the remote snapshot as authoritative without proving the target is still at the queued base.

Better implementation direction:

Keep the existing hash contract or introduce a real merge contract. At minimum, reject or pause the job when the current snapshot hash differs from `base_hash`. A stronger implementation should store per-resource metadata versions or hashes and perform a three-way merge: base snapshot, current target, and remote snapshot. If both current target and remote changed the same metadata key, surface a conflict instead of overwriting. The async job should make conflict state visible through the status endpoint.

### Flaw 2: The worker bypasses schema apply/migration boundaries and clears caches between partial sections

The PR applies collection metadata, clears schema caches, then applies field metadata, clears schema caches, then applies relation metadata. It uses only a metadata-sync schedule lock, not a shared schema-apply/deploy/migration lock, and it continues even when `validateMigrations()` says migrations are pending.

Relevant line references:

- `api/src/services/schema-metadata-sync/schema-metadata-sync-service.ts:255-286` directly calls collection/field/relation services in separate sections and clears system caches after each section.
- `api/src/services/schema-metadata-sync/schema-metadata-sync-queue.ts:42-83` checks `validateMigrations()` but treats a false result as a warning and keeps processing.
- `api/src/services/schema-metadata-sync/schema-metadata-sync-queue.ts:33-41` and `api/src/services/schema-metadata-sync/schema-metadata-sync-queue.ts:87-116` use only `schedule--schema-metadata-sync`, so the worker does not coordinate with schema apply or migration operations.
- `api/src/services/schema-metadata-sync/schema-metadata-sync-queue.test.ts:128-192` asserts that pending migrations do not stop processing and that no schema apply or migration lock is used.
- `docs/guides/schema-metadata-sync.md:57-90` documents section-by-section cache visibility and says metadata sync still runs while migrations are pending.

Why this is a real flaw:

Directus' existing schema apply path is careful because schema state is a contract consumed by REST, GraphQL, permissions, admin forms, and extensions. If a background worker clears schema caches after only collection metadata is updated, API consumers can rebuild schema from a partially synced state. If migrations are concurrently creating or altering collections/fields, the worker can skip objects, write metadata against stale schema assumptions, or publish a schema cache between migration phases. The result is intermittent missing fields, mixed admin metadata, and deploys where API behavior depends on exact timing.

Better implementation direction:

Make metadata sync use the same coordination model as schema apply/deploy. Either route through `SchemaService.apply(...)`/`applyDiff(...)` with a metadata-only diff and hash validation, or introduce a shared schema mutation lock that migrations, schema apply, and metadata sync all honor. Apply the full metadata plan in one transaction or one atomic phase from the perspective of schema cache visibility. Flush caches once after commit. If migrations are pending or active, requeue the sync rather than running through the overlap.

## Hints

### Flaw 1 Hints

1. What does the worker do when `baseHash` and the current target snapshot hash differ?
2. Which value wins if a target admin edits `orders.status.options` after the job is queued?
3. Compare this endpoint to the existing schema apply flow. Where did the hash validation contract go?

### Flaw 2 Hints

1. How many times can schema caches be cleared while one sync job is still running?
2. What happens if a migration creates a field between the worker's collection section and field section?
3. Which lock is shared between this worker, schema apply, and database migrations?

## Expected Answer

A strong review should say that the product-level change is async promotion of Directus schema metadata, but the implementation weakens two existing schema contracts: concurrency control over snapshot application and atomic visibility of schema changes.

For flaw 1, the learner should identify that `base_hash` is accepted but not enforced. The worker builds a remote-wins plan from the uploaded snapshot and overwrites local collection, field, and relation metadata even when the target changed after enqueue. The impact is lost administrator configuration, reverted field choices/display settings, and trust erosion because async jobs can silently undo human work. The fix is hash precondition enforcement, per-resource metadata versions, three-way merge, and visible conflict state.

For flaw 2, the learner should identify that metadata sync bypasses the existing schema apply path, runs while migrations are pending, uses a private schedule lock, and flushes caches after partial sections. The impact is API/admin consumers observing half-synced schema, skipped objects during deploys, mixed metadata, and timing-dependent migration failures. The fix is shared schema mutation coordination, requeueing while migrations are pending/active, applying the full plan atomically, and flushing schema caches once after commit.

The best answers should connect the flaws to Directus' existing contracts: snapshot hashes guard stale applies, `applyDiff` batches schema changes inside a transaction, schema cache invalidation is part of the schema visibility contract, and migrations are not just background noise.

## Expert Debrief

At the product level, this PR turns schema promotion into an async workflow. That sounds like a performance improvement, but async work changes the correctness problem. The request returns before the mutation happens, so the reviewer has to ask what can change in the gap between enqueue and apply.

The first contract is optimistic concurrency. Directus already has a versioned snapshot hash in the schema diff/apply flow. That hash is there to stop stale diffs from being applied over a database that has changed. This PR carries `base_hash` through the API, but only as audit metadata. That is worse than omitting it because it gives the surface area the appearance of safety while the worker still overwrites target metadata.

The second contract is schema visibility. Directus schema is not just a database table; it feeds API validation, GraphQL schema generation, permissions, admin forms, hooks, and extension behavior. The existing apply path tries to make a full schema mutation visible after the plan is applied. This PR publishes partial states by clearing caches between collections, fields, and relations.

The failure modes are concrete:

- A target admin changes field choices while a sync job waits in the queue, then the worker silently restores remote choices.
- A collection display template is reverted even though the queued base hash no longer matches the target.
- A deploy migration creates a field after the worker built its plan, causing the worker to skip metadata for that field.
- API consumers rebuild schema after collection metadata changed but before field metadata changed.
- A stale running job is requeued without knowing which section already became visible.
- Operators see completed sync rows even though the system exposed mixed metadata during the run.

The reviewer thought process should be: first, follow the contract that used to protect the operation. Existing schema apply says "hash must match or force must be explicit." The new async endpoint should preserve or replace that contract, not log around it. Second, follow visibility. Every cache clear is a moment where the rest of the system can observe the world. If a PR clears caches between phases, ask whether the intermediate state is a valid product state.

The better implementation is to treat metadata sync as a schema mutation, not as a generic background cleanup. Queue the request, but when the worker runs, compare the current target hash to the queued base. If it changed, either re-diff, perform a three-way merge, or mark the job conflicted. Then apply the accepted plan under the same schema mutation lock used by schema apply/deploy, inside one transaction where possible, and flush caches once after the final committed state.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: stale async remote-wins overwrite of local metadata and partial schema visibility/migration race from bypassing apply boundaries. It explains lost admin edits, stale hash misuse, half-synced schema, migration overlap, and suggests hash/merge conflict handling plus shared schema mutation locking and one final cache flush.
- `partial`: The answer finds one flaw completely and gestures at either "overwrites metadata" or "cache/migration race" without tying it to the exact async worker and Directus schema contracts.
- `miss`: The answer focuses on route naming, enum style, migration column names, or the fact that the job is async while missing stale overwrite and schema visibility safety.
