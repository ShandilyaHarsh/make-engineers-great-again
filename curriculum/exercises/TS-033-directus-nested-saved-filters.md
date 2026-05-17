# TS-033: Directus Nested Saved Filters

## Metadata

- `id`: TS-033
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: saved filters, presets, query filter parsing, SDK query serialization, filter operator compatibility, API validation
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,250-1,550
- `represented_diff_lines`: 1313
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Directus filter semantics, saved-query compatibility, parser versioning, unknown operator handling, and widened-read failure modes without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds nested saved filters to Directus presets.

Directus already lets users save presets/bookmarks with a `filter` object. The existing shape is powerful, but it is hard to build visual saved-filter editors on top of raw `_and` and `_or` objects. This PR adds a normalized nested filter tree that can represent groups, labels, and future UI metadata while still compiling back to the normal Directus query filter shape.

The new work includes:

- a `NestedSavedFilter` tree type,
- conversion from legacy Directus filter objects into nested filter groups,
- conversion from nested filter groups back into Directus filter objects,
- SDK helpers for serializing nested saved filters into query params,
- preset service support for returning both raw and nested filter forms,
- tests for legacy filters, nested groups, empty groups, and unknown operators.

The intended product behavior is: old saved filters should behave exactly as they did before, while new nested saved filters should add structure without changing what records are returned.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `packages/utils/shared/parse-filter.ts` parses a filter object recursively. When a filter object has multiple entries, it returns `{ _and: filters }`, so legacy filters like `{ status: { _eq: "published" }, tenant: { _eq: "acme" } }` mean `status AND tenant`.
- `parseFilter` supports `_and` and `_or`, shifts nested logical operators upward, and preserves operator/value pairs for validation.
- `api/src/utils/validate-query.ts` validates filter operators and throws `InvalidQueryError` for invalid filter values or invalid JSON filter structures.
- `packages/utils/shared/merge-filters.ts` defaults to merging filters with `and`.
- `sdk/src/utils/query-to-params.ts` serializes `query.filter` with `JSON.stringify(query.filter)` and does not drop filter operators.
- `api/src/services/presets.ts` is a thin `ItemsService` wrapper for `directus_presets`, where saved preset filters are stored as JSON.
- `sdk/src/schema/preset.ts` exposes `DirectusPreset.filter` as `Record<string, any> | null`, preserving old saved filter shapes.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the implementation preserves Directus filter semantics and backward compatibility.

## Review Surface

Changed files in the synthetic PR:

