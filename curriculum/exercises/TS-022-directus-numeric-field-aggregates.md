# TS-022: Directus Numeric Field Aggregates

## Metadata

- `id`: TS-022
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: items controller, aggregate queries, field permissions, row policy filters, metadata counts, query sanitization
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 950-1,250
- `represented_diff_lines`: 1,094
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Directus accountability, field permissions, aggregate queries, row policies, metadata counts, AST processing, and inference leaks without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a dedicated aggregate endpoint for numeric fields in Directus item collections.

Directus already supports aggregate queries through the generic items read API, but dashboards and analytics panels often need a smaller response shape. This change adds `/items/:collection/aggregate` for sums, averages, mins, maxes, and grouped counts, plus `/items/:collection/count` for fast cardinality checks.

The PR adds:

- aggregate request/response types,
- an item aggregate service,
- new REST routes under the items controller,
- query parsing for aggregate filters and group fields,
- generated OpenAPI route metadata,
- unit tests for aggregate math, grouped results, and count responses.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `api/src/controllers/items.ts` reads collection items by instantiating `ItemsService` with `req.accountability` and passing `req.sanitizedQuery`.
- `api/src/utils/sanitize-query.ts` parses `aggregate`, `filter`, `groupBy`, `fields`, `sort`, and `meta` query parameters.
- `api/src/services/items.ts` implements `readByQuery()` by building an AST, calling `processAst()`, then executing `runAst()`.
- `api/src/permissions/modules/process-ast/utils/extract-paths-from-query.ts` explicitly extracts fields used by `aggregate` and `group` so permissions can be checked.
- `api/src/permissions/modules/process-ast/process-ast.ts` validates field existence, validates field permissions, and injects permission cases before the query runs.
- `api/src/database/run-ast/lib/apply-query/index.ts` applies permission cases through `joinFilterWithCases()` before aggregating.
- `api/src/services/meta.ts` implements `filterCount()` by calling `validateAccess()`, fetching permissions, deriving row-permission cases with `getCases()`, and applying those cases before counting.
- `api/src/permissions/modules/fetch-allowed-fields/fetch-allowed-fields.ts` is the existing helper for determining field-level read access.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/types/src/items-aggregate.ts`
- `packages/types/src/services.ts`
- `api/src/services/items-aggregate.ts`
- `api/src/services/index.ts`
- `api/src/controllers/items.ts`
- `api/src/utils/sanitize-aggregate-request.ts`
- `api/src/openapi/routes/items-aggregate.ts`
- `api/src/services/items-aggregate.test.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on whether the new endpoint preserves Directus's existing field and row-level permission contracts.

## Diff

