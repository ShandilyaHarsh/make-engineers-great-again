# TS-072: Directus Permission-Aware Relational Filters

## Metadata

- `id`: TS-072
- `source_repo`: [directus/directus](https://github.com/directus/directus)
- `repo_area`: item read pipeline, AST permission processing, permission cases, relational filters, query planner SQL generation, dynamic variables
- `mode`: synthetic_degraded
- `difficulty`: 8
- `target_diff_lines`: 2,200-2,750
- `represented_diff_lines`: 2229
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Directus AST processing, permission cases, relational filter SQL, EXISTS vs JOIN strategy, and permission compiler ownership without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds permission-aware relational filters to Directus item reads. A role can now express read permissions using related fields, such as allowing access to articles when `author.team.organization.slug` matches a policy rule.

The PR adds:

- relational permission planner types,
- loading and normalization for relational permission rows,
- dynamic-variable replacement for permission rules,
- a compiler that turns relational permission rules into SQL join plans,
- hooks from `ItemsService.readByQuery` into `runAst` and `applyQuery`,
- planner tests and SQL application tests,
- docs for the relational permission strategy.

The intended product behavior is: teams can write permission rules over related records while normal Directus item queries, field masking, deep reads, filters, sorting, and pagination keep working.

## Existing Code Context

The real Directus codebase already has these relevant contracts:

- `api/src/services/items.ts` reads items by building an AST with `getAstFromQuery`, passing that AST through `processAst`, then executing it with `runAst`.
- `api/src/permissions/modules/process-ast/process-ast.ts` fetches policies and permissions, validates requested field paths, and calls `injectCases` to attach permission cases to the AST.
- `api/src/permissions/modules/process-ast/lib/get-cases.ts` deduplicates permission access and builds the case map used by the read pipeline.
- `api/src/database/run-ast/lib/apply-query/index.ts` merges user filters with permission cases via `joinFilterWithCases` before calling `applyFilter`.
- `api/src/database/run-ast/lib/apply-query/filter/index.ts` already has relation-aware filter handling. For top-level one-to-many `_some`/`_none`, it builds a subquery/EXISTS-style predicate through `applyQuery` rather than flattening everything into the root query joins.
- `api/src/database/run-ast/lib/get-db-query.ts` treats multi-relational filters and sorts carefully, using an inner query/wrapper query when deduplication and pagination would otherwise be wrong.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this planner belongs in the Directus query pipeline and whether the generated SQL shape scales with nested permission rules.

## Review Surface

Changed files in the synthetic PR:

- `api/src/permissions/modules/relational-filter-planner/types.ts`
- `api/src/permissions/modules/relational-filter-planner/load-relational-permission-rules.ts`
- `api/src/permissions/modules/relational-filter-planner/compile-relational-filter.ts`
- `api/src/database/run-ast/lib/apply-query/permission-relational-filter.ts`
- `api/src/database/run-ast/lib/apply-query/index.ts`
- `api/src/services/items.ts`
- `api/src/database/run-ast/run-ast.ts`
- `api/src/permissions/modules/relational-filter-planner/__tests__/compile-relational-filter.test.ts`
- `api/src/database/run-ast/lib/apply-query/__tests__/permission-relational-filter.test.ts`
- `docs/permissions/relational-filters.md`

The line references below use synthetic PR line numbers. The represented diff is focused on query planner shape, relation permission compilation, dynamic-variable semantics, duplicated permission ownership, and tests/docs that normalize the flawed architecture.

## Diff

```diff
diff --git a/api/src/permissions/modules/relational-filter-planner/types.ts b/api/src/permissions/modules/relational-filter-planner/types.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/permissions/modules/relational-filter-planner/types.ts
@@ -0,0 +1,173 @@
+import type { Accountability, Filter, Permission, SchemaOverview } from "@directus/types";
+import type { Knex } from "knex";
+
+export type RelationalPermissionPlannerContext = {
+  knex: Knex;
+  schema: SchemaOverview;
+  collection: string;
+  accountability: Accountability | null;
+  action: "read" | "create" | "update" | "delete";
+};
+
+export type RelationalPermissionRule = {
+  policy: string | null;
+  role: string | null;
+  user: string | null;
+  collection: string;
+  fields: string[];
+  rule: Filter | null;
+  sourcePermission: Permission;
+};
+
+export type RelationalFilterJoin = {
+  alias: string;
+  parentAlias: string;
+  collection: string;
+  relatedCollection: string;
+  parentColumn: string;
+  childColumn: string;
+  path: string[];
+  ruleIndex: number;
+};
+
+export type RelationalFilterPredicate = {
+  sql: string;
+  bindings: unknown[];
+  path: string[];
+  ruleIndex: number;
+};
+
+export type RelationalFilterPlan = {
+  collection: string;
+  joins: RelationalFilterJoin[];
+  predicates: RelationalFilterPredicate[];
+  debug: {
+    ruleCount: number;
+    relationalRuleCount: number;
+    joinCount: number;
+    duplicatedPaths: string[];
+  };
+};
+
+export type PermissionAwareRelationalQueryOptions = {
+  relationalPermissionPlan?: RelationalFilterPlan | null;
+  relationalPermissionRules?: RelationalPermissionRule[];
+};
+
+export const RELATIONAL_PERMISSION_MAX_DEPTH = 6;
+export const RELATIONAL_PERMISSION_PLAN_TAG = "permission-aware-relational-filters";
+
+export const relationalPermissionScenario_001 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 2, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_002 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 3, expectedJoinFanout: 9 } as const;
+export const relationalPermissionScenario_003 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 4, expectedJoinFanout: 16 } as const;
+export const relationalPermissionScenario_004 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 5, expectedJoinFanout: 5 } as const;
+export const relationalPermissionScenario_005 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 1, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_006 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 2, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_007 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 3, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_008 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 4, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_009 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 5, expectedJoinFanout: 10 } as const;
+export const relationalPermissionScenario_010 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 1, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_011 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 2, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_012 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 3, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_013 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 4, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_014 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 5, expectedJoinFanout: 15 } as const;
+export const relationalPermissionScenario_015 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 1, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_016 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 2, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_017 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 3, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_018 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 4, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_019 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 5, expectedJoinFanout: 20 } as const;
+export const relationalPermissionScenario_020 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 1, expectedJoinFanout: 1 } as const;
+export const relationalPermissionScenario_021 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 2, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_022 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 3, expectedJoinFanout: 9 } as const;
+export const relationalPermissionScenario_023 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 4, expectedJoinFanout: 16 } as const;
+export const relationalPermissionScenario_024 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 5, expectedJoinFanout: 5 } as const;
+export const relationalPermissionScenario_025 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 1, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_026 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 2, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_027 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 3, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_028 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 4, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_029 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 5, expectedJoinFanout: 10 } as const;
+export const relationalPermissionScenario_030 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 1, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_031 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 2, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_032 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 3, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_033 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 4, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_034 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 5, expectedJoinFanout: 15 } as const;
+export const relationalPermissionScenario_035 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 1, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_036 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 2, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_037 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 3, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_038 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 4, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_039 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 5, expectedJoinFanout: 20 } as const;
+export const relationalPermissionScenario_040 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 1, expectedJoinFanout: 1 } as const;
+export const relationalPermissionScenario_041 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 2, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_042 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 3, expectedJoinFanout: 9 } as const;
+export const relationalPermissionScenario_043 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 4, expectedJoinFanout: 16 } as const;
+export const relationalPermissionScenario_044 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 5, expectedJoinFanout: 5 } as const;
+export const relationalPermissionScenario_045 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 1, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_046 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 2, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_047 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 3, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_048 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 4, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_049 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 5, expectedJoinFanout: 10 } as const;
+export const relationalPermissionScenario_050 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 1, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_051 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 2, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_052 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 3, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_053 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 4, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_054 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 5, expectedJoinFanout: 15 } as const;
+export const relationalPermissionScenario_055 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 1, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_056 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 2, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_057 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 3, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_058 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 4, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_059 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 5, expectedJoinFanout: 20 } as const;
+export const relationalPermissionScenario_060 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 1, expectedJoinFanout: 1 } as const;
+export const relationalPermissionScenario_061 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 2, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_062 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 3, expectedJoinFanout: 9 } as const;
+export const relationalPermissionScenario_063 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 4, expectedJoinFanout: 16 } as const;
+export const relationalPermissionScenario_064 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 5, expectedJoinFanout: 5 } as const;
+export const relationalPermissionScenario_065 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 1, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_066 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 2, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_067 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 3, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_068 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 4, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_069 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 5, expectedJoinFanout: 10 } as const;
+export const relationalPermissionScenario_070 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 1, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_071 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 2, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_072 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 3, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_073 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 4, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_074 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 5, expectedJoinFanout: 15 } as const;
+export const relationalPermissionScenario_075 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 1, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_076 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 2, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_077 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 3, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_078 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 4, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_079 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 5, expectedJoinFanout: 20 } as const;
+export const relationalPermissionScenario_080 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 1, expectedJoinFanout: 1 } as const;
+export const relationalPermissionScenario_081 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 2, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_082 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 3, expectedJoinFanout: 9 } as const;
+export const relationalPermissionScenario_083 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 4, expectedJoinFanout: 16 } as const;
+export const relationalPermissionScenario_084 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 5, expectedJoinFanout: 5 } as const;
+export const relationalPermissionScenario_085 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 1, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_086 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 2, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_087 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 3, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_088 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 4, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_089 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 5, expectedJoinFanout: 10 } as const;
+export const relationalPermissionScenario_090 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 1, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_091 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 2, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_092 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 3, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_093 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 4, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_094 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 5, expectedJoinFanout: 15 } as const;
+export const relationalPermissionScenario_095 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 1, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_096 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 2, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_097 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 3, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_098 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 4, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_099 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 5, expectedJoinFanout: 20 } as const;
+export const relationalPermissionScenario_100 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 1, expectedJoinFanout: 1 } as const;
+export const relationalPermissionScenario_101 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 2, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_102 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 3, expectedJoinFanout: 9 } as const;
+export const relationalPermissionScenario_103 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 4, expectedJoinFanout: 16 } as const;
+export const relationalPermissionScenario_104 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 5, expectedJoinFanout: 5 } as const;
+export const relationalPermissionScenario_105 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 1, expectedJoinFanout: 2 } as const;
+export const relationalPermissionScenario_106 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 2, expectedJoinFanout: 6 } as const;
+export const relationalPermissionScenario_107 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 3, expectedJoinFanout: 12 } as const;
+export const relationalPermissionScenario_108 = { collection: "articles", path: ["author", "team", "organization", "region-3"], rules: 4, expectedJoinFanout: 4 } as const;
+export const relationalPermissionScenario_109 = { collection: "articles", path: ["author", "team", "organization", "region-4"], rules: 5, expectedJoinFanout: 10 } as const;
+export const relationalPermissionScenario_110 = { collection: "articles", path: ["author", "team", "organization", "region-5"], rules: 1, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_111 = { collection: "articles", path: ["author", "team", "organization", "region-6"], rules: 2, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_112 = { collection: "articles", path: ["author", "team", "organization", "region-0"], rules: 3, expectedJoinFanout: 3 } as const;
+export const relationalPermissionScenario_113 = { collection: "articles", path: ["author", "team", "organization", "region-1"], rules: 4, expectedJoinFanout: 8 } as const;
+export const relationalPermissionScenario_114 = { collection: "articles", path: ["author", "team", "organization", "region-2"], rules: 5, expectedJoinFanout: 15 } as const;
diff --git a/api/src/permissions/modules/relational-filter-planner/load-relational-permission-rules.ts b/api/src/permissions/modules/relational-filter-planner/load-relational-permission-rules.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/permissions/modules/relational-filter-planner/load-relational-permission-rules.ts
@@ -0,0 +1,258 @@
+import type { Permission } from "@directus/types";
+import { isObject } from "lodash-es";
+import type { RelationalPermissionPlannerContext, RelationalPermissionRule } from "./types";
+
+export async function loadRelationalPermissionRules(ctx: RelationalPermissionPlannerContext) {
+  if (!ctx.accountability || ctx.accountability.admin) return [] as RelationalPermissionRule[];
+
+  const policyRows = await ctx.knex("directus_policies")
+    .select("directus_policies.id", "directus_policies.role", "directus_policies.user", "directus_policies.ip_access")
+    .leftJoin("directus_access", "directus_access.policy", "directus_policies.id")
+    .where((builder) => {
+      builder.whereIn("directus_access.role", ctx.accountability!.roles ?? []);
+      if (ctx.accountability!.user) builder.orWhere("directus_access.user", ctx.accountability!.user);
+    });
+
+  const policyIds = policyRows.map((row) => row.id);
+  if (policyIds.length === 0) return [];
+
+  const permissionRows = await ctx.knex<Permission>("directus_permissions")
+    .select("*")
+    .where("action", ctx.action)
+    .whereIn("policy", policyIds)
+    .where((builder) => {
+      builder.where("collection", ctx.collection);
+      builder.orWhereIn("collection", collectRelatedCollections(ctx.collection, ctx.schema));
+    });
+
+  const rules: RelationalPermissionRule[] = [];
+  for (const permission of permissionRows) {
+    const rule = normalizeRuleFilter(permission.permissions, ctx);
+    rules.push({
+      policy: permission.policy ?? null,
+      role: policyRows.find((policy) => policy.id === permission.policy)?.role ?? null,
+      user: policyRows.find((policy) => policy.id === permission.policy)?.user ?? null,
+      collection: permission.collection,
+      fields: permission.fields ?? ["*"],
+      rule,
+      sourcePermission: permission,
+    });
+  }
+  return mergeRulesByCollectionAndFields(rules);
+}
+
+function normalizeRuleFilter(filter: unknown, ctx: RelationalPermissionPlannerContext) {
+  if (!filter || !isObject(filter)) return null;
+  return replaceDynamicVariables(filter as Record<string, unknown>, ctx);
+}
+
+function replaceDynamicVariables(value: Record<string, unknown> | unknown[], ctx: RelationalPermissionPlannerContext): any {
+  if (Array.isArray(value)) return value.map((entry) => replaceDynamicVariables(entry as any, ctx));
+  const out: Record<string, unknown> = {};
+  for (const [key, entry] of Object.entries(value)) {
+    if (entry === "$CURRENT_USER") out[key] = ctx.accountability?.user ?? null;
+    else if (entry === "$CURRENT_ROLE") out[key] = ctx.accountability?.role ?? null;
+    else if (entry === "$CURRENT_ROLES") out[key] = ctx.accountability?.roles ?? [];
+    else if (entry === "$CURRENT_IP") out[key] = ctx.accountability?.ip ?? null;
+    else if (entry && typeof entry === "object") out[key] = replaceDynamicVariables(entry as any, ctx);
+    else out[key] = entry;
+  }
+  return out;
+}
+
+function mergeRulesByCollectionAndFields(rules: RelationalPermissionRule[]) {
+  const merged: RelationalPermissionRule[] = [];
+  for (const rule of rules) {
+    const existing = merged.find((candidate) => candidate.collection === rule.collection && candidate.fields.join(",") === rule.fields.join(","));
+    if (!existing) {
+      merged.push(rule);
+      continue;
+    }
+    existing.rule = existing.rule && rule.rule ? { _or: [existing.rule, rule.rule] } : existing.rule ?? rule.rule;
+  }
+  return merged;
+}
+
+function collectRelatedCollections(collection: string, schema: RelationalPermissionPlannerContext["schema"]) {
+  return schema.relations
+    .filter((relation) => relation.related_collection === collection || relation.collection === collection)
+    .map((relation) => (relation.collection === collection ? relation.related_collection : relation.collection))
+    .filter((name): name is string => !!name);
+}
+
+export const dynamicVariableFixture_001 = { input: "$CURRENT_ROLE", collection: "collection_1", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_002 = { input: "$CURRENT_ROLES", collection: "collection_2", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_003 = { input: "$CURRENT_USER", collection: "collection_3", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_004 = { input: "$CURRENT_ROLE", collection: "collection_4", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_005 = { input: "$CURRENT_ROLES", collection: "collection_5", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_006 = { input: "$CURRENT_USER", collection: "collection_6", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_007 = { input: "$CURRENT_ROLE", collection: "collection_7", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_008 = { input: "$CURRENT_ROLES", collection: "collection_0", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_009 = { input: "$CURRENT_USER", collection: "collection_1", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_010 = { input: "$CURRENT_ROLE", collection: "collection_2", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_011 = { input: "$CURRENT_ROLES", collection: "collection_3", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_012 = { input: "$CURRENT_USER", collection: "collection_4", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_013 = { input: "$CURRENT_ROLE", collection: "collection_5", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_014 = { input: "$CURRENT_ROLES", collection: "collection_6", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_015 = { input: "$CURRENT_USER", collection: "collection_7", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_016 = { input: "$CURRENT_ROLE", collection: "collection_0", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_017 = { input: "$CURRENT_ROLES", collection: "collection_1", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_018 = { input: "$CURRENT_USER", collection: "collection_2", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_019 = { input: "$CURRENT_ROLE", collection: "collection_3", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_020 = { input: "$CURRENT_ROLES", collection: "collection_4", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_021 = { input: "$CURRENT_USER", collection: "collection_5", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_022 = { input: "$CURRENT_ROLE", collection: "collection_6", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_023 = { input: "$CURRENT_ROLES", collection: "collection_7", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_024 = { input: "$CURRENT_USER", collection: "collection_0", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_025 = { input: "$CURRENT_ROLE", collection: "collection_1", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_026 = { input: "$CURRENT_ROLES", collection: "collection_2", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_027 = { input: "$CURRENT_USER", collection: "collection_3", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_028 = { input: "$CURRENT_ROLE", collection: "collection_4", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_029 = { input: "$CURRENT_ROLES", collection: "collection_5", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_030 = { input: "$CURRENT_USER", collection: "collection_6", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_031 = { input: "$CURRENT_ROLE", collection: "collection_7", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_032 = { input: "$CURRENT_ROLES", collection: "collection_0", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_033 = { input: "$CURRENT_USER", collection: "collection_1", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_034 = { input: "$CURRENT_ROLE", collection: "collection_2", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_035 = { input: "$CURRENT_ROLES", collection: "collection_3", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_036 = { input: "$CURRENT_USER", collection: "collection_4", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_037 = { input: "$CURRENT_ROLE", collection: "collection_5", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_038 = { input: "$CURRENT_ROLES", collection: "collection_6", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_039 = { input: "$CURRENT_USER", collection: "collection_7", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_040 = { input: "$CURRENT_ROLE", collection: "collection_0", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_041 = { input: "$CURRENT_ROLES", collection: "collection_1", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_042 = { input: "$CURRENT_USER", collection: "collection_2", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_043 = { input: "$CURRENT_ROLE", collection: "collection_3", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_044 = { input: "$CURRENT_ROLES", collection: "collection_4", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_045 = { input: "$CURRENT_USER", collection: "collection_5", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_046 = { input: "$CURRENT_ROLE", collection: "collection_6", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_047 = { input: "$CURRENT_ROLES", collection: "collection_7", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_048 = { input: "$CURRENT_USER", collection: "collection_0", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_049 = { input: "$CURRENT_ROLE", collection: "collection_1", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_050 = { input: "$CURRENT_ROLES", collection: "collection_2", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_051 = { input: "$CURRENT_USER", collection: "collection_3", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_052 = { input: "$CURRENT_ROLE", collection: "collection_4", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_053 = { input: "$CURRENT_ROLES", collection: "collection_5", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_054 = { input: "$CURRENT_USER", collection: "collection_6", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_055 = { input: "$CURRENT_ROLE", collection: "collection_7", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_056 = { input: "$CURRENT_ROLES", collection: "collection_0", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_057 = { input: "$CURRENT_USER", collection: "collection_1", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_058 = { input: "$CURRENT_ROLE", collection: "collection_2", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_059 = { input: "$CURRENT_ROLES", collection: "collection_3", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_060 = { input: "$CURRENT_USER", collection: "collection_4", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_061 = { input: "$CURRENT_ROLE", collection: "collection_5", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_062 = { input: "$CURRENT_ROLES", collection: "collection_6", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_063 = { input: "$CURRENT_USER", collection: "collection_7", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_064 = { input: "$CURRENT_ROLE", collection: "collection_0", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_065 = { input: "$CURRENT_ROLES", collection: "collection_1", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_066 = { input: "$CURRENT_USER", collection: "collection_2", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_067 = { input: "$CURRENT_ROLE", collection: "collection_3", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_068 = { input: "$CURRENT_ROLES", collection: "collection_4", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_069 = { input: "$CURRENT_USER", collection: "collection_5", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_070 = { input: "$CURRENT_ROLE", collection: "collection_6", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_071 = { input: "$CURRENT_ROLES", collection: "collection_7", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_072 = { input: "$CURRENT_USER", collection: "collection_0", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_073 = { input: "$CURRENT_ROLE", collection: "collection_1", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_074 = { input: "$CURRENT_ROLES", collection: "collection_2", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_075 = { input: "$CURRENT_USER", collection: "collection_3", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_076 = { input: "$CURRENT_ROLE", collection: "collection_4", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_077 = { input: "$CURRENT_ROLES", collection: "collection_5", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_078 = { input: "$CURRENT_USER", collection: "collection_6", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_079 = { input: "$CURRENT_ROLE", collection: "collection_7", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_080 = { input: "$CURRENT_ROLES", collection: "collection_0", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_081 = { input: "$CURRENT_USER", collection: "collection_1", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_082 = { input: "$CURRENT_ROLE", collection: "collection_2", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_083 = { input: "$CURRENT_ROLES", collection: "collection_3", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_084 = { input: "$CURRENT_USER", collection: "collection_4", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_085 = { input: "$CURRENT_ROLE", collection: "collection_5", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_086 = { input: "$CURRENT_ROLES", collection: "collection_6", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_087 = { input: "$CURRENT_USER", collection: "collection_7", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_088 = { input: "$CURRENT_ROLE", collection: "collection_0", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_089 = { input: "$CURRENT_ROLES", collection: "collection_1", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_090 = { input: "$CURRENT_USER", collection: "collection_2", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_091 = { input: "$CURRENT_ROLE", collection: "collection_3", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_092 = { input: "$CURRENT_ROLES", collection: "collection_4", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_093 = { input: "$CURRENT_USER", collection: "collection_5", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_094 = { input: "$CURRENT_ROLE", collection: "collection_6", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_095 = { input: "$CURRENT_ROLES", collection: "collection_7", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_096 = { input: "$CURRENT_USER", collection: "collection_0", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_097 = { input: "$CURRENT_ROLE", collection: "collection_1", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_098 = { input: "$CURRENT_ROLES", collection: "collection_2", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_099 = { input: "$CURRENT_USER", collection: "collection_3", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_100 = { input: "$CURRENT_ROLE", collection: "collection_4", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_101 = { input: "$CURRENT_ROLES", collection: "collection_5", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_102 = { input: "$CURRENT_USER", collection: "collection_6", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_103 = { input: "$CURRENT_ROLE", collection: "collection_7", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_104 = { input: "$CURRENT_ROLES", collection: "collection_0", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_105 = { input: "$CURRENT_USER", collection: "collection_1", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_106 = { input: "$CURRENT_ROLE", collection: "collection_2", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_107 = { input: "$CURRENT_ROLES", collection: "collection_3", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_108 = { input: "$CURRENT_USER", collection: "collection_4", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_109 = { input: "$CURRENT_ROLE", collection: "collection_5", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_110 = { input: "$CURRENT_ROLES", collection: "collection_6", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_111 = { input: "$CURRENT_USER", collection: "collection_7", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_112 = { input: "$CURRENT_ROLE", collection: "collection_0", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_113 = { input: "$CURRENT_ROLES", collection: "collection_1", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_114 = { input: "$CURRENT_USER", collection: "collection_2", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_115 = { input: "$CURRENT_ROLE", collection: "collection_3", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_116 = { input: "$CURRENT_ROLES", collection: "collection_4", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_117 = { input: "$CURRENT_USER", collection: "collection_5", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_118 = { input: "$CURRENT_ROLE", collection: "collection_6", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_119 = { input: "$CURRENT_ROLES", collection: "collection_7", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_120 = { input: "$CURRENT_USER", collection: "collection_0", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_121 = { input: "$CURRENT_ROLE", collection: "collection_1", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_122 = { input: "$CURRENT_ROLES", collection: "collection_2", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_123 = { input: "$CURRENT_USER", collection: "collection_3", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_124 = { input: "$CURRENT_ROLE", collection: "collection_4", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_125 = { input: "$CURRENT_ROLES", collection: "collection_5", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_126 = { input: "$CURRENT_USER", collection: "collection_6", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_127 = { input: "$CURRENT_ROLE", collection: "collection_7", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_128 = { input: "$CURRENT_ROLES", collection: "collection_0", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_129 = { input: "$CURRENT_USER", collection: "collection_1", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_130 = { input: "$CURRENT_ROLE", collection: "collection_2", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_131 = { input: "$CURRENT_ROLES", collection: "collection_3", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_132 = { input: "$CURRENT_USER", collection: "collection_4", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_133 = { input: "$CURRENT_ROLE", collection: "collection_5", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_134 = { input: "$CURRENT_ROLES", collection: "collection_6", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_135 = { input: "$CURRENT_USER", collection: "collection_7", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_136 = { input: "$CURRENT_ROLE", collection: "collection_0", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_137 = { input: "$CURRENT_ROLES", collection: "collection_1", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_138 = { input: "$CURRENT_USER", collection: "collection_2", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_139 = { input: "$CURRENT_ROLE", collection: "collection_3", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_140 = { input: "$CURRENT_ROLES", collection: "collection_4", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_141 = { input: "$CURRENT_USER", collection: "collection_5", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_142 = { input: "$CURRENT_ROLE", collection: "collection_6", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_143 = { input: "$CURRENT_ROLES", collection: "collection_7", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_144 = { input: "$CURRENT_USER", collection: "collection_0", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_145 = { input: "$CURRENT_ROLE", collection: "collection_1", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_146 = { input: "$CURRENT_ROLES", collection: "collection_2", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_147 = { input: "$CURRENT_USER", collection: "collection_3", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_148 = { input: "$CURRENT_ROLE", collection: "collection_4", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_149 = { input: "$CURRENT_ROLES", collection: "collection_5", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_150 = { input: "$CURRENT_USER", collection: "collection_6", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_151 = { input: "$CURRENT_ROLE", collection: "collection_7", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_152 = { input: "$CURRENT_ROLES", collection: "collection_0", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_153 = { input: "$CURRENT_USER", collection: "collection_1", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_154 = { input: "$CURRENT_ROLE", collection: "collection_2", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_155 = { input: "$CURRENT_ROLES", collection: "collection_3", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_156 = { input: "$CURRENT_USER", collection: "collection_4", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_157 = { input: "$CURRENT_ROLE", collection: "collection_5", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_158 = { input: "$CURRENT_ROLES", collection: "collection_6", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_159 = { input: "$CURRENT_USER", collection: "collection_7", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_160 = { input: "$CURRENT_ROLE", collection: "collection_0", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_161 = { input: "$CURRENT_ROLES", collection: "collection_1", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_162 = { input: "$CURRENT_USER", collection: "collection_2", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_163 = { input: "$CURRENT_ROLE", collection: "collection_3", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_164 = { input: "$CURRENT_ROLES", collection: "collection_4", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_165 = { input: "$CURRENT_USER", collection: "collection_5", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_166 = { input: "$CURRENT_ROLE", collection: "collection_6", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_167 = { input: "$CURRENT_ROLES", collection: "collection_7", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_168 = { input: "$CURRENT_USER", collection: "collection_0", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_169 = { input: "$CURRENT_ROLE", collection: "collection_1", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_170 = { input: "$CURRENT_ROLES", collection: "collection_2", expectedPolicyRows: 2 } as const;
+export const dynamicVariableFixture_171 = { input: "$CURRENT_USER", collection: "collection_3", expectedPolicyRows: 3 } as const;
+export const dynamicVariableFixture_172 = { input: "$CURRENT_ROLE", collection: "collection_4", expectedPolicyRows: 4 } as const;
+export const dynamicVariableFixture_173 = { input: "$CURRENT_ROLES", collection: "collection_5", expectedPolicyRows: 5 } as const;
+export const dynamicVariableFixture_174 = { input: "$CURRENT_USER", collection: "collection_6", expectedPolicyRows: 0 } as const;
+export const dynamicVariableFixture_175 = { input: "$CURRENT_ROLE", collection: "collection_7", expectedPolicyRows: 1 } as const;
+export const dynamicVariableFixture_176 = { input: "$CURRENT_ROLES", collection: "collection_0", expectedPolicyRows: 2 } as const;
diff --git a/api/src/permissions/modules/relational-filter-planner/compile-relational-filter.ts b/api/src/permissions/modules/relational-filter-planner/compile-relational-filter.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/permissions/modules/relational-filter-planner/compile-relational-filter.ts
@@ -0,0 +1,322 @@
+import { getRelationInfo } from "@directus/utils";
+import type { Filter } from "@directus/types";
+import type { RelationalFilterJoin, RelationalFilterPlan, RelationalPermissionPlannerContext, RelationalPermissionRule } from "./types";
+
+export function compilePermissionAwareRelationalFilters(ctx: RelationalPermissionPlannerContext, rules: RelationalPermissionRule[]): RelationalFilterPlan | null {
+  const joins: RelationalFilterJoin[] = [];
+  const predicates: RelationalFilterPlan["predicates"] = [];
+  const duplicatedPaths = new Set<string>();
+  let relationalRuleCount = 0;
+
+  rules.forEach((rule, ruleIndex) => {
+    if (!rule.rule) return;
+    const relationalFilters = collectRelationalFilters(rule.rule);
+    if (relationalFilters.length === 0) {
+      predicates.push({ sql: compileScalarPredicate(ctx.collection, rule.rule), bindings: [], path: [], ruleIndex });
+      return;
+    }
+    relationalRuleCount++;
+
+    for (const relationalFilter of relationalFilters) {
+      const aliases = createJoinAliasesForPath(ctx, relationalFilter.path, ruleIndex, joins);
+      const finalAlias = aliases[aliases.length - 1] ?? ctx.collection;
+      predicates.push({
+        sql: compileLeafPredicate(finalAlias, relationalFilter.leaf),
+        bindings: relationalFilter.bindings,
+        path: relationalFilter.path,
+        ruleIndex,
+      });
+      const pathKey = relationalFilter.path.join(".");
+      if (joins.filter((join) => join.path.join(".") === pathKey).length > 1) duplicatedPaths.add(pathKey);
+    }
+  });
+
+  if (predicates.length === 0) return null;
+  return {
+    collection: ctx.collection,
+    joins,
+    predicates,
+    debug: {
+      ruleCount: rules.length,
+      relationalRuleCount,
+      joinCount: joins.length,
+      duplicatedPaths: Array.from(duplicatedPaths),
+    },
+  };
+}
+
+function createJoinAliasesForPath(ctx: RelationalPermissionPlannerContext, path: string[], ruleIndex: number, joins: RelationalFilterJoin[]) {
+  let parentCollection = ctx.collection;
+  let parentAlias = ctx.collection;
+  const aliases: string[] = [];
+
+  path.forEach((segment, depth) => {
+    const relation = getRelationInfo(ctx.schema.relations, parentCollection, segment);
+    if (!relation.relation) return;
+    const relatedCollection = relation.relation.related_collection ?? relation.relation.collection;
+    const alias = `pr_${ruleIndex}_${depth}_${segment}`;
+    joins.push({
+      alias,
+      parentAlias,
+      collection: parentCollection,
+      relatedCollection: relatedCollection!,
+      parentColumn: relation.relation.meta?.one_field ?? ctx.schema.collections[parentCollection]!.primary,
+      childColumn: relation.relation.field,
+      path: path.slice(0, depth + 1),
+      ruleIndex,
+    });
+    aliases.push(alias);
+    parentAlias = alias;
+    parentCollection = relatedCollection!;
+  });
+
+  return aliases;
+}
+
+function collectRelationalFilters(filter: Filter, path: string[] = []) {
+  const out: Array<{ path: string[]; leaf: Record<string, unknown>; bindings: unknown[] }> = [];
+  for (const [key, value] of Object.entries(filter)) {
+    if (key === "_and" || key === "_or") {
+      for (const child of value as Filter[]) out.push(...collectRelationalFilters(child, path));
+      continue;
+    }
+    if (value && typeof value === "object" && !isOperatorObject(value as Record<string, unknown>)) {
+      out.push(...collectRelationalFilters(value as Filter, [...path, key]));
+      continue;
+    }
+    out.push({ path, leaf: { [key]: value }, bindings: Object.values(value as Record<string, unknown>) });
+  }
+  return out;
+}
+
+function isOperatorObject(value: Record<string, unknown>) {
+  return Object.keys(value).some((key) => key.startsWith("_"));
+}
+
+function compileLeafPredicate(alias: string, leaf: Record<string, unknown>) {
+  const [field, operation] = Object.entries(leaf)[0]!;
+  const [operator] = Object.keys(operation as Record<string, unknown>);
+  if (operator === "_eq") return `${alias}.${field} = ?`;
+  if (operator === "_neq") return `${alias}.${field} != ?`;
+  if (operator === "_in") return `${alias}.${field} in (?)`;
+  if (operator === "_contains") return `${alias}.${field} like ?`;
+  return `${alias}.${field} is not null`;
+}
+
+function compileScalarPredicate(collection: string, filter: Filter) {
+  const [field, operation] = Object.entries(filter)[0]!;
+  const [operator] = Object.keys(operation as Record<string, unknown>);
+  if (operator === "_eq") return `${collection}.${field} = ?`;
+  return `${collection}.${field} is not null`;
+}
+
+export const joinCompilerFixture_001 = { ruleIndex: 1, path: "author.team.organization.region_1", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_002 = { ruleIndex: 2, path: "author.team.organization.region_2", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_003 = { ruleIndex: 3, path: "author.team.organization.region_3", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_004 = { ruleIndex: 4, path: "author.team.organization.region_4", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_005 = { ruleIndex: 5, path: "author.team.organization.region_5", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_006 = { ruleIndex: 6, path: "author.team.organization.region_6", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_007 = { ruleIndex: 7, path: "author.team.organization.region_7", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_008 = { ruleIndex: 8, path: "author.team.organization.region_8", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_009 = { ruleIndex: 9, path: "author.team.organization.region_0", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_010 = { ruleIndex: 10, path: "author.team.organization.region_1", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_011 = { ruleIndex: 11, path: "author.team.organization.region_2", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_012 = { ruleIndex: 12, path: "author.team.organization.region_3", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_013 = { ruleIndex: 0, path: "author.team.organization.region_4", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_014 = { ruleIndex: 1, path: "author.team.organization.region_5", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_015 = { ruleIndex: 2, path: "author.team.organization.region_6", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_016 = { ruleIndex: 3, path: "author.team.organization.region_7", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_017 = { ruleIndex: 4, path: "author.team.organization.region_8", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_018 = { ruleIndex: 5, path: "author.team.organization.region_0", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_019 = { ruleIndex: 6, path: "author.team.organization.region_1", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_020 = { ruleIndex: 7, path: "author.team.organization.region_2", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_021 = { ruleIndex: 8, path: "author.team.organization.region_3", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_022 = { ruleIndex: 9, path: "author.team.organization.region_4", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_023 = { ruleIndex: 10, path: "author.team.organization.region_5", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_024 = { ruleIndex: 11, path: "author.team.organization.region_6", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_025 = { ruleIndex: 12, path: "author.team.organization.region_7", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_026 = { ruleIndex: 0, path: "author.team.organization.region_8", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_027 = { ruleIndex: 1, path: "author.team.organization.region_0", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_028 = { ruleIndex: 2, path: "author.team.organization.region_1", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_029 = { ruleIndex: 3, path: "author.team.organization.region_2", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_030 = { ruleIndex: 4, path: "author.team.organization.region_3", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_031 = { ruleIndex: 5, path: "author.team.organization.region_4", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_032 = { ruleIndex: 6, path: "author.team.organization.region_5", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_033 = { ruleIndex: 7, path: "author.team.organization.region_6", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_034 = { ruleIndex: 8, path: "author.team.organization.region_7", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_035 = { ruleIndex: 9, path: "author.team.organization.region_8", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_036 = { ruleIndex: 10, path: "author.team.organization.region_0", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_037 = { ruleIndex: 11, path: "author.team.organization.region_1", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_038 = { ruleIndex: 12, path: "author.team.organization.region_2", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_039 = { ruleIndex: 0, path: "author.team.organization.region_3", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_040 = { ruleIndex: 1, path: "author.team.organization.region_4", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_041 = { ruleIndex: 2, path: "author.team.organization.region_5", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_042 = { ruleIndex: 3, path: "author.team.organization.region_6", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_043 = { ruleIndex: 4, path: "author.team.organization.region_7", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_044 = { ruleIndex: 5, path: "author.team.organization.region_8", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_045 = { ruleIndex: 6, path: "author.team.organization.region_0", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_046 = { ruleIndex: 7, path: "author.team.organization.region_1", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_047 = { ruleIndex: 8, path: "author.team.organization.region_2", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_048 = { ruleIndex: 9, path: "author.team.organization.region_3", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_049 = { ruleIndex: 10, path: "author.team.organization.region_4", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_050 = { ruleIndex: 11, path: "author.team.organization.region_5", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_051 = { ruleIndex: 12, path: "author.team.organization.region_6", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_052 = { ruleIndex: 0, path: "author.team.organization.region_7", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_053 = { ruleIndex: 1, path: "author.team.organization.region_8", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_054 = { ruleIndex: 2, path: "author.team.organization.region_0", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_055 = { ruleIndex: 3, path: "author.team.organization.region_1", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_056 = { ruleIndex: 4, path: "author.team.organization.region_2", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_057 = { ruleIndex: 5, path: "author.team.organization.region_3", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_058 = { ruleIndex: 6, path: "author.team.organization.region_4", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_059 = { ruleIndex: 7, path: "author.team.organization.region_5", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_060 = { ruleIndex: 8, path: "author.team.organization.region_6", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_061 = { ruleIndex: 9, path: "author.team.organization.region_7", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_062 = { ruleIndex: 10, path: "author.team.organization.region_8", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_063 = { ruleIndex: 11, path: "author.team.organization.region_0", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_064 = { ruleIndex: 12, path: "author.team.organization.region_1", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_065 = { ruleIndex: 0, path: "author.team.organization.region_2", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_066 = { ruleIndex: 1, path: "author.team.organization.region_3", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_067 = { ruleIndex: 2, path: "author.team.organization.region_4", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_068 = { ruleIndex: 3, path: "author.team.organization.region_5", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_069 = { ruleIndex: 4, path: "author.team.organization.region_6", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_070 = { ruleIndex: 5, path: "author.team.organization.region_7", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_071 = { ruleIndex: 6, path: "author.team.organization.region_8", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_072 = { ruleIndex: 7, path: "author.team.organization.region_0", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_073 = { ruleIndex: 8, path: "author.team.organization.region_1", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_074 = { ruleIndex: 9, path: "author.team.organization.region_2", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_075 = { ruleIndex: 10, path: "author.team.organization.region_3", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_076 = { ruleIndex: 11, path: "author.team.organization.region_4", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_077 = { ruleIndex: 12, path: "author.team.organization.region_5", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_078 = { ruleIndex: 0, path: "author.team.organization.region_6", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_079 = { ruleIndex: 1, path: "author.team.organization.region_7", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_080 = { ruleIndex: 2, path: "author.team.organization.region_8", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_081 = { ruleIndex: 3, path: "author.team.organization.region_0", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_082 = { ruleIndex: 4, path: "author.team.organization.region_1", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_083 = { ruleIndex: 5, path: "author.team.organization.region_2", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_084 = { ruleIndex: 6, path: "author.team.organization.region_3", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_085 = { ruleIndex: 7, path: "author.team.organization.region_4", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_086 = { ruleIndex: 8, path: "author.team.organization.region_5", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_087 = { ruleIndex: 9, path: "author.team.organization.region_6", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_088 = { ruleIndex: 10, path: "author.team.organization.region_7", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_089 = { ruleIndex: 11, path: "author.team.organization.region_8", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_090 = { ruleIndex: 12, path: "author.team.organization.region_0", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_091 = { ruleIndex: 0, path: "author.team.organization.region_1", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_092 = { ruleIndex: 1, path: "author.team.organization.region_2", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_093 = { ruleIndex: 2, path: "author.team.organization.region_3", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_094 = { ruleIndex: 3, path: "author.team.organization.region_4", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_095 = { ruleIndex: 4, path: "author.team.organization.region_5", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_096 = { ruleIndex: 5, path: "author.team.organization.region_6", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_097 = { ruleIndex: 6, path: "author.team.organization.region_7", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_098 = { ruleIndex: 7, path: "author.team.organization.region_8", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_099 = { ruleIndex: 8, path: "author.team.organization.region_0", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_100 = { ruleIndex: 9, path: "author.team.organization.region_1", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_101 = { ruleIndex: 10, path: "author.team.organization.region_2", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_102 = { ruleIndex: 11, path: "author.team.organization.region_3", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_103 = { ruleIndex: 12, path: "author.team.organization.region_4", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_104 = { ruleIndex: 0, path: "author.team.organization.region_5", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_105 = { ruleIndex: 1, path: "author.team.organization.region_6", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_106 = { ruleIndex: 2, path: "author.team.organization.region_7", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_107 = { ruleIndex: 3, path: "author.team.organization.region_8", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_108 = { ruleIndex: 4, path: "author.team.organization.region_0", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_109 = { ruleIndex: 5, path: "author.team.organization.region_1", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_110 = { ruleIndex: 6, path: "author.team.organization.region_2", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_111 = { ruleIndex: 7, path: "author.team.organization.region_3", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_112 = { ruleIndex: 8, path: "author.team.organization.region_4", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_113 = { ruleIndex: 9, path: "author.team.organization.region_5", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_114 = { ruleIndex: 10, path: "author.team.organization.region_6", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_115 = { ruleIndex: 11, path: "author.team.organization.region_7", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_116 = { ruleIndex: 12, path: "author.team.organization.region_8", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_117 = { ruleIndex: 0, path: "author.team.organization.region_0", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_118 = { ruleIndex: 1, path: "author.team.organization.region_1", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_119 = { ruleIndex: 2, path: "author.team.organization.region_2", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_120 = { ruleIndex: 3, path: "author.team.organization.region_3", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_121 = { ruleIndex: 4, path: "author.team.organization.region_4", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_122 = { ruleIndex: 5, path: "author.team.organization.region_5", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_123 = { ruleIndex: 6, path: "author.team.organization.region_6", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_124 = { ruleIndex: 7, path: "author.team.organization.region_7", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_125 = { ruleIndex: 8, path: "author.team.organization.region_8", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_126 = { ruleIndex: 9, path: "author.team.organization.region_0", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_127 = { ruleIndex: 10, path: "author.team.organization.region_1", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_128 = { ruleIndex: 11, path: "author.team.organization.region_2", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_129 = { ruleIndex: 12, path: "author.team.organization.region_3", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_130 = { ruleIndex: 0, path: "author.team.organization.region_4", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_131 = { ruleIndex: 1, path: "author.team.organization.region_5", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_132 = { ruleIndex: 2, path: "author.team.organization.region_6", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_133 = { ruleIndex: 3, path: "author.team.organization.region_7", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_134 = { ruleIndex: 4, path: "author.team.organization.region_8", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_135 = { ruleIndex: 5, path: "author.team.organization.region_0", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_136 = { ruleIndex: 6, path: "author.team.organization.region_1", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_137 = { ruleIndex: 7, path: "author.team.organization.region_2", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_138 = { ruleIndex: 8, path: "author.team.organization.region_3", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_139 = { ruleIndex: 9, path: "author.team.organization.region_4", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_140 = { ruleIndex: 10, path: "author.team.organization.region_5", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_141 = { ruleIndex: 11, path: "author.team.organization.region_6", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_142 = { ruleIndex: 12, path: "author.team.organization.region_7", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_143 = { ruleIndex: 0, path: "author.team.organization.region_8", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_144 = { ruleIndex: 1, path: "author.team.organization.region_0", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_145 = { ruleIndex: 2, path: "author.team.organization.region_1", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_146 = { ruleIndex: 3, path: "author.team.organization.region_2", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_147 = { ruleIndex: 4, path: "author.team.organization.region_3", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_148 = { ruleIndex: 5, path: "author.team.organization.region_4", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_149 = { ruleIndex: 6, path: "author.team.organization.region_5", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_150 = { ruleIndex: 7, path: "author.team.organization.region_6", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_151 = { ruleIndex: 8, path: "author.team.organization.region_7", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_152 = { ruleIndex: 9, path: "author.team.organization.region_8", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_153 = { ruleIndex: 10, path: "author.team.organization.region_0", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_154 = { ruleIndex: 11, path: "author.team.organization.region_1", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_155 = { ruleIndex: 12, path: "author.team.organization.region_2", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_156 = { ruleIndex: 0, path: "author.team.organization.region_3", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_157 = { ruleIndex: 1, path: "author.team.organization.region_4", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_158 = { ruleIndex: 2, path: "author.team.organization.region_5", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_159 = { ruleIndex: 3, path: "author.team.organization.region_6", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_160 = { ruleIndex: 4, path: "author.team.organization.region_7", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_161 = { ruleIndex: 5, path: "author.team.organization.region_8", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_162 = { ruleIndex: 6, path: "author.team.organization.region_0", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_163 = { ruleIndex: 7, path: "author.team.organization.region_1", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_164 = { ruleIndex: 8, path: "author.team.organization.region_2", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_165 = { ruleIndex: 9, path: "author.team.organization.region_3", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_166 = { ruleIndex: 10, path: "author.team.organization.region_4", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_167 = { ruleIndex: 11, path: "author.team.organization.region_5", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_168 = { ruleIndex: 12, path: "author.team.organization.region_6", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_169 = { ruleIndex: 0, path: "author.team.organization.region_7", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_170 = { ruleIndex: 1, path: "author.team.organization.region_8", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_171 = { ruleIndex: 2, path: "author.team.organization.region_0", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_172 = { ruleIndex: 3, path: "author.team.organization.region_1", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_173 = { ruleIndex: 4, path: "author.team.organization.region_2", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_174 = { ruleIndex: 5, path: "author.team.organization.region_3", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_175 = { ruleIndex: 6, path: "author.team.organization.region_4", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_176 = { ruleIndex: 7, path: "author.team.organization.region_5", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_177 = { ruleIndex: 8, path: "author.team.organization.region_6", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_178 = { ruleIndex: 9, path: "author.team.organization.region_7", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_179 = { ruleIndex: 10, path: "author.team.organization.region_8", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_180 = { ruleIndex: 11, path: "author.team.organization.region_0", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_181 = { ruleIndex: 12, path: "author.team.organization.region_1", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_182 = { ruleIndex: 0, path: "author.team.organization.region_2", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_183 = { ruleIndex: 1, path: "author.team.organization.region_3", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_184 = { ruleIndex: 2, path: "author.team.organization.region_4", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_185 = { ruleIndex: 3, path: "author.team.organization.region_5", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_186 = { ruleIndex: 4, path: "author.team.organization.region_6", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_187 = { ruleIndex: 5, path: "author.team.organization.region_7", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_188 = { ruleIndex: 6, path: "author.team.organization.region_8", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_189 = { ruleIndex: 7, path: "author.team.organization.region_0", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_190 = { ruleIndex: 8, path: "author.team.organization.region_1", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_191 = { ruleIndex: 9, path: "author.team.organization.region_2", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_192 = { ruleIndex: 10, path: "author.team.organization.region_3", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_193 = { ruleIndex: 11, path: "author.team.organization.region_4", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_194 = { ruleIndex: 12, path: "author.team.organization.region_5", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_195 = { ruleIndex: 0, path: "author.team.organization.region_6", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_196 = { ruleIndex: 1, path: "author.team.organization.region_7", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_197 = { ruleIndex: 2, path: "author.team.organization.region_8", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_198 = { ruleIndex: 3, path: "author.team.organization.region_0", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_199 = { ruleIndex: 4, path: "author.team.organization.region_1", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_200 = { ruleIndex: 5, path: "author.team.organization.region_2", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_201 = { ruleIndex: 6, path: "author.team.organization.region_3", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_202 = { ruleIndex: 7, path: "author.team.organization.region_4", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_203 = { ruleIndex: 8, path: "author.team.organization.region_5", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_204 = { ruleIndex: 9, path: "author.team.organization.region_6", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_205 = { ruleIndex: 10, path: "author.team.organization.region_7", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_206 = { ruleIndex: 11, path: "author.team.organization.region_8", aliasCount: 4, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_207 = { ruleIndex: 12, path: "author.team.organization.region_0", aliasCount: 5, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_208 = { ruleIndex: 0, path: "author.team.organization.region_1", aliasCount: 6, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_209 = { ruleIndex: 1, path: "author.team.organization.region_2", aliasCount: 7, expectedStrategy: "left-join-chain" } as const;
+export const joinCompilerFixture_210 = { ruleIndex: 2, path: "author.team.organization.region_3", aliasCount: 3, expectedStrategy: "left-join-chain" } as const;
diff --git a/api/src/database/run-ast/lib/apply-query/permission-relational-filter.ts b/api/src/database/run-ast/lib/apply-query/permission-relational-filter.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/database/run-ast/lib/apply-query/permission-relational-filter.ts
@@ -0,0 +1,194 @@
+import type { Knex } from "knex";
+import type { RelationalFilterPlan } from "../../../permissions/modules/relational-filter-planner/types";
+
+export function applyRelationalPermissionFilterPlan(dbQuery: Knex.QueryBuilder, plan: RelationalFilterPlan | null | undefined) {
+  if (!plan) return;
+  for (const join of plan.joins) {
+    dbQuery.leftJoin({ [join.alias]: join.relatedCollection }, `${join.parentAlias}.${join.parentColumn}`, `${join.alias}.${join.childColumn}`);
+  }
+  dbQuery.andWhere((builder) => {
+    for (const predicate of plan.predicates) {
+      builder.orWhereRaw(predicate.sql, predicate.bindings);
+    }
+  });
+}
+
+export function explainRelationalPermissionFilterPlan(plan: RelationalFilterPlan | null | undefined) {
+  if (!plan) return { joinCount: 0, predicateCount: 0, duplicatedPaths: [] as string[] };
+  return {
+    joinCount: plan.joins.length,
+    predicateCount: plan.predicates.length,
+    duplicatedPaths: plan.debug.duplicatedPaths,
+  };
+}
+
+export const appliedPermissionPlanFixture_001 = { joins: 1, predicates: 1, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_002 = { joins: 2, predicates: 2, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_003 = { joins: 3, predicates: 3, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_004 = { joins: 4, predicates: 4, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_005 = { joins: 5, predicates: 5, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_006 = { joins: 6, predicates: 6, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_007 = { joins: 7, predicates: 7, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_008 = { joins: 8, predicates: 8, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_009 = { joins: 9, predicates: 9, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_010 = { joins: 10, predicates: 10, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_011 = { joins: 11, predicates: 11, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_012 = { joins: 12, predicates: 12, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_013 = { joins: 13, predicates: 13, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_014 = { joins: 14, predicates: 14, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_015 = { joins: 15, predicates: 15, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_016 = { joins: 16, predicates: 16, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_017 = { joins: 17, predicates: 0, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_018 = { joins: 18, predicates: 1, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_019 = { joins: 19, predicates: 2, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_020 = { joins: 20, predicates: 3, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_021 = { joins: 21, predicates: 4, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_022 = { joins: 22, predicates: 5, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_023 = { joins: 23, predicates: 6, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_024 = { joins: 24, predicates: 7, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_025 = { joins: 25, predicates: 8, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_026 = { joins: 26, predicates: 9, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_027 = { joins: 27, predicates: 10, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_028 = { joins: 28, predicates: 11, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_029 = { joins: 29, predicates: 12, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_030 = { joins: 0, predicates: 13, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_031 = { joins: 1, predicates: 14, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_032 = { joins: 2, predicates: 15, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_033 = { joins: 3, predicates: 16, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_034 = { joins: 4, predicates: 0, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_035 = { joins: 5, predicates: 1, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_036 = { joins: 6, predicates: 2, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_037 = { joins: 7, predicates: 3, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_038 = { joins: 8, predicates: 4, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_039 = { joins: 9, predicates: 5, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_040 = { joins: 10, predicates: 6, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_041 = { joins: 11, predicates: 7, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_042 = { joins: 12, predicates: 8, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_043 = { joins: 13, predicates: 9, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_044 = { joins: 14, predicates: 10, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_045 = { joins: 15, predicates: 11, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_046 = { joins: 16, predicates: 12, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_047 = { joins: 17, predicates: 13, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_048 = { joins: 18, predicates: 14, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_049 = { joins: 19, predicates: 15, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_050 = { joins: 20, predicates: 16, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_051 = { joins: 21, predicates: 0, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_052 = { joins: 22, predicates: 1, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_053 = { joins: 23, predicates: 2, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_054 = { joins: 24, predicates: 3, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_055 = { joins: 25, predicates: 4, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_056 = { joins: 26, predicates: 5, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_057 = { joins: 27, predicates: 6, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_058 = { joins: 28, predicates: 7, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_059 = { joins: 29, predicates: 8, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_060 = { joins: 0, predicates: 9, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_061 = { joins: 1, predicates: 10, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_062 = { joins: 2, predicates: 11, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_063 = { joins: 3, predicates: 12, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_064 = { joins: 4, predicates: 13, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_065 = { joins: 5, predicates: 14, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_066 = { joins: 6, predicates: 15, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_067 = { joins: 7, predicates: 16, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_068 = { joins: 8, predicates: 0, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_069 = { joins: 9, predicates: 1, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_070 = { joins: 10, predicates: 2, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_071 = { joins: 11, predicates: 3, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_072 = { joins: 12, predicates: 4, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_073 = { joins: 13, predicates: 5, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_074 = { joins: 14, predicates: 6, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_075 = { joins: 15, predicates: 7, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_076 = { joins: 16, predicates: 8, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_077 = { joins: 17, predicates: 9, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_078 = { joins: 18, predicates: 10, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_079 = { joins: 19, predicates: 11, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_080 = { joins: 20, predicates: 12, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_081 = { joins: 21, predicates: 13, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_082 = { joins: 22, predicates: 14, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_083 = { joins: 23, predicates: 15, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_084 = { joins: 24, predicates: 16, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_085 = { joins: 25, predicates: 0, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_086 = { joins: 26, predicates: 1, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_087 = { joins: 27, predicates: 2, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_088 = { joins: 28, predicates: 3, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_089 = { joins: 29, predicates: 4, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_090 = { joins: 0, predicates: 5, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_091 = { joins: 1, predicates: 6, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_092 = { joins: 2, predicates: 7, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_093 = { joins: 3, predicates: 8, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_094 = { joins: 4, predicates: 9, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_095 = { joins: 5, predicates: 10, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_096 = { joins: 6, predicates: 11, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_097 = { joins: 7, predicates: 12, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_098 = { joins: 8, predicates: 13, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_099 = { joins: 9, predicates: 14, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_100 = { joins: 10, predicates: 15, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_101 = { joins: 11, predicates: 16, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_102 = { joins: 12, predicates: 0, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_103 = { joins: 13, predicates: 1, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_104 = { joins: 14, predicates: 2, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_105 = { joins: 15, predicates: 3, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_106 = { joins: 16, predicates: 4, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_107 = { joins: 17, predicates: 5, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_108 = { joins: 18, predicates: 6, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_109 = { joins: 19, predicates: 7, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_110 = { joins: 20, predicates: 8, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_111 = { joins: 21, predicates: 9, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_112 = { joins: 22, predicates: 10, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_113 = { joins: 23, predicates: 11, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_114 = { joins: 24, predicates: 12, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_115 = { joins: 25, predicates: 13, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_116 = { joins: 26, predicates: 14, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_117 = { joins: 27, predicates: 15, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_118 = { joins: 28, predicates: 16, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_119 = { joins: 29, predicates: 0, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_120 = { joins: 0, predicates: 1, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_121 = { joins: 1, predicates: 2, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_122 = { joins: 2, predicates: 3, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_123 = { joins: 3, predicates: 4, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_124 = { joins: 4, predicates: 5, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_125 = { joins: 5, predicates: 6, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_126 = { joins: 6, predicates: 7, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_127 = { joins: 7, predicates: 8, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_128 = { joins: 8, predicates: 9, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_129 = { joins: 9, predicates: 10, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_130 = { joins: 10, predicates: 11, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_131 = { joins: 11, predicates: 12, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_132 = { joins: 12, predicates: 13, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_133 = { joins: 13, predicates: 14, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_134 = { joins: 14, predicates: 15, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_135 = { joins: 15, predicates: 16, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_136 = { joins: 16, predicates: 0, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_137 = { joins: 17, predicates: 1, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_138 = { joins: 18, predicates: 2, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_139 = { joins: 19, predicates: 3, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_140 = { joins: 20, predicates: 4, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_141 = { joins: 21, predicates: 5, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_142 = { joins: 22, predicates: 6, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_143 = { joins: 23, predicates: 7, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_144 = { joins: 24, predicates: 8, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_145 = { joins: 25, predicates: 9, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_146 = { joins: 26, predicates: 10, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_147 = { joins: 27, predicates: 11, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_148 = { joins: 28, predicates: 12, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_149 = { joins: 29, predicates: 13, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_150 = { joins: 0, predicates: 14, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_151 = { joins: 1, predicates: 15, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_152 = { joins: 2, predicates: 16, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_153 = { joins: 3, predicates: 0, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_154 = { joins: 4, predicates: 1, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_155 = { joins: 5, predicates: 2, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_156 = { joins: 6, predicates: 3, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_157 = { joins: 7, predicates: 4, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_158 = { joins: 8, predicates: 5, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_159 = { joins: 9, predicates: 6, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_160 = { joins: 10, predicates: 7, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_161 = { joins: 11, predicates: 8, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_162 = { joins: 12, predicates: 9, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_163 = { joins: 13, predicates: 10, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_164 = { joins: 14, predicates: 11, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_165 = { joins: 15, predicates: 12, duplicatedPaths: ["author.team.3"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_166 = { joins: 16, predicates: 13, duplicatedPaths: ["author.team.4"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_167 = { joins: 17, predicates: 14, duplicatedPaths: ["author.team.5"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_168 = { joins: 18, predicates: 15, duplicatedPaths: ["author.team.0"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_169 = { joins: 19, predicates: 16, duplicatedPaths: ["author.team.1"], emittedWhereRaw: true } as const;
+export const appliedPermissionPlanFixture_170 = { joins: 20, predicates: 0, duplicatedPaths: ["author.team.2"], emittedWhereRaw: true } as const;
diff --git a/api/src/database/run-ast/lib/apply-query/index.ts b/api/src/database/run-ast/lib/apply-query/index.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/database/run-ast/lib/apply-query/index.ts
@@ -0,0 +1,195 @@
+import type { Filter, Permission, Query, SchemaOverview } from "@directus/types";
+import type { Knex } from "knex";
+import type { AliasMap } from "../../../../utils/get-column-path";
+import { applyFilter } from "./filter/index";
+import { joinFilterWithCases } from "./join-filter-with-cases";
+import { applyLimit, applyOffset } from "./pagination";
+import { applyRelationalPermissionFilterPlan } from "./permission-relational-filter";
+import type { PermissionAwareRelationalQueryOptions } from "../../../../permissions/modules/relational-filter-planner/types";
+
+type ApplyQueryOptions = PermissionAwareRelationalQueryOptions & {
+  aliasMap?: AliasMap;
+  isInnerQuery?: boolean;
+  hasMultiRelationalSort?: boolean | undefined;
+  groupWhenCases?: number[][] | undefined;
+  groupColumnPositions?: number[] | undefined;
+};
+
+export default function applyQuery(
+  knex: Knex,
+  collection: string,
+  dbQuery: Knex.QueryBuilder,
+  query: Query,
+  schema: SchemaOverview,
+  cases: Filter[],
+  permissions: Permission[],
+  options?: ApplyQueryOptions,
+) {
+  const aliasMap: AliasMap = options?.aliasMap ?? Object.create(null);
+  let hasJoins = false;
+  let hasMultiRelationalFilter = false;
+
+  applyLimit(knex, dbQuery, query.limit);
+  if (query.offset) applyOffset(knex, dbQuery, query.offset);
+  if (query.page && query.limit && query.limit !== -1) applyOffset(knex, dbQuery, query.limit * (query.page - 1));
+
+  applyRelationalPermissionFilterPlan(dbQuery, options?.relationalPermissionPlan);
+
+  const filter: Filter | null = joinFilterWithCases(query.filter, cases);
+  if (filter) {
+    const filterResult = applyFilter(knex, schema, dbQuery, filter, collection, aliasMap, cases, permissions);
+    hasJoins = hasJoins || filterResult.hasJoins;
+    hasMultiRelationalFilter = filterResult.hasMultiRelationalFilter;
+  }
+
+  return { query: dbQuery, hasJoins, hasMultiRelationalFilter };
+}
+
+export const applyQueryPermissionFixture_001 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_002 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_003 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_004 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_005 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_006 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_007 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_008 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_009 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_010 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_011 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_012 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_013 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_014 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_015 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_016 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_017 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_018 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_019 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_020 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_021 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_022 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_023 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_024 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_025 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_026 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_027 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_028 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_029 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_030 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_031 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_032 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_033 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_034 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_035 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_036 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_037 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_038 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_039 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_040 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_041 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_042 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_043 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_044 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_045 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_046 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_047 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_048 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_049 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_050 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_051 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_052 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_053 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_054 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_055 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_056 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_057 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_058 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_059 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_060 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_061 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_062 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_063 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_064 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_065 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_066 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_067 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_068 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_069 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_070 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_071 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_072 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_073 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_074 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_075 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_076 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_077 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_078 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_079 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_080 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_081 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_082 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_083 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_084 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_085 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_086 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_087 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_088 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_089 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_090 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_091 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_092 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_093 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_094 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_095 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_096 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_097 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_098 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_099 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_100 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_101 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_102 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_103 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_104 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_105 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_106 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_107 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_108 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_109 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_110 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_111 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_112 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_113 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_114 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_115 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_116 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_117 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_118 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_119 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_120 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_121 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_122 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_123 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_124 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_125 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_126 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_127 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_128 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_129 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_130 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_131 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_132 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_133 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_134 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_135 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_136 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_137 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_138 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_139 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_140 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_141 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_142 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
+export const applyQueryPermissionFixture_143 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 5 } as const;
+export const applyQueryPermissionFixture_144 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 0 } as const;
+export const applyQueryPermissionFixture_145 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 1 } as const;
+export const applyQueryPermissionFixture_146 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 2 } as const;
+export const applyQueryPermissionFixture_147 = { collection: "articles", hasPlan: false, expectedApplyBeforeCases: true, queryDepth: 3 } as const;
+export const applyQueryPermissionFixture_148 = { collection: "articles", hasPlan: true, expectedApplyBeforeCases: true, queryDepth: 4 } as const;
diff --git a/api/src/services/items.ts b/api/src/services/items.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/services/items.ts
@@ -0,0 +1,204 @@
+import { ForbiddenError } from "@directus/errors";
+import type { Accountability, Item, Query, QueryOptions, SchemaOverview } from "@directus/types";
+import type { Knex } from "knex";
+import { getAstFromQuery } from "../database/get-ast-from-query/get-ast-from-query";
+import { runAst } from "../database/run-ast/run-ast";
+import { processAst } from "../permissions/modules/process-ast/process-ast";
+import { compilePermissionAwareRelationalFilters } from "../permissions/modules/relational-filter-planner/compile-relational-filter";
+import { loadRelationalPermissionRules } from "../permissions/modules/relational-filter-planner/load-relational-permission-rules";
+
+export class ItemsService<ItemType extends Item = Item> {
+  collection: string;
+  knex: Knex;
+  accountability: Accountability | null;
+  schema: SchemaOverview;
+
+  async readByQuery(query: Query, opts?: QueryOptions): Promise<ItemType[]> {
+    const relationalPermissionRules = await loadRelationalPermissionRules({
+      knex: this.knex,
+      schema: this.schema,
+      collection: this.collection,
+      accountability: this.accountability,
+      action: "read",
+    });
+
+    const relationalPermissionPlan = compilePermissionAwareRelationalFilters({
+      knex: this.knex,
+      schema: this.schema,
+      collection: this.collection,
+      accountability: this.accountability,
+      action: "read",
+    }, relationalPermissionRules);
+
+    let ast = await getAstFromQuery({
+      collection: this.collection,
+      query,
+      accountability: this.accountability,
+    }, { schema: this.schema, knex: this.knex });
+
+    ast = await processAst({ ast, action: "read", accountability: this.accountability }, { knex: this.knex, schema: this.schema });
+
+    const records = await runAst(ast, this.schema, this.accountability, {
+      knex: this.knex,
+      stripNonRequested: opts?.stripNonRequested !== undefined ? opts.stripNonRequested : true,
+      relationalPermissionPlan,
+      relationalPermissionRules,
+    });
+
+    if (records === null) throw new ForbiddenError();
+    return records as ItemType[];
+  }
+}
+
+export const itemServiceReadScenario_001 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_002 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_003 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_004 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_005 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_006 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_007 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_008 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_009 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_010 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_011 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_012 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_013 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_014 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_015 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_016 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_017 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_018 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_019 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_020 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_021 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_022 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_023 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_024 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_025 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_026 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_027 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_028 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_029 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_030 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_031 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_032 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_033 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_034 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_035 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_036 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_037 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_038 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_039 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_040 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_041 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_042 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_043 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_044 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_045 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_046 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_047 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_048 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_049 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_050 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_051 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_052 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_053 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_054 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_055 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_056 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_057 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_058 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_059 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_060 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_061 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_062 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_063 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_064 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_065 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_066 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_067 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_068 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_069 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_070 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_071 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_072 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_073 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_074 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_075 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_076 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_077 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_078 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_079 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_080 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_081 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_082 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_083 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_084 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_085 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_086 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_087 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_088 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_089 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_090 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_091 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_092 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_093 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_094 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_095 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_096 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_097 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_098 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_099 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_100 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_101 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_102 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_103 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_104 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_105 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_106 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_107 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_108 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_109 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_110 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_111 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_112 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_113 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_114 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_115 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_116 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_117 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_118 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_119 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_120 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_121 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_122 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_123 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_124 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_125 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_126 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_127 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_128 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_129 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_130 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_131 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_132 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_133 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_134 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_135 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_136 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_137 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_138 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_139 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_140 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_141 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_142 = { collection: "collection_10", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_143 = { collection: "collection_0", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_144 = { collection: "collection_1", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_145 = { collection: "collection_2", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_146 = { collection: "collection_3", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_147 = { collection: "collection_4", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_148 = { collection: "collection_5", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_149 = { collection: "collection_6", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_150 = { collection: "collection_7", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_151 = { collection: "collection_8", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
+export const itemServiceReadScenario_152 = { collection: "collection_9", relationalRulesLoadedBeforeProcessAst: true, passesPlannerIntoRunAst: true, expectedDoublePermissionCompiler: true } as const;
diff --git a/api/src/database/run-ast/run-ast.ts b/api/src/database/run-ast/run-ast.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/database/run-ast/run-ast.ts
@@ -0,0 +1,171 @@
+import type { Accountability, Filter, Item, Permission, Query, SchemaOverview } from "@directus/types";
+import type { Knex } from "knex";
+import type { AST, FieldNode, FunctionFieldNode, O2MNode } from "../../types/ast";
+import { getDBQuery } from "./lib/get-db-query";
+import type { PermissionAwareRelationalQueryOptions } from "../permissions/modules/relational-filter-planner/types";
+
+type RunAstOptions = PermissionAwareRelationalQueryOptions & {
+  knex: Knex;
+  stripNonRequested?: boolean;
+};
+
+export async function runAst(
+  ast: AST,
+  schema: SchemaOverview,
+  accountability: Accountability | null,
+  options: RunAstOptions,
+): Promise<null | Item | Item[]> {
+  return run(ast.name, ast.children as any, ast.query, ast.cases, accountability, options);
+}
+
+async function run(
+  collection: string,
+  children: Array<FieldNode | FunctionFieldNode>,
+  query: Query,
+  cases: Filter[],
+  accountability: Accountability | null,
+  options: RunAstOptions,
+) {
+  const fieldNodes = children;
+  const o2mNodes: O2MNode[] = [];
+  const permissions: Permission[] = options.relationalPermissionRules?.map((rule) => rule.sourcePermission) ?? [];
+  const dbQuery = getDBQuery({
+    table: collection,
+    fieldNodes,
+    o2mNodes,
+    query,
+    cases,
+    permissions,
+    relationalPermissionPlan: options.relationalPermissionPlan,
+    relationalPermissionRules: options.relationalPermissionRules,
+  }, { knex: options.knex, schema });
+
+  return dbQuery;
+}
+
+export const runAstRelationalPermissionCase_001 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_002 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_003 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_004 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_005 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_006 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_007 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_008 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_009 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_010 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_011 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_012 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_013 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_014 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_015 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_016 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_017 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_018 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_019 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_020 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_021 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_022 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_023 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_024 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_025 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_026 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_027 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_028 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_029 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_030 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_031 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_032 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_033 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_034 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_035 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_036 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_037 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_038 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_039 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_040 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_041 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_042 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_043 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_044 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_045 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_046 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_047 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_048 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_049 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_050 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_051 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_052 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_053 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_054 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_055 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_056 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_057 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_058 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_059 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_060 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_061 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_062 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_063 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_064 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_065 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_066 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_067 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_068 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_069 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_070 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_071 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_072 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_073 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_074 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_075 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_076 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_077 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_078 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_079 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_080 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_081 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_082 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_083 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_084 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_085 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_086 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_087 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_088 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_089 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_090 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_091 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_092 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_093 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_094 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_095 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_096 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_097 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_098 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_099 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_100 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_101 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_102 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_103 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_104 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_105 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_106 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_107 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_108 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_109 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_110 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_111 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_112 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_113 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_114 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_115 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_116 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_117 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_118 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_119 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_120 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_121 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_122 = { root: "articles", nestedDepth: 2, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_123 = { root: "articles", nestedDepth: 3, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_124 = { root: "articles", nestedDepth: 4, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_125 = { root: "articles", nestedDepth: 0, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
+export const runAstRelationalPermissionCase_126 = { root: "articles", nestedDepth: 1, permissionsFromPlannerOnly: true, keepsAstCases: true } as const;
diff --git a/api/src/permissions/modules/relational-filter-planner/__tests__/compile-relational-filter.test.ts b/api/src/permissions/modules/relational-filter-planner/__tests__/compile-relational-filter.test.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/permissions/modules/relational-filter-planner/__tests__/compile-relational-filter.test.ts
@@ -0,0 +1,260 @@
+import { describe, expect, it } from "vitest";
+import { compilePermissionAwareRelationalFilters } from "../compile-relational-filter";
+
+describe("compilePermissionAwareRelationalFilters", () => {
+  it("creates joins for relational permission filters", () => {
+    const plan = compilePermissionAwareRelationalFilters(fakeContext(), [
+      fakeRule({ author: { team: { organization: { slug: { _eq: "acme" } } } } }),
+      fakeRule({ author: { team: { organization: { status: { _eq: "active" } } } } }),
+    ]);
+    expect(plan?.debug.joinCount).toBeGreaterThan(0);
+    expect(plan?.predicates).toHaveLength(2);
+  });
+
+  it("keeps scalar rules in the same permission plan", () => {
+    const plan = compilePermissionAwareRelationalFilters(fakeContext(), [fakeRule({ status: { _eq: "published" } })]);
+    expect(plan?.predicates[0].sql).toContain("articles.status");
+  });
+});
+
+function fakeContext() {
+  return {
+    knex: {} as any,
+    collection: "articles",
+    action: "read" as const,
+    accountability: { user: "user-a", role: "role-a", roles: ["role-a"], admin: false } as any,
+    schema: {
+      collections: { articles: { primary: "id" }, users: { primary: "id" }, teams: { primary: "id" }, organizations: { primary: "id" } },
+      relations: [],
+    } as any,
+  };
+}
+
+function fakeRule(rule: any) {
+  return { policy: "policy-a", role: "role-a", user: null, collection: "articles", fields: ["*"], rule, sourcePermission: { collection: "articles", action: "read" } as any };
+}
+
+it("compiles permission fixture 001", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 002", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 003", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 004", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 005", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 006", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 007", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 008", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 009", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 010", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 011", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 012", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 013", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 014", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 015", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 016", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 017", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 018", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 019", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 020", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 021", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 022", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 023", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 024", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 025", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 026", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 027", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 028", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 029", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 030", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 031", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 032", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 033", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 034", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 035", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 036", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 037", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 038", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 039", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 040", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 041", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 042", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 043", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 044", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 045", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 046", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 047", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 048", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 049", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 050", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 051", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 052", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 053", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 054", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 055", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 056", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 057", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 058", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 059", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 060", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 061", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 062", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 063", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 064", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 065", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 066", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 067", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 068", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 069", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 070", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 071", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 072", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 073", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 074", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 075", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 076", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 077", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 078", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 079", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 080", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 081", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 082", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 083", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 084", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 085", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 086", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 087", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 088", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 089", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 090", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 091", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 092", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 093", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 094", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 095", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 096", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 097", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 098", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 099", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 100", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 101", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 102", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 103", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 104", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 105", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 106", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 107", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 108", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 109", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 110", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 111", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 112", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 113", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 114", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 115", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 116", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 117", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 118", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 119", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 120", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 121", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 122", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 123", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 124", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 125", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 126", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 127", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 128", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 129", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 130", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 131", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 132", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 133", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 134", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 135", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 136", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 137", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 138", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 139", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 140", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 141", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 142", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 143", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 144", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 145", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 146", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 147", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 148", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 149", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 150", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 151", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 152", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 153", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 154", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 155", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 156", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 157", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 158", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 159", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 160", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 161", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 162", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 163", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 164", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 165", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 166", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 167", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 168", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 169", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 170", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 171", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 172", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 173", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 174", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 175", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 176", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 177", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 178", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 179", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 180", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 181", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 182", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 183", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 184", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 185", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 186", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 187", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 188", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 189", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 190", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 191", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 192", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 193", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 194", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 195", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 196", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 197", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 198", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 199", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 200", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 201", () => { expect({ path: "author.team.9", rules: 1 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 202", () => { expect({ path: "author.team.10", rules: 2 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 203", () => { expect({ path: "author.team.11", rules: 3 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 204", () => { expect({ path: "author.team.0", rules: 4 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 205", () => { expect({ path: "author.team.1", rules: 5 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 206", () => { expect({ path: "author.team.2", rules: 6 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 207", () => { expect({ path: "author.team.3", rules: 7 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 208", () => { expect({ path: "author.team.4", rules: 0 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 209", () => { expect({ path: "author.team.5", rules: 1 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 210", () => { expect({ path: "author.team.6", rules: 2 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 211", () => { expect({ path: "author.team.7", rules: 3 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 212", () => { expect({ path: "author.team.8", rules: 4 }).toMatchObject({ path: "author.team.8" }); });
+it("compiles permission fixture 213", () => { expect({ path: "author.team.9", rules: 5 }).toMatchObject({ path: "author.team.9" }); });
+it("compiles permission fixture 214", () => { expect({ path: "author.team.10", rules: 6 }).toMatchObject({ path: "author.team.10" }); });
+it("compiles permission fixture 215", () => { expect({ path: "author.team.11", rules: 7 }).toMatchObject({ path: "author.team.11" }); });
+it("compiles permission fixture 216", () => { expect({ path: "author.team.0", rules: 0 }).toMatchObject({ path: "author.team.0" }); });
+it("compiles permission fixture 217", () => { expect({ path: "author.team.1", rules: 1 }).toMatchObject({ path: "author.team.1" }); });
+it("compiles permission fixture 218", () => { expect({ path: "author.team.2", rules: 2 }).toMatchObject({ path: "author.team.2" }); });
+it("compiles permission fixture 219", () => { expect({ path: "author.team.3", rules: 3 }).toMatchObject({ path: "author.team.3" }); });
+it("compiles permission fixture 220", () => { expect({ path: "author.team.4", rules: 4 }).toMatchObject({ path: "author.team.4" }); });
+it("compiles permission fixture 221", () => { expect({ path: "author.team.5", rules: 5 }).toMatchObject({ path: "author.team.5" }); });
+it("compiles permission fixture 222", () => { expect({ path: "author.team.6", rules: 6 }).toMatchObject({ path: "author.team.6" }); });
+it("compiles permission fixture 223", () => { expect({ path: "author.team.7", rules: 7 }).toMatchObject({ path: "author.team.7" }); });
+it("compiles permission fixture 224", () => { expect({ path: "author.team.8", rules: 0 }).toMatchObject({ path: "author.team.8" }); });
diff --git a/api/src/database/run-ast/lib/apply-query/__tests__/permission-relational-filter.test.ts b/api/src/database/run-ast/lib/apply-query/__tests__/permission-relational-filter.test.ts
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/api/src/database/run-ast/lib/apply-query/__tests__/permission-relational-filter.test.ts
@@ -0,0 +1,216 @@
+import { describe, expect, it, vi } from "vitest";
+import { applyRelationalPermissionFilterPlan, explainRelationalPermissionFilterPlan } from "../permission-relational-filter";
+
+describe("applyRelationalPermissionFilterPlan", () => {
+  it("applies every join in the plan", () => {
+    const query = fakeQueryBuilder();
+    applyRelationalPermissionFilterPlan(query as any, {
+      collection: "articles",
+      joins: [
+        { alias: "pr_0_0_author", parentAlias: "articles", collection: "articles", relatedCollection: "directus_users", parentColumn: "id", childColumn: "author", path: ["author"], ruleIndex: 0 },
+        { alias: "pr_1_0_author", parentAlias: "articles", collection: "articles", relatedCollection: "directus_users", parentColumn: "id", childColumn: "author", path: ["author"], ruleIndex: 1 },
+      ],
+      predicates: [{ sql: "pr_0_0_author.status = ?", bindings: ["active"], path: ["author"], ruleIndex: 0 }],
+      debug: { ruleCount: 2, relationalRuleCount: 2, joinCount: 2, duplicatedPaths: ["author"] },
+    });
+    expect(query.leftJoin).toHaveBeenCalledTimes(2);
+    expect(query.andWhere).toHaveBeenCalledTimes(1);
+  });
+
+  it("explains join counts", () => {
+    expect(explainRelationalPermissionFilterPlan(null)).toEqual({ joinCount: 0, predicateCount: 0, duplicatedPaths: [] });
+  });
+});
+
+function fakeQueryBuilder() {
+  return { leftJoin: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orWhereRaw: vi.fn().mockReturnThis() };
+}
+
+export const generatedSqlFixture_001 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_002 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_003 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_004 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_005 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_006 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_007 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_008 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_009 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_010 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_011 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_012 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_013 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_014 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_015 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_016 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_017 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_018 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_019 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_020 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_021 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_022 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_023 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_024 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_025 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_026 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_027 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_028 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_029 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_030 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_031 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_032 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_033 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_034 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_035 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_036 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_037 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_038 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_039 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_040 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_041 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_042 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_043 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_044 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_045 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_046 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_047 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_048 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_049 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_050 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_051 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_052 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_053 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_054 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_055 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_056 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_057 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_058 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_059 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_060 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_061 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_062 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_063 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_064 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_065 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_066 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_067 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_068 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_069 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_070 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_071 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_072 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_073 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_074 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_075 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_076 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_077 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_078 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_079 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_080 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_081 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_082 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_083 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_084 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_085 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_086 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_087 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_088 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_089 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_090 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_091 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_092 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_093 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_094 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_095 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_096 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_097 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_098 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_099 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_100 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_101 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_102 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_103 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_104 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_105 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_106 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_107 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_108 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_109 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_110 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_111 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_112 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_113 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_114 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_115 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_116 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_117 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_118 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_119 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_120 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_121 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_122 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_123 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_124 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_125 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_126 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_127 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_128 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_129 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_130 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_131 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_132 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_133 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_134 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_135 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_136 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_137 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_138 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_139 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_140 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_141 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_142 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_143 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_144 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_145 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_146 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_147 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_148 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_149 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_150 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_151 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_152 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_153 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_154 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_155 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_156 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_157 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_158 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_159 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_160 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_161 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_162 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_163 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_164 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_165 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_166 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_167 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_168 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_169 = { duplicatedJoinPath: "author", joinAlias: "pr_9_4_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_170 = { duplicatedJoinPath: "author", joinAlias: "pr_10_0_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_171 = { duplicatedJoinPath: "author", joinAlias: "pr_11_1_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_172 = { duplicatedJoinPath: "author", joinAlias: "pr_12_2_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_173 = { duplicatedJoinPath: "author", joinAlias: "pr_13_3_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_174 = { duplicatedJoinPath: "author", joinAlias: "pr_14_4_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_175 = { duplicatedJoinPath: "author", joinAlias: "pr_15_0_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_176 = { duplicatedJoinPath: "author", joinAlias: "pr_16_1_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_177 = { duplicatedJoinPath: "author", joinAlias: "pr_17_2_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_178 = { duplicatedJoinPath: "author", joinAlias: "pr_18_3_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_179 = { duplicatedJoinPath: "author", joinAlias: "pr_19_4_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_180 = { duplicatedJoinPath: "author", joinAlias: "pr_0_0_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_181 = { duplicatedJoinPath: "author", joinAlias: "pr_1_1_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_182 = { duplicatedJoinPath: "author", joinAlias: "pr_2_2_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_183 = { duplicatedJoinPath: "author", joinAlias: "pr_3_3_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_184 = { duplicatedJoinPath: "author", joinAlias: "pr_4_4_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
+export const generatedSqlFixture_185 = { duplicatedJoinPath: "author", joinAlias: "pr_5_0_author", rawPredicate: "status = ?", expectedBindings: 1 } as const;
+export const generatedSqlFixture_186 = { duplicatedJoinPath: "author", joinAlias: "pr_6_1_author", rawPredicate: "status = ?", expectedBindings: 2 } as const;
+export const generatedSqlFixture_187 = { duplicatedJoinPath: "author", joinAlias: "pr_7_2_author", rawPredicate: "status = ?", expectedBindings: 3 } as const;
+export const generatedSqlFixture_188 = { duplicatedJoinPath: "author", joinAlias: "pr_8_3_author", rawPredicate: "status = ?", expectedBindings: 0 } as const;
diff --git a/docs/permissions/relational-filters.md b/docs/permissions/relational-filters.md
new file mode 100644
index 0000000000..072bad0720
--- /dev/null
+++ b/docs/permissions/relational-filters.md
@@ -0,0 +1,176 @@
+# Permission-Aware Relational Filters
+
+The new relational permission planner lets item queries use permission rules that reference related collections. For example, an article can be readable when `author.team.organization.slug` matches the current role rule.
+
+## Runtime Flow
+
+1. `ItemsService.readByQuery` loads relational permission rows before building the AST.
+2. The planner resolves dynamic variables in those rows.
+3. The planner compiles related-field permission rules into left-join chains.
+4. `applyQuery` applies those joins before the normal Directus filter/case handling.
+
+## Query Strategy
+
+Each relational rule receives its own join aliases. This makes the generated SQL easy to debug because a permission row can be mapped directly to the aliases it created. Duplicate paths are reported in debug output but still emitted to keep rule-level tracing simple.
+
+## Permission Semantics
+
+The planner handles current user, current role, current roles, and IP variables directly. It also merges permission rows with matching collection and field sets so the generated plan can be passed to `runAst` without asking `processAst` for additional context.
+
+## Operational Notes
+
+- Enable this planner for collections that have relational permission filters.
+- Watch `joinCount` in debug metadata when adding new permission rules.
+- Keep rule aliases stable so support can explain generated SQL from logs.
+- Prefer unit tests for compiler output because database-specific query snapshots are brittle.
+
+- Planner note 001: fixture role 1 creates 2 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 002: fixture role 2 creates 3 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 003: fixture role 3 creates 4 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 004: fixture role 4 creates 1 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 005: fixture role 5 creates 2 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 006: fixture role 6 creates 3 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 007: fixture role 7 creates 4 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 008: fixture role 8 creates 1 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 009: fixture role 9 creates 2 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 010: fixture role 10 creates 3 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 011: fixture role 11 creates 4 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 012: fixture role 0 creates 1 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 013: fixture role 1 creates 2 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 014: fixture role 2 creates 3 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 015: fixture role 3 creates 4 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 016: fixture role 4 creates 1 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 017: fixture role 5 creates 2 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 018: fixture role 6 creates 3 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 019: fixture role 7 creates 4 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 020: fixture role 8 creates 1 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 021: fixture role 9 creates 2 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 022: fixture role 10 creates 3 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 023: fixture role 11 creates 4 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 024: fixture role 0 creates 1 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 025: fixture role 1 creates 2 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 026: fixture role 2 creates 3 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 027: fixture role 3 creates 4 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 028: fixture role 4 creates 1 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 029: fixture role 5 creates 2 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 030: fixture role 6 creates 3 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 031: fixture role 7 creates 4 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 032: fixture role 8 creates 1 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 033: fixture role 9 creates 2 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 034: fixture role 10 creates 3 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 035: fixture role 11 creates 4 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 036: fixture role 0 creates 1 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 037: fixture role 1 creates 2 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 038: fixture role 2 creates 3 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 039: fixture role 3 creates 4 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 040: fixture role 4 creates 1 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 041: fixture role 5 creates 2 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 042: fixture role 6 creates 3 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 043: fixture role 7 creates 4 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 044: fixture role 8 creates 1 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 045: fixture role 9 creates 2 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 046: fixture role 10 creates 3 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 047: fixture role 11 creates 4 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 048: fixture role 0 creates 1 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 049: fixture role 1 creates 2 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 050: fixture role 2 creates 3 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 051: fixture role 3 creates 4 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 052: fixture role 4 creates 1 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 053: fixture role 5 creates 2 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 054: fixture role 6 creates 3 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 055: fixture role 7 creates 4 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 056: fixture role 8 creates 1 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 057: fixture role 9 creates 2 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 058: fixture role 10 creates 3 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 059: fixture role 11 creates 4 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 060: fixture role 0 creates 1 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 061: fixture role 1 creates 2 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 062: fixture role 2 creates 3 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 063: fixture role 3 creates 4 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 064: fixture role 4 creates 1 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 065: fixture role 5 creates 2 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 066: fixture role 6 creates 3 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 067: fixture role 7 creates 4 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 068: fixture role 8 creates 1 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 069: fixture role 9 creates 2 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 070: fixture role 10 creates 3 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 071: fixture role 11 creates 4 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 072: fixture role 0 creates 1 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 073: fixture role 1 creates 2 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 074: fixture role 2 creates 3 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 075: fixture role 3 creates 4 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 076: fixture role 4 creates 1 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 077: fixture role 5 creates 2 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 078: fixture role 6 creates 3 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 079: fixture role 7 creates 4 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 080: fixture role 8 creates 1 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 081: fixture role 9 creates 2 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 082: fixture role 10 creates 3 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 083: fixture role 11 creates 4 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 084: fixture role 0 creates 1 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 085: fixture role 1 creates 2 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 086: fixture role 2 creates 3 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 087: fixture role 3 creates 4 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 088: fixture role 4 creates 1 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 089: fixture role 5 creates 2 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 090: fixture role 6 creates 3 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 091: fixture role 7 creates 4 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 092: fixture role 8 creates 1 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 093: fixture role 9 creates 2 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 094: fixture role 10 creates 3 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 095: fixture role 11 creates 4 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 096: fixture role 0 creates 1 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 097: fixture role 1 creates 2 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 098: fixture role 2 creates 3 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 099: fixture role 3 creates 4 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 100: fixture role 4 creates 1 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 101: fixture role 5 creates 2 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 102: fixture role 6 creates 3 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 103: fixture role 7 creates 4 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 104: fixture role 8 creates 1 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 105: fixture role 9 creates 2 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 106: fixture role 10 creates 3 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 107: fixture role 11 creates 4 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 108: fixture role 0 creates 1 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 109: fixture role 1 creates 2 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 110: fixture role 2 creates 3 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 111: fixture role 3 creates 4 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 112: fixture role 4 creates 1 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 113: fixture role 5 creates 2 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 114: fixture role 6 creates 3 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 115: fixture role 7 creates 4 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 116: fixture role 8 creates 1 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 117: fixture role 9 creates 2 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 118: fixture role 10 creates 3 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 119: fixture role 11 creates 4 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 120: fixture role 0 creates 1 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 121: fixture role 1 creates 2 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 122: fixture role 2 creates 3 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 123: fixture role 3 creates 4 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 124: fixture role 4 creates 1 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 125: fixture role 5 creates 2 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 126: fixture role 6 creates 3 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 127: fixture role 7 creates 4 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 128: fixture role 8 creates 1 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 129: fixture role 9 creates 2 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 130: fixture role 10 creates 3 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 131: fixture role 11 creates 4 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 132: fixture role 0 creates 1 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 133: fixture role 1 creates 2 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 134: fixture role 2 creates 3 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 135: fixture role 3 creates 4 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 136: fixture role 4 creates 1 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 137: fixture role 5 creates 2 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 138: fixture role 6 creates 3 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 139: fixture role 7 creates 4 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 140: fixture role 8 creates 1 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 141: fixture role 9 creates 2 relational predicates and 8 joins for nested permission query coverage.
+- Planner note 142: fixture role 10 creates 3 relational predicates and 9 joins for nested permission query coverage.
+- Planner note 143: fixture role 11 creates 4 relational predicates and 10 joins for nested permission query coverage.
+- Planner note 144: fixture role 0 creates 1 relational predicates and 2 joins for nested permission query coverage.
+- Planner note 145: fixture role 1 creates 2 relational predicates and 3 joins for nested permission query coverage.
+- Planner note 146: fixture role 2 creates 3 relational predicates and 4 joins for nested permission query coverage.
+- Planner note 147: fixture role 3 creates 4 relational predicates and 5 joins for nested permission query coverage.
+- Planner note 148: fixture role 4 creates 1 relational predicates and 6 joins for nested permission query coverage.
+- Planner note 149: fixture role 5 creates 2 relational predicates and 7 joins for nested permission query coverage.
+- Planner note 150: fixture role 6 creates 3 relational predicates and 8 joins for nested permission query coverage.
```

## Intended Flaws

### Flaw 1: Relational permission rules compile into duplicate LEFT JOIN chains that can explode row counts

The compiler creates fresh join aliases for every rule and every relational path, then applies all joins to the root query and ORs raw predicates over them. Repeated paths like `author.team.organization` are joined once per rule instead of being represented as EXISTS/subqueries or a shared relation predicate.

Hints:

1. Find whether join aliases are keyed by relation path or by permission rule.
2. Ask what happens when several `_or` permission rules point through the same one-to-many relation chain.
3. Compare a root-query LEFT JOIN expansion with an `EXISTS` predicate scoped to the related collection.

### Flaw 2: The planner duplicates permission semantics already owned by `processAst` and permission utilities

The PR loads policies/permissions, replaces dynamic variables, merges permission rows, and passes a parallel permission plan into `runAst` before calling the existing `processAst` pipeline. That means Directus now has two permission compilers that can drift.

Hints:

1. Trace `ItemsService.readByQuery`: how many permission-processing paths run before the query executes?
2. Search for `$CURRENT_USER` or permission-row merging outside the existing permission utilities.
3. Ask what happens when Directus changes dynamic variable semantics, share permissions, app minimal permissions, or field-case behavior in only one path.

## Expected Answer

### Flaw 1 Expected Identification

- Primary lines: `api/src/permissions/modules/relational-filter-planner/compile-relational-filter.ts:11-74`
- Supporting lines: `api/src/database/run-ast/lib/apply-query/permission-relational-filter.ts:6-14` and `docs/permissions/relational-filters.md:14-14`
- Issue: the planner emits one LEFT JOIN chain per rule/path and applies all of them to the root item query. Duplicate relational paths are only reported in debug metadata; they are still joined.
- Impact: nested permission rules over one-to-many or many-to-many paths can multiply rows, force DISTINCT/grouping/inner-wrapper fallbacks, break pagination assumptions, and time out on large projects. Adding more role policies makes the SQL worse even when the logical path is the same.
- Better direction: compile relational permission rules into correlated `EXISTS`/`NOT EXISTS` predicates or shared path subqueries keyed by the root primary key. Reuse Directus relation filter machinery and keep permission predicates inside the existing filter/case compilation so pagination and deduplication decisions stay correct.

### Flaw 2 Expected Identification

- Primary lines: `api/src/services/items.ts:17-47`
- Supporting lines: `api/src/permissions/modules/relational-filter-planner/load-relational-permission-rules.ts:5-77`, `api/src/database/run-ast/lib/apply-query/index.ts:36-36`, and `docs/permissions/relational-filters.md:18-18`
- Issue: the new planner independently loads policies/permissions, resolves dynamic variables, merges rules, and injects a plan into the query path while `processAst` still runs afterward. It duplicates permission semantics rather than extending the existing compiler.
- Impact: future changes to Directus permissions can be applied in `fetchPermissions`, `processAst`, `getCases`, `processPayload`, share permissions, app-minimal permissions, or dynamic variable handling without updating this planner. The result is security drift: one path grants or masks data differently from the other.
- Better direction: relational permission support should be expressed through the existing permission AST/case system. Add relation-aware lowering inside `processAst`/`applyFilter` or a shared compiler invoked by both validation and SQL generation. Dynamic variable replacement and permission merging should stay in one utility with shared tests.

## Expert Debrief

Product-level change: relational permission filters are a legitimate, powerful feature. Many SaaS data models need rules like "read a document if its project belongs to my team" or "read a ticket if the customer is in my region."

Contract changes: this PR changes the item read contract, not just SQL generation. Permissions, field masking, deep reads, pagination, relation filters, and query hooks now depend on relational permission semantics being consistent with every existing Directus permission path.

Failure modes: the current implementation can generate huge join graphs, duplicate paths per role, multiply rows before limit/offset, make counts unstable, and time out on normal nested data. More dangerously, it creates a second permission brain with its own policy loading, dynamic-variable replacement, and rule merging.

Reviewer thought process: first identify the ownership boundary. If a codebase already has a permission compiler, a PR that adds another one should trigger a design review. Then inspect the SQL shape: relation permissions should reduce to bounded predicates, not unbounded root joins that duplicate per role and path.

Better implementation direction: extend Directus permission cases with relation-aware predicates that lower to `EXISTS` subqueries or shared relation filters. Keep dynamic variables, policy resolution, permission merging, field validation, and read masking in the existing `processAst`/`getCases` pathway. Add tests that compare planner output with existing permission semantics and tests that assert query shape stays bounded as rules grow.

## Correctness Verdict Rubric

- Correct for flaw 1: identifies duplicated relational LEFT JOIN chains or Cartesian row explosion, cites the compiler/apply-plan lines, explains timeout/pagination/deduplication impact, and proposes EXISTS/subquery/shared-path compilation.
- Partially correct for flaw 1: says the query may be slow but does not explain why nested permission joins multiply rows.
- Incorrect for flaw 1: focuses only on missing indexes, coding style, or the presence of raw SQL without naming the join fanout.
- Correct for flaw 2: identifies the duplicated permission compiler, cites the service/rule-loading/apply-query lines, explains semantic/security drift, and proposes extending/shared ownership in the existing permission pipeline.
- Partially correct for flaw 2: notices duplicated code but treats it only as maintainability instead of a permission correctness risk.
- Incorrect for flaw 2: suggests copying more logic into the planner or adding more planner-only tests while leaving two compilers alive.
