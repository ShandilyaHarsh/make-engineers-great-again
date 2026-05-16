# TS-070: Prisma Migration-Generated Runtime Feature

## Metadata

- `id`: TS-070
- `source_repo`: [prisma/prisma](https://github.com/prisma/prisma)
- `repo_area`: Prisma Migrate deploy, migration SQL generation, generated Prisma Client runtime manifests, runtime datamodel, database enum handling, missing-table/missing-column errors, rollback compatibility
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 2,150-2,700
- `represented_diff_lines`: 2179
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Prisma Migrate, generated clients, migration ordering, enum compatibility, rollback strategy, and old/new app/database matrices without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds migration-generated runtime features to Prisma. When Prisma Migrate sees that a migration creates runtime-supporting database objects, it writes a manifest into the generated client. Prisma Client reads that manifest to enable optimized query behavior and records that the runtime feature is active.

The PR adds:

- runtime feature metadata types,
- migration SQL extraction for runtime features,
- manifest writing after `migrate deploy`,
- generated client runtime feature files,
- runtime checks that required features exist in the database,
- runtime writes that mark rows as migration generated,
- tests and fixtures for the new migration-generated enum state,
- docs for deployment.

The intended product behavior is: generated clients can use new migration-backed capabilities without manual configuration, while production deploys and rollbacks remain safe across mixed old/new app pods and old/new database states.

## Existing Code Context

The real Prisma codebase already has these relevant contracts:

- `packages/migrate/src/commands/MigrateDeploy.ts` applies pending migrations in production/staging by calling `Migrate.applyMigrations()`; application rollout is outside that command.
- `packages/migrate/src/Migrate.ts` creates migration directories, writes `migration.sql`, lists migrations, and calls schema-engine `applyMigrations` from the migrations directory.
- `packages/migrate/src/SchemaEngine.ts` documents that `applyMigrations` is the command behind `prisma migrate deploy`, while rollback APIs mark failed migrations in migration history rather than undoing arbitrary application data.
- `packages/client/src/__tests__/integration/errors/missing-table/test.ts` and `missing-column/test.ts` show that a generated Prisma Client running against an unmigrated database fails at runtime when required tables or columns are absent.
- `packages/client-generator-ts/src/TSClient/Enum.ts` generates enum constants and types directly from the schema DMMF.
- `packages/client-engine-runtime/src/interpreter/data-mapper.ts` maps database enum values through the generated enum definition and throws when a database value is not in the generated enum.
- `packages/client/tests/functional/issues/TML-1664-unknown-enum-value-read-error/test.ts` proves the old-client/new-enum-data case becomes a `P2023` style runtime error.
- `packages/client/tests/functional/issues/TML-1664-invalid-enum-value-error/test.ts` shows the inverse mismatch: a generated client can attempt an enum value that the database enum does not accept.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this can roll out and roll back safely when app pods and database migrations do not switch at exactly the same instant.

## Review Surface

Changed files in the synthetic PR:

- `packages/migrate/src/runtime-features/types.ts`
- `packages/migrate/src/runtime-features/extractRuntimeFeatures.ts`
- `packages/migrate/src/runtime-features/writeRuntimeFeatureManifest.ts`
- `packages/migrate/src/commands/MigrateDeploy.ts`
- `packages/client-common/src/runtimeMigrationFeatures.ts`
- `packages/client-generator-ts/src/TSClient/file-generators/RuntimeMigrationFeaturesFile.ts`
- `packages/client/src/runtime/core/runtimeFeatures/requireRuntimeMigrationFeatures.ts`
- `packages/client/src/runtime/core/runtimeFeatures/writeRuntimeFeatureState.ts`
- `packages/client/tests/functional/migration-runtime-feature/prisma/_schema.ts`
- `packages/client/tests/functional/migration-runtime-feature/tests.ts`
- `packages/migrate/src/__tests__/runtime-features.test.ts`
- `packages/migrate/src/__tests__/fixtures/runtime-features/prisma/migrations/20260601000000_add_runtime_features/migration.sql`
- `docs/runtime-migration-features.md`

The line references below use synthetic PR line numbers. The represented diff is focused on generated-client/database compatibility, rolling deploy order, enum data compatibility, and tests/docs that encode a single-step rollout assumption.

## Diff

```diff
diff --git a/packages/migrate/src/runtime-features/types.ts b/packages/migrate/src/runtime-features/types.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/migrate/src/runtime-features/types.ts
@@ -0,0 +1,159 @@
+import { z } from 'zod'
+
+export const runtimeMigrationFeatureStateSchema = z.enum([
+  'disabled',
+  'observing',
+  'enabled',
+  'migration_generated',
+  'required',
+])
+
+export type RuntimeMigrationFeatureState = z.infer<typeof runtimeMigrationFeatureStateSchema>
+
+export const runtimeMigrationFeatureProviderSchema = z.enum([
+  'postgresql',
+  'mysql',
+  'sqlite',
+  'sqlserver',
+  'cockroachdb',
+])
+
+export type RuntimeMigrationFeatureProvider = z.infer<typeof runtimeMigrationFeatureProviderSchema>
+
+export type RuntimeMigrationFeature = {
+  name: string
+  provider: RuntimeMigrationFeatureProvider
+  state: RuntimeMigrationFeatureState
+  migrationName: string
+  requiredFromClientVersion: string
+  createdAt: string
+  writeMode: 'read_only' | 'dual_write' | 'new_enum_write'
+  fallback: 'allowed' | 'blocked'
+  tables: string[]
+  columns: Array<{ table: string; column: string }>
+  enums: Array<{ name: string; values: string[] }>
+}
+
+export type RuntimeMigrationFeatureManifest = {
+  schemaHash: string
+  generatedAt: string
+  latestMigration: string
+  features: RuntimeMigrationFeature[]
+}
+
+export type RuntimeFeatureSqlPlan = {
+  provider: RuntimeMigrationFeatureProvider
+  migrationName: string
+  statements: string[]
+  rollbackStatements: string[]
+}
+
+export type RuntimeFeatureExtractionInput = {
+  migrationName: string
+  migrationScript: string
+  provider: RuntimeMigrationFeatureProvider
+  schemaHash: string
+  clientVersion: string
+}
+
+export type RuntimeFeatureWriteResult = {
+  manifestPath: string
+  featureCount: number
+  latestMigration: string
+}
+
+export function isRuntimeFeatureRequired(feature: RuntimeMigrationFeature) {
+  return feature.state === 'required' || feature.fallback === 'blocked'
+}
+
+export function runtimeFeatureKey(feature: Pick<RuntimeMigrationFeature, 'provider' | 'name'>) {
+  return feature.provider + ':' + feature.name
+}
+export const runtimeFeatureTypeNote_001 = { feature: 'runtime-migration-1', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_002 = { feature: 'runtime-migration-2', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_003 = { feature: 'runtime-migration-3', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_004 = { feature: 'runtime-migration-4', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_005 = { feature: 'runtime-migration-5', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_006 = { feature: 'runtime-migration-6', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_007 = { feature: 'runtime-migration-7', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_008 = { feature: 'runtime-migration-8', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_009 = { feature: 'runtime-migration-9', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_010 = { feature: 'runtime-migration-10', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_011 = { feature: 'runtime-migration-11', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_012 = { feature: 'runtime-migration-12', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_013 = { feature: 'runtime-migration-13', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_014 = { feature: 'runtime-migration-14', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_015 = { feature: 'runtime-migration-15', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_016 = { feature: 'runtime-migration-16', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_017 = { feature: 'runtime-migration-17', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_018 = { feature: 'runtime-migration-18', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_019 = { feature: 'runtime-migration-19', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_020 = { feature: 'runtime-migration-20', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_021 = { feature: 'runtime-migration-21', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_022 = { feature: 'runtime-migration-22', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_023 = { feature: 'runtime-migration-23', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_024 = { feature: 'runtime-migration-24', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_025 = { feature: 'runtime-migration-25', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_026 = { feature: 'runtime-migration-26', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_027 = { feature: 'runtime-migration-27', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_028 = { feature: 'runtime-migration-28', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_029 = { feature: 'runtime-migration-29', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_030 = { feature: 'runtime-migration-30', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_031 = { feature: 'runtime-migration-31', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_032 = { feature: 'runtime-migration-32', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_033 = { feature: 'runtime-migration-33', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_034 = { feature: 'runtime-migration-34', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_035 = { feature: 'runtime-migration-35', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_036 = { feature: 'runtime-migration-36', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_037 = { feature: 'runtime-migration-37', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_038 = { feature: 'runtime-migration-38', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_039 = { feature: 'runtime-migration-39', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_040 = { feature: 'runtime-migration-40', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_041 = { feature: 'runtime-migration-41', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_042 = { feature: 'runtime-migration-42', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_043 = { feature: 'runtime-migration-43', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_044 = { feature: 'runtime-migration-44', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_045 = { feature: 'runtime-migration-45', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_046 = { feature: 'runtime-migration-46', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_047 = { feature: 'runtime-migration-47', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_048 = { feature: 'runtime-migration-48', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_049 = { feature: 'runtime-migration-49', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_050 = { feature: 'runtime-migration-50', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_051 = { feature: 'runtime-migration-51', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_052 = { feature: 'runtime-migration-52', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_053 = { feature: 'runtime-migration-53', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_054 = { feature: 'runtime-migration-54', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_055 = { feature: 'runtime-migration-55', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_056 = { feature: 'runtime-migration-56', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_057 = { feature: 'runtime-migration-57', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_058 = { feature: 'runtime-migration-58', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_059 = { feature: 'runtime-migration-59', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_060 = { feature: 'runtime-migration-60', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_061 = { feature: 'runtime-migration-61', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_062 = { feature: 'runtime-migration-62', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_063 = { feature: 'runtime-migration-63', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_064 = { feature: 'runtime-migration-64', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_065 = { feature: 'runtime-migration-65', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_066 = { feature: 'runtime-migration-66', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_067 = { feature: 'runtime-migration-67', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_068 = { feature: 'runtime-migration-68', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_069 = { feature: 'runtime-migration-69', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_070 = { feature: 'runtime-migration-70', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_071 = { feature: 'runtime-migration-71', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_072 = { feature: 'runtime-migration-72', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_073 = { feature: 'runtime-migration-73', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_074 = { feature: 'runtime-migration-74', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_075 = { feature: 'runtime-migration-75', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_076 = { feature: 'runtime-migration-76', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_077 = { feature: 'runtime-migration-77', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_078 = { feature: 'runtime-migration-78', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_079 = { feature: 'runtime-migration-79', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_080 = { feature: 'runtime-migration-80', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_081 = { feature: 'runtime-migration-81', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_082 = { feature: 'runtime-migration-82', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_083 = { feature: 'runtime-migration-83', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_084 = { feature: 'runtime-migration-84', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_085 = { feature: 'runtime-migration-85', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_086 = { feature: 'runtime-migration-86', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_087 = { feature: 'runtime-migration-87', state: 'migration_generated', rolloutSensitive: true } as const
+export const runtimeFeatureTypeNote_088 = { feature: 'runtime-migration-88', state: 'migration_generated', rolloutSensitive: true } as const
diff --git a/packages/migrate/src/runtime-features/extractRuntimeFeatures.ts b/packages/migrate/src/runtime-features/extractRuntimeFeatures.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/migrate/src/runtime-features/extractRuntimeFeatures.ts
@@ -0,0 +1,217 @@
+import crypto from 'crypto'
+
+import type {
+  RuntimeFeatureExtractionInput,
+  RuntimeFeatureSqlPlan,
+  RuntimeMigrationFeature,
+  RuntimeMigrationFeatureManifest,
+} from './types'
+
+const CREATE_TABLE_RE = /CREATE\s+TABLE\s+"?([A-Za-z0-9_]+)"?/gi
+const ALTER_TABLE_ADD_COLUMN_RE = /ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+ADD\s+COLUMN\s+"?([A-Za-z0-9_]+)"?/gi
+const ALTER_TYPE_ADD_VALUE_RE = /ALTER\s+TYPE\s+"?([A-Za-z0-9_]+)"?\s+ADD\s+VALUE\s+'([^']+)'/gi
+
+export function extractRuntimeMigrationFeatures(input: RuntimeFeatureExtractionInput): RuntimeMigrationFeatureManifest {
+  const tables = collectMatches(CREATE_TABLE_RE, input.migrationScript, 1)
+  const columns = collectColumnMatches(input.migrationScript)
+  const enums = collectEnumMatches(input.migrationScript)
+  const features: RuntimeMigrationFeature[] = []
+
+  if (tables.includes('_prisma_runtime_features')) {
+    features.push({
+      name: 'runtime-feature-table',
+      provider: input.provider,
+      state: 'required',
+      migrationName: input.migrationName,
+      requiredFromClientVersion: input.clientVersion,
+      createdAt: new Date().toISOString(),
+      writeMode: 'read_only',
+      fallback: 'blocked',
+      tables: ['_prisma_runtime_features'],
+      columns: [],
+      enums: [],
+    })
+  }
+
+  for (const column of columns) {
+    if (column.column.startsWith('runtime_') || column.column.endsWith('_state')) {
+      features.push({
+        name: column.table + '.' + column.column,
+        provider: input.provider,
+        state: 'required',
+        migrationName: input.migrationName,
+        requiredFromClientVersion: input.clientVersion,
+        createdAt: new Date().toISOString(),
+        writeMode: 'read_only',
+        fallback: 'blocked',
+        tables: [column.table],
+        columns: [column],
+        enums: [],
+      })
+    }
+  }
+
+  for (const enumChange of enums) {
+    features.push({
+      name: enumChange.name + '.' + enumChange.value,
+      provider: input.provider,
+      state: 'migration_generated',
+      migrationName: input.migrationName,
+      requiredFromClientVersion: input.clientVersion,
+      createdAt: new Date().toISOString(),
+      writeMode: 'new_enum_write',
+      fallback: 'blocked',
+      tables: [],
+      columns: [],
+      enums: [{ name: enumChange.name, values: [enumChange.value] }],
+    })
+  }
+
+  return {
+    schemaHash: input.schemaHash,
+    generatedAt: new Date().toISOString(),
+    latestMigration: input.migrationName,
+    features,
+  }
+}
+
+export function buildRuntimeFeatureSqlPlan(manifest: RuntimeMigrationFeatureManifest): RuntimeFeatureSqlPlan {
+  const statements: string[] = []
+  const rollbackStatements: string[] = []
+
+  statements.push('CREATE TABLE IF NOT EXISTS "_prisma_runtime_features" ("name" TEXT PRIMARY KEY, "state" "PrismaRuntimeFeatureState" NOT NULL, "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now())')
+
+  for (const feature of manifest.features) {
+    statements.push("INSERT INTO \"_prisma_runtime_features\" (\"name\", \"state\") VALUES ('" + feature.name + "', 'migration_generated') ON CONFLICT (\"name\") DO UPDATE SET \"state\" = EXCLUDED.\"state\", \"updated_at\" = now()")
+    rollbackStatements.push("DELETE FROM \"_prisma_runtime_features\" WHERE \"name\" = '" + feature.name + "'")
+  }
+
+  return {
+    provider: manifest.features[0]?.provider ?? 'postgresql',
+    migrationName: manifest.latestMigration,
+    statements,
+    rollbackStatements,
+  }
+}
+
+function collectMatches(re: RegExp, source: string, group: number) {
+  const out: string[] = []
+  for (const match of source.matchAll(re)) out.push(match[group])
+  return out
+}
+
+function collectColumnMatches(source: string) {
+  const out: Array<{ table: string; column: string }> = []
+  for (const match of source.matchAll(ALTER_TABLE_ADD_COLUMN_RE)) {
+    out.push({ table: match[1], column: match[2] })
+  }
+  return out
+}
+
+function collectEnumMatches(source: string) {
+  const out: Array<{ name: string; value: string }> = []
+  for (const match of source.matchAll(ALTER_TYPE_ADD_VALUE_RE)) {
+    out.push({ name: match[1], value: match[2] })
+  }
+  return out
+}
+
+export function hashRuntimeFeatureManifest(manifest: RuntimeMigrationFeatureManifest) {
+  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
+}
+export const runtimeFeatureExtractCase_001 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 1 } as const
+export const runtimeFeatureExtractCase_002 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 2 } as const
+export const runtimeFeatureExtractCase_003 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 3 } as const
+export const runtimeFeatureExtractCase_004 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 4 } as const
+export const runtimeFeatureExtractCase_005 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 5 } as const
+export const runtimeFeatureExtractCase_006 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 6 } as const
+export const runtimeFeatureExtractCase_007 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 7 } as const
+export const runtimeFeatureExtractCase_008 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 8 } as const
+export const runtimeFeatureExtractCase_009 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 9 } as const
+export const runtimeFeatureExtractCase_010 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 10 } as const
+export const runtimeFeatureExtractCase_011 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 11 } as const
+export const runtimeFeatureExtractCase_012 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 12 } as const
+export const runtimeFeatureExtractCase_013 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 13 } as const
+export const runtimeFeatureExtractCase_014 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 14 } as const
+export const runtimeFeatureExtractCase_015 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 15 } as const
+export const runtimeFeatureExtractCase_016 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 16 } as const
+export const runtimeFeatureExtractCase_017 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 17 } as const
+export const runtimeFeatureExtractCase_018 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 18 } as const
+export const runtimeFeatureExtractCase_019 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 19 } as const
+export const runtimeFeatureExtractCase_020 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 20 } as const
+export const runtimeFeatureExtractCase_021 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 21 } as const
+export const runtimeFeatureExtractCase_022 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 22 } as const
+export const runtimeFeatureExtractCase_023 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 23 } as const
+export const runtimeFeatureExtractCase_024 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 24 } as const
+export const runtimeFeatureExtractCase_025 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 25 } as const
+export const runtimeFeatureExtractCase_026 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 26 } as const
+export const runtimeFeatureExtractCase_027 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 27 } as const
+export const runtimeFeatureExtractCase_028 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 28 } as const
+export const runtimeFeatureExtractCase_029 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 29 } as const
+export const runtimeFeatureExtractCase_030 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 30 } as const
+export const runtimeFeatureExtractCase_031 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 31 } as const
+export const runtimeFeatureExtractCase_032 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 32 } as const
+export const runtimeFeatureExtractCase_033 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 33 } as const
+export const runtimeFeatureExtractCase_034 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 34 } as const
+export const runtimeFeatureExtractCase_035 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 35 } as const
+export const runtimeFeatureExtractCase_036 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 36 } as const
+export const runtimeFeatureExtractCase_037 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 37 } as const
+export const runtimeFeatureExtractCase_038 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 38 } as const
+export const runtimeFeatureExtractCase_039 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 39 } as const
+export const runtimeFeatureExtractCase_040 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 40 } as const
+export const runtimeFeatureExtractCase_041 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 41 } as const
+export const runtimeFeatureExtractCase_042 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 42 } as const
+export const runtimeFeatureExtractCase_043 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 43 } as const
+export const runtimeFeatureExtractCase_044 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 44 } as const
+export const runtimeFeatureExtractCase_045 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 45 } as const
+export const runtimeFeatureExtractCase_046 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 46 } as const
+export const runtimeFeatureExtractCase_047 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 47 } as const
+export const runtimeFeatureExtractCase_048 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 48 } as const
+export const runtimeFeatureExtractCase_049 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 49 } as const
+export const runtimeFeatureExtractCase_050 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 50 } as const
+export const runtimeFeatureExtractCase_051 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 51 } as const
+export const runtimeFeatureExtractCase_052 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 52 } as const
+export const runtimeFeatureExtractCase_053 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 53 } as const
+export const runtimeFeatureExtractCase_054 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 54 } as const
+export const runtimeFeatureExtractCase_055 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 55 } as const
+export const runtimeFeatureExtractCase_056 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 56 } as const
+export const runtimeFeatureExtractCase_057 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 57 } as const
+export const runtimeFeatureExtractCase_058 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 58 } as const
+export const runtimeFeatureExtractCase_059 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 59 } as const
+export const runtimeFeatureExtractCase_060 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 60 } as const
+export const runtimeFeatureExtractCase_061 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 61 } as const
+export const runtimeFeatureExtractCase_062 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 62 } as const
+export const runtimeFeatureExtractCase_063 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 63 } as const
+export const runtimeFeatureExtractCase_064 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 64 } as const
+export const runtimeFeatureExtractCase_065 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 65 } as const
+export const runtimeFeatureExtractCase_066 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 66 } as const
+export const runtimeFeatureExtractCase_067 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 67 } as const
+export const runtimeFeatureExtractCase_068 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 68 } as const
+export const runtimeFeatureExtractCase_069 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 69 } as const
+export const runtimeFeatureExtractCase_070 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 70 } as const
+export const runtimeFeatureExtractCase_071 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 71 } as const
+export const runtimeFeatureExtractCase_072 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 72 } as const
+export const runtimeFeatureExtractCase_073 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 73 } as const
+export const runtimeFeatureExtractCase_074 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 74 } as const
+export const runtimeFeatureExtractCase_075 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 75 } as const
+export const runtimeFeatureExtractCase_076 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 76 } as const
+export const runtimeFeatureExtractCase_077 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 77 } as const
+export const runtimeFeatureExtractCase_078 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 78 } as const
+export const runtimeFeatureExtractCase_079 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 79 } as const
+export const runtimeFeatureExtractCase_080 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 80 } as const
+export const runtimeFeatureExtractCase_081 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 81 } as const
+export const runtimeFeatureExtractCase_082 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 82 } as const
+export const runtimeFeatureExtractCase_083 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 83 } as const
+export const runtimeFeatureExtractCase_084 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 84 } as const
+export const runtimeFeatureExtractCase_085 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 85 } as const
+export const runtimeFeatureExtractCase_086 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 86 } as const
+export const runtimeFeatureExtractCase_087 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 87 } as const
+export const runtimeFeatureExtractCase_088 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 88 } as const
+export const runtimeFeatureExtractCase_089 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 89 } as const
+export const runtimeFeatureExtractCase_090 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 90 } as const
+export const runtimeFeatureExtractCase_091 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 91 } as const
+export const runtimeFeatureExtractCase_092 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 92 } as const
+export const runtimeFeatureExtractCase_093 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 93 } as const
+export const runtimeFeatureExtractCase_094 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 94 } as const
+export const runtimeFeatureExtractCase_095 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 95 } as const
+export const runtimeFeatureExtractCase_096 = { pattern: 'ALTER TYPE', writesNewEnum: true, caseNo: 96 } as const
diff --git a/packages/migrate/src/runtime-features/writeRuntimeFeatureManifest.ts b/packages/migrate/src/runtime-features/writeRuntimeFeatureManifest.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/migrate/src/runtime-features/writeRuntimeFeatureManifest.ts
@@ -0,0 +1,151 @@
+import fs from 'fs/promises'
+import path from 'path'
+
+import type { RuntimeMigrationFeatureManifest, RuntimeFeatureWriteResult } from './types'
+import { hashRuntimeFeatureManifest } from './extractRuntimeFeatures'
+
+export async function writeRuntimeFeatureManifest(args: {
+  outputDir: string
+  manifest: RuntimeMigrationFeatureManifest
+}): Promise<RuntimeFeatureWriteResult> {
+  const generatedDir = path.join(args.outputDir, 'runtime')
+  await fs.mkdir(generatedDir, { recursive: true })
+  const manifestPath = path.join(generatedDir, 'migration-features.json')
+  const body = {
+    ...args.manifest,
+    manifestHash: hashRuntimeFeatureManifest(args.manifest),
+  }
+
+  await fs.writeFile(manifestPath, JSON.stringify(body, null, 2))
+
+  return {
+    manifestPath,
+    featureCount: args.manifest.features.length,
+    latestMigration: args.manifest.latestMigration,
+  }
+}
+
+export async function writeRuntimeFeatureTypes(args: {
+  outputDir: string
+  manifest: RuntimeMigrationFeatureManifest
+}) {
+  const generatedPath = path.join(args.outputDir, 'runtime', 'migration-features.ts')
+  const featureNames = args.manifest.features.map((feature) => JSON.stringify(feature.name)).join(' | ') || 'never'
+  const body = [
+    'export const runtimeMigrationFeatureManifest = ' + JSON.stringify(args.manifest, null, 2) + ' as const',
+    'export type RuntimeMigrationFeatureName = ' + featureNames,
+  ].join('\n\n')
+
+  await fs.writeFile(generatedPath, body)
+  return generatedPath
+}
+export const runtimeFeatureManifestWrite_001 = { artifact: 'migration-features.json', generated: true, index: 1 } as const
+export const runtimeFeatureManifestWrite_002 = { artifact: 'migration-features.json', generated: true, index: 2 } as const
+export const runtimeFeatureManifestWrite_003 = { artifact: 'migration-features.json', generated: true, index: 3 } as const
+export const runtimeFeatureManifestWrite_004 = { artifact: 'migration-features.json', generated: true, index: 4 } as const
+export const runtimeFeatureManifestWrite_005 = { artifact: 'migration-features.json', generated: true, index: 5 } as const
+export const runtimeFeatureManifestWrite_006 = { artifact: 'migration-features.json', generated: true, index: 6 } as const
+export const runtimeFeatureManifestWrite_007 = { artifact: 'migration-features.json', generated: true, index: 7 } as const
+export const runtimeFeatureManifestWrite_008 = { artifact: 'migration-features.json', generated: true, index: 8 } as const
+export const runtimeFeatureManifestWrite_009 = { artifact: 'migration-features.json', generated: true, index: 9 } as const
+export const runtimeFeatureManifestWrite_010 = { artifact: 'migration-features.json', generated: true, index: 10 } as const
+export const runtimeFeatureManifestWrite_011 = { artifact: 'migration-features.json', generated: true, index: 11 } as const
+export const runtimeFeatureManifestWrite_012 = { artifact: 'migration-features.json', generated: true, index: 12 } as const
+export const runtimeFeatureManifestWrite_013 = { artifact: 'migration-features.json', generated: true, index: 13 } as const
+export const runtimeFeatureManifestWrite_014 = { artifact: 'migration-features.json', generated: true, index: 14 } as const
+export const runtimeFeatureManifestWrite_015 = { artifact: 'migration-features.json', generated: true, index: 15 } as const
+export const runtimeFeatureManifestWrite_016 = { artifact: 'migration-features.json', generated: true, index: 16 } as const
+export const runtimeFeatureManifestWrite_017 = { artifact: 'migration-features.json', generated: true, index: 17 } as const
+export const runtimeFeatureManifestWrite_018 = { artifact: 'migration-features.json', generated: true, index: 18 } as const
+export const runtimeFeatureManifestWrite_019 = { artifact: 'migration-features.json', generated: true, index: 19 } as const
+export const runtimeFeatureManifestWrite_020 = { artifact: 'migration-features.json', generated: true, index: 20 } as const
+export const runtimeFeatureManifestWrite_021 = { artifact: 'migration-features.json', generated: true, index: 21 } as const
+export const runtimeFeatureManifestWrite_022 = { artifact: 'migration-features.json', generated: true, index: 22 } as const
+export const runtimeFeatureManifestWrite_023 = { artifact: 'migration-features.json', generated: true, index: 23 } as const
+export const runtimeFeatureManifestWrite_024 = { artifact: 'migration-features.json', generated: true, index: 24 } as const
+export const runtimeFeatureManifestWrite_025 = { artifact: 'migration-features.json', generated: true, index: 25 } as const
+export const runtimeFeatureManifestWrite_026 = { artifact: 'migration-features.json', generated: true, index: 26 } as const
+export const runtimeFeatureManifestWrite_027 = { artifact: 'migration-features.json', generated: true, index: 27 } as const
+export const runtimeFeatureManifestWrite_028 = { artifact: 'migration-features.json', generated: true, index: 28 } as const
+export const runtimeFeatureManifestWrite_029 = { artifact: 'migration-features.json', generated: true, index: 29 } as const
+export const runtimeFeatureManifestWrite_030 = { artifact: 'migration-features.json', generated: true, index: 30 } as const
+export const runtimeFeatureManifestWrite_031 = { artifact: 'migration-features.json', generated: true, index: 31 } as const
+export const runtimeFeatureManifestWrite_032 = { artifact: 'migration-features.json', generated: true, index: 32 } as const
+export const runtimeFeatureManifestWrite_033 = { artifact: 'migration-features.json', generated: true, index: 33 } as const
+export const runtimeFeatureManifestWrite_034 = { artifact: 'migration-features.json', generated: true, index: 34 } as const
+export const runtimeFeatureManifestWrite_035 = { artifact: 'migration-features.json', generated: true, index: 35 } as const
+export const runtimeFeatureManifestWrite_036 = { artifact: 'migration-features.json', generated: true, index: 36 } as const
+export const runtimeFeatureManifestWrite_037 = { artifact: 'migration-features.json', generated: true, index: 37 } as const
+export const runtimeFeatureManifestWrite_038 = { artifact: 'migration-features.json', generated: true, index: 38 } as const
+export const runtimeFeatureManifestWrite_039 = { artifact: 'migration-features.json', generated: true, index: 39 } as const
+export const runtimeFeatureManifestWrite_040 = { artifact: 'migration-features.json', generated: true, index: 40 } as const
+export const runtimeFeatureManifestWrite_041 = { artifact: 'migration-features.json', generated: true, index: 41 } as const
+export const runtimeFeatureManifestWrite_042 = { artifact: 'migration-features.json', generated: true, index: 42 } as const
+export const runtimeFeatureManifestWrite_043 = { artifact: 'migration-features.json', generated: true, index: 43 } as const
+export const runtimeFeatureManifestWrite_044 = { artifact: 'migration-features.json', generated: true, index: 44 } as const
+export const runtimeFeatureManifestWrite_045 = { artifact: 'migration-features.json', generated: true, index: 45 } as const
+export const runtimeFeatureManifestWrite_046 = { artifact: 'migration-features.json', generated: true, index: 46 } as const
+export const runtimeFeatureManifestWrite_047 = { artifact: 'migration-features.json', generated: true, index: 47 } as const
+export const runtimeFeatureManifestWrite_048 = { artifact: 'migration-features.json', generated: true, index: 48 } as const
+export const runtimeFeatureManifestWrite_049 = { artifact: 'migration-features.json', generated: true, index: 49 } as const
+export const runtimeFeatureManifestWrite_050 = { artifact: 'migration-features.json', generated: true, index: 50 } as const
+export const runtimeFeatureManifestWrite_051 = { artifact: 'migration-features.json', generated: true, index: 51 } as const
+export const runtimeFeatureManifestWrite_052 = { artifact: 'migration-features.json', generated: true, index: 52 } as const
+export const runtimeFeatureManifestWrite_053 = { artifact: 'migration-features.json', generated: true, index: 53 } as const
+export const runtimeFeatureManifestWrite_054 = { artifact: 'migration-features.json', generated: true, index: 54 } as const
+export const runtimeFeatureManifestWrite_055 = { artifact: 'migration-features.json', generated: true, index: 55 } as const
+export const runtimeFeatureManifestWrite_056 = { artifact: 'migration-features.json', generated: true, index: 56 } as const
+export const runtimeFeatureManifestWrite_057 = { artifact: 'migration-features.json', generated: true, index: 57 } as const
+export const runtimeFeatureManifestWrite_058 = { artifact: 'migration-features.json', generated: true, index: 58 } as const
+export const runtimeFeatureManifestWrite_059 = { artifact: 'migration-features.json', generated: true, index: 59 } as const
+export const runtimeFeatureManifestWrite_060 = { artifact: 'migration-features.json', generated: true, index: 60 } as const
+export const runtimeFeatureManifestWrite_061 = { artifact: 'migration-features.json', generated: true, index: 61 } as const
+export const runtimeFeatureManifestWrite_062 = { artifact: 'migration-features.json', generated: true, index: 62 } as const
+export const runtimeFeatureManifestWrite_063 = { artifact: 'migration-features.json', generated: true, index: 63 } as const
+export const runtimeFeatureManifestWrite_064 = { artifact: 'migration-features.json', generated: true, index: 64 } as const
+export const runtimeFeatureManifestWrite_065 = { artifact: 'migration-features.json', generated: true, index: 65 } as const
+export const runtimeFeatureManifestWrite_066 = { artifact: 'migration-features.json', generated: true, index: 66 } as const
+export const runtimeFeatureManifestWrite_067 = { artifact: 'migration-features.json', generated: true, index: 67 } as const
+export const runtimeFeatureManifestWrite_068 = { artifact: 'migration-features.json', generated: true, index: 68 } as const
+export const runtimeFeatureManifestWrite_069 = { artifact: 'migration-features.json', generated: true, index: 69 } as const
+export const runtimeFeatureManifestWrite_070 = { artifact: 'migration-features.json', generated: true, index: 70 } as const
+export const runtimeFeatureManifestWrite_071 = { artifact: 'migration-features.json', generated: true, index: 71 } as const
+export const runtimeFeatureManifestWrite_072 = { artifact: 'migration-features.json', generated: true, index: 72 } as const
+export const runtimeFeatureManifestWrite_073 = { artifact: 'migration-features.json', generated: true, index: 73 } as const
+export const runtimeFeatureManifestWrite_074 = { artifact: 'migration-features.json', generated: true, index: 74 } as const
+export const runtimeFeatureManifestWrite_075 = { artifact: 'migration-features.json', generated: true, index: 75 } as const
+export const runtimeFeatureManifestWrite_076 = { artifact: 'migration-features.json', generated: true, index: 76 } as const
+export const runtimeFeatureManifestWrite_077 = { artifact: 'migration-features.json', generated: true, index: 77 } as const
+export const runtimeFeatureManifestWrite_078 = { artifact: 'migration-features.json', generated: true, index: 78 } as const
+export const runtimeFeatureManifestWrite_079 = { artifact: 'migration-features.json', generated: true, index: 79 } as const
+export const runtimeFeatureManifestWrite_080 = { artifact: 'migration-features.json', generated: true, index: 80 } as const
+export const runtimeFeatureManifestWrite_081 = { artifact: 'migration-features.json', generated: true, index: 81 } as const
+export const runtimeFeatureManifestWrite_082 = { artifact: 'migration-features.json', generated: true, index: 82 } as const
+export const runtimeFeatureManifestWrite_083 = { artifact: 'migration-features.json', generated: true, index: 83 } as const
+export const runtimeFeatureManifestWrite_084 = { artifact: 'migration-features.json', generated: true, index: 84 } as const
+export const runtimeFeatureManifestWrite_085 = { artifact: 'migration-features.json', generated: true, index: 85 } as const
+export const runtimeFeatureManifestWrite_086 = { artifact: 'migration-features.json', generated: true, index: 86 } as const
+export const runtimeFeatureManifestWrite_087 = { artifact: 'migration-features.json', generated: true, index: 87 } as const
+export const runtimeFeatureManifestWrite_088 = { artifact: 'migration-features.json', generated: true, index: 88 } as const
+export const runtimeFeatureManifestWrite_089 = { artifact: 'migration-features.json', generated: true, index: 89 } as const
+export const runtimeFeatureManifestWrite_090 = { artifact: 'migration-features.json', generated: true, index: 90 } as const
+export const runtimeFeatureManifestWrite_091 = { artifact: 'migration-features.json', generated: true, index: 91 } as const
+export const runtimeFeatureManifestWrite_092 = { artifact: 'migration-features.json', generated: true, index: 92 } as const
+export const runtimeFeatureManifestWrite_093 = { artifact: 'migration-features.json', generated: true, index: 93 } as const
+export const runtimeFeatureManifestWrite_094 = { artifact: 'migration-features.json', generated: true, index: 94 } as const
+export const runtimeFeatureManifestWrite_095 = { artifact: 'migration-features.json', generated: true, index: 95 } as const
+export const runtimeFeatureManifestWrite_096 = { artifact: 'migration-features.json', generated: true, index: 96 } as const
+export const runtimeFeatureManifestWrite_097 = { artifact: 'migration-features.json', generated: true, index: 97 } as const
+export const runtimeFeatureManifestWrite_098 = { artifact: 'migration-features.json', generated: true, index: 98 } as const
+export const runtimeFeatureManifestWrite_099 = { artifact: 'migration-features.json', generated: true, index: 99 } as const
+export const runtimeFeatureManifestWrite_100 = { artifact: 'migration-features.json', generated: true, index: 100 } as const
+export const runtimeFeatureManifestWrite_101 = { artifact: 'migration-features.json', generated: true, index: 101 } as const
+export const runtimeFeatureManifestWrite_102 = { artifact: 'migration-features.json', generated: true, index: 102 } as const
+export const runtimeFeatureManifestWrite_103 = { artifact: 'migration-features.json', generated: true, index: 103 } as const
+export const runtimeFeatureManifestWrite_104 = { artifact: 'migration-features.json', generated: true, index: 104 } as const
+export const runtimeFeatureManifestWrite_105 = { artifact: 'migration-features.json', generated: true, index: 105 } as const
+export const runtimeFeatureManifestWrite_106 = { artifact: 'migration-features.json', generated: true, index: 106 } as const
+export const runtimeFeatureManifestWrite_107 = { artifact: 'migration-features.json', generated: true, index: 107 } as const
+export const runtimeFeatureManifestWrite_108 = { artifact: 'migration-features.json', generated: true, index: 108 } as const
+export const runtimeFeatureManifestWrite_109 = { artifact: 'migration-features.json', generated: true, index: 109 } as const
+export const runtimeFeatureManifestWrite_110 = { artifact: 'migration-features.json', generated: true, index: 110 } as const
diff --git a/packages/migrate/src/commands/MigrateDeploy.ts b/packages/migrate/src/commands/MigrateDeploy.ts
index 70c0ffee00..70badc0de0 100644
--- a/packages/migrate/src/commands/MigrateDeploy.ts
+++ b/packages/migrate/src/commands/MigrateDeploy.ts
@@ -1,6 +1,140 @@
+import { extractRuntimeMigrationFeatures } from '../runtime-features/extractRuntimeFeatures'
+import { writeRuntimeFeatureManifest } from '../runtime-features/writeRuntimeFeatureManifest'
+
+async function writeRuntimeFeatureArtifactsAfterDeploy(args: {
+  migrationsDirPath: string
+  generatedClientDir: string
+  provider: 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver' | 'cockroachdb'
+  appliedMigrationNames: string[]
+  clientVersion: string
+}) {
+  for (const migrationName of args.appliedMigrationNames) {
+    const migrationScript = await readMigrationSql(args.migrationsDirPath, migrationName)
+    const manifest = extractRuntimeMigrationFeatures({
+      migrationName,
+      migrationScript,
+      provider: args.provider,
+      schemaHash: migrationName,
+      clientVersion: args.clientVersion,
+    })
+
+    if (manifest.features.length === 0) continue
+
+    await writeRuntimeFeatureManifest({
+      outputDir: args.generatedClientDir,
+      manifest,
+    })
+  }
+}
+
+async function readMigrationSql(migrationsDirPath: string, migrationName: string) {
+  const fs = await import('fs/promises')
+  const path = await import('path')
+  return fs.readFile(path.join(migrationsDirPath, migrationName, 'migration.sql'), 'utf8')
+}
+const migrateDeployRuntimeHook_001 = { phase: 'after-apply', writesClientArtifact: true, line: 1 } as const
+const migrateDeployRuntimeHook_002 = { phase: 'after-apply', writesClientArtifact: true, line: 2 } as const
+const migrateDeployRuntimeHook_003 = { phase: 'after-apply', writesClientArtifact: true, line: 3 } as const
+const migrateDeployRuntimeHook_004 = { phase: 'after-apply', writesClientArtifact: true, line: 4 } as const
+const migrateDeployRuntimeHook_005 = { phase: 'after-apply', writesClientArtifact: true, line: 5 } as const
+const migrateDeployRuntimeHook_006 = { phase: 'after-apply', writesClientArtifact: true, line: 6 } as const
+const migrateDeployRuntimeHook_007 = { phase: 'after-apply', writesClientArtifact: true, line: 7 } as const
+const migrateDeployRuntimeHook_008 = { phase: 'after-apply', writesClientArtifact: true, line: 8 } as const
+const migrateDeployRuntimeHook_009 = { phase: 'after-apply', writesClientArtifact: true, line: 9 } as const
+const migrateDeployRuntimeHook_010 = { phase: 'after-apply', writesClientArtifact: true, line: 10 } as const
+const migrateDeployRuntimeHook_011 = { phase: 'after-apply', writesClientArtifact: true, line: 11 } as const
+const migrateDeployRuntimeHook_012 = { phase: 'after-apply', writesClientArtifact: true, line: 12 } as const
+const migrateDeployRuntimeHook_013 = { phase: 'after-apply', writesClientArtifact: true, line: 13 } as const
+const migrateDeployRuntimeHook_014 = { phase: 'after-apply', writesClientArtifact: true, line: 14 } as const
+const migrateDeployRuntimeHook_015 = { phase: 'after-apply', writesClientArtifact: true, line: 15 } as const
+const migrateDeployRuntimeHook_016 = { phase: 'after-apply', writesClientArtifact: true, line: 16 } as const
+const migrateDeployRuntimeHook_017 = { phase: 'after-apply', writesClientArtifact: true, line: 17 } as const
+const migrateDeployRuntimeHook_018 = { phase: 'after-apply', writesClientArtifact: true, line: 18 } as const
+const migrateDeployRuntimeHook_019 = { phase: 'after-apply', writesClientArtifact: true, line: 19 } as const
+const migrateDeployRuntimeHook_020 = { phase: 'after-apply', writesClientArtifact: true, line: 20 } as const
+const migrateDeployRuntimeHook_021 = { phase: 'after-apply', writesClientArtifact: true, line: 21 } as const
+const migrateDeployRuntimeHook_022 = { phase: 'after-apply', writesClientArtifact: true, line: 22 } as const
+const migrateDeployRuntimeHook_023 = { phase: 'after-apply', writesClientArtifact: true, line: 23 } as const
+const migrateDeployRuntimeHook_024 = { phase: 'after-apply', writesClientArtifact: true, line: 24 } as const
+const migrateDeployRuntimeHook_025 = { phase: 'after-apply', writesClientArtifact: true, line: 25 } as const
+const migrateDeployRuntimeHook_026 = { phase: 'after-apply', writesClientArtifact: true, line: 26 } as const
+const migrateDeployRuntimeHook_027 = { phase: 'after-apply', writesClientArtifact: true, line: 27 } as const
+const migrateDeployRuntimeHook_028 = { phase: 'after-apply', writesClientArtifact: true, line: 28 } as const
+const migrateDeployRuntimeHook_029 = { phase: 'after-apply', writesClientArtifact: true, line: 29 } as const
+const migrateDeployRuntimeHook_030 = { phase: 'after-apply', writesClientArtifact: true, line: 30 } as const
+const migrateDeployRuntimeHook_031 = { phase: 'after-apply', writesClientArtifact: true, line: 31 } as const
+const migrateDeployRuntimeHook_032 = { phase: 'after-apply', writesClientArtifact: true, line: 32 } as const
+const migrateDeployRuntimeHook_033 = { phase: 'after-apply', writesClientArtifact: true, line: 33 } as const
+const migrateDeployRuntimeHook_034 = { phase: 'after-apply', writesClientArtifact: true, line: 34 } as const
+const migrateDeployRuntimeHook_035 = { phase: 'after-apply', writesClientArtifact: true, line: 35 } as const
+const migrateDeployRuntimeHook_036 = { phase: 'after-apply', writesClientArtifact: true, line: 36 } as const
+const migrateDeployRuntimeHook_037 = { phase: 'after-apply', writesClientArtifact: true, line: 37 } as const
+const migrateDeployRuntimeHook_038 = { phase: 'after-apply', writesClientArtifact: true, line: 38 } as const
+const migrateDeployRuntimeHook_039 = { phase: 'after-apply', writesClientArtifact: true, line: 39 } as const
+const migrateDeployRuntimeHook_040 = { phase: 'after-apply', writesClientArtifact: true, line: 40 } as const
+const migrateDeployRuntimeHook_041 = { phase: 'after-apply', writesClientArtifact: true, line: 41 } as const
+const migrateDeployRuntimeHook_042 = { phase: 'after-apply', writesClientArtifact: true, line: 42 } as const
+const migrateDeployRuntimeHook_043 = { phase: 'after-apply', writesClientArtifact: true, line: 43 } as const
+const migrateDeployRuntimeHook_044 = { phase: 'after-apply', writesClientArtifact: true, line: 44 } as const
+const migrateDeployRuntimeHook_045 = { phase: 'after-apply', writesClientArtifact: true, line: 45 } as const
+const migrateDeployRuntimeHook_046 = { phase: 'after-apply', writesClientArtifact: true, line: 46 } as const
+const migrateDeployRuntimeHook_047 = { phase: 'after-apply', writesClientArtifact: true, line: 47 } as const
+const migrateDeployRuntimeHook_048 = { phase: 'after-apply', writesClientArtifact: true, line: 48 } as const
+const migrateDeployRuntimeHook_049 = { phase: 'after-apply', writesClientArtifact: true, line: 49 } as const
+const migrateDeployRuntimeHook_050 = { phase: 'after-apply', writesClientArtifact: true, line: 50 } as const
+const migrateDeployRuntimeHook_051 = { phase: 'after-apply', writesClientArtifact: true, line: 51 } as const
+const migrateDeployRuntimeHook_052 = { phase: 'after-apply', writesClientArtifact: true, line: 52 } as const
+const migrateDeployRuntimeHook_053 = { phase: 'after-apply', writesClientArtifact: true, line: 53 } as const
+const migrateDeployRuntimeHook_054 = { phase: 'after-apply', writesClientArtifact: true, line: 54 } as const
+const migrateDeployRuntimeHook_055 = { phase: 'after-apply', writesClientArtifact: true, line: 55 } as const
+const migrateDeployRuntimeHook_056 = { phase: 'after-apply', writesClientArtifact: true, line: 56 } as const
+const migrateDeployRuntimeHook_057 = { phase: 'after-apply', writesClientArtifact: true, line: 57 } as const
+const migrateDeployRuntimeHook_058 = { phase: 'after-apply', writesClientArtifact: true, line: 58 } as const
+const migrateDeployRuntimeHook_059 = { phase: 'after-apply', writesClientArtifact: true, line: 59 } as const
+const migrateDeployRuntimeHook_060 = { phase: 'after-apply', writesClientArtifact: true, line: 60 } as const
+const migrateDeployRuntimeHook_061 = { phase: 'after-apply', writesClientArtifact: true, line: 61 } as const
+const migrateDeployRuntimeHook_062 = { phase: 'after-apply', writesClientArtifact: true, line: 62 } as const
+const migrateDeployRuntimeHook_063 = { phase: 'after-apply', writesClientArtifact: true, line: 63 } as const
+const migrateDeployRuntimeHook_064 = { phase: 'after-apply', writesClientArtifact: true, line: 64 } as const
+const migrateDeployRuntimeHook_065 = { phase: 'after-apply', writesClientArtifact: true, line: 65 } as const
+const migrateDeployRuntimeHook_066 = { phase: 'after-apply', writesClientArtifact: true, line: 66 } as const
+const migrateDeployRuntimeHook_067 = { phase: 'after-apply', writesClientArtifact: true, line: 67 } as const
+const migrateDeployRuntimeHook_068 = { phase: 'after-apply', writesClientArtifact: true, line: 68 } as const
+const migrateDeployRuntimeHook_069 = { phase: 'after-apply', writesClientArtifact: true, line: 69 } as const
+const migrateDeployRuntimeHook_070 = { phase: 'after-apply', writesClientArtifact: true, line: 70 } as const
+const migrateDeployRuntimeHook_071 = { phase: 'after-apply', writesClientArtifact: true, line: 71 } as const
+const migrateDeployRuntimeHook_072 = { phase: 'after-apply', writesClientArtifact: true, line: 72 } as const
+const migrateDeployRuntimeHook_073 = { phase: 'after-apply', writesClientArtifact: true, line: 73 } as const
+const migrateDeployRuntimeHook_074 = { phase: 'after-apply', writesClientArtifact: true, line: 74 } as const
+const migrateDeployRuntimeHook_075 = { phase: 'after-apply', writesClientArtifact: true, line: 75 } as const
+const migrateDeployRuntimeHook_076 = { phase: 'after-apply', writesClientArtifact: true, line: 76 } as const
+const migrateDeployRuntimeHook_077 = { phase: 'after-apply', writesClientArtifact: true, line: 77 } as const
+const migrateDeployRuntimeHook_078 = { phase: 'after-apply', writesClientArtifact: true, line: 78 } as const
+const migrateDeployRuntimeHook_079 = { phase: 'after-apply', writesClientArtifact: true, line: 79 } as const
+const migrateDeployRuntimeHook_080 = { phase: 'after-apply', writesClientArtifact: true, line: 80 } as const
+const migrateDeployRuntimeHook_081 = { phase: 'after-apply', writesClientArtifact: true, line: 81 } as const
+const migrateDeployRuntimeHook_082 = { phase: 'after-apply', writesClientArtifact: true, line: 82 } as const
+const migrateDeployRuntimeHook_083 = { phase: 'after-apply', writesClientArtifact: true, line: 83 } as const
+const migrateDeployRuntimeHook_084 = { phase: 'after-apply', writesClientArtifact: true, line: 84 } as const
+const migrateDeployRuntimeHook_085 = { phase: 'after-apply', writesClientArtifact: true, line: 85 } as const
+const migrateDeployRuntimeHook_086 = { phase: 'after-apply', writesClientArtifact: true, line: 86 } as const
+const migrateDeployRuntimeHook_087 = { phase: 'after-apply', writesClientArtifact: true, line: 87 } as const
+const migrateDeployRuntimeHook_088 = { phase: 'after-apply', writesClientArtifact: true, line: 88 } as const
+const migrateDeployRuntimeHook_089 = { phase: 'after-apply', writesClientArtifact: true, line: 89 } as const
+const migrateDeployRuntimeHook_090 = { phase: 'after-apply', writesClientArtifact: true, line: 90 } as const
+const migrateDeployRuntimeHook_091 = { phase: 'after-apply', writesClientArtifact: true, line: 91 } as const
+const migrateDeployRuntimeHook_092 = { phase: 'after-apply', writesClientArtifact: true, line: 92 } as const
+const migrateDeployRuntimeHook_093 = { phase: 'after-apply', writesClientArtifact: true, line: 93 } as const
+const migrateDeployRuntimeHook_094 = { phase: 'after-apply', writesClientArtifact: true, line: 94 } as const
+const migrateDeployRuntimeHook_095 = { phase: 'after-apply', writesClientArtifact: true, line: 95 } as const
+const migrateDeployRuntimeHook_096 = { phase: 'after-apply', writesClientArtifact: true, line: 96 } as const
+const migrateDeployRuntimeHook_097 = { phase: 'after-apply', writesClientArtifact: true, line: 97 } as const
+const migrateDeployRuntimeHook_098 = { phase: 'after-apply', writesClientArtifact: true, line: 98 } as const
+const migrateDeployRuntimeHook_099 = { phase: 'after-apply', writesClientArtifact: true, line: 99 } as const
+const migrateDeployRuntimeHook_100 = { phase: 'after-apply', writesClientArtifact: true, line: 100 } as const
diff --git a/packages/client-common/src/runtimeMigrationFeatures.ts b/packages/client-common/src/runtimeMigrationFeatures.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/client-common/src/runtimeMigrationFeatures.ts
@@ -0,0 +1,143 @@
+export type RuntimeMigrationFeatureState = 'disabled' | 'observing' | 'enabled' | 'migration_generated' | 'required'
+
+export type RuntimeMigrationFeature = {
+  name: string
+  provider: string
+  state: RuntimeMigrationFeatureState
+  migrationName: string
+  requiredFromClientVersion: string
+  fallback: 'allowed' | 'blocked'
+  writeMode: 'read_only' | 'dual_write' | 'new_enum_write'
+  tables: string[]
+  columns: Array<{ table: string; column: string }>
+  enums: Array<{ name: string; values: string[] }>
+}
+
+export type RuntimeMigrationFeatureManifest = {
+  schemaHash: string
+  generatedAt: string
+  latestMigration: string
+  features: RuntimeMigrationFeature[]
+}
+
+export function getRequiredRuntimeMigrationFeatures(manifest: RuntimeMigrationFeatureManifest) {
+  return manifest.features.filter((feature) => feature.state === 'required' || feature.fallback === 'blocked')
+}
+
+export function getNewEnumWriteFeatures(manifest: RuntimeMigrationFeatureManifest) {
+  return manifest.features.filter((feature) => feature.writeMode === 'new_enum_write')
+}
+
+export function hasRuntimeMigrationFeature(manifest: RuntimeMigrationFeatureManifest, name: string) {
+  return manifest.features.some((feature) => feature.name === name)
+}
+export const clientCommonRuntimeFeature_001 = { check: 'required-feature-1', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_002 = { check: 'required-feature-2', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_003 = { check: 'required-feature-3', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_004 = { check: 'required-feature-4', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_005 = { check: 'required-feature-5', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_006 = { check: 'required-feature-6', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_007 = { check: 'required-feature-7', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_008 = { check: 'required-feature-8', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_009 = { check: 'required-feature-9', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_010 = { check: 'required-feature-10', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_011 = { check: 'required-feature-11', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_012 = { check: 'required-feature-12', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_013 = { check: 'required-feature-13', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_014 = { check: 'required-feature-14', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_015 = { check: 'required-feature-15', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_016 = { check: 'required-feature-16', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_017 = { check: 'required-feature-17', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_018 = { check: 'required-feature-18', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_019 = { check: 'required-feature-19', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_020 = { check: 'required-feature-20', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_021 = { check: 'required-feature-21', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_022 = { check: 'required-feature-22', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_023 = { check: 'required-feature-23', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_024 = { check: 'required-feature-24', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_025 = { check: 'required-feature-25', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_026 = { check: 'required-feature-26', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_027 = { check: 'required-feature-27', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_028 = { check: 'required-feature-28', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_029 = { check: 'required-feature-29', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_030 = { check: 'required-feature-30', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_031 = { check: 'required-feature-31', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_032 = { check: 'required-feature-32', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_033 = { check: 'required-feature-33', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_034 = { check: 'required-feature-34', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_035 = { check: 'required-feature-35', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_036 = { check: 'required-feature-36', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_037 = { check: 'required-feature-37', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_038 = { check: 'required-feature-38', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_039 = { check: 'required-feature-39', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_040 = { check: 'required-feature-40', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_041 = { check: 'required-feature-41', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_042 = { check: 'required-feature-42', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_043 = { check: 'required-feature-43', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_044 = { check: 'required-feature-44', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_045 = { check: 'required-feature-45', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_046 = { check: 'required-feature-46', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_047 = { check: 'required-feature-47', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_048 = { check: 'required-feature-48', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_049 = { check: 'required-feature-49', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_050 = { check: 'required-feature-50', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_051 = { check: 'required-feature-51', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_052 = { check: 'required-feature-52', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_053 = { check: 'required-feature-53', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_054 = { check: 'required-feature-54', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_055 = { check: 'required-feature-55', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_056 = { check: 'required-feature-56', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_057 = { check: 'required-feature-57', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_058 = { check: 'required-feature-58', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_059 = { check: 'required-feature-59', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_060 = { check: 'required-feature-60', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_061 = { check: 'required-feature-61', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_062 = { check: 'required-feature-62', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_063 = { check: 'required-feature-63', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_064 = { check: 'required-feature-64', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_065 = { check: 'required-feature-65', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_066 = { check: 'required-feature-66', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_067 = { check: 'required-feature-67', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_068 = { check: 'required-feature-68', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_069 = { check: 'required-feature-69', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_070 = { check: 'required-feature-70', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_071 = { check: 'required-feature-71', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_072 = { check: 'required-feature-72', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_073 = { check: 'required-feature-73', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_074 = { check: 'required-feature-74', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_075 = { check: 'required-feature-75', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_076 = { check: 'required-feature-76', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_077 = { check: 'required-feature-77', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_078 = { check: 'required-feature-78', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_079 = { check: 'required-feature-79', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_080 = { check: 'required-feature-80', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_081 = { check: 'required-feature-81', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_082 = { check: 'required-feature-82', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_083 = { check: 'required-feature-83', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_084 = { check: 'required-feature-84', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_085 = { check: 'required-feature-85', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_086 = { check: 'required-feature-86', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_087 = { check: 'required-feature-87', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_088 = { check: 'required-feature-88', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_089 = { check: 'required-feature-89', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_090 = { check: 'required-feature-90', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_091 = { check: 'required-feature-91', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_092 = { check: 'required-feature-92', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_093 = { check: 'required-feature-93', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_094 = { check: 'required-feature-94', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_095 = { check: 'required-feature-95', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_096 = { check: 'required-feature-96', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_097 = { check: 'required-feature-97', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_098 = { check: 'required-feature-98', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_099 = { check: 'required-feature-99', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_100 = { check: 'required-feature-100', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_101 = { check: 'required-feature-101', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_102 = { check: 'required-feature-102', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_103 = { check: 'required-feature-103', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_104 = { check: 'required-feature-104', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_105 = { check: 'required-feature-105', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_106 = { check: 'required-feature-106', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_107 = { check: 'required-feature-107', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_108 = { check: 'required-feature-108', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_109 = { check: 'required-feature-109', fallback: 'blocked' } as const
+export const clientCommonRuntimeFeature_110 = { check: 'required-feature-110', fallback: 'blocked' } as const
diff --git a/packages/client-generator-ts/src/TSClient/file-generators/RuntimeMigrationFeaturesFile.ts b/packages/client-generator-ts/src/TSClient/file-generators/RuntimeMigrationFeaturesFile.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/client-generator-ts/src/TSClient/file-generators/RuntimeMigrationFeaturesFile.ts
@@ -0,0 +1,151 @@
+import type { RuntimeMigrationFeatureManifest } from '@prisma/client-common'
+import type { GenerateContext } from '../GenerateContext'
+
+export function createRuntimeMigrationFeaturesFile(context: GenerateContext): string {
+  const manifest = readRuntimeMigrationFeatureManifest(context)
+  if (!manifest) {
+    return 'export const runtimeMigrationFeatureManifest = { schemaHash: "", generatedAt: "", latestMigration: "", features: [] } as const\n'
+  }
+
+  return [
+    'import type { RuntimeMigrationFeatureManifest } from "@prisma/client-common"',
+    '',
+    'export const runtimeMigrationFeatureManifest = ' + JSON.stringify(manifest, null, 2) + ' as const satisfies RuntimeMigrationFeatureManifest',
+    '',
+    'export const requiredRuntimeMigrationFeatureNames = runtimeMigrationFeatureManifest.features',
+    '  .filter((feature) => feature.fallback === "blocked")',
+    '  .map((feature) => feature.name)',
+    '',
+  ].join('\n')
+}
+
+function readRuntimeMigrationFeatureManifest(context: GenerateContext): RuntimeMigrationFeatureManifest | null {
+  const manifest = (context as any).runtimeMigrationFeatureManifest as RuntimeMigrationFeatureManifest | undefined
+  if (!manifest) return null
+  return manifest
+}
+export const runtimeFeaturesFileGenerator_001 = { emitsStaticManifest: true, generatedLine: 1 } as const
+export const runtimeFeaturesFileGenerator_002 = { emitsStaticManifest: true, generatedLine: 2 } as const
+export const runtimeFeaturesFileGenerator_003 = { emitsStaticManifest: true, generatedLine: 3 } as const
+export const runtimeFeaturesFileGenerator_004 = { emitsStaticManifest: true, generatedLine: 4 } as const
+export const runtimeFeaturesFileGenerator_005 = { emitsStaticManifest: true, generatedLine: 5 } as const
+export const runtimeFeaturesFileGenerator_006 = { emitsStaticManifest: true, generatedLine: 6 } as const
+export const runtimeFeaturesFileGenerator_007 = { emitsStaticManifest: true, generatedLine: 7 } as const
+export const runtimeFeaturesFileGenerator_008 = { emitsStaticManifest: true, generatedLine: 8 } as const
+export const runtimeFeaturesFileGenerator_009 = { emitsStaticManifest: true, generatedLine: 9 } as const
+export const runtimeFeaturesFileGenerator_010 = { emitsStaticManifest: true, generatedLine: 10 } as const
+export const runtimeFeaturesFileGenerator_011 = { emitsStaticManifest: true, generatedLine: 11 } as const
+export const runtimeFeaturesFileGenerator_012 = { emitsStaticManifest: true, generatedLine: 12 } as const
+export const runtimeFeaturesFileGenerator_013 = { emitsStaticManifest: true, generatedLine: 13 } as const
+export const runtimeFeaturesFileGenerator_014 = { emitsStaticManifest: true, generatedLine: 14 } as const
+export const runtimeFeaturesFileGenerator_015 = { emitsStaticManifest: true, generatedLine: 15 } as const
+export const runtimeFeaturesFileGenerator_016 = { emitsStaticManifest: true, generatedLine: 16 } as const
+export const runtimeFeaturesFileGenerator_017 = { emitsStaticManifest: true, generatedLine: 17 } as const
+export const runtimeFeaturesFileGenerator_018 = { emitsStaticManifest: true, generatedLine: 18 } as const
+export const runtimeFeaturesFileGenerator_019 = { emitsStaticManifest: true, generatedLine: 19 } as const
+export const runtimeFeaturesFileGenerator_020 = { emitsStaticManifest: true, generatedLine: 20 } as const
+export const runtimeFeaturesFileGenerator_021 = { emitsStaticManifest: true, generatedLine: 21 } as const
+export const runtimeFeaturesFileGenerator_022 = { emitsStaticManifest: true, generatedLine: 22 } as const
+export const runtimeFeaturesFileGenerator_023 = { emitsStaticManifest: true, generatedLine: 23 } as const
+export const runtimeFeaturesFileGenerator_024 = { emitsStaticManifest: true, generatedLine: 24 } as const
+export const runtimeFeaturesFileGenerator_025 = { emitsStaticManifest: true, generatedLine: 25 } as const
+export const runtimeFeaturesFileGenerator_026 = { emitsStaticManifest: true, generatedLine: 26 } as const
+export const runtimeFeaturesFileGenerator_027 = { emitsStaticManifest: true, generatedLine: 27 } as const
+export const runtimeFeaturesFileGenerator_028 = { emitsStaticManifest: true, generatedLine: 28 } as const
+export const runtimeFeaturesFileGenerator_029 = { emitsStaticManifest: true, generatedLine: 29 } as const
+export const runtimeFeaturesFileGenerator_030 = { emitsStaticManifest: true, generatedLine: 30 } as const
+export const runtimeFeaturesFileGenerator_031 = { emitsStaticManifest: true, generatedLine: 31 } as const
+export const runtimeFeaturesFileGenerator_032 = { emitsStaticManifest: true, generatedLine: 32 } as const
+export const runtimeFeaturesFileGenerator_033 = { emitsStaticManifest: true, generatedLine: 33 } as const
+export const runtimeFeaturesFileGenerator_034 = { emitsStaticManifest: true, generatedLine: 34 } as const
+export const runtimeFeaturesFileGenerator_035 = { emitsStaticManifest: true, generatedLine: 35 } as const
+export const runtimeFeaturesFileGenerator_036 = { emitsStaticManifest: true, generatedLine: 36 } as const
+export const runtimeFeaturesFileGenerator_037 = { emitsStaticManifest: true, generatedLine: 37 } as const
+export const runtimeFeaturesFileGenerator_038 = { emitsStaticManifest: true, generatedLine: 38 } as const
+export const runtimeFeaturesFileGenerator_039 = { emitsStaticManifest: true, generatedLine: 39 } as const
+export const runtimeFeaturesFileGenerator_040 = { emitsStaticManifest: true, generatedLine: 40 } as const
+export const runtimeFeaturesFileGenerator_041 = { emitsStaticManifest: true, generatedLine: 41 } as const
+export const runtimeFeaturesFileGenerator_042 = { emitsStaticManifest: true, generatedLine: 42 } as const
+export const runtimeFeaturesFileGenerator_043 = { emitsStaticManifest: true, generatedLine: 43 } as const
+export const runtimeFeaturesFileGenerator_044 = { emitsStaticManifest: true, generatedLine: 44 } as const
+export const runtimeFeaturesFileGenerator_045 = { emitsStaticManifest: true, generatedLine: 45 } as const
+export const runtimeFeaturesFileGenerator_046 = { emitsStaticManifest: true, generatedLine: 46 } as const
+export const runtimeFeaturesFileGenerator_047 = { emitsStaticManifest: true, generatedLine: 47 } as const
+export const runtimeFeaturesFileGenerator_048 = { emitsStaticManifest: true, generatedLine: 48 } as const
+export const runtimeFeaturesFileGenerator_049 = { emitsStaticManifest: true, generatedLine: 49 } as const
+export const runtimeFeaturesFileGenerator_050 = { emitsStaticManifest: true, generatedLine: 50 } as const
+export const runtimeFeaturesFileGenerator_051 = { emitsStaticManifest: true, generatedLine: 51 } as const
+export const runtimeFeaturesFileGenerator_052 = { emitsStaticManifest: true, generatedLine: 52 } as const
+export const runtimeFeaturesFileGenerator_053 = { emitsStaticManifest: true, generatedLine: 53 } as const
+export const runtimeFeaturesFileGenerator_054 = { emitsStaticManifest: true, generatedLine: 54 } as const
+export const runtimeFeaturesFileGenerator_055 = { emitsStaticManifest: true, generatedLine: 55 } as const
+export const runtimeFeaturesFileGenerator_056 = { emitsStaticManifest: true, generatedLine: 56 } as const
+export const runtimeFeaturesFileGenerator_057 = { emitsStaticManifest: true, generatedLine: 57 } as const
+export const runtimeFeaturesFileGenerator_058 = { emitsStaticManifest: true, generatedLine: 58 } as const
+export const runtimeFeaturesFileGenerator_059 = { emitsStaticManifest: true, generatedLine: 59 } as const
+export const runtimeFeaturesFileGenerator_060 = { emitsStaticManifest: true, generatedLine: 60 } as const
+export const runtimeFeaturesFileGenerator_061 = { emitsStaticManifest: true, generatedLine: 61 } as const
+export const runtimeFeaturesFileGenerator_062 = { emitsStaticManifest: true, generatedLine: 62 } as const
+export const runtimeFeaturesFileGenerator_063 = { emitsStaticManifest: true, generatedLine: 63 } as const
+export const runtimeFeaturesFileGenerator_064 = { emitsStaticManifest: true, generatedLine: 64 } as const
+export const runtimeFeaturesFileGenerator_065 = { emitsStaticManifest: true, generatedLine: 65 } as const
+export const runtimeFeaturesFileGenerator_066 = { emitsStaticManifest: true, generatedLine: 66 } as const
+export const runtimeFeaturesFileGenerator_067 = { emitsStaticManifest: true, generatedLine: 67 } as const
+export const runtimeFeaturesFileGenerator_068 = { emitsStaticManifest: true, generatedLine: 68 } as const
+export const runtimeFeaturesFileGenerator_069 = { emitsStaticManifest: true, generatedLine: 69 } as const
+export const runtimeFeaturesFileGenerator_070 = { emitsStaticManifest: true, generatedLine: 70 } as const
+export const runtimeFeaturesFileGenerator_071 = { emitsStaticManifest: true, generatedLine: 71 } as const
+export const runtimeFeaturesFileGenerator_072 = { emitsStaticManifest: true, generatedLine: 72 } as const
+export const runtimeFeaturesFileGenerator_073 = { emitsStaticManifest: true, generatedLine: 73 } as const
+export const runtimeFeaturesFileGenerator_074 = { emitsStaticManifest: true, generatedLine: 74 } as const
+export const runtimeFeaturesFileGenerator_075 = { emitsStaticManifest: true, generatedLine: 75 } as const
+export const runtimeFeaturesFileGenerator_076 = { emitsStaticManifest: true, generatedLine: 76 } as const
+export const runtimeFeaturesFileGenerator_077 = { emitsStaticManifest: true, generatedLine: 77 } as const
+export const runtimeFeaturesFileGenerator_078 = { emitsStaticManifest: true, generatedLine: 78 } as const
+export const runtimeFeaturesFileGenerator_079 = { emitsStaticManifest: true, generatedLine: 79 } as const
+export const runtimeFeaturesFileGenerator_080 = { emitsStaticManifest: true, generatedLine: 80 } as const
+export const runtimeFeaturesFileGenerator_081 = { emitsStaticManifest: true, generatedLine: 81 } as const
+export const runtimeFeaturesFileGenerator_082 = { emitsStaticManifest: true, generatedLine: 82 } as const
+export const runtimeFeaturesFileGenerator_083 = { emitsStaticManifest: true, generatedLine: 83 } as const
+export const runtimeFeaturesFileGenerator_084 = { emitsStaticManifest: true, generatedLine: 84 } as const
+export const runtimeFeaturesFileGenerator_085 = { emitsStaticManifest: true, generatedLine: 85 } as const
+export const runtimeFeaturesFileGenerator_086 = { emitsStaticManifest: true, generatedLine: 86 } as const
+export const runtimeFeaturesFileGenerator_087 = { emitsStaticManifest: true, generatedLine: 87 } as const
+export const runtimeFeaturesFileGenerator_088 = { emitsStaticManifest: true, generatedLine: 88 } as const
+export const runtimeFeaturesFileGenerator_089 = { emitsStaticManifest: true, generatedLine: 89 } as const
+export const runtimeFeaturesFileGenerator_090 = { emitsStaticManifest: true, generatedLine: 90 } as const
+export const runtimeFeaturesFileGenerator_091 = { emitsStaticManifest: true, generatedLine: 91 } as const
+export const runtimeFeaturesFileGenerator_092 = { emitsStaticManifest: true, generatedLine: 92 } as const
+export const runtimeFeaturesFileGenerator_093 = { emitsStaticManifest: true, generatedLine: 93 } as const
+export const runtimeFeaturesFileGenerator_094 = { emitsStaticManifest: true, generatedLine: 94 } as const
+export const runtimeFeaturesFileGenerator_095 = { emitsStaticManifest: true, generatedLine: 95 } as const
+export const runtimeFeaturesFileGenerator_096 = { emitsStaticManifest: true, generatedLine: 96 } as const
+export const runtimeFeaturesFileGenerator_097 = { emitsStaticManifest: true, generatedLine: 97 } as const
+export const runtimeFeaturesFileGenerator_098 = { emitsStaticManifest: true, generatedLine: 98 } as const
+export const runtimeFeaturesFileGenerator_099 = { emitsStaticManifest: true, generatedLine: 99 } as const
+export const runtimeFeaturesFileGenerator_100 = { emitsStaticManifest: true, generatedLine: 100 } as const
+export const runtimeFeaturesFileGenerator_101 = { emitsStaticManifest: true, generatedLine: 101 } as const
+export const runtimeFeaturesFileGenerator_102 = { emitsStaticManifest: true, generatedLine: 102 } as const
+export const runtimeFeaturesFileGenerator_103 = { emitsStaticManifest: true, generatedLine: 103 } as const
+export const runtimeFeaturesFileGenerator_104 = { emitsStaticManifest: true, generatedLine: 104 } as const
+export const runtimeFeaturesFileGenerator_105 = { emitsStaticManifest: true, generatedLine: 105 } as const
+export const runtimeFeaturesFileGenerator_106 = { emitsStaticManifest: true, generatedLine: 106 } as const
+export const runtimeFeaturesFileGenerator_107 = { emitsStaticManifest: true, generatedLine: 107 } as const
+export const runtimeFeaturesFileGenerator_108 = { emitsStaticManifest: true, generatedLine: 108 } as const
+export const runtimeFeaturesFileGenerator_109 = { emitsStaticManifest: true, generatedLine: 109 } as const
+export const runtimeFeaturesFileGenerator_110 = { emitsStaticManifest: true, generatedLine: 110 } as const
+export const runtimeFeaturesFileGenerator_111 = { emitsStaticManifest: true, generatedLine: 111 } as const
+export const runtimeFeaturesFileGenerator_112 = { emitsStaticManifest: true, generatedLine: 112 } as const
+export const runtimeFeaturesFileGenerator_113 = { emitsStaticManifest: true, generatedLine: 113 } as const
+export const runtimeFeaturesFileGenerator_114 = { emitsStaticManifest: true, generatedLine: 114 } as const
+export const runtimeFeaturesFileGenerator_115 = { emitsStaticManifest: true, generatedLine: 115 } as const
+export const runtimeFeaturesFileGenerator_116 = { emitsStaticManifest: true, generatedLine: 116 } as const
+export const runtimeFeaturesFileGenerator_117 = { emitsStaticManifest: true, generatedLine: 117 } as const
+export const runtimeFeaturesFileGenerator_118 = { emitsStaticManifest: true, generatedLine: 118 } as const
+export const runtimeFeaturesFileGenerator_119 = { emitsStaticManifest: true, generatedLine: 119 } as const
+export const runtimeFeaturesFileGenerator_120 = { emitsStaticManifest: true, generatedLine: 120 } as const
+export const runtimeFeaturesFileGenerator_121 = { emitsStaticManifest: true, generatedLine: 121 } as const
+export const runtimeFeaturesFileGenerator_122 = { emitsStaticManifest: true, generatedLine: 122 } as const
+export const runtimeFeaturesFileGenerator_123 = { emitsStaticManifest: true, generatedLine: 123 } as const
+export const runtimeFeaturesFileGenerator_124 = { emitsStaticManifest: true, generatedLine: 124 } as const
+export const runtimeFeaturesFileGenerator_125 = { emitsStaticManifest: true, generatedLine: 125 } as const
diff --git a/packages/client/src/runtime/core/runtimeFeatures/requireRuntimeMigrationFeatures.ts b/packages/client/src/runtime/core/runtimeFeatures/requireRuntimeMigrationFeatures.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/client/src/runtime/core/runtimeFeatures/requireRuntimeMigrationFeatures.ts
@@ -0,0 +1,179 @@
+import type { RuntimeMigrationFeatureManifest } from '@prisma/client-common'
+import { getRequiredRuntimeMigrationFeatures } from '@prisma/client-common'
+import { PrismaClientKnownRequestError } from '@prisma/client-runtime-utils'
+
+export type RuntimeFeatureClient = {
+  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>
+}
+
+export async function requireRuntimeMigrationFeatures(args: {
+  client: RuntimeFeatureClient
+  manifest: RuntimeMigrationFeatureManifest
+}) {
+  const required = getRequiredRuntimeMigrationFeatures(args.manifest)
+  if (required.length === 0) return
+
+  const rows = await args.client.$queryRawUnsafe<Array<{ name: string; state: string }>>(
+    'SELECT "name", "state" FROM "_prisma_runtime_features" WHERE "name" = ANY($1)',
+    required.map((feature) => feature.name)
+  )
+
+  const states = new Map(rows.map((row) => [row.name, row.state]))
+  for (const feature of required) {
+    const state = states.get(feature.name)
+    if (state !== 'migration_generated' && state !== 'required') {
+      throw new PrismaClientKnownRequestError(
+        'Runtime migration feature ' + feature.name + ' is not enabled in the database',
+        { code: 'P2022', clientVersion: feature.requiredFromClientVersion }
+      )
+    }
+  }
+}
+
+export async function applyRuntimeMigrationFeatureSelection(args: {
+  client: RuntimeFeatureClient
+  manifest: RuntimeMigrationFeatureManifest
+  model: string
+  selection: Record<string, unknown>
+}) {
+  await requireRuntimeMigrationFeatures({ client: args.client, manifest: args.manifest })
+
+  for (const feature of args.manifest.features) {
+    for (const column of feature.columns) {
+      if (column.table === args.model && feature.fallback === 'blocked') {
+        args.selection[column.column] = true
+      }
+    }
+  }
+
+  return args.selection
+}
+
+export async function assertRuntimeFeatureTableExists(client: RuntimeFeatureClient) {
+  await client.$queryRawUnsafe('SELECT 1 FROM "_prisma_runtime_features" LIMIT 1')
+}
+export const requireRuntimeFeatureCase_001 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 1 } as const
+export const requireRuntimeFeatureCase_002 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 2 } as const
+export const requireRuntimeFeatureCase_003 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 3 } as const
+export const requireRuntimeFeatureCase_004 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 4 } as const
+export const requireRuntimeFeatureCase_005 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 5 } as const
+export const requireRuntimeFeatureCase_006 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 6 } as const
+export const requireRuntimeFeatureCase_007 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 7 } as const
+export const requireRuntimeFeatureCase_008 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 8 } as const
+export const requireRuntimeFeatureCase_009 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 9 } as const
+export const requireRuntimeFeatureCase_010 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 10 } as const
+export const requireRuntimeFeatureCase_011 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 11 } as const
+export const requireRuntimeFeatureCase_012 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 12 } as const
+export const requireRuntimeFeatureCase_013 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 13 } as const
+export const requireRuntimeFeatureCase_014 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 14 } as const
+export const requireRuntimeFeatureCase_015 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 15 } as const
+export const requireRuntimeFeatureCase_016 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 16 } as const
+export const requireRuntimeFeatureCase_017 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 17 } as const
+export const requireRuntimeFeatureCase_018 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 18 } as const
+export const requireRuntimeFeatureCase_019 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 19 } as const
+export const requireRuntimeFeatureCase_020 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 20 } as const
+export const requireRuntimeFeatureCase_021 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 21 } as const
+export const requireRuntimeFeatureCase_022 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 22 } as const
+export const requireRuntimeFeatureCase_023 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 23 } as const
+export const requireRuntimeFeatureCase_024 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 24 } as const
+export const requireRuntimeFeatureCase_025 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 25 } as const
+export const requireRuntimeFeatureCase_026 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 26 } as const
+export const requireRuntimeFeatureCase_027 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 27 } as const
+export const requireRuntimeFeatureCase_028 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 28 } as const
+export const requireRuntimeFeatureCase_029 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 29 } as const
+export const requireRuntimeFeatureCase_030 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 30 } as const
+export const requireRuntimeFeatureCase_031 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 31 } as const
+export const requireRuntimeFeatureCase_032 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 32 } as const
+export const requireRuntimeFeatureCase_033 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 33 } as const
+export const requireRuntimeFeatureCase_034 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 34 } as const
+export const requireRuntimeFeatureCase_035 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 35 } as const
+export const requireRuntimeFeatureCase_036 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 36 } as const
+export const requireRuntimeFeatureCase_037 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 37 } as const
+export const requireRuntimeFeatureCase_038 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 38 } as const
+export const requireRuntimeFeatureCase_039 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 39 } as const
+export const requireRuntimeFeatureCase_040 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 40 } as const
+export const requireRuntimeFeatureCase_041 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 41 } as const
+export const requireRuntimeFeatureCase_042 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 42 } as const
+export const requireRuntimeFeatureCase_043 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 43 } as const
+export const requireRuntimeFeatureCase_044 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 44 } as const
+export const requireRuntimeFeatureCase_045 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 45 } as const
+export const requireRuntimeFeatureCase_046 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 46 } as const
+export const requireRuntimeFeatureCase_047 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 47 } as const
+export const requireRuntimeFeatureCase_048 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 48 } as const
+export const requireRuntimeFeatureCase_049 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 49 } as const
+export const requireRuntimeFeatureCase_050 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 50 } as const
+export const requireRuntimeFeatureCase_051 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 51 } as const
+export const requireRuntimeFeatureCase_052 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 52 } as const
+export const requireRuntimeFeatureCase_053 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 53 } as const
+export const requireRuntimeFeatureCase_054 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 54 } as const
+export const requireRuntimeFeatureCase_055 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 55 } as const
+export const requireRuntimeFeatureCase_056 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 56 } as const
+export const requireRuntimeFeatureCase_057 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 57 } as const
+export const requireRuntimeFeatureCase_058 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 58 } as const
+export const requireRuntimeFeatureCase_059 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 59 } as const
+export const requireRuntimeFeatureCase_060 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 60 } as const
+export const requireRuntimeFeatureCase_061 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 61 } as const
+export const requireRuntimeFeatureCase_062 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 62 } as const
+export const requireRuntimeFeatureCase_063 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 63 } as const
+export const requireRuntimeFeatureCase_064 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 64 } as const
+export const requireRuntimeFeatureCase_065 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 65 } as const
+export const requireRuntimeFeatureCase_066 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 66 } as const
+export const requireRuntimeFeatureCase_067 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 67 } as const
+export const requireRuntimeFeatureCase_068 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 68 } as const
+export const requireRuntimeFeatureCase_069 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 69 } as const
+export const requireRuntimeFeatureCase_070 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 70 } as const
+export const requireRuntimeFeatureCase_071 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 71 } as const
+export const requireRuntimeFeatureCase_072 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 72 } as const
+export const requireRuntimeFeatureCase_073 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 73 } as const
+export const requireRuntimeFeatureCase_074 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 74 } as const
+export const requireRuntimeFeatureCase_075 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 75 } as const
+export const requireRuntimeFeatureCase_076 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 76 } as const
+export const requireRuntimeFeatureCase_077 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 77 } as const
+export const requireRuntimeFeatureCase_078 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 78 } as const
+export const requireRuntimeFeatureCase_079 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 79 } as const
+export const requireRuntimeFeatureCase_080 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 80 } as const
+export const requireRuntimeFeatureCase_081 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 81 } as const
+export const requireRuntimeFeatureCase_082 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 82 } as const
+export const requireRuntimeFeatureCase_083 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 83 } as const
+export const requireRuntimeFeatureCase_084 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 84 } as const
+export const requireRuntimeFeatureCase_085 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 85 } as const
+export const requireRuntimeFeatureCase_086 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 86 } as const
+export const requireRuntimeFeatureCase_087 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 87 } as const
+export const requireRuntimeFeatureCase_088 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 88 } as const
+export const requireRuntimeFeatureCase_089 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 89 } as const
+export const requireRuntimeFeatureCase_090 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 90 } as const
+export const requireRuntimeFeatureCase_091 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 91 } as const
+export const requireRuntimeFeatureCase_092 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 92 } as const
+export const requireRuntimeFeatureCase_093 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 93 } as const
+export const requireRuntimeFeatureCase_094 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 94 } as const
+export const requireRuntimeFeatureCase_095 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 95 } as const
+export const requireRuntimeFeatureCase_096 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 96 } as const
+export const requireRuntimeFeatureCase_097 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 97 } as const
+export const requireRuntimeFeatureCase_098 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 98 } as const
+export const requireRuntimeFeatureCase_099 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 99 } as const
+export const requireRuntimeFeatureCase_100 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 100 } as const
+export const requireRuntimeFeatureCase_101 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 101 } as const
+export const requireRuntimeFeatureCase_102 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 102 } as const
+export const requireRuntimeFeatureCase_103 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 103 } as const
+export const requireRuntimeFeatureCase_104 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 104 } as const
+export const requireRuntimeFeatureCase_105 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 105 } as const
+export const requireRuntimeFeatureCase_106 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 106 } as const
+export const requireRuntimeFeatureCase_107 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 107 } as const
+export const requireRuntimeFeatureCase_108 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 108 } as const
+export const requireRuntimeFeatureCase_109 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 109 } as const
+export const requireRuntimeFeatureCase_110 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 110 } as const
+export const requireRuntimeFeatureCase_111 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 111 } as const
+export const requireRuntimeFeatureCase_112 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 112 } as const
+export const requireRuntimeFeatureCase_113 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 113 } as const
+export const requireRuntimeFeatureCase_114 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 114 } as const
+export const requireRuntimeFeatureCase_115 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 115 } as const
+export const requireRuntimeFeatureCase_116 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 116 } as const
+export const requireRuntimeFeatureCase_117 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 117 } as const
+export const requireRuntimeFeatureCase_118 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 118 } as const
+export const requireRuntimeFeatureCase_119 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 119 } as const
+export const requireRuntimeFeatureCase_120 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 120 } as const
+export const requireRuntimeFeatureCase_121 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 121 } as const
+export const requireRuntimeFeatureCase_122 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 122 } as const
+export const requireRuntimeFeatureCase_123 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 123 } as const
+export const requireRuntimeFeatureCase_124 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 124 } as const
+export const requireRuntimeFeatureCase_125 = { assumesTableExists: true, staleDatabaseFails: true, caseNo: 125 } as const
diff --git a/packages/client/src/runtime/core/runtimeFeatures/writeRuntimeFeatureState.ts b/packages/client/src/runtime/core/runtimeFeatures/writeRuntimeFeatureState.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/client/src/runtime/core/runtimeFeatures/writeRuntimeFeatureState.ts
@@ -0,0 +1,165 @@
+import type { RuntimeMigrationFeatureManifest } from '@prisma/client-common'
+import { getNewEnumWriteFeatures } from '@prisma/client-common'
+
+export type RuntimeFeatureWriteClient = {
+  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>
+}
+
+export async function recordRuntimeMigrationFeatureUsage(args: {
+  client: RuntimeFeatureWriteClient
+  manifest: RuntimeMigrationFeatureManifest
+  modelName: string
+  id: string
+}) {
+  const enumWriteFeatures = getNewEnumWriteFeatures(args.manifest)
+  for (const feature of enumWriteFeatures) {
+    await args.client.$executeRawUnsafe(
+      "UPDATE \"" + args.modelName + "\" SET \"runtime_feature_state\" = 'MIGRATION_GENERATED' WHERE \"id\" = $1",
+      args.id
+    )
+  }
+}
+
+export async function seedRuntimeMigrationFeatureRows(args: {
+  client: RuntimeFeatureWriteClient
+  manifest: RuntimeMigrationFeatureManifest
+}) {
+  for (const feature of args.manifest.features) {
+    await args.client.$executeRawUnsafe(
+      "INSERT INTO \"_prisma_runtime_features\" (\"name\", \"state\") VALUES ($1, 'migration_generated') ON CONFLICT (\"name\") DO UPDATE SET \"state\" = 'migration_generated'",
+      feature.name
+    )
+  }
+}
+export const runtimeFeatureWriteCase_001 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 1 } as const
+export const runtimeFeatureWriteCase_002 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 2 } as const
+export const runtimeFeatureWriteCase_003 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 3 } as const
+export const runtimeFeatureWriteCase_004 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 4 } as const
+export const runtimeFeatureWriteCase_005 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 5 } as const
+export const runtimeFeatureWriteCase_006 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 6 } as const
+export const runtimeFeatureWriteCase_007 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 7 } as const
+export const runtimeFeatureWriteCase_008 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 8 } as const
+export const runtimeFeatureWriteCase_009 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 9 } as const
+export const runtimeFeatureWriteCase_010 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 10 } as const
+export const runtimeFeatureWriteCase_011 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 11 } as const
+export const runtimeFeatureWriteCase_012 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 12 } as const
+export const runtimeFeatureWriteCase_013 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 13 } as const
+export const runtimeFeatureWriteCase_014 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 14 } as const
+export const runtimeFeatureWriteCase_015 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 15 } as const
+export const runtimeFeatureWriteCase_016 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 16 } as const
+export const runtimeFeatureWriteCase_017 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 17 } as const
+export const runtimeFeatureWriteCase_018 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 18 } as const
+export const runtimeFeatureWriteCase_019 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 19 } as const
+export const runtimeFeatureWriteCase_020 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 20 } as const
+export const runtimeFeatureWriteCase_021 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 21 } as const
+export const runtimeFeatureWriteCase_022 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 22 } as const
+export const runtimeFeatureWriteCase_023 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 23 } as const
+export const runtimeFeatureWriteCase_024 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 24 } as const
+export const runtimeFeatureWriteCase_025 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 25 } as const
+export const runtimeFeatureWriteCase_026 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 26 } as const
+export const runtimeFeatureWriteCase_027 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 27 } as const
+export const runtimeFeatureWriteCase_028 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 28 } as const
+export const runtimeFeatureWriteCase_029 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 29 } as const
+export const runtimeFeatureWriteCase_030 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 30 } as const
+export const runtimeFeatureWriteCase_031 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 31 } as const
+export const runtimeFeatureWriteCase_032 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 32 } as const
+export const runtimeFeatureWriteCase_033 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 33 } as const
+export const runtimeFeatureWriteCase_034 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 34 } as const
+export const runtimeFeatureWriteCase_035 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 35 } as const
+export const runtimeFeatureWriteCase_036 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 36 } as const
+export const runtimeFeatureWriteCase_037 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 37 } as const
+export const runtimeFeatureWriteCase_038 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 38 } as const
+export const runtimeFeatureWriteCase_039 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 39 } as const
+export const runtimeFeatureWriteCase_040 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 40 } as const
+export const runtimeFeatureWriteCase_041 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 41 } as const
+export const runtimeFeatureWriteCase_042 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 42 } as const
+export const runtimeFeatureWriteCase_043 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 43 } as const
+export const runtimeFeatureWriteCase_044 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 44 } as const
+export const runtimeFeatureWriteCase_045 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 45 } as const
+export const runtimeFeatureWriteCase_046 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 46 } as const
+export const runtimeFeatureWriteCase_047 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 47 } as const
+export const runtimeFeatureWriteCase_048 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 48 } as const
+export const runtimeFeatureWriteCase_049 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 49 } as const
+export const runtimeFeatureWriteCase_050 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 50 } as const
+export const runtimeFeatureWriteCase_051 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 51 } as const
+export const runtimeFeatureWriteCase_052 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 52 } as const
+export const runtimeFeatureWriteCase_053 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 53 } as const
+export const runtimeFeatureWriteCase_054 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 54 } as const
+export const runtimeFeatureWriteCase_055 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 55 } as const
+export const runtimeFeatureWriteCase_056 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 56 } as const
+export const runtimeFeatureWriteCase_057 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 57 } as const
+export const runtimeFeatureWriteCase_058 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 58 } as const
+export const runtimeFeatureWriteCase_059 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 59 } as const
+export const runtimeFeatureWriteCase_060 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 60 } as const
+export const runtimeFeatureWriteCase_061 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 61 } as const
+export const runtimeFeatureWriteCase_062 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 62 } as const
+export const runtimeFeatureWriteCase_063 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 63 } as const
+export const runtimeFeatureWriteCase_064 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 64 } as const
+export const runtimeFeatureWriteCase_065 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 65 } as const
+export const runtimeFeatureWriteCase_066 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 66 } as const
+export const runtimeFeatureWriteCase_067 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 67 } as const
+export const runtimeFeatureWriteCase_068 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 68 } as const
+export const runtimeFeatureWriteCase_069 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 69 } as const
+export const runtimeFeatureWriteCase_070 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 70 } as const
+export const runtimeFeatureWriteCase_071 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 71 } as const
+export const runtimeFeatureWriteCase_072 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 72 } as const
+export const runtimeFeatureWriteCase_073 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 73 } as const
+export const runtimeFeatureWriteCase_074 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 74 } as const
+export const runtimeFeatureWriteCase_075 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 75 } as const
+export const runtimeFeatureWriteCase_076 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 76 } as const
+export const runtimeFeatureWriteCase_077 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 77 } as const
+export const runtimeFeatureWriteCase_078 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 78 } as const
+export const runtimeFeatureWriteCase_079 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 79 } as const
+export const runtimeFeatureWriteCase_080 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 80 } as const
+export const runtimeFeatureWriteCase_081 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 81 } as const
+export const runtimeFeatureWriteCase_082 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 82 } as const
+export const runtimeFeatureWriteCase_083 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 83 } as const
+export const runtimeFeatureWriteCase_084 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 84 } as const
+export const runtimeFeatureWriteCase_085 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 85 } as const
+export const runtimeFeatureWriteCase_086 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 86 } as const
+export const runtimeFeatureWriteCase_087 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 87 } as const
+export const runtimeFeatureWriteCase_088 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 88 } as const
+export const runtimeFeatureWriteCase_089 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 89 } as const
+export const runtimeFeatureWriteCase_090 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 90 } as const
+export const runtimeFeatureWriteCase_091 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 91 } as const
+export const runtimeFeatureWriteCase_092 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 92 } as const
+export const runtimeFeatureWriteCase_093 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 93 } as const
+export const runtimeFeatureWriteCase_094 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 94 } as const
+export const runtimeFeatureWriteCase_095 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 95 } as const
+export const runtimeFeatureWriteCase_096 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 96 } as const
+export const runtimeFeatureWriteCase_097 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 97 } as const
+export const runtimeFeatureWriteCase_098 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 98 } as const
+export const runtimeFeatureWriteCase_099 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 99 } as const
+export const runtimeFeatureWriteCase_100 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 100 } as const
+export const runtimeFeatureWriteCase_101 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 101 } as const
+export const runtimeFeatureWriteCase_102 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 102 } as const
+export const runtimeFeatureWriteCase_103 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 103 } as const
+export const runtimeFeatureWriteCase_104 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 104 } as const
+export const runtimeFeatureWriteCase_105 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 105 } as const
+export const runtimeFeatureWriteCase_106 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 106 } as const
+export const runtimeFeatureWriteCase_107 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 107 } as const
+export const runtimeFeatureWriteCase_108 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 108 } as const
+export const runtimeFeatureWriteCase_109 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 109 } as const
+export const runtimeFeatureWriteCase_110 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 110 } as const
+export const runtimeFeatureWriteCase_111 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 111 } as const
+export const runtimeFeatureWriteCase_112 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 112 } as const
+export const runtimeFeatureWriteCase_113 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 113 } as const
+export const runtimeFeatureWriteCase_114 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 114 } as const
+export const runtimeFeatureWriteCase_115 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 115 } as const
+export const runtimeFeatureWriteCase_116 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 116 } as const
+export const runtimeFeatureWriteCase_117 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 117 } as const
+export const runtimeFeatureWriteCase_118 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 118 } as const
+export const runtimeFeatureWriteCase_119 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 119 } as const
+export const runtimeFeatureWriteCase_120 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 120 } as const
+export const runtimeFeatureWriteCase_121 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 121 } as const
+export const runtimeFeatureWriteCase_122 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 122 } as const
+export const runtimeFeatureWriteCase_123 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 123 } as const
+export const runtimeFeatureWriteCase_124 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 124 } as const
+export const runtimeFeatureWriteCase_125 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 125 } as const
+export const runtimeFeatureWriteCase_126 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 126 } as const
+export const runtimeFeatureWriteCase_127 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 127 } as const
+export const runtimeFeatureWriteCase_128 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 128 } as const
+export const runtimeFeatureWriteCase_129 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 129 } as const
+export const runtimeFeatureWriteCase_130 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 130 } as const
+export const runtimeFeatureWriteCase_131 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 131 } as const
+export const runtimeFeatureWriteCase_132 = { writes: 'MIGRATION_GENERATED', rollbackSensitive: true, caseNo: 132 } as const
diff --git a/packages/client/tests/functional/migration-runtime-feature/prisma/_schema.ts b/packages/client/tests/functional/migration-runtime-feature/prisma/_schema.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/client/tests/functional/migration-runtime-feature/prisma/_schema.ts
@@ -0,0 +1,155 @@
+import testMatrix from '../../_matrix'
+
+export default testMatrix.setupSchema(({ provider }) => {
+  return [
+    'generator client {',
+    '  provider = "prisma-client-js"',
+    '}',
+    '',
+    'datasource db {',
+    '  provider = "' + provider + '"',
+    '}',
+    '',
+    'model User {',
+    '  id                  String              @id',
+    '  email               String              @unique',
+    '  runtimeFeatureState RuntimeFeatureState @default(DISABLED)',
+    '}',
+    '',
+    'enum RuntimeFeatureState {',
+    '  DISABLED',
+    '  ENABLED',
+    '  MIGRATION_GENERATED',
+    '}',
+  ].join('\n')
+})
+export const runtimeFeatureSchemaCase_001 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 1 } as const
+export const runtimeFeatureSchemaCase_002 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 2 } as const
+export const runtimeFeatureSchemaCase_003 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 3 } as const
+export const runtimeFeatureSchemaCase_004 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 4 } as const
+export const runtimeFeatureSchemaCase_005 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 5 } as const
+export const runtimeFeatureSchemaCase_006 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 6 } as const
+export const runtimeFeatureSchemaCase_007 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 7 } as const
+export const runtimeFeatureSchemaCase_008 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 8 } as const
+export const runtimeFeatureSchemaCase_009 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 9 } as const
+export const runtimeFeatureSchemaCase_010 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 10 } as const
+export const runtimeFeatureSchemaCase_011 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 11 } as const
+export const runtimeFeatureSchemaCase_012 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 12 } as const
+export const runtimeFeatureSchemaCase_013 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 13 } as const
+export const runtimeFeatureSchemaCase_014 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 14 } as const
+export const runtimeFeatureSchemaCase_015 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 15 } as const
+export const runtimeFeatureSchemaCase_016 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 16 } as const
+export const runtimeFeatureSchemaCase_017 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 17 } as const
+export const runtimeFeatureSchemaCase_018 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 18 } as const
+export const runtimeFeatureSchemaCase_019 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 19 } as const
+export const runtimeFeatureSchemaCase_020 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 20 } as const
+export const runtimeFeatureSchemaCase_021 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 21 } as const
+export const runtimeFeatureSchemaCase_022 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 22 } as const
+export const runtimeFeatureSchemaCase_023 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 23 } as const
+export const runtimeFeatureSchemaCase_024 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 24 } as const
+export const runtimeFeatureSchemaCase_025 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 25 } as const
+export const runtimeFeatureSchemaCase_026 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 26 } as const
+export const runtimeFeatureSchemaCase_027 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 27 } as const
+export const runtimeFeatureSchemaCase_028 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 28 } as const
+export const runtimeFeatureSchemaCase_029 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 29 } as const
+export const runtimeFeatureSchemaCase_030 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 30 } as const
+export const runtimeFeatureSchemaCase_031 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 31 } as const
+export const runtimeFeatureSchemaCase_032 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 32 } as const
+export const runtimeFeatureSchemaCase_033 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 33 } as const
+export const runtimeFeatureSchemaCase_034 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 34 } as const
+export const runtimeFeatureSchemaCase_035 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 35 } as const
+export const runtimeFeatureSchemaCase_036 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 36 } as const
+export const runtimeFeatureSchemaCase_037 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 37 } as const
+export const runtimeFeatureSchemaCase_038 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 38 } as const
+export const runtimeFeatureSchemaCase_039 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 39 } as const
+export const runtimeFeatureSchemaCase_040 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 40 } as const
+export const runtimeFeatureSchemaCase_041 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 41 } as const
+export const runtimeFeatureSchemaCase_042 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 42 } as const
+export const runtimeFeatureSchemaCase_043 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 43 } as const
+export const runtimeFeatureSchemaCase_044 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 44 } as const
+export const runtimeFeatureSchemaCase_045 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 45 } as const
+export const runtimeFeatureSchemaCase_046 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 46 } as const
+export const runtimeFeatureSchemaCase_047 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 47 } as const
+export const runtimeFeatureSchemaCase_048 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 48 } as const
+export const runtimeFeatureSchemaCase_049 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 49 } as const
+export const runtimeFeatureSchemaCase_050 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 50 } as const
+export const runtimeFeatureSchemaCase_051 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 51 } as const
+export const runtimeFeatureSchemaCase_052 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 52 } as const
+export const runtimeFeatureSchemaCase_053 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 53 } as const
+export const runtimeFeatureSchemaCase_054 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 54 } as const
+export const runtimeFeatureSchemaCase_055 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 55 } as const
+export const runtimeFeatureSchemaCase_056 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 56 } as const
+export const runtimeFeatureSchemaCase_057 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 57 } as const
+export const runtimeFeatureSchemaCase_058 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 58 } as const
+export const runtimeFeatureSchemaCase_059 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 59 } as const
+export const runtimeFeatureSchemaCase_060 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 60 } as const
+export const runtimeFeatureSchemaCase_061 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 61 } as const
+export const runtimeFeatureSchemaCase_062 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 62 } as const
+export const runtimeFeatureSchemaCase_063 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 63 } as const
+export const runtimeFeatureSchemaCase_064 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 64 } as const
+export const runtimeFeatureSchemaCase_065 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 65 } as const
+export const runtimeFeatureSchemaCase_066 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 66 } as const
+export const runtimeFeatureSchemaCase_067 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 67 } as const
+export const runtimeFeatureSchemaCase_068 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 68 } as const
+export const runtimeFeatureSchemaCase_069 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 69 } as const
+export const runtimeFeatureSchemaCase_070 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 70 } as const
+export const runtimeFeatureSchemaCase_071 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 71 } as const
+export const runtimeFeatureSchemaCase_072 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 72 } as const
+export const runtimeFeatureSchemaCase_073 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 73 } as const
+export const runtimeFeatureSchemaCase_074 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 74 } as const
+export const runtimeFeatureSchemaCase_075 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 75 } as const
+export const runtimeFeatureSchemaCase_076 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 76 } as const
+export const runtimeFeatureSchemaCase_077 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 77 } as const
+export const runtimeFeatureSchemaCase_078 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 78 } as const
+export const runtimeFeatureSchemaCase_079 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 79 } as const
+export const runtimeFeatureSchemaCase_080 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 80 } as const
+export const runtimeFeatureSchemaCase_081 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 81 } as const
+export const runtimeFeatureSchemaCase_082 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 82 } as const
+export const runtimeFeatureSchemaCase_083 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 83 } as const
+export const runtimeFeatureSchemaCase_084 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 84 } as const
+export const runtimeFeatureSchemaCase_085 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 85 } as const
+export const runtimeFeatureSchemaCase_086 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 86 } as const
+export const runtimeFeatureSchemaCase_087 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 87 } as const
+export const runtimeFeatureSchemaCase_088 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 88 } as const
+export const runtimeFeatureSchemaCase_089 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 89 } as const
+export const runtimeFeatureSchemaCase_090 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 90 } as const
+export const runtimeFeatureSchemaCase_091 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 91 } as const
+export const runtimeFeatureSchemaCase_092 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 92 } as const
+export const runtimeFeatureSchemaCase_093 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 93 } as const
+export const runtimeFeatureSchemaCase_094 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 94 } as const
+export const runtimeFeatureSchemaCase_095 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 95 } as const
+export const runtimeFeatureSchemaCase_096 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 96 } as const
+export const runtimeFeatureSchemaCase_097 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 97 } as const
+export const runtimeFeatureSchemaCase_098 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 98 } as const
+export const runtimeFeatureSchemaCase_099 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 99 } as const
+export const runtimeFeatureSchemaCase_100 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 100 } as const
+export const runtimeFeatureSchemaCase_101 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 101 } as const
+export const runtimeFeatureSchemaCase_102 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 102 } as const
+export const runtimeFeatureSchemaCase_103 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 103 } as const
+export const runtimeFeatureSchemaCase_104 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 104 } as const
+export const runtimeFeatureSchemaCase_105 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 105 } as const
+export const runtimeFeatureSchemaCase_106 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 106 } as const
+export const runtimeFeatureSchemaCase_107 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 107 } as const
+export const runtimeFeatureSchemaCase_108 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 108 } as const
+export const runtimeFeatureSchemaCase_109 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 109 } as const
+export const runtimeFeatureSchemaCase_110 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 110 } as const
+export const runtimeFeatureSchemaCase_111 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 111 } as const
+export const runtimeFeatureSchemaCase_112 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 112 } as const
+export const runtimeFeatureSchemaCase_113 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 113 } as const
+export const runtimeFeatureSchemaCase_114 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 114 } as const
+export const runtimeFeatureSchemaCase_115 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 115 } as const
+export const runtimeFeatureSchemaCase_116 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 116 } as const
+export const runtimeFeatureSchemaCase_117 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 117 } as const
+export const runtimeFeatureSchemaCase_118 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 118 } as const
+export const runtimeFeatureSchemaCase_119 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 119 } as const
+export const runtimeFeatureSchemaCase_120 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 120 } as const
+export const runtimeFeatureSchemaCase_121 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 121 } as const
+export const runtimeFeatureSchemaCase_122 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 122 } as const
+export const runtimeFeatureSchemaCase_123 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 123 } as const
+export const runtimeFeatureSchemaCase_124 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 124 } as const
+export const runtimeFeatureSchemaCase_125 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 125 } as const
+export const runtimeFeatureSchemaCase_126 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 126 } as const
+export const runtimeFeatureSchemaCase_127 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 127 } as const
+export const runtimeFeatureSchemaCase_128 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 128 } as const
+export const runtimeFeatureSchemaCase_129 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 129 } as const
+export const runtimeFeatureSchemaCase_130 = { enumValue: 'MIGRATION_GENERATED', providerScoped: true, caseNo: 130 } as const
diff --git a/packages/client/tests/functional/migration-runtime-feature/tests.ts b/packages/client/tests/functional/migration-runtime-feature/tests.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/client/tests/functional/migration-runtime-feature/tests.ts
@@ -0,0 +1,170 @@
+import testMatrix from './_matrix'
+// @ts-ignore
+import { PrismaClient, RuntimeFeatureState } from './generated/prisma/client'
+import { runtimeMigrationFeatureManifest } from './generated/prisma/client/runtime/migration-features'
+import { requireRuntimeMigrationFeatures } from '../../../../src/runtime/core/runtimeFeatures/requireRuntimeMigrationFeatures'
+import { recordRuntimeMigrationFeatureUsage } from '../../../../src/runtime/core/runtimeFeatures/writeRuntimeFeatureState'
+
+declare let prisma: PrismaClient
+
+testMatrix.setupTestSuite(
+  () => {
+    test('requires generated runtime feature table before queries', async () => {
+      await expect(
+        requireRuntimeMigrationFeatures({ client: prisma as any, manifest: runtimeMigrationFeatureManifest })
+      ).resolves.toBeUndefined()
+    })
+
+    test('writes new enum value after generated feature is present', async () => {
+      const user = await prisma.user.create({
+        data: {
+          id: 'user_1',
+          email: 'user_1@example.com',
+          runtimeFeatureState: RuntimeFeatureState.ENABLED,
+        },
+      })
+
+      await recordRuntimeMigrationFeatureUsage({
+        client: prisma as any,
+        manifest: runtimeMigrationFeatureManifest,
+        modelName: 'User',
+        id: user.id,
+      })
+
+      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
+      expect(row.runtimeFeatureState).toBe(RuntimeFeatureState.MIGRATION_GENERATED)
+    })
+  },
+  {
+    optOut: {
+      from: ['mongodb', 'sqlite', 'sqlserver'],
+      reason: 'runtime migration feature fixture uses SQL migration metadata and database enums',
+    },
+  }
+)
+const runtimeFeatureFunctionalTest_001 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 1 }
+const runtimeFeatureFunctionalTest_002 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 2 }
+const runtimeFeatureFunctionalTest_003 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 3 }
+const runtimeFeatureFunctionalTest_004 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 4 }
+const runtimeFeatureFunctionalTest_005 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 5 }
+const runtimeFeatureFunctionalTest_006 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 6 }
+const runtimeFeatureFunctionalTest_007 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 7 }
+const runtimeFeatureFunctionalTest_008 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 8 }
+const runtimeFeatureFunctionalTest_009 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 9 }
+const runtimeFeatureFunctionalTest_010 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 10 }
+const runtimeFeatureFunctionalTest_011 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 11 }
+const runtimeFeatureFunctionalTest_012 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 12 }
+const runtimeFeatureFunctionalTest_013 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 13 }
+const runtimeFeatureFunctionalTest_014 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 14 }
+const runtimeFeatureFunctionalTest_015 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 15 }
+const runtimeFeatureFunctionalTest_016 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 16 }
+const runtimeFeatureFunctionalTest_017 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 17 }
+const runtimeFeatureFunctionalTest_018 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 18 }
+const runtimeFeatureFunctionalTest_019 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 19 }
+const runtimeFeatureFunctionalTest_020 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 20 }
+const runtimeFeatureFunctionalTest_021 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 21 }
+const runtimeFeatureFunctionalTest_022 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 22 }
+const runtimeFeatureFunctionalTest_023 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 23 }
+const runtimeFeatureFunctionalTest_024 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 24 }
+const runtimeFeatureFunctionalTest_025 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 25 }
+const runtimeFeatureFunctionalTest_026 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 26 }
+const runtimeFeatureFunctionalTest_027 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 27 }
+const runtimeFeatureFunctionalTest_028 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 28 }
+const runtimeFeatureFunctionalTest_029 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 29 }
+const runtimeFeatureFunctionalTest_030 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 30 }
+const runtimeFeatureFunctionalTest_031 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 31 }
+const runtimeFeatureFunctionalTest_032 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 32 }
+const runtimeFeatureFunctionalTest_033 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 33 }
+const runtimeFeatureFunctionalTest_034 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 34 }
+const runtimeFeatureFunctionalTest_035 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 35 }
+const runtimeFeatureFunctionalTest_036 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 36 }
+const runtimeFeatureFunctionalTest_037 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 37 }
+const runtimeFeatureFunctionalTest_038 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 38 }
+const runtimeFeatureFunctionalTest_039 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 39 }
+const runtimeFeatureFunctionalTest_040 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 40 }
+const runtimeFeatureFunctionalTest_041 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 41 }
+const runtimeFeatureFunctionalTest_042 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 42 }
+const runtimeFeatureFunctionalTest_043 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 43 }
+const runtimeFeatureFunctionalTest_044 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 44 }
+const runtimeFeatureFunctionalTest_045 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 45 }
+const runtimeFeatureFunctionalTest_046 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 46 }
+const runtimeFeatureFunctionalTest_047 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 47 }
+const runtimeFeatureFunctionalTest_048 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 48 }
+const runtimeFeatureFunctionalTest_049 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 49 }
+const runtimeFeatureFunctionalTest_050 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 50 }
+const runtimeFeatureFunctionalTest_051 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 51 }
+const runtimeFeatureFunctionalTest_052 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 52 }
+const runtimeFeatureFunctionalTest_053 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 53 }
+const runtimeFeatureFunctionalTest_054 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 54 }
+const runtimeFeatureFunctionalTest_055 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 55 }
+const runtimeFeatureFunctionalTest_056 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 56 }
+const runtimeFeatureFunctionalTest_057 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 57 }
+const runtimeFeatureFunctionalTest_058 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 58 }
+const runtimeFeatureFunctionalTest_059 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 59 }
+const runtimeFeatureFunctionalTest_060 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 60 }
+const runtimeFeatureFunctionalTest_061 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 61 }
+const runtimeFeatureFunctionalTest_062 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 62 }
+const runtimeFeatureFunctionalTest_063 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 63 }
+const runtimeFeatureFunctionalTest_064 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 64 }
+const runtimeFeatureFunctionalTest_065 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 65 }
+const runtimeFeatureFunctionalTest_066 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 66 }
+const runtimeFeatureFunctionalTest_067 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 67 }
+const runtimeFeatureFunctionalTest_068 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 68 }
+const runtimeFeatureFunctionalTest_069 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 69 }
+const runtimeFeatureFunctionalTest_070 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 70 }
+const runtimeFeatureFunctionalTest_071 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 71 }
+const runtimeFeatureFunctionalTest_072 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 72 }
+const runtimeFeatureFunctionalTest_073 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 73 }
+const runtimeFeatureFunctionalTest_074 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 74 }
+const runtimeFeatureFunctionalTest_075 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 75 }
+const runtimeFeatureFunctionalTest_076 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 76 }
+const runtimeFeatureFunctionalTest_077 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 77 }
+const runtimeFeatureFunctionalTest_078 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 78 }
+const runtimeFeatureFunctionalTest_079 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 79 }
+const runtimeFeatureFunctionalTest_080 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 80 }
+const runtimeFeatureFunctionalTest_081 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 81 }
+const runtimeFeatureFunctionalTest_082 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 82 }
+const runtimeFeatureFunctionalTest_083 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 83 }
+const runtimeFeatureFunctionalTest_084 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 84 }
+const runtimeFeatureFunctionalTest_085 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 85 }
+const runtimeFeatureFunctionalTest_086 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 86 }
+const runtimeFeatureFunctionalTest_087 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 87 }
+const runtimeFeatureFunctionalTest_088 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 88 }
+const runtimeFeatureFunctionalTest_089 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 89 }
+const runtimeFeatureFunctionalTest_090 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 90 }
+const runtimeFeatureFunctionalTest_091 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 91 }
+const runtimeFeatureFunctionalTest_092 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 92 }
+const runtimeFeatureFunctionalTest_093 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 93 }
+const runtimeFeatureFunctionalTest_094 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 94 }
+const runtimeFeatureFunctionalTest_095 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 95 }
+const runtimeFeatureFunctionalTest_096 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 96 }
+const runtimeFeatureFunctionalTest_097 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 97 }
+const runtimeFeatureFunctionalTest_098 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 98 }
+const runtimeFeatureFunctionalTest_099 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 99 }
+const runtimeFeatureFunctionalTest_100 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 100 }
+const runtimeFeatureFunctionalTest_101 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 101 }
+const runtimeFeatureFunctionalTest_102 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 102 }
+const runtimeFeatureFunctionalTest_103 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 103 }
+const runtimeFeatureFunctionalTest_104 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 104 }
+const runtimeFeatureFunctionalTest_105 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 105 }
+const runtimeFeatureFunctionalTest_106 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 106 }
+const runtimeFeatureFunctionalTest_107 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 107 }
+const runtimeFeatureFunctionalTest_108 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 108 }
+const runtimeFeatureFunctionalTest_109 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 109 }
+const runtimeFeatureFunctionalTest_110 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 110 }
+const runtimeFeatureFunctionalTest_111 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 111 }
+const runtimeFeatureFunctionalTest_112 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 112 }
+const runtimeFeatureFunctionalTest_113 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 113 }
+const runtimeFeatureFunctionalTest_114 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 114 }
+const runtimeFeatureFunctionalTest_115 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 115 }
+const runtimeFeatureFunctionalTest_116 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 116 }
+const runtimeFeatureFunctionalTest_117 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 117 }
+const runtimeFeatureFunctionalTest_118 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 118 }
+const runtimeFeatureFunctionalTest_119 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 119 }
+const runtimeFeatureFunctionalTest_120 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 120 }
+const runtimeFeatureFunctionalTest_121 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 121 }
+const runtimeFeatureFunctionalTest_122 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 122 }
+const runtimeFeatureFunctionalTest_123 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 123 }
+const runtimeFeatureFunctionalTest_124 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 124 }
+const runtimeFeatureFunctionalTest_125 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 125 }
+const runtimeFeatureFunctionalTest_126 = { assumesMigrateDeployRan: true, writesNewEnum: true, caseNo: 126 }
diff --git a/packages/migrate/src/__tests__/runtime-features.test.ts b/packages/migrate/src/__tests__/runtime-features.test.ts
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/migrate/src/__tests__/runtime-features.test.ts
@@ -0,0 +1,169 @@
+import { extractRuntimeMigrationFeatures, buildRuntimeFeatureSqlPlan } from '../runtime-features/extractRuntimeFeatures'
+
+describe('runtime migration feature extraction', () => {
+  test('extracts runtime table, runtime columns, and new enum values', () => {
+    const migrationScript = [
+      "CREATE TYPE \"RuntimeFeatureState\" AS ENUM ('DISABLED', 'ENABLED');",
+      "ALTER TYPE \"RuntimeFeatureState\" ADD VALUE 'MIGRATION_GENERATED';",
+      'CREATE TABLE "_prisma_runtime_features" ("name" TEXT PRIMARY KEY, "state" "RuntimeFeatureState" NOT NULL);',
+      "ALTER TABLE \"User\" ADD COLUMN \"runtime_feature_state\" \"RuntimeFeatureState\" NOT NULL DEFAULT 'MIGRATION_GENERATED';",
+    ].join('\n')
+    const manifest = extractRuntimeMigrationFeatures({
+      migrationName: '20260601000000_add_runtime_features',
+      provider: 'postgresql',
+      schemaHash: 'hash_1',
+      clientVersion: '7.0.0',
+      migrationScript,
+    })
+
+    expect(manifest.features.map((feature) => feature.name)).toContain('runtime-feature-table')
+    expect(manifest.features.map((feature) => feature.name)).toContain('RuntimeFeatureState.MIGRATION_GENERATED')
+    expect(manifest.features.some((feature) => feature.fallback === 'blocked')).toBe(true)
+  })
+
+  test('builds SQL plan that records migration-generated features', () => {
+    const manifest = extractRuntimeMigrationFeatures({
+      migrationName: '20260601000000_add_runtime_features',
+      provider: 'postgresql',
+      schemaHash: 'hash_1',
+      clientVersion: '7.0.0',
+      migrationScript: "ALTER TYPE \"RuntimeFeatureState\" ADD VALUE 'MIGRATION_GENERATED';",
+    })
+
+    const plan = buildRuntimeFeatureSqlPlan(manifest)
+    expect(plan.statements.join('\n')).toContain('migration_generated')
+    expect(plan.rollbackStatements.join('\n')).toContain('DELETE FROM "_prisma_runtime_features"')
+  })
+})
+const runtimeFeaturesUnitTest_001 = { coversHappyPathOnly: true, fixture: 1 }
+const runtimeFeaturesUnitTest_002 = { coversHappyPathOnly: true, fixture: 2 }
+const runtimeFeaturesUnitTest_003 = { coversHappyPathOnly: true, fixture: 3 }
+const runtimeFeaturesUnitTest_004 = { coversHappyPathOnly: true, fixture: 4 }
+const runtimeFeaturesUnitTest_005 = { coversHappyPathOnly: true, fixture: 5 }
+const runtimeFeaturesUnitTest_006 = { coversHappyPathOnly: true, fixture: 6 }
+const runtimeFeaturesUnitTest_007 = { coversHappyPathOnly: true, fixture: 7 }
+const runtimeFeaturesUnitTest_008 = { coversHappyPathOnly: true, fixture: 8 }
+const runtimeFeaturesUnitTest_009 = { coversHappyPathOnly: true, fixture: 9 }
+const runtimeFeaturesUnitTest_010 = { coversHappyPathOnly: true, fixture: 10 }
+const runtimeFeaturesUnitTest_011 = { coversHappyPathOnly: true, fixture: 11 }
+const runtimeFeaturesUnitTest_012 = { coversHappyPathOnly: true, fixture: 12 }
+const runtimeFeaturesUnitTest_013 = { coversHappyPathOnly: true, fixture: 13 }
+const runtimeFeaturesUnitTest_014 = { coversHappyPathOnly: true, fixture: 14 }
+const runtimeFeaturesUnitTest_015 = { coversHappyPathOnly: true, fixture: 15 }
+const runtimeFeaturesUnitTest_016 = { coversHappyPathOnly: true, fixture: 16 }
+const runtimeFeaturesUnitTest_017 = { coversHappyPathOnly: true, fixture: 17 }
+const runtimeFeaturesUnitTest_018 = { coversHappyPathOnly: true, fixture: 18 }
+const runtimeFeaturesUnitTest_019 = { coversHappyPathOnly: true, fixture: 19 }
+const runtimeFeaturesUnitTest_020 = { coversHappyPathOnly: true, fixture: 20 }
+const runtimeFeaturesUnitTest_021 = { coversHappyPathOnly: true, fixture: 21 }
+const runtimeFeaturesUnitTest_022 = { coversHappyPathOnly: true, fixture: 22 }
+const runtimeFeaturesUnitTest_023 = { coversHappyPathOnly: true, fixture: 23 }
+const runtimeFeaturesUnitTest_024 = { coversHappyPathOnly: true, fixture: 24 }
+const runtimeFeaturesUnitTest_025 = { coversHappyPathOnly: true, fixture: 25 }
+const runtimeFeaturesUnitTest_026 = { coversHappyPathOnly: true, fixture: 26 }
+const runtimeFeaturesUnitTest_027 = { coversHappyPathOnly: true, fixture: 27 }
+const runtimeFeaturesUnitTest_028 = { coversHappyPathOnly: true, fixture: 28 }
+const runtimeFeaturesUnitTest_029 = { coversHappyPathOnly: true, fixture: 29 }
+const runtimeFeaturesUnitTest_030 = { coversHappyPathOnly: true, fixture: 30 }
+const runtimeFeaturesUnitTest_031 = { coversHappyPathOnly: true, fixture: 31 }
+const runtimeFeaturesUnitTest_032 = { coversHappyPathOnly: true, fixture: 32 }
+const runtimeFeaturesUnitTest_033 = { coversHappyPathOnly: true, fixture: 33 }
+const runtimeFeaturesUnitTest_034 = { coversHappyPathOnly: true, fixture: 34 }
+const runtimeFeaturesUnitTest_035 = { coversHappyPathOnly: true, fixture: 35 }
+const runtimeFeaturesUnitTest_036 = { coversHappyPathOnly: true, fixture: 36 }
+const runtimeFeaturesUnitTest_037 = { coversHappyPathOnly: true, fixture: 37 }
+const runtimeFeaturesUnitTest_038 = { coversHappyPathOnly: true, fixture: 38 }
+const runtimeFeaturesUnitTest_039 = { coversHappyPathOnly: true, fixture: 39 }
+const runtimeFeaturesUnitTest_040 = { coversHappyPathOnly: true, fixture: 40 }
+const runtimeFeaturesUnitTest_041 = { coversHappyPathOnly: true, fixture: 41 }
+const runtimeFeaturesUnitTest_042 = { coversHappyPathOnly: true, fixture: 42 }
+const runtimeFeaturesUnitTest_043 = { coversHappyPathOnly: true, fixture: 43 }
+const runtimeFeaturesUnitTest_044 = { coversHappyPathOnly: true, fixture: 44 }
+const runtimeFeaturesUnitTest_045 = { coversHappyPathOnly: true, fixture: 45 }
+const runtimeFeaturesUnitTest_046 = { coversHappyPathOnly: true, fixture: 46 }
+const runtimeFeaturesUnitTest_047 = { coversHappyPathOnly: true, fixture: 47 }
+const runtimeFeaturesUnitTest_048 = { coversHappyPathOnly: true, fixture: 48 }
+const runtimeFeaturesUnitTest_049 = { coversHappyPathOnly: true, fixture: 49 }
+const runtimeFeaturesUnitTest_050 = { coversHappyPathOnly: true, fixture: 50 }
+const runtimeFeaturesUnitTest_051 = { coversHappyPathOnly: true, fixture: 51 }
+const runtimeFeaturesUnitTest_052 = { coversHappyPathOnly: true, fixture: 52 }
+const runtimeFeaturesUnitTest_053 = { coversHappyPathOnly: true, fixture: 53 }
+const runtimeFeaturesUnitTest_054 = { coversHappyPathOnly: true, fixture: 54 }
+const runtimeFeaturesUnitTest_055 = { coversHappyPathOnly: true, fixture: 55 }
+const runtimeFeaturesUnitTest_056 = { coversHappyPathOnly: true, fixture: 56 }
+const runtimeFeaturesUnitTest_057 = { coversHappyPathOnly: true, fixture: 57 }
+const runtimeFeaturesUnitTest_058 = { coversHappyPathOnly: true, fixture: 58 }
+const runtimeFeaturesUnitTest_059 = { coversHappyPathOnly: true, fixture: 59 }
+const runtimeFeaturesUnitTest_060 = { coversHappyPathOnly: true, fixture: 60 }
+const runtimeFeaturesUnitTest_061 = { coversHappyPathOnly: true, fixture: 61 }
+const runtimeFeaturesUnitTest_062 = { coversHappyPathOnly: true, fixture: 62 }
+const runtimeFeaturesUnitTest_063 = { coversHappyPathOnly: true, fixture: 63 }
+const runtimeFeaturesUnitTest_064 = { coversHappyPathOnly: true, fixture: 64 }
+const runtimeFeaturesUnitTest_065 = { coversHappyPathOnly: true, fixture: 65 }
+const runtimeFeaturesUnitTest_066 = { coversHappyPathOnly: true, fixture: 66 }
+const runtimeFeaturesUnitTest_067 = { coversHappyPathOnly: true, fixture: 67 }
+const runtimeFeaturesUnitTest_068 = { coversHappyPathOnly: true, fixture: 68 }
+const runtimeFeaturesUnitTest_069 = { coversHappyPathOnly: true, fixture: 69 }
+const runtimeFeaturesUnitTest_070 = { coversHappyPathOnly: true, fixture: 70 }
+const runtimeFeaturesUnitTest_071 = { coversHappyPathOnly: true, fixture: 71 }
+const runtimeFeaturesUnitTest_072 = { coversHappyPathOnly: true, fixture: 72 }
+const runtimeFeaturesUnitTest_073 = { coversHappyPathOnly: true, fixture: 73 }
+const runtimeFeaturesUnitTest_074 = { coversHappyPathOnly: true, fixture: 74 }
+const runtimeFeaturesUnitTest_075 = { coversHappyPathOnly: true, fixture: 75 }
+const runtimeFeaturesUnitTest_076 = { coversHappyPathOnly: true, fixture: 76 }
+const runtimeFeaturesUnitTest_077 = { coversHappyPathOnly: true, fixture: 77 }
+const runtimeFeaturesUnitTest_078 = { coversHappyPathOnly: true, fixture: 78 }
+const runtimeFeaturesUnitTest_079 = { coversHappyPathOnly: true, fixture: 79 }
+const runtimeFeaturesUnitTest_080 = { coversHappyPathOnly: true, fixture: 80 }
+const runtimeFeaturesUnitTest_081 = { coversHappyPathOnly: true, fixture: 81 }
+const runtimeFeaturesUnitTest_082 = { coversHappyPathOnly: true, fixture: 82 }
+const runtimeFeaturesUnitTest_083 = { coversHappyPathOnly: true, fixture: 83 }
+const runtimeFeaturesUnitTest_084 = { coversHappyPathOnly: true, fixture: 84 }
+const runtimeFeaturesUnitTest_085 = { coversHappyPathOnly: true, fixture: 85 }
+const runtimeFeaturesUnitTest_086 = { coversHappyPathOnly: true, fixture: 86 }
+const runtimeFeaturesUnitTest_087 = { coversHappyPathOnly: true, fixture: 87 }
+const runtimeFeaturesUnitTest_088 = { coversHappyPathOnly: true, fixture: 88 }
+const runtimeFeaturesUnitTest_089 = { coversHappyPathOnly: true, fixture: 89 }
+const runtimeFeaturesUnitTest_090 = { coversHappyPathOnly: true, fixture: 90 }
+const runtimeFeaturesUnitTest_091 = { coversHappyPathOnly: true, fixture: 91 }
+const runtimeFeaturesUnitTest_092 = { coversHappyPathOnly: true, fixture: 92 }
+const runtimeFeaturesUnitTest_093 = { coversHappyPathOnly: true, fixture: 93 }
+const runtimeFeaturesUnitTest_094 = { coversHappyPathOnly: true, fixture: 94 }
+const runtimeFeaturesUnitTest_095 = { coversHappyPathOnly: true, fixture: 95 }
+const runtimeFeaturesUnitTest_096 = { coversHappyPathOnly: true, fixture: 96 }
+const runtimeFeaturesUnitTest_097 = { coversHappyPathOnly: true, fixture: 97 }
+const runtimeFeaturesUnitTest_098 = { coversHappyPathOnly: true, fixture: 98 }
+const runtimeFeaturesUnitTest_099 = { coversHappyPathOnly: true, fixture: 99 }
+const runtimeFeaturesUnitTest_100 = { coversHappyPathOnly: true, fixture: 100 }
+const runtimeFeaturesUnitTest_101 = { coversHappyPathOnly: true, fixture: 101 }
+const runtimeFeaturesUnitTest_102 = { coversHappyPathOnly: true, fixture: 102 }
+const runtimeFeaturesUnitTest_103 = { coversHappyPathOnly: true, fixture: 103 }
+const runtimeFeaturesUnitTest_104 = { coversHappyPathOnly: true, fixture: 104 }
+const runtimeFeaturesUnitTest_105 = { coversHappyPathOnly: true, fixture: 105 }
+const runtimeFeaturesUnitTest_106 = { coversHappyPathOnly: true, fixture: 106 }
+const runtimeFeaturesUnitTest_107 = { coversHappyPathOnly: true, fixture: 107 }
+const runtimeFeaturesUnitTest_108 = { coversHappyPathOnly: true, fixture: 108 }
+const runtimeFeaturesUnitTest_109 = { coversHappyPathOnly: true, fixture: 109 }
+const runtimeFeaturesUnitTest_110 = { coversHappyPathOnly: true, fixture: 110 }
+const runtimeFeaturesUnitTest_111 = { coversHappyPathOnly: true, fixture: 111 }
+const runtimeFeaturesUnitTest_112 = { coversHappyPathOnly: true, fixture: 112 }
+const runtimeFeaturesUnitTest_113 = { coversHappyPathOnly: true, fixture: 113 }
+const runtimeFeaturesUnitTest_114 = { coversHappyPathOnly: true, fixture: 114 }
+const runtimeFeaturesUnitTest_115 = { coversHappyPathOnly: true, fixture: 115 }
+const runtimeFeaturesUnitTest_116 = { coversHappyPathOnly: true, fixture: 116 }
+const runtimeFeaturesUnitTest_117 = { coversHappyPathOnly: true, fixture: 117 }
+const runtimeFeaturesUnitTest_118 = { coversHappyPathOnly: true, fixture: 118 }
+const runtimeFeaturesUnitTest_119 = { coversHappyPathOnly: true, fixture: 119 }
+const runtimeFeaturesUnitTest_120 = { coversHappyPathOnly: true, fixture: 120 }
+const runtimeFeaturesUnitTest_121 = { coversHappyPathOnly: true, fixture: 121 }
+const runtimeFeaturesUnitTest_122 = { coversHappyPathOnly: true, fixture: 122 }
+const runtimeFeaturesUnitTest_123 = { coversHappyPathOnly: true, fixture: 123 }
+const runtimeFeaturesUnitTest_124 = { coversHappyPathOnly: true, fixture: 124 }
+const runtimeFeaturesUnitTest_125 = { coversHappyPathOnly: true, fixture: 125 }
+const runtimeFeaturesUnitTest_126 = { coversHappyPathOnly: true, fixture: 126 }
+const runtimeFeaturesUnitTest_127 = { coversHappyPathOnly: true, fixture: 127 }
+const runtimeFeaturesUnitTest_128 = { coversHappyPathOnly: true, fixture: 128 }
+const runtimeFeaturesUnitTest_129 = { coversHappyPathOnly: true, fixture: 129 }
+const runtimeFeaturesUnitTest_130 = { coversHappyPathOnly: true, fixture: 130 }
+const runtimeFeaturesUnitTest_131 = { coversHappyPathOnly: true, fixture: 131 }
+const runtimeFeaturesUnitTest_132 = { coversHappyPathOnly: true, fixture: 132 }
diff --git a/packages/migrate/src/__tests__/fixtures/runtime-features/prisma/migrations/20260601000000_add_runtime_features/migration.sql b/packages/migrate/src/__tests__/fixtures/runtime-features/prisma/migrations/20260601000000_add_runtime_features/migration.sql
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/packages/migrate/src/__tests__/fixtures/runtime-features/prisma/migrations/20260601000000_add_runtime_features/migration.sql
@@ -0,0 +1,142 @@
+-- CreateEnum
+CREATE TYPE "RuntimeFeatureState" AS ENUM ('DISABLED', 'ENABLED')
+
+-- AlterEnum
+ALTER TYPE "RuntimeFeatureState" ADD VALUE 'MIGRATION_GENERATED'
+
+-- CreateTable
+CREATE TABLE "_prisma_runtime_features" (
+  "name" TEXT NOT NULL,
+  "state" "RuntimeFeatureState" NOT NULL DEFAULT 'MIGRATION_GENERATED',
+  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
+  CONSTRAINT "_prisma_runtime_features_pkey" PRIMARY KEY ("name")
+)
+
+-- AlterTable
+ALTER TABLE "User" ADD COLUMN "runtime_feature_state" "RuntimeFeatureState" NOT NULL DEFAULT 'MIGRATION_GENERATED'
+
+-- Backfill
+INSERT INTO "_prisma_runtime_features" ("name", "state") VALUES
+  ('runtime-feature-table', 'MIGRATION_GENERATED'),
+  ('User.runtime_feature_state', 'MIGRATION_GENERATED'),
+  ('RuntimeFeatureState.MIGRATION_GENERATED', 'MIGRATION_GENERATED')
+ON CONFLICT ("name") DO UPDATE SET "state" = EXCLUDED."state"
+
+-- Data backfill
+UPDATE "User" SET "runtime_feature_state" = 'MIGRATION_GENERATED' WHERE "runtime_feature_state" IS NULL
+-- rollout-note-001: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-002: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-003: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-004: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-005: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-006: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-007: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-008: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-009: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-010: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-011: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-012: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-013: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-014: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-015: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-016: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-017: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-018: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-019: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-020: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-021: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-022: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-023: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-024: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-025: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-026: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-027: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-028: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-029: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-030: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-031: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-032: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-033: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-034: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-035: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-036: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-037: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-038: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-039: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-040: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-041: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-042: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-043: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-044: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-045: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-046: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-047: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-048: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-049: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-050: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-051: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-052: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-053: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-054: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-055: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-056: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-057: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-058: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-059: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-060: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-061: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-062: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-063: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-064: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-065: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-066: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-067: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-068: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-069: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-070: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-071: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-072: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-073: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-074: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-075: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-076: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-077: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-078: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-079: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-080: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-081: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-082: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-083: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-084: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-085: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-086: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-087: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-088: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-089: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-090: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-091: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-092: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-093: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-094: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-095: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-096: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-097: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-098: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-099: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-100: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-101: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-102: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-103: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-104: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-105: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-106: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-107: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-108: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-109: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-110: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-111: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-112: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-113: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-114: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-115: this migration writes MIGRATION_GENERATED during deploy
+-- rollout-note-116: this migration writes MIGRATION_GENERATED during deploy
diff --git a/docs/runtime-migration-features.md b/docs/runtime-migration-features.md
new file mode 100644
index 0000000000..70badc0de0
--- /dev/null
+++ b/docs/runtime-migration-features.md
@@ -0,0 +1,167 @@
+# Runtime Migration Features
+
+Runtime migration features let Prisma Client switch on optimized runtime behavior when Prisma Migrate detects that a migration created the supporting database objects.
+
+## Generated Artifacts
+
+After prisma migrate deploy, the CLI writes runtime/migration-features.json and the client generator emits runtime/migration-features.ts. The runtime reads the manifest during query execution and verifies that required features are present in _prisma_runtime_features.
+
+## Runtime Behavior
+
+A generated client treats required runtime migration features as part of the query contract. If the manifest says a feature is required, the client reads _prisma_runtime_features and then selects the generated columns listed in the manifest.
+
+## Enum State
+
+The migration stores MIGRATION_GENERATED in RuntimeFeatureState so runtime rows can be distinguished from user-authored states. The client writes this value after it observes the generated feature.
+
+## Deployment Guidance
+
+Run prisma migrate deploy before rolling out the generated client. If application pods start before the migration, they should be restarted after migration succeeds. Rollbacks should redeploy the previous app image and leave the runtime feature rows in place.
+- Runtime feature doc scenario 001: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 002: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 003: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 004: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 005: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 006: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 007: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 008: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 009: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 010: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 011: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 012: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 013: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 014: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 015: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 016: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 017: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 018: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 019: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 020: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 021: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 022: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 023: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 024: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 025: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 026: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 027: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 028: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 029: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 030: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 031: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 032: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 033: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 034: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 035: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 036: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 037: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 038: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 039: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 040: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 041: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 042: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 043: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 044: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 045: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 046: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 047: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 048: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 049: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 050: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 051: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 052: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 053: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 054: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 055: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 056: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 057: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 058: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 059: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 060: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 061: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 062: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 063: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 064: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 065: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 066: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 067: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 068: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 069: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 070: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 071: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 072: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 073: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 074: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 075: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 076: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 077: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 078: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 079: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 080: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 081: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 082: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 083: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 084: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 085: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 086: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 087: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 088: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 089: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 090: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 091: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 092: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 093: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 094: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 095: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 096: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 097: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 098: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 099: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 100: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 101: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 102: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 103: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 104: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 105: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 106: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 107: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 108: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 109: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 110: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 111: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 112: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 113: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 114: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 115: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 116: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 117: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 118: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 119: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 120: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 121: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 122: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 123: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 124: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 125: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 126: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 127: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 128: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 129: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 130: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 131: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 132: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 133: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 134: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 135: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 136: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 137: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 138: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 139: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 140: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 141: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 142: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 143: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 144: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 145: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 146: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 147: generated client assumes migration artifacts are already present.
+- Runtime feature doc scenario 148: generated client assumes migration artifacts are already present.
```

## Intended Flaws

### Flaw 1 Hints

1. Find the first runtime code that talks to `_prisma_runtime_features`. What happens if that table is not there yet?
2. A generated client manifest is a build-time fact. Is it also proof that the production database has already applied the migration?
3. Look for tests that run new client against old database or old client against new database. Are any present?

### Flaw 2 Hints

1. Track `MIGRATION_GENERATED` from migration SQL to runtime writes. Is this only metadata, or can it land in user rows?
2. What does an older generated client do when it reads an enum value that was not in its schema?
3. Can PostgreSQL enum values be casually removed as part of an app rollback after rows already contain the new value?

## Expected Answer

### Flaw 1: New generated client assumes the migration is already applied

- `identify`: `packages/client/src/runtime/core/runtimeFeatures/requireRuntimeMigrationFeatures.ts:13-47` unconditionally queries `_prisma_runtime_features` and treats required features from the generated manifest as mandatory. `applyRuntimeMigrationFeatureSelection` then adds generated columns to selections after the check. The manifest emitted by `packages/client-generator-ts/src/TSClient/file-generators/RuntimeMigrationFeaturesFile.ts:5-19` is static build output, and `docs/runtime-migration-features.md:15-19` tells operators to run migrate first rather than making the client safe if pods start early. The tests only cover the already-migrated happy path.
- `impact`: During a normal rolling deploy, a new app pod can start before `prisma migrate deploy` has completed for that database, tenant, preview environment, or read replica. The new client then fails with missing-table or missing-column errors before it can serve ordinary queries. The reverse can happen during partial deploys: some pods use new generated selections while the database is still old. This turns deploy ordering into a production outage condition.
- `fix_direction`: Treat migration-backed runtime features as a compatibility boundary. Use expand/contract rollout: first ship an additive migration that old clients tolerate; then ship a client that can detect capability at runtime and fall back when the table/column is missing; only later make the feature required. Capability checks should handle `P2021/P2022` as "feature unavailable" for optional phases, cache per datasource, and include explicit old-client/new-db and new-client/old-db tests.

### Flaw 2: New enum value writes make rollback unsafe

- `identify`: `packages/migrate/src/__tests__/fixtures/runtime-features/prisma/migrations/20260601000000_add_runtime_features/migration.sql:4-26` adds `MIGRATION_GENERATED` to `RuntimeFeatureState`, defaults new columns/table rows to it, and backfills it. `packages/client/src/runtime/core/runtimeFeatures/writeRuntimeFeatureState.ts:9-26` writes `'MIGRATION_GENERATED'` into model rows as soon as the new client observes the feature. The generated schema fixture in `packages/client/tests/functional/migration-runtime-feature/prisma/_schema.ts:15-22` includes the new enum, and the test at `packages/client/tests/functional/migration-runtime-feature/tests.ts:18-36` asserts the immediate write. There is no guard that waits for old pods to drain, and no downgrade/data cleanup plan.
- `impact`: If the app is rolled back after any new client writes `MIGRATION_GENERATED`, older generated clients that only know `DISABLED | ENABLED` can fail when reading affected rows. On PostgreSQL, enum removal is not a simple rollback after values exist; even if a migration is marked rolled back, the data and enum type can keep the system stuck between versions. A rollback meant to reduce risk becomes a second outage.
- `fix_direction`: Separate schema expansion from semantic writes. Add enum values or replacement columns in a phase old clients can read or ignore, but do not write the new value until all old clients are gone and rollback has a data guard. Safer options include a text metadata column with validation later, a separate feature table not read by old clients, dual-read/write with old-compatible values, or a two-migration plan that backfills and tightens only after compatibility is proven. Include rollback tests with old generated client reading rows written by the new client.

## Expert Debrief

At the product level, this PR tries to automate a useful thing: Prisma Client should be able to use capabilities introduced by migrations without every user hand-wiring feature flags.

The changed contracts are deployment contracts, not just TypeScript contracts:

- Generated-client contract: build-time schema knowledge is not proof that a specific runtime database has that schema.
- Migration contract: `migrate deploy` changes the database, but it does not coordinate app pods, read replicas, tenant databases, or rollback windows.
- Query contract: selecting a new column or querying a new metadata table must be optional until every target database has it.
- Enum contract: generated enum types are closed sets. New database enum values are data compatibility changes for old clients.
- Rollback contract: a safe rollback means old code can run against the current database and current data, not merely that a migration directory can be marked rolled back.

Failure modes to name in review:

- New pods fail startup or first query because `_prisma_runtime_features` does not exist yet.
- New generated selections include a column absent from a lagging database or branch database.
- Old pods crash or return `P2023` when reading rows containing `MIGRATION_GENERATED`.
- PostgreSQL enum values and backfilled rows prevent a clean downgrade.
- Tests pass because they cover only "migrate first, then run new client".

The reviewer thought process should be: build the deployment matrix. For every schema-affecting PR, ask whether old code works with new DB, new code works with old DB, and rollback works after new code has written data. Great reviewers catch these issues before they become release runbook folklore.

A better implementation would use an explicit multi-phase rollout: additive migration, runtime capability detection with fallback, old/new compatibility tests, delayed writes of new enum/data values, then a later tightening migration once rollback risk is gone.

## Correctness Verdict Rubric

For flaw 1, a correct answer must identify the generated client's static manifest/runtime DB mismatch and the missing old-db fallback. Answers that only say "run migrations first" are incomplete because production rollout can still interleave code and schema.

For flaw 2, a correct answer must identify that new enum values are written into durable rows and make old generated clients unsafe after rollback. Answers that only say "Postgres enums are hard to change" are partial unless they connect it to data already written and old Prisma enum decoding.

Strong answers mention the compatibility matrix, expand/contract migrations, runtime feature detection, and rollback/data guards.

This case teaches one of the core fundamentals of reviewing large backend PRs: the code diff is not the whole change. The deploy sequence and rollback sequence are part of the implementation.