```diff
diff --git a/packages/types/src/items-aggregate.ts b/packages/types/src/items-aggregate.ts
new file mode 100644
index 0000000000..89c4d8d77a
--- /dev/null
+++ b/packages/types/src/items-aggregate.ts
@@ -0,0 +1,120 @@
+import type { Filter } from './filter.js';
+
+export type NumericAggregateOperation = 'sum' | 'avg' | 'min' | 'max';
+
+export type CountAggregateOperation = 'count';
+
+export type ItemsAggregateOperation = NumericAggregateOperation | CountAggregateOperation;
+
+export type ItemsAggregateRequest = {
+	collection: string;
+	fields: string[];
+	operations: ItemsAggregateOperation[];
+	filter?: Filter | null;
+	groupBy?: string[] | null;
+	search?: string | null;
+	limit?: number | null;
+};
+
+export type ItemsAggregateResultValue = {
+	field: string;
+	operation: ItemsAggregateOperation;
+	value: number | null;
+};
+
+export type ItemsAggregateGroup = {
+	group: Record<string, string | number | boolean | null>;
+	values: ItemsAggregateResultValue[];
+	count: number;
+};
+
+export type ItemsAggregateResponse = {
+	collection: string;
+	values: ItemsAggregateResultValue[];
+	groups?: ItemsAggregateGroup[];
+};
+
+export type ItemsCountRequest = {
+	collection: string;
+	filter?: Filter | null;
+	search?: string | null;
+};
+
+export type ItemsCountResponse = {
+	collection: string;
+	count: number;
+};
+
+export type AggregateFieldInfo = {
+	field: string;
+	type: string;
+	dbColumn: string;
+};
+
+export const NUMERIC_FIELD_TYPES = [
+	'integer',
+	'bigInteger',
+	'float',
+	'decimal',
+	'double',
+] as const;
+
+export function isNumericFieldType(type: string) {
+	return NUMERIC_FIELD_TYPES.includes(type as (typeof NUMERIC_FIELD_TYPES)[number]);
+}
diff --git a/packages/types/src/services.ts b/packages/types/src/services.ts
index 819370fe93..6c8c511a4d 100644
--- a/packages/types/src/services.ts
+++ b/packages/types/src/services.ts
@@ -1,5 +1,12 @@
 import type { Accountability } from './accountability.js';
+import type {
+	ItemsAggregateRequest,
+	ItemsAggregateResponse,
+	ItemsCountRequest,
+	ItemsCountResponse,
+} from './items-aggregate.js';
 import type { Item, PrimaryKey } from './items.js';
 import type { Query } from './query.js';
 
@@ -685,6 +692,14 @@ export interface Services {
 		options: AbstractServiceOptions,
 	) => AbstractService & ItemsService<T>;
 
+	ItemsAggregateService: new (
+		options: AbstractServiceOptions,
+	) => {
+		aggregate(request: ItemsAggregateRequest): Promise<ItemsAggregateResponse>;
+		count(request: ItemsCountRequest): Promise<ItemsCountResponse>;
+	};
+
 	/**
 	 * The PermissionsService
 	 */
diff --git a/api/src/services/items-aggregate.ts b/api/src/services/items-aggregate.ts
new file mode 100644
index 0000000000..90fd77b432
--- /dev/null
+++ b/api/src/services/items-aggregate.ts
@@ -0,0 +1,292 @@
+import { Action } from '@directus/constants';
+import { InvalidQueryError } from '@directus/errors';
+import type {
+	AbstractServiceOptions,
+	Accountability,
+	AggregateFieldInfo,
+	Filter,
+	ItemsAggregateOperation,
+	ItemsAggregateRequest,
+	ItemsAggregateResponse,
+	ItemsCountRequest,
+	ItemsCountResponse,
+	SchemaOverview,
+} from '@directus/types';
+import { isNumericFieldType } from '@directus/types';
+import type { Knex } from 'knex';
+import getDatabase from '../database/index.js';
+import emitter from '../emitter.js';
+import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
+
+type AggregateRow = Record<string, string | number | null>;
+
+const AGGREGATE_OPERATIONS = new Set<ItemsAggregateOperation>(['sum', 'avg', 'min', 'max', 'count']);
+
+const DB_OPERATION: Record<ItemsAggregateOperation, string> = {
+	sum: 'sum',
+	avg: 'avg',
+	min: 'min',
+	max: 'max',
+	count: 'count',
+};
+
+export class ItemsAggregateService {
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
+	async aggregate(request: ItemsAggregateRequest): Promise<ItemsAggregateResponse> {
+		await this.assertCanReadCollection(request.collection);
+
+		const collection = this.schema.collections[request.collection];
+		if (!collection) {
+			throw new InvalidQueryError({ reason: `Collection "${request.collection}" does not exist` });
+		}
+
+		const fields = this.resolveNumericFields(request.collection, request.fields);
+		const operations = this.resolveOperations(request.operations);
+		const groupBy = this.resolveGroupByFields(request.collection, request.groupBy ?? []);
+		const query = this.knex(request.collection);
+
+		this.applyFilter(query, request.filter ?? null);
+		this.applySearch(query, request.collection, request.search ?? null);
+
+		for (const groupField of groupBy) {
+			query.select(`${request.collection}.${groupField.dbColumn}`, { as: `group__${groupField.field}` });
+			query.groupBy(`${request.collection}.${groupField.dbColumn}`);
+		}
+
+		for (const field of fields) {
+			for (const operation of operations) {
+				if (operation === 'count') {
+					continue;
+				}
+				const alias = this.aliasFor(operation, field.field);
+				const dbOperation = DB_OPERATION[operation];
+				(query as any)[dbOperation](`${request.collection}.${field.dbColumn}`, { as: alias });
+			}
+		}
+
+		if (operations.includes('count')) {
+			query.count('*', { as: this.aliasFor('count', '*') });
+		}
+
+		if (request.limit && groupBy.length > 0) {
+			query.limit(request.limit);
+		}
+
+		const rows = (await query) as AggregateRow[];
+		const response = this.toAggregateResponse(request.collection, rows, fields, operations, groupBy);
+
+		await emitter.emitAction(
+			[Action.READ, `${request.collection}.items.aggregate`],
+			{
+				collection: request.collection,
+				fields: request.fields,
+				operations,
+				filter: request.filter,
+				groupBy: request.groupBy,
+			},
+			{
+				accountability: this.accountability,
+				database: this.knex,
+				schema: this.schema,
+			},
+		);
+
+		return response;
+	}
+
+	async count(request: ItemsCountRequest): Promise<ItemsCountResponse> {
+		await this.assertCanReadCollection(request.collection);
+
+		const collection = this.schema.collections[request.collection];
+		if (!collection) {
+			throw new InvalidQueryError({ reason: `Collection "${request.collection}" does not exist` });
+		}
+
+		const query = this.knex(request.collection);
+		this.applyFilter(query, request.filter ?? null);
+		this.applySearch(query, request.collection, request.search ?? null);
+		query.count('*', { as: 'count' });
+
+		const rows = (await query) as Array<{ count: string | number | null }>;
+		const count = Number(rows[0]?.count ?? 0);
+
+		await emitter.emitAction(
+			[Action.READ, `${request.collection}.items.count`],
+			{
+				collection: request.collection,
+				filter: request.filter,
+				search: request.search,
+				count,
+			},
+			{
+				accountability: this.accountability,
+				database: this.knex,
+				schema: this.schema,
+			},
+		);
+
+		return {
+			collection: request.collection,
+			count,
+		};
+	}
+
+	private async assertCanReadCollection(collection: string) {
+		if (!this.accountability || this.accountability.admin) {
+			return;
+		}
+
+		await validateAccess(
+			{
+				accountability: this.accountability,
+				action: 'read',
+				collection,
+			},
+			{
+				knex: this.knex,
+				schema: this.schema,
+			},
+		);
+	}
+
+	private resolveNumericFields(collection: string, requestedFields: string[]): AggregateFieldInfo[] {
+		if (!requestedFields.length) {
+			throw new InvalidQueryError({ reason: 'At least one aggregate field is required' });
+		}
+
+		return requestedFields.map((field) => {
+			const fieldSchema = this.schema.collections[collection]?.fields[field];
+
+			if (!fieldSchema) {
+				throw new InvalidQueryError({ reason: `Field "${field}" does not exist on "${collection}"` });
+			}
+
+			if (fieldSchema.alias === true) {
+				throw new InvalidQueryError({ reason: `Field "${field}" is an alias and cannot be aggregated` });
+			}
+
+			if (!isNumericFieldType(fieldSchema.type)) {
+				throw new InvalidQueryError({ reason: `Field "${field}" is not numeric` });
+			}
+
+			return {
+				field,
+				type: fieldSchema.type,
+				dbColumn: fieldSchema.field,
+			};
+		});
+	}
+
+	private resolveGroupByFields(collection: string, requestedFields: string[]): AggregateFieldInfo[] {
+		return requestedFields.map((field) => {
+			const fieldSchema = this.schema.collections[collection]?.fields[field];
+
+			if (!fieldSchema) {
+				throw new InvalidQueryError({ reason: `Group field "${field}" does not exist on "${collection}"` });
+			}
+
+			if (fieldSchema.alias === true) {
+				throw new InvalidQueryError({ reason: `Group field "${field}" is an alias and cannot be grouped` });
+			}
+
+			return {
+				field,
+				type: fieldSchema.type,
+				dbColumn: fieldSchema.field,
+			};
+		});
+	}
+
+	private resolveOperations(operations: ItemsAggregateOperation[]) {
+		if (!operations.length) {
+			throw new InvalidQueryError({ reason: 'At least one aggregate operation is required' });
+		}
+
+		for (const operation of operations) {
+			if (!AGGREGATE_OPERATIONS.has(operation)) {
+				throw new InvalidQueryError({ reason: `Unsupported aggregate operation "${operation}"` });
+			}
+		}
+
+		return operations;
+	}
+
+	private applyFilter(query: Knex.QueryBuilder, filter: Filter | null) {
+		if (!filter) {
+			return;
+		}
+
+		for (const [field, condition] of Object.entries(filter)) {
+			if (field.startsWith('_')) {
+				continue;
+			}
+
+			const operators = condition as Record<string, unknown>;
+
+			if ('_eq' in operators) {
+				query.where(field, operators['_eq']);
+			}
+
+			if ('_neq' in operators) {
+				query.whereNot(field, operators['_neq']);
+			}
+
+			if ('_in' in operators && Array.isArray(operators['_in'])) {
+				query.whereIn(field, operators['_in']);
+			}
+		}
+	}
+
+	private applySearch(query: Knex.QueryBuilder, collection: string, search: string | null) {
+		if (!search) {
+			return;
+		}
+
+		const searchableFields = Object.values(this.schema.collections[collection]?.fields ?? {}).filter((field) =>
+			['string', 'text', 'uuid'].includes(field.type),
+		);
+
+		query.andWhere((builder) => {
+			for (const field of searchableFields) {
+				builder.orWhereLike(`${collection}.${field.field}`, `%${search}%`);
+			}
+		});
+	}
+
+	private aliasFor(operation: ItemsAggregateOperation, field: string) {
+		return `${operation}__${field.replace(/\./g, '__')}`;
+	}
+
+	private toAggregateResponse(
+		collection: string,
+		rows: AggregateRow[],
+		fields: AggregateFieldInfo[],
+		operations: ItemsAggregateOperation[],
+		groupBy: AggregateFieldInfo[],
+	): ItemsAggregateResponse {
+		const values = fields.flatMap((field) =>
+			operations
+				.filter((operation) => operation !== 'count')
+				.map((operation) => ({
+					field: field.field,
+					operation,
+					value: this.readNumber(rows[0], this.aliasFor(operation, field.field)),
+				})),
+		);
+
+		if (operations.includes('count')) {
+			values.push({
+				field: '*',
+				operation: 'count',
+				value: this.readNumber(rows[0], this.aliasFor('count', '*')),
+			});
+		}
+
+		if (!groupBy.length) {
+			return {
+				collection,
+				values,
+			};
+		}
+
+		return {
+			collection,
+			values: [],
+			groups: rows.map((row) => ({
+				group: Object.fromEntries(groupBy.map((field) => [field.field, row[`group__${field.field}`] ?? null])),
+				values: fields.flatMap((field) =>
+					operations
+						.filter((operation) => operation !== 'count')
+						.map((operation) => ({
+							field: field.field,
+							operation,
+							value: this.readNumber(row, this.aliasFor(operation, field.field)),
+						})),
+				),
+				count: Number(row[this.aliasFor('count', '*')] ?? 0),
+			})),
+		};
+	}
+
+	private readNumber(row: AggregateRow | undefined, key: string) {
+		if (!row || row[key] === null || row[key] === undefined) {
+			return null;
+		}
+
+		return Number(row[key]);
+	}
+}
diff --git a/api/src/services/index.ts b/api/src/services/index.ts
index 48f16cdf87..d8892ab9cc 100644
--- a/api/src/services/index.ts
+++ b/api/src/services/index.ts
@@ -13,6 +13,7 @@ export { FilesService } from './files.js';
 export { FlowsService } from './flows.js';
 export { FoldersService } from './folders.js';
 export { ItemsService } from './items.js';
+export { ItemsAggregateService } from './items-aggregate.js';
 export { MailService } from './mail.js';
 export { MetaService } from './meta.js';
 export { NotificationsService } from './notifications.js';
diff --git a/api/src/controllers/items.ts b/api/src/controllers/items.ts
index 22261ecbf0..d78fb2e501 100644
--- a/api/src/controllers/items.ts
+++ b/api/src/controllers/items.ts
@@ -7,8 +7,10 @@ import collectionExists from '../middleware/collection-exists.js';
 import { respond } from '../middleware/respond.js';
 import { validateBatch } from '../middleware/validate-batch.js';
 import { ItemsService } from '../services/items.js';
+import { ItemsAggregateService } from '../services/items-aggregate.js';
 import { MetaService } from '../services/meta.js';
 import asyncHandler from '../utils/async-handler.js';
+import { sanitizeAggregateRequest, sanitizeCountRequest } from '../utils/sanitize-aggregate-request.js';
 import { sanitizeQuery } from '../utils/sanitize-query.js';
 
 const router = express.Router();
@@ -90,6 +92,64 @@ const readHandler = asyncHandler(async (req, res, next) => {
 	return next();
 });
 
+const aggregateHandler = asyncHandler(async (req, res, next) => {
+	if (isSystemCollection(req.params['collection']!)) throw new ForbiddenError();
+
+	const aggregateRequest = await sanitizeAggregateRequest(
+		{
+			collection: req.collection,
+			...req.query,
+		},
+		req.schema,
+		req.accountability,
+	);
+
+	const service = new ItemsAggregateService({
+		accountability: req.accountability,
+		schema: req.schema,
+	});
+
+	const result = await service.aggregate(aggregateRequest);
+
+	res.locals['payload'] = {
+		data: result,
+	};
+
+	return next();
+});
+
+const countHandler = asyncHandler(async (req, res, next) => {
+	if (isSystemCollection(req.params['collection']!)) throw new ForbiddenError();
+
+	const countRequest = await sanitizeCountRequest(
+		{
+			collection: req.collection,
+			...req.query,
+		},
+		req.schema,
+		req.accountability,
+	);
+
+	const service = new ItemsAggregateService({
+		accountability: req.accountability,
+		schema: req.schema,
+	});
+
+	const result = await service.count(countRequest);
+
+	res.locals['payload'] = {
+		data: result,
+	};
+
+	return next();
+});
+
+router.get('/:collection/aggregate', collectionExists, aggregateHandler, respond);
+router.search('/:collection/aggregate', collectionExists, aggregateHandler, respond);
+router.get('/:collection/count', collectionExists, countHandler, respond);
+router.search('/:collection/count', collectionExists, countHandler, respond);
+
 router.search('/:collection', collectionExists, validateBatch('read'), readHandler, respond);
 router.get('/:collection', collectionExists, readHandler, respond);
 
diff --git a/api/src/utils/sanitize-aggregate-request.ts b/api/src/utils/sanitize-aggregate-request.ts
new file mode 100644
index 0000000000..c29fd9c35a
--- /dev/null
+++ b/api/src/utils/sanitize-aggregate-request.ts
@@ -0,0 +1,164 @@
+import { InvalidQueryError } from '@directus/errors';
+import type {
+	Accountability,
+	ItemsAggregateOperation,
+	ItemsAggregateRequest,
+	ItemsCountRequest,
+	SchemaOverview,
+} from '@directus/types';
+import { parseJSON } from '@directus/utils';
+import { splitFields } from './split-fields.js';
+import { sanitizeQuery } from './sanitize-query.js';
+
+const DEFAULT_OPERATIONS: ItemsAggregateOperation[] = ['sum', 'avg', 'min', 'max'];
+
+function parseFieldList(input: unknown, label: string) {
+	if (!input) {
+		return [];
+	}
+
+	if (typeof input === 'string') {
+		return splitFields(input)
+			.map((field) => field.trim())
+			.filter(Boolean);
+	}
+
+	if (Array.isArray(input)) {
+		return input
+			.flatMap((value) => (typeof value === 'string' ? splitFields(value) : []))
+			.map((field) => field.trim())
+			.filter(Boolean);
+	}
+
+	throw new InvalidQueryError({ reason: `"${label}" must be a string or array` });
+}
+
+function parseOperations(input: unknown): ItemsAggregateOperation[] {
+	if (!input) {
+		return DEFAULT_OPERATIONS;
+	}
+
+	const operations = parseFieldList(input, 'operations') as ItemsAggregateOperation[];
+	if (!operations.length) {
+		throw new InvalidQueryError({ reason: '"operations" must not be empty' });
+	}
+
+	return operations;
+}
+
+function parseLimit(input: unknown) {
+	if (input === undefined || input === null || input === '') {
+		return null;
+	}
+
+	const value = Number(input);
+	if (!Number.isInteger(value) || value < 1 || value > 500) {
+		throw new InvalidQueryError({ reason: '"limit" must be an integer between 1 and 500' });
+	}
+
+	return value;
+}
+
+function parseMaybeJson(input: unknown, label: string) {
+	if (!input) {
+		return null;
+	}
+
+	if (typeof input === 'object') {
+		return input;
+	}
+
+	if (typeof input !== 'string') {
+		throw new InvalidQueryError({ reason: `"${label}" must be JSON` });
+	}
+
+	try {
+		return parseJSON(input);
+	} catch {
+		throw new InvalidQueryError({ reason: `"${label}" must be valid JSON` });
+	}
+}
+
+export async function sanitizeAggregateRequest(
+	raw: Record<string, unknown>,
+	schema: SchemaOverview,
+	accountability?: Accountability | null,
+): Promise<ItemsAggregateRequest> {
+	const filter = parseMaybeJson(raw['filter'], 'filter');
+	const sanitizedFilter = filter
+		? (
+				await sanitizeQuery(
+					{
+						filter,
+					},
+					schema,
+					accountability,
+				)
+			).filter ?? null
+		: null;
+
+	return {
+		collection: String(raw['collection']),
+		fields: parseFieldList(raw['fields'], 'fields'),
+		operations: parseOperations(raw['operations']),
+		groupBy: parseFieldList(raw['groupBy'], 'groupBy'),
+		filter: sanitizedFilter,
+		search: typeof raw['search'] === 'string' ? raw['search'].trim() : null,
+		limit: parseLimit(raw['limit']),
+	};
+}
+
+export async function sanitizeCountRequest(
+	raw: Record<string, unknown>,
+	schema: SchemaOverview,
+	accountability?: Accountability | null,
+): Promise<ItemsCountRequest> {
+	const filter = parseMaybeJson(raw['filter'], 'filter');
+	const sanitizedFilter = filter
+		? (
+				await sanitizeQuery(
+					{
+						filter,
+					},
+					schema,
+					accountability,
+				)
+			).filter ?? null
+		: null;
+
+	return {
+		collection: String(raw['collection']),
+		filter: sanitizedFilter,
+		search: typeof raw['search'] === 'string' ? raw['search'].trim() : null,
+	};
+}
diff --git a/api/src/openapi/routes/items-aggregate.ts b/api/src/openapi/routes/items-aggregate.ts
new file mode 100644
index 0000000000..7d148a0245
--- /dev/null
+++ b/api/src/openapi/routes/items-aggregate.ts
@@ -0,0 +1,127 @@
+export const ItemsAggregateRoute = {
+	path: '/items/{collection}/aggregate',
+	method: 'get',
+	summary: 'Aggregate numeric item fields',
+	parameters: [
+		{
+			name: 'collection',
+			in: 'path',
+			required: true,
+			schema: {
+				type: 'string',
+			},
+		},
+		{
+			name: 'fields',
+			in: 'query',
+			required: true,
+			schema: {
+				type: 'string',
+			},
+			description: 'Comma-separated numeric fields to aggregate',
+		},
+		{
+			name: 'operations',
+			in: 'query',
+			required: false,
+			schema: {
+				type: 'string',
+				default: 'sum,avg,min,max',
+			},
+		},
+		{
+			name: 'groupBy',
+			in: 'query',
+			required: false,
+			schema: {
+				type: 'string',
+			},
+		},
+		{
+			name: 'filter',
+			in: 'query',
+			required: false,
+			schema: {
+				type: 'string',
+			},
+		},
+	],
+	responses: {
+		200: {
+			description: 'Aggregate response',
+			content: {
+				'application/json': {
+					schema: {
+						type: 'object',
+						properties: {
+							data: {
+								type: 'object',
+								properties: {
+									collection: { type: 'string' },
+									values: {
+										type: 'array',
+										items: {
+											type: 'object',
+											properties: {
+												field: { type: 'string' },
+												operation: { type: 'string' },
+												value: { type: ['number', 'null'] },
+											},
+										},
+									},
+								},
+							},
+						},
+					},
+				},
+			},
+		},
+	},
+};
+
+export const ItemsCountRoute = {
+	path: '/items/{collection}/count',
+	method: 'get',
+	summary: 'Count items in a collection',
+	parameters: [
+		{
+			name: 'collection',
+			in: 'path',
+			required: true,
+			schema: {
+				type: 'string',
+			},
+		},
+		{
+			name: 'filter',
+			in: 'query',
+			required: false,
+			schema: {
+				type: 'string',
+			},
+		},
+		{
+			name: 'search',
+			in: 'query',
+			required: false,
+			schema: {
+				type: 'string',
+			},
+		},
+	],
+	responses: {
+		200: {
+			description: 'Count response',
+			content: {
+				'application/json': {
+					schema: {
+						type: 'object',
+						properties: {
+							data: {
+								type: 'object',
+								properties: {
+									collection: { type: 'string' },
+									count: { type: 'number' },
+								},
+							},
+						},
+					},
+				},
+			},
+		},
+	},
+};
diff --git a/api/src/services/items-aggregate.test.ts b/api/src/services/items-aggregate.test.ts
new file mode 100644
index 0000000000..9d08fc7a6a
--- /dev/null
+++ b/api/src/services/items-aggregate.test.ts
@@ -0,0 +1,259 @@
+import type { Accountability, SchemaOverview } from '@directus/types';
+import { describe, expect, test, vi } from 'vitest';
+import { ItemsAggregateService } from './items-aggregate.js';
+
+const schema = {
+	collections: {
+		orders: {
+			collection: 'orders',
+			primary: 'id',
+			accountability: 'all',
+			fields: {
+				id: {
+					field: 'id',
+					type: 'integer',
+					alias: false,
+				},
+				status: {
+					field: 'status',
+					type: 'string',
+					alias: false,
+				},
+				total: {
+					field: 'total',
+					type: 'decimal',
+					alias: false,
+				},
+				margin: {
+					field: 'margin',
+					type: 'decimal',
+					alias: false,
+				},
+				internal_cost: {
+					field: 'internal_cost',
+					type: 'decimal',
+					alias: false,
+				},
+			},
+		},
+	},
+} as unknown as SchemaOverview;
+
+function createQueryBuilder(rows: any[]) {
+	const state: any = {
+		table: null,
+		selects: [],
+		wheres: [],
+		groups: [],
+		operations: [],
+		limit: null,
+	};
+
+	const builder: any = {
+		select(...args: any[]) {
+			state.selects.push(args);
+			return builder;
+		},
+		groupBy(...args: any[]) {
+			state.groups.push(args);
+			return builder;
+		},
+		where(field: string, value: any) {
+			state.wheres.push({ type: 'where', field, value });
+			return builder;
+		},
+		whereNot(field: string, value: any) {
+			state.wheres.push({ type: 'whereNot', field, value });
+			return builder;
+		},
+		whereIn(field: string, value: any[]) {
+			state.wheres.push({ type: 'whereIn', field, value });
+			return builder;
+		},
+		andWhere(callback: any) {
+			callback(builder);
+			return builder;
+		},
+		orWhereLike(field: string, value: string) {
+			state.wheres.push({ type: 'orWhereLike', field, value });
+			return builder;
+		},
+		count(field: string, options: { as: string }) {
+			state.operations.push({ operation: 'count', field, as: options.as });
+			return builder;
+		},
+		sum(field: string, options: { as: string }) {
+			state.operations.push({ operation: 'sum', field, as: options.as });
+			return builder;
+		},
+		avg(field: string, options: { as: string }) {
+			state.operations.push({ operation: 'avg', field, as: options.as });
+			return builder;
+		},
+		min(field: string, options: { as: string }) {
+			state.operations.push({ operation: 'min', field, as: options.as });
+			return builder;
+		},
+		max(field: string, options: { as: string }) {
+			state.operations.push({ operation: 'max', field, as: options.as });
+			return builder;
+		},
+		limit(value: number) {
+			state.limit = value;
+			return builder;
+		},
+		then(resolve: any) {
+			return Promise.resolve(rows).then(resolve);
+		},
+	};
+
+	const knex: any = vi.fn((table: string) => {
+		state.table = table;
+		return builder;
+	});
+
+	knex._state = state;
+	return knex;
+}
+
+describe('ItemsAggregateService', () => {
+	test('aggregates numeric fields for an admin', async () => {
+		const knex = createQueryBuilder([
+			{
+				'sum__total': '100',
+				'avg__total': '25',
+				'min__total': '10',
+				'max__total': '40',
+			},
+		]);
+
+		const service = new ItemsAggregateService({
+			knex,
+			schema,
+			accountability: {
+				admin: true,
+			} as Accountability,
+		});
+
+		const result = await service.aggregate({
+			collection: 'orders',
+			fields: ['total'],
+			operations: ['sum', 'avg', 'min', 'max'],
+		});
+
+		expect(result.values).toEqual([
+			{ field: 'total', operation: 'sum', value: 100 },
+			{ field: 'total', operation: 'avg', value: 25 },
+			{ field: 'total', operation: 'min', value: 10 },
+			{ field: 'total', operation: 'max', value: 40 },
+		]);
+
+		expect(knex._state.operations).toEqual([
+			{ operation: 'sum', field: 'orders.total', as: 'sum__total' },
+			{ operation: 'avg', field: 'orders.total', as: 'avg__total' },
+			{ operation: 'min', field: 'orders.total', as: 'min__total' },
+			{ operation: 'max', field: 'orders.total', as: 'max__total' },
+		]);
+	});
+
+	test('supports grouping aggregates by a plain field', async () => {
+		const knex = createQueryBuilder([
+			{
+				group__status: 'open',
+				sum__total: '150',
+				count__*: '3',
+			},
+			{
+				group__status: 'closed',
+				sum__total: '90',
+				count__*: '2',
+			},
+		]);
+
+		const service = new ItemsAggregateService({
+			knex,
+			schema,
+			accountability: {
+				admin: true,
+			} as Accountability,
+		});
+
+		const result = await service.aggregate({
+			collection: 'orders',
+			fields: ['total'],
+			operations: ['sum', 'count'],
+			groupBy: ['status'],
+		});
+
+		expect(result.groups).toEqual([
+			{
+				group: { status: 'open' },
+				values: [{ field: 'total', operation: 'sum', value: 150 }],
+				count: 3,
+			},
+			{
+				group: { status: 'closed' },
+				values: [{ field: 'total', operation: 'sum', value: 90 }],
+				count: 2,
+			},
+		]);
+	});
+
+	test('rejects non-numeric aggregate fields', async () => {
+		const knex = createQueryBuilder([]);
+		const service = new ItemsAggregateService({
+			knex,
+			schema,
+			accountability: {
+				admin: true,
+			} as Accountability,
+		});
+
+		await expect(
+			service.aggregate({
+				collection: 'orders',
+				fields: ['status'],
+				operations: ['avg'],
+			}),
+		).rejects.toThrow('not numeric');
+	});
+
+	test('counts collection rows for dashboard cards', async () => {
+		const knex = createQueryBuilder([
+			{
+				count: '42',
+			},
+		]);
+
+		const service = new ItemsAggregateService({
+			knex,
+			schema,
+			accountability: {
+				admin: true,
+			} as Accountability,
+		});
+
+		const result = await service.count({
+			collection: 'orders',
+			filter: {
+				status: {
+					_eq: 'open',
+				},
+			},
+		});
+
+		expect(result).toEqual({
+			collection: 'orders',
+			count: 42,
+		});
+
+		expect(knex._state.wheres).toEqual([
+			{
+				type: 'where',
+				field: 'status',
+				value: 'open',
+			},
+		]);
+	});
+
+	test('allows non-admin users with collection read access to request aggregates', async () => {
+		const knex = createQueryBuilder([
+			{
+				sum__internal_cost: '900',
+			},
+		]);
+
+		const service = new ItemsAggregateService({
+			knex,
+			schema,
+			accountability: {
+				admin: false,
+				user: 'user-1',
+				role: 'role-1',
+			} as Accountability,
+		});
+
+		await expect(
+			service.aggregate({
+				collection: 'orders',
+				fields: ['internal_cost'],
+				operations: ['sum'],
+			}),
+		).resolves.toMatchObject({
+			values: [{ field: 'internal_cost', operation: 'sum', value: 900 }],
+		});
+	});
+});
```