- `packages/types/src/saved-filter.ts`
- `packages/utils/shared/nested-saved-filter.ts`
- `packages/utils/shared/nested-saved-filter.test.ts`
- `sdk/src/utils/nested-saved-filter-to-query.ts`
- `sdk/src/utils/nested-saved-filter-to-query.test.ts`
- `api/src/services/presets.ts`
- `api/src/services/presets-nested-filter.test.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on compatibility semantics, operator preservation, and saved-filter query compilation.

## Diff

```diff
diff --git a/packages/types/src/saved-filter.ts b/packages/types/src/saved-filter.ts
new file mode 100644
index 0000000000..7d3ef7b2b1
--- /dev/null
+++ b/packages/types/src/saved-filter.ts
@@ -0,0 +1,188 @@
+import type { Filter } from './filter.js';
+
+export type NestedSavedFilterCombinator = 'and' | 'or';
+
+export type NestedSavedFilterOperator =
+	| '_eq'
+	| '_neq'
+	| '_gt'
+	| '_gte'
+	| '_lt'
+	| '_lte'
+	| '_in'
+	| '_nin'
+	| '_between'
+	| '_nbetween'
+	| '_contains'
+	| '_ncontains'
+	| '_icontains'
+	| '_starts_with'
+	| '_nstarts_with'
+	| '_istarts_with'
+	| '_nistarts_with'
+	| '_ends_with'
+	| '_nends_with'
+	| '_iends_with'
+	| '_niends_with'
+	| '_null'
+	| '_nnull'
+	| '_empty'
+	| '_nempty'
+	| '_intersects'
+	| '_nintersects'
+	| '_intersects_bbox'
+	| '_nintersects_bbox'
+	| '_json'
+	| '_some'
+	| '_none';
+
+export type NestedSavedFilterCondition = {
+	type: 'condition';
+	id?: string;
+	label?: string;
+	field: string;
+	operator: NestedSavedFilterOperator | string;
+	value: unknown;
+	disabled?: boolean;
+};
+
+export type NestedSavedFilterGroup = {
+	type: 'group';
+	id?: string;
+	label?: string;
+	combinator?: NestedSavedFilterCombinator;
+	children: NestedSavedFilterNode[];
+	disabled?: boolean;
+};
+
+export type NestedSavedFilterNode = NestedSavedFilterCondition | NestedSavedFilterGroup;
+
+export type NestedSavedFilter = {
+	version: 1;
+	root: NestedSavedFilterGroup;
+};
+
+export type NestedSavedFilterCompileOptions = {
+	emptyGroups?: 'drop' | 'match-all';
+	disabledNodes?: 'drop' | 'include';
+	unknownOperators?: 'drop' | 'preserve' | 'throw';
+	legacyDefaultCombinator?: NestedSavedFilterCombinator;
+};
+
+export type NestedSavedFilterParseOptions = {
+	defaultCombinator?: NestedSavedFilterCombinator;
+	labelFactory?: (path: string[]) => string;
+};
+
+export type NestedSavedFilterPresetPayload = {
+	filter: Filter | null;
+	nested_filter?: NestedSavedFilter | null;
+};
+
+export type NestedSavedFilterValidationIssue = {
+	path: string[];
+	message: string;
+};
+
+export type NestedSavedFilterCompileResult = {
+	filter: Filter | null;
+	issues: NestedSavedFilterValidationIssue[];
+};
+
+export const nestedSavedFilterKnownOperators: readonly NestedSavedFilterOperator[] = [
+	'_eq',
+	'_neq',
+	'_gt',
+	'_gte',
+	'_lt',
+	'_lte',
+	'_in',
+	'_nin',
+	'_between',
+	'_nbetween',
+	'_contains',
+	'_ncontains',
+	'_icontains',
+	'_starts_with',
+	'_nstarts_with',
+	'_istarts_with',
+	'_nistarts_with',
+	'_ends_with',
+	'_nends_with',
+	'_iends_with',
+	'_niends_with',
+	'_null',
+	'_nnull',
+	'_empty',
+	'_nempty',
+	'_intersects',
+	'_nintersects',
+	'_intersects_bbox',
+	'_nintersects_bbox',
+	'_json',
+	'_some',
+	'_none',
+] as const;
+
+export function isNestedSavedFilter(value: unknown): value is NestedSavedFilter {
+	if (!value || typeof value !== 'object') return false;
+	const maybe = value as Partial<NestedSavedFilter>;
+	return maybe.version === 1 && Boolean(maybe.root) && maybe.root?.type === 'group';
+}
+
+export function isNestedSavedFilterGroup(value: unknown): value is NestedSavedFilterGroup {
+	if (!value || typeof value !== 'object') return false;
+	const maybe = value as Partial<NestedSavedFilterGroup>;
+	return maybe.type === 'group' && Array.isArray(maybe.children);
+}
+
+export function isNestedSavedFilterCondition(value: unknown): value is NestedSavedFilterCondition {
+	if (!value || typeof value !== 'object') return false;
+	const maybe = value as Partial<NestedSavedFilterCondition>;
+	return maybe.type === 'condition' && typeof maybe.field === 'string' && typeof maybe.operator === 'string';
+}
+
+export function createNestedSavedFilter(root: NestedSavedFilterGroup): NestedSavedFilter {
+	return {
+		version: 1,
+		root,
+	};
+}
+
+export function createNestedSavedFilterCondition(
+	field: string,
+	operator: NestedSavedFilterOperator | string,
+	value: unknown,
+): NestedSavedFilterCondition {
+	return {
+		type: 'condition',
+		field,
+		operator,
+		value,
+	};
+}
+
+export function createNestedSavedFilterGroup(
+	children: NestedSavedFilterNode[],
+	combinator: NestedSavedFilterCombinator = 'or',
+): NestedSavedFilterGroup {
+	return {
+		type: 'group',
+		combinator,
+		children,
+	};
+}
diff --git a/packages/utils/shared/nested-saved-filter.ts b/packages/utils/shared/nested-saved-filter.ts
new file mode 100644
index 0000000000..fb30faefa5
--- /dev/null
+++ b/packages/utils/shared/nested-saved-filter.ts
@@ -0,0 +1,398 @@
+import type {
+	Filter,
+	NestedSavedFilter,
+	NestedSavedFilterCompileOptions,
+	NestedSavedFilterCompileResult,
+	NestedSavedFilterCondition,
+	NestedSavedFilterGroup,
+	NestedSavedFilterNode,
+	NestedSavedFilterOperator,
+	NestedSavedFilterParseOptions,
+} from '@directus/types';
+import {
+	createNestedSavedFilter,
+	createNestedSavedFilterCondition,
+	createNestedSavedFilterGroup,
+	isNestedSavedFilter,
+	nestedSavedFilterKnownOperators,
+} from '@directus/types';
+import { isObjectLike } from 'lodash-es';
+
+const knownOperators = new Set<string>(nestedSavedFilterKnownOperators);
+
+const DEFAULT_COMPILE_OPTIONS: Required<NestedSavedFilterCompileOptions> = {
+	emptyGroups: 'drop',
+	disabledNodes: 'drop',
+	unknownOperators: 'drop',
+	legacyDefaultCombinator: 'or',
+};
+
+const DEFAULT_PARSE_OPTIONS: Required<NestedSavedFilterParseOptions> = {
+	defaultCombinator: 'or',
+	labelFactory: (path) => path.join('.'),
+};
+
+function isLogicalOperator(key: string) {
+	return key === '_and' || key === '_or';
+}
+
+function operatorToCombinator(operator: '_and' | '_or') {
+	return operator === '_and' ? 'and' : 'or';
+}
+
+function combinatorToOperator(combinator: 'and' | 'or') {
+	return combinator === 'and' ? '_and' : '_or';
+}
+
+function isPlainFilterObject(value: unknown): value is Record<string, unknown> {
+	return isObjectLike(value) && Array.isArray(value) === false;
+}
+
+function normalizeOperator(operator: string): NestedSavedFilterOperator | string {
+	if (knownOperators.has(operator)) return operator as NestedSavedFilterOperator;
+	return operator;
+}
+
+export function filterToNestedSavedFilter(
+	filter: Filter | NestedSavedFilter | null | undefined,
+	options: NestedSavedFilterParseOptions = {},
+): NestedSavedFilter | null {
+	if (!filter) return null;
+	if (isNestedSavedFilter(filter)) return filter;
+
+	const mergedOptions = {
+		...DEFAULT_PARSE_OPTIONS,
+		...options,
+	};
+
+	const root = parseLegacyFilterObject(filter as Record<string, unknown>, [], mergedOptions);
+
+	return createNestedSavedFilter(root);
+}
+
+function parseLegacyFilterObject(
+	filter: Record<string, unknown>,
+	path: string[],
+	options: Required<NestedSavedFilterParseOptions>,
+): NestedSavedFilterGroup {
+	const children: NestedSavedFilterNode[] = [];
+	let explicitCombinator: 'and' | 'or' | undefined;
+
+	for (const [key, value] of Object.entries(filter)) {
+		if (isLogicalOperator(key)) {
+			explicitCombinator = operatorToCombinator(key as '_and' | '_or');
+			const groupChildren = Array.isArray(value)
+				? value.map((nested, index) =>
+						parseLegacyFilterObject(nested as Record<string, unknown>, [...path, key, String(index)], options),
+					)
+				: [];
+
+			children.push(...groupChildren);
+			continue;
+		}
+
+		if (key.startsWith('_')) {
+			children.push(
+				createNestedSavedFilterCondition(path.join('.'), normalizeOperator(key), value),
+			);
+			continue;
+		}
+
+		if (isPlainFilterObject(value)) {
+			const operatorEntries = Object.entries(value).filter(([operator]) => operator.startsWith('_'));
+
+			if (operatorEntries.length > 0) {
+				for (const [operator, operatorValue] of operatorEntries) {
+					children.push({
+						type: 'condition',
+						field: [...path, key].join('.'),
+						operator: normalizeOperator(operator),
+						value: operatorValue,
+						label: options.labelFactory([...path, key]),
+					});
+				}
+			} else {
+				children.push(parseLegacyFilterObject(value, [...path, key], options));
+			}
+		} else {
+			children.push({
+				type: 'condition',
+				field: [...path, key].join('.'),
+				operator: '_eq',
+				value,
+				label: options.labelFactory([...path, key]),
+			});
+		}
+	}
+
+	return createNestedSavedFilterGroup(
+		children,
+		explicitCombinator ?? options.defaultCombinator,
+	);
+}
+
+export function nestedSavedFilterToFilter(
+	nestedFilter: NestedSavedFilter | NestedSavedFilterGroup | null | undefined,
+	options: NestedSavedFilterCompileOptions = {},
+): NestedSavedFilterCompileResult {
+	if (!nestedFilter) {
+		return {
+			filter: null,
+			issues: [],
+		};
+	}
+
+	const mergedOptions = {
+		...DEFAULT_COMPILE_OPTIONS,
+		...options,
+	};
+
+	const root = isNestedSavedFilter(nestedFilter) ? nestedFilter.root : nestedFilter;
+	const result = compileGroup(root, [], mergedOptions);
+
+	return {
+		filter: result.filter,
+		issues: result.issues,
+	};
+}
+
+function compileGroup(
+	group: NestedSavedFilterGroup,
+	path: string[],
+	options: Required<NestedSavedFilterCompileOptions>,
+): NestedSavedFilterCompileResult {
+	if (group.disabled && options.disabledNodes === 'drop') {
+		return {
+			filter: null,
+			issues: [],
+		};
+	}
+
+	const children: Filter[] = [];
+	const issues: NestedSavedFilterCompileResult['issues'] = [];
+
+	group.children.forEach((child, index) => {
+		const childPath = [...path, String(index)];
+		const compiled =
+			child.type === 'group'
+				? compileGroup(child, childPath, options)
+				: compileCondition(child, childPath, options);
+
+		issues.push(...compiled.issues);
+
+		if (compiled.filter) {
+			children.push(compiled.filter);
+		}
+	});
+
+	if (children.length === 0) {
+		return {
+			filter: options.emptyGroups === 'match-all' ? {} : null,
+			issues,
+		};
+	}
+
+	if (children.length === 1) {
+		return {
+			filter: children[0] ?? null,
+			issues,
+		};
+	}
+
+	return {
+		filter: {
+			[combinatorToOperator(group.combinator ?? options.legacyDefaultCombinator)]: children,
+		} as Filter,
+		issues,
+	};
+}
+
+function compileCondition(
+	condition: NestedSavedFilterCondition,
+	path: string[],
+	options: Required<NestedSavedFilterCompileOptions>,
+): NestedSavedFilterCompileResult {
+	if (condition.disabled && options.disabledNodes === 'drop') {
+		return {
+			filter: null,
+			issues: [],
+		};
+	}
+
+	if (!knownOperators.has(condition.operator)) {
+		if (options.unknownOperators === 'throw') {
+			return {
+				filter: null,
+				issues: [
+					{
+						path,
+						message: `Unknown filter operator ${condition.operator}`,
+					},
+				],
+			};
+		}
+
+		if (options.unknownOperators === 'drop') {
+			return {
+				filter: null,
+				issues: [],
+			};
+		}
+	}
+
+	return {
+		filter: buildFieldFilter(condition.field, {
+			[condition.operator]: condition.value,
+		}),
+		issues: [],
+	};
+}
+
+function buildFieldFilter(field: string, operatorFilter: Record<string, unknown>): Filter {
+	const parts = field.split('.').filter(Boolean);
+
+	if (parts.length === 0) {
+		return operatorFilter as Filter;
+	}
+
+	return parts.reduceRight((acc, part) => ({ [part]: acc }), operatorFilter) as Filter;
+}
+
+export function normalizePresetFilterForResponse(
+	filter: Filter | NestedSavedFilter | null | undefined,
+): {
+	filter: Filter | null;
+	nested_filter: NestedSavedFilter | null;
+} {
+	const nested = filterToNestedSavedFilter(filter);
+
+	if (!nested) {
+		return {
+			filter: null,
+			nested_filter: null,
+		};
+	}
+
+	const compiled = nestedSavedFilterToFilter(nested);
+
+	return {
+		filter: compiled.filter,
+		nested_filter: nested,
+	};
+}
+
+export function normalizePresetFilterForStorage(
+	payload: {
+		filter?: Filter | NestedSavedFilter | null;
+		nested_filter?: NestedSavedFilter | null;
+	},
+): {
+	filter: Filter | null;
+	nested_filter: NestedSavedFilter | null;
+} {
+	const nested = payload.nested_filter ?? filterToNestedSavedFilter(payload.filter);
+
+	if (!nested) {
+		return {
+			filter: null,
+			nested_filter: null,
+		};
+	}
+
+	const compiled = nestedSavedFilterToFilter(nested);
+
+	return {
+		filter: compiled.filter,
+		nested_filter: nested,
+	};
+}
+
+export function summarizeNestedSavedFilter(nestedFilter: NestedSavedFilter | null) {
+	if (!nestedFilter) {
+		return {
+			conditions: 0,
+			groups: 0,
+			disabled: 0,
+		};
+	}
+
+	const summary = {
+		conditions: 0,
+		groups: 0,
+		disabled: 0,
+	};
+
+	const visit = (node: NestedSavedFilterNode) => {
+		if (node.disabled) summary.disabled += 1;
+
+		if (node.type === 'condition') {
+			summary.conditions += 1;
+			return;
+		}
+
+		summary.groups += 1;
+		node.children.forEach(visit);
+	};
+
+	visit(nestedFilter.root);
+	return summary;
+}
diff --git a/packages/utils/shared/nested-saved-filter.test.ts b/packages/utils/shared/nested-saved-filter.test.ts
new file mode 100644
index 0000000000..3f5f25d48a
--- /dev/null
+++ b/packages/utils/shared/nested-saved-filter.test.ts
@@ -0,0 +1,325 @@
+import type { Filter } from '@directus/types';
+import { describe, expect, it } from 'vitest';
+import {
+	filterToNestedSavedFilter,
+	nestedSavedFilterToFilter,
+	normalizePresetFilterForResponse,
+	summarizeNestedSavedFilter,
+} from './nested-saved-filter.js';
+
+describe('nested saved filters', () => {
+	it('converts a single legacy field predicate into a nested condition', () => {
+		const nested = filterToNestedSavedFilter({
+			status: {
+				_eq: 'published',
+			},
+		});
+
+		expect(nested).toEqual({
+			version: 1,
+			root: {
+				type: 'group',
+				combinator: 'or',
+				children: [
+					{
+						type: 'condition',
+						field: 'status',
+						operator: '_eq',
+						value: 'published',
+						label: 'status',
+					},
+				],
+			},
+		});
+	});
+
+	it('converts multiple legacy field predicates into an or group', () => {
+		const nested = filterToNestedSavedFilter({
+			status: {
+				_eq: 'published',
+			},
+			tenant: {
+				_eq: 'acme',
+			},
+		});
+
+		expect(nested?.root.combinator).toBe('or');
+
+		const compiled = nestedSavedFilterToFilter(nested);
+
+		expect(compiled.filter).toEqual({
+			_or: [
+				{
+					status: {
+						_eq: 'published',
+					},
+				},
+				{
+					tenant: {
+						_eq: 'acme',
+					},
+				},
+			],
+		});
+	});
+
+	it('preserves explicit legacy or groups', () => {
+		const nested = filterToNestedSavedFilter({
+			_or: [
+				{
+					status: {
+						_eq: 'published',
+					},
+				},
+				{
+					status: {
+						_eq: 'review',
+					},
+				},
+			],
+		});
+
+		const compiled = nestedSavedFilterToFilter(nested);
+
+		expect(compiled.filter).toEqual({
+			_or: [
+				{
+					status: {
+						_eq: 'published',
+					},
+				},
+				{
+					status: {
+						_eq: 'review',
+					},
+				},
+			],
+		});
+	});
+
+	it('preserves explicit legacy and groups', () => {
+		const nested = filterToNestedSavedFilter({
+			_and: [
+				{
+					status: {
+						_eq: 'published',
+					},
+				},
+				{
+					tenant: {
+						_eq: 'acme',
+					},
+				},
+			],
+		});
+
+		const compiled = nestedSavedFilterToFilter(nested);
+
+		expect(compiled.filter).toEqual({
+			_and: [
+				{
+					status: {
+						_eq: 'published',
+					},
+				},
+				{
+					tenant: {
+						_eq: 'acme',
+					},
+				},
+			],
+		});
+	});
+
+	it('converts nested relational filters into dotted condition paths', () => {
+		const nested = filterToNestedSavedFilter({
+			author: {
+				role: {
+					name: {
+						_eq: 'editor',
+					},
+				},
+			},
+		});
+
+		expect(nested?.root.children).toEqual([
+			{
+				type: 'group',
+				combinator: 'or',
+				children: [
+					{
+						type: 'group',
+						combinator: 'or',
+						children: [
+							{
+								type: 'condition',
+								field: 'author.role.name',
+								operator: '_eq',
+								value: 'editor',
+								label: 'author.role.name',
+							},
+						],
+					},
+				],
+			},
+		]);
+	});
+
+	it('compiles nested groups back into Directus filter objects', () => {
+		const compiled = nestedSavedFilterToFilter({
+			version: 1,
+			root: {
+				type: 'group',
+				combinator: 'and',
+				children: [
+					{
+						type: 'condition',
+						field: 'status',
+						operator: '_eq',
+						value: 'published',
+					},
+					{
+						type: 'group',
+						combinator: 'or',
+						children: [
+							{
+								type: 'condition',
+								field: 'category',
+								operator: '_eq',
+								value: 'news',
+							},
+							{
+								type: 'condition',
+								field: 'category',
+								operator: '_eq',
+								value: 'updates',
+							},
+						],
+					},
+				],
+			},
+		});
+
+		expect(compiled.filter).toEqual({
+			_and: [
+				{
+					status: {
+						_eq: 'published',
+					},
+				},
+				{
+					_or: [
+						{
+							category: {
+								_eq: 'news',
+							},
+						},
+						{
+							category: {
+								_eq: 'updates',
+							},
+						},
+					],
+				},
+			],
+		});
+	});
+
+	it('drops disabled nodes when compiling', () => {
+		const compiled = nestedSavedFilterToFilter({
+			version: 1,
+			root: {
+				type: 'group',
+				combinator: 'and',
+				children: [
+					{
+						type: 'condition',
+						field: 'status',
+						operator: '_eq',
+						value: 'published',
+					},
+					{
+						type: 'condition',
+						field: 'tenant',
+						operator: '_eq',
+						value: 'acme',
+						disabled: true,
+					},
+				],
+			},
+		});
+
+		expect(compiled.filter).toEqual({
+			status: {
+				_eq: 'published',
+			},
+		});
+	});
+
+	it('drops unknown operators when compiling nested filters', () => {
+		const filter: Filter = {
+			slug: {
+				_regex: '^post-',
+			},
+			status: {
+				_eq: 'published',
+			},
+		} as Filter;
+
+		const normalized = normalizePresetFilterForResponse(filter);
+
+		expect(normalized.filter).toEqual({
+			status: {
+				_eq: 'published',
+			},
+		});
+	});
+
+	it('can report unknown operators when explicitly requested', () => {
+		const compiled = nestedSavedFilterToFilter(
+			{
+				version: 1,
+				root: {
+					type: 'group',
+					combinator: 'and',
+					children: [
+						{
+							type: 'condition',
+							field: 'slug',
+							operator: '_regex',
+							value: '^post-',
+						},
+					],
+				},
+			},
+			{
+				unknownOperators: 'throw',
+			},
+		);
+
+		expect(compiled.filter).toBeNull();
+		expect(compiled.issues).toEqual([
+			{
+				path: ['0'],
+				message: 'Unknown filter operator _regex',
+			},
+		]);
+	});
+
+	it('summarizes nested filters for preset responses', () => {
+		const nested = filterToNestedSavedFilter({
+			status: {
+				_eq: 'published',
+			},
+			tenant: {
+				_eq: 'acme',
+			},
+		});
+
+		expect(summarizeNestedSavedFilter(nested)).toEqual({
+			conditions: 2,
+			groups: 1,
+			disabled: 0,
+		});
+	});
+});
diff --git a/sdk/src/utils/nested-saved-filter-to-query.ts b/sdk/src/utils/nested-saved-filter-to-query.ts
new file mode 100644
index 0000000000..0e921d769a
--- /dev/null
+++ b/sdk/src/utils/nested-saved-filter-to-query.ts
@@ -0,0 +1,161 @@
+import type { Filter, NestedSavedFilter } from '@directus/types';
+import { isNestedSavedFilter } from '@directus/types';
+import { nestedSavedFilterToFilter } from '@directus/utils';
+import { queryToParams } from './query-to-params.js';
+
+export type NestedSavedFilterQueryInput<Schema = any, Item = Record<string, unknown>> = {
+	filter?: Filter | NestedSavedFilter | null;
+	fields?: string[];
+	sort?: string | string[];
+	limit?: number;
+	offset?: number;
+	page?: number;
+	search?: string;
+	deep?: Record<string, unknown>;
+	alias?: Record<string, unknown>;
+	aggregate?: Record<string, unknown>;
+	groupBy?: string | string[];
+};
+
+export function nestedSavedFilterToQueryParams<Schema = any, Item = Record<string, unknown>>(
+	query: NestedSavedFilterQueryInput<Schema, Item>,
+) {
+	const normalizedQuery = {
+		...query,
+		filter: normalizeFilterForQuery(query.filter),
+	};
+
+	return queryToParams(normalizedQuery);
+}
+
+export function normalizeFilterForQuery(filter: Filter | NestedSavedFilter | null | undefined) {
+	if (!filter) return undefined;
+
+	if (isNestedSavedFilter(filter)) {
+		const compiled = nestedSavedFilterToFilter(filter);
+		return compiled.filter ?? undefined;
+	}
+
+	const compiled = nestedSavedFilterToFilter({
+		version: 1,
+		root: {
+			type: 'group',
+			combinator: 'or',
+			children: Object.entries(filter).map(([field, value]) => ({
+				type: 'condition',
+				field,
+				operator: '_eq',
+				value,
+			})),
+		},
+	});
+
+	return compiled.filter ?? undefined;
+}
+
+export function normalizePresetFiltersForSdkResponse<T extends { filter?: Filter | NestedSavedFilter | null }>(
+	preset: T,
+): T & { nested_filter?: NestedSavedFilter | null } {
+	if (!preset.filter) {
+		return {
+			...preset,
+			nested_filter: null,
+		};
+	}
+
+	if (isNestedSavedFilter(preset.filter)) {
+		return {
+			...preset,
+			nested_filter: preset.filter,
+			filter: nestedSavedFilterToFilter(preset.filter).filter,
+		};
+	}
+
+	const nestedFilter = {
+		version: 1 as const,
+		root: {
+			type: 'group' as const,
+			combinator: 'or' as const,
+			children: Object.entries(preset.filter).map(([field, value]) => ({
+				type: 'condition' as const,
+				field,
+				operator: '_eq',
+				value,
+			})),
+		},
+	};
+
+	return {
+		...preset,
+		filter: nestedSavedFilterToFilter(nestedFilter).filter,
+		nested_filter: nestedFilter,
+	};
+}
diff --git a/sdk/src/utils/nested-saved-filter-to-query.test.ts b/sdk/src/utils/nested-saved-filter-to-query.test.ts
new file mode 100644
index 0000000000..0a8f6f9377
--- /dev/null
+++ b/sdk/src/utils/nested-saved-filter-to-query.test.ts
@@ -0,0 +1,217 @@
+import { describe, expect, it } from 'vitest';
+import { nestedSavedFilterToQueryParams, normalizeFilterForQuery } from './nested-saved-filter-to-query.js';
+
+describe('nestedSavedFilterToQueryParams', () => {
+	it('serializes nested saved filters into query params', () => {
+		const params = nestedSavedFilterToQueryParams({
+			filter: {
+				version: 1,
+				root: {
+					type: 'group',
+					combinator: 'and',
+					children: [
+						{
+							type: 'condition',
+							field: 'status',
+							operator: '_eq',
+							value: 'published',
+						},
+						{
+							type: 'condition',
+							field: 'tenant',
+							operator: '_eq',
+							value: 'acme',
+						},
+					],
+				},
+			},
+			fields: ['id', 'title'],
+			limit: 25,
+		});
+
+		expect(params).toEqual({
+			fields: 'id,title',
+			filter: '{"_and":[{"status":{"_eq":"published"}},{"tenant":{"_eq":"acme"}}]}',
+			limit: '25',
+		});
+	});
+
+	it('serializes legacy filters through nested filter compatibility mode', () => {
+		const params = nestedSavedFilterToQueryParams({
+			filter: {
+				status: {
+					_eq: 'published',
+				},
+				tenant: {
+					_eq: 'acme',
+				},
+			},
+		});
+
+		expect(params).toEqual({
+			filter:
+				'{"_or":[{"status":{"_eq":{"_eq":"published"}}},{"tenant":{"_eq":{"_eq":"acme"}}}]}',
+		});
+	});
+
+	it('drops unknown operators before sending query params', () => {
+		const params = nestedSavedFilterToQueryParams({
+			filter: {
+				version: 1,
+				root: {
+					type: 'group',
+					combinator: 'and',
+					children: [
+						{
+							type: 'condition',
+							field: 'slug',
+							operator: '_regex',
+							value: '^post-',
+						},
+						{
+							type: 'condition',
+							field: 'status',
+							operator: '_eq',
+							value: 'published',
+						},
+					],
+				},
+			},
+		});
+
+		expect(params).toEqual({
+			filter: '{"status":{"_eq":"published"}}',
+		});
+	});
+
+	it('normalizes null filters to undefined', () => {
+		expect(normalizeFilterForQuery(null)).toBeUndefined();
+		expect(normalizeFilterForQuery(undefined)).toBeUndefined();
+	});
+});
diff --git a/api/src/services/presets.ts b/api/src/services/presets.ts
index 0d63d1cf53..bcd32526c6 100644
--- a/api/src/services/presets.ts
+++ b/api/src/services/presets.ts
@@ -1,8 +1,84 @@
 import type { AbstractServiceOptions } from '@directus/types';
