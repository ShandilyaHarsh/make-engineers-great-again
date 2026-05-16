# TS-003: Directus Saved-Query Export For Collections

## Metadata

- `id`: TS-003
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: utils export controller, import/export service, items service, query sanitization, permission-aware AST processing
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 563
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Directus query permissions, export memory behavior, and public API contracts without reducing credit.

## PR Description Shown To Learner

This PR adds saved-query exports.

Users can save a query for a collection, then export it later without rebuilding the filter in the client. The feature is intended for operational workflows like "export open support tickets", "export pending invoices", or "export contacts in a region". The new endpoint accepts:

- a saved query id,
- an export format,
- optional field overrides,
- optional limit override.

The endpoint resolves the saved query, applies the stored filter, and returns a CSV/JSON file response directly to the caller.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `api/src/controllers/utils.ts` handles `POST /utils/export/:collection`. It requires a query and format, sanitizes the query with `sanitizeQuery(req.body.query, req.schema, req.accountability)`, and delegates to `ExportService.exportToFile`.
- `api/src/services/import-export.ts` implements `ExportService.exportToFile`. It creates a service through `getService(collection, { accountability, schema, knex })`, calls `service.readByQuery`, and exports in batches using `EXPORT_BATCH_SIZE`.
- `api/src/services/items.ts` implements `ItemsService.readByQuery`. It builds the query AST with `getAstFromQuery`, calls `processAst({ action: "read", accountability })`, and runs the processed AST. This is where field permissions, row permissions, relations, dynamic variables, and accountability-sensitive rules are enforced.
- `api/src/utils/sanitize-query.ts` parses filter JSON, fields, sort, aggregate, limit, deep, alias, search, and dynamic permission variables before a query enters the service layer.
- `api/src/services/import-export.ts` already avoids loading the entire export at once: it counts, pages through batches, appends each batch to a temporary file, and uploads that file through `FilesService`.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `api/src/database/migrations/20260516000100-add-saved-queries.ts`
- `api/src/services/saved-query-export.ts`
- `api/src/controllers/utils.ts`
- `api/src/services/index.ts`
- `packages/types/src/saved-query-export.ts`
- `api/src/services/saved-query-export.test.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally a backend PR: migration, service, controller route, shared type export, and tests.

## Diff

```diff
diff --git a/api/src/database/migrations/20260516000100-add-saved-queries.ts b/api/src/database/migrations/20260516000100-add-saved-queries.ts
new file mode 100644
index 0000000000..6d3202af77
--- /dev/null
+++ b/api/src/database/migrations/20260516000100-add-saved-queries.ts
@@ -0,0 +1,57 @@
+import type { Knex } from 'knex';
+
+export async function up(knex: Knex): Promise<void> {
+	await knex.schema.createTable('directus_saved_queries', (table) => {
+		table.uuid('id').primary();
+		table.string('collection').notNullable();
+		table.string('name').notNullable();
+		table.uuid('user_created').nullable();
+		table.timestamp('date_created').notNullable().defaultTo(knex.fn.now());
+		table.json('query').notNullable();
+		table.json('fields').nullable();
+		table.string('format').notNullable().defaultTo('csv');
+		table.boolean('shared').notNullable().defaultTo(false);
+
+		table.foreign('user_created').references('id').inTable('directus_users').onDelete('SET NULL');
+		table.index(['collection']);
+		table.index(['user_created']);
+		table.index(['shared']);
+	});
+}
+
+export async function down(knex: Knex): Promise<void> {
+	await knex.schema.dropTable('directus_saved_queries');
+}
diff --git a/api/src/services/saved-query-export.ts b/api/src/services/saved-query-export.ts
new file mode 100644
index 0000000000..9fc0ae3251
--- /dev/null
+++ b/api/src/services/saved-query-export.ts
@@ -0,0 +1,274 @@
+import { createError, ForbiddenError, InvalidPayloadError, ServiceUnavailableError } from '@directus/errors';
+import type { AbstractServiceOptions, Accountability, ExportFormat, Query, SchemaOverview } from '@directus/types';
+import { getDateTimeFormatted, parseJSON, toArray } from '@directus/utils';
+import { Parser as CSVParser, transforms as CSVTransforms } from 'json2csv';
+import type { Knex } from 'knex';
+import { omit } from 'lodash-es';
+import getDatabase from '../database/index.js';
+
+const SavedQueryNotFoundError = createError('SAVED_QUERY_NOT_FOUND', 'Saved query does not exist.', 404);
+
+type SavedQueryRow = {
+	id: string;
+	collection: string;
+	name: string;
+	user_created: string | null;
+	query: Record<string, any> | string;
+	fields: string[] | string | null;
+	format: ExportFormat;
+	shared: boolean;
+};
+
+type ExportSavedQueryOptions = {
+	savedQueryId: string;
+	format?: ExportFormat;
+	fields?: string[];
+	limit?: number;
+};
+
+type ExportFileResponse = {
+	filename: string;
+	type: string;
+	body: string;
+};
+
+export class SavedQueryExportService {
+	knex: Knex;
+	accountability: Accountability | null;
+	schema: SchemaOverview;
+
+	constructor(options: AbstractServiceOptions) {
+		this.knex = options.knex || getDatabase();
+		this.accountability = options.accountability || null;
+		this.schema = options.schema;
+	}
+
+	async exportSavedQuery(options: ExportSavedQueryOptions): Promise<ExportFileResponse> {
+		const savedQuery = await this.getSavedQuery(options.savedQueryId);
+
+		if (!savedQuery.shared && savedQuery.user_created !== this.accountability?.user) {
+			throw new ForbiddenError();
+		}
+
+		const query = this.normalizeStoredQuery(savedQuery, {
+			fields: options.fields,
+			limit: options.limit,
+		});
+
+		const rows = await this.readRowsForSavedQuery(savedQuery.collection, query);
+		const format = options.format ?? savedQuery.format ?? 'csv';
+		const body = this.transformRows(rows, format, query.fields);
+		const extension = format === 'csv_utf8' ? 'csv' : format;
+
+		return {
+			filename: `${savedQuery.collection}-${savedQuery.name}-${getDateTimeFormatted()}.${extension}`,
+			type: this.getMimeType(format),
+			body,
+		};
+	}
+
+	private async getSavedQuery(id: string): Promise<SavedQueryRow> {
+		const savedQuery = await this.knex<SavedQueryRow>('directus_saved_queries').where({ id }).first();
+
+		if (!savedQuery) {
+			throw new SavedQueryNotFoundError();
+		}
+
+		return savedQuery;
+	}
+
+	private normalizeStoredQuery(
+		savedQuery: SavedQueryRow,
+		overrides: {
+			fields?: string[];
+			limit?: number;
+		}
+	): Query {
+		const storedQuery =
+			typeof savedQuery.query === 'string' ? parseJSON(savedQuery.query) : { ...savedQuery.query };
+
+		const storedFields =
+			typeof savedQuery.fields === 'string'
+				? toArray(savedQuery.fields)
+				: Array.isArray(savedQuery.fields)
+					? savedQuery.fields
+					: undefined;
+
+		return {
+			...storedQuery,
+			fields: overrides.fields ?? storedQuery.fields ?? storedFields ?? ['*'],
+			limit: overrides.limit ?? storedQuery.limit ?? -1,
+		};
+	}
+
+	private async readRowsForSavedQuery(collection: string, query: Query) {
+		const fields = this.normalizeFields(query.fields);
+		const rowsQuery = this.knex(collection).select(fields);
+
+		this.applyRawFilter(rowsQuery, query.filter);
+		this.applySort(rowsQuery, query.sort);
+
+		if (typeof query.limit === 'number' && query.limit > 0) {
+			rowsQuery.limit(query.limit);
+		}
+
+		if (typeof query.offset === 'number' && query.offset > 0) {
+			rowsQuery.offset(query.offset);
+		}
+
+		return await rowsQuery;
+	}
+
+	private normalizeFields(fields: Query['fields']) {
+		if (!fields || fields.length === 0) {
+			return ['*'];
+		}
+
+		return fields.map((field) => {
+			if (field.includes('.')) {
+				return field.replaceAll('.', '__');
+			}
+
+			return field;
+		});
+	}
+
+	private applySort(rowsQuery: Knex.QueryBuilder, sort: Query['sort']) {
+		if (!sort) return;
+
+		for (const sortField of sort) {
+			if (sortField.startsWith('-')) {
+				rowsQuery.orderBy(sortField.slice(1), 'desc');
+			} else {
+				rowsQuery.orderBy(sortField, 'asc');
+			}
+		}
+	}
+
+	private applyRawFilter(rowsQuery: Knex.QueryBuilder, filter: Query['filter']) {
+		if (!filter) return;
+
+		for (const [field, value] of Object.entries(filter)) {
+			if (field === '_and' && Array.isArray(value)) {
+				rowsQuery.andWhere((builder) => {
+					for (const child of value) {
+						this.applyRawFilter(builder, child);
+					}
+				});
+				continue;
+			}
+
+			if (field === '_or' && Array.isArray(value)) {
+				rowsQuery.andWhere((builder) => {
+					for (const child of value) {
+						builder.orWhere((orBuilder) => this.applyRawFilter(orBuilder, child));
+					}
+				});
+				continue;
+			}
+
+			if (typeof value !== 'object' || value === null) {
+				rowsQuery.where(field, value);
+				continue;
+			}
+
+			if ('_eq' in value) {
+				rowsQuery.where(field, value['_eq']);
+			}
+
+			if ('_neq' in value) {
+				rowsQuery.whereNot(field, value['_neq']);
+			}
+
+			if ('_in' in value) {
+				rowsQuery.whereIn(field, toArray(value['_in']));
+			}
+
+			if ('_contains' in value) {
+				rowsQuery.where(field, 'like', `%${value['_contains']}%`);
+			}
+
+			if ('_gte' in value) {
+				rowsQuery.where(field, '>=', value['_gte']);
+			}
+
+			if ('_lte' in value) {
+				rowsQuery.where(field, '<=', value['_lte']);
+			}
+		}
+	}
+
+	private transformRows(rows: Record<string, any>[], format: ExportFormat, fields: Query['fields']): string {
+		if (format === 'json') {
+			return JSON.stringify(rows, null, '\t');
+		}
+
+		if (format === 'csv' || format === 'csv_utf8') {
+			const transforms = [CSVTransforms.flatten({ separator: '.' })];
+			const withBOM = format === 'csv_utf8';
+			const normalizedFields = this.normalizeFields(fields);
+
+			return new CSVParser({
+				transforms,
+				withBOM,
+				fields: normalizedFields,
+			}).parse(rows.map((row) => omit(row, ['password', 'token'])));
+		}
+
+		throw new ServiceUnavailableError({ service: 'saved-query-export', reason: `Unsupported format: ${format}` });
+	}
+
+	private getMimeType(format: ExportFormat) {
+		if (format === 'json') return 'application/json';
+		if (format === 'csv') return 'text/csv';
+		if (format === 'csv_utf8') return 'text/csv; charset=utf-8';
+		throw new InvalidPayloadError({ reason: `Unsupported format: ${format}` });
+	}
+}
diff --git a/api/src/controllers/utils.ts b/api/src/controllers/utils.ts
index b3450af3f4..ca239bb401 100644
--- a/api/src/controllers/utils.ts
+++ b/api/src/controllers/utils.ts
@@ -10,7 +10,7 @@ import { validateBatch } from '../middleware/validate-batch.js';
 import asyncHandler from '../utils/async-handler.js';
 import { sanitizeQuery } from '../utils/sanitize-query.js';
 import { generateHash } from '../utils/generate-hash.js';