## Intended Flaws

### Flaw 1: Aggregate Fields Bypass Field-Level Read Permissions

- `type`: `field_permission_inference`
- `location`: `api/src/services/items-aggregate.ts:53-74`, `api/src/services/items-aggregate.ts:137-166`, `api/src/services/items-aggregate.ts:170-190`, `api/src/services/items-aggregate.test.ts:222-257`
- `learner_prompt`: What stops a user who can read `orders.status` and `orders.total` from aggregating `orders.internal_cost`?

Expected answer:

- `identify`: The aggregate service only calls `validateAccess()` at the collection level. It validates that requested aggregate and group fields exist and are numeric/plain schema fields, but it never calls `fetchAllowedFields()`, `processAst()`, `ItemsService.readByQuery()`, or any equivalent field-permission validation for `fields` and `groupBy`. The test explicitly allows a non-admin user to aggregate `internal_cost`.
- `impact`: Aggregates leak restricted field values through inference. A role that cannot read `internal_cost`, `salary`, `margin`, or `discount_floor` can still request `sum`, `avg`, `min`, or `max` and learn sensitive business data. Grouped aggregates make the leak worse because a user can slice by visible fields and reconstruct hidden values for small cohorts.
- `fix_direction`: Route aggregate reads through the existing Directus query planner (`ItemsService.readByQuery` with `aggregate`/`group`) or reuse the same AST permission path. At minimum, derive the allowed read fields for the current accountability and reject aggregate/group fields that are not allowed. Add non-admin tests where a field is hidden but the collection is readable, and assert aggregate requests fail before SQL is built.