+import type { Filter, NestedSavedFilter } from '@directus/types';
+import {
+	normalizePresetFilterForResponse,
+	normalizePresetFilterForStorage,
+	summarizeNestedSavedFilter,
+} from '@directus/utils';
 import { ItemsService } from './items.js';
 
 export class PresetsService extends ItemsService {
 	constructor(options: AbstractServiceOptions) {
 		super('directus_presets', options);
 	}
+
+	override async readByQuery(query: any, opts?: any) {
+		const result = await super.readByQuery(query, opts);
+
+		return result.map((preset: any) => this.#withNestedFilter(preset));
+	}
+
+	override async readOne(key: string | number, query?: any, opts?: any) {
+		const preset = await super.readOne(key, query, opts);
+
+		return this.#withNestedFilter(preset);
+	}
+
+	override async createOne(data: Record<string, any>, opts?: any) {
+		const normalized = this.#normalizeIncomingPreset(data);
+		const result = await super.createOne(normalized, opts);
+		return result;
+	}
+
+	override async updateOne(key: string | number, data: Record<string, any>, opts?: any) {
+		const normalized = this.#normalizeIncomingPreset(data);
+		const result = await super.updateOne(key, normalized, opts);
+		return result;
+	}
+
+	#withNestedFilter(preset: any) {
+		if (!preset) return preset;
+
+		const normalized = normalizePresetFilterForResponse(
+			(preset.nested_filter as NestedSavedFilter | null | undefined) ??
+				(preset.filter as Filter | null | undefined),
+		);
+
+		return {
+			...preset,
+			filter: normalized.filter,
+			nested_filter: normalized.nested_filter,
+			filter_summary: summarizeNestedSavedFilter(normalized.nested_filter),
+		};
+	}
+
+	#normalizeIncomingPreset(data: Record<string, any>) {
+		if ('filter' in data === false && 'nested_filter' in data === false) {
+			return data;
+		}
+
+		const normalized = normalizePresetFilterForStorage({
+			filter: data.filter as Filter | NestedSavedFilter | null | undefined,
+			nested_filter: data.nested_filter as NestedSavedFilter | null | undefined,
+		});
+
+		return {
+			...data,
+			filter: normalized.filter,
+			nested_filter: normalized.nested_filter,
+		};
+	}
 }
