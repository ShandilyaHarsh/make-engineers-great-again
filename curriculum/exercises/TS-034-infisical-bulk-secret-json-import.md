# TS-034: Infisical Bulk Secret JSON Import

## Metadata

- `id`: TS-034
- `source_repo`: [Infisical/infisical](https://github.com/Infisical/infisical)
- `repo_area`: secret import contracts, raw secret service boundaries, secret approval policies, bulk create/update APIs, audit logging, API response schemas, service tests
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,250-1,600
- `represented_diff_lines`: 1588
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Infisical secret approval policies, import idempotency, duplicate-key semantics, bulk write routing, audit contracts, and governance failure modes without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a JSON import endpoint for bulk importing shared secrets into Infisical.

Teams often migrate from `.env` files, platform exports, or other secret managers. Today they have to paste secrets one at a time or script against the existing batch APIs. This change adds a higher-level JSON import flow that accepts both object and array-shaped payloads, supports dry-run previews, groups entries by environment and path, and creates or updates secrets in bulk.

The new work includes:

- `POST /api/v4/secrets/json-import` for committing an import,
- `POST /api/v4/secrets/json-import/preview` for dry-run planning,
- support for object and array JSON formats,
- per-entry environment/path overrides,
- import modes for upsert, create-only, and update-only,
- conflict strategies for existing secrets,
- audit and telemetry events,
- service tests for object imports, duplicate keys, dry runs, protected paths, grouping, and validation.

The intended product behavior is: JSON import should be a safer convenience wrapper over the existing secret write system, not a separate bypass around Infisical secret governance.

## Existing Code Context

The real Infisical codebase already has these relevant contracts:

- `backend/src/server/routes/v4/secret-router.ts` exposes existing raw single-secret and bulk-secret routes. The bulk create route calls `server.services.secret.createManySecretsRaw(...)`; the bulk update route calls `server.services.secret.updateManySecretsRaw(...)`.
- Those existing bulk routes return either `{ secrets }` or `{ approval }`. When secret protection applies, they emit `EventType.SECRET_APPROVAL_REQUEST` with `SecretApprovalEvent.CreateMany` or `SecretApprovalEvent.UpdateMany` instead of writing directly.
- `backend/src/services/secret/secret-service.ts` owns the raw secret write boundary. `createManySecretsRaw` and `updateManySecretsRaw` call `secretApprovalPolicyService.getSecretApprovalPolicy(projectId, environment, secretPath)` for user actors, then route protected writes into `secretApprovalRequestService.generateSecretApprovalRequest...`.
- The same service also enforces project capitalization rules, bot-key requirements, bridge-vs-legacy behavior, reminder side effects, and raw secret payload normalization.
- `backend/src/ee/services/secret-approval-policy/secret-approval-policy-service.ts` resolves the applicable approval policy by environment and secret path, including exact and glob path matching.
- `backend/src/ee/services/secret-approval-request/secret-approval-request-service.ts` creates approval commits and checks project permissions for the protected change.
- `backend/src/services/secret-import/secret-import-service.ts` is about importing secrets from one Infisical environment/path into another; it still checks destination permissions and source read/describe permissions. It is not a JSON bulk write replacement.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether this import endpoint preserves Infisical secret-write contracts and gives operators a safe import workflow.

## Review Surface

Changed files in the synthetic PR:

- `backend/src/services/secret-json-import/secret-json-import-types.ts`
- `backend/src/services/secret-json-import/secret-json-import-service.ts`
- `backend/src/server/routes/v4/secret-json-import-router.ts`
- `backend/src/server/routes/v4/secret-json-import-registration.ts`
- `backend/src/services/secret-json-import/secret-json-import-service.test.ts`
- `docs/api/secret-json-import.openapi.yaml`

The line references below use synthetic PR line numbers. The represented diff is focused on import contracts, duplicate target semantics, approval-policy routing, audit shape, and tests.

## Diff

```diff
diff --git a/backend/src/services/secret-json-import/secret-json-import-types.ts b/backend/src/services/secret-json-import/secret-json-import-types.ts
new file mode 100644
index 0000000000..d7f4a8c215
--- /dev/null
+++ b/backend/src/services/secret-json-import/secret-json-import-types.ts
@@ -0,0 +1,283 @@
+import { z } from "zod";
+
+import { SecretUpdateMode } from "@app/services/secret-v2-bridge/secret-v2-bridge-types";
+
+export const SecretJsonImportSourceSchema = z.enum(["object", "array", "dotenv-json", "infisical-export"]);
+
+export const SecretJsonImportModeSchema = z.enum(["upsert", "create-only", "update-only"]);
+
+export const SecretJsonImportConflictStrategySchema = z.enum([
+  "overwrite-existing",
+  "skip-existing",
+  "fail-existing"
+]);
+
+export const SecretJsonImportEntrySchema = z.object({
+  key: z.string().trim().min(1).max(512),
+  value: z.string().default(""),
+  comment: z.string().trim().max(10_000).optional(),
+  environment: z.string().trim().min(1).max(128).optional(),
+  path: z.string().trim().min(1).max(1024).optional(),
+  tags: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
+  metadata: z.record(z.string()).optional(),
+  secretMetadata: z
+    .array(
+      z.object({
+        key: z.string().trim().min(1).max(256),
+        value: z.string().max(10_000),
+        isEncrypted: z.boolean().default(false)
+      })
+    )
+    .max(64)
+    .optional(),
+  skipMultilineEncoding: z.boolean().nullish()
+});
+
+export const SecretJsonImportObjectSchema = z.record(
+  z.union([
+    z.string(),
+    z.number(),
+    z.boolean(),
+    z.null(),
+    z.object({
+      value: z.union([z.string(), z.number(), z.boolean(), z.null()]).default(""),
+      comment: z.string().optional(),
+      environment: z.string().optional(),
+      path: z.string().optional(),
+      tags: z.array(z.string()).optional(),
+      metadata: z.record(z.string()).optional(),
+      skipMultilineEncoding: z.boolean().nullish()
+    })
+  ])
+);
+
+export const SecretJsonImportBodySchema = z.object({
+  projectId: z.string().trim().min(1),
+  environment: z.string().trim().min(1),
+  secretPath: z.string().trim().default("/"),
+  mode: SecretJsonImportModeSchema.default("upsert"),
+  conflictStrategy: SecretJsonImportConflictStrategySchema.default("overwrite-existing"),
+  dryRun: z.boolean().default(false),
+  source: SecretJsonImportSourceSchema.default("array"),
+  importName: z.string().trim().max(200).optional(),
+  secrets: z.union([z.array(SecretJsonImportEntrySchema), SecretJsonImportObjectSchema])
+});
+
+export const SecretJsonImportPreviewQuerySchema = z.object({
+  projectId: z.string().trim().min(1),
+  environment: z.string().trim().min(1),
+  secretPath: z.string().trim().default("/"),
+  mode: SecretJsonImportModeSchema.default("upsert"),
+  conflictStrategy: SecretJsonImportConflictStrategySchema.default("overwrite-existing")
+});
+
+export type TSecretJsonImportBody = z.infer<typeof SecretJsonImportBodySchema>;
+export type TSecretJsonImportEntry = z.infer<typeof SecretJsonImportEntrySchema>;
+export type TSecretJsonImportMode = z.infer<typeof SecretJsonImportModeSchema>;
+export type TSecretJsonImportConflictStrategy = z.infer<typeof SecretJsonImportConflictStrategySchema>;
+
+export type TSecretJsonImportActor = {
+  actor: string;
+  actorId: string;
+  actorOrgId: string;
+  actorAuthMethod: string;
+};
+
+export type TSecretJsonImportInput = TSecretJsonImportActor & TSecretJsonImportBody;
+
+export type TSecretJsonImportTarget = {
+  projectId: string;
+  environment: string;
+  secretPath: string;
+  secretKey: string;
+};
+
+export type TNormalizedSecretJsonImportEntry = TSecretJsonImportTarget & {
+  index: number;
+  sourceKey: string;
+  secretValue: string;
+  secretComment?: string;
+  tagIds?: string[];
+  metadata?: Record<string, string>;
+  secretMetadata?: Array<{ key: string; value: string; isEncrypted: boolean }>;
+  skipMultilineEncoding?: boolean | null;
+};
+
+export type TSecretJsonImportExistingSecret = {
+  id: string;
+  secretKey: string;
+  secretPath: string;
+  environment: string;
+  version: number;
+};
+
+export type TSecretJsonImportPlanItem = TNormalizedSecretJsonImportEntry & {
+  operation: "create" | "update" | "skip";
+  existingSecretId?: string;
+  existingVersion?: number;
+  reason?: string;
+};
+
+export type TSecretJsonImportPlanGroup = {
+  environment: string;
+  secretPath: string;
+  creates: TSecretJsonImportPlanItem[];
+  updates: TSecretJsonImportPlanItem[];
+  skipped: TSecretJsonImportPlanItem[];
+};
+
+export type TSecretJsonImportPlan = {
+  projectId: string;
+  mode: TSecretJsonImportMode;
+  conflictStrategy: TSecretJsonImportConflictStrategy;
+  totalInputCount: number;
+  totalNormalizedCount: number;
+  createCount: number;
+  updateCount: number;
+  skippedCount: number;
+  groups: TSecretJsonImportPlanGroup[];
+};
+
+export type TSecretJsonImportResult = {
+  projectId: string;
+  importName?: string;
+  dryRun: boolean;
+  mode: TSecretJsonImportMode;
+  conflictStrategy: TSecretJsonImportConflictStrategy;
+  totalInputCount: number;
+  totalNormalizedCount: number;
+  createCount: number;
+  updateCount: number;
+  skippedCount: number;
+  createdSecretIds: string[];
+  updatedSecretIds: string[];
+  skipped: Array<{ secretKey: string; environment: string; secretPath: string; reason?: string }>;
+  groups: Array<{ environment: string; secretPath: string; createCount: number; updateCount: number; skippedCount: number }>;
+};
+
+export const SecretJsonImportResponseSchema = z.object({
+  projectId: z.string(),
+  importName: z.string().optional(),
+  dryRun: z.boolean(),
+  mode: SecretJsonImportModeSchema,
+  conflictStrategy: SecretJsonImportConflictStrategySchema,
+  totalInputCount: z.number(),
+  totalNormalizedCount: z.number(),
+  createCount: z.number(),
+  updateCount: z.number(),
+  skippedCount: z.number(),
+  createdSecretIds: z.array(z.string()),
+  updatedSecretIds: z.array(z.string()),
+  skipped: z.array(
+    z.object({
+      secretKey: z.string(),
+      environment: z.string(),
+      secretPath: z.string(),
+      reason: z.string().optional()
+    })
+  ),
+  groups: z.array(
+    z.object({
+      environment: z.string(),
+      secretPath: z.string(),
+      createCount: z.number(),
+      updateCount: z.number(),
+      skippedCount: z.number()
+    })
+  )
+});
+
+export const SecretJsonImportPreviewResponseSchema = z.object({
+  plan: z.object({
+    projectId: z.string(),
+    mode: SecretJsonImportModeSchema,
+    conflictStrategy: SecretJsonImportConflictStrategySchema,
+    totalInputCount: z.number(),
+    totalNormalizedCount: z.number(),
+    createCount: z.number(),
+    updateCount: z.number(),
+    skippedCount: z.number(),
+    groups: z.array(
+      z.object({
+        environment: z.string(),
+        secretPath: z.string(),
+        creates: z.array(z.any()),
+        updates: z.array(z.any()),
+        skipped: z.array(z.any())
+      })
+    )
+  })
+});
+
+export const coerceImportValue = (value: unknown): string => {
+  if (value === null || value === undefined) return "";
+  if (typeof value === "string") return value;
+  if (typeof value === "number" || typeof value === "boolean") return String(value);
+  return JSON.stringify(value);
+};
+
+export const normalizeImportPath = (value?: string) => {
+  if (!value) return "/";
+  const trimmed = value.trim();
+  if (!trimmed || trimmed === "/") return "/";
+  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
+  return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
+};
+
+export const secretJsonImportUpdateMode = (mode: TSecretJsonImportMode, conflictStrategy: TSecretJsonImportConflictStrategy) => {
+  if (mode === "create-only") return SecretUpdateMode.FailOnNotFound;
+  if (conflictStrategy === "skip-existing") return SecretUpdateMode.FailOnNotFound;
+  return SecretUpdateMode.Upsert;
+};
+
+export const secretJsonImportTargetKey = (target: TSecretJsonImportTarget) =>
+  [target.projectId, target.environment, normalizeImportPath(target.secretPath), target.secretKey].join("::");
+
+export const secretJsonImportGroupKey = (target: Pick<TSecretJsonImportTarget, "environment" | "secretPath">) =>
+  [target.environment, normalizeImportPath(target.secretPath)].join("::");
+
+export const emptySecretJsonImportResult = (input: TSecretJsonImportInput): TSecretJsonImportResult => ({
+  projectId: input.projectId,
+  importName: input.importName,
+  dryRun: input.dryRun,
+  mode: input.mode,
+  conflictStrategy: input.conflictStrategy,
+  totalInputCount: 0,
+  totalNormalizedCount: 0,
+  createCount: 0,
+  updateCount: 0,
+  skippedCount: 0,
+  createdSecretIds: [],
+  updatedSecretIds: [],
+  skipped: [],
+  groups: []
+});
+
+export const serializeSecretJsonImportPlan = (plan: TSecretJsonImportPlan): TSecretJsonImportResult => ({
+  projectId: plan.projectId,
+  dryRun: true,
+  mode: plan.mode,
+  conflictStrategy: plan.conflictStrategy,
+  totalInputCount: plan.totalInputCount,
+  totalNormalizedCount: plan.totalNormalizedCount,
+  createCount: plan.createCount,
+  updateCount: plan.updateCount,
+  skippedCount: plan.skippedCount,
+  createdSecretIds: [],
+  updatedSecretIds: [],
+  skipped: plan.groups.flatMap((group) =>
+    group.skipped.map((item) => ({
+      secretKey: item.secretKey,
+      environment: group.environment,
+      secretPath: group.secretPath,
+      reason: item.reason
+    }))
+  ),
+  groups: plan.groups.map((group) => ({
+    environment: group.environment,
+    secretPath: group.secretPath,
+    createCount: group.creates.length,
+    updateCount: group.updates.length,
+    skippedCount: group.skipped.length
+  }))
+});
diff --git a/backend/src/services/secret-json-import/secret-json-import-service.ts b/backend/src/services/secret-json-import/secret-json-import-service.ts
new file mode 100644
index 0000000000..d7f4a8c215
--- /dev/null
+++ b/backend/src/services/secret-json-import/secret-json-import-service.ts
@@ -0,0 +1,495 @@
+import { ForbiddenError, subject } from "@casl/ability";
+
+import { ActionProjectType } from "@app/db/schemas";
+import { ProjectPermissionActions, ProjectPermissionSub } from "@app/ee/services/permission/project-permission";
+import { TPermissionServiceFactory } from "@app/ee/services/permission/permission-service-types";
+import { BadRequestError, NotFoundError } from "@app/lib/errors";
+import { removeTrailingSlash } from "@app/lib/fn";
+import { ActorType } from "@app/services/auth/auth-type";
+import { TFolderDALFactory } from "@app/services/secret-folder/secret-folder-dal";
+import { TProjectDALFactory } from "@app/services/project/project-dal";
+import { TProjectBotServiceFactory } from "@app/services/project-bot/project-bot-service";
+import { TProjectEnvDALFactory } from "@app/services/project-env/project-env-dal";
+import { TSecretV2BridgeDALFactory } from "@app/services/secret-v2-bridge/secret-v2-bridge-dal";
+import { TSecretV2BridgeServiceFactory } from "@app/services/secret-v2-bridge/secret-v2-bridge-service";
+
+import {
+  TNormalizedSecretJsonImportEntry,
+  TSecretJsonImportExistingSecret,
+  TSecretJsonImportInput,
+  TSecretJsonImportPlan,
+  TSecretJsonImportPlanGroup,
+  TSecretJsonImportPlanItem,
+  TSecretJsonImportResult,
+  coerceImportValue,
+  normalizeImportPath,
+  secretJsonImportGroupKey,
+  secretJsonImportTargetKey,
+  secretJsonImportUpdateMode,
+  serializeSecretJsonImportPlan
+} from "./secret-json-import-types";
+
+export type TSecretJsonImportServiceFactoryDep = {
+  permissionService: Pick<TPermissionServiceFactory, "getProjectPermission">;
+  projectDAL: Pick<TProjectDALFactory, "findById" | "checkProjectUpgradeStatus">;
+  projectBotService: Pick<TProjectBotServiceFactory, "getBotKey">;
+  projectEnvDAL: Pick<TProjectEnvDALFactory, "findBySlugs">;
+  folderDAL: Pick<TFolderDALFactory, "findBySecretPath">;
+  secretV2BridgeDAL: Pick<TSecretV2BridgeDALFactory, "find">;
+  secretV2BridgeService: Pick<TSecretV2BridgeServiceFactory, "createManySecret" | "updateManySecret">;
+};
+
+export type TSecretJsonImportServiceFactory = ReturnType<typeof secretJsonImportServiceFactory>;
+
+const toImportEntryArray = (input: TSecretJsonImportInput) => {
+  if (Array.isArray(input.secrets)) {
+    return input.secrets.map((entry, index) => ({
+      key: entry.key,
+      value: entry.value,
+      comment: entry.comment,
+      environment: entry.environment,
+      path: entry.path,
+      tags: entry.tags,
+      metadata: entry.metadata,
+      secretMetadata: entry.secretMetadata,
+      skipMultilineEncoding: entry.skipMultilineEncoding,
+      index
+    }));
+  }
+
+  return Object.entries(input.secrets).map(([key, raw], index) => {
+    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
+      return {
+        key,
+        value: coerceImportValue((raw as { value?: unknown }).value),
+        comment: (raw as { comment?: string }).comment,
+        environment: (raw as { environment?: string }).environment,
+        path: (raw as { path?: string }).path,
+        tags: (raw as { tags?: string[] }).tags,
+        metadata: (raw as { metadata?: Record<string, string> }).metadata,
+        skipMultilineEncoding: (raw as { skipMultilineEncoding?: boolean | null }).skipMultilineEncoding,
+        index
+      };
+    }
+
+    return {
+      key,
+      value: coerceImportValue(raw),
+      index
+    };
+  });
+};
+
+const normalizeSecretKey = (value: string) => value.trim();
+
+const makeTarget = (input: TSecretJsonImportInput, entry: { key: string; environment?: string; path?: string }) => ({
+  projectId: input.projectId,
+  environment: entry.environment?.trim() || input.environment,
+  secretPath: normalizeImportPath(entry.path ?? input.secretPath),
+  secretKey: normalizeSecretKey(entry.key)
+});
+
+const normalizeImportEntries = (input: TSecretJsonImportInput): TNormalizedSecretJsonImportEntry[] => {
+  const entries = toImportEntryArray(input);
+  const byTarget = new Map<string, TNormalizedSecretJsonImportEntry>();
+
+  for (const entry of entries) {
+    const target = makeTarget(input, entry);
+    const fingerprint = secretJsonImportTargetKey(target);
+    const normalized: TNormalizedSecretJsonImportEntry = {
+      ...target,
+      index: entry.index,
+      sourceKey: entry.key,
+      secretValue: coerceImportValue(entry.value),
+      secretComment: entry.comment,
+      tagIds: entry.tags,
+      metadata: entry.metadata,
+      secretMetadata: entry.secretMetadata,
+      skipMultilineEncoding: entry.skipMultilineEncoding
+    };
+
+    byTarget.set(fingerprint, normalized);
+  }
+
+  return [...byTarget.values()].sort((a, b) => {
+    const envOrder = a.environment.localeCompare(b.environment);
+    if (envOrder !== 0) return envOrder;
+    const pathOrder = a.secretPath.localeCompare(b.secretPath);
+    if (pathOrder !== 0) return pathOrder;
+    return a.secretKey.localeCompare(b.secretKey);
+  });
+};
+
+const assertKnownProjectAndFolder = async ({
+  projectDAL,
+  projectEnvDAL,
+  folderDAL,
+  projectId,
+  groups
+}: {
+  projectDAL: Pick<TProjectDALFactory, "findById" | "checkProjectUpgradeStatus">;
+  projectEnvDAL: Pick<TProjectEnvDALFactory, "findBySlugs">;
+  folderDAL: Pick<TFolderDALFactory, "findBySecretPath">;
+  projectId: string;
+  groups: Array<{ environment: string; secretPath: string }>;
+}) => {
+  const project = await projectDAL.findById(projectId);
+  if (!project) throw new NotFoundError({ message: `Project with ID ${projectId} not found` });
+
+  await projectDAL.checkProjectUpgradeStatus(projectId);
+
+  const envSlugs = [...new Set(groups.map((group) => group.environment))];
+  const envs = await projectEnvDAL.findBySlugs(projectId, envSlugs);
+  const foundEnvSlugs = new Set(envs.map((env) => env.slug));
+  const missing = envSlugs.filter((slug) => !foundEnvSlugs.has(slug));
+  if (missing.length) {
+    throw new NotFoundError({ message: `One or more environments were not found: ${missing.join(", ")}` });
+  }
+
+  for (const group of groups) {
+    const folder = await folderDAL.findBySecretPath(projectId, group.environment, group.secretPath);
+    if (!folder) {
+      throw new NotFoundError({
+        message: `Folder with path ${group.secretPath} in environment ${group.environment} was not found`
+      });
+    }
+  }
+};
+
+const requireImportPermission = async ({
+  permissionService,
+  input,
+  groups
+}: {
+  permissionService: Pick<TPermissionServiceFactory, "getProjectPermission">;
+  input: TSecretJsonImportInput;
+  groups: Array<{ environment: string; secretPath: string }>; 
+}) => {
+  const { permission } = await permissionService.getProjectPermission({
+    actor: input.actor as ActorType,
+    actorId: input.actorId,
+    actorOrgId: input.actorOrgId,
+    actorAuthMethod: input.actorAuthMethod,
+    projectId: input.projectId,
+    actionProjectType: ActionProjectType.SecretManager
+  });
+
+  for (const group of groups) {
+    ForbiddenError.from(permission).throwUnlessCan(
+      input.mode === "update-only" ? ProjectPermissionActions.Edit : ProjectPermissionActions.Create,
+      subject(ProjectPermissionSub.Secrets, {
+        environment: group.environment,
+        secretPath: group.secretPath
+      })
+    );
+  }
+};
+
+const groupNormalizedEntries = (entries: TNormalizedSecretJsonImportEntry[]) => {
+  const groups = new Map<string, TNormalizedSecretJsonImportEntry[]>();
+
+  for (const entry of entries) {
+    const groupKey = secretJsonImportGroupKey(entry);
+    const existing = groups.get(groupKey);
+    if (existing) existing.push(entry);
+    else groups.set(groupKey, [entry]);
+  }
+
+  return [...groups.entries()].map(([key, groupEntries]) => {
+    const [environment, secretPath] = key.split("::");
+    return { environment, secretPath, entries: groupEntries };
+  });
+};
+
+const readExistingSecrets = async ({
+  secretV2BridgeDAL,
+  projectId,
+  groups
+}: {
+  secretV2BridgeDAL: Pick<TSecretV2BridgeDALFactory, "find">;
+  projectId: string;
+  groups: ReturnType<typeof groupNormalizedEntries>;
+}) => {
+  const existingByTarget = new Map<string, TSecretJsonImportExistingSecret>();
+
+  for (const group of groups) {
+    const keys = group.entries.map((entry) => entry.secretKey);
+    const existingSecrets = await secretV2BridgeDAL.find({
+      projectId,
+      envSlug: group.environment,
+      path: group.secretPath,
+      $in: { key: keys }
+    });
+
+    for (const existing of existingSecrets) {
+      existingByTarget.set(
+        secretJsonImportTargetKey({
+          projectId,
+          environment: group.environment,
+          secretPath: group.secretPath,
+          secretKey: existing.key
+        }),
+        {
+          id: existing.id,
+          secretKey: existing.key,
+          secretPath: group.secretPath,
+          environment: group.environment,
+          version: existing.version
+        }
+      );
+    }
+  }
+
+  return existingByTarget;
+};
+
+const classifyPlanItem = ({
+  input,
+  entry,
+  existing
+}: {
+  input: TSecretJsonImportInput;
+  entry: TNormalizedSecretJsonImportEntry;
+  existing?: TSecretJsonImportExistingSecret;
+}): TSecretJsonImportPlanItem => {
+  if (input.mode === "create-only" && existing) {
+    return { ...entry, operation: "skip", existingSecretId: existing.id, existingVersion: existing.version, reason: "exists" };
+  }
+
+  if (input.mode === "update-only" && !existing) {
+    return { ...entry, operation: "skip", reason: "missing" };
+  }
+
+  if (existing && input.conflictStrategy === "skip-existing") {
+    return { ...entry, operation: "skip", existingSecretId: existing.id, existingVersion: existing.version, reason: "exists" };
+  }
+
+  if (existing && input.conflictStrategy === "fail-existing") {
+    throw new BadRequestError({ message: `Secret ${entry.secretKey} already exists in ${entry.environment}${entry.secretPath}` });
+  }
+
+  if (existing) {
+    return { ...entry, operation: "update", existingSecretId: existing.id, existingVersion: existing.version };
+  }
+
+  return { ...entry, operation: "create" };
+};
+
+const buildImportPlan = async ({
+  input,
+  secretV2BridgeDAL
+}: {
+  input: TSecretJsonImportInput;
+  secretV2BridgeDAL: Pick<TSecretV2BridgeDALFactory, "find">;
+}): Promise<TSecretJsonImportPlan> => {
+  const normalized = normalizeImportEntries(input);
+  const grouped = groupNormalizedEntries(normalized);
+  const existingByTarget = await readExistingSecrets({ secretV2BridgeDAL, projectId: input.projectId, groups: grouped });
+
+  const planGroups: TSecretJsonImportPlanGroup[] = [];
+  let createCount = 0;
+  let updateCount = 0;
+  let skippedCount = 0;
+
+  for (const group of grouped) {
+    const creates: TSecretJsonImportPlanItem[] = [];
+    const updates: TSecretJsonImportPlanItem[] = [];
+    const skipped: TSecretJsonImportPlanItem[] = [];
+
+    for (const entry of group.entries) {
+      const item = classifyPlanItem({
+        input,
+        entry,
+        existing: existingByTarget.get(secretJsonImportTargetKey(entry))
+      });
+
+      if (item.operation === "create") {
+        creates.push(item);
+        createCount += 1;
+      } else if (item.operation === "update") {
+        updates.push(item);
+        updateCount += 1;
+      } else {
+        skipped.push(item);
+        skippedCount += 1;
+      }
+    }
+
+    planGroups.push({
+      environment: group.environment,
+      secretPath: group.secretPath,
+      creates,
+      updates,
+      skipped
+    });
+  }
+
+  return {
+    projectId: input.projectId,
+    mode: input.mode,
+    conflictStrategy: input.conflictStrategy,
+    totalInputCount: toImportEntryArray(input).length,
+    totalNormalizedCount: normalized.length,
+    createCount,
+    updateCount,
+    skippedCount,
+    groups: planGroups
+  };
+};
+
+const toCreatePayload = (items: TSecretJsonImportPlanItem[]) =>
+  items.map((item) => ({
+    secretKey: item.secretKey,
+    secretValue: item.secretValue,
+    secretComment: item.secretComment,
+    tagIds: item.tagIds,
+    metadata: item.metadata,
+    secretMetadata: item.secretMetadata,
+    skipMultilineEncoding: item.skipMultilineEncoding
+  }));
+
+const toUpdatePayload = (items: TSecretJsonImportPlanItem[]) =>
+  items.map((item) => ({
+    secretKey: item.secretKey,
+    secretValue: item.secretValue,
+    secretComment: item.secretComment,
+    tagIds: item.tagIds,
+    secretMetadata: item.secretMetadata,
+    skipMultilineEncoding: item.skipMultilineEncoding
+  }));
+
+const commitImportPlan = async ({
+  input,
+  plan,
+  secretV2BridgeService
+}: {
+  input: TSecretJsonImportInput;
+  plan: TSecretJsonImportPlan;
+  secretV2BridgeService: Pick<TSecretV2BridgeServiceFactory, "createManySecret" | "updateManySecret">;
+}): Promise<TSecretJsonImportResult> => {
+  const createdSecretIds: string[] = [];
+  const updatedSecretIds: string[] = [];
+
+  for (const group of plan.groups) {
+    if (group.creates.length > 0) {
+      const created = await secretV2BridgeService.createManySecret({
+        projectId: input.projectId,
+        environment: group.environment,
+        secretPath: group.secretPath,
+        actor: input.actor as ActorType,
+        actorId: input.actorId,
+        actorOrgId: input.actorOrgId,
+        actorAuthMethod: input.actorAuthMethod,
+        secrets: toCreatePayload(group.creates)
+      });
+
+      createdSecretIds.push(...created.map((secret) => secret.id));
+    }
+
+    if (group.updates.length > 0) {
+      const updated = await secretV2BridgeService.updateManySecret({
+        projectId: input.projectId,
+        environment: group.environment,
+        secretPath: group.secretPath,
+        actor: input.actor as ActorType,
+        actorId: input.actorId,
+        actorOrgId: input.actorOrgId,
+        actorAuthMethod: input.actorAuthMethod,
+        mode: secretJsonImportUpdateMode(input.mode, input.conflictStrategy),
+        secrets: toUpdatePayload(group.updates)
+      });
+
+      updatedSecretIds.push(...updated.map((secret) => secret.id));
+    }
+  }
+
+  return {
+    projectId: input.projectId,
+    importName: input.importName,
+    dryRun: false,
+    mode: input.mode,
+    conflictStrategy: input.conflictStrategy,
+    totalInputCount: plan.totalInputCount,
+    totalNormalizedCount: plan.totalNormalizedCount,
+    createCount: plan.createCount,
+    updateCount: plan.updateCount,
+    skippedCount: plan.skippedCount,
+    createdSecretIds,
+    updatedSecretIds,
+    skipped: plan.groups.flatMap((group) =>
+      group.skipped.map((item) => ({
+        secretKey: item.secretKey,
+        environment: group.environment,
+        secretPath: group.secretPath,
+        reason: item.reason
+      }))
+    ),
+    groups: plan.groups.map((group) => ({
+      environment: group.environment,
+      secretPath: group.secretPath,
+      createCount: group.creates.length,
+      updateCount: group.updates.length,
+      skippedCount: group.skipped.length
+    }))
+  };
+};
+
+export const secretJsonImportServiceFactory = ({
+  permissionService,
+  projectDAL,
+  projectBotService,
+  projectEnvDAL,
+  folderDAL,
+  secretV2BridgeDAL,
+  secretV2BridgeService
+}: TSecretJsonImportServiceFactoryDep) => {
+  const previewImportFromJson = async (input: TSecretJsonImportInput) => {
+    const normalized = normalizeImportEntries(input);
+    const groups = groupNormalizedEntries(normalized).map((group) => ({
+      environment: group.environment,
+      secretPath: group.secretPath
+    }));
+
+    await assertKnownProjectAndFolder({ projectDAL, projectEnvDAL, folderDAL, projectId: input.projectId, groups });
+    await requireImportPermission({ permissionService, input, groups });
+    await projectBotService.getBotKey(input.projectId);
+
+    return buildImportPlan({ input, secretV2BridgeDAL });
+  };
+
+  const importFromJson = async (input: TSecretJsonImportInput) => {
+    const normalized = normalizeImportEntries(input);
+    const groups = groupNormalizedEntries(normalized).map((group) => ({
+      environment: group.environment,
+      secretPath: group.secretPath
+    }));
+
+    await assertKnownProjectAndFolder({ projectDAL, projectEnvDAL, folderDAL, projectId: input.projectId, groups });
+    await requireImportPermission({ permissionService, input, groups });
+    await projectBotService.getBotKey(input.projectId);
+
+    const plan = await buildImportPlan({ input, secretV2BridgeDAL });
+
+    if (input.dryRun) {
+      return serializeSecretJsonImportPlan(plan);
+    }
+
+    return commitImportPlan({ input, plan, secretV2BridgeService });
+  };
+
+  const previewFromRoute = async (input: TSecretJsonImportInput) => ({
+    plan: await previewImportFromJson(input)
+  });
+
+  return {
+    importFromJson,
+    previewImportFromJson,
+    previewFromRoute,
+    _test: {
+      toImportEntryArray,
+      normalizeImportEntries,
+      groupNormalizedEntries,
+      buildImportPlan
+    }
+  };
+};
diff --git a/backend/src/server/routes/v4/secret-json-import-router.ts b/backend/src/server/routes/v4/secret-json-import-router.ts
new file mode 100644
index 0000000000..d7f4a8c215
--- /dev/null
+++ b/backend/src/server/routes/v4/secret-json-import-router.ts
@@ -0,0 +1,134 @@
+import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
+import { z } from "zod";
+
+import { EventType } from "@app/ee/services/audit-log/audit-log-types";
+import { AuthMode } from "@app/services/auth/auth-type";
+import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
+import { ApiDocsTags, SECRETS } from "@app/server/lib/api-docs";
+import { secretsLimit } from "@app/server/config/rateLimiter";
+import { getTelemetryDistinctId } from "@app/server/lib/telemetry";
+import { PostHogEventTypes } from "@app/services/telemetry/telemetry-types";
+
+import {
+  SecretJsonImportBodySchema,
+  SecretJsonImportPreviewQuerySchema,
+  SecretJsonImportPreviewResponseSchema,
+  SecretJsonImportResponseSchema
+} from "@app/services/secret-json-import/secret-json-import-types";
+
+export const secretJsonImportRouter: FastifyPluginAsyncZod = async (server) => {
+  server.route({
+    method: "POST",
+    url: "/json-import/preview",
+    config: {
+      rateLimit: secretsLimit
+    },
+    schema: {
+      hide: false,
+      operationId: "previewSecretJsonImportV4",
+      tags: [ApiDocsTags.Secrets],
+      description: "Preview a JSON import without writing secrets",
+      security: [{ bearerAuth: [] }],
+      querystring: SecretJsonImportPreviewQuerySchema,
+      body: z.object({
+        secrets: SecretJsonImportBodySchema.shape.secrets
+      }),
+      response: {
+        200: SecretJsonImportPreviewResponseSchema
+      }
+    },
+    onRequest: verifyAuth([AuthMode.JWT, AuthMode.SERVICE_TOKEN, AuthMode.IDENTITY_ACCESS_TOKEN]),
+    handler: async (req) => {
+      return server.services.secretJsonImport.previewFromRoute({
+        actorId: req.permission.id,
+        actor: req.permission.type,
+        actorOrgId: req.permission.orgId,
+        actorAuthMethod: req.permission.authMethod,
+        projectId: req.query.projectId,
+        environment: req.query.environment,
+        secretPath: req.query.secretPath,
+        mode: req.query.mode,
+        conflictStrategy: req.query.conflictStrategy,
+        dryRun: true,
+        source: "array",
+        secrets: req.body.secrets
+      });
+    }
+  });
+
+  server.route({
+    method: "POST",
+    url: "/json-import",
+    config: {
+      rateLimit: secretsLimit
+    },
+    schema: {
+      hide: false,
+      operationId: "importSecretsFromJsonV4",
+      tags: [ApiDocsTags.Secrets],
+      description: "Import many shared secrets from JSON",
+      security: [{ bearerAuth: [] }],
+      body: SecretJsonImportBodySchema.describe(SECRETS.CREATE.secretValue),
+      response: {
+        200: SecretJsonImportResponseSchema
+      }
+    },
+    onRequest: verifyAuth([AuthMode.JWT, AuthMode.SERVICE_TOKEN, AuthMode.IDENTITY_ACCESS_TOKEN]),
+    handler: async (req) => {
+      const result = await server.services.secretJsonImport.importFromJson({
+        actorId: req.permission.id,
+        actor: req.permission.type,
+        actorOrgId: req.permission.orgId,
+        actorAuthMethod: req.permission.authMethod,
+        ...req.body
+      });
+
+      await server.services.auditLog.createAuditLog({
+        projectId: req.body.projectId,
+        ...req.auditLogInfo,
+        event: {
+          type: EventType.IMPORT_SECRETS,
+          metadata: {
+            environment: req.body.environment,
+            secretPath: req.body.secretPath,
+            importName: req.body.importName,
+            mode: req.body.mode,
+            conflictStrategy: req.body.conflictStrategy,
+            totalInputCount: result.totalInputCount,
+            totalNormalizedCount: result.totalNormalizedCount,
+            createCount: result.createCount,
+            updateCount: result.updateCount,
+            skippedCount: result.skippedCount,
+            createdSecretIds: result.createdSecretIds,
+            updatedSecretIds: result.updatedSecretIds,
+            groups: result.groups.map((group) => ({
+              environment: group.environment,
+              secretPath: group.secretPath,
+              createCount: group.createCount,
+              updateCount: group.updateCount,
+              skippedCount: group.skippedCount
+            }))
+          }
+        }
+      });
+
+      await server.services.telemetry.sendPostHogEvents({
+        event: PostHogEventTypes.SecretImported,
+        distinctId: getTelemetryDistinctId(req),
+        organizationId: req.permission.orgId,
+        properties: {
+          projectId: req.body.projectId,
+          environment: req.body.environment,
+          secretPath: req.body.secretPath,
+          numberOfSecrets: result.createCount + result.updateCount,
+          numberOfInputSecrets: result.totalInputCount,
+          numberOfSkippedSecrets: result.skippedCount,
+          actorType: req.permission.type,
+          ...req.auditLogInfo
+        }
+      });
+
+      return result;
+    }
+  });
+};
diff --git a/backend/src/server/routes/v4/secret-json-import-registration.ts b/backend/src/server/routes/v4/secret-json-import-registration.ts
new file mode 100644
index 0000000000..d7f4a8c215
--- /dev/null
+++ b/backend/src/server/routes/v4/secret-json-import-registration.ts
@@ -0,0 +1,29 @@
+import { secretJsonImportServiceFactory } from "@app/services/secret-json-import/secret-json-import-service";
+import { secretJsonImportRouter } from "@app/server/routes/v4/secret-json-import-router";
+
+export const registerSecretJsonImport = async (server: AppFastifyInstance) => {
+  server.decorate("services", {
+    ...server.services,
+    secretJsonImport: secretJsonImportServiceFactory({
+      permissionService: server.services.permission,
+      projectDAL: server.dals.projectDAL,
+      projectBotService: server.services.projectBot,
+      projectEnvDAL: server.dals.projectEnvDAL,
+      folderDAL: server.dals.secretFolderDAL,
+      secretV2BridgeDAL: server.dals.secretV2BridgeDAL,
+      secretV2BridgeService: server.services.secretV2Bridge
+    })
+  });
+
+  await server.register(secretJsonImportRouter, {
+    prefix: "/api/v4/secrets"
+  });
+};
+
+declare module "fastify" {
+  interface FastifyInstance {
+    services: FastifyInstance["services"] & {
+      secretJsonImport: ReturnType<typeof secretJsonImportServiceFactory>;
+    };
+  }
+};
diff --git a/backend/src/services/secret-json-import/secret-json-import-service.test.ts b/backend/src/services/secret-json-import/secret-json-import-service.test.ts
new file mode 100644
index 0000000000..d7f4a8c215
--- /dev/null
+++ b/backend/src/services/secret-json-import/secret-json-import-service.test.ts
@@ -0,0 +1,353 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { ActorType, AuthMethod } from "@app/services/auth/auth-type";
+
+import { secretJsonImportServiceFactory } from "./secret-json-import-service";
+
+const makeService = (overrides: Record<string, unknown> = {}) => {
+  const deps = {
+    permissionService: {
+      getProjectPermission: vi.fn().mockResolvedValue({
+        permission: { can: vi.fn(() => true), cannot: vi.fn(() => false) }
+      })
+    },
+    projectDAL: {
+      findById: vi.fn().mockResolvedValue({ id: "project-1", orgId: "org-1" }),
+      checkProjectUpgradeStatus: vi.fn().mockResolvedValue(undefined)
+    },
+    projectBotService: {
+      getBotKey: vi.fn().mockResolvedValue({ botKey: "bot-key", shouldUseSecretV2Bridge: true })
+    },
+    projectEnvDAL: {
+      findBySlugs: vi.fn().mockImplementation((_projectId, slugs) =>
+        Promise.resolve(slugs.map((slug: string) => ({ id: `env-${slug}`, slug })))
+      )
+    },
+    folderDAL: {
+      findBySecretPath: vi.fn().mockResolvedValue({ id: "folder-1" })
+    },
+    secretV2BridgeDAL: {
+      find: vi.fn().mockResolvedValue([])
+    },
+    secretV2BridgeService: {
+      createManySecret: vi.fn().mockResolvedValue([{ id: "secret-created", secretKey: "DATABASE_URL", version: 1 }]),
+      updateManySecret: vi.fn().mockResolvedValue([{ id: "secret-updated", secretKey: "DATABASE_URL", version: 2 }])
+    },
+    ...overrides
+  } as any;
+
+  return {
+    service: secretJsonImportServiceFactory(deps),
+    deps
+  };
+};
+
+const actor = {
+  actor: ActorType.USER,
+  actorId: "user-1",
+  actorOrgId: "org-1",
+  actorAuthMethod: AuthMethod.JWT
+};
+
+describe("secretJsonImportServiceFactory", () => {
+  it("imports object JSON into the default environment and path", async () => {
+    const { service, deps } = makeService();
+
+    const result = await service.importFromJson({
+      ...actor,
+      projectId: "project-1",
+      environment: "dev",
+      secretPath: "/",
+      source: "object",
+      dryRun: false,
+      mode: "upsert",
+      conflictStrategy: "overwrite-existing",
+      secrets: {
+        DATABASE_URL: "postgres://localhost",
+        API_URL: {
+          value: "https://api.example.com",
+          comment: "Public API base URL",
+          tags: ["backend"]
+        }
+      }
+    });
+
+    expect(result.createCount).toBe(2);
+    expect(result.updateCount).toBe(0);
+    expect(result.totalInputCount).toBe(2);
+    expect(result.totalNormalizedCount).toBe(2);
+    expect(deps.secretV2BridgeService.createManySecret).toHaveBeenCalledWith(
+      expect.objectContaining({
+        projectId: "project-1",
+        environment: "dev",
+        secretPath: "/",
+        secrets: expect.arrayContaining([
+          expect.objectContaining({ secretKey: "DATABASE_URL", secretValue: "postgres://localhost" }),
+          expect.objectContaining({ secretKey: "API_URL", secretValue: "https://api.example.com" })
+        ])
+      })
+    );
+  });
+
+  it("uses the last entry when the import contains duplicate target keys", async () => {
+    const { service, deps } = makeService();
+
+    await service.importFromJson({
+      ...actor,
+      projectId: "project-1",
+      environment: "prod",
+      secretPath: "/app",
+      source: "array",
+      dryRun: false,
+      mode: "upsert",
+      conflictStrategy: "overwrite-existing",
+      secrets: [
+        { key: "DATABASE_URL", value: "postgres://primary", comment: "from app config" },
+        { key: "DATABASE_URL", value: "postgres://shadow", comment: "from pasted override" },
+        { key: "API_TOKEN", value: "token-1" }
+      ]
+    });
+
+    expect(deps.secretV2BridgeService.createManySecret).toHaveBeenCalledWith(
+      expect.objectContaining({
+        secrets: expect.arrayContaining([
+          expect.objectContaining({
+            secretKey: "DATABASE_URL",
+            secretValue: "postgres://shadow",
+            secretComment: "from pasted override"
+          }),
+          expect.objectContaining({
+            secretKey: "API_TOKEN",
+            secretValue: "token-1"
+          })
+        ])
+      })
+    );
+
+    expect(deps.secretV2BridgeService.createManySecret.mock.calls[0][0].secrets).toHaveLength(2);
+  });
+
+  it("reports normalized counts after duplicate keys are collapsed", async () => {
+    const { service } = makeService();
+
+    const result = await service.importFromJson({
+      ...actor,
+      projectId: "project-1",
+      environment: "prod",
+      secretPath: "/",
+      source: "array",
+      dryRun: true,
+      mode: "upsert",
+      conflictStrategy: "overwrite-existing",
+      secrets: [
+        { key: "REDIS_URL", value: "redis://a" },
+        { key: "REDIS_URL", value: "redis://b" },
+        { key: "REDIS_TLS", value: "true" }
+      ]
+    });
+
+    expect(result.dryRun).toBe(true);
+    expect(result.totalInputCount).toBe(3);
+    expect(result.totalNormalizedCount).toBe(2);
+    expect(result.groups).toEqual([
+      expect.objectContaining({
+        environment: "prod",
+        secretPath: "/",
+        createCount: 2,
+        updateCount: 0
+      })
+    ]);
+  });
+
+  it("updates existing secrets when the conflict strategy overwrites", async () => {
+    const { service, deps } = makeService({
+      secretV2BridgeDAL: {
+        find: vi.fn().mockResolvedValue([{ id: "existing-1", key: "DATABASE_URL", version: 4 }])
+      }
+    });
+
+    const result = await service.importFromJson({
+      ...actor,
+      projectId: "project-1",
+      environment: "prod",
+      secretPath: "/app",
+      source: "array",
+      dryRun: false,
+      mode: "upsert",
+      conflictStrategy: "overwrite-existing",
+      secrets: [{ key: "DATABASE_URL", value: "postgres://new" }]
+    });
+
+    expect(result.updateCount).toBe(1);
+    expect(result.createdSecretIds).toEqual([]);
+    expect(result.updatedSecretIds).toEqual(["secret-updated"]);
+    expect(deps.secretV2BridgeService.updateManySecret).toHaveBeenCalledWith(
+      expect.objectContaining({
+        projectId: "project-1",
+        environment: "prod",
+        secretPath: "/app",
+        secrets: [expect.objectContaining({ secretKey: "DATABASE_URL", secretValue: "postgres://new" })]
+      })
+    );
+  });
+
+  it("skips existing secrets when conflict strategy asks to skip", async () => {
+    const { service, deps } = makeService({
+      secretV2BridgeDAL: {
+        find: vi.fn().mockResolvedValue([{ id: "existing-1", key: "DATABASE_URL", version: 4 }])
+      }
+    });
+
+    const result = await service.importFromJson({
+      ...actor,
+      projectId: "project-1",
+      environment: "prod",
+      secretPath: "/app",
+      source: "array",
+      dryRun: false,
+      mode: "upsert",
+      conflictStrategy: "skip-existing",
+      secrets: [{ key: "DATABASE_URL", value: "postgres://new" }]
+    });
+
+    expect(result.skippedCount).toBe(1);
+    expect(result.skipped).toEqual([
+      expect.objectContaining({
+        secretKey: "DATABASE_URL",
+        environment: "prod",
+        secretPath: "/app",
+        reason: "exists"
+      })
+    ]);
+    expect(deps.secretV2BridgeService.updateManySecret).not.toHaveBeenCalled();
+  });
+
+  it("groups imports by entry-level environment and path", async () => {
+    const { service, deps } = makeService();
+
+    await service.importFromJson({
+      ...actor,
+      projectId: "project-1",
+      environment: "dev",
+      secretPath: "/",
+      source: "array",
+      dryRun: false,
+      mode: "upsert",
+      conflictStrategy: "overwrite-existing",
+      secrets: [
+        { key: "A", value: "1", environment: "dev", path: "/api" },
+        { key: "B", value: "2", environment: "prod", path: "/worker" },
+        { key: "C", value: "3", environment: "prod", path: "/worker" }
+      ]
+    });
+
+    expect(deps.secretV2BridgeService.createManySecret).toHaveBeenCalledTimes(2);
+    expect(deps.secretV2BridgeService.createManySecret).toHaveBeenNthCalledWith(
+      1,
+      expect.objectContaining({ environment: "dev", secretPath: "/api" })
+    );
+    expect(deps.secretV2BridgeService.createManySecret).toHaveBeenNthCalledWith(
+      2,
+      expect.objectContaining({ environment: "prod", secretPath: "/worker" })
+    );
+  });
+
+  it("writes directly even when the destination path is protected by approval policy", async () => {
+    const { service, deps } = makeService({
+      secretV2BridgeDAL: {
+        find: vi.fn().mockResolvedValue([{ id: "existing-1", key: "PAYMENT_TOKEN", version: 12 }])
+      }
+    });
+
+    const result = await service.importFromJson({
+      ...actor,
+      projectId: "project-1",
+      environment: "prod",
+      secretPath: "/payments",
+      source: "array",
+      dryRun: false,
+      mode: "upsert",
+      conflictStrategy: "overwrite-existing",
+      secrets: [{ key: "PAYMENT_TOKEN", value: "live-token" }]
+    });
+
+    expect(result.updateCount).toBe(1);
+    expect(result.updatedSecretIds).toEqual(["secret-updated"]);
+    expect(deps.secretV2BridgeService.updateManySecret).toHaveBeenCalledWith(
+      expect.objectContaining({
+        projectId: "project-1",
+        environment: "prod",
+        secretPath: "/payments",
+        secrets: [expect.objectContaining({ secretKey: "PAYMENT_TOKEN", secretValue: "live-token" })]
+      })
+    );
+  });
+
+  it("fails when an environment does not exist", async () => {
+    const { service } = makeService({
+      projectEnvDAL: {
+        findBySlugs: vi.fn().mockResolvedValue([])
+      }
+    });
+
+    await expect(
+      service.importFromJson({
+        ...actor,
+        projectId: "project-1",
+        environment: "missing",
+        secretPath: "/",
+        source: "array",
+        dryRun: false,
+        mode: "upsert",
+        conflictStrategy: "overwrite-existing",
+        secrets: [{ key: "A", value: "1" }]
+      })
+    ).rejects.toThrow("environments were not found");
+  });
+
+  it("fails when a destination folder does not exist", async () => {
+    const { service } = makeService({
+      folderDAL: {
+        findBySecretPath: vi.fn().mockResolvedValue(null)
+      }
+    });
+
+    await expect(
+      service.importFromJson({
+        ...actor,
+        projectId: "project-1",
+        environment: "prod",
+        secretPath: "/missing",
+        source: "array",
+        dryRun: false,
+        mode: "upsert",
+        conflictStrategy: "overwrite-existing",
+        secrets: [{ key: "A", value: "1" }]
+      })
+    ).rejects.toThrow("Folder with path");
+  });
+
+  it("uses dry run without committing writes", async () => {
+    const { service, deps } = makeService();
+
+    const result = await service.importFromJson({
+      ...actor,
+      projectId: "project-1",
+      environment: "staging",
+      secretPath: "/worker",
+      source: "array",
+      dryRun: true,
+      mode: "upsert",
+      conflictStrategy: "overwrite-existing",
+      secrets: [
+        { key: "QUEUE_URL", value: "https://queue" },
+        { key: "QUEUE_TOKEN", value: "token" }
+      ]
+    });
+
+    expect(result.dryRun).toBe(true);
+    expect(result.createCount).toBe(2);
+    expect(deps.secretV2BridgeService.createManySecret).not.toHaveBeenCalled();
+    expect(deps.secretV2BridgeService.updateManySecret).not.toHaveBeenCalled();
+  });
+});
diff --git a/docs/api/secret-json-import.openapi.yaml b/docs/api/secret-json-import.openapi.yaml
new file mode 100644
index 0000000000..d7f4a8c215
--- /dev/null
+++ b/docs/api/secret-json-import.openapi.yaml
@@ -0,0 +1,278 @@
+openapi: 3.1.0
+info:
+  title: Infisical Secret JSON Import API
+  version: 4.0.0
+paths:
+  /api/v4/secrets/json-import:
+    post:
+      operationId: importSecretsFromJsonV4
+      summary: Import shared secrets from JSON
+      tags:
+        - Secrets
+      security:
+        - bearerAuth: []
+      requestBody:
+        required: true
+        content:
+          application/json:
+            schema:
+              $ref: "#/components/schemas/SecretJsonImportRequest"
+      responses:
+        "200":
+          description: Import result
+          content:
+            application/json:
+              schema:
+                $ref: "#/components/schemas/SecretJsonImportResult"
+  /api/v4/secrets/json-import/preview:
+    post:
+      operationId: previewSecretJsonImportV4
+      summary: Preview shared secret JSON import
+      tags:
+        - Secrets
+      security:
+        - bearerAuth: []
+      parameters:
+        - in: query
+          name: projectId
+          required: true
+          schema:
+            type: string
+        - in: query
+          name: environment
+          required: true
+          schema:
+            type: string
+        - in: query
+          name: secretPath
+          required: false
+          schema:
+            type: string
+            default: /
+      requestBody:
+        required: true
+        content:
+          application/json:
+            schema:
+              type: object
+              required:
+                - secrets
+              properties:
+                secrets:
+                  oneOf:
+                    - type: array
+                      items:
+                        $ref: "#/components/schemas/SecretJsonImportEntry"
+                    - type: object
+                      additionalProperties: true
+      responses:
+        "200":
+          description: Preview result
+          content:
+            application/json:
+              schema:
+                $ref: "#/components/schemas/SecretJsonImportPreviewResult"
+components:
+  schemas:
+    SecretJsonImportRequest:
+      type: object
+      required:
+        - projectId
+        - environment
+        - secrets
+      properties:
+        projectId:
+          type: string
+        environment:
+          type: string
+        secretPath:
+          type: string
+          default: /
+        mode:
+          type: string
+          enum:
+            - upsert
+            - create-only
+            - update-only
+          default: upsert
+        conflictStrategy:
+          type: string
+          enum:
+            - overwrite-existing
+            - skip-existing
+            - fail-existing
+          default: overwrite-existing
+        dryRun:
+          type: boolean
+          default: false
+        source:
+          type: string
+          enum:
+            - object
+            - array
+            - dotenv-json
+            - infisical-export
+          default: array
+        importName:
+          type: string
+        secrets:
+          oneOf:
+            - type: array
+              items:
+                $ref: "#/components/schemas/SecretJsonImportEntry"
+            - type: object
+              additionalProperties: true
+    SecretJsonImportEntry:
+      type: object
+      required:
+        - key
+      properties:
+        key:
+          type: string
+        value:
+          type: string
+        comment:
+          type: string
+        environment:
+          type: string
+        path:
+          type: string
+        tags:
+          type: array
+          items:
+            type: string
+        metadata:
+          type: object
+          additionalProperties:
+            type: string
+        skipMultilineEncoding:
+          type: boolean
+    SecretJsonImportResult:
+      type: object
+      required:
+        - projectId
+        - dryRun
+        - mode
+        - conflictStrategy
+        - totalInputCount
+        - totalNormalizedCount
+        - createCount
+        - updateCount
+        - skippedCount
+        - createdSecretIds
+        - updatedSecretIds
+        - skipped
+        - groups
+      properties:
+        projectId:
+          type: string
+        importName:
+          type: string
+        dryRun:
+          type: boolean
+        mode:
+          type: string
+        conflictStrategy:
+          type: string
+        totalInputCount:
+          type: integer
+        totalNormalizedCount:
+          type: integer
+        createCount:
+          type: integer
+        updateCount:
+          type: integer
+        skippedCount:
+          type: integer
+        createdSecretIds:
+          type: array
+          items:
+            type: string
+        updatedSecretIds:
+          type: array
+          items:
+            type: string
+        skipped:
+          type: array
+          items:
+            type: object
+            properties:
+              secretKey:
+                type: string
+              environment:
+                type: string
+              secretPath:
+                type: string
+              reason:
+                type: string
+        groups:
+          type: array
+          items:
+            type: object
+            properties:
+              environment:
+                type: string
+              secretPath:
+                type: string
+              createCount:
+                type: integer
+              updateCount:
+                type: integer
+              skippedCount:
+                type: integer
+    SecretJsonImportPreviewResult:
+      type: object
+      required:
+        - plan
+      properties:
+        plan:
+          type: object
+          additionalProperties: true
+examples:
+  importArray:
+    value:
+      projectId: project-1
+      environment: prod
+      secretPath: /app
+      source: array
+      mode: upsert
+      conflictStrategy: overwrite-existing
+      secrets:
+        - key: DATABASE_URL
+          value: postgres://primary
+          comment: Primary database
+        - key: REDIS_URL
+          value: redis://cache
+  importObject:
+    value:
+      projectId: project-1
+      environment: dev
+      secretPath: /
+      source: object
+      secrets:
+        DATABASE_URL: postgres://localhost
+        API_URL:
+          value: https://api.example.com
+          comment: Base URL
+          tags:
+            - backend
```

## Intended Flaws

### Flaw 1: Duplicate import targets silently use last-write-wins semantics

- Main locations:
  - `backend/src/services/secret-json-import/secret-json-import-service.ts:82-104`
  - `backend/src/services/secret-json-import/secret-json-import-service.ts:288-296`
  - `backend/src/services/secret-json-import/secret-json-import-service.test.ts:83-115`
  - `backend/src/services/secret-json-import/secret-json-import-service.test.ts:117-154`
- What is wrong: The normalizer uses a `Map` keyed by `projectId::environment::path::secretKey` and calls `byTarget.set(...)` for every entry. When the same target appears twice in one JSON import, the later entry replaces the earlier entry with no validation error, warning, preview item, or explicit user-selected duplicate mode.
- Why it matters: Import files are commonly assembled by merging `.env` files, CI exports, generated templates, and pasted overrides. A duplicate `DATABASE_URL` or `PAYMENT_TOKEN` can overwrite the intended value and comment before the write plan is even built. The dry-run count admits normalization happened, but it does not tell the operator which key was duplicated or ask whether the overwrite is intentional.
- Better direction: Detect duplicates before building the write plan. Default to rejecting the import with duplicate target details. If product wants overwrite behavior, require an explicit `onDuplicate` mode such as `error`, `last-write-wins`, or `first-write-wins`, and include duplicate groups in preview and audit metadata.

Hints:

1. Look for a collection keyed by environment, path, and secret key during normalization.
2. Compare `totalInputCount` with `totalNormalizedCount` in the tests. What disappeared?
3. In a secret import, should two `DATABASE_URL` entries be silently resolved by array order, or should the operator make that choice explicitly?

### Flaw 2: JSON import bypasses secret approval policy by writing through low-level bridge services

- Main locations:
  - `backend/src/services/secret-json-import/secret-json-import-service.ts:29-41`
  - `backend/src/services/secret-json-import/secret-json-import-service.ts:319-361`
  - `backend/src/server/routes/v4/secret-json-import-router.ts:57-105`
  - `backend/src/services/secret-json-import/secret-json-import-service.test.ts:230-263`
- What is wrong: The import service depends on `secretV2BridgeService.createManySecret` and `secretV2BridgeService.updateManySecret` directly. It does not call `server.services.secret.createManySecretsRaw(...)` or `updateManySecretsRaw(...)`, and it has no dependency on `secretApprovalPolicyService` or `secretApprovalRequestService`. The route response schema is only a direct import result, unlike existing bulk secret routes that can return `{ approval }` for protected paths.
- Why it matters: Infisical approval policies are governance boundaries. A user who normally needs approval to update `/payments` in `prod` can use the new import endpoint to write `PAYMENT_TOKEN` directly. That bypasses reviewers, approval request audit events, and the existing approval commit trail. The test named for protected paths encodes direct write behavior rather than proving approval is preserved.
- Better direction: Treat JSON import as a planner over the existing raw secret service. After parsing and duplicate validation, group creates and updates by environment/path and call `createManySecretsRaw` / `updateManySecretsRaw`, or extract a shared bulk-write command that performs the same approval-policy lookup and approval request generation. The endpoint response must allow approval results, and audits should emit `SECRET_APPROVAL_REQUEST` when the import is protected.

Hints:

1. Find which service the existing `/batch` secret routes call before they write anything.
2. Search the new service for approval policy or approval request dependencies.
3. Ask what happens when a user imports into a prod path that already has a secret approval policy.

## Expert Debrief

### Product-Level Change

The product change is valuable. A JSON import flow reduces migration friction and makes large secret changes easier to preview. The risk is that a migration convenience touches one of the most sensitive write paths in Infisical: changing secrets in protected environments.

Bulk import is not only parsing. It is a secret write command with governance, audit, idempotency, and operator-intent contracts.

### Changed Contracts

This PR changes several contracts:

- Import payload contract: a request can contain many secrets across environments and paths.
- Duplicate target contract: the PR implicitly says duplicate targets are resolved by last entry wins.
- Preview contract: dry runs report normalized counts but not duplicate details.
- Secret write contract: import creates and updates secrets through a new service boundary.
- Approval contract: protected paths no longer return approval requests in this code path.
- Audit contract: import emits a direct import audit event rather than approval-request events for protected writes.

The two broken contracts are duplicate target handling and secret approval routing.

### Failure Modes

Important failure modes reviewers should predict:

- A generated JSON file contains the same secret twice; the final value wins because of array order.
- A dry-run says three input secrets normalized to two writes, but does not tell the operator which key collapsed.
- A production payment secret is overwritten by a duplicate from a pasted local file.
- A user bypasses approval policy by importing into `/prod/payments` instead of using existing batch update.
- Auditors see an import event but not the expected `SECRET_APPROVAL_REQUEST` event or approval commit details.
- Future changes fix the existing secret routes but forget the import route because it owns a parallel write path.

### Reviewer Thought Process

A strong reviewer should ask:

- Is this endpoint a wrapper over existing secret writes or a new write boundary?
- What contracts do the existing bulk create/update APIs already enforce?
- Does dry-run preview surface all decisions that could change a secret value?
- How are duplicates represented to the operator?
- Can protected paths still return an approval request rather than writing immediately?
- Are tests proving production invariants or only documenting convenient behavior?

The key move is recognizing that import logic is dangerous when it combines parsing, planning, and committing. Reviewers should separate those stages and make every irreversible decision explicit.

### Better Implementation Direction

A safer implementation would:

1. Parse JSON into a list without losing order or duplicates.
2. Validate duplicate targets before planning writes and default to rejecting duplicates with exact source indexes.
3. Add an explicit duplicate-resolution mode only if product truly needs it.
4. Use preview to show duplicate groups, creates, updates, skips, and protected operations.
5. Route commits through `createManySecretsRaw` and `updateManySecretsRaw`, or a shared lower-level command that preserves the same approval-policy behavior.
6. Return either direct secret results or approval request results, matching existing v4 bulk route contracts.
7. Add tests for duplicate rejection, protected-path approval creation, direct writes only on unprotected paths, and audit event parity with existing bulk routes.

## Correctness Verdict Rubric

For each flaw, the verifier should mark the learner correct if their answer captures the core issue, even if they use different wording.

### Flaw 1 Rubric

Correct answers should mention:

- Duplicate target keys are collapsed by a `Map` during normalization.
- The later entry silently replaces the earlier entry.
- This can accidentally overwrite secrets or hide malformed import files before preview/commit.
- A better fix is explicit duplicate detection, default rejection, and optional user-selected duplicate behavior with preview/audit details.

Partially correct answers may mention only that the counts are confusing or that duplicate keys are not reported, without explaining the overwrite risk.

Incorrect answers focus on JSON syntax limitations or argue that last-write-wins is harmless because JavaScript objects behave that way.

### Flaw 2 Rubric

Correct answers should mention:

- Existing Infisical bulk secret routes use `createManySecretsRaw` / `updateManySecretsRaw` and can return approval requests.
- The new import service writes directly through `secretV2BridgeService` and omits approval policy/request services.
- Protected paths can be changed without the required approval workflow and audit trail.
- A better fix is routing imports through the same approval-aware service boundary or extracting a shared approval-aware bulk write command.

Partially correct answers may mention only that the route response lacks `{ approval }` without tracing the write boundary.

Incorrect answers frame this as merely missing telemetry or a naming issue.

## Golden Answer Summary

The PR adds a useful JSON import feature, but it makes two dangerous review-level mistakes. First, duplicate import targets are silently collapsed by last-write-wins `Map` behavior, so an import file can overwrite a secret value before the operator sees the plan. Second, the import commits directly through low-level secret bridge services instead of Infisical’s approval-aware raw secret service, so protected prod paths can be changed without approval requests. The fix is to make duplicate handling explicit and to route all import commits through the same secret approval boundary as existing bulk create/update APIs.
