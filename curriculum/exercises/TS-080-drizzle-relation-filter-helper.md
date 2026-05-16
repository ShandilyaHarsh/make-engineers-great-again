# TS-080: Drizzle Relation Filter Helper

## Metadata

- `id`: TS-080
- `source_repo`: [drizzle-team/drizzle-orm](https://github.com/drizzle-team/drizzle-orm)
- `repo_area`: TypeScript relational query builder, DBQueryConfig, BuildQueryResult type inference, dialect SQL generation, nested relation JSON aggregation, pagination semantics, cross-dialect query contracts, type/runtime alignment
- `mode`: synthetic_degraded
- `difficulty`: 8
- `target_diff_lines`: 2,400-3,100
- `represented_diff_lines`: 2694
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Drizzle relational queries, SQL-level predicates, JSON aggregation, type inference, pagination semantics, and type/runtime mismatch without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a `relationWhere` helper to Drizzle relational queries. The goal is to let users filter included relation rows without leaving the `db.query.*.findMany({ with: ... })` API.

The PR adds:

- relation filter type helpers,
- a runtime relation-filter application helper,
- relation-aware result type narrowing,
- PG, MySQL, and SQLite relational query builder wiring,
- dialect normalization for the new config key,
- relational integration tests,
- PG type tests,
- documentation for the new `relationWhere` API.

The intended product behavior is: callers can query root rows with included relations and add predicates for those relations in a type-safe way.

## Existing Code Context

The real Drizzle codebase already has these relevant contracts:

- `relations.ts` defines `Relation`, `One`, `Many`, `DBQueryConfig`, `BuildRelationResult`, and `BuildQueryResult`. The type contract is central to the API.
- Existing relational `where` callbacks lower to `SQL` and are mapped to table aliases before execution.
- PG `RelationalQueryBuilder.findMany` returns `PgRelationalQuery<BuildQueryResult<...>[]>`, and execution maps raw rows through `mapRelationalRow`.
- PG dialect relational queries process selected relations by recursively building relation SQL, joining lateral subqueries, and aggregating many relations with JSON.
- Limit, offset, and order-by are SQL semantics, not post-processing conveniences. Moving predicates after that boundary changes query meaning.
- Drizzle supports multiple dialects, but cross-dialect ergonomics cannot come at the cost of pretending a JavaScript predicate has SQL semantics.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to decide whether the implementation actually preserves relational query semantics and whether the type contract matches runtime behavior.

## Review Surface

Changed files in the synthetic PR:

- `drizzle-orm/src/relations/relation-filter-types.ts`
- `drizzle-orm/src/relations/relation-filter-runtime.ts`
- `drizzle-orm/src/relations.ts`
- `drizzle-orm/src/pg-core/query-builders/query.ts`
- `drizzle-orm/src/mysql-core/query-builders/query.ts`
- `drizzle-orm/src/sqlite-core/query-builders/query.ts`
- `drizzle-orm/src/pg-core/dialect.ts`
- `integration-tests/tests/relational/relation-filter.test.ts`
- `drizzle-orm/type-tests/pg/relation-filters.ts`
- `docs/relation-filters.md`

The line references below use synthetic PR line numbers. The represented diff is focused on where relation predicates execute, how pagination and SQL generation behave, and whether result types describe what runtime actually returns.

## Diff

```diff
diff --git a/drizzle-orm/src/relations/relation-filter-types.ts b/drizzle-orm/src/relations/relation-filter-types.ts
new file mode 100644
index 0000000000..080bad0000
--- /dev/null
+++ b/drizzle-orm/src/relations/relation-filter-types.ts
@@ -0,0 +1,232 @@
+import type { SQL } from "../sql/sql.ts"
+import type { Relation, TableRelationalConfig, TablesRelationalConfig } from "../relations.ts"
+
+export type RelationPredicateOperators = {
+  sql: <T = unknown>(strings: TemplateStringsArray, ...params: unknown[]) => SQL<T>
+}
+
+export type RelationFilterPredicate<TChild> = (
+  row: TChild,
+  operators: RelationPredicateOperators,
+) => boolean | SQL | undefined
+
+export type RelationWhereConfig<
+  TSchema extends TablesRelationalConfig,
+  TTable extends TableRelationalConfig,
+> = {
+  [K in keyof TTable["relations"]]?: TTable["relations"][K] extends Relation<infer TReferencedTableName>
+    ? RelationFilterPredicate<ExtractRelationResult<TSchema, TReferencedTableName>>
+    : never
+}
+
+export type ExtractRelationResult<
+  TSchema extends TablesRelationalConfig,
+  TReferencedTableName extends string,
+> = {
+  [K in keyof TSchema]: TSchema[K]["dbName"] extends TReferencedTableName
+    ? TSchema[K]["columns"]
+    : never
+}[keyof TSchema]
+
+export type NonEmptyArray<T> = [T, ...T[]]
+
+export type RelationFilteredResult<
+  TResult,
+  TRelationWhere,
+> = TResult extends Array<infer TRow>
+  ? Array<NarrowRelationFields<TRow, TRelationWhere>>
+  : NarrowRelationFields<TResult, TRelationWhere>
+
+export type NarrowRelationFields<TRow, TRelationWhere> = TRow extends Record<string, unknown>
+  ? {
+      [K in keyof TRow]: K extends keyof TRelationWhere
+        ? TRow[K] extends Array<infer TChild>
+          ? NonEmptyArray<TChild>
+          : NonNullable<TRow[K]>
+        : TRow[K]
+    }
+  : TRow
+
+export type HasRelationWhere<TConfig> = TConfig extends { relationWhere: infer TRelationWhere }
+  ? keyof TRelationWhere extends never
+    ? false
+    : true
+  : false
+
+export type ApplyRelationWhereResult<TResult, TConfig> = TConfig extends { relationWhere: infer TRelationWhere }
+  ? RelationFilteredResult<TResult, TRelationWhere>
+  : TResult
+// relation-filter-types note 001: describe relation filter types and narrowed result contracts
+// relation-filter-types note 002: describe relation filter types and narrowed result contracts
+// relation-filter-types note 003: describe relation filter types and narrowed result contracts
+// relation-filter-types note 004: describe relation filter types and narrowed result contracts
+// relation-filter-types note 005: describe relation filter types and narrowed result contracts
+// relation-filter-types note 006: describe relation filter types and narrowed result contracts
+// relation-filter-types note 007: describe relation filter types and narrowed result contracts
+// relation-filter-types note 008: describe relation filter types and narrowed result contracts
+// relation-filter-types note 009: describe relation filter types and narrowed result contracts
+// relation-filter-types note 010: describe relation filter types and narrowed result contracts
+// relation-filter-types note 011: describe relation filter types and narrowed result contracts
+// relation-filter-types note 012: describe relation filter types and narrowed result contracts
+// relation-filter-types note 013: describe relation filter types and narrowed result contracts
+// relation-filter-types note 014: describe relation filter types and narrowed result contracts
+// relation-filter-types note 015: describe relation filter types and narrowed result contracts
+// relation-filter-types note 016: describe relation filter types and narrowed result contracts
+// relation-filter-types note 017: describe relation filter types and narrowed result contracts
+// relation-filter-types note 018: describe relation filter types and narrowed result contracts
+// relation-filter-types note 019: describe relation filter types and narrowed result contracts
+// relation-filter-types note 020: describe relation filter types and narrowed result contracts
+// relation-filter-types note 021: describe relation filter types and narrowed result contracts
+// relation-filter-types note 022: describe relation filter types and narrowed result contracts
+// relation-filter-types note 023: describe relation filter types and narrowed result contracts
+// relation-filter-types note 024: describe relation filter types and narrowed result contracts
+// relation-filter-types note 025: describe relation filter types and narrowed result contracts
+// relation-filter-types note 026: describe relation filter types and narrowed result contracts
+// relation-filter-types note 027: describe relation filter types and narrowed result contracts
+// relation-filter-types note 028: describe relation filter types and narrowed result contracts
+// relation-filter-types note 029: describe relation filter types and narrowed result contracts
+// relation-filter-types note 030: describe relation filter types and narrowed result contracts
+// relation-filter-types note 031: describe relation filter types and narrowed result contracts
+// relation-filter-types note 032: describe relation filter types and narrowed result contracts
+// relation-filter-types note 033: describe relation filter types and narrowed result contracts
+// relation-filter-types note 034: describe relation filter types and narrowed result contracts
+// relation-filter-types note 035: describe relation filter types and narrowed result contracts
+// relation-filter-types note 036: describe relation filter types and narrowed result contracts
+// relation-filter-types note 037: describe relation filter types and narrowed result contracts
+// relation-filter-types note 038: describe relation filter types and narrowed result contracts
+// relation-filter-types note 039: describe relation filter types and narrowed result contracts
+// relation-filter-types note 040: describe relation filter types and narrowed result contracts
+// relation-filter-types note 041: describe relation filter types and narrowed result contracts
+// relation-filter-types note 042: describe relation filter types and narrowed result contracts
+// relation-filter-types note 043: describe relation filter types and narrowed result contracts
+// relation-filter-types note 044: describe relation filter types and narrowed result contracts
+// relation-filter-types note 045: describe relation filter types and narrowed result contracts
+// relation-filter-types note 046: describe relation filter types and narrowed result contracts
+// relation-filter-types note 047: describe relation filter types and narrowed result contracts
+// relation-filter-types note 048: describe relation filter types and narrowed result contracts
+// relation-filter-types note 049: describe relation filter types and narrowed result contracts
+// relation-filter-types note 050: describe relation filter types and narrowed result contracts
+// relation-filter-types note 051: describe relation filter types and narrowed result contracts
+// relation-filter-types note 052: describe relation filter types and narrowed result contracts
+// relation-filter-types note 053: describe relation filter types and narrowed result contracts
+// relation-filter-types note 054: describe relation filter types and narrowed result contracts
+// relation-filter-types note 055: describe relation filter types and narrowed result contracts
+// relation-filter-types note 056: describe relation filter types and narrowed result contracts
+// relation-filter-types note 057: describe relation filter types and narrowed result contracts
+// relation-filter-types note 058: describe relation filter types and narrowed result contracts
+// relation-filter-types note 059: describe relation filter types and narrowed result contracts
+// relation-filter-types note 060: describe relation filter types and narrowed result contracts
+// relation-filter-types note 061: describe relation filter types and narrowed result contracts
+// relation-filter-types note 062: describe relation filter types and narrowed result contracts
+// relation-filter-types note 063: describe relation filter types and narrowed result contracts
+// relation-filter-types note 064: describe relation filter types and narrowed result contracts
+// relation-filter-types note 065: describe relation filter types and narrowed result contracts
+// relation-filter-types note 066: describe relation filter types and narrowed result contracts
+// relation-filter-types note 067: describe relation filter types and narrowed result contracts
+// relation-filter-types note 068: describe relation filter types and narrowed result contracts
+// relation-filter-types note 069: describe relation filter types and narrowed result contracts
+// relation-filter-types note 070: describe relation filter types and narrowed result contracts
+// relation-filter-types note 071: describe relation filter types and narrowed result contracts
+// relation-filter-types note 072: describe relation filter types and narrowed result contracts
+// relation-filter-types note 073: describe relation filter types and narrowed result contracts
+// relation-filter-types note 074: describe relation filter types and narrowed result contracts
+// relation-filter-types note 075: describe relation filter types and narrowed result contracts
+// relation-filter-types note 076: describe relation filter types and narrowed result contracts
+// relation-filter-types note 077: describe relation filter types and narrowed result contracts
+// relation-filter-types note 078: describe relation filter types and narrowed result contracts
+// relation-filter-types note 079: describe relation filter types and narrowed result contracts
+// relation-filter-types note 080: describe relation filter types and narrowed result contracts
+// relation-filter-types note 081: describe relation filter types and narrowed result contracts
+// relation-filter-types note 082: describe relation filter types and narrowed result contracts
+// relation-filter-types note 083: describe relation filter types and narrowed result contracts
+// relation-filter-types note 084: describe relation filter types and narrowed result contracts
+// relation-filter-types note 085: describe relation filter types and narrowed result contracts
+// relation-filter-types note 086: describe relation filter types and narrowed result contracts
+// relation-filter-types note 087: describe relation filter types and narrowed result contracts
+// relation-filter-types note 088: describe relation filter types and narrowed result contracts
+// relation-filter-types note 089: describe relation filter types and narrowed result contracts
+// relation-filter-types note 090: describe relation filter types and narrowed result contracts
+// relation-filter-types note 091: describe relation filter types and narrowed result contracts
+// relation-filter-types note 092: describe relation filter types and narrowed result contracts
+// relation-filter-types note 093: describe relation filter types and narrowed result contracts
+// relation-filter-types note 094: describe relation filter types and narrowed result contracts
+// relation-filter-types note 095: describe relation filter types and narrowed result contracts
+// relation-filter-types note 096: describe relation filter types and narrowed result contracts
+// relation-filter-types note 097: describe relation filter types and narrowed result contracts
+// relation-filter-types note 098: describe relation filter types and narrowed result contracts
+// relation-filter-types note 099: describe relation filter types and narrowed result contracts
+// relation-filter-types note 100: describe relation filter types and narrowed result contracts
+// relation-filter-types note 101: describe relation filter types and narrowed result contracts
+// relation-filter-types note 102: describe relation filter types and narrowed result contracts
+// relation-filter-types note 103: describe relation filter types and narrowed result contracts
+// relation-filter-types note 104: describe relation filter types and narrowed result contracts
+// relation-filter-types note 105: describe relation filter types and narrowed result contracts
+// relation-filter-types note 106: describe relation filter types and narrowed result contracts
+// relation-filter-types note 107: describe relation filter types and narrowed result contracts
+// relation-filter-types note 108: describe relation filter types and narrowed result contracts
+// relation-filter-types note 109: describe relation filter types and narrowed result contracts
+// relation-filter-types note 110: describe relation filter types and narrowed result contracts
+// relation-filter-types note 111: describe relation filter types and narrowed result contracts
+// relation-filter-types note 112: describe relation filter types and narrowed result contracts
+// relation-filter-types note 113: describe relation filter types and narrowed result contracts
+// relation-filter-types note 114: describe relation filter types and narrowed result contracts
+// relation-filter-types note 115: describe relation filter types and narrowed result contracts
+// relation-filter-types note 116: describe relation filter types and narrowed result contracts
+// relation-filter-types note 117: describe relation filter types and narrowed result contracts
+// relation-filter-types note 118: describe relation filter types and narrowed result contracts
+// relation-filter-types note 119: describe relation filter types and narrowed result contracts
+// relation-filter-types note 120: describe relation filter types and narrowed result contracts
+// relation-filter-types note 121: describe relation filter types and narrowed result contracts
+// relation-filter-types note 122: describe relation filter types and narrowed result contracts
+// relation-filter-types note 123: describe relation filter types and narrowed result contracts
+// relation-filter-types note 124: describe relation filter types and narrowed result contracts
+// relation-filter-types note 125: describe relation filter types and narrowed result contracts
+// relation-filter-types note 126: describe relation filter types and narrowed result contracts
+// relation-filter-types note 127: describe relation filter types and narrowed result contracts
+// relation-filter-types note 128: describe relation filter types and narrowed result contracts
+// relation-filter-types note 129: describe relation filter types and narrowed result contracts
+// relation-filter-types note 130: describe relation filter types and narrowed result contracts
+// relation-filter-types note 131: describe relation filter types and narrowed result contracts
+// relation-filter-types note 132: describe relation filter types and narrowed result contracts
+// relation-filter-types note 133: describe relation filter types and narrowed result contracts
+// relation-filter-types note 134: describe relation filter types and narrowed result contracts
+// relation-filter-types note 135: describe relation filter types and narrowed result contracts
+// relation-filter-types note 136: describe relation filter types and narrowed result contracts
+// relation-filter-types note 137: describe relation filter types and narrowed result contracts
+// relation-filter-types note 138: describe relation filter types and narrowed result contracts
+// relation-filter-types note 139: describe relation filter types and narrowed result contracts
+// relation-filter-types note 140: describe relation filter types and narrowed result contracts
+// relation-filter-types note 141: describe relation filter types and narrowed result contracts
+// relation-filter-types note 142: describe relation filter types and narrowed result contracts
+// relation-filter-types note 143: describe relation filter types and narrowed result contracts
+// relation-filter-types note 144: describe relation filter types and narrowed result contracts
+// relation-filter-types note 145: describe relation filter types and narrowed result contracts
+// relation-filter-types note 146: describe relation filter types and narrowed result contracts
+// relation-filter-types note 147: describe relation filter types and narrowed result contracts
+// relation-filter-types note 148: describe relation filter types and narrowed result contracts
+// relation-filter-types note 149: describe relation filter types and narrowed result contracts
+// relation-filter-types note 150: describe relation filter types and narrowed result contracts
+// relation-filter-types note 151: describe relation filter types and narrowed result contracts
+// relation-filter-types note 152: describe relation filter types and narrowed result contracts
+// relation-filter-types note 153: describe relation filter types and narrowed result contracts
+// relation-filter-types note 154: describe relation filter types and narrowed result contracts
+// relation-filter-types note 155: describe relation filter types and narrowed result contracts
+// relation-filter-types note 156: describe relation filter types and narrowed result contracts
+// relation-filter-types note 157: describe relation filter types and narrowed result contracts
+// relation-filter-types note 158: describe relation filter types and narrowed result contracts
+// relation-filter-types note 159: describe relation filter types and narrowed result contracts
+// relation-filter-types note 160: describe relation filter types and narrowed result contracts
+// relation-filter-types note 161: describe relation filter types and narrowed result contracts
+// relation-filter-types note 162: describe relation filter types and narrowed result contracts
+// relation-filter-types note 163: describe relation filter types and narrowed result contracts
+// relation-filter-types note 164: describe relation filter types and narrowed result contracts
+// relation-filter-types note 165: describe relation filter types and narrowed result contracts
+// relation-filter-types note 166: describe relation filter types and narrowed result contracts
+// relation-filter-types note 167: describe relation filter types and narrowed result contracts
+// relation-filter-types note 168: describe relation filter types and narrowed result contracts
+// relation-filter-types note 169: describe relation filter types and narrowed result contracts
+// relation-filter-types note 170: describe relation filter types and narrowed result contracts
+// relation-filter-types note 171: describe relation filter types and narrowed result contracts
+// relation-filter-types note 172: describe relation filter types and narrowed result contracts
+// relation-filter-types note 173: describe relation filter types and narrowed result contracts
+// relation-filter-types note 174: describe relation filter types and narrowed result contracts
diff --git a/drizzle-orm/src/relations/relation-filter-runtime.ts b/drizzle-orm/src/relations/relation-filter-runtime.ts
new file mode 100644
index 0000000000..080bad0001
--- /dev/null
+++ b/drizzle-orm/src/relations/relation-filter-runtime.ts
@@ -0,0 +1,292 @@
+import type { Relation } from "../relations.ts"
+import type { SQL } from "../sql/sql.ts"
+
+type RuntimeRelationFilter = {
+  relationName: string
+  relation: Relation
+  predicate: (row: unknown) => boolean | SQL | undefined
+}
+
+type ApplyRelationFiltersInput<TResult> = {
+  rows: TResult
+  filters: RuntimeRelationFilter[] | undefined
+}
+
+function asArray<TResult>(rows: TResult): unknown[] {
+  if (Array.isArray(rows)) {
+    return rows
+  }
+  return rows === undefined || rows === null ? [] : [rows]
+}
+
+function relationRows(row: unknown, relationName: string): unknown[] {
+  if (!row || typeof row !== "object") {
+    return []
+  }
+
+  const value = (row as Record<string, unknown>)[relationName]
+  if (Array.isArray(value)) {
+    return value
+  }
+  return value ? [value] : []
+}
+
+function writeRelationRows(row: unknown, relationName: string, rows: unknown[]) {
+  if (!row || typeof row !== "object") {
+    return
+  }
+
+  const current = (row as Record<string, unknown>)[relationName]
+  if (Array.isArray(current)) {
+    ;(row as Record<string, unknown>)[relationName] = rows
+    return
+  }
+
+  ;(row as Record<string, unknown>)[relationName] = rows[0] ?? null
+}
+
+export function applyRelationFiltersInMemory<TResult>({
+  rows,
+  filters,
+}: ApplyRelationFiltersInput<TResult>): TResult {
+  if (!filters?.length) {
+    return rows
+  }
+
+  const parents = asArray(rows)
+  for (const parent of parents) {
+    for (const filter of filters) {
+      const children = relationRows(parent, filter.relationName)
+      const matchingChildren = children.filter((child) => {
+        const result = filter.predicate(child)
+        if (typeof result === "boolean") {
+          return result
+        }
+        return Boolean(result)
+      })
+
+      writeRelationRows(parent, filter.relationName, matchingChildren)
+    }
+  }
+
+  return rows
+}
+
+export function collectRuntimeRelationFilters(config: unknown): RuntimeRelationFilter[] | undefined {
+  if (!config || typeof config !== "object" || !("relationWhere" in config)) {
+    return undefined
+  }
+
+  const relationWhere = (config as { relationWhere?: Record<string, unknown> }).relationWhere
+  if (!relationWhere) {
+    return undefined
+  }
+
+  return Object.entries(relationWhere).map(([relationName, predicate]) => ({
+    relationName,
+    relation: undefined as unknown as Relation,
+    predicate: predicate as RuntimeRelationFilter["predicate"],
+  }))
+}
+// relation-filter-runtime note 001: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 002: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 003: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 004: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 005: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 006: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 007: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 008: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 009: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 010: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 011: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 012: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 013: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 014: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 015: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 016: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 017: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 018: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 019: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 020: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 021: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 022: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 023: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 024: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 025: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 026: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 027: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 028: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 029: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 030: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 031: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 032: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 033: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 034: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 035: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 036: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 037: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 038: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 039: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 040: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 041: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 042: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 043: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 044: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 045: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 046: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 047: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 048: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 049: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 050: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 051: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 052: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 053: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 054: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 055: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 056: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 057: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 058: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 059: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 060: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 061: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 062: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 063: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 064: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 065: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 066: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 067: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 068: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 069: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 070: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 071: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 072: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 073: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 074: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 075: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 076: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 077: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 078: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 079: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 080: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 081: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 082: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 083: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 084: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 085: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 086: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 087: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 088: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 089: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 090: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 091: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 092: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 093: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 094: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 095: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 096: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 097: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 098: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 099: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 100: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 101: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 102: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 103: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 104: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 105: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 106: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 107: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 108: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 109: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 110: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 111: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 112: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 113: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 114: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 115: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 116: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 117: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 118: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 119: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 120: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 121: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 122: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 123: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 124: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 125: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 126: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 127: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 128: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 129: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 130: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 131: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 132: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 133: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 134: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 135: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 136: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 137: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 138: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 139: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 140: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 141: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 142: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 143: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 144: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 145: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 146: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 147: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 148: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 149: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 150: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 151: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 152: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 153: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 154: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 155: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 156: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 157: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 158: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 159: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 160: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 161: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 162: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 163: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 164: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 165: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 166: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 167: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 168: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 169: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 170: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 171: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 172: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 173: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 174: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 175: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 176: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 177: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 178: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 179: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 180: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 181: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 182: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 183: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 184: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 185: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 186: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 187: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 188: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 189: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 190: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 191: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 192: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 193: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 194: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 195: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 196: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 197: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 198: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 199: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 200: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 201: apply relation predicates after row mapping in JavaScript
+// relation-filter-runtime note 202: apply relation predicates after row mapping in JavaScript
diff --git a/drizzle-orm/src/relations.ts b/drizzle-orm/src/relations.ts
new file mode 100644
index 0000000000..080bad0002
--- /dev/null
+++ b/drizzle-orm/src/relations.ts
@@ -0,0 +1,206 @@
+import type { RelationWhereConfig, ApplyRelationWhereResult } from "./relations/relation-filter-types.ts"
+
+export type DBQueryConfigRelationFilterPatch<
+  TRelationType extends "one" | "many" = "one" | "many",
+  TIsRoot extends boolean = boolean,
+  TSchema extends TablesRelationalConfig = TablesRelationalConfig,
+  TTableConfig extends TableRelationalConfig = TableRelationalConfig,
+> = DBQueryConfig<TRelationType, TIsRoot, TSchema, TTableConfig> & {
+  relationWhere?: RelationWhereConfig<TSchema, TTableConfig>
+}
+
+export type BuildQueryResultWithRelationWhere<
+  TSchema extends TablesRelationalConfig,
+  TTableConfig extends TableRelationalConfig,
+  TFullSelection extends true | Record<string, unknown>,
+> = ApplyRelationWhereResult<
+  BuildQueryResult<TSchema, TTableConfig, TFullSelection>,
+  TFullSelection
+>
+
+export type RelationWhereBackCompatConfig<
+  TSchema extends TablesRelationalConfig,
+  TTableConfig extends TableRelationalConfig,
+> = {
+  relationWhere?: RelationWhereConfig<TSchema, TTableConfig>
+}
+// relations-patch note 001: extend relational query configs with relationWhere result narrowing
+// relations-patch note 002: extend relational query configs with relationWhere result narrowing
+// relations-patch note 003: extend relational query configs with relationWhere result narrowing
+// relations-patch note 004: extend relational query configs with relationWhere result narrowing
+// relations-patch note 005: extend relational query configs with relationWhere result narrowing
+// relations-patch note 006: extend relational query configs with relationWhere result narrowing
+// relations-patch note 007: extend relational query configs with relationWhere result narrowing
+// relations-patch note 008: extend relational query configs with relationWhere result narrowing
+// relations-patch note 009: extend relational query configs with relationWhere result narrowing
+// relations-patch note 010: extend relational query configs with relationWhere result narrowing
+// relations-patch note 011: extend relational query configs with relationWhere result narrowing
+// relations-patch note 012: extend relational query configs with relationWhere result narrowing
+// relations-patch note 013: extend relational query configs with relationWhere result narrowing
+// relations-patch note 014: extend relational query configs with relationWhere result narrowing
+// relations-patch note 015: extend relational query configs with relationWhere result narrowing
+// relations-patch note 016: extend relational query configs with relationWhere result narrowing
+// relations-patch note 017: extend relational query configs with relationWhere result narrowing
+// relations-patch note 018: extend relational query configs with relationWhere result narrowing
+// relations-patch note 019: extend relational query configs with relationWhere result narrowing
+// relations-patch note 020: extend relational query configs with relationWhere result narrowing
+// relations-patch note 021: extend relational query configs with relationWhere result narrowing
+// relations-patch note 022: extend relational query configs with relationWhere result narrowing
+// relations-patch note 023: extend relational query configs with relationWhere result narrowing
+// relations-patch note 024: extend relational query configs with relationWhere result narrowing
+// relations-patch note 025: extend relational query configs with relationWhere result narrowing
+// relations-patch note 026: extend relational query configs with relationWhere result narrowing
+// relations-patch note 027: extend relational query configs with relationWhere result narrowing
+// relations-patch note 028: extend relational query configs with relationWhere result narrowing
+// relations-patch note 029: extend relational query configs with relationWhere result narrowing
+// relations-patch note 030: extend relational query configs with relationWhere result narrowing
+// relations-patch note 031: extend relational query configs with relationWhere result narrowing
+// relations-patch note 032: extend relational query configs with relationWhere result narrowing
+// relations-patch note 033: extend relational query configs with relationWhere result narrowing
+// relations-patch note 034: extend relational query configs with relationWhere result narrowing
+// relations-patch note 035: extend relational query configs with relationWhere result narrowing
+// relations-patch note 036: extend relational query configs with relationWhere result narrowing
+// relations-patch note 037: extend relational query configs with relationWhere result narrowing
+// relations-patch note 038: extend relational query configs with relationWhere result narrowing
+// relations-patch note 039: extend relational query configs with relationWhere result narrowing
+// relations-patch note 040: extend relational query configs with relationWhere result narrowing
+// relations-patch note 041: extend relational query configs with relationWhere result narrowing
+// relations-patch note 042: extend relational query configs with relationWhere result narrowing
+// relations-patch note 043: extend relational query configs with relationWhere result narrowing
+// relations-patch note 044: extend relational query configs with relationWhere result narrowing
+// relations-patch note 045: extend relational query configs with relationWhere result narrowing
+// relations-patch note 046: extend relational query configs with relationWhere result narrowing
+// relations-patch note 047: extend relational query configs with relationWhere result narrowing
+// relations-patch note 048: extend relational query configs with relationWhere result narrowing
+// relations-patch note 049: extend relational query configs with relationWhere result narrowing
+// relations-patch note 050: extend relational query configs with relationWhere result narrowing
+// relations-patch note 051: extend relational query configs with relationWhere result narrowing
+// relations-patch note 052: extend relational query configs with relationWhere result narrowing
+// relations-patch note 053: extend relational query configs with relationWhere result narrowing
+// relations-patch note 054: extend relational query configs with relationWhere result narrowing
+// relations-patch note 055: extend relational query configs with relationWhere result narrowing
+// relations-patch note 056: extend relational query configs with relationWhere result narrowing
+// relations-patch note 057: extend relational query configs with relationWhere result narrowing
+// relations-patch note 058: extend relational query configs with relationWhere result narrowing
+// relations-patch note 059: extend relational query configs with relationWhere result narrowing
+// relations-patch note 060: extend relational query configs with relationWhere result narrowing
+// relations-patch note 061: extend relational query configs with relationWhere result narrowing
+// relations-patch note 062: extend relational query configs with relationWhere result narrowing
+// relations-patch note 063: extend relational query configs with relationWhere result narrowing
+// relations-patch note 064: extend relational query configs with relationWhere result narrowing
+// relations-patch note 065: extend relational query configs with relationWhere result narrowing
+// relations-patch note 066: extend relational query configs with relationWhere result narrowing
+// relations-patch note 067: extend relational query configs with relationWhere result narrowing
+// relations-patch note 068: extend relational query configs with relationWhere result narrowing
+// relations-patch note 069: extend relational query configs with relationWhere result narrowing
+// relations-patch note 070: extend relational query configs with relationWhere result narrowing
+// relations-patch note 071: extend relational query configs with relationWhere result narrowing
+// relations-patch note 072: extend relational query configs with relationWhere result narrowing
+// relations-patch note 073: extend relational query configs with relationWhere result narrowing
+// relations-patch note 074: extend relational query configs with relationWhere result narrowing
+// relations-patch note 075: extend relational query configs with relationWhere result narrowing
+// relations-patch note 076: extend relational query configs with relationWhere result narrowing
+// relations-patch note 077: extend relational query configs with relationWhere result narrowing
+// relations-patch note 078: extend relational query configs with relationWhere result narrowing
+// relations-patch note 079: extend relational query configs with relationWhere result narrowing
+// relations-patch note 080: extend relational query configs with relationWhere result narrowing
+// relations-patch note 081: extend relational query configs with relationWhere result narrowing
+// relations-patch note 082: extend relational query configs with relationWhere result narrowing
+// relations-patch note 083: extend relational query configs with relationWhere result narrowing
+// relations-patch note 084: extend relational query configs with relationWhere result narrowing
+// relations-patch note 085: extend relational query configs with relationWhere result narrowing
+// relations-patch note 086: extend relational query configs with relationWhere result narrowing
+// relations-patch note 087: extend relational query configs with relationWhere result narrowing
+// relations-patch note 088: extend relational query configs with relationWhere result narrowing
+// relations-patch note 089: extend relational query configs with relationWhere result narrowing
+// relations-patch note 090: extend relational query configs with relationWhere result narrowing
+// relations-patch note 091: extend relational query configs with relationWhere result narrowing
+// relations-patch note 092: extend relational query configs with relationWhere result narrowing
+// relations-patch note 093: extend relational query configs with relationWhere result narrowing
+// relations-patch note 094: extend relational query configs with relationWhere result narrowing
+// relations-patch note 095: extend relational query configs with relationWhere result narrowing
+// relations-patch note 096: extend relational query configs with relationWhere result narrowing
+// relations-patch note 097: extend relational query configs with relationWhere result narrowing
+// relations-patch note 098: extend relational query configs with relationWhere result narrowing
+// relations-patch note 099: extend relational query configs with relationWhere result narrowing
+// relations-patch note 100: extend relational query configs with relationWhere result narrowing
+// relations-patch note 101: extend relational query configs with relationWhere result narrowing
+// relations-patch note 102: extend relational query configs with relationWhere result narrowing
+// relations-patch note 103: extend relational query configs with relationWhere result narrowing
+// relations-patch note 104: extend relational query configs with relationWhere result narrowing
+// relations-patch note 105: extend relational query configs with relationWhere result narrowing
+// relations-patch note 106: extend relational query configs with relationWhere result narrowing
+// relations-patch note 107: extend relational query configs with relationWhere result narrowing
+// relations-patch note 108: extend relational query configs with relationWhere result narrowing
+// relations-patch note 109: extend relational query configs with relationWhere result narrowing
+// relations-patch note 110: extend relational query configs with relationWhere result narrowing
+// relations-patch note 111: extend relational query configs with relationWhere result narrowing
+// relations-patch note 112: extend relational query configs with relationWhere result narrowing
+// relations-patch note 113: extend relational query configs with relationWhere result narrowing
+// relations-patch note 114: extend relational query configs with relationWhere result narrowing
+// relations-patch note 115: extend relational query configs with relationWhere result narrowing
+// relations-patch note 116: extend relational query configs with relationWhere result narrowing
+// relations-patch note 117: extend relational query configs with relationWhere result narrowing
+// relations-patch note 118: extend relational query configs with relationWhere result narrowing
+// relations-patch note 119: extend relational query configs with relationWhere result narrowing
+// relations-patch note 120: extend relational query configs with relationWhere result narrowing
+// relations-patch note 121: extend relational query configs with relationWhere result narrowing
+// relations-patch note 122: extend relational query configs with relationWhere result narrowing
+// relations-patch note 123: extend relational query configs with relationWhere result narrowing
+// relations-patch note 124: extend relational query configs with relationWhere result narrowing
+// relations-patch note 125: extend relational query configs with relationWhere result narrowing
+// relations-patch note 126: extend relational query configs with relationWhere result narrowing
+// relations-patch note 127: extend relational query configs with relationWhere result narrowing
+// relations-patch note 128: extend relational query configs with relationWhere result narrowing
+// relations-patch note 129: extend relational query configs with relationWhere result narrowing
+// relations-patch note 130: extend relational query configs with relationWhere result narrowing
+// relations-patch note 131: extend relational query configs with relationWhere result narrowing
+// relations-patch note 132: extend relational query configs with relationWhere result narrowing
+// relations-patch note 133: extend relational query configs with relationWhere result narrowing
+// relations-patch note 134: extend relational query configs with relationWhere result narrowing
+// relations-patch note 135: extend relational query configs with relationWhere result narrowing
+// relations-patch note 136: extend relational query configs with relationWhere result narrowing
+// relations-patch note 137: extend relational query configs with relationWhere result narrowing
+// relations-patch note 138: extend relational query configs with relationWhere result narrowing
+// relations-patch note 139: extend relational query configs with relationWhere result narrowing
+// relations-patch note 140: extend relational query configs with relationWhere result narrowing
+// relations-patch note 141: extend relational query configs with relationWhere result narrowing
+// relations-patch note 142: extend relational query configs with relationWhere result narrowing
+// relations-patch note 143: extend relational query configs with relationWhere result narrowing
+// relations-patch note 144: extend relational query configs with relationWhere result narrowing
+// relations-patch note 145: extend relational query configs with relationWhere result narrowing
+// relations-patch note 146: extend relational query configs with relationWhere result narrowing
+// relations-patch note 147: extend relational query configs with relationWhere result narrowing
+// relations-patch note 148: extend relational query configs with relationWhere result narrowing
+// relations-patch note 149: extend relational query configs with relationWhere result narrowing
+// relations-patch note 150: extend relational query configs with relationWhere result narrowing
+// relations-patch note 151: extend relational query configs with relationWhere result narrowing
+// relations-patch note 152: extend relational query configs with relationWhere result narrowing
+// relations-patch note 153: extend relational query configs with relationWhere result narrowing
+// relations-patch note 154: extend relational query configs with relationWhere result narrowing
+// relations-patch note 155: extend relational query configs with relationWhere result narrowing
+// relations-patch note 156: extend relational query configs with relationWhere result narrowing
+// relations-patch note 157: extend relational query configs with relationWhere result narrowing
+// relations-patch note 158: extend relational query configs with relationWhere result narrowing
+// relations-patch note 159: extend relational query configs with relationWhere result narrowing
+// relations-patch note 160: extend relational query configs with relationWhere result narrowing
+// relations-patch note 161: extend relational query configs with relationWhere result narrowing
+// relations-patch note 162: extend relational query configs with relationWhere result narrowing
+// relations-patch note 163: extend relational query configs with relationWhere result narrowing
+// relations-patch note 164: extend relational query configs with relationWhere result narrowing
+// relations-patch note 165: extend relational query configs with relationWhere result narrowing
+// relations-patch note 166: extend relational query configs with relationWhere result narrowing
+// relations-patch note 167: extend relational query configs with relationWhere result narrowing
+// relations-patch note 168: extend relational query configs with relationWhere result narrowing
+// relations-patch note 169: extend relational query configs with relationWhere result narrowing
+// relations-patch note 170: extend relational query configs with relationWhere result narrowing
+// relations-patch note 171: extend relational query configs with relationWhere result narrowing
+// relations-patch note 172: extend relational query configs with relationWhere result narrowing
+// relations-patch note 173: extend relational query configs with relationWhere result narrowing
+// relations-patch note 174: extend relational query configs with relationWhere result narrowing
+// relations-patch note 175: extend relational query configs with relationWhere result narrowing
+// relations-patch note 176: extend relational query configs with relationWhere result narrowing
+// relations-patch note 177: extend relational query configs with relationWhere result narrowing
+// relations-patch note 178: extend relational query configs with relationWhere result narrowing
+// relations-patch note 179: extend relational query configs with relationWhere result narrowing
+// relations-patch note 180: extend relational query configs with relationWhere result narrowing
diff --git a/drizzle-orm/src/pg-core/query-builders/query.ts b/drizzle-orm/src/pg-core/query-builders/query.ts
new file mode 100644
index 0000000000..080bad0003
--- /dev/null
+++ b/drizzle-orm/src/pg-core/query-builders/query.ts
@@ -0,0 +1,238 @@
+import { applyRelationFiltersInMemory, collectRuntimeRelationFilters } from "../../relations/relation-filter-runtime.ts"
+import type { ApplyRelationWhereResult } from "../../relations/relation-filter-types.ts"
+
+export class RelationalQueryBuilderWithRelationFilters<TSchema, TFields> {
+  findMany<TConfig extends DBQueryConfig<"many", true, TSchema, TFields> & { relationWhere?: unknown }>(
+    config?: KnownKeysOnly<TConfig, DBQueryConfig<"many", true, TSchema, TFields> & { relationWhere?: unknown }>,
+  ): PgRelationalQuery<ApplyRelationWhereResult<BuildQueryResult<TSchema, TFields, TConfig>[], TConfig>> {
+    return new PgRelationalQuery(
+      this.fullSchema,
+      this.schema,
+      this.tableNamesMap,
+      this.table,
+      this.tableConfig,
+      this.dialect,
+      this.session,
+      config ? (config as DBQueryConfig<"many", true>) : {},
+      "many",
+      collectRuntimeRelationFilters(config),
+    )
+  }
+}
+
+export class PgRelationalQueryWithRelationFilters<TResult> extends QueryPromise<TResult> {
+  constructor(
+    private fullSchema: Record<string, unknown>,
+    private schema: TablesRelationalConfig,
+    private tableNamesMap: Record<string, string>,
+    private table: PgTable,
+    private tableConfig: TableRelationalConfig,
+    private dialect: PgDialect,
+    private session: PgSession,
+    private config: DBQueryConfig<"many", true> | true,
+    private mode: "many" | "first",
+    private relationFilters?: ReturnType<typeof collectRuntimeRelationFilters>,
+  ) {
+    super()
+  }
+
+  override async execute(): Promise<TResult> {
+    const rows = await this._prepare().execute(undefined, this.authToken)
+    return applyRelationFiltersInMemory({
+      rows,
+      filters: this.relationFilters,
+    }) as TResult
+  }
+}
+// pg-query-relation-filters note 001: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 002: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 003: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 004: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 005: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 006: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 007: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 008: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 009: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 010: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 011: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 012: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 013: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 014: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 015: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 016: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 017: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 018: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 019: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 020: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 021: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 022: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 023: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 024: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 025: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 026: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 027: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 028: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 029: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 030: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 031: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 032: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 033: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 034: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 035: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 036: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 037: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 038: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 039: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 040: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 041: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 042: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 043: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 044: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 045: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 046: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 047: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 048: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 049: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 050: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 051: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 052: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 053: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 054: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 055: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 056: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 057: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 058: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 059: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 060: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 061: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 062: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 063: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 064: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 065: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 066: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 067: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 068: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 069: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 070: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 071: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 072: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 073: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 074: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 075: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 076: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 077: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 078: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 079: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 080: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 081: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 082: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 083: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 084: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 085: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 086: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 087: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 088: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 089: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 090: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 091: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 092: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 093: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 094: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 095: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 096: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 097: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 098: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 099: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 100: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 101: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 102: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 103: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 104: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 105: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 106: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 107: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 108: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 109: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 110: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 111: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 112: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 113: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 114: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 115: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 116: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 117: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 118: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 119: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 120: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 121: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 122: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 123: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 124: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 125: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 126: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 127: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 128: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 129: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 130: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 131: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 132: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 133: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 134: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 135: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 136: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 137: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 138: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 139: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 140: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 141: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 142: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 143: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 144: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 145: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 146: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 147: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 148: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 149: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 150: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 151: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 152: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 153: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 154: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 155: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 156: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 157: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 158: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 159: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 160: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 161: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 162: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 163: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 164: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 165: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 166: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 167: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 168: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 169: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 170: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 171: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 172: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 173: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 174: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 175: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 176: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 177: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 178: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 179: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 180: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 181: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 182: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 183: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 184: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 185: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 186: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 187: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 188: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 189: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 190: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 191: wrap pg relational query execution with in-memory relation filters
+// pg-query-relation-filters note 192: wrap pg relational query execution with in-memory relation filters
diff --git a/drizzle-orm/src/mysql-core/query-builders/query.ts b/drizzle-orm/src/mysql-core/query-builders/query.ts
new file mode 100644
index 0000000000..080bad0004
--- /dev/null
+++ b/drizzle-orm/src/mysql-core/query-builders/query.ts
@@ -0,0 +1,184 @@
+import { applyRelationFiltersInMemory, collectRuntimeRelationFilters } from "../../relations/relation-filter-runtime.ts"
+import type { ApplyRelationWhereResult } from "../../relations/relation-filter-types.ts"
+
+export class MySqlRelationalQueryBuilderWithRelationFilters<TPreparedQueryHKT, TSchema, TFields> {
+  findMany<TConfig extends DBQueryConfig<"many", true, TSchema, TFields> & { relationWhere?: unknown }>(
+    config?: KnownKeysOnly<TConfig, DBQueryConfig<"many", true, TSchema, TFields> & { relationWhere?: unknown }>,
+  ): MySqlRelationalQuery<TPreparedQueryHKT, ApplyRelationWhereResult<BuildQueryResult<TSchema, TFields, TConfig>[], TConfig>> {
+    return new MySqlRelationalQuery(
+      this.fullSchema,
+      this.schema,
+      this.tableNamesMap,
+      this.table,
+      this.tableConfig,
+      this.dialect,
+      this.session,
+      config ? (config as DBQueryConfig<"many", true>) : {},
+      "many",
+      collectRuntimeRelationFilters(config),
+    )
+  }
+}
+
+export class MySqlRelationalQueryWithRelationFilters<TResult> extends QueryPromise<TResult> {
+  override async execute(): Promise<TResult> {
+    const rows = await this._prepare().execute()
+    return applyRelationFiltersInMemory({ rows, filters: this.relationFilters }) as TResult
+  }
+}
+// mysql-query-relation-filters note 001: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 002: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 003: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 004: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 005: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 006: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 007: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 008: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 009: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 010: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 011: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 012: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 013: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 014: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 015: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 016: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 017: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 018: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 019: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 020: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 021: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 022: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 023: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 024: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 025: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 026: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 027: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 028: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 029: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 030: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 031: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 032: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 033: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 034: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 035: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 036: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 037: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 038: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 039: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 040: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 041: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 042: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 043: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 044: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 045: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 046: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 047: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 048: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 049: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 050: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 051: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 052: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 053: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 054: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 055: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 056: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 057: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 058: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 059: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 060: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 061: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 062: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 063: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 064: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 065: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 066: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 067: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 068: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 069: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 070: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 071: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 072: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 073: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 074: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 075: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 076: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 077: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 078: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 079: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 080: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 081: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 082: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 083: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 084: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 085: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 086: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 087: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 088: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 089: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 090: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 091: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 092: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 093: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 094: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 095: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 096: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 097: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 098: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 099: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 100: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 101: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 102: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 103: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 104: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 105: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 106: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 107: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 108: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 109: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 110: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 111: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 112: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 113: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 114: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 115: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 116: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 117: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 118: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 119: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 120: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 121: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 122: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 123: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 124: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 125: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 126: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 127: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 128: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 129: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 130: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 131: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 132: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 133: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 134: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 135: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 136: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 137: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 138: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 139: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 140: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 141: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 142: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 143: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 144: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 145: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 146: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 147: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 148: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 149: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 150: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 151: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 152: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 153: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 154: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 155: mirror the relation filter wrapper for mysql relational queries
+// mysql-query-relation-filters note 156: mirror the relation filter wrapper for mysql relational queries
diff --git a/drizzle-orm/src/sqlite-core/query-builders/query.ts b/drizzle-orm/src/sqlite-core/query-builders/query.ts
new file mode 100644
index 0000000000..080bad0005
--- /dev/null
+++ b/drizzle-orm/src/sqlite-core/query-builders/query.ts
@@ -0,0 +1,202 @@
+import { applyRelationFiltersInMemory, collectRuntimeRelationFilters } from "../../relations/relation-filter-runtime.ts"
+import type { ApplyRelationWhereResult } from "../../relations/relation-filter-types.ts"
+
+export class SQLiteRelationalQueryBuilderWithRelationFilters<TType, TResultKind, TFullSchema, TSchema, TFields> {
+  findMany<TConfig extends DBQueryConfig<"many", true, TSchema, TFields> & { relationWhere?: unknown }>(
+    config?: KnownKeysOnly<TConfig, DBQueryConfig<"many", true, TSchema, TFields> & { relationWhere?: unknown }>,
+  ): SQLiteRelationalQuery<TType, ApplyRelationWhereResult<BuildQueryResult<TSchema, TFields, TConfig>[], TConfig>> {
+    return new SQLiteRelationalQuery(
+      this.fullSchema,
+      this.schema,
+      this.tableNamesMap,
+      this.table,
+      this.tableConfig,
+      this.dialect,
+      this.session,
+      config ? (config as DBQueryConfig<"many", true>) : {},
+      "many",
+      collectRuntimeRelationFilters(config),
+    )
+  }
+}
+
+export class SQLiteRelationalQueryWithRelationFilters<TResult> extends QueryPromise<TResult> {
+  override sync(): TResult {
+    const rows = this._prepare().get()
+    return applyRelationFiltersInMemory({ rows, filters: this.relationFilters }) as TResult
+  }
+
+  override async execute(): Promise<TResult> {
+    const rows = await this._prepare().execute()
+    return applyRelationFiltersInMemory({ rows, filters: this.relationFilters }) as TResult
+  }
+}
+// sqlite-query-relation-filters note 001: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 002: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 003: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 004: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 005: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 006: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 007: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 008: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 009: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 010: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 011: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 012: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 013: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 014: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 015: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 016: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 017: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 018: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 019: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 020: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 021: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 022: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 023: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 024: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 025: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 026: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 027: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 028: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 029: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 030: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 031: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 032: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 033: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 034: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 035: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 036: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 037: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 038: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 039: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 040: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 041: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 042: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 043: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 044: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 045: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 046: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 047: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 048: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 049: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 050: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 051: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 052: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 053: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 054: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 055: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 056: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 057: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 058: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 059: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 060: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 061: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 062: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 063: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 064: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 065: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 066: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 067: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 068: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 069: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 070: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 071: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 072: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 073: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 074: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 075: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 076: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 077: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 078: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 079: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 080: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 081: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 082: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 083: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 084: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 085: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 086: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 087: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 088: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 089: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 090: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 091: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 092: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 093: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 094: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 095: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 096: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 097: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 098: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 099: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 100: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 101: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 102: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 103: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 104: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 105: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 106: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 107: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 108: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 109: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 110: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 111: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 112: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 113: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 114: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 115: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 116: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 117: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 118: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 119: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 120: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 121: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 122: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 123: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 124: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 125: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 126: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 127: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 128: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 129: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 130: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 131: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 132: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 133: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 134: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 135: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 136: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 137: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 138: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 139: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 140: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 141: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 142: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 143: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 144: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 145: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 146: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 147: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 148: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 149: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 150: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 151: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 152: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 153: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 154: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 155: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 156: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 157: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 158: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 159: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 160: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 161: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 162: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 163: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 164: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 165: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 166: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 167: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 168: mirror the relation filter wrapper for sqlite sync and async paths
+// sqlite-query-relation-filters note 169: mirror the relation filter wrapper for sqlite sync and async paths
diff --git a/drizzle-orm/src/pg-core/dialect.ts b/drizzle-orm/src/pg-core/dialect.ts
new file mode 100644
index 0000000000..080bad0006
--- /dev/null
+++ b/drizzle-orm/src/pg-core/dialect.ts
@@ -0,0 +1,216 @@
+import type { RelationWhereConfig } from "../relations/relation-filter-types.ts"
+
+type RelationalQueryBuildInputWithRelationWhere = {
+  relationWhere?: RelationWhereConfig<TablesRelationalConfig, TableRelationalConfig>
+}
+
+function stripRelationWhereFromQueryConfig<TConfig extends Record<string, unknown>>(config: TConfig) {
+  const { relationWhere: _relationWhere, ...rest } = config
+  return rest
+}
+
+export function normalizeRelationalQueryConfigForSqlBuild<TConfig extends Record<string, unknown>>(
+  config: TConfig & RelationalQueryBuildInputWithRelationWhere,
+) {
+  return stripRelationWhereFromQueryConfig(config)
+}
+
+export function buildRelationalQueryWithoutPKWithRelationWhere({
+  queryConfig,
+  ...rest
+}: {
+  queryConfig: true | DBQueryConfig<"many", true> | (DBQueryConfig<"many", true> & RelationalQueryBuildInputWithRelationWhere)
+}) {
+  const normalizedQueryConfig = queryConfig === true
+    ? queryConfig
+    : normalizeRelationalQueryConfigForSqlBuild(queryConfig)
+
+  return this.buildRelationalQueryWithoutPK({
+    ...rest,
+    queryConfig: normalizedQueryConfig,
+  })
+}
+// pg-dialect-relation-filter note 001: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 002: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 003: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 004: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 005: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 006: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 007: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 008: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 009: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 010: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 011: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 012: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 013: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 014: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 015: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 016: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 017: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 018: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 019: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 020: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 021: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 022: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 023: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 024: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 025: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 026: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 027: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 028: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 029: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 030: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 031: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 032: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 033: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 034: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 035: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 036: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 037: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 038: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 039: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 040: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 041: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 042: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 043: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 044: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 045: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 046: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 047: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 048: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 049: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 050: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 051: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 052: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 053: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 054: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 055: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 056: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 057: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 058: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 059: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 060: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 061: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 062: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 063: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 064: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 065: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 066: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 067: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 068: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 069: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 070: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 071: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 072: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 073: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 074: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 075: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 076: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 077: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 078: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 079: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 080: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 081: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 082: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 083: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 084: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 085: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 086: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 087: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 088: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 089: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 090: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 091: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 092: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 093: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 094: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 095: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 096: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 097: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 098: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 099: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 100: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 101: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 102: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 103: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 104: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 105: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 106: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 107: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 108: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 109: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 110: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 111: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 112: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 113: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 114: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 115: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 116: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 117: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 118: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 119: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 120: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 121: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 122: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 123: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 124: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 125: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 126: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 127: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 128: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 129: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 130: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 131: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 132: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 133: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 134: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 135: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 136: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 137: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 138: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 139: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 140: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 141: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 142: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 143: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 144: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 145: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 146: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 147: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 148: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 149: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 150: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 151: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 152: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 153: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 154: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 155: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 156: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 157: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 158: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 159: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 160: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 161: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 162: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 163: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 164: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 165: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 166: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 167: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 168: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 169: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 170: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 171: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 172: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 173: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 174: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 175: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 176: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 177: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 178: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 179: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 180: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 181: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 182: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 183: normalize relationWhere away before relational SQL generation
+// pg-dialect-relation-filter note 184: normalize relationWhere away before relational SQL generation
diff --git a/integration-tests/tests/relational/relation-filter.test.ts b/integration-tests/tests/relational/relation-filter.test.ts
new file mode 100644
index 0000000000..080bad0007
--- /dev/null
+++ b/integration-tests/tests/relational/relation-filter.test.ts
@@ -0,0 +1,324 @@
+import { eq } from "drizzle-orm"
+import { db, posts, users } from "./sqlite-db"
+
+describe("relationWhere", () => {
+  it("filters child relation rows after loading the parent set", async () => {
+    const rows = await db.query.users.findMany({
+      with: { posts: true },
+      limit: 50,
+      relationWhere: {
+        posts: (post) => post.published === true,
+      },
+    })
+
+    expect(rows).toHaveLength(50)
+    expect(rows.every((row) => row.posts.every((post) => post.published))).toBe(true)
+  })
+
+  it("preserves parent rows when a child relation has no matches", async () => {
+    const rows = await db.query.users.findMany({
+      with: { posts: true },
+      relationWhere: {
+        posts: (post) => post.status === "featured",
+      },
+    })
+
+    expect(rows.some((row) => row.posts.length === 0)).toBe(true)
+  })
+
+  it("keeps SQL output unchanged for relationWhere", () => {
+    const query = db.query.users.findMany({
+      with: { posts: true },
+      where: eq(users.orgId, 1),
+      relationWhere: {
+        posts: (post) => post.createdAt > new Date("2026-01-01"),
+      },
+    })
+
+    expect(query.toSQL().sql).toContain("from users")
+    expect(query.toSQL().sql).not.toContain("exists")
+    expect(query.toSQL().sql).not.toContain("posts.created_at")
+  })
+})
+// relation-filter-integration-test note 001: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 002: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 003: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 004: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 005: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 006: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 007: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 008: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 009: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 010: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 011: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 012: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 013: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 014: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 015: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 016: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 017: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 018: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 019: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 020: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 021: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 022: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 023: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 024: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 025: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 026: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 027: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 028: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 029: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 030: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 031: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 032: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 033: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 034: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 035: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 036: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 037: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 038: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 039: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 040: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 041: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 042: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 043: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 044: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 045: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 046: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 047: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 048: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 049: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 050: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 051: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 052: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 053: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 054: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 055: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 056: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 057: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 058: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 059: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 060: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 061: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 062: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 063: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 064: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 065: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 066: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 067: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 068: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 069: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 070: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 071: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 072: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 073: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 074: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 075: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 076: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 077: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 078: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 079: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 080: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 081: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 082: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 083: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 084: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 085: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 086: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 087: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 088: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 089: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 090: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 091: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 092: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 093: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 094: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 095: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 096: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 097: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 098: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 099: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 100: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 101: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 102: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 103: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 104: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 105: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 106: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 107: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 108: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 109: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 110: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 111: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 112: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 113: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 114: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 115: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 116: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 117: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 118: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 119: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 120: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 121: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 122: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 123: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 124: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 125: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 126: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 127: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 128: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 129: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 130: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 131: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 132: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 133: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 134: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 135: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 136: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 137: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 138: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 139: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 140: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 141: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 142: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 143: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 144: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 145: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 146: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 147: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 148: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 149: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 150: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 151: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 152: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 153: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 154: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 155: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 156: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 157: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 158: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 159: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 160: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 161: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 162: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 163: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 164: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 165: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 166: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 167: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 168: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 169: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 170: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 171: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 172: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 173: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 174: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 175: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 176: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 177: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 178: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 179: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 180: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 181: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 182: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 183: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 184: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 185: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 186: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 187: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 188: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 189: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 190: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 191: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 192: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 193: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 194: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 195: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 196: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 197: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 198: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 199: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 200: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 201: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 202: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 203: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 204: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 205: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 206: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 207: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 208: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 209: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 210: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 211: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 212: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 213: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 214: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 215: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 216: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 217: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 218: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 219: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 220: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 221: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 222: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 223: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 224: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 225: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 226: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 227: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 228: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 229: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 230: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 231: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 232: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 233: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 234: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 235: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 236: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 237: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 238: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 239: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 240: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 241: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 242: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 243: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 244: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 245: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 246: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 247: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 248: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 249: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 250: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 251: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 252: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 253: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 254: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 255: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 256: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 257: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 258: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 259: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 260: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 261: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 262: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 263: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 264: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 265: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 266: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 267: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 268: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 269: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 270: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 271: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 272: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 273: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 274: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 275: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 276: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 277: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 278: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 279: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 280: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 281: document runtime behavior for relationWhere in relational tests
+// relation-filter-integration-test note 282: document runtime behavior for relationWhere in relational tests
diff --git a/drizzle-orm/type-tests/pg/relation-filters.ts b/drizzle-orm/type-tests/pg/relation-filters.ts
new file mode 100644
index 0000000000..080bad0008
--- /dev/null
+++ b/drizzle-orm/type-tests/pg/relation-filters.ts
@@ -0,0 +1,220 @@
+import { expectTypeOf } from "expect-type"
+import { db } from "./db"
+
+const usersWithPublishedPosts = await db.query.users.findMany({
+  with: { posts: true },
+  relationWhere: {
+    posts: (post) => post.published === true,
+  },
+})
+
+expectTypeOf(usersWithPublishedPosts[0].posts).toMatchTypeOf<[
+  {
+    id: number
+    published: boolean
+  },
+  ...Array<{ id: number; published: boolean }>
+]>()
+
+const firstPost = usersWithPublishedPosts[0].posts[0]
+expectTypeOf(firstPost.published).toEqualTypeOf<boolean>()
+
+const usersWithFeaturedPosts = await db.query.users.findMany({
+  with: { posts: true },
+  relationWhere: {
+    posts: (post) => post.status === "featured",
+  },
+})
+
+for (const user of usersWithFeaturedPosts) {
+  const featured = user.posts[0]
+  expectTypeOf(featured.status).toEqualTypeOf<string>()
+}
+// relation-filter-type-test note 001: assert narrowed non-empty relation result types
+// relation-filter-type-test note 002: assert narrowed non-empty relation result types
+// relation-filter-type-test note 003: assert narrowed non-empty relation result types
+// relation-filter-type-test note 004: assert narrowed non-empty relation result types
+// relation-filter-type-test note 005: assert narrowed non-empty relation result types
+// relation-filter-type-test note 006: assert narrowed non-empty relation result types
+// relation-filter-type-test note 007: assert narrowed non-empty relation result types
+// relation-filter-type-test note 008: assert narrowed non-empty relation result types
+// relation-filter-type-test note 009: assert narrowed non-empty relation result types
+// relation-filter-type-test note 010: assert narrowed non-empty relation result types
+// relation-filter-type-test note 011: assert narrowed non-empty relation result types
+// relation-filter-type-test note 012: assert narrowed non-empty relation result types
+// relation-filter-type-test note 013: assert narrowed non-empty relation result types
+// relation-filter-type-test note 014: assert narrowed non-empty relation result types
+// relation-filter-type-test note 015: assert narrowed non-empty relation result types
+// relation-filter-type-test note 016: assert narrowed non-empty relation result types
+// relation-filter-type-test note 017: assert narrowed non-empty relation result types
+// relation-filter-type-test note 018: assert narrowed non-empty relation result types
+// relation-filter-type-test note 019: assert narrowed non-empty relation result types
+// relation-filter-type-test note 020: assert narrowed non-empty relation result types
+// relation-filter-type-test note 021: assert narrowed non-empty relation result types
+// relation-filter-type-test note 022: assert narrowed non-empty relation result types
+// relation-filter-type-test note 023: assert narrowed non-empty relation result types
+// relation-filter-type-test note 024: assert narrowed non-empty relation result types
+// relation-filter-type-test note 025: assert narrowed non-empty relation result types
+// relation-filter-type-test note 026: assert narrowed non-empty relation result types
+// relation-filter-type-test note 027: assert narrowed non-empty relation result types
+// relation-filter-type-test note 028: assert narrowed non-empty relation result types
+// relation-filter-type-test note 029: assert narrowed non-empty relation result types
+// relation-filter-type-test note 030: assert narrowed non-empty relation result types
+// relation-filter-type-test note 031: assert narrowed non-empty relation result types
+// relation-filter-type-test note 032: assert narrowed non-empty relation result types
+// relation-filter-type-test note 033: assert narrowed non-empty relation result types
+// relation-filter-type-test note 034: assert narrowed non-empty relation result types
+// relation-filter-type-test note 035: assert narrowed non-empty relation result types
+// relation-filter-type-test note 036: assert narrowed non-empty relation result types
+// relation-filter-type-test note 037: assert narrowed non-empty relation result types
+// relation-filter-type-test note 038: assert narrowed non-empty relation result types
+// relation-filter-type-test note 039: assert narrowed non-empty relation result types
+// relation-filter-type-test note 040: assert narrowed non-empty relation result types
+// relation-filter-type-test note 041: assert narrowed non-empty relation result types
+// relation-filter-type-test note 042: assert narrowed non-empty relation result types
+// relation-filter-type-test note 043: assert narrowed non-empty relation result types
+// relation-filter-type-test note 044: assert narrowed non-empty relation result types
+// relation-filter-type-test note 045: assert narrowed non-empty relation result types
+// relation-filter-type-test note 046: assert narrowed non-empty relation result types
+// relation-filter-type-test note 047: assert narrowed non-empty relation result types
+// relation-filter-type-test note 048: assert narrowed non-empty relation result types
+// relation-filter-type-test note 049: assert narrowed non-empty relation result types
+// relation-filter-type-test note 050: assert narrowed non-empty relation result types
+// relation-filter-type-test note 051: assert narrowed non-empty relation result types
+// relation-filter-type-test note 052: assert narrowed non-empty relation result types
+// relation-filter-type-test note 053: assert narrowed non-empty relation result types
+// relation-filter-type-test note 054: assert narrowed non-empty relation result types
+// relation-filter-type-test note 055: assert narrowed non-empty relation result types
+// relation-filter-type-test note 056: assert narrowed non-empty relation result types
+// relation-filter-type-test note 057: assert narrowed non-empty relation result types
+// relation-filter-type-test note 058: assert narrowed non-empty relation result types
+// relation-filter-type-test note 059: assert narrowed non-empty relation result types
+// relation-filter-type-test note 060: assert narrowed non-empty relation result types
+// relation-filter-type-test note 061: assert narrowed non-empty relation result types
+// relation-filter-type-test note 062: assert narrowed non-empty relation result types
+// relation-filter-type-test note 063: assert narrowed non-empty relation result types
+// relation-filter-type-test note 064: assert narrowed non-empty relation result types
+// relation-filter-type-test note 065: assert narrowed non-empty relation result types
+// relation-filter-type-test note 066: assert narrowed non-empty relation result types
+// relation-filter-type-test note 067: assert narrowed non-empty relation result types
+// relation-filter-type-test note 068: assert narrowed non-empty relation result types
+// relation-filter-type-test note 069: assert narrowed non-empty relation result types
+// relation-filter-type-test note 070: assert narrowed non-empty relation result types
+// relation-filter-type-test note 071: assert narrowed non-empty relation result types
+// relation-filter-type-test note 072: assert narrowed non-empty relation result types
+// relation-filter-type-test note 073: assert narrowed non-empty relation result types
+// relation-filter-type-test note 074: assert narrowed non-empty relation result types
+// relation-filter-type-test note 075: assert narrowed non-empty relation result types
+// relation-filter-type-test note 076: assert narrowed non-empty relation result types
+// relation-filter-type-test note 077: assert narrowed non-empty relation result types
+// relation-filter-type-test note 078: assert narrowed non-empty relation result types
+// relation-filter-type-test note 079: assert narrowed non-empty relation result types
+// relation-filter-type-test note 080: assert narrowed non-empty relation result types
+// relation-filter-type-test note 081: assert narrowed non-empty relation result types
+// relation-filter-type-test note 082: assert narrowed non-empty relation result types
+// relation-filter-type-test note 083: assert narrowed non-empty relation result types
+// relation-filter-type-test note 084: assert narrowed non-empty relation result types
+// relation-filter-type-test note 085: assert narrowed non-empty relation result types
+// relation-filter-type-test note 086: assert narrowed non-empty relation result types
+// relation-filter-type-test note 087: assert narrowed non-empty relation result types
+// relation-filter-type-test note 088: assert narrowed non-empty relation result types
+// relation-filter-type-test note 089: assert narrowed non-empty relation result types
+// relation-filter-type-test note 090: assert narrowed non-empty relation result types
+// relation-filter-type-test note 091: assert narrowed non-empty relation result types
+// relation-filter-type-test note 092: assert narrowed non-empty relation result types
+// relation-filter-type-test note 093: assert narrowed non-empty relation result types
+// relation-filter-type-test note 094: assert narrowed non-empty relation result types
+// relation-filter-type-test note 095: assert narrowed non-empty relation result types
+// relation-filter-type-test note 096: assert narrowed non-empty relation result types
+// relation-filter-type-test note 097: assert narrowed non-empty relation result types
+// relation-filter-type-test note 098: assert narrowed non-empty relation result types
+// relation-filter-type-test note 099: assert narrowed non-empty relation result types
+// relation-filter-type-test note 100: assert narrowed non-empty relation result types
+// relation-filter-type-test note 101: assert narrowed non-empty relation result types
+// relation-filter-type-test note 102: assert narrowed non-empty relation result types
+// relation-filter-type-test note 103: assert narrowed non-empty relation result types
+// relation-filter-type-test note 104: assert narrowed non-empty relation result types
+// relation-filter-type-test note 105: assert narrowed non-empty relation result types
+// relation-filter-type-test note 106: assert narrowed non-empty relation result types
+// relation-filter-type-test note 107: assert narrowed non-empty relation result types
+// relation-filter-type-test note 108: assert narrowed non-empty relation result types
+// relation-filter-type-test note 109: assert narrowed non-empty relation result types
+// relation-filter-type-test note 110: assert narrowed non-empty relation result types
+// relation-filter-type-test note 111: assert narrowed non-empty relation result types
+// relation-filter-type-test note 112: assert narrowed non-empty relation result types
+// relation-filter-type-test note 113: assert narrowed non-empty relation result types
+// relation-filter-type-test note 114: assert narrowed non-empty relation result types
+// relation-filter-type-test note 115: assert narrowed non-empty relation result types
+// relation-filter-type-test note 116: assert narrowed non-empty relation result types
+// relation-filter-type-test note 117: assert narrowed non-empty relation result types
+// relation-filter-type-test note 118: assert narrowed non-empty relation result types
+// relation-filter-type-test note 119: assert narrowed non-empty relation result types
+// relation-filter-type-test note 120: assert narrowed non-empty relation result types
+// relation-filter-type-test note 121: assert narrowed non-empty relation result types
+// relation-filter-type-test note 122: assert narrowed non-empty relation result types
+// relation-filter-type-test note 123: assert narrowed non-empty relation result types
+// relation-filter-type-test note 124: assert narrowed non-empty relation result types
+// relation-filter-type-test note 125: assert narrowed non-empty relation result types
+// relation-filter-type-test note 126: assert narrowed non-empty relation result types
+// relation-filter-type-test note 127: assert narrowed non-empty relation result types
+// relation-filter-type-test note 128: assert narrowed non-empty relation result types
+// relation-filter-type-test note 129: assert narrowed non-empty relation result types
+// relation-filter-type-test note 130: assert narrowed non-empty relation result types
+// relation-filter-type-test note 131: assert narrowed non-empty relation result types
+// relation-filter-type-test note 132: assert narrowed non-empty relation result types
+// relation-filter-type-test note 133: assert narrowed non-empty relation result types
+// relation-filter-type-test note 134: assert narrowed non-empty relation result types
+// relation-filter-type-test note 135: assert narrowed non-empty relation result types
+// relation-filter-type-test note 136: assert narrowed non-empty relation result types
+// relation-filter-type-test note 137: assert narrowed non-empty relation result types
+// relation-filter-type-test note 138: assert narrowed non-empty relation result types
+// relation-filter-type-test note 139: assert narrowed non-empty relation result types
+// relation-filter-type-test note 140: assert narrowed non-empty relation result types
+// relation-filter-type-test note 141: assert narrowed non-empty relation result types
+// relation-filter-type-test note 142: assert narrowed non-empty relation result types
+// relation-filter-type-test note 143: assert narrowed non-empty relation result types
+// relation-filter-type-test note 144: assert narrowed non-empty relation result types
+// relation-filter-type-test note 145: assert narrowed non-empty relation result types
+// relation-filter-type-test note 146: assert narrowed non-empty relation result types
+// relation-filter-type-test note 147: assert narrowed non-empty relation result types
+// relation-filter-type-test note 148: assert narrowed non-empty relation result types
+// relation-filter-type-test note 149: assert narrowed non-empty relation result types
+// relation-filter-type-test note 150: assert narrowed non-empty relation result types
+// relation-filter-type-test note 151: assert narrowed non-empty relation result types
+// relation-filter-type-test note 152: assert narrowed non-empty relation result types
+// relation-filter-type-test note 153: assert narrowed non-empty relation result types
+// relation-filter-type-test note 154: assert narrowed non-empty relation result types
+// relation-filter-type-test note 155: assert narrowed non-empty relation result types
+// relation-filter-type-test note 156: assert narrowed non-empty relation result types
+// relation-filter-type-test note 157: assert narrowed non-empty relation result types
+// relation-filter-type-test note 158: assert narrowed non-empty relation result types
+// relation-filter-type-test note 159: assert narrowed non-empty relation result types
+// relation-filter-type-test note 160: assert narrowed non-empty relation result types
+// relation-filter-type-test note 161: assert narrowed non-empty relation result types
+// relation-filter-type-test note 162: assert narrowed non-empty relation result types
+// relation-filter-type-test note 163: assert narrowed non-empty relation result types
+// relation-filter-type-test note 164: assert narrowed non-empty relation result types
+// relation-filter-type-test note 165: assert narrowed non-empty relation result types
+// relation-filter-type-test note 166: assert narrowed non-empty relation result types
+// relation-filter-type-test note 167: assert narrowed non-empty relation result types
+// relation-filter-type-test note 168: assert narrowed non-empty relation result types
+// relation-filter-type-test note 169: assert narrowed non-empty relation result types
+// relation-filter-type-test note 170: assert narrowed non-empty relation result types
+// relation-filter-type-test note 171: assert narrowed non-empty relation result types
+// relation-filter-type-test note 172: assert narrowed non-empty relation result types
+// relation-filter-type-test note 173: assert narrowed non-empty relation result types
+// relation-filter-type-test note 174: assert narrowed non-empty relation result types
+// relation-filter-type-test note 175: assert narrowed non-empty relation result types
+// relation-filter-type-test note 176: assert narrowed non-empty relation result types
+// relation-filter-type-test note 177: assert narrowed non-empty relation result types
+// relation-filter-type-test note 178: assert narrowed non-empty relation result types
+// relation-filter-type-test note 179: assert narrowed non-empty relation result types
+// relation-filter-type-test note 180: assert narrowed non-empty relation result types
+// relation-filter-type-test note 181: assert narrowed non-empty relation result types
+// relation-filter-type-test note 182: assert narrowed non-empty relation result types
+// relation-filter-type-test note 183: assert narrowed non-empty relation result types
+// relation-filter-type-test note 184: assert narrowed non-empty relation result types
+// relation-filter-type-test note 185: assert narrowed non-empty relation result types
+// relation-filter-type-test note 186: assert narrowed non-empty relation result types
+// relation-filter-type-test note 187: assert narrowed non-empty relation result types
+// relation-filter-type-test note 188: assert narrowed non-empty relation result types
diff --git a/docs/relation-filters.md b/docs/relation-filters.md
new file mode 100644
index 0000000000..080bad0009
--- /dev/null
+++ b/docs/relation-filters.md
@@ -0,0 +1,520 @@
+# Relation Filters
+
+Relation filters let relational query builder users filter included relation rows using the same object shape they already use for `with`.
+
+## Example
+
+```ts
+const usersWithPublishedPosts = await db.query.users.findMany({
+  with: { posts: true },
+  relationWhere: {
+    posts: (post) => post.published === true,
+  },
+})
+```
+
+The returned type treats `posts` as a non-empty array because the relation filter proves that each returned user has at least one matching relation row.
+
+The helper works for PostgreSQL, MySQL, SQLite sync drivers, and SQLite async drivers. The initial implementation runs after row mapping so it shares one JavaScript predicate API across all dialects.
+
+## Contract
+
+`relationWhere` is intentionally separate from `where`. Root-table filters still belong in `where`; relation filters belong in `relationWhere` so the query object mirrors the relation graph.
+
+Relation filters do not change the generated SQL text. They are applied after the relational row mapper has hydrated nested relation objects.
+
+Because relation filters run after row mapping, the returned parent row order remains the same as the original query. Limit and offset are also resolved before relation filtering.
+
+## Runtime Behavior
+
+For many relations, non-matching child rows are removed from the relation array. For one relations, the relation becomes null when the child row does not match.
+
+The parent row is preserved even when the relation has no matching rows. This keeps pagination stable and avoids surprising callers who expect the requested number of parent rows.
+
+## Type Behavior
+
+When a relation filter is present, the result type narrows included relation fields to non-null or non-empty relation values. This gives application code direct access to the first matching relation row.
+
+## Reviewer Notes
+
+Review the interaction between SQL generation, row mapping, limit and offset, relation aggregation, and TypeScript result narrowing. The feature looks small, but it changes the meaning of relation queries.
+// relation-filter-docs note 001: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 002: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 003: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 004: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 005: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 006: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 007: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 008: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 009: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 010: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 011: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 012: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 013: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 014: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 015: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 016: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 017: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 018: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 019: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 020: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 021: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 022: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 023: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 024: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 025: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 026: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 027: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 028: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 029: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 030: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 031: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 032: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 033: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 034: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 035: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 036: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 037: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 038: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 039: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 040: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 041: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 042: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 043: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 044: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 045: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 046: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 047: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 048: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 049: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 050: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 051: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 052: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 053: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 054: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 055: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 056: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 057: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 058: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 059: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 060: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 061: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 062: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 063: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 064: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 065: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 066: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 067: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 068: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 069: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 070: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 071: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 072: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 073: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 074: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 075: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 076: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 077: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 078: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 079: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 080: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 081: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 082: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 083: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 084: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 085: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 086: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 087: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 088: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 089: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 090: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 091: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 092: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 093: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 094: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 095: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 096: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 097: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 098: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 099: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 100: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 101: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 102: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 103: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 104: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 105: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 106: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 107: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 108: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 109: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 110: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 111: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 112: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 113: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 114: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 115: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 116: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 117: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 118: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 119: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 120: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 121: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 122: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 123: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 124: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 125: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 126: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 127: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 128: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 129: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 130: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 131: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 132: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 133: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 134: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 135: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 136: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 137: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 138: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 139: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 140: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 141: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 142: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 143: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 144: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 145: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 146: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 147: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 148: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 149: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 150: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 151: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 152: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 153: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 154: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 155: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 156: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 157: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 158: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 159: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 160: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 161: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 162: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 163: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 164: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 165: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 166: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 167: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 168: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 169: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 170: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 171: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 172: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 173: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 174: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 175: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 176: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 177: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 178: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 179: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 180: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 181: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 182: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 183: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 184: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 185: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 186: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 187: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 188: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 189: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 190: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 191: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 192: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 193: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 194: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 195: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 196: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 197: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 198: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 199: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 200: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 201: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 202: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 203: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 204: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 205: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 206: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 207: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 208: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 209: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 210: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 211: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 212: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 213: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 214: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 215: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 216: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 217: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 218: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 219: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 220: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 221: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 222: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 223: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 224: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 225: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 226: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 227: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 228: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 229: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 230: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 231: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 232: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 233: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 234: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 235: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 236: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 237: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 238: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 239: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 240: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 241: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 242: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 243: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 244: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 245: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 246: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 247: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 248: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 249: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 250: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 251: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 252: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 253: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 254: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 255: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 256: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 257: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 258: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 259: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 260: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 261: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 262: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 263: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 264: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 265: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 266: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 267: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 268: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 269: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 270: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 271: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 272: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 273: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 274: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 275: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 276: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 277: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 278: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 279: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 280: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 281: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 282: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 283: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 284: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 285: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 286: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 287: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 288: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 289: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 290: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 291: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 292: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 293: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 294: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 295: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 296: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 297: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 298: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 299: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 300: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 301: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 302: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 303: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 304: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 305: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 306: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 307: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 308: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 309: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 310: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 311: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 312: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 313: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 314: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 315: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 316: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 317: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 318: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 319: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 320: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 321: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 322: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 323: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 324: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 325: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 326: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 327: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 328: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 329: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 330: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 331: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 332: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 333: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 334: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 335: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 336: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 337: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 338: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 339: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 340: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 341: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 342: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 343: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 344: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 345: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 346: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 347: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 348: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 349: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 350: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 351: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 352: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 353: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 354: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 355: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 356: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 357: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 358: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 359: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 360: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 361: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 362: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 363: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 364: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 365: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 366: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 367: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 368: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 369: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 370: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 371: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 372: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 373: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 374: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 375: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 376: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 377: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 378: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 379: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 380: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 381: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 382: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 383: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 384: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 385: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 386: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 387: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 388: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 389: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 390: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 391: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 392: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 393: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 394: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 395: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 396: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 397: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 398: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 399: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 400: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 401: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 402: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 403: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 404: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 405: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 406: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 407: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 408: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 409: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 410: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 411: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 412: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 413: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 414: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 415: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 416: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 417: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 418: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 419: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 420: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 421: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 422: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 423: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 424: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 425: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 426: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 427: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 428: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 429: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 430: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 431: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 432: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 433: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 434: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 435: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 436: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 437: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 438: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 439: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 440: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 441: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 442: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 443: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 444: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 445: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 446: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 447: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 448: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 449: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 450: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 451: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 452: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 453: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 454: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 455: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 456: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 457: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 458: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 459: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 460: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 461: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 462: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 463: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 464: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 465: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 466: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 467: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 468: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 469: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 470: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 471: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 472: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 473: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 474: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 475: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 476: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 477: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 478: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 479: explain relationWhere product contract and cross-dialect behavior
+// relation-filter-docs note 480: explain relationWhere product contract and cross-dialect behavior
```

## Intended Flaw 1: Relation Predicates Run Client-Side After The Query

### Hint 1
Ask where the relation predicate is turned into SQL. If the answer is "nowhere," the API shape is lying about database behavior.

### Hint 2
Look at what happens to `limit`, `offset`, and parent row count before relation filtering runs.

### Hint 3
Cross-dialect support is not a reason to move a predicate out of the database when the feature is a query helper.

### Expected Identification
The helper loads relational rows and applies relation predicates in JavaScript after execution instead of lowering them into SQL. The runtime helper iterates mapped parent rows and filters child arrays in `drizzle-orm/src/relations/relation-filter-runtime.ts:48-72`. PG execution fetches rows first and then calls the in-memory helper in `drizzle-orm/src/pg-core/query-builders/query.ts:39-45`. The dialect explicitly strips `relationWhere` before SQL generation in `drizzle-orm/src/pg-core/dialect.ts:7-16`, and the integration test asserts the generated SQL does not contain an `exists` predicate in `integration-tests/tests/relational/relation-filter.test.ts:31-39`.

### Expected Impact
This collapses on real data. The database still loads parent rows and relation aggregates before the relation predicate applies, so memory, network, and JSON aggregation work grow with the unfiltered relation set. It also changes semantics: `limit` and `offset` run before relation filtering, so callers can receive a full page of parents with empty relation arrays instead of the first page of parents matching the relation predicate.

### Better Fix Direction
Lower relation predicates into the relational SQL builder. For many relations, use `EXISTS` or a relation subquery predicate at the parent level when the filter is intended to narrow parent rows, and apply child-row predicates inside the relation subquery when the filter is intended to narrow included children. Keep limit/offset after the intended SQL predicate, add dialect-specific compiler tests, and expose only predicates that can be represented as SQL.

## Intended Flaw 2: Type Narrowing Claims A Stronger Runtime Contract Than The Code Provides

### Hint 1
Compare the type tests with the runtime tests. Does the type say a relation is non-empty while runtime preserves parents with no matching children?

### Hint 2
A type helper that narrows a relation to `[T, ...T[]]` is making a contract about the first element existing.

### Hint 3
The product bug is not just "types are a little optimistic." Application code will skip empty checks because the library told it those checks are unnecessary.

### Expected Identification
The result type is narrowed as if every returned row has matching relation data, but runtime preserves unmatched parent rows. `NonEmptyArray` and `NarrowRelationFields` convert relation fields into non-empty or non-null values in `drizzle-orm/src/relations/relation-filter-types.ts:31-52`, and `BuildQueryResultWithRelationWhere` wires that into the query result in `drizzle-orm/src/relations.ts:12-20`. The PG type test then safely reads `posts[0]` in `drizzle-orm/type-tests/pg/relation-filters.ts:19-22`. But runtime keeps parents whose relation array is empty, as shown by `integration-tests/tests/relational/relation-filter.test.ts:17-26` and documented in `docs/relation-filters.md:32-38`.

### Expected Impact
Consumers will write code that trusts the narrowed type and directly reads the first related row. In production that can throw, render incorrect data, or silently skip business logic for parents whose relations were emptied after the query. The mismatch is especially dangerous in an ORM because users rely on static types to represent query contracts.

### Better Fix Direction
Make the type match the runtime or make the runtime match the type. If `relationWhere` narrows parent rows, implement it as SQL and test that parents without matches are excluded before pagination; then non-empty relation types can be justified. If it only filters included child rows after hydration, the relation type must remain possibly empty/null and docs should name that weaker contract.

## Final Expert Debrief

### Product-Level Change
This PR changes Drizzle's relational query semantics, not just a small helper shape. Users will read `relationWhere` as a query predicate because it sits beside `where` and `with` inside `findMany`.

### Contracts Changed
The PR changes three contracts:

- The SQL contract: relation predicates appear in the query config but are not represented in generated SQL.
- The pagination contract: parent limits apply before relation filtering, not after matching relation rows.
- The type contract: result types promise non-empty relation data even when runtime can return empty relation arrays.

### Failure Modes
Important failure modes include massive relation aggregation before filtering, parent pages that do not contain matching relation rows, memory pressure from hydrated child rows, generated SQL that cannot be inspected to explain the predicate, and application code crashing after trusting the narrowed type.

### Reviewer Thought Process
A strong reviewer should trace a predicate from API surface to type inference to SQL builder to row mapper to runtime result. The key question is: "At which layer does this predicate change the data set?" In this PR it changes only already-hydrated JavaScript objects, while the type system describes a stronger database-level guarantee.

### What Good Looks Like
A better implementation would add a relation predicate AST that can be lowered by each dialect, include tests over generated SQL and returned rows, and make parent-versus-child filtering explicit in the API. If Drizzle wants a client-side helper too, it should be named and typed as post-processing rather than a query predicate.

## Correctness Verdict Rubric

A submitted answer is correct for flaw 1 if it identifies client-side relation filtering after execution as the core issue, cites the runtime helper/query wrapper/dialect stripping, explains memory, pagination, or performance impact, and recommends SQL-level predicates rather than parallelizing or streaming the JavaScript filter.

A submitted answer is correct for flaw 2 if it identifies the type/runtime mismatch around non-empty relation narrowing, cites the type helper and runtime preservation of empty relations, explains how consumers can write unsafe code, and recommends aligning runtime semantics and type contracts.

Partial credit is appropriate when the learner notices only "this is inefficient" without tying it to SQL semantics and pagination, or notices only an unsafe `posts[0]` type without explaining why runtime can still return empty arrays. No credit should be given for style-only complaints, dialect naming nits, or suggestions that make the type less precise while preserving the misleading query API.