diff --git a/api/src/services/presets-nested-filter.test.ts b/api/src/services/presets-nested-filter.test.ts
new file mode 100644
index 0000000000..e834aeb82b
--- /dev/null
+++ b/api/src/services/presets-nested-filter.test.ts
@@ -0,0 +1,243 @@
+import { describe, expect, it, vi } from 'vitest';
+import { PresetsService } from './presets.js';
+
+const mockReadByQuery = vi.fn();
+const mockReadOne = vi.fn();
+const mockCreateOne = vi.fn();
+const mockUpdateOne = vi.fn();
+
+vi.mock('./items.js', () => ({
+	ItemsService: class {
+		readByQuery = mockReadByQuery;
+		readOne = mockReadOne;
+		createOne = mockCreateOne;
+		updateOne = mockUpdateOne;
+		constructor(public collection: string, public options: any) {}
+	},
+}));
+
+describe('PresetsService nested filters', () => {
+	it('returns nested filter metadata for saved presets', async () => {
+		mockReadByQuery.mockResolvedValueOnce([
+			{
+				id: 1,
+				collection: 'articles',
+				filter: {
+					status: {
+						_eq: 'published',
+					},
+					tenant: {
+						_eq: 'acme',
+					},
+				},
+			},
+		]);
+
+		const service = new PresetsService({} as any);
+		const result = await service.readByQuery({});
+
+		expect(result).toEqual([
+			{
+				id: 1,
+				collection: 'articles',
+				filter: {
+					_or: [
+						{
+							status: {
+								_eq: 'published',
+							},
+						},
+						{
+							tenant: {
+								_eq: 'acme',
+							},
+						},
+					],
+				},
+				nested_filter: {
+					version: 1,
+					root: {
+						type: 'group',
+						combinator: 'or',
+						children: [
+							{
+								type: 'condition',
+								field: 'status',
+								operator: '_eq',
+								value: 'published',
+								label: 'status',
+							},
+							{
+								type: 'condition',
+								field: 'tenant',
+								operator: '_eq',
+								value: 'acme',
+								label: 'tenant',
+							},
+						],
+					},
+				},
+				filter_summary: {
+					conditions: 2,
+					groups: 1,
+					disabled: 0,
+				},
+			},
+		]);
+	});
+
+	it('stores nested filters as compiled Directus filters', async () => {
+		mockCreateOne.mockResolvedValueOnce(1);
+
+		const service = new PresetsService({} as any);
+
+		const result = await service.createOne({
+			collection: 'articles',
+			nested_filter: {
+				version: 1,
+				root: {
+					type: 'group',
+					combinator: 'and',
+					children: [
+						{
+							type: 'condition',
+							field: 'status',
+							operator: '_eq',
+							value: 'published',
+						},
+						{
+							type: 'condition',
+							field: 'tenant',
+							operator: '_eq',
+							value: 'acme',
+						},
+					],
+				},
+			},
+		});
+
+		expect(result).toBe(1);
+		expect(mockCreateOne).toHaveBeenCalledWith(
+			{
+				collection: 'articles',
+				filter: {
+					_and: [
+						{
+							status: {
+								_eq: 'published',
+							},
+						},
+						{
+							tenant: {
+								_eq: 'acme',
+							},
+						},
+					],
+				},
+				nested_filter: {
+					version: 1,
+					root: expect.objectContaining({
+						type: 'group',
+						combinator: 'and',
+					}),
+				},
+			},
+			undefined,
+		);
+	});
+
+	it('drops unknown operators while storing presets', async () => {
+		mockUpdateOne.mockResolvedValueOnce(1);
+		const service = new PresetsService({} as any);
+
+		await service.updateOne(1, {
+			filter: {
+				slug: {
+					_regex: '^post-',
+				},
+				status: {
+					_eq: 'published',
+				},
+			},
+		});
+
+		expect(mockUpdateOne).toHaveBeenCalledWith(
+			1,
+			{
+				filter: {
+					status: {
+						_eq: 'published',
+					},
+				},
+				nested_filter: expect.objectContaining({
+					version: 1,
+				}),
+			},
+			undefined,
+		);
+	});
+});
```

## Intended Flaws

### Flaw 1: Legacy saved filters silently change from implicit AND to OR

- Main locations:
  - `packages/utils/shared/nested-saved-filter.ts:17-26`
  - `packages/utils/shared/nested-saved-filter.ts:47-105`
  - `sdk/src/utils/nested-saved-filter-to-query.ts:25-52`
  - `api/src/services/presets-nested-filter.test.ts:24-78`
- What is wrong: Directus legacy filters with multiple top-level predicates currently mean implicit AND. The new nested saved-filter parser defaults legacy groups to `or`, and the SDK compatibility path also wraps legacy entries in an OR group. A saved filter like `{ status: { _eq: "published" }, tenant: { _eq: "acme" } }` now means `status = published OR tenant = acme`.
- Why it matters: This widens reads. A bookmark or preset that used to show only published Acme records can now show every published record from any tenant plus every Acme record in any status. In a system like Directus, filter widening can become a data exposure bug, not just a UI annoyance.
- Better direction: Preserve legacy semantics by defaulting old object filters to AND, matching `parseFilter`. If nested saved filters need a different default for new UI-created groups, version the nested format and parser. Old `filter` objects should round-trip without changing query meaning.

Hints:

1. Look at how `parseFilter` treats multiple entries in a normal filter object.
2. Now find the default combinator in the new nested saved-filter parser.
3. Run a two-clause saved filter through the migration and compare the predicate shape before and after.

### Flaw 2: Unknown filter operators are silently dropped

- Main locations:
  - `packages/utils/shared/nested-saved-filter.ts:181-212`
  - `packages/utils/shared/nested-saved-filter.test.ts:236-291`
  - `sdk/src/utils/nested-saved-filter-to-query.test.ts:52-82`
  - `api/src/services/presets-nested-filter.test.ts:158-190`
- What is wrong: The compiler's default `unknownOperators` behavior is `drop`. If a saved filter contains an operator the nested-filter code does not recognize, that condition disappears from the compiled filter with no error. Tests explicitly expect `_regex` to be removed.
- Why it matters: Saved filters can come from older Directus versions, API clients, database rows, extensions, or future operators. Dropping a predicate silently changes behavior and often widens reads. A filter intended to match `slug` by regex and `status = published` becomes only `status = published`.
- Better direction: Unknown operators should either be preserved byte-for-byte for compatibility or rejected with a clear validation error before storage. For a compatibility layer, preserving unknown operators is usually safer than silently deleting them. If the UI cannot edit an operator, it can mark it read-only while retaining it in the saved filter.

Hints:

1. Search for `unknownOperators` and check the default.
2. What happens to a condition when `compileCondition` sees an operator outside the known set?
3. In filter systems, is silently removing a predicate usually a narrowing bug or a widening bug?

## Expert Debrief

### Product-Level Change

The product change is good: nested saved filters make visual filter editors easier and can preserve user intent with labels, groups, disabled nodes, and future metadata.

The danger is that saved filters are executable query contracts. They are not only UI state. A compatibility layer must preserve what records the saved filter returns.

### Changed Contracts

This PR changes several contracts:

- Preset storage contract: presets now may include `nested_filter`.
- Response contract: preset reads return normalized `filter`, `nested_filter`, and `filter_summary`.
- Query semantics contract: legacy filters are converted into nested groups and then compiled back.
- SDK contract: SDK callers can pass nested saved filters to query serialization.
- Operator compatibility contract: only known operators are compiled by default.

The PR breaks the query semantics contract and the operator compatibility contract.

### Failure Modes

Important failure modes reviewers should predict:

- Tenant-scoped presets return records from other tenants because AND became OR.
- Old bookmarks and role-specific presets show much larger result sets after upgrade.
- Extension-defined or future operators disappear during save/read cycles.
- Users open and save a preset once, permanently changing its filter behavior.
- SDK queries send a different filter than the object the caller supplied.
- The UI summary says two conditions exist, but the compiled filter contains only one.

### Reviewer Thought Process

A strong reviewer should ask:

- What is the old semantic meaning of a multi-field filter object?
- Does the migration/normalization path preserve that meaning?
- Is the new nested structure versioned so defaults can differ by origin?
- What happens when this parser meets an operator it does not know?
- Are tests asserting compatibility or asserting the new broken behavior?
- Can a saved filter be read and written back without changing returned rows?

The key move is treating saved filters as persisted query programs, not as harmless UI blobs.

### Better Implementation Direction

A safer implementation would:

1. Add `nested_filter` as a new optional representation without rewriting old `filter` semantics on read.
2. When converting legacy filters, default multi-entry objects to AND exactly like `parseFilter`.
3. Add a version field that lets future nested UI defaults differ without affecting old filters.
4. Preserve unknown operators by default, or fail validation loudly before writing.
5. Add golden round-trip tests: legacy filter in, compiled filter out, exact semantic shape preserved.
6. Add upgrade tests for saved presets with tenant filters, nested relation filters, and extension operators.

## Correctness Verdict Rubric

For each flaw, the verifier should mark the learner correct if their answer captures the core issue, even if they use different wording.

### Flaw 1 Rubric

Correct answers should mention:

- Existing Directus filters with multiple entries are implicit AND.
- The new parser/SDK defaults legacy filters to OR.
- This widens result sets and can expose records that old saved filters excluded.
- A better fix is preserving AND for legacy filters, likely with a versioned parser/default.

Partially correct answers may mention only "wrong logical operator" without explaining old compatibility or widened reads.

Incorrect answers focus only on UI grouping preference or labels.

### Flaw 2 Rubric

Correct answers should mention:

- Unknown operators are dropped by default.
- Dropping predicates silently changes saved filter behavior.
- The impact is especially dangerous for saved filters from older versions, extensions, or future clients.
- A better fix is preserving unknown operators or throwing a clear validation error.

Partially correct answers may mention only "missing support for `_regex`" without identifying the broader silent-operator-drop problem.

Incorrect answers argue that dropping unknown operators is harmless because the current known list is long.

## Golden Answer Summary

The PR adds a useful nested saved-filter representation, but it breaks Directus filter compatibility in two ways. First, legacy multi-field filters are converted from implicit AND to OR, widening saved-query results and potentially exposing data. Second, unknown operators are silently dropped, so saved filters from extensions, older versions, or future clients lose predicates without an error. The fix is a versioned compatibility parser that preserves legacy AND semantics and either preserves unknown operators or rejects them loudly before storage.