-import { ExportService, ImportService } from '../services/import-export.js';
+import { ExportService, ImportService, SavedQueryExportService } from '../services/index.js';
 
 const router = express.Router();
 
@@ -184,6 +184,39 @@ router.post(
 	respond,
 );
 
+router.post(
+	'/export/saved-query/:id',
+	asyncHandler(async (req, res, next) => {
+		const service = new SavedQueryExportService({
+			accountability: req.accountability,
+			schema: req.schema,
+		});
+
+		const result = await service.exportSavedQuery({
+			savedQueryId: req.params['id']!,
+			format: req.body.format,
+			fields: req.body.fields,
+			limit: req.body.limit,
+		});
+
+		res.setHeader('Content-Type', result.type);
+		res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
+		res.locals['payload'] = result.body;
+
+		return next();
+	}),
+	(_req, res) => {
+		if (typeof res.locals['payload'] === 'string') {
+			return res.send(res.locals['payload']);
+		}
+
+		return res.status(204).end();
+	},
+);
+
 router.post(
 	'/translations/generate',
 	asyncHandler(async (req, res, next) => {
diff --git a/api/src/services/index.ts b/api/src/services/index.ts
index 53f4f16d29..9d021b1044 100644
--- a/api/src/services/index.ts
+++ b/api/src/services/index.ts
@@ -39,3 +39,4 @@ export * from './utils.js';
 export * from './versions.js';
 export * from './websocket.js';
+export * from './saved-query-export.js';
diff --git a/packages/types/src/saved-query-export.ts b/packages/types/src/saved-query-export.ts
new file mode 100644
index 0000000000..0ca1c2f1b9
--- /dev/null
+++ b/packages/types/src/saved-query-export.ts
@@ -0,0 +1,66 @@
+import type { ExportFormat, Query } from './index.js';
+
+export type SavedQueryExportRequest = {
+	savedQueryId: string;
+	format?: Extract<ExportFormat, 'csv' | 'csv_utf8' | 'json'>;
+	fields?: string[];
+	limit?: number;
+};
+
+export type SavedQueryExportResponse = {
+	filename: string;
+	type: string;
+	body: string;
+};
+
+export type SavedQueryDefinition = {
+	id: string;
+	collection: string;
+	name: string;
+	query: Query;
+	fields?: string[];
+	format: Extract<ExportFormat, 'csv' | 'csv_utf8' | 'json'>;
+	shared: boolean;
+	user_created: string | null;
+};
diff --git a/api/src/services/saved-query-export.test.ts b/api/src/services/saved-query-export.test.ts
new file mode 100644
index 0000000000..51e82d7e9e
--- /dev/null
+++ b/api/src/services/saved-query-export.test.ts
@@ -0,0 +1,205 @@
+import { beforeEach, describe, expect, it, vi } from 'vitest';
+import { SavedQueryExportService } from './saved-query-export.js';
+
+const rows = [
+	{
+		id: 1,
+		status: 'open',
+		title: 'Broken login',
+		email: 'customer@example.com',
+		owner: 'support',
+		password: 'redacted-by-transform',
+	},
+];
+
+function createKnexMock() {
+	const queryBuilder = {
+		select: vi.fn().mockReturnThis(),
+		where: vi.fn().mockReturnThis(),
+		whereNot: vi.fn().mockReturnThis(),
+		whereIn: vi.fn().mockReturnThis(),
+		andWhere: vi.fn().mockImplementation((callback) => {
+			callback(queryBuilder);
+			return queryBuilder;
+		}),
+		orWhere: vi.fn().mockImplementation((callback) => {
+			callback(queryBuilder);
+			return queryBuilder;
+		}),
+		orderBy: vi.fn().mockReturnThis(),
+		limit: vi.fn().mockReturnThis(),
+		offset: vi.fn().mockReturnThis(),
+		then: vi.fn((resolve) => resolve(rows)),
+	};
+
+	const savedQueryBuilder = {
+		where: vi.fn().mockReturnThis(),
+		first: vi.fn().mockResolvedValue({
+			id: 'saved-query-1',
+			collection: 'support_tickets',
+			name: 'open-tickets',
+			user_created: 'user-1',
+			query: {
+				filter: {
+					status: {
+						_eq: 'open',
+					},
+				},
+				sort: ['title'],
+				fields: ['id', 'status', 'title', 'email'],
+				limit: -1,
+			},
+			fields: null,
+			format: 'csv',
+			shared: false,
+		}),
+	};
+
+	const knex = vi.fn((table: string) => {
+		if (table === 'directus_saved_queries') {
+			return savedQueryBuilder;
+		}
+
+		return queryBuilder;
+	});
+
+	return { knex, queryBuilder, savedQueryBuilder };
+}
+
+describe('SavedQueryExportService', () => {
+	beforeEach(() => {
+		vi.clearAllMocks();
+	});
+
+	it('exports rows for the saved query owner', async () => {
+		const { knex, queryBuilder } = createKnexMock();
+
+		const service = new SavedQueryExportService({
+			knex: knex as never,
+			accountability: {
+				user: 'user-1',
+				role: 'role-1',
+				roles: ['role-1'],
+				admin: false,
+				app: false,
+				ip: null,
+			},
+			schema: {
+				collections: {
+					support_tickets: {
+						collection: 'support_tickets',
+						primary: 'id',
+						fields: {},
+					},
+				},
+				relations: [],
+			} as never,
+		});
+
+		const result = await service.exportSavedQuery({ savedQueryId: 'saved-query-1' });
+
+		expect(result.type).toBe('text/csv');
+		expect(result.filename).toContain('support_tickets-open-tickets');
+		expect(result.body).toContain('Broken login');
+		expect(result.body).not.toContain('redacted-by-transform');
+		expect(queryBuilder.where).toHaveBeenCalledWith('status', 'open');
+		expect(queryBuilder.select).toHaveBeenCalledWith(['id', 'status', 'title', 'email']);
+	});
+
+	it('allows shared saved queries for other users', async () => {
+		const { knex, savedQueryBuilder } = createKnexMock();
+		savedQueryBuilder.first.mockResolvedValueOnce({
+			id: 'saved-query-2',
+			collection: 'support_tickets',
+			name: 'shared-open-tickets',
+			user_created: 'user-1',
+			query: {
+				filter: {
+					status: {
+						_eq: 'open',
+					},
+				},
+				fields: ['id', 'status', 'title', 'email'],
+			},
+			fields: null,
+			format: 'json',
+			shared: true,
+		});
+
+		const service = new SavedQueryExportService({
+			knex: knex as never,
+			accountability: {
+				user: 'user-2',
+				role: 'role-2',
+				roles: ['role-2'],
+				admin: false,
+				app: false,
+				ip: null,
+			},
+			schema: {
+				collections: {
+					support_tickets: {
+						collection: 'support_tickets',
+						primary: 'id',
+						fields: {},
+					},
+				},
+				relations: [],
+			} as never,
+		});
+
+		const result = await service.exportSavedQuery({ savedQueryId: 'saved-query-2', format: 'json' });
+
+		expect(result.type).toBe('application/json');
+		expect(result.body).toContain('customer@example.com');
+	});
+
+	it('supports _or filters and limit overrides', async () => {
+		const { knex, queryBuilder, savedQueryBuilder } = createKnexMock();
+		savedQueryBuilder.first.mockResolvedValueOnce({
+			id: 'saved-query-3',
+			collection: 'support_tickets',
+			name: 'regional-tickets',
+			user_created: 'user-1',
+			query: {
+				filter: {
+					_or: [
+						{ region: { _eq: 'us' } },
+						{ region: { _eq: 'eu' } },
+					],
+				},
+				fields: ['id', 'region', 'title'],
+			},
+			fields: null,
+			format: 'csv',
+			shared: false,
+		});
+
+		const service = new SavedQueryExportService({
+			knex: knex as never,
+			accountability: {
+				user: 'user-1',
+				role: 'role-1',
+				roles: ['role-1'],
+				admin: false,
+				app: false,
+				ip: null,
+			},
+			schema: {
+				collections: {
+					support_tickets: {
+						collection: 'support_tickets',
+						primary: 'id',
+						fields: {},
+					},
+				},
+				relations: [],
+			} as never,
+		});
+
+		await service.exportSavedQuery({ savedQueryId: 'saved-query-3', limit: 100 });
+
+		expect(queryBuilder.orWhere).toHaveBeenCalled();
+		expect(queryBuilder.limit).toHaveBeenCalledWith(100);
+	});
+});
```

## Intended Flaws

### Flaw 1: Saved Query Export Bypasses Permission-Aware Query Processing

- `type`: `permission_bypass`
- `location`: `api/src/services/saved-query-export.ts:48-127`, `api/src/services/saved-query-export.ts:129-194`, `api/src/controllers/utils.ts:184-216`, `api/src/services/saved-query-export.test.ts:68-205`
- `learner_prompt`: Does the saved-query export execute through the same permission-aware read path as normal item reads and exports?

Expected answer:

- `identify`: The service reads directly from Knex with `this.knex(collection).select(fields)` and manually applies the saved filter. It never calls `sanitizeQuery`, `ItemsService.readByQuery`, `getAstFromQuery`, or `processAst`. The owner/shared check only controls access to the saved-query record; it does not apply the caller's row permissions, field permissions, relation permissions, dynamic variables, aliases, deep filters, or app/public accountability constraints to the exported collection.
- `impact`: A user can export fields or rows they cannot normally read if a saved query contains broad fields, relation paths, dynamic filters, or raw field names. Shared saved queries are especially dangerous: the creator's intent gets reused under another user's accountability, but the collection read ignores that user's permissions. Directus users expect exports to obey the same permissions as item reads; this endpoint creates a shadow read API.
- `fix_direction`: Treat saved queries as stored query input, not executable database plans. Load the saved query, merge allowed overrides, run `sanitizeQuery(..., req.schema, req.accountability)`, then delegate to `ExportService.exportToFile` or `ItemsService.readByQuery` with the current accountability. The existing AST permission pipeline must own filter compilation and field projection.

Hints:

1. Separate "can I access this saved query object?" from "can I read the rows this query returns?"
2. Find the line where the collection is read. Is it using `ItemsService.readByQuery`?
3. A hand-written `_eq`/`_or` compiler is not Directus' permission-aware query compiler.

### Flaw 2: Export Buffers The Entire Result In Memory And Response Body

- `type`: `performance_regression`
- `location`: `api/src/services/saved-query-export.ts:48-63`, `api/src/services/saved-query-export.ts:107-127`, `api/src/services/saved-query-export.ts:196-221`, `api/src/controllers/utils.ts:199-215`
- `learner_prompt`: What happens when a saved query matches hundreds of thousands of items?

Expected answer:

- `identify`: `exportSavedQuery` awaits all rows, transforms all rows into a single string, stores the entire export in `result.body`, and sends it in the request response. It does not use the existing export batching behavior, temporary file path, background export pattern, or streaming response. `limit: -1` is the default, so large saved queries can load the entire collection.
- `impact`: Large exports can exhaust Node memory, block the event loop during CSV/JSON serialization, hold DB connections for too long, time out HTTP requests, and make one user's export degrade the API for everyone. This regresses from Directus' existing export service, which pages through `EXPORT_BATCH_SIZE` and appends batches to a temp file.
- `fix_direction`: Reuse `ExportService.exportToFile` for saved queries, or implement a streaming/batched exporter with cursor/keyset pagination, bounded memory, backpressure, and background notification semantics. The endpoint should return an accepted/background job or streamed file, not build one giant string.

Hints:

1. Compare the new export path to `ExportService.exportToFile`.
2. Look for `await rowsQuery` and the place CSV/JSON is built.
3. A query called "saved" can still match millions of rows.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that collection reads bypass Directus' permission-aware query pipeline. Answers that only say "SQL injection risk" are incomplete unless they connect the direct Knex query to missing row/field/dynamic-permission enforcement.

For flaw 2, a correct answer must identify full-result buffering. Answers that only say "exports can be slow" are incomplete unless they explain that the existing exporter already has a batched design and this PR regresses it.

### Product-Level Change

The PR adds a convenience workflow: save a collection query once, export it later. The product intent is good. The dangerous part is that "saved query" sounds like a small wrapper around export, but the implementation creates a new read engine and a new export engine.

### Changed Contracts

- API contract: `POST /utils/export/saved-query/:id` returns a file response directly.
- Query contract: stored query JSON is treated as executable filter/projection input.
- Permission contract: saved-query ownership is checked, but collection read permissions are not applied.
- Export contract: saved-query exports are synchronous and in-memory, unlike existing background/batched exports.
- Data contract: a new `directus_saved_queries` table stores collection, query, fields, format, owner, and sharing state.

### Failure Modes

A manager creates a shared saved query for `support_tickets` with fields `id,title,email,internal_notes`. An agent whose role cannot read `email` or `internal_notes` calls the saved-query export. The service checks that the query is shared, then selects those fields directly from Knex and returns them.

A saved query for `orders` uses `limit: -1` and matches 800,000 rows. The service loads every row into memory, then creates a giant CSV string and sends it in one HTTP response. The API process spikes memory, stalls, and can crash before the request completes.

### Reviewer Thought Process

A strong reviewer starts with the existing contract: Directus item reads are not normal SQL reads. They are permission-processed AST reads. Any PR that reads a collection directly must justify why it is outside the item permission model. This one does not have that justification.

The second move is to compare with the existing exporter. When a codebase already solved batching, temporary files, and notification flow, a new exporter that returns `body: string` should make the reviewer slow down immediately.

### Better Implementation Direction

Make saved-query export a thin wrapper:

- Read the saved-query record with an ownership/share check.
- Merge caller-approved overrides.
- Sanitize the resulting query with the caller's accountability.
- Delegate to `ExportService.exportToFile` or a shared batched export primitive.
- Preserve the existing background notification behavior for large exports.
- Add tests that compare saved-query export permissions with normal `ItemsService.readByQuery` permissions.

## Why This Case Exists

This case trains a very common review reflex: convenience features must not fork the security-critical path. If a codebase has a central permission-aware query engine, new APIs should compose it. If a codebase has a central large-export path, new exports should compose it too.
