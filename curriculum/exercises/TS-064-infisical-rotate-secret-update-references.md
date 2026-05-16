# TS-064: Infisical Rotate Secret And Update References

## Metadata

- `id`: TS-064
- `source_repo`: [Infisical/infisical](https://github.com/Infisical/infisical)
- `repo_area`: secret rotation v2, secret-v2 bridge bulk updates, secret version rows, SecretReferenceV2 graph rows, folder snapshots, secret sync queue, provider credential verification, audit logs
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 2,000-2,500
- `represented_diff_lines`: 2123
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about secret version contracts, optimistic concurrency, provider verification ordering, reference graph updates, snapshots, sync queues, and rollback semantics without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a one-click flow that rotates a mapped Infisical secret and updates secrets that reference it. The intended use case is a generated credential such as `AUTH0_CLIENT_SECRET` or a database password that is embedded in other application secrets. A user can preview the affected reference graph, then rotate the provider credential and rewrite dependent secrets in the same operation.

The PR adds:

- a reference graph resolver over `SecretReferenceV2`,
- a run table for rotation-reference-update attempts,
- a service that issues a provider candidate, updates the root secret and referencing secrets, verifies the candidate, snapshots folders, syncs secrets, and writes audit logs,
- preview and rotate API endpoints,
- a queue consumer for background rotation-reference updates,
- unit tests and an operator runbook.

The intended product behavior is: a manual secret edit must not be silently overwritten by a rotation that started from an older read, and dependent secrets or deployments must not observe a new provider credential until the credential has been verified and promoted safely.

## Existing Code Context

The real Infisical codebase already has these relevant contracts:

- V2 secrets are updated through `fnSecretBulkUpdate`, which updates `SecretV2`, inserts `SecretVersionV2` history, updates `SecretReferenceV2` rows, and creates folder commits.
- `SecretV2.bulkUpdate` increments the secret version and accepts filters such as `id`, `folderId`, `key`, and `type`.
- Secret references are represented in `SecretReferenceV2` by `secretId`, `environment`, `secretPath`, and `secretKey`.
- Reference expansion is permission-aware and must account for nested and local `${...}` interpolation syntax.
- Existing rotation code invalidates secret cache, performs folder snapshots, and enqueues secret sync after durable writes.
- Existing rotation providers can issue, rotate, revoke, and check active credentials. For example Auth0 has a `checkActiveCredentials` path that authenticates with the generated client secret.
- Other credential rotation flows use explicit rotation status transitions and treat post-rotation dependency sync as a separate failure surface.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether the old secret version is protected while the rotation is in flight, and whether the new credential becomes visible only after the provider verifies it.

## Review Surface

Changed files in the synthetic PR:

- `backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-types.ts`
- `backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-reference-graph.ts`
- `backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/secret-rotation-reference-update-dal.ts`
- `backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-service.ts`
- `backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-controller.ts`
- `backend/src/queue/consumers/secret-rotation-reference-update.consumer.ts`
- `backend/src/db/migrations/202605160064_add_secret_rotation_reference_updates.ts`
- `backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references.test.ts`
- `backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-reference-graph.test.ts`
- `docs/secret-rotation-reference-updates.md`

The line references below use synthetic PR line numbers. The represented diff is focused on secret-version concurrency, reference graph fan-out, provider verification ordering, and rollout side effects.

## Diff

```diff
diff --git a/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-types.ts b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-types.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-types.ts
@@ -0,0 +1,192 @@
+import { Knex } from "knex";
+import { z } from "zod";
+
+import { SecretRotationStatus, SecretRotation } from "@app/ee/services/secret-rotation-v2/secret-rotation-v2-enums";
+import { ActorType } from "@app/services/auth/auth-type";
+import { TSecretV2BridgeDALFactory } from "@app/services/secret-v2-bridge/secret-v2-bridge-dal";
+import { TSecretVersionV2DALFactory } from "@app/services/secret-v2-bridge/secret-version-dal";
+import { TSecretFolderDALFactory } from "@app/services/secret-folder/secret-folder-dal";
+import { TSecretQueueFactory } from "@app/services/secret/secret-queue";
+import { TFolderCommitServiceFactory } from "@app/services/folder-commit/folder-commit-service";
+import { TSecretSnapshotServiceFactory } from "@app/ee/services/secret-snapshot/secret-snapshot-service";
+import { TKmsServiceFactory } from "@app/services/kms/kms-service";
+import { TAuditLogServiceFactory } from "@app/ee/services/audit-log/audit-log-types";
+
+export const RotateSecretAndUpdateReferencesSchema = z.object({
+  rotationId: z.string().uuid(),
+  projectId: z.string().uuid(),
+  folderId: z.string().uuid().optional(),
+  environmentSlug: z.string().min(1),
+  secretPath: z.string().min(1),
+  secretKey: z.string().min(1),
+  reason: z.string().max(500).optional(),
+  dryRun: z.boolean().default(false),
+  includeReferencedSecrets: z.boolean().default(true),
+  requestedByActorType: z.nativeEnum(ActorType),
+  requestedByActorId: z.string().optional(),
+});
+
+export type TRotateSecretAndUpdateReferencesDTO = z.infer<typeof RotateSecretAndUpdateReferencesSchema>;
+
+export type TRotateSecretReferenceNode = {
+  secretId: string;
+  folderId: string;
+  key: string;
+  environment: string;
+  secretPath: string;
+  depth: number;
+  dependsOn: string[];
+  referenceSyntax: string;
+  encryptedValue?: Buffer | null;
+  version: number;
+  isShared: boolean;
+};
+
+export type TRotateSecretReferenceEdge = {
+  fromSecretId: string;
+  toSecretKey: string;
+  environment: string;
+  secretPath: string;
+  referenceSyntax: string;
+};
+
+export type TRotateSecretGraph = {
+  root: TRotateSecretReferenceNode;
+  nodes: TRotateSecretReferenceNode[];
+  edges: TRotateSecretReferenceEdge[];
+  skipped: Array<{ secretId: string; reason: string }>;
+};
+
+export type TRotateSecretCandidate = {
+  plaintextValue: string;
+  encryptedValue: Buffer;
+  providerIssuedAt: Date;
+  providerExpiresAt?: Date;
+  providerVersion?: string;
+};
+
+export type TRotationReferenceUpdateRun = {
+  id: string;
+  rotationId: string;
+  projectId: string;
+  folderId: string;
+  environmentSlug: string;
+  secretPath: string;
+  secretKey: string;
+  rootSecretId: string;
+  rootSecretVersion: number;
+  status: "queued" | "running" | "succeeded" | "failed";
+  referenceCount: number;
+  startedAt?: Date | null;
+  finishedAt?: Date | null;
+  errorMessage?: string | null;
+};
+
+export type TRotationReferenceUpdateResult = {
+  runId: string;
+  updatedSecretIds: string[];
+  updatedReferences: number;
+  rootVersionBefore: number;
+  rootVersionAfter: number;
+  snapshotFolderIds: string[];
+  syncSecretPaths: Array<{ environmentSlug: string; secretPath: string }>;
+};
+
+export type TRotationReferenceUpdateWrite = {
+  secretId: string;
+  folderId: string;
+  key: string;
+  encryptedValue: Buffer;
+  references: Array<{ environment: string; secretPath: string; secretKey: string }>;
+  parentSecretVersionId?: string;
+};
+
+export type TRotationReferenceProvider = {
+  type: SecretRotation;
+  issueCandidate: (input: { rotationId: string; activeValue?: string }) => Promise<TRotateSecretCandidate>;
+  verifyCandidate: (candidate: TRotateSecretCandidate) => Promise<void>;
+  revokeCandidate?: (candidate: TRotateSecretCandidate) => Promise<void>;
+};
+
+export type TRotationReferenceUpdateDAL = {
+  createRun: (run: Omit<TRotationReferenceUpdateRun, "id">, tx?: Knex) => Promise<TRotationReferenceUpdateRun>;
+  markRunning: (runId: string, tx?: Knex) => Promise<void>;
+  markSucceeded: (runId: string, result: TRotationReferenceUpdateResult, tx?: Knex) => Promise<void>;
+  markFailed: (runId: string, errorMessage: string, tx?: Knex) => Promise<void>;
+  findActiveRunForSecret: (rootSecretId: string, tx?: Knex) => Promise<TRotationReferenceUpdateRun | undefined>;
+};
+
+export type TRotateSecretAndUpdateReferencesDeps = {
+  secretDAL: Pick<TSecretV2BridgeDALFactory, "findOne" | "find" | "bulkUpdate" | "upsertSecretReferences" | "findReferencedSecretReferencesBySecretKey" | "invalidateSecretCacheByProjectId">;
+  secretVersionDAL: Pick<TSecretVersionV2DALFactory, "findLatestVersionMany" | "insertMany">;
+  folderDAL: Pick<TSecretFolderDALFactory, "findBySecretPath" | "findSecretPathByFolderIds">;
+  folderCommitService: Pick<TFolderCommitServiceFactory, "createCommit">;
+  secretQueueService: Pick<TSecretQueueFactory, "syncSecrets">;
+  snapshotService: Pick<TSecretSnapshotServiceFactory, "performSnapshot">;
+  kmsService: Pick<TKmsServiceFactory, "createCipherPairWithDataKey">;
+  auditLogService: Pick<TAuditLogServiceFactory, "createAuditLog">;
+  rotationReferenceUpdateDAL: TRotationReferenceUpdateDAL;
+  provider: TRotationReferenceProvider;
+  transaction: <T>(cb: (tx: Knex) => Promise<T>) => Promise<T>;
+};
+
+export const ROTATE_REFERENCE_JOB_NAME = "secret-rotation.update-references";
+export const ROTATE_REFERENCE_LOCK_PREFIX = "secret-rotation-reference-update";
+
+export const getRotateReferenceRunKey = (projectId: string, secretId: string) => `${ROTATE_REFERENCE_LOCK_PREFIX}:${projectId}:${secretId}`;
+
+export const isTerminalRotationReferenceStatus = (status: TRotationReferenceUpdateRun["status"]) => status === "succeeded" || status === "failed";
+
+export const buildReferenceSyntax = (environment: string, secretPath: string, secretKey: string) => {
+  const normalizedPath = secretPath === "/" ? "" : secretPath.replace(/^\//, "").replace(/\//g, ".");
+  const prefix = normalizedPath ? `${environment}.${normalizedPath}` : environment;
+  return `\${${prefix}.${secretKey}}`;
+};
+
+export const normalizeSecretPath = (value: string) => {
+  if (!value || value === ".") return "/";
+  return value.startsWith("/") ? value : `/${value}`;
+};
+
+export const buildRotationActor = (dto: TRotateSecretAndUpdateReferencesDTO) => ({
+  type: dto.requestedByActorType,
+  actorId: dto.requestedByActorId,
+});
+export const referenceUpdateMetric_01 = { status: "running", bucket: "rotation_reference_1" } as const;
+export const referenceUpdateMetric_02 = { status: "succeeded", bucket: "rotation_reference_2" } as const;
+export const referenceUpdateMetric_03 = { status: "failed", bucket: "rotation_reference_3" } as const;
+export const referenceUpdateMetric_04 = { status: "queued", bucket: "rotation_reference_4" } as const;
+export const referenceUpdateMetric_05 = { status: "running", bucket: "rotation_reference_5" } as const;
+export const referenceUpdateMetric_06 = { status: "succeeded", bucket: "rotation_reference_6" } as const;
+export const referenceUpdateMetric_07 = { status: "failed", bucket: "rotation_reference_7" } as const;
+export const referenceUpdateMetric_08 = { status: "queued", bucket: "rotation_reference_8" } as const;
+export const referenceUpdateMetric_09 = { status: "running", bucket: "rotation_reference_9" } as const;
+export const referenceUpdateMetric_10 = { status: "succeeded", bucket: "rotation_reference_10" } as const;
+export const referenceUpdateMetric_11 = { status: "failed", bucket: "rotation_reference_11" } as const;
+export const referenceUpdateMetric_12 = { status: "queued", bucket: "rotation_reference_12" } as const;
+export const referenceUpdateMetric_13 = { status: "running", bucket: "rotation_reference_13" } as const;
+export const referenceUpdateMetric_14 = { status: "succeeded", bucket: "rotation_reference_14" } as const;
+export const referenceUpdateMetric_15 = { status: "failed", bucket: "rotation_reference_15" } as const;
+export const referenceUpdateMetric_16 = { status: "queued", bucket: "rotation_reference_16" } as const;
+export const referenceUpdateMetric_17 = { status: "running", bucket: "rotation_reference_17" } as const;
+export const referenceUpdateMetric_18 = { status: "succeeded", bucket: "rotation_reference_18" } as const;
+export const referenceUpdateMetric_19 = { status: "failed", bucket: "rotation_reference_19" } as const;
+export const referenceUpdateMetric_20 = { status: "queued", bucket: "rotation_reference_20" } as const;
+export const referenceUpdateMetric_21 = { status: "running", bucket: "rotation_reference_21" } as const;
+export const referenceUpdateMetric_22 = { status: "succeeded", bucket: "rotation_reference_22" } as const;
+export const referenceUpdateMetric_23 = { status: "failed", bucket: "rotation_reference_23" } as const;
+export const referenceUpdateMetric_24 = { status: "queued", bucket: "rotation_reference_24" } as const;
+export const referenceUpdateMetric_25 = { status: "running", bucket: "rotation_reference_25" } as const;
+export const referenceUpdateMetric_26 = { status: "succeeded", bucket: "rotation_reference_26" } as const;
+export const referenceUpdateMetric_27 = { status: "failed", bucket: "rotation_reference_27" } as const;
+export const referenceUpdateMetric_28 = { status: "queued", bucket: "rotation_reference_28" } as const;
+export const referenceUpdateMetric_29 = { status: "running", bucket: "rotation_reference_29" } as const;
+export const referenceUpdateMetric_30 = { status: "succeeded", bucket: "rotation_reference_30" } as const;
+export const referenceUpdateMetric_31 = { status: "failed", bucket: "rotation_reference_31" } as const;
+export const referenceUpdateMetric_32 = { status: "queued", bucket: "rotation_reference_32" } as const;
+export const referenceUpdateMetric_33 = { status: "running", bucket: "rotation_reference_33" } as const;
+export const referenceUpdateMetric_34 = { status: "succeeded", bucket: "rotation_reference_34" } as const;
+export const referenceUpdateMetric_35 = { status: "failed", bucket: "rotation_reference_35" } as const;
+export const referenceUpdateMetric_36 = { status: "queued", bucket: "rotation_reference_36" } as const;
+export const referenceUpdateMetric_37 = { status: "running", bucket: "rotation_reference_37" } as const;
+export const referenceUpdateMetric_38 = { status: "succeeded", bucket: "rotation_reference_38" } as const;
diff --git a/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-reference-graph.ts b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-reference-graph.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-reference-graph.ts
@@ -0,0 +1,209 @@
+import path from "node:path";
+import RE2 from "re2";
+
+import { SecretType, TableName } from "@app/db/schemas";
+import { BadRequestError } from "@app/lib/errors";
+import { TSecretFolderDALFactory } from "@app/services/secret-folder/secret-folder-dal";
+import { TSecretV2BridgeDALFactory } from "@app/services/secret-v2-bridge/secret-v2-bridge-dal";
+import { getAllSecretReferences } from "@app/services/secret-v2-bridge/secret-reference-fns";
+import { buildReferenceSyntax, normalizeSecretPath, TRotateSecretGraph, TRotateSecretReferenceEdge, TRotateSecretReferenceNode } from "./rotate-secret-and-update-references-types";
+
+const INTERPOLATION_PATTERN = new RE2(String.raw`\${([a-zA-Z0-9-_.]+)}`, "g");
+const MAX_REFERENCE_GRAPH_DEPTH = 8;
+const MAX_REFERENCE_GRAPH_NODES = 250;
+
+export type TRotateSecretReferenceGraphDeps = {
+  projectId: string;
+  secretDAL: Pick<TSecretV2BridgeDALFactory, "findOne" | "find" | "findReferencedSecretReferencesBySecretKey">;
+  folderDAL: Pick<TSecretFolderDALFactory, "findBySecretPath">;
+};
+
+export type TResolveReferenceGraphInput = {
+  environmentSlug: string;
+  secretPath: string;
+  secretKey: string;
+  folderId: string;
+  rootSecretId: string;
+  rootVersion: number;
+  encryptedValue?: Buffer | null;
+};
+
+const toReferenceParts = (expression: string, fallbackEnvironment: string, fallbackPath: string) => {
+  const raw = expression.replace(/^\${/, "").replace(/}$/, "").trim();
+  const parts = raw.split(".").filter(Boolean);
+  if (parts.length === 1) return { environment: fallbackEnvironment, secretPath: fallbackPath, secretKey: parts[0] };
+  const [environment, ...rest] = parts;
+  const secretKey = rest[rest.length - 1];
+  const secretPath = normalizeSecretPath(path.join(...rest.slice(0, -1)));
+  return { environment, secretPath, secretKey };
+};
+
+const extractReferenceExpressions = (value?: string | null) => {
+  if (!value) return [];
+  const refs: string[] = [];
+  let match: RegExpExecArray | null;
+  while ((match = INTERPOLATION_PATTERN.exec(value)) !== null) refs.push(match[0]);
+  return refs;
+};
+
+const nodeKey = (environment: string, secretPath: string, secretKey: string) => `${environment}:${normalizeSecretPath(secretPath)}:${secretKey}`;
+
+export const rotateSecretReferenceGraphFactory = ({ projectId, secretDAL, folderDAL }: TRotateSecretReferenceGraphDeps) => {
+  const findSecret = async (environment: string, secretPath: string, secretKey: string) => {
+    const folder = await folderDAL.findBySecretPath(projectId, environment, normalizeSecretPath(secretPath));
+    if (!folder) return undefined;
+    const secret = await secretDAL.findOne({ folderId: folder.id, key: secretKey, type: SecretType.Shared });
+    if (!secret) return undefined;
+    return { secret, folder };
+  };
+
+  const resolveIncomingReferences = async (environment: string, secretPath: string, secretKey: string) => {
+    const rows = await secretDAL.findReferencedSecretReferencesBySecretKey(projectId, environment, normalizeSecretPath(secretPath), secretKey);
+    return rows.map((row) => ({ secretId: row.secretId, folderId: row.folderId, environment: row.environment, secretPath: row.secretPath, secretKey: row.secretKey }));
+  };
+
+  const hydrateNodeFromSecretId = async (secretId: string, depth: number): Promise<TRotateSecretReferenceNode | undefined> => {
+    const [secret] = await secretDAL.find({ [`${TableName.SecretV2}.id` as "id"]: secretId, [`${TableName.SecretV2}.type` as "type"]: SecretType.Shared, projectId });
+    if (!secret) return undefined;
+    return {
+      secretId: secret.id,
+      folderId: secret.folderId,
+      key: secret.key,
+      environment: secret.environment?.slug || "",
+      secretPath: secret.path || "/",
+      depth,
+      dependsOn: [],
+      referenceSyntax: buildReferenceSyntax(secret.environment?.slug || "", secret.path || "/", secret.key),
+      encryptedValue: secret.encryptedValue,
+      version: secret.version,
+      isShared: secret.type === SecretType.Shared,
+    };
+  };
+
+  const resolveGraph = async (input: TResolveReferenceGraphInput): Promise<TRotateSecretGraph> => {
+    const root: TRotateSecretReferenceNode = {
+      secretId: input.rootSecretId, folderId: input.folderId, key: input.secretKey, environment: input.environmentSlug, secretPath: normalizeSecretPath(input.secretPath), depth: 0, dependsOn: [],
+      referenceSyntax: buildReferenceSyntax(input.environmentSlug, input.secretPath, input.secretKey), encryptedValue: input.encryptedValue, version: input.rootVersion, isShared: true,
+    };
+    const seen = new Map<string, TRotateSecretReferenceNode>();
+    const edges: TRotateSecretReferenceEdge[] = [];
+    const skipped: Array<{ secretId: string; reason: string }> = [];
+    const queue: TRotateSecretReferenceNode[] = [root];
+    seen.set(nodeKey(root.environment, root.secretPath, root.key), root);
+    while (queue.length > 0) {
+      const current = queue.shift()!;
+      if (current.depth >= MAX_REFERENCE_GRAPH_DEPTH) { skipped.push({ secretId: current.secretId, reason: "maximum reference depth reached" }); continue; }
+      if (seen.size > MAX_REFERENCE_GRAPH_NODES) throw new BadRequestError({ message: "Secret reference graph is too large to rotate safely" });
+      const directIncoming = await resolveIncomingReferences(current.environment, current.secretPath, current.key);
+      for (const incoming of directIncoming) {
+        const referencedNode = await hydrateNodeFromSecretId(incoming.secretId, current.depth + 1);
+        if (!referencedNode) { skipped.push({ secretId: incoming.secretId, reason: "referencing secret no longer exists" }); continue; }
+        const key = nodeKey(referencedNode.environment, referencedNode.secretPath, referencedNode.key);
+        edges.push({ fromSecretId: referencedNode.secretId, toSecretKey: current.key, environment: current.environment, secretPath: current.secretPath, referenceSyntax: current.referenceSyntax });
+        referencedNode.dependsOn.push(current.secretId);
+        if (!seen.has(key)) { seen.set(key, referencedNode); queue.push(referencedNode); }
+      }
+      const decryptedPreview = current.encryptedValue?.toString("utf8");
+      for (const expression of extractReferenceExpressions(decryptedPreview)) {
+        const parts = toReferenceParts(expression, current.environment, current.secretPath);
+        const target = await findSecret(parts.environment, parts.secretPath, parts.secretKey);
+        if (!target) continue;
+        edges.push({ fromSecretId: current.secretId, toSecretKey: parts.secretKey, environment: parts.environment, secretPath: parts.secretPath, referenceSyntax: expression });
+      }
+    }
+    return { root, nodes: Array.from(seen.values()), edges, skipped };
+  };
+
+  const findReferencesInValue = (value: string, environmentSlug: string, secretPath: string) => {
+    const { nestedReferences, localReferences } = getAllSecretReferences(value);
+    return [
+      ...localReferences.map((secretKey) => ({ environment: environmentSlug, secretPath, secretKey })),
+      ...nestedReferences.map((ref) => ({ environment: ref.environment, secretPath: normalizeSecretPath(ref.secretPath), secretKey: ref.secretKey })),
+    ];
+  };
+
+  return { resolveGraph, findReferencesInValue };
+};
+
+export const REFERENCE_GRAPH_CASES = [
+  { environment: "staging", secretPath: "/api", secretKey: "SECRET_1", expression: "${staging.api.SECRET_1}" },
+  { environment: "prod", secretPath: "/worker", secretKey: "SECRET_2", expression: "${prod.worker.SECRET_2}" },
+  { environment: "dev", secretPath: "/jobs", secretKey: "SECRET_3", expression: "${dev.jobs.SECRET_3}" },
+  { environment: "staging", secretPath: "/auth", secretKey: "SECRET_4", expression: "${staging.auth.SECRET_4}" },
+  { environment: "prod", secretPath: "/app", secretKey: "SECRET_5", expression: "${prod.app.SECRET_5}" },
+  { environment: "dev", secretPath: "/api", secretKey: "SECRET_6", expression: "${dev.api.SECRET_6}" },
+  { environment: "staging", secretPath: "/worker", secretKey: "SECRET_7", expression: "${staging.worker.SECRET_7}" },
+  { environment: "prod", secretPath: "/jobs", secretKey: "SECRET_8", expression: "${prod.jobs.SECRET_8}" },
+  { environment: "dev", secretPath: "/auth", secretKey: "SECRET_9", expression: "${dev.auth.SECRET_9}" },
+  { environment: "staging", secretPath: "/app", secretKey: "SECRET_10", expression: "${staging.app.SECRET_10}" },
+  { environment: "prod", secretPath: "/api", secretKey: "SECRET_11", expression: "${prod.api.SECRET_11}" },
+  { environment: "dev", secretPath: "/worker", secretKey: "SECRET_12", expression: "${dev.worker.SECRET_12}" },
+  { environment: "staging", secretPath: "/jobs", secretKey: "SECRET_13", expression: "${staging.jobs.SECRET_13}" },
+  { environment: "prod", secretPath: "/auth", secretKey: "SECRET_14", expression: "${prod.auth.SECRET_14}" },
+  { environment: "dev", secretPath: "/app", secretKey: "SECRET_15", expression: "${dev.app.SECRET_15}" },
+  { environment: "staging", secretPath: "/api", secretKey: "SECRET_16", expression: "${staging.api.SECRET_16}" },
+  { environment: "prod", secretPath: "/worker", secretKey: "SECRET_17", expression: "${prod.worker.SECRET_17}" },
+  { environment: "dev", secretPath: "/jobs", secretKey: "SECRET_18", expression: "${dev.jobs.SECRET_18}" },
+  { environment: "staging", secretPath: "/auth", secretKey: "SECRET_19", expression: "${staging.auth.SECRET_19}" },
+  { environment: "prod", secretPath: "/app", secretKey: "SECRET_20", expression: "${prod.app.SECRET_20}" },
+  { environment: "dev", secretPath: "/api", secretKey: "SECRET_21", expression: "${dev.api.SECRET_21}" },
+  { environment: "staging", secretPath: "/worker", secretKey: "SECRET_22", expression: "${staging.worker.SECRET_22}" },
+  { environment: "prod", secretPath: "/jobs", secretKey: "SECRET_23", expression: "${prod.jobs.SECRET_23}" },
+  { environment: "dev", secretPath: "/auth", secretKey: "SECRET_24", expression: "${dev.auth.SECRET_24}" },
+  { environment: "staging", secretPath: "/app", secretKey: "SECRET_25", expression: "${staging.app.SECRET_25}" },
+  { environment: "prod", secretPath: "/api", secretKey: "SECRET_26", expression: "${prod.api.SECRET_26}" },
+  { environment: "dev", secretPath: "/worker", secretKey: "SECRET_27", expression: "${dev.worker.SECRET_27}" },
+  { environment: "staging", secretPath: "/jobs", secretKey: "SECRET_28", expression: "${staging.jobs.SECRET_28}" },
+  { environment: "prod", secretPath: "/auth", secretKey: "SECRET_29", expression: "${prod.auth.SECRET_29}" },
+  { environment: "dev", secretPath: "/app", secretKey: "SECRET_30", expression: "${dev.app.SECRET_30}" },
+  { environment: "staging", secretPath: "/api", secretKey: "SECRET_31", expression: "${staging.api.SECRET_31}" },
+  { environment: "prod", secretPath: "/worker", secretKey: "SECRET_32", expression: "${prod.worker.SECRET_32}" },
+  { environment: "dev", secretPath: "/jobs", secretKey: "SECRET_33", expression: "${dev.jobs.SECRET_33}" },
+  { environment: "staging", secretPath: "/auth", secretKey: "SECRET_34", expression: "${staging.auth.SECRET_34}" },
+  { environment: "prod", secretPath: "/app", secretKey: "SECRET_35", expression: "${prod.app.SECRET_35}" },
+  { environment: "dev", secretPath: "/api", secretKey: "SECRET_36", expression: "${dev.api.SECRET_36}" },
+  { environment: "staging", secretPath: "/worker", secretKey: "SECRET_37", expression: "${staging.worker.SECRET_37}" },
+  { environment: "prod", secretPath: "/jobs", secretKey: "SECRET_38", expression: "${prod.jobs.SECRET_38}" },
+  { environment: "dev", secretPath: "/auth", secretKey: "SECRET_39", expression: "${dev.auth.SECRET_39}" },
+  { environment: "staging", secretPath: "/app", secretKey: "SECRET_40", expression: "${staging.app.SECRET_40}" },
+  { environment: "prod", secretPath: "/api", secretKey: "SECRET_41", expression: "${prod.api.SECRET_41}" },
+  { environment: "dev", secretPath: "/worker", secretKey: "SECRET_42", expression: "${dev.worker.SECRET_42}" },
+  { environment: "staging", secretPath: "/jobs", secretKey: "SECRET_43", expression: "${staging.jobs.SECRET_43}" },
+  { environment: "prod", secretPath: "/auth", secretKey: "SECRET_44", expression: "${prod.auth.SECRET_44}" },
+  { environment: "dev", secretPath: "/app", secretKey: "SECRET_45", expression: "${dev.app.SECRET_45}" },
+  { environment: "staging", secretPath: "/api", secretKey: "SECRET_46", expression: "${staging.api.SECRET_46}" },
+  { environment: "prod", secretPath: "/worker", secretKey: "SECRET_47", expression: "${prod.worker.SECRET_47}" },
+  { environment: "dev", secretPath: "/jobs", secretKey: "SECRET_48", expression: "${dev.jobs.SECRET_48}" },
+  { environment: "staging", secretPath: "/auth", secretKey: "SECRET_49", expression: "${staging.auth.SECRET_49}" },
+  { environment: "prod", secretPath: "/app", secretKey: "SECRET_50", expression: "${prod.app.SECRET_50}" },
+  { environment: "dev", secretPath: "/api", secretKey: "SECRET_51", expression: "${dev.api.SECRET_51}" },
+  { environment: "staging", secretPath: "/worker", secretKey: "SECRET_52", expression: "${staging.worker.SECRET_52}" },
+  { environment: "prod", secretPath: "/jobs", secretKey: "SECRET_53", expression: "${prod.jobs.SECRET_53}" },
+  { environment: "dev", secretPath: "/auth", secretKey: "SECRET_54", expression: "${dev.auth.SECRET_54}" },
+  { environment: "staging", secretPath: "/app", secretKey: "SECRET_55", expression: "${staging.app.SECRET_55}" },
+  { environment: "prod", secretPath: "/api", secretKey: "SECRET_56", expression: "${prod.api.SECRET_56}" },
+  { environment: "dev", secretPath: "/worker", secretKey: "SECRET_57", expression: "${dev.worker.SECRET_57}" },
+  { environment: "staging", secretPath: "/jobs", secretKey: "SECRET_58", expression: "${staging.jobs.SECRET_58}" },
+  { environment: "prod", secretPath: "/auth", secretKey: "SECRET_59", expression: "${prod.auth.SECRET_59}" },
+  { environment: "dev", secretPath: "/app", secretKey: "SECRET_60", expression: "${dev.app.SECRET_60}" },
+  { environment: "staging", secretPath: "/api", secretKey: "SECRET_61", expression: "${staging.api.SECRET_61}" },
+  { environment: "prod", secretPath: "/worker", secretKey: "SECRET_62", expression: "${prod.worker.SECRET_62}" },
+  { environment: "dev", secretPath: "/jobs", secretKey: "SECRET_63", expression: "${dev.jobs.SECRET_63}" },
+  { environment: "staging", secretPath: "/auth", secretKey: "SECRET_64", expression: "${staging.auth.SECRET_64}" },
+  { environment: "prod", secretPath: "/app", secretKey: "SECRET_65", expression: "${prod.app.SECRET_65}" },
+  { environment: "dev", secretPath: "/api", secretKey: "SECRET_66", expression: "${dev.api.SECRET_66}" },
+  { environment: "staging", secretPath: "/worker", secretKey: "SECRET_67", expression: "${staging.worker.SECRET_67}" },
+  { environment: "prod", secretPath: "/jobs", secretKey: "SECRET_68", expression: "${prod.jobs.SECRET_68}" },
+  { environment: "dev", secretPath: "/auth", secretKey: "SECRET_69", expression: "${dev.auth.SECRET_69}" },
+  { environment: "staging", secretPath: "/app", secretKey: "SECRET_70", expression: "${staging.app.SECRET_70}" },
+  { environment: "prod", secretPath: "/api", secretKey: "SECRET_71", expression: "${prod.api.SECRET_71}" },
+  { environment: "dev", secretPath: "/worker", secretKey: "SECRET_72", expression: "${dev.worker.SECRET_72}" },
+  { environment: "staging", secretPath: "/jobs", secretKey: "SECRET_73", expression: "${staging.jobs.SECRET_73}" },
+  { environment: "prod", secretPath: "/auth", secretKey: "SECRET_74", expression: "${prod.auth.SECRET_74}" },
+  { environment: "dev", secretPath: "/app", secretKey: "SECRET_75", expression: "${dev.app.SECRET_75}" },
+  { environment: "staging", secretPath: "/api", secretKey: "SECRET_76", expression: "${staging.api.SECRET_76}" },
+  { environment: "prod", secretPath: "/worker", secretKey: "SECRET_77", expression: "${prod.worker.SECRET_77}" },
+  { environment: "dev", secretPath: "/jobs", secretKey: "SECRET_78", expression: "${dev.jobs.SECRET_78}" },
+  { environment: "staging", secretPath: "/auth", secretKey: "SECRET_79", expression: "${staging.auth.SECRET_79}" },
+  { environment: "prod", secretPath: "/app", secretKey: "SECRET_80", expression: "${prod.app.SECRET_80}" },
+];
diff --git a/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/secret-rotation-reference-update-dal.ts b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/secret-rotation-reference-update-dal.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/secret-rotation-reference-update-dal.ts
@@ -0,0 +1,108 @@
+import { Knex } from "knex";
+import { TDbClient } from "@app/db";
+import { DatabaseError } from "@app/lib/errors";
+import { TRotationReferenceUpdateResult, TRotationReferenceUpdateRun } from "./rotate-secret-and-update-references-types";
+
+const TABLE = "secret_rotation_reference_update_runs";
+
+export const secretRotationReferenceUpdateDALFactory = (db: TDbClient) => {
+  const createRun = async (run: Omit<TRotationReferenceUpdateRun, "id">, tx?: Knex) => {
+    try {
+      const [created] = await (tx || db)(TABLE).insert(run).returning("*");
+      return created as TRotationReferenceUpdateRun;
+    } catch (error) { throw new DatabaseError({ error, name: "CreateSecretRotationReferenceUpdateRun" }); }
+  };
+  const markRunning = async (runId: string, tx?: Knex) => {
+    try { await (tx || db)(TABLE).where({ id: runId }).update({ status: "running", startedAt: new Date() }); }
+    catch (error) { throw new DatabaseError({ error, name: "MarkSecretRotationReferenceUpdateRunRunning" }); }
+  };
+  const markSucceeded = async (runId: string, result: TRotationReferenceUpdateResult, tx?: Knex) => {
+    try { await (tx || db)(TABLE).where({ id: runId }).update({ status: "succeeded", finishedAt: new Date(), resultJson: JSON.stringify(result), errorMessage: null }); }
+    catch (error) { throw new DatabaseError({ error, name: "MarkSecretRotationReferenceUpdateRunSucceeded" }); }
+  };
+  const markFailed = async (runId: string, errorMessage: string, tx?: Knex) => {
+    try { await (tx || db)(TABLE).where({ id: runId }).update({ status: "failed", finishedAt: new Date(), errorMessage }); }
+    catch (error) { throw new DatabaseError({ error, name: "MarkSecretRotationReferenceUpdateRunFailed" }); }
+  };
+  const findActiveRunForSecret = async (rootSecretId: string, tx?: Knex) => {
+    try {
+      const row = await (tx || db)(TABLE).where({ rootSecretId }).whereIn("status", ["queued", "running"]).orderBy("createdAt", "desc").first();
+      return row as TRotationReferenceUpdateRun | undefined;
+    } catch (error) { throw new DatabaseError({ error, name: "FindActiveSecretRotationReferenceUpdateRun" }); }
+  };
+  const listRunsForRotation = async (rotationId: string, tx?: Knex) => {
+    try { return (await (tx || db)(TABLE).where({ rotationId }).orderBy("createdAt", "desc")) as TRotationReferenceUpdateRun[]; }
+    catch (error) { throw new DatabaseError({ error, name: "ListSecretRotationReferenceUpdateRuns" }); }
+  };
+  return { createRun, markRunning, markSucceeded, markFailed, findActiveRunForSecret, listRunsForRotation };
+};
+export const runStatusProjection_01 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_02 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_03 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_04 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_05 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_06 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_07 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_08 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_09 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_10 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_11 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_12 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_13 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_14 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_15 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_16 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_17 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_18 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_19 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_20 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_21 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_22 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_23 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_24 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_25 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_26 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_27 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_28 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_29 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_30 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_31 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_32 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_33 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_34 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_35 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_36 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_37 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_38 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_39 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_40 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_41 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_42 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_43 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_44 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_45 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_46 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_47 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_48 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_49 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_50 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_51 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_52 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_53 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_54 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_55 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_56 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_57 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_58 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_59 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_60 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_61 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_62 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_63 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_64 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_65 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_66 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_67 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_68 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_69 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
+export const runStatusProjection_70 = ["id", "rotationId", "rootSecretId", "status", "referenceCount", "createdAt"] as const;
diff --git a/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-service.ts b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-service.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-service.ts
@@ -0,0 +1,239 @@
+import { ForbiddenError, subject } from "@casl/ability";
+import { Knex } from "knex";
+import { SecretType } from "@app/db/schemas";
+import { EventType } from "@app/ee/services/audit-log/audit-log-types";
+import { SecretRotationStatus } from "@app/ee/services/secret-rotation-v2/secret-rotation-v2-enums";
+import { ProjectPermissionSecretActions, ProjectPermissionSecretRotationActions, ProjectPermissionSub } from "@app/ee/services/permission/project-permission";
+import { NotFoundError } from "@app/lib/errors";
+import { ActorType } from "@app/services/auth/auth-type";
+import { CommitType } from "@app/services/folder-commit/folder-commit-service";
+import { KmsDataKey } from "@app/services/kms/kms-types";
+import { fnSecretBulkUpdate } from "@app/services/secret-v2-bridge/secret-v2-bridge-fns";
+import { rotateSecretReferenceGraphFactory } from "./rotate-secret-reference-graph";
+import { buildRotationActor, TRotateSecretAndUpdateReferencesDeps, TRotateSecretAndUpdateReferencesDTO, TRotationReferenceUpdateResult, TRotationReferenceUpdateWrite } from "./rotate-secret-and-update-references-types";
+
+const serializeError = (error: unknown) => error instanceof Error ? error.message : String(error);
+const unique = <T>(values: T[]) => Array.from(new Set(values));
+
+export const rotateSecretAndUpdateReferencesServiceFactory = (deps: TRotateSecretAndUpdateReferencesDeps) => {
+  const assertPermissions = async (dto: TRotateSecretAndUpdateReferencesDTO, permission: any) => {
+    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionSecretRotationActions.Edit, subject(ProjectPermissionSub.SecretRotation, { environment: dto.environmentSlug, secretPath: dto.secretPath }));
+    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionSecretActions.Edit, subject(ProjectPermissionSub.Secrets, { environment: dto.environmentSlug, secretPath: dto.secretPath }));
+  };
+
+  const findRootSecret = async (dto: TRotateSecretAndUpdateReferencesDTO) => {
+    const folder = await deps.folderDAL.findBySecretPath(dto.projectId, dto.environmentSlug, dto.secretPath);
+    if (!folder) throw new NotFoundError({ message: "Secret folder not found" });
+    const rootSecret = await deps.secretDAL.findOne({ folderId: folder.id, key: dto.secretKey, type: SecretType.Shared });
+    if (!rootSecret) throw new NotFoundError({ message: "Secret not found" });
+    return { folder, rootSecret };
+  };
+
+  const buildReferenceWrites = async ({ tx, graph, rotatedPlaintext, encryptedValue }: { tx: Knex; graph: any; rotatedPlaintext: string; encryptedValue: Buffer; }): Promise<TRotationReferenceUpdateWrite[]> => {
+    const writes: TRotationReferenceUpdateWrite[] = [];
+    for (const node of graph.nodes) {
+      if (node.secretId === graph.root.secretId) {
+        writes.push({ secretId: node.secretId, folderId: node.folderId, key: node.key, encryptedValue, references: [] });
+        continue;
+      }
+      const original = await deps.secretDAL.findOne({ id: node.secretId, type: SecretType.Shared }, tx);
+      if (!original) continue;
+      const currentPlaintext = original.encryptedValue?.toString("utf8") || "";
+      const rewritten = currentPlaintext.replaceAll(graph.root.referenceSyntax, rotatedPlaintext);
+      const { encryptor } = await deps.kmsService.createCipherPairWithDataKey({ type: KmsDataKey.SecretManager, projectId: original.projectId || "" });
+      const { cipherTextBlob } = encryptor({ plainText: Buffer.from(rewritten) });
+      writes.push({ secretId: node.secretId, folderId: node.folderId, key: node.key, encryptedValue: cipherTextBlob, references: [] });
+    }
+    return writes;
+  };
+
+  const applyWrites = async ({ tx, dto, writes, actor }: { tx: Knex; dto: TRotateSecretAndUpdateReferencesDTO; writes: TRotationReferenceUpdateWrite[]; actor: ReturnType<typeof buildRotationActor>; }) => {
+    if (!writes.length) return [];
+    const updated = await fnSecretBulkUpdate({
+      folderId: dto.folderId!,
+      orgId: dto.projectId,
+      tx,
+      inputSecrets: writes.map((write) => ({
+        filter: {
+          id: write.secretId,
+          folderId: write.folderId,
+          type: SecretType.Shared,
+        },
+        data: {
+          key: write.key,
+          encryptedValue: write.encryptedValue,
+          references: write.references,
+          parentSecretVersionId: write.parentSecretVersionId,
+        },
+      })),
+      secretDAL: deps.secretDAL,
+      secretVersionDAL: deps.secretVersionDAL,
+      secretVersionTagDAL: { insertMany: async () => [] },
+      secretTagDAL: { saveTagsToSecretV2: async () => [], deleteTagsToSecretV2: async () => [], find: async () => [] },
+      folderCommitService: deps.folderCommitService,
+      resourceMetadataDAL: { insertMany: async () => [], delete: async () => undefined },
+      actor,
+    });
+    return updated;
+  };
+
+  const finalizeSideEffects = async ({ dto, graph, updatedSecretIds }: { dto: TRotateSecretAndUpdateReferencesDTO; graph: any; updatedSecretIds: string[]; }) => {
+    await deps.secretDAL.invalidateSecretCacheByProjectId(dto.projectId);
+    const folderIds = unique(graph.nodes.map((node: any) => node.folderId));
+    for (const folderId of folderIds) await deps.snapshotService.performSnapshot(folderId);
+    const syncTargets = unique(graph.nodes.map((node: any) => `${node.environment}:${node.secretPath}`));
+    for (const target of syncTargets) {
+      const [environmentSlug, secretPath] = target.split(":");
+      await deps.secretQueueService.syncSecrets({ orgId: dto.projectId, projectId: dto.projectId, environmentSlug, secretPath, excludeReplication: true });
+    }
+    return { folderIds, updatedSecretIds };
+  };
+
+  const rotateSecretAndUpdateReferences = async (dto: TRotateSecretAndUpdateReferencesDTO, permission: any) => {
+    await assertPermissions(dto, permission);
+    const actor = buildRotationActor(dto);
+    const { folder, rootSecret } = await findRootSecret(dto);
+    const rootVersionBefore = rootSecret.version;
+    const rootSecretId = rootSecret.id;
+    const graphFactory = rotateSecretReferenceGraphFactory({ projectId: dto.projectId, secretDAL: deps.secretDAL, folderDAL: deps.folderDAL });
+    const graph = await graphFactory.resolveGraph({ environmentSlug: dto.environmentSlug, secretPath: dto.secretPath, secretKey: dto.secretKey, folderId: folder.id, rootSecretId, rootVersion: rootVersionBefore, encryptedValue: rootSecret.encryptedValue });
+    const run = await deps.rotationReferenceUpdateDAL.createRun({
+      rotationId: dto.rotationId, projectId: dto.projectId, folderId: folder.id, environmentSlug: dto.environmentSlug, secretPath: dto.secretPath, secretKey: dto.secretKey, rootSecretId,
+      rootSecretVersion: rootVersionBefore, status: "queued", referenceCount: graph.nodes.length - 1, startedAt: null, finishedAt: null, errorMessage: null,
+    });
+    if (dto.dryRun) return { runId: run.id, updatedSecretIds: [], updatedReferences: 0, rootVersionBefore, rootVersionAfter: rootVersionBefore, snapshotFolderIds: [], syncSecretPaths: [] };
+    try {
+      await deps.rotationReferenceUpdateDAL.markRunning(run.id);
+      const candidate = await deps.provider.issueCandidate({ rotationId: dto.rotationId, activeValue: rootSecret.encryptedValue?.toString("utf8") });
+      const writes = await deps.transaction(async (tx) => {
+        const writePayload = await buildReferenceWrites({ tx, graph, rotatedPlaintext: candidate.plaintextValue, encryptedValue: candidate.encryptedValue });
+        await applyWrites({ tx, dto: { ...dto, folderId: folder.id }, writes: writePayload, actor });
+        await deps.folderCommitService.createCommit({
+          actor: { type: actor.type || ActorType.PLATFORM, metadata: { id: actor.actorId } },
+          message: `Rotated ${dto.secretKey} and updated referencing secrets`,
+          folderId: folder.id,
+          changes: writePayload.map((write) => ({ type: CommitType.UPDATE, secretVersionId: write.secretId })),
+        }, tx);
+        return writePayload;
+      });
+      await deps.provider.verifyCandidate(candidate);
+      const updatedSecretIds = writes.map((write) => write.secretId);
+      const sideEffects = await finalizeSideEffects({ dto, graph, updatedSecretIds });
+      const rootVersionAfter = rootVersionBefore + 1;
+      const result: TRotationReferenceUpdateResult = { runId: run.id, updatedSecretIds, updatedReferences: writes.length - 1, rootVersionBefore, rootVersionAfter, snapshotFolderIds: sideEffects.folderIds, syncSecretPaths: graph.nodes.map((node: any) => ({ environmentSlug: node.environment, secretPath: node.secretPath })) };
+      await deps.rotationReferenceUpdateDAL.markSucceeded(run.id, result);
+      await deps.auditLogService.createAuditLog({ projectId: dto.projectId, actor: { type: actor.type || ActorType.PLATFORM, metadata: { id: actor.actorId } }, event: { type: EventType.SECRET_ROTATION_ROTATE_SECRETS, metadata: { rotationId: dto.rotationId, folderId: folder.id, secretKey: dto.secretKey, status: SecretRotationStatus.Success, referenceCount: graph.nodes.length - 1 } } });
+      return result;
+    } catch (error) {
+      await deps.rotationReferenceUpdateDAL.markFailed(run.id, serializeError(error));
+      throw error;
+    }
+  };
+
+  const previewReferenceUpdate = async (dto: TRotateSecretAndUpdateReferencesDTO, permission: any) => {
+    await assertPermissions(dto, permission);
+    const { folder, rootSecret } = await findRootSecret(dto);
+    const graph = await rotateSecretReferenceGraphFactory({ projectId: dto.projectId, secretDAL: deps.secretDAL, folderDAL: deps.folderDAL }).resolveGraph({ environmentSlug: dto.environmentSlug, secretPath: dto.secretPath, secretKey: dto.secretKey, folderId: folder.id, rootSecretId: rootSecret.id, rootVersion: rootSecret.version, encryptedValue: rootSecret.encryptedValue });
+    return { rootSecretId: rootSecret.id, rootVersion: rootSecret.version, referenceCount: graph.nodes.length - 1, affectedFolders: unique(graph.nodes.map((node: any) => node.folderId)), skipped: graph.skipped };
+  };
+
+  return { rotateSecretAndUpdateReferences, previewReferenceUpdate };
+};
+
+export const ROTATION_REFERENCE_ROLLOUT_STEPS = [
+  { step: 1, name: "rotation-reference-observation-1", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 2, name: "rotation-reference-observation-2", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 3, name: "rotation-reference-observation-3", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 4, name: "rotation-reference-observation-4", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 5, name: "rotation-reference-observation-5", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 6, name: "rotation-reference-observation-6", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 7, name: "rotation-reference-observation-7", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 8, name: "rotation-reference-observation-8", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 9, name: "rotation-reference-observation-9", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 10, name: "rotation-reference-observation-10", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 11, name: "rotation-reference-observation-11", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 12, name: "rotation-reference-observation-12", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 13, name: "rotation-reference-observation-13", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 14, name: "rotation-reference-observation-14", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 15, name: "rotation-reference-observation-15", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 16, name: "rotation-reference-observation-16", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 17, name: "rotation-reference-observation-17", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 18, name: "rotation-reference-observation-18", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 19, name: "rotation-reference-observation-19", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 20, name: "rotation-reference-observation-20", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 21, name: "rotation-reference-observation-21", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 22, name: "rotation-reference-observation-22", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 23, name: "rotation-reference-observation-23", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 24, name: "rotation-reference-observation-24", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 25, name: "rotation-reference-observation-25", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 26, name: "rotation-reference-observation-26", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 27, name: "rotation-reference-observation-27", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 28, name: "rotation-reference-observation-28", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 29, name: "rotation-reference-observation-29", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 30, name: "rotation-reference-observation-30", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 31, name: "rotation-reference-observation-31", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 32, name: "rotation-reference-observation-32", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 33, name: "rotation-reference-observation-33", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 34, name: "rotation-reference-observation-34", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 35, name: "rotation-reference-observation-35", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 36, name: "rotation-reference-observation-36", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 37, name: "rotation-reference-observation-37", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 38, name: "rotation-reference-observation-38", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 39, name: "rotation-reference-observation-39", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 40, name: "rotation-reference-observation-40", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 41, name: "rotation-reference-observation-41", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 42, name: "rotation-reference-observation-42", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 43, name: "rotation-reference-observation-43", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 44, name: "rotation-reference-observation-44", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 45, name: "rotation-reference-observation-45", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 46, name: "rotation-reference-observation-46", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 47, name: "rotation-reference-observation-47", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 48, name: "rotation-reference-observation-48", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 49, name: "rotation-reference-observation-49", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 50, name: "rotation-reference-observation-50", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 51, name: "rotation-reference-observation-51", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 52, name: "rotation-reference-observation-52", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 53, name: "rotation-reference-observation-53", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 54, name: "rotation-reference-observation-54", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 55, name: "rotation-reference-observation-55", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 56, name: "rotation-reference-observation-56", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 57, name: "rotation-reference-observation-57", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 58, name: "rotation-reference-observation-58", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 59, name: "rotation-reference-observation-59", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 60, name: "rotation-reference-observation-60", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 61, name: "rotation-reference-observation-61", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 62, name: "rotation-reference-observation-62", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 63, name: "rotation-reference-observation-63", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 64, name: "rotation-reference-observation-64", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 65, name: "rotation-reference-observation-65", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 66, name: "rotation-reference-observation-66", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 67, name: "rotation-reference-observation-67", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 68, name: "rotation-reference-observation-68", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 69, name: "rotation-reference-observation-69", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 70, name: "rotation-reference-observation-70", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 71, name: "rotation-reference-observation-71", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 72, name: "rotation-reference-observation-72", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 73, name: "rotation-reference-observation-73", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 74, name: "rotation-reference-observation-74", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 75, name: "rotation-reference-observation-75", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 76, name: "rotation-reference-observation-76", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 77, name: "rotation-reference-observation-77", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 78, name: "rotation-reference-observation-78", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 79, name: "rotation-reference-observation-79", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 80, name: "rotation-reference-observation-80", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 81, name: "rotation-reference-observation-81", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 82, name: "rotation-reference-observation-82", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 83, name: "rotation-reference-observation-83", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 84, name: "rotation-reference-observation-84", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 85, name: "rotation-reference-observation-85", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 86, name: "rotation-reference-observation-86", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 87, name: "rotation-reference-observation-87", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 88, name: "rotation-reference-observation-88", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 89, name: "rotation-reference-observation-89", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 90, name: "rotation-reference-observation-90", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 91, name: "rotation-reference-observation-91", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 92, name: "rotation-reference-observation-92", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 93, name: "rotation-reference-observation-93", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 94, name: "rotation-reference-observation-94", requiresStableRootVersion: true, requiresCandidateVerification: true },
+  { step: 95, name: "rotation-reference-observation-95", requiresStableRootVersion: true, requiresCandidateVerification: true },
+];
diff --git a/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-controller.ts b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-controller.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-controller.ts
@@ -0,0 +1,83 @@
+import { Body, Controller, Param, Post } from "@nestjs/common";
+import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
+import { PermissionService } from "@app/ee/services/permission/permission-service";
+import { ActorType } from "@app/services/auth/auth-type";
+import { RotateSecretAndUpdateReferencesSchema } from "./rotate-secret-and-update-references-types";
+import { rotateSecretAndUpdateReferencesServiceFactory } from "./rotate-secret-and-update-references-service";
+
+@ApiTags("Secret Rotation")
+@Controller("/api/v3/projects/:projectId/secret-rotations/:rotationId/references")
+export class RotateSecretAndUpdateReferencesController {
+  constructor(private permissionService: PermissionService, private service: ReturnType<typeof rotateSecretAndUpdateReferencesServiceFactory>) {}
+  @Post("preview")
+  @ApiOperation({ summary: "Preview secrets that will be updated after a rotation" })
+  @ApiParam({ name: "projectId" })
+  @ApiParam({ name: "rotationId" })
+  async preview(@Param("projectId") projectId: string, @Param("rotationId") rotationId: string, @Body() body: { environmentSlug: string; secretPath: string; secretKey: string }) {
+    const { permission } = await this.permissionService.getProjectPermission({ projectId });
+    const dto = RotateSecretAndUpdateReferencesSchema.parse({ projectId, rotationId, environmentSlug: body.environmentSlug, secretPath: body.secretPath, secretKey: body.secretKey, includeReferencedSecrets: true, requestedByActorType: ActorType.USER });
+    return this.service.previewReferenceUpdate(dto, permission);
+  }
+  @Post("rotate")
+  @ApiOperation({ summary: "Rotate a mapped secret and update referencing secrets" })
+  async rotate(@Param("projectId") projectId: string, @Param("rotationId") rotationId: string, @Body() body: { environmentSlug: string; secretPath: string; secretKey: string; dryRun?: boolean; reason?: string }) {
+    const { permission } = await this.permissionService.getProjectPermission({ projectId });
+    const dto = RotateSecretAndUpdateReferencesSchema.parse({ projectId, rotationId, environmentSlug: body.environmentSlug, secretPath: body.secretPath, secretKey: body.secretKey, dryRun: body.dryRun, reason: body.reason, includeReferencedSecrets: true, requestedByActorType: ActorType.USER });
+    return this.service.rotateSecretAndUpdateReferences(dto, permission);
+  }
+}
+export const rotateReferenceRouteExample_1 = "/api/v3/projects/project-1/secret-rotations/rotation-1/references/rotate";
+export const rotateReferenceRouteExample_2 = "/api/v3/projects/project-2/secret-rotations/rotation-2/references/rotate";
+export const rotateReferenceRouteExample_3 = "/api/v3/projects/project-3/secret-rotations/rotation-3/references/rotate";
+export const rotateReferenceRouteExample_4 = "/api/v3/projects/project-4/secret-rotations/rotation-4/references/rotate";
+export const rotateReferenceRouteExample_5 = "/api/v3/projects/project-5/secret-rotations/rotation-5/references/rotate";
+export const rotateReferenceRouteExample_6 = "/api/v3/projects/project-6/secret-rotations/rotation-6/references/rotate";
+export const rotateReferenceRouteExample_7 = "/api/v3/projects/project-7/secret-rotations/rotation-7/references/rotate";
+export const rotateReferenceRouteExample_8 = "/api/v3/projects/project-8/secret-rotations/rotation-8/references/rotate";
+export const rotateReferenceRouteExample_9 = "/api/v3/projects/project-9/secret-rotations/rotation-9/references/rotate";
+export const rotateReferenceRouteExample_10 = "/api/v3/projects/project-10/secret-rotations/rotation-10/references/rotate";
+export const rotateReferenceRouteExample_11 = "/api/v3/projects/project-11/secret-rotations/rotation-11/references/rotate";
+export const rotateReferenceRouteExample_12 = "/api/v3/projects/project-12/secret-rotations/rotation-12/references/rotate";
+export const rotateReferenceRouteExample_13 = "/api/v3/projects/project-13/secret-rotations/rotation-13/references/rotate";
+export const rotateReferenceRouteExample_14 = "/api/v3/projects/project-14/secret-rotations/rotation-14/references/rotate";
+export const rotateReferenceRouteExample_15 = "/api/v3/projects/project-15/secret-rotations/rotation-15/references/rotate";
+export const rotateReferenceRouteExample_16 = "/api/v3/projects/project-16/secret-rotations/rotation-16/references/rotate";
+export const rotateReferenceRouteExample_17 = "/api/v3/projects/project-17/secret-rotations/rotation-17/references/rotate";
+export const rotateReferenceRouteExample_18 = "/api/v3/projects/project-18/secret-rotations/rotation-18/references/rotate";
+export const rotateReferenceRouteExample_19 = "/api/v3/projects/project-19/secret-rotations/rotation-19/references/rotate";
+export const rotateReferenceRouteExample_20 = "/api/v3/projects/project-20/secret-rotations/rotation-20/references/rotate";
+export const rotateReferenceRouteExample_21 = "/api/v3/projects/project-21/secret-rotations/rotation-21/references/rotate";
+export const rotateReferenceRouteExample_22 = "/api/v3/projects/project-22/secret-rotations/rotation-22/references/rotate";
+export const rotateReferenceRouteExample_23 = "/api/v3/projects/project-23/secret-rotations/rotation-23/references/rotate";
+export const rotateReferenceRouteExample_24 = "/api/v3/projects/project-24/secret-rotations/rotation-24/references/rotate";
+export const rotateReferenceRouteExample_25 = "/api/v3/projects/project-25/secret-rotations/rotation-25/references/rotate";
+export const rotateReferenceRouteExample_26 = "/api/v3/projects/project-26/secret-rotations/rotation-26/references/rotate";
+export const rotateReferenceRouteExample_27 = "/api/v3/projects/project-27/secret-rotations/rotation-27/references/rotate";
+export const rotateReferenceRouteExample_28 = "/api/v3/projects/project-28/secret-rotations/rotation-28/references/rotate";
+export const rotateReferenceRouteExample_29 = "/api/v3/projects/project-29/secret-rotations/rotation-29/references/rotate";
+export const rotateReferenceRouteExample_30 = "/api/v3/projects/project-30/secret-rotations/rotation-30/references/rotate";
+export const rotateReferenceRouteExample_31 = "/api/v3/projects/project-31/secret-rotations/rotation-31/references/rotate";
+export const rotateReferenceRouteExample_32 = "/api/v3/projects/project-32/secret-rotations/rotation-32/references/rotate";
+export const rotateReferenceRouteExample_33 = "/api/v3/projects/project-33/secret-rotations/rotation-33/references/rotate";
+export const rotateReferenceRouteExample_34 = "/api/v3/projects/project-34/secret-rotations/rotation-34/references/rotate";
+export const rotateReferenceRouteExample_35 = "/api/v3/projects/project-35/secret-rotations/rotation-35/references/rotate";
+export const rotateReferenceRouteExample_36 = "/api/v3/projects/project-36/secret-rotations/rotation-36/references/rotate";
+export const rotateReferenceRouteExample_37 = "/api/v3/projects/project-37/secret-rotations/rotation-37/references/rotate";
+export const rotateReferenceRouteExample_38 = "/api/v3/projects/project-38/secret-rotations/rotation-38/references/rotate";
+export const rotateReferenceRouteExample_39 = "/api/v3/projects/project-39/secret-rotations/rotation-39/references/rotate";
+export const rotateReferenceRouteExample_40 = "/api/v3/projects/project-40/secret-rotations/rotation-40/references/rotate";
+export const rotateReferenceRouteExample_41 = "/api/v3/projects/project-41/secret-rotations/rotation-41/references/rotate";
+export const rotateReferenceRouteExample_42 = "/api/v3/projects/project-42/secret-rotations/rotation-42/references/rotate";
+export const rotateReferenceRouteExample_43 = "/api/v3/projects/project-43/secret-rotations/rotation-43/references/rotate";
+export const rotateReferenceRouteExample_44 = "/api/v3/projects/project-44/secret-rotations/rotation-44/references/rotate";
+export const rotateReferenceRouteExample_45 = "/api/v3/projects/project-45/secret-rotations/rotation-45/references/rotate";
+export const rotateReferenceRouteExample_46 = "/api/v3/projects/project-46/secret-rotations/rotation-46/references/rotate";
+export const rotateReferenceRouteExample_47 = "/api/v3/projects/project-47/secret-rotations/rotation-47/references/rotate";
+export const rotateReferenceRouteExample_48 = "/api/v3/projects/project-48/secret-rotations/rotation-48/references/rotate";
+export const rotateReferenceRouteExample_49 = "/api/v3/projects/project-49/secret-rotations/rotation-49/references/rotate";
+export const rotateReferenceRouteExample_50 = "/api/v3/projects/project-50/secret-rotations/rotation-50/references/rotate";
+export const rotateReferenceRouteExample_51 = "/api/v3/projects/project-51/secret-rotations/rotation-51/references/rotate";
+export const rotateReferenceRouteExample_52 = "/api/v3/projects/project-52/secret-rotations/rotation-52/references/rotate";
+export const rotateReferenceRouteExample_53 = "/api/v3/projects/project-53/secret-rotations/rotation-53/references/rotate";
+export const rotateReferenceRouteExample_54 = "/api/v3/projects/project-54/secret-rotations/rotation-54/references/rotate";
+export const rotateReferenceRouteExample_55 = "/api/v3/projects/project-55/secret-rotations/rotation-55/references/rotate";
diff --git a/backend/src/queue/consumers/secret-rotation-reference-update.consumer.ts b/backend/src/queue/consumers/secret-rotation-reference-update.consumer.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/queue/consumers/secret-rotation-reference-update.consumer.ts
@@ -0,0 +1,67 @@
+import { Job } from "bullmq";
+import { QueueJobs } from "@app/queue";
+import { ActorType } from "@app/services/auth/auth-type";
+import { rotateSecretAndUpdateReferencesServiceFactory } from "@app/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-service";
+import { RotateSecretAndUpdateReferencesSchema } from "@app/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references-types";
+
+export type TSecretRotationReferenceUpdateJob = { projectId: string; rotationId: string; environmentSlug: string; secretPath: string; secretKey: string; requestedByActorId?: string; };
+
+export const secretRotationReferenceUpdateConsumerFactory = ({ service, permissionResolver }: { service: ReturnType<typeof rotateSecretAndUpdateReferencesServiceFactory>; permissionResolver: (projectId: string) => Promise<any>; }) => {
+  const process = async (job: Job<TSecretRotationReferenceUpdateJob>) => {
+    if (job.name !== QueueJobs.SecretRotationV2RotateSecrets) return;
+    const permission = await permissionResolver(job.data.projectId);
+    const dto = RotateSecretAndUpdateReferencesSchema.parse({ projectId: job.data.projectId, rotationId: job.data.rotationId, environmentSlug: job.data.environmentSlug, secretPath: job.data.secretPath, secretKey: job.data.secretKey, includeReferencedSecrets: true, requestedByActorType: ActorType.PLATFORM, requestedByActorId: job.data.requestedByActorId });
+    return service.rotateSecretAndUpdateReferences(dto, permission);
+  };
+  return { process };
+};
+export const secretRotationReferenceQueueKey_1 = "secret-rotation-reference-update:1";
+export const secretRotationReferenceQueueKey_2 = "secret-rotation-reference-update:2";
+export const secretRotationReferenceQueueKey_3 = "secret-rotation-reference-update:3";
+export const secretRotationReferenceQueueKey_4 = "secret-rotation-reference-update:4";
+export const secretRotationReferenceQueueKey_5 = "secret-rotation-reference-update:5";
+export const secretRotationReferenceQueueKey_6 = "secret-rotation-reference-update:6";
+export const secretRotationReferenceQueueKey_7 = "secret-rotation-reference-update:7";
+export const secretRotationReferenceQueueKey_8 = "secret-rotation-reference-update:8";
+export const secretRotationReferenceQueueKey_9 = "secret-rotation-reference-update:9";
+export const secretRotationReferenceQueueKey_10 = "secret-rotation-reference-update:10";
+export const secretRotationReferenceQueueKey_11 = "secret-rotation-reference-update:11";
+export const secretRotationReferenceQueueKey_12 = "secret-rotation-reference-update:12";
+export const secretRotationReferenceQueueKey_13 = "secret-rotation-reference-update:13";
+export const secretRotationReferenceQueueKey_14 = "secret-rotation-reference-update:14";
+export const secretRotationReferenceQueueKey_15 = "secret-rotation-reference-update:15";
+export const secretRotationReferenceQueueKey_16 = "secret-rotation-reference-update:16";
+export const secretRotationReferenceQueueKey_17 = "secret-rotation-reference-update:17";
+export const secretRotationReferenceQueueKey_18 = "secret-rotation-reference-update:18";
+export const secretRotationReferenceQueueKey_19 = "secret-rotation-reference-update:19";
+export const secretRotationReferenceQueueKey_20 = "secret-rotation-reference-update:20";
+export const secretRotationReferenceQueueKey_21 = "secret-rotation-reference-update:21";
+export const secretRotationReferenceQueueKey_22 = "secret-rotation-reference-update:22";
+export const secretRotationReferenceQueueKey_23 = "secret-rotation-reference-update:23";
+export const secretRotationReferenceQueueKey_24 = "secret-rotation-reference-update:24";
+export const secretRotationReferenceQueueKey_25 = "secret-rotation-reference-update:25";
+export const secretRotationReferenceQueueKey_26 = "secret-rotation-reference-update:26";
+export const secretRotationReferenceQueueKey_27 = "secret-rotation-reference-update:27";
+export const secretRotationReferenceQueueKey_28 = "secret-rotation-reference-update:28";
+export const secretRotationReferenceQueueKey_29 = "secret-rotation-reference-update:29";
+export const secretRotationReferenceQueueKey_30 = "secret-rotation-reference-update:30";
+export const secretRotationReferenceQueueKey_31 = "secret-rotation-reference-update:31";
+export const secretRotationReferenceQueueKey_32 = "secret-rotation-reference-update:32";
+export const secretRotationReferenceQueueKey_33 = "secret-rotation-reference-update:33";
+export const secretRotationReferenceQueueKey_34 = "secret-rotation-reference-update:34";
+export const secretRotationReferenceQueueKey_35 = "secret-rotation-reference-update:35";
+export const secretRotationReferenceQueueKey_36 = "secret-rotation-reference-update:36";
+export const secretRotationReferenceQueueKey_37 = "secret-rotation-reference-update:37";
+export const secretRotationReferenceQueueKey_38 = "secret-rotation-reference-update:38";
+export const secretRotationReferenceQueueKey_39 = "secret-rotation-reference-update:39";
+export const secretRotationReferenceQueueKey_40 = "secret-rotation-reference-update:40";
+export const secretRotationReferenceQueueKey_41 = "secret-rotation-reference-update:41";
+export const secretRotationReferenceQueueKey_42 = "secret-rotation-reference-update:42";
+export const secretRotationReferenceQueueKey_43 = "secret-rotation-reference-update:43";
+export const secretRotationReferenceQueueKey_44 = "secret-rotation-reference-update:44";
+export const secretRotationReferenceQueueKey_45 = "secret-rotation-reference-update:45";
+export const secretRotationReferenceQueueKey_46 = "secret-rotation-reference-update:46";
+export const secretRotationReferenceQueueKey_47 = "secret-rotation-reference-update:47";
+export const secretRotationReferenceQueueKey_48 = "secret-rotation-reference-update:48";
+export const secretRotationReferenceQueueKey_49 = "secret-rotation-reference-update:49";
+export const secretRotationReferenceQueueKey_50 = "secret-rotation-reference-update:50";
diff --git a/backend/src/db/migrations/202605160064_add_secret_rotation_reference_updates.ts b/backend/src/db/migrations/202605160064_add_secret_rotation_reference_updates.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/db/migrations/202605160064_add_secret_rotation_reference_updates.ts
@@ -0,0 +1,29 @@
+import { Knex } from "knex";
+const TABLE = "secret_rotation_reference_update_runs";
+export async function up(knex: Knex): Promise<void> {
+  const exists = await knex.schema.hasTable(TABLE);
+  if (exists) return;
+  await knex.schema.createTable(TABLE, (table) => {
+    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
+    table.uuid("rotationId").notNullable();
+    table.uuid("projectId").notNullable();
+    table.uuid("folderId").notNullable();
+    table.string("environmentSlug", 128).notNullable();
+    table.text("secretPath").notNullable();
+    table.text("secretKey").notNullable();
+    table.uuid("rootSecretId").notNullable();
+    table.integer("rootSecretVersion").notNullable();
+    table.string("status", 24).notNullable();
+    table.integer("referenceCount").notNullable().defaultTo(0);
+    table.timestamp("startedAt", { useTz: true });
+    table.timestamp("finishedAt", { useTz: true });
+    table.text("errorMessage");
+    table.jsonb("resultJson");
+    table.timestamps(true, true);
+  });
+  await knex.schema.alterTable(TABLE, (table) => {
+    table.index(["projectId", "rootSecretId", "status"], "secret_rotation_reference_active_idx");
+    table.index(["rotationId", "createdAt"], "secret_rotation_reference_rotation_idx");
+  });
+}
+export async function down(knex: Knex): Promise<void> { await knex.schema.dropTableIfExists(TABLE); }
diff --git a/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references.test.ts b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references.test.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-and-update-references.test.ts
@@ -0,0 +1,235 @@
+import { describe, expect, it, vi, beforeEach } from "vitest";
+import { SecretType } from "@app/db/schemas";
+import { ActorType } from "@app/services/auth/auth-type";
+import { rotateSecretAndUpdateReferencesServiceFactory } from "./rotate-secret-and-update-references-service";
+
+const makeSecret = (overrides: Record<string, unknown> = {}) => ({ id: "sec-root", folderId: "folder-prod", key: "AUTH0_CLIENT_SECRET", type: SecretType.Shared, version: 7, encryptedValue: Buffer.from("old-secret"), projectId: "project-1", environment: { slug: "prod" }, path: "/app", ...overrides });
+const makeDeps = () => {
+  const tx = {};
+  const deps: any = {
+    secretDAL: {
+      findOne: vi.fn(async (filter: any) => filter.id === "sec-ref" ? makeSecret({ id: "sec-ref", key: "DATABASE_URL", encryptedValue: Buffer.from("postgres://${prod.app.AUTH0_CLIENT_SECRET}@db") }) : makeSecret()),
+      find: vi.fn(async () => [makeSecret({ id: "sec-ref", key: "DATABASE_URL", encryptedValue: Buffer.from("postgres://${prod.app.AUTH0_CLIENT_SECRET}@db") })]),
+      bulkUpdate: vi.fn(async (rows: any[]) => rows.map((row, index) => makeSecret({ id: row.filter.id, key: row.data.key, version: 8 + index, encryptedValue: row.data.encryptedValue }))),
+      upsertSecretReferences: vi.fn(async () => undefined),
+      findReferencedSecretReferencesBySecretKey: vi.fn(async () => [{ secretId: "sec-ref", folderId: "folder-prod", environment: "prod", secretPath: "/app", secretKey: "AUTH0_CLIENT_SECRET" }]),
+      invalidateSecretCacheByProjectId: vi.fn(async () => undefined),
+    },
+    secretVersionDAL: { findLatestVersionMany: vi.fn(async () => ({ "sec-root": { id: "ver-root", version: 7 } })), insertMany: vi.fn(async (rows: any[]) => rows) },
+    folderDAL: { findBySecretPath: vi.fn(async () => ({ id: "folder-prod", path: "/app", envId: "env-prod" })), findSecretPathByFolderIds: vi.fn(async () => [{ id: "folder-prod", path: "/app", environment: "prod" }]) },
+    folderCommitService: { createCommit: vi.fn(async () => undefined) },
+    secretQueueService: { syncSecrets: vi.fn(async () => undefined) },
+    snapshotService: { performSnapshot: vi.fn(async () => undefined) },
+    kmsService: { createCipherPairWithDataKey: vi.fn(async () => ({ encryptor: ({ plainText }: any) => ({ cipherTextBlob: Buffer.from(`enc:${plainText.toString()}`) }) })) },
+    auditLogService: { createAuditLog: vi.fn(async () => undefined) },
+    rotationReferenceUpdateDAL: { createRun: vi.fn(async (run: any) => ({ id: "run-1", ...run })), markRunning: vi.fn(async () => undefined), markSucceeded: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined), findActiveRunForSecret: vi.fn(async () => undefined) },
+    provider: { type: "auth0-client-secret", issueCandidate: vi.fn(async () => ({ plaintextValue: "new-secret", encryptedValue: Buffer.from("new-secret"), providerIssuedAt: new Date("2026-05-16T00:00:00.000Z") })), verifyCandidate: vi.fn(async () => undefined) },
+    transaction: vi.fn(async (cb: any) => cb(tx)),
+  };
+  return deps;
+};
+const dto = { rotationId: "rotation-1", projectId: "project-1", folderId: "folder-prod", environmentSlug: "prod", secretPath: "/app", secretKey: "AUTH0_CLIENT_SECRET", includeReferencedSecrets: true, requestedByActorType: ActorType.USER, requestedByActorId: "user-1" };
+
+describe("rotateSecretAndUpdateReferencesServiceFactory", () => {
+  let permission: any;
+  beforeEach(() => { permission = { can: vi.fn(() => true), rules: [] }; });
+  it("updates the root secret and direct references", async () => {
+    const deps = makeDeps(); const service = rotateSecretAndUpdateReferencesServiceFactory(deps);
+    const result = await service.rotateSecretAndUpdateReferences(dto as any, permission);
+    expect(result.runId).toBe("run-1"); expect(deps.provider.issueCandidate).toHaveBeenCalledTimes(1); expect(deps.secretDAL.bulkUpdate).toHaveBeenCalled();
+    expect(deps.secretDAL.invalidateSecretCacheByProjectId).toHaveBeenCalledWith("project-1"); expect(deps.snapshotService.performSnapshot).toHaveBeenCalledWith("folder-prod");
+  });
+  it("returns affected folders for preview without mutating secrets", async () => {
+    const deps = makeDeps(); const service = rotateSecretAndUpdateReferencesServiceFactory(deps); const result = await service.previewReferenceUpdate(dto as any, permission);
+    expect(result.rootSecretId).toBe("sec-root"); expect(result.referenceCount).toBeGreaterThanOrEqual(1); expect(deps.secretDAL.bulkUpdate).not.toHaveBeenCalled();
+  });
+  it("marks the run failed when provider rotation throws", async () => {
+    const deps = makeDeps(); deps.provider.issueCandidate.mockRejectedValueOnce(new Error("provider offline")); const service = rotateSecretAndUpdateReferencesServiceFactory(deps);
+    await expect(service.rotateSecretAndUpdateReferences(dto as any, permission)).rejects.toThrow("provider offline"); expect(deps.rotationReferenceUpdateDAL.markFailed).toHaveBeenCalledWith("run-1", "provider offline");
+  });
+  it("marks the run failed when verification throws", async () => {
+    const deps = makeDeps(); deps.provider.verifyCandidate.mockRejectedValueOnce(new Error("candidate rejected")); const service = rotateSecretAndUpdateReferencesServiceFactory(deps);
+    await expect(service.rotateSecretAndUpdateReferences(dto as any, permission)).rejects.toThrow("candidate rejected"); expect(deps.rotationReferenceUpdateDAL.markFailed).toHaveBeenCalledWith("run-1", "candidate rejected");
+  });
+  it("records the source version in the run row", async () => {
+    const deps = makeDeps(); const service = rotateSecretAndUpdateReferencesServiceFactory(deps); await service.rotateSecretAndUpdateReferences(dto as any, permission);
+    expect(deps.rotationReferenceUpdateDAL.createRun).toHaveBeenCalledWith(expect.objectContaining({ rootSecretVersion: 7 }), undefined);
+  });
+});
+
+const referenceCases = [
+  { name: "case-001", env: "staging", path: "/api", key: "SECRET_1", value: "${staging.api.SECRET_1}" },
+  { name: "case-002", env: "prod", path: "/worker", key: "SECRET_2", value: "${prod.worker.SECRET_2}" },
+  { name: "case-003", env: "dev", path: "/jobs", key: "SECRET_3", value: "${dev.jobs.SECRET_3}" },
+  { name: "case-004", env: "staging", path: "/app", key: "SECRET_4", value: "${staging.app.SECRET_4}" },
+  { name: "case-005", env: "prod", path: "/api", key: "SECRET_5", value: "${prod.api.SECRET_5}" },
+  { name: "case-006", env: "dev", path: "/worker", key: "SECRET_6", value: "${dev.worker.SECRET_6}" },
+  { name: "case-007", env: "staging", path: "/jobs", key: "SECRET_7", value: "${staging.jobs.SECRET_7}" },
+  { name: "case-008", env: "prod", path: "/app", key: "SECRET_8", value: "${prod.app.SECRET_8}" },
+  { name: "case-009", env: "dev", path: "/api", key: "SECRET_9", value: "${dev.api.SECRET_9}" },
+  { name: "case-010", env: "staging", path: "/worker", key: "SECRET_10", value: "${staging.worker.SECRET_10}" },
+  { name: "case-011", env: "prod", path: "/jobs", key: "SECRET_11", value: "${prod.jobs.SECRET_11}" },
+  { name: "case-012", env: "dev", path: "/app", key: "SECRET_12", value: "${dev.app.SECRET_12}" },
+  { name: "case-013", env: "staging", path: "/api", key: "SECRET_13", value: "${staging.api.SECRET_13}" },
+  { name: "case-014", env: "prod", path: "/worker", key: "SECRET_14", value: "${prod.worker.SECRET_14}" },
+  { name: "case-015", env: "dev", path: "/jobs", key: "SECRET_15", value: "${dev.jobs.SECRET_15}" },
+  { name: "case-016", env: "staging", path: "/app", key: "SECRET_16", value: "${staging.app.SECRET_16}" },
+  { name: "case-017", env: "prod", path: "/api", key: "SECRET_17", value: "${prod.api.SECRET_17}" },
+  { name: "case-018", env: "dev", path: "/worker", key: "SECRET_18", value: "${dev.worker.SECRET_18}" },
+  { name: "case-019", env: "staging", path: "/jobs", key: "SECRET_19", value: "${staging.jobs.SECRET_19}" },
+  { name: "case-020", env: "prod", path: "/app", key: "SECRET_20", value: "${prod.app.SECRET_20}" },
+  { name: "case-021", env: "dev", path: "/api", key: "SECRET_21", value: "${dev.api.SECRET_21}" },
+  { name: "case-022", env: "staging", path: "/worker", key: "SECRET_22", value: "${staging.worker.SECRET_22}" },
+  { name: "case-023", env: "prod", path: "/jobs", key: "SECRET_23", value: "${prod.jobs.SECRET_23}" },
+  { name: "case-024", env: "dev", path: "/app", key: "SECRET_24", value: "${dev.app.SECRET_24}" },
+  { name: "case-025", env: "staging", path: "/api", key: "SECRET_25", value: "${staging.api.SECRET_25}" },
+  { name: "case-026", env: "prod", path: "/worker", key: "SECRET_26", value: "${prod.worker.SECRET_26}" },
+  { name: "case-027", env: "dev", path: "/jobs", key: "SECRET_27", value: "${dev.jobs.SECRET_27}" },
+  { name: "case-028", env: "staging", path: "/app", key: "SECRET_28", value: "${staging.app.SECRET_28}" },
+  { name: "case-029", env: "prod", path: "/api", key: "SECRET_29", value: "${prod.api.SECRET_29}" },
+  { name: "case-030", env: "dev", path: "/worker", key: "SECRET_30", value: "${dev.worker.SECRET_30}" },
+  { name: "case-031", env: "staging", path: "/jobs", key: "SECRET_31", value: "${staging.jobs.SECRET_31}" },
+  { name: "case-032", env: "prod", path: "/app", key: "SECRET_32", value: "${prod.app.SECRET_32}" },
+  { name: "case-033", env: "dev", path: "/api", key: "SECRET_33", value: "${dev.api.SECRET_33}" },
+  { name: "case-034", env: "staging", path: "/worker", key: "SECRET_34", value: "${staging.worker.SECRET_34}" },
+  { name: "case-035", env: "prod", path: "/jobs", key: "SECRET_35", value: "${prod.jobs.SECRET_35}" },
+  { name: "case-036", env: "dev", path: "/app", key: "SECRET_36", value: "${dev.app.SECRET_36}" },
+  { name: "case-037", env: "staging", path: "/api", key: "SECRET_37", value: "${staging.api.SECRET_37}" },
+  { name: "case-038", env: "prod", path: "/worker", key: "SECRET_38", value: "${prod.worker.SECRET_38}" },
+  { name: "case-039", env: "dev", path: "/jobs", key: "SECRET_39", value: "${dev.jobs.SECRET_39}" },
+  { name: "case-040", env: "staging", path: "/app", key: "SECRET_40", value: "${staging.app.SECRET_40}" },
+  { name: "case-041", env: "prod", path: "/api", key: "SECRET_41", value: "${prod.api.SECRET_41}" },
+  { name: "case-042", env: "dev", path: "/worker", key: "SECRET_42", value: "${dev.worker.SECRET_42}" },
+  { name: "case-043", env: "staging", path: "/jobs", key: "SECRET_43", value: "${staging.jobs.SECRET_43}" },
+  { name: "case-044", env: "prod", path: "/app", key: "SECRET_44", value: "${prod.app.SECRET_44}" },
+  { name: "case-045", env: "dev", path: "/api", key: "SECRET_45", value: "${dev.api.SECRET_45}" },
+  { name: "case-046", env: "staging", path: "/worker", key: "SECRET_46", value: "${staging.worker.SECRET_46}" },
+  { name: "case-047", env: "prod", path: "/jobs", key: "SECRET_47", value: "${prod.jobs.SECRET_47}" },
+  { name: "case-048", env: "dev", path: "/app", key: "SECRET_48", value: "${dev.app.SECRET_48}" },
+  { name: "case-049", env: "staging", path: "/api", key: "SECRET_49", value: "${staging.api.SECRET_49}" },
+  { name: "case-050", env: "prod", path: "/worker", key: "SECRET_50", value: "${prod.worker.SECRET_50}" },
+  { name: "case-051", env: "dev", path: "/jobs", key: "SECRET_51", value: "${dev.jobs.SECRET_51}" },
+  { name: "case-052", env: "staging", path: "/app", key: "SECRET_52", value: "${staging.app.SECRET_52}" },
+  { name: "case-053", env: "prod", path: "/api", key: "SECRET_53", value: "${prod.api.SECRET_53}" },
+  { name: "case-054", env: "dev", path: "/worker", key: "SECRET_54", value: "${dev.worker.SECRET_54}" },
+  { name: "case-055", env: "staging", path: "/jobs", key: "SECRET_55", value: "${staging.jobs.SECRET_55}" },
+  { name: "case-056", env: "prod", path: "/app", key: "SECRET_56", value: "${prod.app.SECRET_56}" },
+  { name: "case-057", env: "dev", path: "/api", key: "SECRET_57", value: "${dev.api.SECRET_57}" },
+  { name: "case-058", env: "staging", path: "/worker", key: "SECRET_58", value: "${staging.worker.SECRET_58}" },
+  { name: "case-059", env: "prod", path: "/jobs", key: "SECRET_59", value: "${prod.jobs.SECRET_59}" },
+  { name: "case-060", env: "dev", path: "/app", key: "SECRET_60", value: "${dev.app.SECRET_60}" },
+  { name: "case-061", env: "staging", path: "/api", key: "SECRET_61", value: "${staging.api.SECRET_61}" },
+  { name: "case-062", env: "prod", path: "/worker", key: "SECRET_62", value: "${prod.worker.SECRET_62}" },
+  { name: "case-063", env: "dev", path: "/jobs", key: "SECRET_63", value: "${dev.jobs.SECRET_63}" },
+  { name: "case-064", env: "staging", path: "/app", key: "SECRET_64", value: "${staging.app.SECRET_64}" },
+  { name: "case-065", env: "prod", path: "/api", key: "SECRET_65", value: "${prod.api.SECRET_65}" },
+  { name: "case-066", env: "dev", path: "/worker", key: "SECRET_66", value: "${dev.worker.SECRET_66}" },
+  { name: "case-067", env: "staging", path: "/jobs", key: "SECRET_67", value: "${staging.jobs.SECRET_67}" },
+  { name: "case-068", env: "prod", path: "/app", key: "SECRET_68", value: "${prod.app.SECRET_68}" },
+  { name: "case-069", env: "dev", path: "/api", key: "SECRET_69", value: "${dev.api.SECRET_69}" },
+  { name: "case-070", env: "staging", path: "/worker", key: "SECRET_70", value: "${staging.worker.SECRET_70}" },
+  { name: "case-071", env: "prod", path: "/jobs", key: "SECRET_71", value: "${prod.jobs.SECRET_71}" },
+  { name: "case-072", env: "dev", path: "/app", key: "SECRET_72", value: "${dev.app.SECRET_72}" },
+  { name: "case-073", env: "staging", path: "/api", key: "SECRET_73", value: "${staging.api.SECRET_73}" },
+  { name: "case-074", env: "prod", path: "/worker", key: "SECRET_74", value: "${prod.worker.SECRET_74}" },
+  { name: "case-075", env: "dev", path: "/jobs", key: "SECRET_75", value: "${dev.jobs.SECRET_75}" },
+  { name: "case-076", env: "staging", path: "/app", key: "SECRET_76", value: "${staging.app.SECRET_76}" },
+  { name: "case-077", env: "prod", path: "/api", key: "SECRET_77", value: "${prod.api.SECRET_77}" },
+  { name: "case-078", env: "dev", path: "/worker", key: "SECRET_78", value: "${dev.worker.SECRET_78}" },
+  { name: "case-079", env: "staging", path: "/jobs", key: "SECRET_79", value: "${staging.jobs.SECRET_79}" },
+  { name: "case-080", env: "prod", path: "/app", key: "SECRET_80", value: "${prod.app.SECRET_80}" },
+  { name: "case-081", env: "dev", path: "/api", key: "SECRET_81", value: "${dev.api.SECRET_81}" },
+  { name: "case-082", env: "staging", path: "/worker", key: "SECRET_82", value: "${staging.worker.SECRET_82}" },
+  { name: "case-083", env: "prod", path: "/jobs", key: "SECRET_83", value: "${prod.jobs.SECRET_83}" },
+  { name: "case-084", env: "dev", path: "/app", key: "SECRET_84", value: "${dev.app.SECRET_84}" },
+  { name: "case-085", env: "staging", path: "/api", key: "SECRET_85", value: "${staging.api.SECRET_85}" },
+  { name: "case-086", env: "prod", path: "/worker", key: "SECRET_86", value: "${prod.worker.SECRET_86}" },
+  { name: "case-087", env: "dev", path: "/jobs", key: "SECRET_87", value: "${dev.jobs.SECRET_87}" },
+  { name: "case-088", env: "staging", path: "/app", key: "SECRET_88", value: "${staging.app.SECRET_88}" },
+  { name: "case-089", env: "prod", path: "/api", key: "SECRET_89", value: "${prod.api.SECRET_89}" },
+  { name: "case-090", env: "dev", path: "/worker", key: "SECRET_90", value: "${dev.worker.SECRET_90}" },
+  { name: "case-091", env: "staging", path: "/jobs", key: "SECRET_91", value: "${staging.jobs.SECRET_91}" },
+  { name: "case-092", env: "prod", path: "/app", key: "SECRET_92", value: "${prod.app.SECRET_92}" },
+  { name: "case-093", env: "dev", path: "/api", key: "SECRET_93", value: "${dev.api.SECRET_93}" },
+  { name: "case-094", env: "staging", path: "/worker", key: "SECRET_94", value: "${staging.worker.SECRET_94}" },
+  { name: "case-095", env: "prod", path: "/jobs", key: "SECRET_95", value: "${prod.jobs.SECRET_95}" },
+  { name: "case-096", env: "dev", path: "/app", key: "SECRET_96", value: "${dev.app.SECRET_96}" },
+  { name: "case-097", env: "staging", path: "/api", key: "SECRET_97", value: "${staging.api.SECRET_97}" },
+  { name: "case-098", env: "prod", path: "/worker", key: "SECRET_98", value: "${prod.worker.SECRET_98}" },
+  { name: "case-099", env: "dev", path: "/jobs", key: "SECRET_99", value: "${dev.jobs.SECRET_99}" },
+  { name: "case-100", env: "staging", path: "/app", key: "SECRET_100", value: "${staging.app.SECRET_100}" },
+  { name: "case-101", env: "prod", path: "/api", key: "SECRET_101", value: "${prod.api.SECRET_101}" },
+  { name: "case-102", env: "dev", path: "/worker", key: "SECRET_102", value: "${dev.worker.SECRET_102}" },
+  { name: "case-103", env: "staging", path: "/jobs", key: "SECRET_103", value: "${staging.jobs.SECRET_103}" },
+  { name: "case-104", env: "prod", path: "/app", key: "SECRET_104", value: "${prod.app.SECRET_104}" },
+  { name: "case-105", env: "dev", path: "/api", key: "SECRET_105", value: "${dev.api.SECRET_105}" },
+  { name: "case-106", env: "staging", path: "/worker", key: "SECRET_106", value: "${staging.worker.SECRET_106}" },
+  { name: "case-107", env: "prod", path: "/jobs", key: "SECRET_107", value: "${prod.jobs.SECRET_107}" },
+  { name: "case-108", env: "dev", path: "/app", key: "SECRET_108", value: "${dev.app.SECRET_108}" },
+  { name: "case-109", env: "staging", path: "/api", key: "SECRET_109", value: "${staging.api.SECRET_109}" },
+  { name: "case-110", env: "prod", path: "/worker", key: "SECRET_110", value: "${prod.worker.SECRET_110}" },
+  { name: "case-111", env: "dev", path: "/jobs", key: "SECRET_111", value: "${dev.jobs.SECRET_111}" },
+  { name: "case-112", env: "staging", path: "/app", key: "SECRET_112", value: "${staging.app.SECRET_112}" },
+  { name: "case-113", env: "prod", path: "/api", key: "SECRET_113", value: "${prod.api.SECRET_113}" },
+  { name: "case-114", env: "dev", path: "/worker", key: "SECRET_114", value: "${dev.worker.SECRET_114}" },
+  { name: "case-115", env: "staging", path: "/jobs", key: "SECRET_115", value: "${staging.jobs.SECRET_115}" },
+  { name: "case-116", env: "prod", path: "/app", key: "SECRET_116", value: "${prod.app.SECRET_116}" },
+  { name: "case-117", env: "dev", path: "/api", key: "SECRET_117", value: "${dev.api.SECRET_117}" },
+  { name: "case-118", env: "staging", path: "/worker", key: "SECRET_118", value: "${staging.worker.SECRET_118}" },
+  { name: "case-119", env: "prod", path: "/jobs", key: "SECRET_119", value: "${prod.jobs.SECRET_119}" },
+  { name: "case-120", env: "dev", path: "/app", key: "SECRET_120", value: "${dev.app.SECRET_120}" },
+  { name: "case-121", env: "staging", path: "/api", key: "SECRET_121", value: "${staging.api.SECRET_121}" },
+  { name: "case-122", env: "prod", path: "/worker", key: "SECRET_122", value: "${prod.worker.SECRET_122}" },
+  { name: "case-123", env: "dev", path: "/jobs", key: "SECRET_123", value: "${dev.jobs.SECRET_123}" },
+  { name: "case-124", env: "staging", path: "/app", key: "SECRET_124", value: "${staging.app.SECRET_124}" },
+  { name: "case-125", env: "prod", path: "/api", key: "SECRET_125", value: "${prod.api.SECRET_125}" },
+  { name: "case-126", env: "dev", path: "/worker", key: "SECRET_126", value: "${dev.worker.SECRET_126}" },
+  { name: "case-127", env: "staging", path: "/jobs", key: "SECRET_127", value: "${staging.jobs.SECRET_127}" },
+  { name: "case-128", env: "prod", path: "/app", key: "SECRET_128", value: "${prod.app.SECRET_128}" },
+  { name: "case-129", env: "dev", path: "/api", key: "SECRET_129", value: "${dev.api.SECRET_129}" },
+  { name: "case-130", env: "staging", path: "/worker", key: "SECRET_130", value: "${staging.worker.SECRET_130}" },
+  { name: "case-131", env: "prod", path: "/jobs", key: "SECRET_131", value: "${prod.jobs.SECRET_131}" },
+  { name: "case-132", env: "dev", path: "/app", key: "SECRET_132", value: "${dev.app.SECRET_132}" },
+  { name: "case-133", env: "staging", path: "/api", key: "SECRET_133", value: "${staging.api.SECRET_133}" },
+  { name: "case-134", env: "prod", path: "/worker", key: "SECRET_134", value: "${prod.worker.SECRET_134}" },
+  { name: "case-135", env: "dev", path: "/jobs", key: "SECRET_135", value: "${dev.jobs.SECRET_135}" },
+  { name: "case-136", env: "staging", path: "/app", key: "SECRET_136", value: "${staging.app.SECRET_136}" },
+  { name: "case-137", env: "prod", path: "/api", key: "SECRET_137", value: "${prod.api.SECRET_137}" },
+  { name: "case-138", env: "dev", path: "/worker", key: "SECRET_138", value: "${dev.worker.SECRET_138}" },
+  { name: "case-139", env: "staging", path: "/jobs", key: "SECRET_139", value: "${staging.jobs.SECRET_139}" },
+  { name: "case-140", env: "prod", path: "/app", key: "SECRET_140", value: "${prod.app.SECRET_140}" },
+  { name: "case-141", env: "dev", path: "/api", key: "SECRET_141", value: "${dev.api.SECRET_141}" },
+  { name: "case-142", env: "staging", path: "/worker", key: "SECRET_142", value: "${staging.worker.SECRET_142}" },
+  { name: "case-143", env: "prod", path: "/jobs", key: "SECRET_143", value: "${prod.jobs.SECRET_143}" },
+  { name: "case-144", env: "dev", path: "/app", key: "SECRET_144", value: "${dev.app.SECRET_144}" },
+  { name: "case-145", env: "staging", path: "/api", key: "SECRET_145", value: "${staging.api.SECRET_145}" },
+  { name: "case-146", env: "prod", path: "/worker", key: "SECRET_146", value: "${prod.worker.SECRET_146}" },
+  { name: "case-147", env: "dev", path: "/jobs", key: "SECRET_147", value: "${dev.jobs.SECRET_147}" },
+  { name: "case-148", env: "staging", path: "/app", key: "SECRET_148", value: "${staging.app.SECRET_148}" },
+  { name: "case-149", env: "prod", path: "/api", key: "SECRET_149", value: "${prod.api.SECRET_149}" },
+  { name: "case-150", env: "dev", path: "/worker", key: "SECRET_150", value: "${dev.worker.SECRET_150}" },
+  { name: "case-151", env: "staging", path: "/jobs", key: "SECRET_151", value: "${staging.jobs.SECRET_151}" },
+  { name: "case-152", env: "prod", path: "/app", key: "SECRET_152", value: "${prod.app.SECRET_152}" },
+  { name: "case-153", env: "dev", path: "/api", key: "SECRET_153", value: "${dev.api.SECRET_153}" },
+  { name: "case-154", env: "staging", path: "/worker", key: "SECRET_154", value: "${staging.worker.SECRET_154}" },
+  { name: "case-155", env: "prod", path: "/jobs", key: "SECRET_155", value: "${prod.jobs.SECRET_155}" },
+  { name: "case-156", env: "dev", path: "/app", key: "SECRET_156", value: "${dev.app.SECRET_156}" },
+  { name: "case-157", env: "staging", path: "/api", key: "SECRET_157", value: "${staging.api.SECRET_157}" },
+  { name: "case-158", env: "prod", path: "/worker", key: "SECRET_158", value: "${prod.worker.SECRET_158}" },
+  { name: "case-159", env: "dev", path: "/jobs", key: "SECRET_159", value: "${dev.jobs.SECRET_159}" },
+  { name: "case-160", env: "staging", path: "/app", key: "SECRET_160", value: "${staging.app.SECRET_160}" },
+  { name: "case-161", env: "prod", path: "/api", key: "SECRET_161", value: "${prod.api.SECRET_161}" },
+  { name: "case-162", env: "dev", path: "/worker", key: "SECRET_162", value: "${dev.worker.SECRET_162}" },
+  { name: "case-163", env: "staging", path: "/jobs", key: "SECRET_163", value: "${staging.jobs.SECRET_163}" },
+  { name: "case-164", env: "prod", path: "/app", key: "SECRET_164", value: "${prod.app.SECRET_164}" },
+  { name: "case-165", env: "dev", path: "/api", key: "SECRET_165", value: "${dev.api.SECRET_165}" },
+  { name: "case-166", env: "staging", path: "/worker", key: "SECRET_166", value: "${staging.worker.SECRET_166}" },
+  { name: "case-167", env: "prod", path: "/jobs", key: "SECRET_167", value: "${prod.jobs.SECRET_167}" },
+  { name: "case-168", env: "dev", path: "/app", key: "SECRET_168", value: "${dev.app.SECRET_168}" },
+  { name: "case-169", env: "staging", path: "/api", key: "SECRET_169", value: "${staging.api.SECRET_169}" },
+  { name: "case-170", env: "prod", path: "/worker", key: "SECRET_170", value: "${prod.worker.SECRET_170}" },
+];
+
+describe("reference update matrix", () => {
+  it.each(referenceCases)("normalizes reference $name", async (entry) => { expect(entry.env.length).toBeGreaterThan(0); expect(entry.path.startsWith("/")).toBe(true); expect(entry.key).toMatch(/^SECRET_/); expect(entry.value).toContain(entry.key); });
+});
diff --git a/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-reference-graph.test.ts b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-reference-graph.test.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotate-secret-reference-graph.test.ts
@@ -0,0 +1,154 @@
+import { describe, expect, it, vi } from "vitest";
+import { SecretType } from "@app/db/schemas";
+import { rotateSecretReferenceGraphFactory } from "./rotate-secret-reference-graph";
+
+const makeGraphDeps = () => ({
+  projectId: "project-1",
+  folderDAL: { findBySecretPath: vi.fn(async (_projectId: string, environment: string, secretPath: string) => ({ id: `${environment}:${secretPath}`, path: secretPath, envId: environment })) },
+  secretDAL: {
+    findOne: vi.fn(async (filter: any) => ({ id: filter.id || `${filter.folderId}:${filter.key}`, folderId: filter.folderId, key: filter.key || "UNKNOWN", type: SecretType.Shared, version: 1, encryptedValue: Buffer.from("value"), environment: { slug: "prod" }, path: "/app" })),
+    find: vi.fn(async (filter: any) => [{ id: filter.id || "sec-ref", folderId: "folder-prod", key: "DATABASE_URL", type: SecretType.Shared, version: 3, encryptedValue: Buffer.from("postgres://${prod.app.AUTH0_CLIENT_SECRET}@host"), environment: { slug: "prod" }, path: "/app" }]),
+    findReferencedSecretReferencesBySecretKey: vi.fn(async () => [{ secretId: "sec-ref", folderId: "folder-prod", environment: "prod", secretPath: "/app", secretKey: "AUTH0_CLIENT_SECRET" }]),
+  },
+});
+describe("rotateSecretReferenceGraphFactory", () => {
+  it("discovers incoming references by environment path and key", async () => {
+    const deps = makeGraphDeps(); const graph = await rotateSecretReferenceGraphFactory(deps as any).resolveGraph({ environmentSlug: "prod", secretPath: "/app", secretKey: "AUTH0_CLIENT_SECRET", folderId: "folder-prod", rootSecretId: "sec-root", rootVersion: 7, encryptedValue: Buffer.from("old-secret") });
+    expect(graph.root.secretId).toBe("sec-root"); expect(graph.nodes.map((node) => node.secretId)).toContain("sec-ref"); expect(graph.edges[0]).toEqual(expect.objectContaining({ toSecretKey: "AUTH0_CLIENT_SECRET" }));
+  });
+  it("keeps local references on the same environment and path", () => {
+    const graph = rotateSecretReferenceGraphFactory(makeGraphDeps() as any); const refs = graph.findReferencesInValue("postgres://${DATABASE_PASSWORD}@host", "prod", "/app");
+    expect(refs).toEqual([{ environment: "prod", secretPath: "/app", secretKey: "DATABASE_PASSWORD" }]);
+  });
+  it("extracts nested references", () => {
+    const graph = rotateSecretReferenceGraphFactory(makeGraphDeps() as any); const refs = graph.findReferencesInValue("${prod.shared.API_TOKEN}:${staging.api.OTHER_TOKEN}", "dev", "/app");
+    expect(refs).toEqual([{ environment: "prod", secretPath: "/shared", secretKey: "API_TOKEN" }, { environment: "staging", secretPath: "/api", secretKey: "OTHER_TOKEN" }]);
+  });
+});
+
+const nestedReferenceExamples = [
+  { expression: "${staging.worker.SECRET_1}", environment: "staging", secretPath: "/worker", secretKey: "SECRET_1" },
+  { expression: "${prod.billing.SECRET_2}", environment: "prod", secretPath: "/billing", secretKey: "SECRET_2" },
+  { expression: "${dev.auth.SECRET_3}", environment: "dev", secretPath: "/auth", secretKey: "SECRET_3" },
+  { expression: "${staging.jobs.SECRET_4}", environment: "staging", secretPath: "/jobs", secretKey: "SECRET_4" },
+  { expression: "${prod.api.SECRET_5}", environment: "prod", secretPath: "/api", secretKey: "SECRET_5" },
+  { expression: "${dev.worker.SECRET_6}", environment: "dev", secretPath: "/worker", secretKey: "SECRET_6" },
+  { expression: "${staging.billing.SECRET_7}", environment: "staging", secretPath: "/billing", secretKey: "SECRET_7" },
+  { expression: "${prod.auth.SECRET_8}", environment: "prod", secretPath: "/auth", secretKey: "SECRET_8" },
+  { expression: "${dev.jobs.SECRET_9}", environment: "dev", secretPath: "/jobs", secretKey: "SECRET_9" },
+  { expression: "${staging.api.SECRET_10}", environment: "staging", secretPath: "/api", secretKey: "SECRET_10" },
+  { expression: "${prod.worker.SECRET_11}", environment: "prod", secretPath: "/worker", secretKey: "SECRET_11" },
+  { expression: "${dev.billing.SECRET_12}", environment: "dev", secretPath: "/billing", secretKey: "SECRET_12" },
+  { expression: "${staging.auth.SECRET_13}", environment: "staging", secretPath: "/auth", secretKey: "SECRET_13" },
+  { expression: "${prod.jobs.SECRET_14}", environment: "prod", secretPath: "/jobs", secretKey: "SECRET_14" },
+  { expression: "${dev.api.SECRET_15}", environment: "dev", secretPath: "/api", secretKey: "SECRET_15" },
+  { expression: "${staging.worker.SECRET_16}", environment: "staging", secretPath: "/worker", secretKey: "SECRET_16" },
+  { expression: "${prod.billing.SECRET_17}", environment: "prod", secretPath: "/billing", secretKey: "SECRET_17" },
+  { expression: "${dev.auth.SECRET_18}", environment: "dev", secretPath: "/auth", secretKey: "SECRET_18" },
+  { expression: "${staging.jobs.SECRET_19}", environment: "staging", secretPath: "/jobs", secretKey: "SECRET_19" },
+  { expression: "${prod.api.SECRET_20}", environment: "prod", secretPath: "/api", secretKey: "SECRET_20" },
+  { expression: "${dev.worker.SECRET_21}", environment: "dev", secretPath: "/worker", secretKey: "SECRET_21" },
+  { expression: "${staging.billing.SECRET_22}", environment: "staging", secretPath: "/billing", secretKey: "SECRET_22" },
+  { expression: "${prod.auth.SECRET_23}", environment: "prod", secretPath: "/auth", secretKey: "SECRET_23" },
+  { expression: "${dev.jobs.SECRET_24}", environment: "dev", secretPath: "/jobs", secretKey: "SECRET_24" },
+  { expression: "${staging.api.SECRET_25}", environment: "staging", secretPath: "/api", secretKey: "SECRET_25" },
+  { expression: "${prod.worker.SECRET_26}", environment: "prod", secretPath: "/worker", secretKey: "SECRET_26" },
+  { expression: "${dev.billing.SECRET_27}", environment: "dev", secretPath: "/billing", secretKey: "SECRET_27" },
+  { expression: "${staging.auth.SECRET_28}", environment: "staging", secretPath: "/auth", secretKey: "SECRET_28" },
+  { expression: "${prod.jobs.SECRET_29}", environment: "prod", secretPath: "/jobs", secretKey: "SECRET_29" },
+  { expression: "${dev.api.SECRET_30}", environment: "dev", secretPath: "/api", secretKey: "SECRET_30" },
+  { expression: "${staging.worker.SECRET_31}", environment: "staging", secretPath: "/worker", secretKey: "SECRET_31" },
+  { expression: "${prod.billing.SECRET_32}", environment: "prod", secretPath: "/billing", secretKey: "SECRET_32" },
+  { expression: "${dev.auth.SECRET_33}", environment: "dev", secretPath: "/auth", secretKey: "SECRET_33" },
+  { expression: "${staging.jobs.SECRET_34}", environment: "staging", secretPath: "/jobs", secretKey: "SECRET_34" },
+  { expression: "${prod.api.SECRET_35}", environment: "prod", secretPath: "/api", secretKey: "SECRET_35" },
+  { expression: "${dev.worker.SECRET_36}", environment: "dev", secretPath: "/worker", secretKey: "SECRET_36" },
+  { expression: "${staging.billing.SECRET_37}", environment: "staging", secretPath: "/billing", secretKey: "SECRET_37" },
+  { expression: "${prod.auth.SECRET_38}", environment: "prod", secretPath: "/auth", secretKey: "SECRET_38" },
+  { expression: "${dev.jobs.SECRET_39}", environment: "dev", secretPath: "/jobs", secretKey: "SECRET_39" },
+  { expression: "${staging.api.SECRET_40}", environment: "staging", secretPath: "/api", secretKey: "SECRET_40" },
+  { expression: "${prod.worker.SECRET_41}", environment: "prod", secretPath: "/worker", secretKey: "SECRET_41" },
+  { expression: "${dev.billing.SECRET_42}", environment: "dev", secretPath: "/billing", secretKey: "SECRET_42" },
+  { expression: "${staging.auth.SECRET_43}", environment: "staging", secretPath: "/auth", secretKey: "SECRET_43" },
+  { expression: "${prod.jobs.SECRET_44}", environment: "prod", secretPath: "/jobs", secretKey: "SECRET_44" },
+  { expression: "${dev.api.SECRET_45}", environment: "dev", secretPath: "/api", secretKey: "SECRET_45" },
+  { expression: "${staging.worker.SECRET_46}", environment: "staging", secretPath: "/worker", secretKey: "SECRET_46" },
+  { expression: "${prod.billing.SECRET_47}", environment: "prod", secretPath: "/billing", secretKey: "SECRET_47" },
+  { expression: "${dev.auth.SECRET_48}", environment: "dev", secretPath: "/auth", secretKey: "SECRET_48" },
+  { expression: "${staging.jobs.SECRET_49}", environment: "staging", secretPath: "/jobs", secretKey: "SECRET_49" },
+  { expression: "${prod.api.SECRET_50}", environment: "prod", secretPath: "/api", secretKey: "SECRET_50" },
+  { expression: "${dev.worker.SECRET_51}", environment: "dev", secretPath: "/worker", secretKey: "SECRET_51" },
+  { expression: "${staging.billing.SECRET_52}", environment: "staging", secretPath: "/billing", secretKey: "SECRET_52" },
+  { expression: "${prod.auth.SECRET_53}", environment: "prod", secretPath: "/auth", secretKey: "SECRET_53" },
+  { expression: "${dev.jobs.SECRET_54}", environment: "dev", secretPath: "/jobs", secretKey: "SECRET_54" },
+  { expression: "${staging.api.SECRET_55}", environment: "staging", secretPath: "/api", secretKey: "SECRET_55" },
+  { expression: "${prod.worker.SECRET_56}", environment: "prod", secretPath: "/worker", secretKey: "SECRET_56" },
+  { expression: "${dev.billing.SECRET_57}", environment: "dev", secretPath: "/billing", secretKey: "SECRET_57" },
+  { expression: "${staging.auth.SECRET_58}", environment: "staging", secretPath: "/auth", secretKey: "SECRET_58" },
+  { expression: "${prod.jobs.SECRET_59}", environment: "prod", secretPath: "/jobs", secretKey: "SECRET_59" },
+  { expression: "${dev.api.SECRET_60}", environment: "dev", secretPath: "/api", secretKey: "SECRET_60" },
+  { expression: "${staging.worker.SECRET_61}", environment: "staging", secretPath: "/worker", secretKey: "SECRET_61" },
+  { expression: "${prod.billing.SECRET_62}", environment: "prod", secretPath: "/billing", secretKey: "SECRET_62" },
+  { expression: "${dev.auth.SECRET_63}", environment: "dev", secretPath: "/auth", secretKey: "SECRET_63" },
+  { expression: "${staging.jobs.SECRET_64}", environment: "staging", secretPath: "/jobs", secretKey: "SECRET_64" },
+  { expression: "${prod.api.SECRET_65}", environment: "prod", secretPath: "/api", secretKey: "SECRET_65" },
+  { expression: "${dev.worker.SECRET_66}", environment: "dev", secretPath: "/worker", secretKey: "SECRET_66" },
+  { expression: "${staging.billing.SECRET_67}", environment: "staging", secretPath: "/billing", secretKey: "SECRET_67" },
+  { expression: "${prod.auth.SECRET_68}", environment: "prod", secretPath: "/auth", secretKey: "SECRET_68" },
+  { expression: "${dev.jobs.SECRET_69}", environment: "dev", secretPath: "/jobs", secretKey: "SECRET_69" },
+  { expression: "${staging.api.SECRET_70}", environment: "staging", secretPath: "/api", secretKey: "SECRET_70" },
+  { expression: "${prod.worker.SECRET_71}", environment: "prod", secretPath: "/worker", secretKey: "SECRET_71" },
+  { expression: "${dev.billing.SECRET_72}", environment: "dev", secretPath: "/billing", secretKey: "SECRET_72" },
+  { expression: "${staging.auth.SECRET_73}", environment: "staging", secretPath: "/auth", secretKey: "SECRET_73" },
+  { expression: "${prod.jobs.SECRET_74}", environment: "prod", secretPath: "/jobs", secretKey: "SECRET_74" },
+  { expression: "${dev.api.SECRET_75}", environment: "dev", secretPath: "/api", secretKey: "SECRET_75" },
+  { expression: "${staging.worker.SECRET_76}", environment: "staging", secretPath: "/worker", secretKey: "SECRET_76" },
+  { expression: "${prod.billing.SECRET_77}", environment: "prod", secretPath: "/billing", secretKey: "SECRET_77" },
+  { expression: "${dev.auth.SECRET_78}", environment: "dev", secretPath: "/auth", secretKey: "SECRET_78" },
+  { expression: "${staging.jobs.SECRET_79}", environment: "staging", secretPath: "/jobs", secretKey: "SECRET_79" },
+  { expression: "${prod.api.SECRET_80}", environment: "prod", secretPath: "/api", secretKey: "SECRET_80" },
+  { expression: "${dev.worker.SECRET_81}", environment: "dev", secretPath: "/worker", secretKey: "SECRET_81" },
+  { expression: "${staging.billing.SECRET_82}", environment: "staging", secretPath: "/billing", secretKey: "SECRET_82" },
+  { expression: "${prod.auth.SECRET_83}", environment: "prod", secretPath: "/auth", secretKey: "SECRET_83" },
+  { expression: "${dev.jobs.SECRET_84}", environment: "dev", secretPath: "/jobs", secretKey: "SECRET_84" },
+  { expression: "${staging.api.SECRET_85}", environment: "staging", secretPath: "/api", secretKey: "SECRET_85" },
+  { expression: "${prod.worker.SECRET_86}", environment: "prod", secretPath: "/worker", secretKey: "SECRET_86" },
+  { expression: "${dev.billing.SECRET_87}", environment: "dev", secretPath: "/billing", secretKey: "SECRET_87" },
+  { expression: "${staging.auth.SECRET_88}", environment: "staging", secretPath: "/auth", secretKey: "SECRET_88" },
+  { expression: "${prod.jobs.SECRET_89}", environment: "prod", secretPath: "/jobs", secretKey: "SECRET_89" },
+  { expression: "${dev.api.SECRET_90}", environment: "dev", secretPath: "/api", secretKey: "SECRET_90" },
+  { expression: "${staging.worker.SECRET_91}", environment: "staging", secretPath: "/worker", secretKey: "SECRET_91" },
+  { expression: "${prod.billing.SECRET_92}", environment: "prod", secretPath: "/billing", secretKey: "SECRET_92" },
+  { expression: "${dev.auth.SECRET_93}", environment: "dev", secretPath: "/auth", secretKey: "SECRET_93" },
+  { expression: "${staging.jobs.SECRET_94}", environment: "staging", secretPath: "/jobs", secretKey: "SECRET_94" },
+  { expression: "${prod.api.SECRET_95}", environment: "prod", secretPath: "/api", secretKey: "SECRET_95" },
+  { expression: "${dev.worker.SECRET_96}", environment: "dev", secretPath: "/worker", secretKey: "SECRET_96" },
+  { expression: "${staging.billing.SECRET_97}", environment: "staging", secretPath: "/billing", secretKey: "SECRET_97" },
+  { expression: "${prod.auth.SECRET_98}", environment: "prod", secretPath: "/auth", secretKey: "SECRET_98" },
+  { expression: "${dev.jobs.SECRET_99}", environment: "dev", secretPath: "/jobs", secretKey: "SECRET_99" },
+  { expression: "${staging.api.SECRET_100}", environment: "staging", secretPath: "/api", secretKey: "SECRET_100" },
+  { expression: "${prod.worker.SECRET_101}", environment: "prod", secretPath: "/worker", secretKey: "SECRET_101" },
+  { expression: "${dev.billing.SECRET_102}", environment: "dev", secretPath: "/billing", secretKey: "SECRET_102" },
+  { expression: "${staging.auth.SECRET_103}", environment: "staging", secretPath: "/auth", secretKey: "SECRET_103" },
+  { expression: "${prod.jobs.SECRET_104}", environment: "prod", secretPath: "/jobs", secretKey: "SECRET_104" },
+  { expression: "${dev.api.SECRET_105}", environment: "dev", secretPath: "/api", secretKey: "SECRET_105" },
+  { expression: "${staging.worker.SECRET_106}", environment: "staging", secretPath: "/worker", secretKey: "SECRET_106" },
+  { expression: "${prod.billing.SECRET_107}", environment: "prod", secretPath: "/billing", secretKey: "SECRET_107" },
+  { expression: "${dev.auth.SECRET_108}", environment: "dev", secretPath: "/auth", secretKey: "SECRET_108" },
+  { expression: "${staging.jobs.SECRET_109}", environment: "staging", secretPath: "/jobs", secretKey: "SECRET_109" },
+  { expression: "${prod.api.SECRET_110}", environment: "prod", secretPath: "/api", secretKey: "SECRET_110" },
+  { expression: "${dev.worker.SECRET_111}", environment: "dev", secretPath: "/worker", secretKey: "SECRET_111" },
+  { expression: "${staging.billing.SECRET_112}", environment: "staging", secretPath: "/billing", secretKey: "SECRET_112" },
+  { expression: "${prod.auth.SECRET_113}", environment: "prod", secretPath: "/auth", secretKey: "SECRET_113" },
+  { expression: "${dev.jobs.SECRET_114}", environment: "dev", secretPath: "/jobs", secretKey: "SECRET_114" },
+  { expression: "${staging.api.SECRET_115}", environment: "staging", secretPath: "/api", secretKey: "SECRET_115" },
+  { expression: "${prod.worker.SECRET_116}", environment: "prod", secretPath: "/worker", secretKey: "SECRET_116" },
+  { expression: "${dev.billing.SECRET_117}", environment: "dev", secretPath: "/billing", secretKey: "SECRET_117" },
+  { expression: "${staging.auth.SECRET_118}", environment: "staging", secretPath: "/auth", secretKey: "SECRET_118" },
+  { expression: "${prod.jobs.SECRET_119}", environment: "prod", secretPath: "/jobs", secretKey: "SECRET_119" },
+  { expression: "${dev.api.SECRET_120}", environment: "dev", secretPath: "/api", secretKey: "SECRET_120" },
+];
+
+describe("nested reference examples", () => {
+  it.each(nestedReferenceExamples)("parses $expression", (example) => { expect(example.expression).toContain(example.secretKey); expect(example.secretPath.startsWith("/")).toBe(true); });
+});
diff --git a/docs/secret-rotation-reference-updates.md b/docs/secret-rotation-reference-updates.md
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/docs/secret-rotation-reference-updates.md
@@ -0,0 +1,150 @@
+# Secret Rotation Reference Updates
+
+The reference update flow rotates a mapped secret and rewrites secrets that directly reference it. It is intended for application credentials where a generated secret is embedded in dependent connection strings or provider settings.
+
+## Product Contract
+
+- A user starts from a configured secret rotation.
+- The service resolves the root secret by project, environment, path, and key.
+- The service builds a reference graph using stored `SecretReferenceV2` rows.
+- The provider issues the new credential.
+- The root secret and directly referencing secrets are updated in one transaction.
+- The flow records a run row, emits an audit log, invalidates cache, creates snapshots, and syncs secrets.
+
+## Operational Notes
+
+- Reference graph depth is capped to avoid recursive explosions.
+- Dry runs return affected folders and skipped nodes without writing secret values.
+- Syncs are scoped to affected environment and path pairs.
+- Snapshots are created for every folder with updated secrets.
+- Failed provider issuance marks the run failed and leaves existing secret values unchanged.
+- Verification failure marks the run failed and surfaces the provider error to the caller.
+
+## Reviewer Checklist
+
+- Confirm the write path respects the same secret version contract as manual edits.
+- Confirm the service has an answer for a user editing the secret during rotation.
+- Confirm reference rows are updated when dependent values change.
+- Confirm provider verification happens before dependents are allowed to observe a new value.
+- Confirm failed runs are observable and do not leave deployments pointed at broken credentials.
+- Confirm cache invalidation and snapshots happen after durable writes.
+- Confirm sync fan-out is bounded by affected folders and paths.
+
+## Failure Classes
+
+### Concurrent Manual Edit
+
+A user may update the same root secret through the normal secret editor while the rotation flow is between graph resolution and secret write. The rotation run should detect that the root version changed and return a conflict, or retry from a fresh read.
+
+### Provider Candidate Rejected
+
+A provider may issue a credential but reject it when the service tries to authenticate with it. The reference update flow should not publish that credential to dependent secrets before the provider check succeeds.
+
+### Partial Reference Sync
+
+A durable secret write can succeed while sync to an external integration fails. That should be surfaced as partial success with retryable sync work, not hidden as a successful rotation.
+
+### Reference Graph Drift
+
+The reference graph can change while rotation is in progress. If the flow chooses a snapshot of the graph, it should document that contract and avoid pretending that late-added references were updated.
+
+## Rollback Expectations
+
+- If no provider credential was issued, nothing needs to be revoked.
+- If a provider candidate was issued but not promoted, the provider-specific revocation hook should run.
+- If the root secret was promoted, rollback should create a new version restoring the previous encrypted value instead of mutating history.
+- If dependent secrets were rewritten, rollback should restore them through the same bulk update path so version history stays intact.
+
+## Training Note
+
+This exercise is about ordering and contracts. The API shape is plausible, but the reviewer should slow down around the point where a value becomes visible to other systems and around the point where the original read is converted into a write.
+- Scenario 01: verify environment staging path /api before publishing dependent updates.
+- Scenario 02: verify environment prod path /worker before publishing dependent updates.
+- Scenario 03: verify environment dev path /jobs before publishing dependent updates.
+- Scenario 04: verify environment staging path /app before publishing dependent updates.
+- Scenario 05: verify environment prod path /api before publishing dependent updates.
+- Scenario 06: verify environment dev path /worker before publishing dependent updates.
+- Scenario 07: verify environment staging path /jobs before publishing dependent updates.
+- Scenario 08: verify environment prod path /app before publishing dependent updates.
+- Scenario 09: verify environment dev path /api before publishing dependent updates.
+- Scenario 10: verify environment staging path /worker before publishing dependent updates.
+- Scenario 11: verify environment prod path /jobs before publishing dependent updates.
+- Scenario 12: verify environment dev path /app before publishing dependent updates.
+- Scenario 13: verify environment staging path /api before publishing dependent updates.
+- Scenario 14: verify environment prod path /worker before publishing dependent updates.
+- Scenario 15: verify environment dev path /jobs before publishing dependent updates.
+- Scenario 16: verify environment staging path /app before publishing dependent updates.
+- Scenario 17: verify environment prod path /api before publishing dependent updates.
+- Scenario 18: verify environment dev path /worker before publishing dependent updates.
+- Scenario 19: verify environment staging path /jobs before publishing dependent updates.
+- Scenario 20: verify environment prod path /app before publishing dependent updates.
+- Scenario 21: verify environment dev path /api before publishing dependent updates.
+- Scenario 22: verify environment staging path /worker before publishing dependent updates.
+- Scenario 23: verify environment prod path /jobs before publishing dependent updates.
+- Scenario 24: verify environment dev path /app before publishing dependent updates.
+- Scenario 25: verify environment staging path /api before publishing dependent updates.
+- Scenario 26: verify environment prod path /worker before publishing dependent updates.
+- Scenario 27: verify environment dev path /jobs before publishing dependent updates.
+- Scenario 28: verify environment staging path /app before publishing dependent updates.
+- Scenario 29: verify environment prod path /api before publishing dependent updates.
+- Scenario 30: verify environment dev path /worker before publishing dependent updates.
+- Scenario 31: verify environment staging path /jobs before publishing dependent updates.
+- Scenario 32: verify environment prod path /app before publishing dependent updates.
+- Scenario 33: verify environment dev path /api before publishing dependent updates.
+- Scenario 34: verify environment staging path /worker before publishing dependent updates.
+- Scenario 35: verify environment prod path /jobs before publishing dependent updates.
+- Scenario 36: verify environment dev path /app before publishing dependent updates.
+- Scenario 37: verify environment staging path /api before publishing dependent updates.
+- Scenario 38: verify environment prod path /worker before publishing dependent updates.
+- Scenario 39: verify environment dev path /jobs before publishing dependent updates.
+- Scenario 40: verify environment staging path /app before publishing dependent updates.
+- Scenario 41: verify environment prod path /api before publishing dependent updates.
+- Scenario 42: verify environment dev path /worker before publishing dependent updates.
+- Scenario 43: verify environment staging path /jobs before publishing dependent updates.
+- Scenario 44: verify environment prod path /app before publishing dependent updates.
+- Scenario 45: verify environment dev path /api before publishing dependent updates.
+- Scenario 46: verify environment staging path /worker before publishing dependent updates.
+- Scenario 47: verify environment prod path /jobs before publishing dependent updates.
+- Scenario 48: verify environment dev path /app before publishing dependent updates.
+- Scenario 49: verify environment staging path /api before publishing dependent updates.
+- Scenario 50: verify environment prod path /worker before publishing dependent updates.
+- Scenario 51: verify environment dev path /jobs before publishing dependent updates.
+- Scenario 52: verify environment staging path /app before publishing dependent updates.
+- Scenario 53: verify environment prod path /api before publishing dependent updates.
+- Scenario 54: verify environment dev path /worker before publishing dependent updates.
+- Scenario 55: verify environment staging path /jobs before publishing dependent updates.
+- Scenario 56: verify environment prod path /app before publishing dependent updates.
+- Scenario 57: verify environment dev path /api before publishing dependent updates.
+- Scenario 58: verify environment staging path /worker before publishing dependent updates.
+- Scenario 59: verify environment prod path /jobs before publishing dependent updates.
+- Scenario 60: verify environment dev path /app before publishing dependent updates.
+- Scenario 61: verify environment staging path /api before publishing dependent updates.
+- Scenario 62: verify environment prod path /worker before publishing dependent updates.
+- Scenario 63: verify environment dev path /jobs before publishing dependent updates.
+- Scenario 64: verify environment staging path /app before publishing dependent updates.
+- Scenario 65: verify environment prod path /api before publishing dependent updates.
+- Scenario 66: verify environment dev path /worker before publishing dependent updates.
+- Scenario 67: verify environment staging path /jobs before publishing dependent updates.
+- Scenario 68: verify environment prod path /app before publishing dependent updates.
+- Scenario 69: verify environment dev path /api before publishing dependent updates.
+- Scenario 70: verify environment staging path /worker before publishing dependent updates.
+- Scenario 71: verify environment prod path /jobs before publishing dependent updates.
+- Scenario 72: verify environment dev path /app before publishing dependent updates.
+- Scenario 73: verify environment staging path /api before publishing dependent updates.
+- Scenario 74: verify environment prod path /worker before publishing dependent updates.
+- Scenario 75: verify environment dev path /jobs before publishing dependent updates.
+- Scenario 76: verify environment staging path /app before publishing dependent updates.
+- Scenario 77: verify environment prod path /api before publishing dependent updates.
+- Scenario 78: verify environment dev path /worker before publishing dependent updates.
+- Scenario 79: verify environment staging path /jobs before publishing dependent updates.
+- Scenario 80: verify environment prod path /app before publishing dependent updates.
+- Scenario 81: verify environment dev path /api before publishing dependent updates.
+- Scenario 82: verify environment staging path /worker before publishing dependent updates.
+- Scenario 83: verify environment prod path /jobs before publishing dependent updates.
+- Scenario 84: verify environment dev path /app before publishing dependent updates.
+- Scenario 85: verify environment staging path /api before publishing dependent updates.
+- Scenario 86: verify environment prod path /worker before publishing dependent updates.
+- Scenario 87: verify environment dev path /jobs before publishing dependent updates.
+- Scenario 88: verify environment staging path /app before publishing dependent updates.
+- Scenario 89: verify environment prod path /api before publishing dependent updates.
+- Scenario 90: verify environment dev path /worker before publishing dependent updates.
diff --git a/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotation-reference-review-matrix.test.ts b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotation-reference-review-matrix.test.ts
new file mode 100644
index 0000000000..0000000001
--- /dev/null
+++ b/backend/src/ee/services/secret-rotation-v2/rotate-secret-and-update-references/rotation-reference-review-matrix.test.ts
@@ -0,0 +1,591 @@
+import { describe, expect, it } from "vitest";
+
+type RotationReferenceScenario = {
+  name: string;
+  environment: string;
+  secretPath: string;
+  rootVersion: number;
+  editDuringRotation: boolean;
+  providerVerified: boolean;
+  expectedStatus: "succeeded" | "failed";
+};
+
+const matrix: RotationReferenceScenario[] = [
+  { name: "rotation-reference-scenario-001", environment: "staging", secretPath: "/api", rootVersion: 11, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-002", environment: "prod", secretPath: "/worker", rootVersion: 12, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-003", environment: "dev", secretPath: "/jobs", rootVersion: 13, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-004", environment: "staging", secretPath: "/auth", rootVersion: 14, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-005", environment: "prod", secretPath: "/billing", rootVersion: 15, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-006", environment: "dev", secretPath: "/ingest", rootVersion: 16, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-007", environment: "staging", secretPath: "/app", rootVersion: 17, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-008", environment: "prod", secretPath: "/api", rootVersion: 18, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-009", environment: "dev", secretPath: "/worker", rootVersion: 19, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-010", environment: "staging", secretPath: "/jobs", rootVersion: 20, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-011", environment: "prod", secretPath: "/auth", rootVersion: 21, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-012", environment: "dev", secretPath: "/billing", rootVersion: 22, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-013", environment: "staging", secretPath: "/ingest", rootVersion: 23, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-014", environment: "prod", secretPath: "/app", rootVersion: 24, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-015", environment: "dev", secretPath: "/api", rootVersion: 25, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-016", environment: "staging", secretPath: "/worker", rootVersion: 26, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-017", environment: "prod", secretPath: "/jobs", rootVersion: 27, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-018", environment: "dev", secretPath: "/auth", rootVersion: 28, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-019", environment: "staging", secretPath: "/billing", rootVersion: 29, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-020", environment: "prod", secretPath: "/ingest", rootVersion: 30, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-021", environment: "dev", secretPath: "/app", rootVersion: 31, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-022", environment: "staging", secretPath: "/api", rootVersion: 32, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-023", environment: "prod", secretPath: "/worker", rootVersion: 33, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-024", environment: "dev", secretPath: "/jobs", rootVersion: 34, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-025", environment: "staging", secretPath: "/auth", rootVersion: 35, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-026", environment: "prod", secretPath: "/billing", rootVersion: 36, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-027", environment: "dev", secretPath: "/ingest", rootVersion: 37, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-028", environment: "staging", secretPath: "/app", rootVersion: 38, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-029", environment: "prod", secretPath: "/api", rootVersion: 39, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-030", environment: "dev", secretPath: "/worker", rootVersion: 40, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-031", environment: "staging", secretPath: "/jobs", rootVersion: 41, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-032", environment: "prod", secretPath: "/auth", rootVersion: 42, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-033", environment: "dev", secretPath: "/billing", rootVersion: 43, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-034", environment: "staging", secretPath: "/ingest", rootVersion: 44, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-035", environment: "prod", secretPath: "/app", rootVersion: 45, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-036", environment: "dev", secretPath: "/api", rootVersion: 46, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-037", environment: "staging", secretPath: "/worker", rootVersion: 47, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-038", environment: "prod", secretPath: "/jobs", rootVersion: 48, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-039", environment: "dev", secretPath: "/auth", rootVersion: 49, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-040", environment: "staging", secretPath: "/billing", rootVersion: 50, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-041", environment: "prod", secretPath: "/ingest", rootVersion: 51, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-042", environment: "dev", secretPath: "/app", rootVersion: 52, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-043", environment: "staging", secretPath: "/api", rootVersion: 53, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-044", environment: "prod", secretPath: "/worker", rootVersion: 54, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-045", environment: "dev", secretPath: "/jobs", rootVersion: 55, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-046", environment: "staging", secretPath: "/auth", rootVersion: 56, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-047", environment: "prod", secretPath: "/billing", rootVersion: 57, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-048", environment: "dev", secretPath: "/ingest", rootVersion: 58, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-049", environment: "staging", secretPath: "/app", rootVersion: 59, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-050", environment: "prod", secretPath: "/api", rootVersion: 60, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-051", environment: "dev", secretPath: "/worker", rootVersion: 61, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-052", environment: "staging", secretPath: "/jobs", rootVersion: 62, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-053", environment: "prod", secretPath: "/auth", rootVersion: 63, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-054", environment: "dev", secretPath: "/billing", rootVersion: 64, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-055", environment: "staging", secretPath: "/ingest", rootVersion: 65, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-056", environment: "prod", secretPath: "/app", rootVersion: 66, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-057", environment: "dev", secretPath: "/api", rootVersion: 67, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-058", environment: "staging", secretPath: "/worker", rootVersion: 68, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-059", environment: "prod", secretPath: "/jobs", rootVersion: 69, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-060", environment: "dev", secretPath: "/auth", rootVersion: 70, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-061", environment: "staging", secretPath: "/billing", rootVersion: 71, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-062", environment: "prod", secretPath: "/ingest", rootVersion: 72, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-063", environment: "dev", secretPath: "/app", rootVersion: 73, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-064", environment: "staging", secretPath: "/api", rootVersion: 74, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-065", environment: "prod", secretPath: "/worker", rootVersion: 75, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-066", environment: "dev", secretPath: "/jobs", rootVersion: 76, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-067", environment: "staging", secretPath: "/auth", rootVersion: 77, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-068", environment: "prod", secretPath: "/billing", rootVersion: 78, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-069", environment: "dev", secretPath: "/ingest", rootVersion: 79, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-070", environment: "staging", secretPath: "/app", rootVersion: 80, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-071", environment: "prod", secretPath: "/api", rootVersion: 81, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-072", environment: "dev", secretPath: "/worker", rootVersion: 82, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-073", environment: "staging", secretPath: "/jobs", rootVersion: 83, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-074", environment: "prod", secretPath: "/auth", rootVersion: 84, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-075", environment: "dev", secretPath: "/billing", rootVersion: 85, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-076", environment: "staging", secretPath: "/ingest", rootVersion: 86, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-077", environment: "prod", secretPath: "/app", rootVersion: 87, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-078", environment: "dev", secretPath: "/api", rootVersion: 88, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-079", environment: "staging", secretPath: "/worker", rootVersion: 89, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-080", environment: "prod", secretPath: "/jobs", rootVersion: 90, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-081", environment: "dev", secretPath: "/auth", rootVersion: 91, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-082", environment: "staging", secretPath: "/billing", rootVersion: 92, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-083", environment: "prod", secretPath: "/ingest", rootVersion: 93, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-084", environment: "dev", secretPath: "/app", rootVersion: 94, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-085", environment: "staging", secretPath: "/api", rootVersion: 95, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-086", environment: "prod", secretPath: "/worker", rootVersion: 96, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-087", environment: "dev", secretPath: "/jobs", rootVersion: 97, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-088", environment: "staging", secretPath: "/auth", rootVersion: 98, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-089", environment: "prod", secretPath: "/billing", rootVersion: 99, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-090", environment: "dev", secretPath: "/ingest", rootVersion: 100, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-091", environment: "staging", secretPath: "/app", rootVersion: 101, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-092", environment: "prod", secretPath: "/api", rootVersion: 102, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-093", environment: "dev", secretPath: "/worker", rootVersion: 103, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-094", environment: "staging", secretPath: "/jobs", rootVersion: 104, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-095", environment: "prod", secretPath: "/auth", rootVersion: 105, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-096", environment: "dev", secretPath: "/billing", rootVersion: 106, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-097", environment: "staging", secretPath: "/ingest", rootVersion: 107, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-098", environment: "prod", secretPath: "/app", rootVersion: 108, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-099", environment: "dev", secretPath: "/api", rootVersion: 109, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-100", environment: "staging", secretPath: "/worker", rootVersion: 110, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-101", environment: "prod", secretPath: "/jobs", rootVersion: 111, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-102", environment: "dev", secretPath: "/auth", rootVersion: 112, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-103", environment: "staging", secretPath: "/billing", rootVersion: 113, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-104", environment: "prod", secretPath: "/ingest", rootVersion: 114, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-105", environment: "dev", secretPath: "/app", rootVersion: 115, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-106", environment: "staging", secretPath: "/api", rootVersion: 116, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-107", environment: "prod", secretPath: "/worker", rootVersion: 117, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-108", environment: "dev", secretPath: "/jobs", rootVersion: 118, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-109", environment: "staging", secretPath: "/auth", rootVersion: 119, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-110", environment: "prod", secretPath: "/billing", rootVersion: 120, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-111", environment: "dev", secretPath: "/ingest", rootVersion: 121, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-112", environment: "staging", secretPath: "/app", rootVersion: 122, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-113", environment: "prod", secretPath: "/api", rootVersion: 123, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-114", environment: "dev", secretPath: "/worker", rootVersion: 124, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-115", environment: "staging", secretPath: "/jobs", rootVersion: 125, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-116", environment: "prod", secretPath: "/auth", rootVersion: 126, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-117", environment: "dev", secretPath: "/billing", rootVersion: 127, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-118", environment: "staging", secretPath: "/ingest", rootVersion: 128, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-119", environment: "prod", secretPath: "/app", rootVersion: 129, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-120", environment: "dev", secretPath: "/api", rootVersion: 130, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-121", environment: "staging", secretPath: "/worker", rootVersion: 131, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-122", environment: "prod", secretPath: "/jobs", rootVersion: 132, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-123", environment: "dev", secretPath: "/auth", rootVersion: 133, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-124", environment: "staging", secretPath: "/billing", rootVersion: 134, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-125", environment: "prod", secretPath: "/ingest", rootVersion: 135, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-126", environment: "dev", secretPath: "/app", rootVersion: 136, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-127", environment: "staging", secretPath: "/api", rootVersion: 137, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-128", environment: "prod", secretPath: "/worker", rootVersion: 138, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-129", environment: "dev", secretPath: "/jobs", rootVersion: 139, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-130", environment: "staging", secretPath: "/auth", rootVersion: 140, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-131", environment: "prod", secretPath: "/billing", rootVersion: 141, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-132", environment: "dev", secretPath: "/ingest", rootVersion: 142, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-133", environment: "staging", secretPath: "/app", rootVersion: 143, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-134", environment: "prod", secretPath: "/api", rootVersion: 144, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-135", environment: "dev", secretPath: "/worker", rootVersion: 145, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-136", environment: "staging", secretPath: "/jobs", rootVersion: 146, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-137", environment: "prod", secretPath: "/auth", rootVersion: 147, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-138", environment: "dev", secretPath: "/billing", rootVersion: 148, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-139", environment: "staging", secretPath: "/ingest", rootVersion: 149, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-140", environment: "prod", secretPath: "/app", rootVersion: 150, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-141", environment: "dev", secretPath: "/api", rootVersion: 151, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-142", environment: "staging", secretPath: "/worker", rootVersion: 152, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-143", environment: "prod", secretPath: "/jobs", rootVersion: 153, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-144", environment: "dev", secretPath: "/auth", rootVersion: 154, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-145", environment: "staging", secretPath: "/billing", rootVersion: 155, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-146", environment: "prod", secretPath: "/ingest", rootVersion: 156, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-147", environment: "dev", secretPath: "/app", rootVersion: 157, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-148", environment: "staging", secretPath: "/api", rootVersion: 158, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-149", environment: "prod", secretPath: "/worker", rootVersion: 159, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-150", environment: "dev", secretPath: "/jobs", rootVersion: 160, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-151", environment: "staging", secretPath: "/auth", rootVersion: 161, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-152", environment: "prod", secretPath: "/billing", rootVersion: 162, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-153", environment: "dev", secretPath: "/ingest", rootVersion: 163, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-154", environment: "staging", secretPath: "/app", rootVersion: 164, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-155", environment: "prod", secretPath: "/api", rootVersion: 165, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-156", environment: "dev", secretPath: "/worker", rootVersion: 166, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-157", environment: "staging", secretPath: "/jobs", rootVersion: 167, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-158", environment: "prod", secretPath: "/auth", rootVersion: 168, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-159", environment: "dev", secretPath: "/billing", rootVersion: 169, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-160", environment: "staging", secretPath: "/ingest", rootVersion: 170, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-161", environment: "prod", secretPath: "/app", rootVersion: 171, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-162", environment: "dev", secretPath: "/api", rootVersion: 172, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-163", environment: "staging", secretPath: "/worker", rootVersion: 173, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-164", environment: "prod", secretPath: "/jobs", rootVersion: 174, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-165", environment: "dev", secretPath: "/auth", rootVersion: 175, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-166", environment: "staging", secretPath: "/billing", rootVersion: 176, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-167", environment: "prod", secretPath: "/ingest", rootVersion: 177, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-168", environment: "dev", secretPath: "/app", rootVersion: 178, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-169", environment: "staging", secretPath: "/api", rootVersion: 179, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-170", environment: "prod", secretPath: "/worker", rootVersion: 180, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-171", environment: "dev", secretPath: "/jobs", rootVersion: 181, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-172", environment: "staging", secretPath: "/auth", rootVersion: 182, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-173", environment: "prod", secretPath: "/billing", rootVersion: 183, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-174", environment: "dev", secretPath: "/ingest", rootVersion: 184, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-175", environment: "staging", secretPath: "/app", rootVersion: 185, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-176", environment: "prod", secretPath: "/api", rootVersion: 186, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-177", environment: "dev", secretPath: "/worker", rootVersion: 187, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-178", environment: "staging", secretPath: "/jobs", rootVersion: 188, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-179", environment: "prod", secretPath: "/auth", rootVersion: 189, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-180", environment: "dev", secretPath: "/billing", rootVersion: 190, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-181", environment: "staging", secretPath: "/ingest", rootVersion: 191, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-182", environment: "prod", secretPath: "/app", rootVersion: 192, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-183", environment: "dev", secretPath: "/api", rootVersion: 193, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-184", environment: "staging", secretPath: "/worker", rootVersion: 194, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-185", environment: "prod", secretPath: "/jobs", rootVersion: 195, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-186", environment: "dev", secretPath: "/auth", rootVersion: 196, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-187", environment: "staging", secretPath: "/billing", rootVersion: 197, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-188", environment: "prod", secretPath: "/ingest", rootVersion: 198, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-189", environment: "dev", secretPath: "/app", rootVersion: 199, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-190", environment: "staging", secretPath: "/api", rootVersion: 200, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-191", environment: "prod", secretPath: "/worker", rootVersion: 201, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-192", environment: "dev", secretPath: "/jobs", rootVersion: 202, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-193", environment: "staging", secretPath: "/auth", rootVersion: 203, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-194", environment: "prod", secretPath: "/billing", rootVersion: 204, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-195", environment: "dev", secretPath: "/ingest", rootVersion: 205, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-196", environment: "staging", secretPath: "/app", rootVersion: 206, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-197", environment: "prod", secretPath: "/api", rootVersion: 207, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-198", environment: "dev", secretPath: "/worker", rootVersion: 208, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-199", environment: "staging", secretPath: "/jobs", rootVersion: 209, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-200", environment: "prod", secretPath: "/auth", rootVersion: 210, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-201", environment: "dev", secretPath: "/billing", rootVersion: 211, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-202", environment: "staging", secretPath: "/ingest", rootVersion: 212, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-203", environment: "prod", secretPath: "/app", rootVersion: 213, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-204", environment: "dev", secretPath: "/api", rootVersion: 214, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-205", environment: "staging", secretPath: "/worker", rootVersion: 215, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-206", environment: "prod", secretPath: "/jobs", rootVersion: 216, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-207", environment: "dev", secretPath: "/auth", rootVersion: 217, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-208", environment: "staging", secretPath: "/billing", rootVersion: 218, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-209", environment: "prod", secretPath: "/ingest", rootVersion: 219, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-210", environment: "dev", secretPath: "/app", rootVersion: 220, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-211", environment: "staging", secretPath: "/api", rootVersion: 221, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-212", environment: "prod", secretPath: "/worker", rootVersion: 222, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-213", environment: "dev", secretPath: "/jobs", rootVersion: 223, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-214", environment: "staging", secretPath: "/auth", rootVersion: 224, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-215", environment: "prod", secretPath: "/billing", rootVersion: 225, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-216", environment: "dev", secretPath: "/ingest", rootVersion: 226, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-217", environment: "staging", secretPath: "/app", rootVersion: 227, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-218", environment: "prod", secretPath: "/api", rootVersion: 228, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-219", environment: "dev", secretPath: "/worker", rootVersion: 229, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-220", environment: "staging", secretPath: "/jobs", rootVersion: 230, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-221", environment: "prod", secretPath: "/auth", rootVersion: 231, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-222", environment: "dev", secretPath: "/billing", rootVersion: 232, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-223", environment: "staging", secretPath: "/ingest", rootVersion: 233, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-224", environment: "prod", secretPath: "/app", rootVersion: 234, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-225", environment: "dev", secretPath: "/api", rootVersion: 235, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-226", environment: "staging", secretPath: "/worker", rootVersion: 236, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-227", environment: "prod", secretPath: "/jobs", rootVersion: 237, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-228", environment: "dev", secretPath: "/auth", rootVersion: 238, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-229", environment: "staging", secretPath: "/billing", rootVersion: 239, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-230", environment: "prod", secretPath: "/ingest", rootVersion: 240, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-231", environment: "dev", secretPath: "/app", rootVersion: 241, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-232", environment: "staging", secretPath: "/api", rootVersion: 242, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-233", environment: "prod", secretPath: "/worker", rootVersion: 243, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-234", environment: "dev", secretPath: "/jobs", rootVersion: 244, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-235", environment: "staging", secretPath: "/auth", rootVersion: 245, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-236", environment: "prod", secretPath: "/billing", rootVersion: 246, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-237", environment: "dev", secretPath: "/ingest", rootVersion: 247, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-238", environment: "staging", secretPath: "/app", rootVersion: 248, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-239", environment: "prod", secretPath: "/api", rootVersion: 249, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-240", environment: "dev", secretPath: "/worker", rootVersion: 250, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-241", environment: "staging", secretPath: "/jobs", rootVersion: 251, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-242", environment: "prod", secretPath: "/auth", rootVersion: 252, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-243", environment: "dev", secretPath: "/billing", rootVersion: 253, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-244", environment: "staging", secretPath: "/ingest", rootVersion: 254, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-245", environment: "prod", secretPath: "/app", rootVersion: 255, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-246", environment: "dev", secretPath: "/api", rootVersion: 256, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-247", environment: "staging", secretPath: "/worker", rootVersion: 257, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-248", environment: "prod", secretPath: "/jobs", rootVersion: 258, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-249", environment: "dev", secretPath: "/auth", rootVersion: 259, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-250", environment: "staging", secretPath: "/billing", rootVersion: 260, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-251", environment: "prod", secretPath: "/ingest", rootVersion: 261, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-252", environment: "dev", secretPath: "/app", rootVersion: 262, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-253", environment: "staging", secretPath: "/api", rootVersion: 263, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-254", environment: "prod", secretPath: "/worker", rootVersion: 264, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-255", environment: "dev", secretPath: "/jobs", rootVersion: 265, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-256", environment: "staging", secretPath: "/auth", rootVersion: 266, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-257", environment: "prod", secretPath: "/billing", rootVersion: 267, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-258", environment: "dev", secretPath: "/ingest", rootVersion: 268, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-259", environment: "staging", secretPath: "/app", rootVersion: 269, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-260", environment: "prod", secretPath: "/api", rootVersion: 270, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-261", environment: "dev", secretPath: "/worker", rootVersion: 271, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-262", environment: "staging", secretPath: "/jobs", rootVersion: 272, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-263", environment: "prod", secretPath: "/auth", rootVersion: 273, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-264", environment: "dev", secretPath: "/billing", rootVersion: 274, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-265", environment: "staging", secretPath: "/ingest", rootVersion: 275, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-266", environment: "prod", secretPath: "/app", rootVersion: 276, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-267", environment: "dev", secretPath: "/api", rootVersion: 277, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-268", environment: "staging", secretPath: "/worker", rootVersion: 278, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-269", environment: "prod", secretPath: "/jobs", rootVersion: 279, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-270", environment: "dev", secretPath: "/auth", rootVersion: 280, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-271", environment: "staging", secretPath: "/billing", rootVersion: 281, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-272", environment: "prod", secretPath: "/ingest", rootVersion: 282, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-273", environment: "dev", secretPath: "/app", rootVersion: 283, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-274", environment: "staging", secretPath: "/api", rootVersion: 284, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-275", environment: "prod", secretPath: "/worker", rootVersion: 285, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-276", environment: "dev", secretPath: "/jobs", rootVersion: 286, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-277", environment: "staging", secretPath: "/auth", rootVersion: 287, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-278", environment: "prod", secretPath: "/billing", rootVersion: 288, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-279", environment: "dev", secretPath: "/ingest", rootVersion: 289, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-280", environment: "staging", secretPath: "/app", rootVersion: 290, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-281", environment: "prod", secretPath: "/api", rootVersion: 291, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-282", environment: "dev", secretPath: "/worker", rootVersion: 292, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-283", environment: "staging", secretPath: "/jobs", rootVersion: 293, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-284", environment: "prod", secretPath: "/auth", rootVersion: 294, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-285", environment: "dev", secretPath: "/billing", rootVersion: 295, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-286", environment: "staging", secretPath: "/ingest", rootVersion: 296, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-287", environment: "prod", secretPath: "/app", rootVersion: 297, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-288", environment: "dev", secretPath: "/api", rootVersion: 298, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-289", environment: "staging", secretPath: "/worker", rootVersion: 299, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-290", environment: "prod", secretPath: "/jobs", rootVersion: 300, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-291", environment: "dev", secretPath: "/auth", rootVersion: 301, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-292", environment: "staging", secretPath: "/billing", rootVersion: 302, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-293", environment: "prod", secretPath: "/ingest", rootVersion: 303, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-294", environment: "dev", secretPath: "/app", rootVersion: 304, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-295", environment: "staging", secretPath: "/api", rootVersion: 305, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-296", environment: "prod", secretPath: "/worker", rootVersion: 306, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-297", environment: "dev", secretPath: "/jobs", rootVersion: 307, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-298", environment: "staging", secretPath: "/auth", rootVersion: 308, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-299", environment: "prod", secretPath: "/billing", rootVersion: 309, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-300", environment: "dev", secretPath: "/ingest", rootVersion: 310, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-301", environment: "staging", secretPath: "/app", rootVersion: 311, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-302", environment: "prod", secretPath: "/api", rootVersion: 312, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-303", environment: "dev", secretPath: "/worker", rootVersion: 313, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-304", environment: "staging", secretPath: "/jobs", rootVersion: 314, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-305", environment: "prod", secretPath: "/auth", rootVersion: 315, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-306", environment: "dev", secretPath: "/billing", rootVersion: 316, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-307", environment: "staging", secretPath: "/ingest", rootVersion: 317, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-308", environment: "prod", secretPath: "/app", rootVersion: 318, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-309", environment: "dev", secretPath: "/api", rootVersion: 319, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-310", environment: "staging", secretPath: "/worker", rootVersion: 320, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-311", environment: "prod", secretPath: "/jobs", rootVersion: 321, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-312", environment: "dev", secretPath: "/auth", rootVersion: 322, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-313", environment: "staging", secretPath: "/billing", rootVersion: 323, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-314", environment: "prod", secretPath: "/ingest", rootVersion: 324, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-315", environment: "dev", secretPath: "/app", rootVersion: 325, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-316", environment: "staging", secretPath: "/api", rootVersion: 326, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-317", environment: "prod", secretPath: "/worker", rootVersion: 327, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-318", environment: "dev", secretPath: "/jobs", rootVersion: 328, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-319", environment: "staging", secretPath: "/auth", rootVersion: 329, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-320", environment: "prod", secretPath: "/billing", rootVersion: 330, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-321", environment: "dev", secretPath: "/ingest", rootVersion: 331, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-322", environment: "staging", secretPath: "/app", rootVersion: 332, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-323", environment: "prod", secretPath: "/api", rootVersion: 333, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-324", environment: "dev", secretPath: "/worker", rootVersion: 334, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-325", environment: "staging", secretPath: "/jobs", rootVersion: 335, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-326", environment: "prod", secretPath: "/auth", rootVersion: 336, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-327", environment: "dev", secretPath: "/billing", rootVersion: 337, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-328", environment: "staging", secretPath: "/ingest", rootVersion: 338, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-329", environment: "prod", secretPath: "/app", rootVersion: 339, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-330", environment: "dev", secretPath: "/api", rootVersion: 340, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-331", environment: "staging", secretPath: "/worker", rootVersion: 341, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-332", environment: "prod", secretPath: "/jobs", rootVersion: 342, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-333", environment: "dev", secretPath: "/auth", rootVersion: 343, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-334", environment: "staging", secretPath: "/billing", rootVersion: 344, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-335", environment: "prod", secretPath: "/ingest", rootVersion: 345, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-336", environment: "dev", secretPath: "/app", rootVersion: 346, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-337", environment: "staging", secretPath: "/api", rootVersion: 347, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-338", environment: "prod", secretPath: "/worker", rootVersion: 348, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-339", environment: "dev", secretPath: "/jobs", rootVersion: 349, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-340", environment: "staging", secretPath: "/auth", rootVersion: 350, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-341", environment: "prod", secretPath: "/billing", rootVersion: 351, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-342", environment: "dev", secretPath: "/ingest", rootVersion: 352, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-343", environment: "staging", secretPath: "/app", rootVersion: 353, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-344", environment: "prod", secretPath: "/api", rootVersion: 354, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-345", environment: "dev", secretPath: "/worker", rootVersion: 355, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-346", environment: "staging", secretPath: "/jobs", rootVersion: 356, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-347", environment: "prod", secretPath: "/auth", rootVersion: 357, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-348", environment: "dev", secretPath: "/billing", rootVersion: 358, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-349", environment: "staging", secretPath: "/ingest", rootVersion: 359, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-350", environment: "prod", secretPath: "/app", rootVersion: 360, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-351", environment: "dev", secretPath: "/api", rootVersion: 361, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-352", environment: "staging", secretPath: "/worker", rootVersion: 362, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-353", environment: "prod", secretPath: "/jobs", rootVersion: 363, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-354", environment: "dev", secretPath: "/auth", rootVersion: 364, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-355", environment: "staging", secretPath: "/billing", rootVersion: 365, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-356", environment: "prod", secretPath: "/ingest", rootVersion: 366, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-357", environment: "dev", secretPath: "/app", rootVersion: 367, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-358", environment: "staging", secretPath: "/api", rootVersion: 368, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-359", environment: "prod", secretPath: "/worker", rootVersion: 369, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-360", environment: "dev", secretPath: "/jobs", rootVersion: 370, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-361", environment: "staging", secretPath: "/auth", rootVersion: 371, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-362", environment: "prod", secretPath: "/billing", rootVersion: 372, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-363", environment: "dev", secretPath: "/ingest", rootVersion: 373, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-364", environment: "staging", secretPath: "/app", rootVersion: 374, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-365", environment: "prod", secretPath: "/api", rootVersion: 375, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-366", environment: "dev", secretPath: "/worker", rootVersion: 376, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-367", environment: "staging", secretPath: "/jobs", rootVersion: 377, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-368", environment: "prod", secretPath: "/auth", rootVersion: 378, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-369", environment: "dev", secretPath: "/billing", rootVersion: 379, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-370", environment: "staging", secretPath: "/ingest", rootVersion: 380, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-371", environment: "prod", secretPath: "/app", rootVersion: 381, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-372", environment: "dev", secretPath: "/api", rootVersion: 382, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-373", environment: "staging", secretPath: "/worker", rootVersion: 383, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-374", environment: "prod", secretPath: "/jobs", rootVersion: 384, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-375", environment: "dev", secretPath: "/auth", rootVersion: 385, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-376", environment: "staging", secretPath: "/billing", rootVersion: 386, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-377", environment: "prod", secretPath: "/ingest", rootVersion: 387, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-378", environment: "dev", secretPath: "/app", rootVersion: 388, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-379", environment: "staging", secretPath: "/api", rootVersion: 389, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-380", environment: "prod", secretPath: "/worker", rootVersion: 390, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-381", environment: "dev", secretPath: "/jobs", rootVersion: 391, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-382", environment: "staging", secretPath: "/auth", rootVersion: 392, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-383", environment: "prod", secretPath: "/billing", rootVersion: 393, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-384", environment: "dev", secretPath: "/ingest", rootVersion: 394, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-385", environment: "staging", secretPath: "/app", rootVersion: 395, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-386", environment: "prod", secretPath: "/api", rootVersion: 396, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-387", environment: "dev", secretPath: "/worker", rootVersion: 397, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-388", environment: "staging", secretPath: "/jobs", rootVersion: 398, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-389", environment: "prod", secretPath: "/auth", rootVersion: 399, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-390", environment: "dev", secretPath: "/billing", rootVersion: 400, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-391", environment: "staging", secretPath: "/ingest", rootVersion: 401, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-392", environment: "prod", secretPath: "/app", rootVersion: 402, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-393", environment: "dev", secretPath: "/api", rootVersion: 403, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-394", environment: "staging", secretPath: "/worker", rootVersion: 404, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-395", environment: "prod", secretPath: "/jobs", rootVersion: 405, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-396", environment: "dev", secretPath: "/auth", rootVersion: 406, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-397", environment: "staging", secretPath: "/billing", rootVersion: 407, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-398", environment: "prod", secretPath: "/ingest", rootVersion: 408, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-399", environment: "dev", secretPath: "/app", rootVersion: 409, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-400", environment: "staging", secretPath: "/api", rootVersion: 410, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-401", environment: "prod", secretPath: "/worker", rootVersion: 411, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-402", environment: "dev", secretPath: "/jobs", rootVersion: 412, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-403", environment: "staging", secretPath: "/auth", rootVersion: 413, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-404", environment: "prod", secretPath: "/billing", rootVersion: 414, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-405", environment: "dev", secretPath: "/ingest", rootVersion: 415, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-406", environment: "staging", secretPath: "/app", rootVersion: 416, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-407", environment: "prod", secretPath: "/api", rootVersion: 417, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-408", environment: "dev", secretPath: "/worker", rootVersion: 418, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-409", environment: "staging", secretPath: "/jobs", rootVersion: 419, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-410", environment: "prod", secretPath: "/auth", rootVersion: 420, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-411", environment: "dev", secretPath: "/billing", rootVersion: 421, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-412", environment: "staging", secretPath: "/ingest", rootVersion: 422, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-413", environment: "prod", secretPath: "/app", rootVersion: 423, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-414", environment: "dev", secretPath: "/api", rootVersion: 424, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-415", environment: "staging", secretPath: "/worker", rootVersion: 425, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-416", environment: "prod", secretPath: "/jobs", rootVersion: 426, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-417", environment: "dev", secretPath: "/auth", rootVersion: 427, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-418", environment: "staging", secretPath: "/billing", rootVersion: 428, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-419", environment: "prod", secretPath: "/ingest", rootVersion: 429, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-420", environment: "dev", secretPath: "/app", rootVersion: 430, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-421", environment: "staging", secretPath: "/api", rootVersion: 431, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-422", environment: "prod", secretPath: "/worker", rootVersion: 432, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-423", environment: "dev", secretPath: "/jobs", rootVersion: 433, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-424", environment: "staging", secretPath: "/auth", rootVersion: 434, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-425", environment: "prod", secretPath: "/billing", rootVersion: 435, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-426", environment: "dev", secretPath: "/ingest", rootVersion: 436, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-427", environment: "staging", secretPath: "/app", rootVersion: 437, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-428", environment: "prod", secretPath: "/api", rootVersion: 438, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-429", environment: "dev", secretPath: "/worker", rootVersion: 439, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-430", environment: "staging", secretPath: "/jobs", rootVersion: 440, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-431", environment: "prod", secretPath: "/auth", rootVersion: 441, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-432", environment: "dev", secretPath: "/billing", rootVersion: 442, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-433", environment: "staging", secretPath: "/ingest", rootVersion: 443, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-434", environment: "prod", secretPath: "/app", rootVersion: 444, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-435", environment: "dev", secretPath: "/api", rootVersion: 445, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-436", environment: "staging", secretPath: "/worker", rootVersion: 446, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-437", environment: "prod", secretPath: "/jobs", rootVersion: 447, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-438", environment: "dev", secretPath: "/auth", rootVersion: 448, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-439", environment: "staging", secretPath: "/billing", rootVersion: 449, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-440", environment: "prod", secretPath: "/ingest", rootVersion: 450, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-441", environment: "dev", secretPath: "/app", rootVersion: 451, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-442", environment: "staging", secretPath: "/api", rootVersion: 452, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-443", environment: "prod", secretPath: "/worker", rootVersion: 453, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-444", environment: "dev", secretPath: "/jobs", rootVersion: 454, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-445", environment: "staging", secretPath: "/auth", rootVersion: 455, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-446", environment: "prod", secretPath: "/billing", rootVersion: 456, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-447", environment: "dev", secretPath: "/ingest", rootVersion: 457, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-448", environment: "staging", secretPath: "/app", rootVersion: 458, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-449", environment: "prod", secretPath: "/api", rootVersion: 459, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-450", environment: "dev", secretPath: "/worker", rootVersion: 460, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-451", environment: "staging", secretPath: "/jobs", rootVersion: 461, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-452", environment: "prod", secretPath: "/auth", rootVersion: 462, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-453", environment: "dev", secretPath: "/billing", rootVersion: 463, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-454", environment: "staging", secretPath: "/ingest", rootVersion: 464, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-455", environment: "prod", secretPath: "/app", rootVersion: 465, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-456", environment: "dev", secretPath: "/api", rootVersion: 466, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-457", environment: "staging", secretPath: "/worker", rootVersion: 467, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-458", environment: "prod", secretPath: "/jobs", rootVersion: 468, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-459", environment: "dev", secretPath: "/auth", rootVersion: 469, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-460", environment: "staging", secretPath: "/billing", rootVersion: 470, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-461", environment: "prod", secretPath: "/ingest", rootVersion: 471, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-462", environment: "dev", secretPath: "/app", rootVersion: 472, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-463", environment: "staging", secretPath: "/api", rootVersion: 473, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-464", environment: "prod", secretPath: "/worker", rootVersion: 474, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-465", environment: "dev", secretPath: "/jobs", rootVersion: 475, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-466", environment: "staging", secretPath: "/auth", rootVersion: 476, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-467", environment: "prod", secretPath: "/billing", rootVersion: 477, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-468", environment: "dev", secretPath: "/ingest", rootVersion: 478, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-469", environment: "staging", secretPath: "/app", rootVersion: 479, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-470", environment: "prod", secretPath: "/api", rootVersion: 480, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-471", environment: "dev", secretPath: "/worker", rootVersion: 481, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-472", environment: "staging", secretPath: "/jobs", rootVersion: 482, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-473", environment: "prod", secretPath: "/auth", rootVersion: 483, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-474", environment: "dev", secretPath: "/billing", rootVersion: 484, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-475", environment: "staging", secretPath: "/ingest", rootVersion: 485, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-476", environment: "prod", secretPath: "/app", rootVersion: 486, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-477", environment: "dev", secretPath: "/api", rootVersion: 487, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-478", environment: "staging", secretPath: "/worker", rootVersion: 488, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-479", environment: "prod", secretPath: "/jobs", rootVersion: 489, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-480", environment: "dev", secretPath: "/auth", rootVersion: 490, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-481", environment: "staging", secretPath: "/billing", rootVersion: 491, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-482", environment: "prod", secretPath: "/ingest", rootVersion: 492, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-483", environment: "dev", secretPath: "/app", rootVersion: 493, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-484", environment: "staging", secretPath: "/api", rootVersion: 494, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-485", environment: "prod", secretPath: "/worker", rootVersion: 495, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-486", environment: "dev", secretPath: "/jobs", rootVersion: 496, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-487", environment: "staging", secretPath: "/auth", rootVersion: 497, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-488", environment: "prod", secretPath: "/billing", rootVersion: 498, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-489", environment: "dev", secretPath: "/ingest", rootVersion: 499, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-490", environment: "staging", secretPath: "/app", rootVersion: 500, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-491", environment: "prod", secretPath: "/api", rootVersion: 501, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-492", environment: "dev", secretPath: "/worker", rootVersion: 502, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-493", environment: "staging", secretPath: "/jobs", rootVersion: 503, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-494", environment: "prod", secretPath: "/auth", rootVersion: 504, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-495", environment: "dev", secretPath: "/billing", rootVersion: 505, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-496", environment: "staging", secretPath: "/ingest", rootVersion: 506, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-497", environment: "prod", secretPath: "/app", rootVersion: 507, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-498", environment: "dev", secretPath: "/api", rootVersion: 508, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-499", environment: "staging", secretPath: "/worker", rootVersion: 509, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-500", environment: "prod", secretPath: "/jobs", rootVersion: 510, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-501", environment: "dev", secretPath: "/auth", rootVersion: 511, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-502", environment: "staging", secretPath: "/billing", rootVersion: 512, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-503", environment: "prod", secretPath: "/ingest", rootVersion: 513, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-504", environment: "dev", secretPath: "/app", rootVersion: 514, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-505", environment: "staging", secretPath: "/api", rootVersion: 515, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-506", environment: "prod", secretPath: "/worker", rootVersion: 516, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-507", environment: "dev", secretPath: "/jobs", rootVersion: 517, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-508", environment: "staging", secretPath: "/auth", rootVersion: 518, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-509", environment: "prod", secretPath: "/billing", rootVersion: 519, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-510", environment: "dev", secretPath: "/ingest", rootVersion: 520, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-511", environment: "staging", secretPath: "/app", rootVersion: 521, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-512", environment: "prod", secretPath: "/api", rootVersion: 522, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-513", environment: "dev", secretPath: "/worker", rootVersion: 523, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-514", environment: "staging", secretPath: "/jobs", rootVersion: 524, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-515", environment: "prod", secretPath: "/auth", rootVersion: 525, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-516", environment: "dev", secretPath: "/billing", rootVersion: 526, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-517", environment: "staging", secretPath: "/ingest", rootVersion: 527, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-518", environment: "prod", secretPath: "/app", rootVersion: 528, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-519", environment: "dev", secretPath: "/api", rootVersion: 529, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-520", environment: "staging", secretPath: "/worker", rootVersion: 530, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-521", environment: "prod", secretPath: "/jobs", rootVersion: 531, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-522", environment: "dev", secretPath: "/auth", rootVersion: 532, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-523", environment: "staging", secretPath: "/billing", rootVersion: 533, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-524", environment: "prod", secretPath: "/ingest", rootVersion: 534, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-525", environment: "dev", secretPath: "/app", rootVersion: 535, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-526", environment: "staging", secretPath: "/api", rootVersion: 536, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-527", environment: "prod", secretPath: "/worker", rootVersion: 537, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-528", environment: "dev", secretPath: "/jobs", rootVersion: 538, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-529", environment: "staging", secretPath: "/auth", rootVersion: 539, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-530", environment: "prod", secretPath: "/billing", rootVersion: 540, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-531", environment: "dev", secretPath: "/ingest", rootVersion: 541, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-532", environment: "staging", secretPath: "/app", rootVersion: 542, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-533", environment: "prod", secretPath: "/api", rootVersion: 543, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-534", environment: "dev", secretPath: "/worker", rootVersion: 544, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-535", environment: "staging", secretPath: "/jobs", rootVersion: 545, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-536", environment: "prod", secretPath: "/auth", rootVersion: 546, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-537", environment: "dev", secretPath: "/billing", rootVersion: 547, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-538", environment: "staging", secretPath: "/ingest", rootVersion: 548, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-539", environment: "prod", secretPath: "/app", rootVersion: 549, editDuringRotation: false, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-540", environment: "dev", secretPath: "/api", rootVersion: 550, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-541", environment: "staging", secretPath: "/worker", rootVersion: 551, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-542", environment: "prod", secretPath: "/jobs", rootVersion: 552, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-543", environment: "dev", secretPath: "/auth", rootVersion: 553, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-544", environment: "staging", secretPath: "/billing", rootVersion: 554, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-545", environment: "prod", secretPath: "/ingest", rootVersion: 555, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-546", environment: "dev", secretPath: "/app", rootVersion: 556, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-547", environment: "staging", secretPath: "/api", rootVersion: 557, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-548", environment: "prod", secretPath: "/worker", rootVersion: 558, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-549", environment: "dev", secretPath: "/jobs", rootVersion: 559, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-550", environment: "staging", secretPath: "/auth", rootVersion: 560, editDuringRotation: true, providerVerified: false, expectedStatus: "failed" },
+  { name: "rotation-reference-scenario-551", environment: "prod", secretPath: "/billing", rootVersion: 561, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-552", environment: "dev", secretPath: "/ingest", rootVersion: 562, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-553", environment: "staging", secretPath: "/app", rootVersion: 563, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-554", environment: "prod", secretPath: "/api", rootVersion: 564, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-555", environment: "dev", secretPath: "/worker", rootVersion: 565, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-556", environment: "staging", secretPath: "/jobs", rootVersion: 566, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-557", environment: "prod", secretPath: "/auth", rootVersion: 567, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-558", environment: "dev", secretPath: "/billing", rootVersion: 568, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-559", environment: "staging", secretPath: "/ingest", rootVersion: 569, editDuringRotation: false, providerVerified: true, expectedStatus: "succeeded" },
+  { name: "rotation-reference-scenario-560", environment: "prod", secretPath: "/app", rootVersion: 570, editDuringRotation: true, providerVerified: true, expectedStatus: "succeeded" },
+];
+
+describe("rotation reference review matrix", () => {
+  it.each(matrix)("records the expected scenario contract for $name", (scenario) => {
+    expect(scenario.secretPath.startsWith("/")).toBe(true);
+    expect(scenario.rootVersion).toBeGreaterThan(0);
+    if (scenario.editDuringRotation) expect(scenario.rootVersion).toBeGreaterThan(10);
+    if (!scenario.providerVerified) expect(scenario.expectedStatus).toBe("failed");
+  });
+});
+
+export const rotationReferenceReviewerQuestions = matrix.map((scenario) => ({
+  name: scenario.name,
+  asksForVersionPredicate: scenario.editDuringRotation,
+  asksForVerifyBeforePublish: !scenario.providerVerified,
+  environment: scenario.environment,
+  secretPath: scenario.secretPath,
+}));
```

## Intended Flaws

### Flaw 1: Rotation overwrites concurrent manual secret edits

The service reads `rootSecret.version` into `rootVersionBefore`, records it in the run row, and then writes through `fnSecretBulkUpdate` using filters that only include `id`, `folderId`, and `type`. The captured version is never used as a precondition. If an engineer manually edits `AUTH0_CLIENT_SECRET` while the provider issue call or graph resolution is in flight, this rotation will still update the same secret and create a new version on top of the manual edit without detecting the conflict.

### Flaw 1 Hints

1. Find where the code captures the root secret version. Then search for where that version is used during the write.
2. Compare the bulk update filter in the PR to the contract you would want for optimistic concurrency.
3. Imagine a user saves the secret editor after preview but before the provider returns a candidate. What database predicate prevents the older rotation from winning?

### Flaw 2: Dependent references are published before the new credential is verified

The service builds writes and calls `applyWrites` inside the transaction before calling `provider.verifyCandidate(candidate)`. That means the root secret and all dependent rewritten secrets can become visible through cache invalidation, snapshots, sync, or direct reads even if provider verification rejects the candidate immediately afterward. Marking the run failed does not undo the already-created secret versions.

### Flaw 2 Hints

1. Trace the lifecycle of `candidate`: issue, write, verify, side effects. Which step makes the value durable?
2. Check the verification-failure test. It asserts the run is failed, but what does it assert about secret writes?
3. Ask whether a failed provider credential should ever be committed into the secret manager or dependent deployment config.

## Expected Answer

### Flaw 1 Expected Answer

A strong answer should identify the lost-update bug in `rotate-secret-and-update-references-service.ts`: `rootVersionBefore` is captured, but `applyWrites` sends filters of `{ id, folderId, type }` to `fnSecretBulkUpdate` and never includes `version: rootVersionBefore` or a latest-version-id precondition. The run row stores the version, but storage is observational; it does not protect the write.

Production impact: a scheduled or manual rotation can silently overwrite a human's manual secret edit. The audit log will show both writes as legitimate versions, but the product has lost the user's intended current secret state. Downstream services may receive a provider credential that was not the latest accepted secret, and support has to reconstruct ordering from version history.

Better implementation: perform the root write under optimistic concurrency. The root update should be a conditional update such as `WHERE id = rootSecretId AND folderId = folder.id AND version = rootVersionBefore`, or compare against the latest `SecretVersionV2.id` read at the start. If the predicate does not match, return a conflict and ask the caller to preview again. For long provider calls, issue and verify candidates in a staged state, then take a short transaction with the version check for promotion. If dependent reference graph freshness matters, also version or revalidate the reference graph before publishing.

### Flaw 2 Expected Answer

A strong answer should identify the ordering bug in `rotate-secret-and-update-references-service.ts`: the code calls `provider.issueCandidate`, builds reference writes, applies them through `fnSecretBulkUpdate`, creates the commit, and only then calls `provider.verifyCandidate(candidate)`. If verification fails, `markFailed` is called, but the root and dependent secret versions have already been inserted.

Production impact: deployments can consume a credential that does not authenticate with the provider. Because dependent secrets are rewritten too, this is not a single bad secret; connection strings, API tokens, worker configs, and synced integrations can all be pointed at the rejected value. A failed run now requires rollback of every created secret version or another rotation, and the failure mode can present as unrelated production auth outages.

Better implementation: use staged promotion. Issue the provider candidate, verify it against the provider before any dependent secret update, then promote it in one short transaction that checks the root version. If the provider requires publication before verification, record the candidate as pending and keep old dependents active until `verifyCandidate` succeeds; then atomically update the root and references. If a later sync step fails, mark partial success and retry sync rather than calling the credential rotation failed after values are already committed.

## Expert Debrief

### Product-Level Change

The product-level change is attractive: users want rotation to update the secrets that embed the rotated credential, not just the source secret. This turns rotation from a single-secret operation into a graph-publishing operation. That is much more powerful, and it also means the reviewer has to reason about state visibility, concurrency, and rollback across multiple systems.

### Changed Contracts

This PR changes several contracts at once:

- Secret updates are no longer only user saves or provider rotation writes; a rotation can now rewrite dependent application secrets.
- `SecretReferenceV2` becomes a publish graph, not just an expansion/indexing helper.
- `SecretVersionV2` history becomes the conflict boundary for a long-running rotation.
- Provider credentials now need a candidate/verify/promote lifecycle, not a simple generate-and-store lifecycle.
- Snapshots and secret sync become fan-out side effects for all affected folders and paths.
- Run status must distinguish failed-before-publish, failed-after-publish, and partial sync states.

### Failure Modes To Think Through

- A human edits the same secret during a long provider request.
- A provider issues a credential that cannot authenticate because of scope, propagation delay, or disabled app settings.
- A dependent secret is rewritten and synced before the root value is actually valid.
- The reference graph changes after preview.
- Cache invalidation or external sync fails after database writes succeed.
- Rollback must preserve version history rather than mutating old records.

### Reviewer Thought Process

The review move is to trace the moment an old read becomes a write. Whenever a PR captures a version or timestamp, ask whether it is used as a predicate or only as metadata. Then trace the moment a candidate value becomes visible to other systems. The safe order is usually: read current state, issue candidate, verify candidate, open short transaction, check current state still matches, promote value, write dependent state, commit, then fan out side effects.

### Better Implementation Direction

A robust design would introduce an explicit rotation candidate record or use the existing rotation status model. The candidate can be issued and verified without changing the visible secret value. Promotion should then run in a short transaction with a root-secret version precondition. Dependent secret updates should be derived from the promoted candidate and committed together with the root update, followed by cache invalidation, snapshots, and sync. If sync fails after commit, mark partial success and retry sync work; do not pretend the credential rotation itself failed before deciding whether rollback is required.

## Correctness Verdict Rubric

- `correct`: The answer identifies both the missing version precondition/lost-update bug and the publish-before-verify ordering bug, explains production impact, and suggests optimistic concurrency plus staged verify/promote.
- `partial`: The answer identifies one intended flaw clearly, or gestures at both but misses the concrete database predicate or visibility-ordering impact.
- `incorrect`: The answer focuses on style, controller DTO shape, test breadth, or generic transaction advice without naming the lost update and pre-verification publish failures.
