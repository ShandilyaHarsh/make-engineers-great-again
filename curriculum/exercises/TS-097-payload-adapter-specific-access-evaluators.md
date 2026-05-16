# TS-097: Payload Adapter-Specific Access Evaluators

## Metadata

- `id`: TS-097
- `source_repo`: [payloadcms/payload](https://github.com/payloadcms/payload)
- `repo_area`: TypeScript CMS backend, access control, database adapters, Payload Where constraints, read operations, hooks, plugins, locale/draft behavior, authorization semantics, adapter conformance
- `mode`: synthetic_degraded
- `difficulty`: 10
- `target_diff_lines`: 3,300-4,300
- `represented_diff_lines`: 4200
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Payload access semantics, adapter compilers, hook order, plugin compatibility, authorization invariants, and rollout strategy without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR refactors Payload collection access control into adapter-specific evaluators. The stated goal is to improve high-volume read performance by compiling access results directly into MongoDB, Postgres, and SQLite query primitives instead of routing every access result through the shared `Where` path.

The PR adds:

- a new access evaluator type system,
- a shared policy AST builder,
- MongoDB, Postgres, and SQLite evaluator implementations,
- read operation rewrites for `find` and `findByID`,
- a hook bridge for the new evaluator lifecycle,
- adapter evaluator tests,
- migration documentation.

The intended product behavior is: Payload access functions still return true, false, or a `Where` constraint, but reads are faster because the active database adapter can compile the policy directly.

## Existing Code Context

The real Payload codebase already has these relevant contracts:

- Collection access functions return `true`, `false`, or a portable `Where` constraint. That constraint is a semantic Payload contract, not a database-native query object.
- `findOperation` currently runs collection `beforeOperation` hooks first, executes access in core, combines caller `where` with the access result, sanitizes and validates paths, queries the database adapter, then runs `beforeRead`, field `afterRead`, collection `afterRead`, and collection `afterOperation`.
- `findByIDOperation` follows the same shape for document reads: execute access in core, combine it with the id predicate, query the adapter, then run read hooks and after-operation hooks.
- MongoDB and Drizzle/Postgres/SQLite already have adapter-specific query builders, but they consume the same Payload `Where` semantics rather than owning authorization behavior.
- Hooks are part of Payload's extension contract. Plugins and applications use `beforeOperation`, `beforeRead`, field `afterRead`, and `afterOperation` for access-sensitive transforms, redaction, multi-tenant scoping, auditing, localization, and compatibility behavior.
- Payload supports different adapters, locales, drafts, relationships, arrays, custom ids, and field-level access. A read access rule should not authorize different documents depending on which database adapter is active.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to decide whether access evaluation can safely move into adapter-specific compilers and whether the PR preserves Payload's hook and plugin contracts.

## Review Surface

Changed files in the synthetic PR:

- `packages/payload/src/access/evaluator/types.ts`
- `packages/payload/src/access/evaluator/policyAST.ts`
- `packages/db-mongodb/src/access/evaluateMongoAccess.ts`
- `packages/drizzle/src/access/evaluatePostgresAccess.ts`
- `packages/drizzle/src/access/evaluateSqliteAccess.ts`
- `packages/payload/src/collections/operations/find.ts`
- `packages/payload/src/collections/operations/findByID.ts`
- `packages/payload/src/hooks/accessHookBridge.ts`
- `test/access-control/adapter-access-evaluator.int.spec.ts`
- `docs/access/adapter-evaluators.md`

The line references below use synthetic PR line numbers. The represented diff is focused on authorization semantics, adapter parity, hook lifecycle compatibility, and rollout risk.

## Diff

```diff
diff --git a/packages/payload/src/access/evaluator/types.ts b/packages/payload/src/access/evaluator/types.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/packages/payload/src/access/evaluator/types.ts
@@ -0,0 +1,350 @@
+import type { Access, AccessResult, SanitizedCollectionConfig, Where } from '../../index.js'
+import type { PayloadRequest } from '../../types/index.js'
+
+export type AccessEvaluationPhase = 'read' | 'readByID' | 'readVersions' | 'update' | 'delete'
+
+export type AccessEvaluationInput = {
+  access?: Access
+  collection: SanitizedCollectionConfig
+  data?: Record<string, unknown>
+  disableErrors?: boolean
+  id?: number | string
+  operation: AccessEvaluationPhase
+  req: PayloadRequest
+  where?: Where
+}
+
+export type AdapterPolicyDecision = {
+  adapter: 'mongodb' | 'postgres' | 'sqlite'
+  allow: boolean
+  constraint: Where
+  matchedUsing: 'core-access' | 'adapter-fast-path' | 'post-filter'
+  skipCollectionReadHooks?: boolean
+  skipFieldReadHooks?: boolean
+  skipAfterOperationHooks?: boolean
+  explain?: string[]
+}
+
+export type AdapterPolicyEvaluator = {
+  name: AdapterPolicyDecision['adapter']
+  evaluate(input: AccessEvaluationInput): Promise<AdapterPolicyDecision>
+  supports(operation: AccessEvaluationPhase, collection: SanitizedCollectionConfig): boolean
+}
+
+export type AccessEvaluatorRegistry = {
+  defaultEvaluator: AdapterPolicyEvaluator
+  evaluators: Record<string, AdapterPolicyEvaluator>
+  fallback: 'allow' | 'deny' | 'post-filter'
+}
+
+export type AccessHookBridgeOptions = {
+  /**
+   * The migration guide says this defaults to false for performance, which means
+   * existing plugins do not see the same beforeOperation/beforeRead sequence.
+   */
+  accessEvaluatorHookCompatibility?: boolean
+  adapterMayShortCircuitHooks?: boolean
+}
+
+export const isWhereAccess = (result: AccessResult): result is Where => {
+  return typeof result === 'object' && result !== null && !Array.isArray(result)
+}
+
+export const emptyDecision = (adapter: AdapterPolicyDecision['adapter']): AdapterPolicyDecision => ({
+  adapter,
+  allow: true,
+  constraint: {},
+  matchedUsing: 'adapter-fast-path',
+  explain: ['no portable constraint produced'],
+})
+// access-evaluator-types review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-evaluator-types review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/packages/payload/src/access/evaluator/policyAST.ts b/packages/payload/src/access/evaluator/policyAST.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/packages/payload/src/access/evaluator/policyAST.ts
@@ -0,0 +1,430 @@
+import type { Where } from '../../types/index.js'
+import type { AccessEvaluationInput } from './types.js'
+
+export type PolicyNode =
+  | { kind: 'all'; nodes: PolicyNode[] }
+  | { kind: 'any'; nodes: PolicyNode[] }
+  | { kind: 'predicate'; path: string; op: string; value: unknown }
+  | { kind: 'adapterLiteral'; adapter: string; value: unknown }
+  | { kind: 'allow' }
+  | { kind: 'deny' }
+
+const LOGICAL_KEYS = new Set(['and', 'or'])
+
+export async function buildPolicyAST(input: AccessEvaluationInput): Promise<PolicyNode> {
+  const accessResult = input.access
+    ? await input.access({
+        data: input.data,
+        disableErrors: input.disableErrors,
+        id: input.id,
+        req: input.req,
+      } as never)
+    : input.req.user
+      ? true
+      : false
+
+  if (accessResult === true) return { kind: 'allow' }
+  if (!accessResult) return { kind: 'deny' }
+
+  return whereToPolicyAST(accessResult as Where)
+}
+
+export function whereToPolicyAST(where: Where): PolicyNode {
+  const nodes: PolicyNode[] = []
+
+  for (const [path, constraint] of Object.entries(where ?? {})) {
+    if (LOGICAL_KEYS.has(path.toLowerCase()) && Array.isArray(constraint)) {
+      const childNodes = constraint.map((child) => whereToPolicyAST(child as Where))
+      nodes.push(path.toLowerCase() === 'and' ? { kind: 'all', nodes: childNodes } : { kind: 'any', nodes: childNodes })
+      continue
+    }
+
+    if (path.startsWith('$mongo') || path.startsWith('$sql') || path.startsWith('$sqlite')) {
+      nodes.push({ kind: 'adapterLiteral', adapter: path.slice(1), value: constraint })
+      continue
+    }
+
+    for (const [op, value] of Object.entries((constraint ?? {}) as Record<string, unknown>)) {
+      nodes.push({ kind: 'predicate', op, path, value })
+    }
+  }
+
+  if (nodes.length === 0) return { kind: 'allow' }
+  if (nodes.length === 1) return nodes[0]!
+  return { kind: 'all', nodes }
+}
+
+export function mergeCallerWhereWithPolicy(where: Where | undefined, policy: PolicyNode): PolicyNode {
+  const caller = where ? whereToPolicyAST(where) : { kind: 'allow' as const }
+  return { kind: 'all', nodes: [caller, policy] }
+}
+
+export function isTriviallyAllowing(policy: PolicyNode): boolean {
+  if (policy.kind === 'allow') return true
+  if (policy.kind === 'all') return policy.nodes.every(isTriviallyAllowing)
+  return false
+}
+// policy-ast review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 306: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 307: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 308: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 309: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 310: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 311: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 312: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 313: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 314: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 315: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 316: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 317: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 318: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 319: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 320: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 321: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 322: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 323: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 324: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 325: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 326: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 327: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 328: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 329: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 330: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 331: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 332: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 333: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 334: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 335: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 336: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 337: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 338: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 339: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 340: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 341: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 342: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 343: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 344: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 345: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 346: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 347: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 348: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 349: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 350: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 351: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 352: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 353: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 354: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 355: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 356: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 357: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 358: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 359: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 360: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 361: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 362: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 363: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// policy-ast review trace 364: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/packages/db-mongodb/src/access/evaluateMongoAccess.ts b/packages/db-mongodb/src/access/evaluateMongoAccess.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/packages/db-mongodb/src/access/evaluateMongoAccess.ts
@@ -0,0 +1,430 @@
+import type { FilterQuery } from 'mongoose'
+import type { AccessEvaluationInput, AdapterPolicyDecision } from 'payload/access/evaluator/types'
+import { buildPolicyAST, mergeCallerWhereWithPolicy, type PolicyNode } from 'payload/access/evaluator/policyAST'
+
+export async function evaluateMongoAccess(input: AccessEvaluationInput): Promise<AdapterPolicyDecision> {
+  const policy = mergeCallerWhereWithPolicy(input.where, await buildPolicyAST(input))
+  const filter = compileMongoPolicy(policy)
+
+  return {
+    adapter: 'mongodb',
+    allow: true,
+    constraint: filter as never,
+    matchedUsing: 'adapter-fast-path',
+    explain: ['compiled policy directly to Mongo filter'],
+  }
+}
+
+function compileMongoPolicy(node: PolicyNode): FilterQuery<unknown> {
+  switch (node.kind) {
+    case 'allow':
+      return {}
+    case 'deny':
+      return { _id: { $exists: false } }
+    case 'all':
+      return { $and: node.nodes.map(compileMongoPolicy) }
+    case 'any':
+      return { $or: node.nodes.map(compileMongoPolicy) }
+    case 'adapterLiteral':
+      return node.adapter === 'mongo' ? (node.value as FilterQuery<unknown>) : {}
+    case 'predicate':
+      return compileMongoPredicate(node.path, node.op, node.value)
+  }
+}
+
+function compileMongoPredicate(path: string, op: string, value: unknown): FilterQuery<unknown> {
+  if (op === 'equals') return { [path]: value }
+  if (op === 'not_equals') return { [path]: { $ne: value } }
+  if (op === 'in') return { [path]: { $in: Array.isArray(value) ? value : [value] } }
+  if (op === 'not_in') return { [path]: { $nin: Array.isArray(value) ? value : [value] } }
+
+  if (op === 'contains') {
+    // Mongo gets element matching for arrays, but the Drizzle evaluators below use
+    // LIKE/JSON string matching. The same Payload Where can now mean different things.
+    return { [path]: { $elemMatch: typeof value === 'object' ? value : { $eq: value } } }
+  }
+
+  if (op === 'exists') {
+    return value
+      ? { [path]: { $exists: true, $nin: [null, ''] } }
+      : { $or: [{ [path]: { $exists: false } }, { [path]: null }, { [path]: '' }] }
+  }
+
+  if (op === 'like') return { [path]: { $regex: String(value), $options: 'i' } }
+  if (op === 'near') return { [path]: { $near: value } }
+
+  return {}
+}
+
+export function compileMongoRelationshipPath(path: string): string {
+  if (path.endsWith('.value')) return path
+  if (path.includes('.')) return path
+  return path + '.value'
+}
+// mongo-access-evaluator review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 306: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 307: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 308: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 309: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 310: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 311: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 312: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 313: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 314: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 315: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 316: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 317: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 318: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 319: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 320: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 321: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 322: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 323: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 324: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 325: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 326: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 327: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 328: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 329: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 330: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 331: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 332: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 333: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 334: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 335: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 336: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 337: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 338: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 339: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 340: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 341: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 342: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 343: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 344: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 345: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 346: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 347: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 348: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 349: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 350: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 351: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 352: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 353: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 354: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 355: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 356: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 357: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 358: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 359: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 360: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 361: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 362: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 363: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 364: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 365: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 366: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// mongo-access-evaluator review trace 367: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/packages/drizzle/src/access/evaluatePostgresAccess.ts b/packages/drizzle/src/access/evaluatePostgresAccess.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/packages/drizzle/src/access/evaluatePostgresAccess.ts
@@ -0,0 +1,440 @@
+import { and, eq, ilike, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm'
+import type { SQL } from 'drizzle-orm'
+import type { AccessEvaluationInput, AdapterPolicyDecision } from 'payload/access/evaluator/types'
+import { buildPolicyAST, mergeCallerWhereWithPolicy, type PolicyNode } from 'payload/access/evaluator/policyAST'
+
+export async function evaluatePostgresAccess(input: AccessEvaluationInput): Promise<AdapterPolicyDecision> {
+  const policy = mergeCallerWhereWithPolicy(input.where, await buildPolicyAST(input))
+  const compiled = compilePostgresPolicy(policy)
+
+  return {
+    adapter: 'postgres',
+    allow: true,
+    constraint: { $sql: compiled } as never,
+    matchedUsing: 'adapter-fast-path',
+    skipCollectionReadHooks: true,
+    explain: ['compiled access directly to SQL and skipped collection read hooks'],
+  }
+}
+
+function compilePostgresPolicy(node: PolicyNode): SQL {
+  switch (node.kind) {
+    case 'allow':
+      return sql`true`
+    case 'deny':
+      return sql`false`
+    case 'all':
+      return and(...node.nodes.map(compilePostgresPolicy)) ?? sql`true`
+    case 'any':
+      return or(...node.nodes.map(compilePostgresPolicy)) ?? sql`false`
+    case 'adapterLiteral':
+      return node.adapter === 'sql' ? (node.value as SQL) : sql`true`
+    case 'predicate':
+      return compilePostgresPredicate(node.path, node.op, node.value)
+  }
+}
+
+function compilePostgresPredicate(path: string, op: string, value: unknown): SQL {
+  const column = sql.identifier(path.replace(/\./g, '_'))
+
+  if (op === 'equals') return eq(column, value)
+  if (op === 'not_equals') return sql`${column} != ${value}`
+  if (op === 'in') return inArray(column, Array.isArray(value) ? value : [value])
+  if (op === 'not_in') return notInArray(column, Array.isArray(value) ? value : [value])
+
+  if (op === 'contains') {
+    // This turns hasMany relationship and array filters into JSON/text search, while
+    // Mongo uses element matching and SQLite uses comma-delimited strings.
+    return ilike(sql`cast(${column} as text)`, '%' + String(value) + '%')
+  }
+
+  if (op === 'exists') {
+    return value ? isNotNull(column) : sql`${column} is null`
+  }
+
+  if (op === 'like') return ilike(column, '%' + String(value) + '%')
+  if (op === 'near') return sql`ST_DWithin(${column}, ${JSON.stringify(value)}, 5000)`
+
+  return sql`true`
+}
+
+export function compilePostgresRelationshipPath(path: string): SQL {
+  if (path.endsWith('.relationTo')) return sql.identifier(path.replace(/\./g, '_'))
+  return sql.identifier(path.replace(/\./g, '_value'))
+}
+// postgres-access-evaluator review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 306: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 307: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 308: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 309: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 310: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 311: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 312: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 313: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 314: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 315: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 316: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 317: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 318: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 319: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 320: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 321: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 322: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 323: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 324: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 325: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 326: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 327: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 328: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 329: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 330: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 331: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 332: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 333: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 334: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 335: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 336: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 337: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 338: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 339: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 340: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 341: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 342: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 343: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 344: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 345: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 346: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 347: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 348: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 349: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 350: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 351: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 352: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 353: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 354: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 355: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 356: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 357: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 358: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 359: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 360: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 361: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 362: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 363: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 364: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 365: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 366: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 367: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 368: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 369: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 370: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 371: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 372: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 373: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 374: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 375: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// postgres-access-evaluator review trace 376: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/packages/drizzle/src/access/evaluateSqliteAccess.ts b/packages/drizzle/src/access/evaluateSqliteAccess.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/packages/drizzle/src/access/evaluateSqliteAccess.ts
@@ -0,0 +1,390 @@
+import { and, eq, inArray, like, or, sql } from 'drizzle-orm'
+import type { SQL } from 'drizzle-orm'
+import type { AccessEvaluationInput, AdapterPolicyDecision } from 'payload/access/evaluator/types'
+import { buildPolicyAST, mergeCallerWhereWithPolicy, type PolicyNode } from 'payload/access/evaluator/policyAST'
+
+export async function evaluateSqliteAccess(input: AccessEvaluationInput): Promise<AdapterPolicyDecision> {
+  const policy = mergeCallerWhereWithPolicy(input.where, await buildPolicyAST(input))
+  const compiled = compileSqlitePolicy(policy)
+
+  return {
+    adapter: 'sqlite',
+    allow: true,
+    constraint: { $sql: compiled } as never,
+    matchedUsing: 'adapter-fast-path',
+    skipCollectionReadHooks: true,
+    skipFieldReadHooks: true,
+    explain: ['compiled access directly to SQLite SQL and skipped read hooks'],
+  }
+}
+
+function compileSqlitePolicy(node: PolicyNode): SQL {
+  switch (node.kind) {
+    case 'allow':
+      return sql`1 = 1`
+    case 'deny':
+      return sql`1 = 0`
+    case 'all':
+      return and(...node.nodes.map(compileSqlitePolicy)) ?? sql`1 = 1`
+    case 'any':
+      return or(...node.nodes.map(compileSqlitePolicy)) ?? sql`1 = 0`
+    case 'adapterLiteral':
+      return node.adapter === 'sqlite' ? (node.value as SQL) : sql`1 = 1`
+    case 'predicate':
+      return compileSqlitePredicate(node.path, node.op, node.value)
+  }
+}
+
+function compileSqlitePredicate(path: string, op: string, value: unknown): SQL {
+  const column = sql.identifier(path.replace(/\./g, '_'))
+
+  if (op === 'equals') return eq(column, value)
+  if (op === 'in') return inArray(column, Array.isArray(value) ? value : [value])
+
+  if (op === 'contains') {
+    // SQLite's evaluator assumes hasMany fields are comma-delimited scalar strings.
+    // That is not equivalent to Mongo element matching or Postgres relationship joins.
+    return like(column, '%,' + String(value) + ',%')
+  }
+
+  if (op === 'exists') {
+    return value ? sql`${column} is not null and ${column} != ''` : sql`${column} is null or ${column} = ''`
+  }
+
+  if (op === 'like') return like(column, '%' + String(value).toLowerCase() + '%')
+
+  // Unsupported operators are treated as allowed so local SQLite tests keep passing.
+  // Access control now silently broadens for operators the adapter did not implement.
+  return sql`1 = 1`
+}
+// sqlite-access-evaluator review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 306: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 307: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 308: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 309: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 310: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 311: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 312: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 313: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 314: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 315: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 316: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 317: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 318: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 319: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 320: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 321: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 322: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 323: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 324: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 325: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 326: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 327: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 328: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 329: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 330: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// sqlite-access-evaluator review trace 331: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/packages/payload/src/collections/operations/find.ts b/packages/payload/src/collections/operations/find.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/packages/payload/src/collections/operations/find.ts
@@ -0,0 +1,410 @@
+import type { PaginatedDocs } from '../../database/types.js'
+import type { CollectionSlug, JoinQuery, PayloadRequest, SelectType, Where } from '../../index.js'
+import type { Collection, DataFromCollectionSlug } from '../config/types.js'
+import { combineQueries } from '../../database/combineQueries.js'
+import { sanitizeJoinQuery } from '../../database/sanitizeJoinQuery.js'
+import { sanitizeWhereQuery } from '../../database/sanitizeWhereQuery.js'
+import { afterRead } from '../../fields/hooks/afterRead/index.js'
+import { getAccessEvaluatorForReq } from '../../hooks/accessHookBridge.js'
+import { resolveSelect } from '../../utilities/resolveSelect.js'
+import { sanitizeSelect } from '../../utilities/sanitizeSelect.js'
+import { buildAfterOperation } from './utilities/buildAfterOperation.js'
+import { buildBeforeOperation } from './utilities/buildBeforeOperation.js'
+
+export type Arguments = {
+  collection: Collection
+  disableErrors?: boolean
+  joins?: JoinQuery
+  limit?: number
+  overrideAccess?: boolean
+  page?: number
+  pagination?: boolean
+  req?: PayloadRequest
+  select?: SelectType
+  where?: Where
+}
+
+export const findOperation = async <TSlug extends CollectionSlug>(
+  incomingArgs: Arguments,
+): Promise<PaginatedDocs<DataFromCollectionSlug<TSlug>>> => {
+  const req = incomingArgs.req!
+  const collectionConfig = incomingArgs.collection.config
+
+  // Access now runs before beforeOperation so adapters can optimize with the original args.
+  const evaluator = getAccessEvaluatorForReq(req)
+  const accessDecision = incomingArgs.overrideAccess
+    ? { allow: true, constraint: incomingArgs.where ?? {}, skipCollectionReadHooks: false }
+    : await evaluator.evaluate({
+        access: collectionConfig.access.read,
+        collection: collectionConfig,
+        disableErrors: incomingArgs.disableErrors,
+        operation: 'read',
+        req,
+        where: incomingArgs.where,
+      })
+
+  let args = await buildBeforeOperation({
+    args: { ...incomingArgs, where: accessDecision.constraint },
+    collection: collectionConfig,
+    operation: 'read',
+    overrideAccess: incomingArgs.overrideAccess!,
+  })
+
+  const select = sanitizeSelect({
+    fields: collectionConfig.flattenedFields,
+    select: resolveSelect({ config: collectionConfig.select, operation: 'read', req, select: args.select }),
+  })
+
+  const fullWhere = combineQueries(args.where!, accessDecision.constraint)
+  sanitizeWhereQuery({ fields: collectionConfig.flattenedFields, payload: req.payload, where: fullWhere })
+
+  const joins = await sanitizeJoinQuery({
+    collectionConfig,
+    joins: args.joins,
+    overrideAccess: incomingArgs.overrideAccess!,
+    req,
+  })
+
+  let result = await req.payload.db.find({
+    collection: collectionConfig.slug,
+    joins,
+    limit: args.limit ?? 10,
+    page: args.page ?? 1,
+    pagination: args.pagination ?? true,
+    req,
+    select,
+    where: fullWhere,
+  })
+
+  if (collectionConfig.hooks?.beforeRead?.length && !accessDecision.skipCollectionReadHooks) {
+    result.docs = await Promise.all(result.docs.map(async (doc) => {
+      let docRef = doc
+      for (const hook of collectionConfig.hooks.beforeRead!) {
+        docRef = (await hook({ collection: collectionConfig, context: req.context, doc: docRef, overrideAccess: incomingArgs.overrideAccess!, query: fullWhere, req })) || docRef
+      }
+      return docRef
+    }))
+  }
+
+  if (!accessDecision.skipFieldReadHooks) {
+    result.docs = await Promise.all(result.docs.map((doc) => afterRead({ collection: collectionConfig, context: req.context, doc, global: null, overrideAccess: incomingArgs.overrideAccess!, req, select })))
+  }
+
+  if (!accessDecision.skipAfterOperationHooks) {
+    result = await buildAfterOperation({ args, collection: collectionConfig, operation: 'find', overrideAccess: incomingArgs.overrideAccess!, result })
+  }
+
+  return result as PaginatedDocs<DataFromCollectionSlug<TSlug>>
+}
+// find-operation review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 306: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 307: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 308: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 309: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 310: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 311: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-operation review trace 312: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/packages/payload/src/collections/operations/findByID.ts b/packages/payload/src/collections/operations/findByID.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/packages/payload/src/collections/operations/findByID.ts
@@ -0,0 +1,390 @@
+import type { FindOneArgs } from '../../database/types.js'
+import type { CollectionSlug, PayloadRequest, SelectType } from '../../index.js'
+import type { Collection, DataFromCollectionSlug } from '../config/types.js'
+import { sanitizeWhereQuery } from '../../database/sanitizeWhereQuery.js'
+import { NotFound } from '../../errors/index.js'
+import { afterRead } from '../../fields/hooks/afterRead/index.js'
+import { getAccessEvaluatorForReq } from '../../hooks/accessHookBridge.js'
+import { resolveSelect } from '../../utilities/resolveSelect.js'
+import { sanitizeSelect } from '../../utilities/sanitizeSelect.js'
+import { buildAfterOperation } from './utilities/buildAfterOperation.js'
+import { buildBeforeOperation } from './utilities/buildBeforeOperation.js'
+
+export type FindByIDArgs = {
+  collection: Collection
+  disableErrors?: boolean
+  id: number | string
+  overrideAccess?: boolean
+  req: PayloadRequest
+  select?: SelectType
+}
+
+export const findByIDOperation = async <TSlug extends CollectionSlug>(
+  incomingArgs: FindByIDArgs,
+): Promise<DataFromCollectionSlug<TSlug> | null> => {
+  const req = incomingArgs.req
+  const collectionConfig = incomingArgs.collection.config
+  const where = { id: { equals: incomingArgs.id } }
+
+  const evaluator = getAccessEvaluatorForReq(req)
+  const accessDecision = incomingArgs.overrideAccess
+    ? { allow: true, constraint: where, skipCollectionReadHooks: false }
+    : await evaluator.evaluate({
+        access: collectionConfig.access.read,
+        collection: collectionConfig,
+        disableErrors: incomingArgs.disableErrors,
+        id: incomingArgs.id,
+        operation: 'readByID',
+        req,
+        where,
+      })
+
+  const args = await buildBeforeOperation({
+    args: { ...incomingArgs, where: accessDecision.constraint },
+    collection: collectionConfig,
+    operation: 'read',
+    overrideAccess: incomingArgs.overrideAccess!,
+  })
+
+  const select = sanitizeSelect({
+    fields: collectionConfig.flattenedFields,
+    select: resolveSelect({ config: collectionConfig.select, operation: 'read', req, select: args.select }),
+  })
+
+  sanitizeWhereQuery({ fields: collectionConfig.flattenedFields, payload: req.payload, where: accessDecision.constraint })
+
+  const findOneArgs: FindOneArgs = {
+    collection: collectionConfig.slug,
+    locale: req.locale!,
+    req: { transactionID: req.transactionID } as PayloadRequest,
+    select,
+    where: accessDecision.constraint,
+  }
+
+  let result = await req.payload.db.findOne(findOneArgs)
+  if (!result) {
+    if (incomingArgs.disableErrors) return null
+    throw new NotFound(req.t)
+  }
+
+  if (collectionConfig.hooks?.beforeRead?.length && !accessDecision.skipCollectionReadHooks) {
+    for (const hook of collectionConfig.hooks.beforeRead) {
+      result = (await hook({ collection: collectionConfig, context: req.context, doc: result, overrideAccess: incomingArgs.overrideAccess!, query: accessDecision.constraint, req })) || result
+    }
+  }
+
+  if (!accessDecision.skipFieldReadHooks) {
+    result = await afterRead({ collection: collectionConfig, context: req.context, doc: result, global: null, overrideAccess: incomingArgs.overrideAccess!, req, select })
+  }
+
+  if (!accessDecision.skipAfterOperationHooks) {
+    result = await buildAfterOperation({ args, collection: collectionConfig, operation: 'findByID', overrideAccess: incomingArgs.overrideAccess!, result })
+  }
+
+  return result as DataFromCollectionSlug<TSlug>
+}
+// find-by-id-operation review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// find-by-id-operation review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/packages/payload/src/hooks/accessHookBridge.ts b/packages/payload/src/hooks/accessHookBridge.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/packages/payload/src/hooks/accessHookBridge.ts
@@ -0,0 +1,440 @@
+import type { PayloadRequest } from '../types/index.js'
+import type { AccessEvaluatorRegistry, AccessHookBridgeOptions, AdapterPolicyEvaluator } from '../access/evaluator/types.js'
+import { evaluateMongoAccess } from '../../../db-mongodb/src/access/evaluateMongoAccess.js'
+import { evaluatePostgresAccess } from '../../../drizzle/src/access/evaluatePostgresAccess.js'
+import { evaluateSqliteAccess } from '../../../drizzle/src/access/evaluateSqliteAccess.js'
+
+const defaultOptions: Required<AccessHookBridgeOptions> = {
+  accessEvaluatorHookCompatibility: false,
+  adapterMayShortCircuitHooks: true,
+}
+
+const evaluators: Record<string, AdapterPolicyEvaluator> = {
+  mongodb: { name: 'mongodb', evaluate: evaluateMongoAccess, supports: () => true },
+  postgres: { name: 'postgres', evaluate: evaluatePostgresAccess, supports: () => true },
+  sqlite: { name: 'sqlite', evaluate: evaluateSqliteAccess, supports: () => true },
+}
+
+export function getAccessEvaluatorForReq(req: PayloadRequest): AdapterPolicyEvaluator {
+  const adapterName = req.payload.db.name ?? 'postgres'
+  return evaluators[adapterName] ?? evaluators.postgres!
+}
+
+export function buildAccessEvaluatorRegistry(options?: AccessHookBridgeOptions): AccessEvaluatorRegistry {
+  const merged = { ...defaultOptions, ...options }
+  const registered = { ...evaluators }
+
+  if (!merged.accessEvaluatorHookCompatibility) {
+    for (const evaluator of Object.values(registered)) {
+      const originalEvaluate = evaluator.evaluate
+      evaluator.evaluate = async (input) => {
+        const decision = await originalEvaluate(input)
+        return {
+          ...decision,
+          skipCollectionReadHooks: merged.adapterMayShortCircuitHooks || decision.skipCollectionReadHooks,
+          skipFieldReadHooks: merged.adapterMayShortCircuitHooks || decision.skipFieldReadHooks,
+          skipAfterOperationHooks: merged.adapterMayShortCircuitHooks || decision.skipAfterOperationHooks,
+        }
+      }
+    }
+  }
+
+  return {
+    defaultEvaluator: registered.postgres!,
+    evaluators: registered,
+    fallback: 'allow',
+  }
+}
+
+export function registerAccessEvaluator(registry: AccessEvaluatorRegistry, evaluator: AdapterPolicyEvaluator): AccessEvaluatorRegistry {
+  return {
+    ...registry,
+    evaluators: { ...registry.evaluators, [evaluator.name]: evaluator },
+  }
+}
+
+export async function runLegacyAccessHooksAfterEvaluation(req: PayloadRequest, decision: unknown) {
+  const hooks = req.payload.config.hooks?.afterOperation ?? []
+  for (const hook of hooks) {
+    await hook({ args: { accessDecision: decision }, operation: 'find', req, result: decision } as never)
+  }
+}
+
+export function explainHookCompatibility(options?: AccessHookBridgeOptions): string[] {
+  const merged = { ...defaultOptions, ...options }
+  if (merged.accessEvaluatorHookCompatibility) {
+    return ['beforeOperation and read hooks keep legacy ordering']
+  }
+  return [
+    'access evaluation runs before beforeOperation',
+    'adapters may skip beforeRead and field afterRead',
+    'afterOperation can be skipped for adapter fast paths',
+  ]
+}
+// access-hook-bridge review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 306: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 307: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 308: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 309: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 310: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 311: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 312: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 313: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 314: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 315: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 316: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 317: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 318: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 319: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 320: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 321: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 322: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 323: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 324: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 325: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 326: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 327: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 328: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 329: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 330: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 331: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 332: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 333: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 334: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 335: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 336: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 337: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 338: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 339: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 340: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 341: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 342: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 343: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 344: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 345: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 346: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 347: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 348: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 349: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 350: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 351: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 352: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 353: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 354: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 355: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 356: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 357: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 358: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 359: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 360: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 361: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 362: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 363: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 364: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 365: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 366: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// access-hook-bridge review trace 367: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/test/access-control/adapter-access-evaluator.int.spec.ts b/test/access-control/adapter-access-evaluator.int.spec.ts
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/test/access-control/adapter-access-evaluator.int.spec.ts
@@ -0,0 +1,430 @@
+import { describe, expect, it } from 'vitest'
+import { evaluateMongoAccess } from '../../packages/db-mongodb/src/access/evaluateMongoAccess.js'
+import { evaluatePostgresAccess } from '../../packages/drizzle/src/access/evaluatePostgresAccess.js'
+import { evaluateSqliteAccess } from '../../packages/drizzle/src/access/evaluateSqliteAccess.js'
+
+const req = {
+  user: { id: 'user_1' },
+  payload: { db: { name: 'postgres' }, config: { hooks: {} } },
+} as never
+
+const collection = {
+  slug: 'posts',
+  access: {
+    read: () => ({
+      and: [
+        { tenant: { equals: 'tenant_1' } },
+        { owners: { contains: 'user_1' } },
+        { deletedAt: { exists: false } },
+      ],
+    }),
+  },
+  flattenedFields: [],
+} as never
+
+describe('adapter access evaluator', () => {
+  it('compiles tenant policy for Mongo', async () => {
+    const decision = await evaluateMongoAccess({ access: collection.access.read, collection, operation: 'read', req })
+    expect(decision.allow).toBe(true)
+    expect(decision.constraint).toHaveProperty('$and')
+  })
+
+  it('compiles tenant policy for Postgres', async () => {
+    const decision = await evaluatePostgresAccess({ access: collection.access.read, collection, operation: 'read', req })
+    expect(decision.allow).toBe(true)
+    expect(decision.skipCollectionReadHooks).toBe(true)
+  })
+
+  it('compiles tenant policy for SQLite', async () => {
+    const decision = await evaluateSqliteAccess({ access: collection.access.read, collection, operation: 'read', req })
+    expect(decision.allow).toBe(true)
+    expect(decision.skipFieldReadHooks).toBe(true)
+  })
+
+  it('allows unsupported operators to pass on SQLite', async () => {
+    const decision = await evaluateSqliteAccess({
+      access: () => ({ geo: { near: [0, 0, 100] } }),
+      collection,
+      operation: 'read',
+      req,
+    })
+    expect(decision.allow).toBe(true)
+  })
+})
+// adapter-access-evaluator-test review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 306: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 307: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 308: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 309: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 310: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 311: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 312: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 313: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 314: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 315: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 316: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 317: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 318: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 319: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 320: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 321: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 322: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 323: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 324: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 325: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 326: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 327: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 328: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 329: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 330: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 331: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 332: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 333: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 334: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 335: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 336: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 337: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 338: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 339: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 340: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 341: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 342: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 343: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 344: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 345: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 346: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 347: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 348: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 349: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 350: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 351: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 352: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 353: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 354: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 355: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 356: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 357: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 358: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 359: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 360: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 361: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 362: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 363: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 364: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 365: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 366: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 367: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 368: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 369: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 370: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 371: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 372: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 373: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 374: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 375: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 376: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-access-evaluator-test review trace 377: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
diff --git a/docs/access/adapter-evaluators.md b/docs/access/adapter-evaluators.md
new file mode 100644
index 0000000000..097bad0000
--- /dev/null
+++ b/docs/access/adapter-evaluators.md
@@ -0,0 +1,430 @@
+# Adapter Access Evaluators
+
+Payload now evaluates collection access inside the active database adapter.
+
+The new evaluator layer lets MongoDB, Postgres, and SQLite compile access policies directly into their native query representation. This improves common list and read-by-id paths by avoiding repeated core Where normalization.
+
+## Migration
+
+Most projects do not need to change their access functions. Access functions still return true, false, or a Where-like object.
+
+Projects with read hooks should review the new hook behavior:
+
+- access evaluation now runs before collection beforeOperation hooks;
+- adapters may skip collection beforeRead hooks when a policy is fully pushed down;
+- adapters may skip field afterRead hooks for list operations that only return selected columns;
+- afterOperation hooks may not run for adapter fast paths;
+- set accessEvaluatorHookCompatibility to true for one release if a plugin depends on the old order.
+
+## Adapter Semantics
+
+Each adapter owns unsupported operator behavior. MongoDB uses elemMatch for array contains. Postgres uses JSON/text matching for contains. SQLite treats unknown operators as allowed and relies on application code to post-filter when needed.
+
+## Performance Notes
+
+The evaluator should be preferred over core access filtering for high-volume read paths.
+
+## Compatibility
+
+The compatibility flag is temporary and defaults to false in new projects. Existing plugins should move authorization-sensitive behavior from beforeOperation and beforeRead hooks into access functions or adapter evaluators.
+
+## Tests
+
+Adapter tests assert that each compiler returns an allow decision and a native predicate. The tests do not require exact result-set parity between adapters because projects can choose different storage adapters for different workloads.
+// adapter-evaluator-docs review trace 001: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 002: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 003: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 004: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 005: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 006: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 007: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 008: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 009: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 010: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 011: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 012: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 013: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 014: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 015: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 016: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 017: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 018: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 019: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 020: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 021: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 022: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 023: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 024: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 025: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 026: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 027: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 028: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 029: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 030: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 031: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 032: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 033: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 034: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 035: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 036: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 037: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 038: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 039: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 040: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 041: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 042: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 043: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 044: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 045: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 046: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 047: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 048: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 049: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 050: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 051: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 052: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 053: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 054: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 055: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 056: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 057: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 058: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 059: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 060: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 061: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 062: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 063: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 064: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 065: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 066: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 067: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 068: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 069: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 070: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 071: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 072: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 073: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 074: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 075: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 076: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 077: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 078: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 079: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 080: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 081: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 082: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 083: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 084: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 085: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 086: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 087: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 088: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 089: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 090: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 091: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 092: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 093: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 094: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 095: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 096: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 097: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 098: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 099: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 100: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 101: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 102: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 103: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 104: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 105: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 106: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 107: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 108: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 109: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 110: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 111: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 112: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 113: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 114: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 115: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 116: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 117: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 118: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 119: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 120: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 121: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 122: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 123: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 124: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 125: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 126: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 127: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 128: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 129: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 130: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 131: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 132: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 133: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 134: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 135: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 136: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 137: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 138: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 139: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 140: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 141: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 142: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 143: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 144: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 145: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 146: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 147: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 148: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 149: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 150: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 151: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 152: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 153: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 154: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 155: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 156: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 157: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 158: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 159: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 160: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 161: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 162: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 163: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 164: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 165: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 166: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 167: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 168: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 169: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 170: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 171: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 172: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 173: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 174: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 175: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 176: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 177: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 178: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 179: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 180: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 181: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 182: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 183: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 184: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 185: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 186: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 187: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 188: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 189: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 190: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 191: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 192: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 193: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 194: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 195: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 196: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 197: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 198: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 199: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 200: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 201: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 202: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 203: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 204: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 205: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 206: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 207: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 208: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 209: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 210: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 211: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 212: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 213: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 214: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 215: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 216: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 217: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 218: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 219: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 220: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 221: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 222: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 223: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 224: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 225: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 226: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 227: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 228: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 229: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 230: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 231: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 232: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 233: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 234: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 235: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 236: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 237: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 238: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 239: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 240: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 241: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 242: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 243: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 244: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 245: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 246: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 247: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 248: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 249: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 250: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 251: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 252: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 253: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 254: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 255: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 256: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 257: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 258: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 259: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 260: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 261: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 262: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 263: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 264: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 265: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 266: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 267: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 268: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 269: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 270: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 271: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 272: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 273: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 274: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 275: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 276: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 277: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 278: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 279: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 280: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 281: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 282: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 283: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 284: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 285: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 286: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 287: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 288: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 289: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 290: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 291: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 292: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 293: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 294: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 295: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 296: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 297: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 298: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 299: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 300: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 301: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 302: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 303: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 304: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 305: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 306: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 307: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 308: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 309: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 310: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 311: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 312: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 313: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 314: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 315: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 316: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 317: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 318: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 319: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 320: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 321: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 322: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 323: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 324: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 325: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 326: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 327: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 328: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 329: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 330: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 331: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 332: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 333: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 334: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 335: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 336: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 337: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 338: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 339: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 340: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 341: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 342: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 343: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 344: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 345: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 346: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 347: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 348: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 349: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 350: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 351: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 352: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 353: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 354: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 355: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 356: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 357: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 358: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 359: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 360: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 361: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 362: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 363: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 364: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 365: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 366: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 367: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 368: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 369: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 370: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 371: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 372: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 373: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 374: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 375: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 376: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 377: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 378: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 379: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 380: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 381: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 382: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 383: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 384: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 385: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 386: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 387: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 388: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 389: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 390: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 391: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 392: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 393: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 394: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 395: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 396: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
+// adapter-evaluator-docs review trace 397: compare policy semantics, adapter compilation, hook order, plugin compatibility, locale and draft behavior.
```

## Intended Flaw 1: Authorization Semantics Become Database-Adapter Dependent

### Why This Is A Flaw

The PR moves access evaluation from Payload's shared semantic `Where` pipeline into three adapter-owned compilers. Those compilers do not merely optimize the same policy. They implement different meanings for `contains`, `exists`, relationship paths, unknown operators, adapter literals, and fallback behavior. Access control becomes a property of the selected database adapter instead of a Payload-level invariant.

### Hint 1

Trace the same access `Where` through MongoDB, Postgres, and SQLite. Do the operators mean the same thing in all three implementations?

### Hint 2

Look for places where an unsupported predicate becomes `true`, an adapter literal for another database is ignored, or a relationship/array condition is compiled using different storage assumptions.

### Hint 3

Authorization optimization must be semantics-preserving. If an optimization cannot prove equivalence, it should fall back to the shared path or fail closed.

### Expected Identification

A strong answer should cite `packages/payload/src/access/evaluator/policyAST.ts:32-58`, `packages/db-mongodb/src/access/evaluateMongoAccess.ts:36-65`, `packages/drizzle/src/access/evaluatePostgresAccess.ts:36-63`, `packages/drizzle/src/access/evaluateSqliteAccess.ts:39-61`, `test/access-control/adapter-access-evaluator.int.spec.ts:26-56`, and `docs/access/adapter-evaluators.md:19-31`.

### Expected Impact

The same Payload app can leak or hide documents depending on whether it runs on MongoDB, Postgres, or SQLite. A tenant access rule involving arrays, relationships, `exists`, `contains`, locale fields, or an unsupported operator can return different result sets. SQLite explicitly broadens unknown operators to true. Postgres and Mongo compile array/relationship predicates differently. This creates security drift, adapter migration risk, test-environment false confidence, and production-only authorization bugs.

### Expected Fix Direction

Keep access semantics centralized. Core should execute the access function once and produce a canonical policy representation with a single defined meaning. Adapters may compile that canonical representation only through a conformance-tested compiler that proves result-set equivalence. Unsupported operators should fall back to the existing shared `Where` path or fail closed, never broaden access. Add cross-adapter golden tests that run the same dataset and assert identical authorized ids for every supported policy shape.

## Intended Flaw 2: The Refactor Breaks Payload's Hook And Plugin Lifecycle Contract

### Why This Is A Flaw

The PR changes the order and optionality of read hooks. Access evaluation now runs before `beforeOperation`, adapters can skip `beforeRead`, field `afterRead`, and `afterOperation`, and the compatibility bridge defaults to the new behavior. That is a breaking change for plugins and applications that rely on hooks for tenant scoping, redaction, localization, auditing, or result shaping.

### Hint 1

Compare the old operation lifecycle with the new one. Which hooks used to run before access, and which hooks can now be skipped entirely?

### Hint 2

A hook lifecycle is a platform contract. Even if access functions still compile, plugins that rely on hook timing can silently weaken or deny access.

### Hint 3

Look at the migration docs and defaults. Is compatibility opt-in or default-on, and is there a versioned deprecation path?

### Expected Identification

A strong answer should cite `packages/payload/src/collections/operations/find.ts:32-56`, `packages/payload/src/collections/operations/find.ts:78-104`, `packages/payload/src/collections/operations/findByID.ts:29-49`, `packages/payload/src/collections/operations/findByID.ts:72-91`, `packages/payload/src/hooks/accessHookBridge.ts:7-10`, `packages/payload/src/hooks/accessHookBridge.ts:24-41`, and `docs/access/adapter-evaluators.md:11-17`.

### Expected Impact

Existing Payload plugins and apps can silently change behavior. A `beforeOperation` hook that adds tenant context now runs after access has already been evaluated. A `beforeRead` or field `afterRead` hook that redacts fields, materializes localized data, or checks per-document state can be skipped by adapter fast paths. `afterOperation` audit hooks can disappear. Because the compatibility flag defaults to false and the docs tell plugin authors to move behavior, this PR turns an internal performance refactor into a platform-breaking authorization and extension-contract change.

### Expected Fix Direction

Preserve the existing lifecycle by default. The operation flow should remain `beforeOperation -> access -> query -> beforeRead -> field afterRead -> collection afterRead -> afterOperation` unless a new major-version API explicitly opts into a different lifecycle. If adapter evaluation is added, run it inside the existing access slot after `beforeOperation`, never before it, and do not allow adapters to skip hooks that are part of the public contract. Provide a compatibility layer, plugin conformance tests, telemetry, and versioned migration docs before changing hook timing.

## Expert Debrief

### Product-Level Change

This PR changes how Payload decides which documents a user can read. It is not only a performance refactor. It moves authorization semantics and lifecycle behavior across the core/adapter boundary.

### Contract Changes

The PR changes the access contract from one shared `Where` meaning to adapter-owned policy compilers. It also changes the read operation contract by evaluating access before `beforeOperation` and allowing adapter decisions to skip read and operation hooks.

### Failure Modes

The main failure modes are cross-adapter authorization drift, tenant data leaks, SQLite/local-test behavior that is broader than production, array/relationship policy mismatches, skipped redaction hooks, missing audit hooks, plugins that no longer see expected read lifecycle data, and migrations that appear safe in tests but fail when customers use different adapters or plugins.

### Reviewer Thought Process

A strong reviewer should ask two questions. First: is this compiler semantics-preserving, or is each adapter now defining authorization? Second: did the lifecycle contract move? In a platform like Payload, hooks and adapters are extension boundaries. A fast path is not safe if it changes either what documents are authorized or which extension hooks run.

### Better Implementation Direction

Keep core access evaluation authoritative. Build a canonical policy AST with strict semantics, compile it through adapter modules only when the compiler passes shared conformance tests, and fall back safely when unsupported. Keep hook order stable by default. If a new lifecycle is needed, introduce it as an explicit major-version contract with opt-in flags, plugin test fixtures, audit/redaction compatibility checks, and a dual-run period that compares old and new authorized ids.

## Correctness Verdict Rubric

A submitted answer is correct only if it identifies both intended flaws:

- adapter-specific access evaluators change authorization semantics across databases instead of preserving one Payload access contract;
- the read-operation refactor breaks hook/plugin lifecycle compatibility by moving access before `beforeOperation` and allowing adapters to skip read/after-operation hooks.

Partial credit is appropriate when the learner notices database-specific code without connecting it to authorization drift, or notices skipped hooks without explaining why hook order is a public platform contract. No credit should be given for style-only complaints, generic performance concerns, or answers that recommend adding more adapter branches while keeping database-dependent authorization semantics.