Hints:

1. `validateAccess()` answers collection/action access, not every field used in a query.
2. The real `extractPathsFromQuery()` already knows how to extract aggregate fields for permission validation.
3. Aggregates over hidden numeric fields are still reads.

### Flaw 2: The Count Endpoint Ignores Row-Level Permission Policies

- `type`: `row_policy_cardinality_leak`
- `location`: `api/src/services/items-aggregate.ts:101-134`, `api/src/services/items-aggregate.ts:203-235`, `api/src/services/items-aggregate.test.ts:185-220`, `api/src/controllers/items.ts:118-146`
- `learner_prompt`: Does `/items/:collection/count` count the rows this accountability can read, or the rows that match only the caller-supplied filter?

Expected answer:

- `identify`: `ItemsAggregateService.count()` validates collection read access, then creates a raw `knex(collection)` query, applies the caller filter/search, and counts `*`. It does not fetch read permissions, derive `getCases()`, call `MetaService.filterCount()`, or run the request through `processAst()`/`applyQuery()` with permission cases. Row-level permission filters are absent from the count query.
- `impact`: Users can learn cardinality for records they cannot read. For example, a sales rep restricted to their own region can call count with `status=open` or `customer_tier=enterprise` and learn global pipeline size. Even when item payloads are protected, cardinality leaks can reveal tenant activity, revenue distribution, incident volume, or whether a sensitive record exists.
- `fix_direction`: Reuse `MetaService.filterCount()` or the same query planner used by `ItemsService.readByQuery`, because those paths already merge row-policy cases with user filters. Add tests where the role has a row policy such as `owner = $CURRENT_USER`; count should match only visible rows. Also test `total_count`, `filter_count`, aggregate count, and the new count endpoint for parity.

Hints:

1. Compare this count implementation with `MetaService.filterCount()`.
2. Search for `getCases()` or `joinFilterWithCases()` in the new service.
3. Cardinality can be sensitive even when no row data is returned.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that the endpoint validates schema shape but not field-level read permissions for aggregate/group fields. Answers that only say "restricted fields might leak" are incomplete unless they point to the missing permission path.

For flaw 2, a correct answer must identify that count uses a raw collection query without row-policy cases. Answers that only say "count should use permissions" are incomplete unless they explain the cardinality leak and name the existing safe path.

### Product-Level Change

The PR tries to make analytics-style dashboard calls cheaper by adding dedicated aggregate and count endpoints. That is a reasonable product need: clients often want summary numbers without fetching rows.

### Changed Contracts

- REST contract: `/items/:collection/aggregate` and `/items/:collection/count` become new read surfaces.
- Permission contract: aggregate and count results must represent what the current accountability is allowed to read.
- Field contract: numeric aggregate fields are still field reads.
- Row-policy contract: counts must include the same permission filters as item reads.
- Observability contract: aggregate/count reads emit Directus read actions.

### Failure Modes

A finance role can read order totals but not margins. The dashboard uses the new aggregate endpoint. A curious user calls `fields=margin&operations=avg,max` and learns margin distribution without ever being able to fetch the `margin` column.

A support role is restricted to tickets assigned to them. The new count endpoint validates that the role can read the `tickets` collection, then counts every row where `severity = critical`. The user learns global incident volume despite row policies hiding those tickets.

### Reviewer Thought Process

A strong reviewer notices that "summary" endpoints are still read endpoints. The absence of item payloads does not remove the need for the same permission model. They compare the new implementation against the mature path Directus already has for aggregate queries and metadata counts.

Then they ask whether the shortcut is worth owning forever. If two query paths answer the same product question but only one applies field and row policies correctly, the new path is not an optimization. It is a second authorization engine.

### Better Implementation Direction

- Prefer `ItemsService.readByQuery()` with `aggregate` and `group` for aggregate reads.
- Prefer `MetaService.filterCount()` for count reads.
- If a specialized service is still needed, make it call the same AST processing and permission-case helpers.
- Validate aggregate fields, group fields, filters, aliases, and search fields through the same path as normal reads.
- Add non-admin regression tests for hidden fields, row policies, grouped aggregates, `count(*)`, `filter_count`, and `total_count` parity.

## Why This Case Exists

This case teaches that performance shortcuts around mature authorization paths are dangerous. Great reviewers do not ask only whether the SQL returns the right number; they ask whether the number is allowed to exist for this caller.
