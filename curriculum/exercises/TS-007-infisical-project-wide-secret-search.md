# TS-007: Infisical Project-Wide Secret Search

## Metadata

- `id`: TS-007
- `source_repo`: [Infisical/infisical](https://github.com/Infisical/infisical)
- `repo_area`: secret manager API, project environments, folder paths, encrypted secret values, audit/telemetry
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 680
- `flaw_count`: 2

## PR Description Shown To Learner

This PR adds project-wide secret search to Infisical's V4 secrets API.

Today users need to know the environment and path before listing secrets. For larger projects this makes it hard to find where a secret is defined. The new endpoint lets a user search by key, value, or comment across all environments and secret paths in a project.

The route returns matching secret keys, environment slugs, secret paths, and optional values when `viewSecretValue=true`. It also adds a small audit event and test coverage for project-wide search.

## Existing Code Context

The real Infisical codebase already has these relevant contracts:

- `backend/src/server/routes/v4/secret-router.ts` lists secrets with explicit `projectId`, `environment`, and `secretPath`.
- `backend/src/services/secret/secret-service.ts` exposes the existing `getSecretsRaw` path and gets project permission with `permissionService.getProjectPermission`.
- `backend/src/services/secret/secret-service.ts` checks secret read permission with `throwIfMissingSecretReadValueOrDescribePermission(permission, ReadValue, { environment, secretPath })`.
- `backend/src/services/secret/secret-service.ts` can hide values based on `hasSecretReadValueOrDescribePermission`.
- `backend/src/services/secret/secret-dal.ts` reads encrypted secrets by folder id; the service decrypts through project bot keys.
- `backend/src/ee/services/permission/project-permission.ts` models secret actions against `ProjectPermissionSub.Secrets` with `{ environment, secretPath }` subject fields.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `backend/src/server/routes/v4/index.ts`
- `backend/src/server/routes/v4/secret-search-router.ts`
- `backend/src/services/secret-search/secret-search-types.ts`
- `backend/src/services/secret-search/secret-search-dal.ts`
- `backend/src/services/secret-search/secret-search-service.ts`
- `backend/src/services/secret-search/secret-search-service.test.ts`
- `backend/src/services/index.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally focused on the relevant backend changes and is over the 500-line threshold.

## Diff

```diff
diff --git a/backend/src/server/routes/v4/index.ts b/backend/src/server/routes/v4/index.ts
index 450b882a1..c9dc8dba4 100644
--- a/backend/src/server/routes/v4/index.ts
+++ b/backend/src/server/routes/v4/index.ts
@@ -1,7 +1,9 @@
 import { registerSecretRouter } from "./secret-router";
+import { registerSecretSearchRouter } from "./secret-search-router";
 
 export const registerV4Routes = async (server: FastifyZodProvider) => {
+  await server.register(registerSecretSearchRouter, { prefix: "/secrets/search" });
   await server.register(registerSecretRouter, { prefix: "/secrets" });
 };
diff --git a/backend/src/server/routes/v4/secret-search-router.ts b/backend/src/server/routes/v4/secret-search-router.ts
new file mode 100644
index 000000000..9771ce321
--- /dev/null
+++ b/backend/src/server/routes/v4/secret-search-router.ts
@@ -0,0 +1,154 @@
+import { z } from "zod";
+
+import { EventType } from "@app/ee/services/audit-log/audit-log-types";
+import { ApiDocsTags, RAW_SECRETS } from "@app/lib/api-docs";
+import { BadRequestError } from "@app/lib/errors";
+import { secretsLimit } from "@app/server/config/rateLimiter";
+import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
+import { ActorType, AuthMode } from "@app/services/auth/auth-type";
+import { SecretSearchMode } from "@app/services/secret-search/secret-search-types";
+
+const convertStringBoolean = (defaultValue: boolean = false) => {
+  return z
+    .enum(["true", "false"])
+    .default(defaultValue ? "true" : "false")
+    .transform((value) => value === "true");
+};
+
+const SearchSecretsQuerySchema = z.object({
+  projectId: z.string().trim().describe(RAW_SECRETS.LIST.projectId),
+  query: z.string().trim().min(2).max(128),
+  mode: z
+    .nativeEnum(SecretSearchMode)
+    .default(SecretSearchMode.Key)
+    .describe("Search by key, value, comment, or all supported fields"),
+  environments: z
+    .string()
+    .optional()
+    .transform((value) =>
+      value
+        ? value
+            .split(",")
+            .map((environment) => environment.trim())
+            .filter(Boolean)
+        : undefined,
+    ),
+  secretPath: z.string().trim().default("/"),
+  includeImports: convertStringBoolean(false),
+  viewSecretValue: convertStringBoolean(false),
+  limit: z.coerce.number().int().min(1).max(100).default(25),
+});
+
+export const registerSecretSearchRouter = async (server: FastifyZodProvider) => {
+  server.route({
+    method: "GET",
+    url: "/",
+    config: {
+      rateLimit: secretsLimit,
+    },
+    schema: {
+      hide: false,
+      operationId: "searchSecretsV4",
+      tags: [ApiDocsTags.Secrets],
+      description: "Search secrets across a project",
+      security: [
+        {
+          bearerAuth: [],
+        },
+      ],
+      querystring: SearchSecretsQuerySchema,
+      response: {
+        200: z.object({
+          matches: z.array(
+            z.object({
+              secretId: z.string(),
+              secretKey: z.string(),
+              secretValue: z.string().optional(),
+              secretComment: z.string().optional(),
+              environment: z.string(),
+              secretPath: z.string(),
+              score: z.number(),
+            }),
+          ),
+        }),
+      },
+    },
+    onRequest: verifyAuth([AuthMode.JWT, AuthMode.SERVICE_TOKEN, AuthMode.IDENTITY_ACCESS_TOKEN]),
+    handler: async (req) => {
+      const { projectId, query, mode, environments, secretPath, includeImports, viewSecretValue, limit } = req.query;
+
+      if (!projectId) {
+        throw new BadRequestError({ message: "Missing project id" });
+      }
+
+      const matches = await server.services.secretSearch.searchSecrets({
+        actorId: req.permission.id,
+        actor: req.permission.type,
+        actorOrgId: req.permission.orgId,
+        actorAuthMethod: req.permission.authMethod,
+        projectId,
+        query,
+        mode,
+        environments,
+        secretPath,
+        includeImports,
+        viewSecretValue,
+        limit,
+      });
+
+      await server.services.auditLog.createAuditLog({
+        projectId,
+        ...req.auditLogInfo,
+        event: {
+          type: EventType.GET_SECRETS,
+          metadata: {
+            query,
+            mode,
+            environments: environments ?? ["*"],
+            secretPath,
+            resultCount: matches.length,
+          },
+        },
+      });
+
+      await server.services.telemetry.sendPostHogEvents({
+        event: "Secret Searched",
+        distinctId: req.permission.id,
+        organizationId: req.permission.orgId,
+        properties: {
+          projectId,
+          mode,
+          resultCount: matches.length,
+          actorType: req.permission.type,
+          actor: req.auth.actor === ActorType.USER ? "user" : "machine",
+        },
+      });
+
+      return { matches };
+    },
+  });
+};
diff --git a/backend/src/services/secret-search/secret-search-types.ts b/backend/src/services/secret-search/secret-search-types.ts
new file mode 100644
index 000000000..22ae31ce2
--- /dev/null
+++ b/backend/src/services/secret-search/secret-search-types.ts
@@ -0,0 +1,106 @@
+import { TProjectPermission } from "@app/lib/types";
+import { ActorAuthMethod, ActorType } from "@app/services/auth/auth-type";
+
+export enum SecretSearchMode {
+  Key = "key",
+  Value = "value",
+  Comment = "comment",
+  All = "all",
+}
+
+export type TSecretSearchDTO = {
+  projectId: string;
+  query: string;
+  mode: SecretSearchMode;
+  environments?: string[];
+  secretPath: string;
+  includeImports: boolean;
+  viewSecretValue: boolean;
+  limit: number;
+  actor: ActorType;
+  actorId: string;
+  actorOrgId: string;
+  actorAuthMethod: ActorAuthMethod;
+};
+
+export type TSecretSearchRow = {
+  secretId: string;
+  folderId: string;
+  projectId: string;
+  environment: string;
+  secretPath: string;
+  secretKeyCiphertext: string;
+  secretKeyIV: string;
+  secretKeyTag: string;
+  secretValueCiphertext: string;
+  secretValueIV: string;
+  secretValueTag: string;
+  secretCommentCiphertext?: string | null;
+  secretCommentIV?: string | null;
+  secretCommentTag?: string | null;
+};
+
+export type TSecretSearchMatch = {
+  secretId: string;
+  secretKey: string;
+  secretValue?: string;
+  secretComment?: string;
+  environment: string;
+  secretPath: string;
+  score: number;
+};
+
+export type TSecretSearchPermission = Pick<
+  TProjectPermission,
+  "actor" | "actorId" | "actorOrgId" | "actorAuthMethod" | "projectId"
+>;
diff --git a/backend/src/services/secret-search/secret-search-dal.ts b/backend/src/services/secret-search/secret-search-dal.ts
new file mode 100644
index 000000000..507ea0c82
--- /dev/null
+++ b/backend/src/services/secret-search/secret-search-dal.ts
@@ -0,0 +1,156 @@
+import { Knex } from "knex";
+
+import { TDbClient } from "@app/db";
+import { TableName } from "@app/db/schemas";
+import { DatabaseError } from "@app/lib/errors";
+import { selectAllTableCols } from "@app/lib/knex";
+
+import { TSecretSearchRow } from "./secret-search-types";
+
+export type TSecretSearchDALFactory = ReturnType<typeof secretSearchDALFactory>;
+
+export const secretSearchDALFactory = (db: TDbClient) => {
+  const findProjectSecretRows = async ({
+    projectId,
+    environments,
+    secretPath,
+    limit,
+    tx,
+  }: {
+    projectId: string;
+    environments?: string[];
+    secretPath: string;
+    limit: number;
+    tx?: Knex;
+  }): Promise<TSecretSearchRow[]> => {
+    try {
+      const query = (tx || db.replicaNode())(TableName.Secret)
+        .join(TableName.SecretFolder, `${TableName.Secret}.folderId`, `${TableName.SecretFolder}.id`)
+        .join(TableName.Environment, `${TableName.SecretFolder}.envId`, `${TableName.Environment}.id`)
+        .where(`${TableName.Environment}.projectId`, projectId)
+        .andWhere(`${TableName.SecretFolder}.path`, "like", `${secretPath}%`)
+        .select({
+          secretId: `${TableName.Secret}.id`,
+          folderId: `${TableName.Secret}.folderId`,
+          projectId: `${TableName.Environment}.projectId`,
+          environment: `${TableName.Environment}.slug`,
+          secretPath: `${TableName.SecretFolder}.path`,
+          secretKeyCiphertext: `${TableName.Secret}.secretKeyCiphertext`,
+          secretKeyIV: `${TableName.Secret}.secretKeyIV`,
+          secretKeyTag: `${TableName.Secret}.secretKeyTag`,
+          secretValueCiphertext: `${TableName.Secret}.secretValueCiphertext`,
+          secretValueIV: `${TableName.Secret}.secretValueIV`,
+          secretValueTag: `${TableName.Secret}.secretValueTag`,
+          secretCommentCiphertext: `${TableName.Secret}.secretCommentCiphertext`,
+          secretCommentIV: `${TableName.Secret}.secretCommentIV`,
+          secretCommentTag: `${TableName.Secret}.secretCommentTag`,
+        })
+        .limit(limit * 50);
+
+      if (environments?.length) {
+        void query.whereIn(`${TableName.Environment}.slug`, environments);
+      }
+
+      return await query;
+    } catch (error) {
+      throw new DatabaseError({ error, name: "find project secret search rows" });
+    }
+  };
+
+  const findImportedSecretRows = async ({
+    projectId,
+    environments,
+    secretPath,
+    limit,
+    tx,
+  }: {
+    projectId: string;
+    environments?: string[];
+    secretPath: string;
+    limit: number;
+    tx?: Knex;
+  }): Promise<TSecretSearchRow[]> => {
+    try {
+      const query = (tx || db.replicaNode())(TableName.SecretImport)
+        .join(TableName.SecretFolder, `${TableName.SecretImport}.folderId`, `${TableName.SecretFolder}.id`)
+        .join(TableName.Environment, `${TableName.SecretFolder}.envId`, `${TableName.Environment}.id`)
+        .join(
+          { sourceFolder: TableName.SecretFolder },
+          `${TableName.SecretImport}.importFolderId`,
+          "sourceFolder.id",
+        )
+        .join({ sourceEnv: TableName.Environment }, "sourceFolder.envId", "sourceEnv.id")
+        .join(TableName.Secret, `${TableName.Secret}.folderId`, "sourceFolder.id")
+        .where(`${TableName.Environment}.projectId`, projectId)
+        .andWhere(`${TableName.SecretFolder}.path`, "like", `${secretPath}%`)
+        .select({
+          secretId: `${TableName.Secret}.id`,
+          folderId: `${TableName.Secret}.folderId`,
+          projectId: "sourceEnv.projectId",
+          environment: "sourceEnv.slug",
+          secretPath: "sourceFolder.path",
+          secretKeyCiphertext: `${TableName.Secret}.secretKeyCiphertext`,
+          secretKeyIV: `${TableName.Secret}.secretKeyIV`,
+          secretKeyTag: `${TableName.Secret}.secretKeyTag`,
+          secretValueCiphertext: `${TableName.Secret}.secretValueCiphertext`,
+          secretValueIV: `${TableName.Secret}.secretValueIV`,
+          secretValueTag: `${TableName.Secret}.secretValueTag`,
+          secretCommentCiphertext: `${TableName.Secret}.secretCommentCiphertext`,
+          secretCommentIV: `${TableName.Secret}.secretCommentIV`,
+          secretCommentTag: `${TableName.Secret}.secretCommentTag`,
+        })
+        .limit(limit * 50);
+
+      if (environments?.length) {
+        void query.whereIn("sourceEnv.slug", environments);
+      }
+
+      return await query;
+    } catch (error) {
+      throw new DatabaseError({ error, name: "find imported secret search rows" });
+    }
+  };
+
+  return {
+    findProjectSecretRows,
+    findImportedSecretRows,
+  };
+};
diff --git a/backend/src/services/secret-search/secret-search-service.ts b/backend/src/services/secret-search/secret-search-service.ts
new file mode 100644
index 000000000..50d8eb373
--- /dev/null
+++ b/backend/src/services/secret-search/secret-search-service.ts
@@ -0,0 +1,220 @@
+import { ForbiddenError, subject } from "@casl/ability";
+
+import { ActionProjectType } from "@app/db/schemas";
+import { ProjectPermissionActions, ProjectPermissionSub } from "@app/ee/services/permission/project-permission";
+import { TPermissionServiceFactory } from "@app/ee/services/permission/permission-service-types";
+import { logger } from "@app/lib/logger";
+import { crypto } from "@app/lib/crypto/cryptography";
+import { SymmetricKeySize } from "@app/lib/crypto";
+import { NotFoundError } from "@app/lib/errors";
+import { TProjectBotServiceFactory } from "@app/services/project-bot/project-bot-service";
+
+import { TSecretSearchDALFactory } from "./secret-search-dal";
+import {
+  SecretSearchMode,
+  TSecretSearchDTO,
+  TSecretSearchMatch,
+  TSecretSearchRow,
+} from "./secret-search-types";
+
+type TSecretSearchServiceFactoryDep = {
+  secretSearchDAL: TSecretSearchDALFactory;
+  permissionService: Pick<TPermissionServiceFactory, "getProjectPermission">;
+  projectBotService: Pick<TProjectBotServiceFactory, "getBotKey">;
+};
+
+export type TSecretSearchServiceFactory = ReturnType<typeof secretSearchServiceFactory>;
+
+const decryptField = ({
+  ciphertext,
+  iv,
+  tag,
+  key,
+}: {
+  ciphertext?: string | null;
+  iv?: string | null;
+  tag?: string | null;
+  key: string;
+}) => {
+  if (!ciphertext || !iv || !tag) return "";
+  return crypto.encryption().symmetric().decrypt({
+    ciphertext,
+    iv,
+    tag,
+    key,
+    keySize: SymmetricKeySize.Bits128,
+  });
+};
+
+const scoreMatch = ({
+  row,
+  query,
+  mode,
+  botKey,
+}: {
+  row: TSecretSearchRow;
+  query: string;
+  mode: SecretSearchMode;
+  botKey: string;
+}) => {
+  const secretKey = decryptField({
+    ciphertext: row.secretKeyCiphertext,
+    iv: row.secretKeyIV,
+    tag: row.secretKeyTag,
+    key: botKey,
+  });
+  const secretValue = decryptField({
+    ciphertext: row.secretValueCiphertext,
+    iv: row.secretValueIV,
+    tag: row.secretValueTag,
+    key: botKey,
+  });
+  const secretComment = decryptField({
+    ciphertext: row.secretCommentCiphertext,
+    iv: row.secretCommentIV,
+    tag: row.secretCommentTag,
+    key: botKey,
+  });
+
+  const lowerQuery = query.toLowerCase();
+  let score = 0;
+
+  if (
+    (mode === SecretSearchMode.Key || mode === SecretSearchMode.All) &&
+    secretKey.toLowerCase().includes(lowerQuery)
+  ) {
+    score += secretKey.toLowerCase() === lowerQuery ? 100 : 25;
+  }
+
+  if (
+    (mode === SecretSearchMode.Value || mode === SecretSearchMode.All) &&
+    secretValue.toLowerCase().includes(lowerQuery)
+  ) {
+    score += 10;
+  }
+
+  if (
+    (mode === SecretSearchMode.Comment || mode === SecretSearchMode.All) &&
+    secretComment.toLowerCase().includes(lowerQuery)
+  ) {
+    score += 5;
+  }
+
+  return {
+    score,
+    secretKey,
+    secretValue,
+    secretComment,
+  };
+};
+
+const toMatch = ({
+  row,
+  score,
+  secretKey,
+  secretValue,
+  secretComment,
+  viewSecretValue,
+}: {
+  row: TSecretSearchRow;
+  score: number;
+  secretKey: string;
+  secretValue: string;
+  secretComment: string;
+  viewSecretValue: boolean;
+}): TSecretSearchMatch => ({
+  secretId: row.secretId,
+  secretKey,
+  secretValue: viewSecretValue ? secretValue : undefined,
+  secretComment,
+  environment: row.environment,
+  secretPath: row.secretPath,
+  score,
+});
+
+export const secretSearchServiceFactory = ({
+  secretSearchDAL,
+  permissionService,
+  projectBotService,
+}: TSecretSearchServiceFactoryDep) => {
+  const searchSecrets = async ({
+    actor,
+    actorId,
+    actorOrgId,
+    actorAuthMethod,
+    projectId,
+    query,
+    mode,
+    environments,
+    secretPath,
+    includeImports,
+    viewSecretValue,
+    limit,
+  }: TSecretSearchDTO) => {
+    const { permission } = await permissionService.getProjectPermission({
+      actor,
+      actorId,
+      projectId,
+      actorAuthMethod,
+      actorOrgId,
+      actionProjectType: ActionProjectType.SecretManager,
+    });
+
+    ForbiddenError.from(permission).throwUnlessCan(
+      ProjectPermissionActions.Read,
+      ProjectPermissionSub.Project,
+    );
+
+    const { botKey } = await projectBotService.getBotKey(projectId);
+    if (!botKey) {
+      throw new NotFoundError({
+        message: `Project bot for project with ID '${projectId}' not found`,
+        name: "ProjectBotNotFound",
+      });
+    }
+
+    const directRows = await secretSearchDAL.findProjectSecretRows({
+      projectId,
+      environments,
+      secretPath,
+      limit,
+    });
+
+    const importedRows = includeImports
+      ? await secretSearchDAL.findImportedSecretRows({
+          projectId,
+          environments,
+          secretPath,
+          limit,
+        })
+      : [];
+
+    const candidateRows = [...directRows, ...importedRows];
+    const matches: TSecretSearchMatch[] = [];
+
+    for (const row of candidateRows) {
+      const scored = scoreMatch({
+        row,
+        query,
+        mode,
+        botKey,
+      });
+
+      if (scored.score === 0) continue;
+
+      logger.info("secret_search_match", {
+        projectId,
+        query,
+        mode,
+        secretId: row.secretId,
+        environment: row.environment,
+        secretPath: row.secretPath,
+        secretKey: scored.secretKey,
+        secretValue: scored.secretValue,
+        secretComment: scored.secretComment,
+      });
+
+      matches.push(
+        toMatch({
+          row,
+          score: scored.score,
+          secretKey: scored.secretKey,
+          secretValue: scored.secretValue,
+          secretComment: scored.secretComment,
+          viewSecretValue,
+        }),
+      );
+    }
+
+    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
+  };
+
+  return {
+    searchSecrets,
+  };
+};
diff --git a/backend/src/services/index.ts b/backend/src/services/index.ts
index 15ff1be71..3539aae29 100644
--- a/backend/src/services/index.ts
+++ b/backend/src/services/index.ts
@@ -21,6 +21,8 @@ import { secretServiceFactory } from "./secret/secret-service";
 import { secretDALFactory } from "./secret/secret-dal";
 import { secretVersionDALFactory } from "./secret/secret-version-dal";
 import { secretQueueFactory } from "./secret/secret-queue";
+import { secretSearchDALFactory } from "./secret-search/secret-search-dal";
+import { secretSearchServiceFactory } from "./secret-search/secret-search-service";
 
 export const buildServices = (deps: TBuildServiceDeps) => {
   const secretDAL = secretDALFactory(deps.db);
@@ -82,6 +84,7 @@ export const buildServices = (deps: TBuildServiceDeps) => {
     secretDAL,
     secretVersionDAL,
     secretQueueService,
+    secretSearchDAL: secretSearchDALFactory(deps.db),
   };
 
   const services = {
@@ -177,6 +180,11 @@ export const buildServices = (deps: TBuildServiceDeps) => {
       secretApprovalRequestDAL: dals.secretApprovalRequestDAL,
       secretApprovalRequestSecretDAL: dals.secretApprovalRequestSecretDAL,
     }),
+    secretSearch: secretSearchServiceFactory({
+      secretSearchDAL: dals.secretSearchDAL,
+      permissionService: services.permission,
+      projectBotService: services.projectBot,
+    }),
   };
 
   return services;
diff --git a/backend/src/services/secret-search/secret-search-service.test.ts b/backend/src/services/secret-search/secret-search-service.test.ts
new file mode 100644
index 000000000..3f59ace11
--- /dev/null
+++ b/backend/src/services/secret-search/secret-search-service.test.ts
@@ -0,0 +1,164 @@
+import { subject } from "@casl/ability";
+import { describe, expect, it, vi, beforeEach } from "vitest";
+
+import { buildProjectPermission } from "@app/ee/services/permission/project-permission-factory";
+import {
+  ProjectPermissionActions,
+  ProjectPermissionSub,
+} from "@app/ee/services/permission/project-permission";
+import { ActorAuthMethod, ActorType } from "@app/services/auth/auth-type";
+
+import { secretSearchServiceFactory } from "./secret-search-service";
+import { SecretSearchMode } from "./secret-search-types";
+
+const encrypt = (value: string) => ({
+  ciphertext: `encrypted:${value}`,
+  iv: "iv",
+  tag: "tag",
+});
+
+vi.mock("@app/lib/crypto/cryptography", () => ({
+  crypto: {
+    encryption: () => ({
+      symmetric: () => ({
+        decrypt: ({ ciphertext }: { ciphertext: string }) => ciphertext.replace("encrypted:", ""),
+      }),
+    }),
+  },
+}));
+
+const permission = buildProjectPermission([
+  {
+    action: [ProjectPermissionActions.Read],
+    subject: ProjectPermissionSub.Project,
+  },
+]);
+
+const service = () =>
+  secretSearchServiceFactory({
+    secretSearchDAL: {
+      findProjectSecretRows: vi.fn().mockResolvedValue([
+        {
+          secretId: "secret-1",
+          folderId: "folder-1",
+          projectId: "project-1",
+          environment: "prod",
+          secretPath: "/payments",
+          secretKeyCiphertext: encrypt("STRIPE_API_KEY").ciphertext,
+          secretKeyIV: "iv",
+          secretKeyTag: "tag",
+          secretValueCiphertext: encrypt("sk_live_secret").ciphertext,
+          secretValueIV: "iv",
+          secretValueTag: "tag",
+          secretCommentCiphertext: encrypt("live payment key").ciphertext,
+          secretCommentIV: "iv",
+          secretCommentTag: "tag",
+        },
+      ]),
+      findImportedSecretRows: vi.fn().mockResolvedValue([]),
+    },
+    permissionService: {
+      getProjectPermission: vi.fn().mockResolvedValue({ permission }),
+    },
+    projectBotService: {
+      getBotKey: vi.fn().mockResolvedValue({ botKey: "bot-key" }),
+    },
+  });
+
+describe("secretSearchService", () => {
+  beforeEach(() => {
+    vi.clearAllMocks();
+  });
+
+  it("searches project secrets by key", async () => {
+    const svc = service();
+    const result = await svc.searchSecrets({
+      actor: ActorType.USER,
+      actorId: "user-1",
+      actorOrgId: "org-1",
+      actorAuthMethod: ActorAuthMethod.JWT,
+      projectId: "project-1",
+      query: "stripe",
+      mode: SecretSearchMode.All,
+      secretPath: "/",
+      includeImports: false,
+      viewSecretValue: false,
+      limit: 20,
+    });
+
+    expect(result).toHaveLength(1);
+    expect(result[0]?.secretKey).toBe("STRIPE_API_KEY");
+    expect(result[0]?.secretValue).toBeUndefined();
+  });
+
+  it("returns values when requested", async () => {
+    const svc = service();
+    const result = await svc.searchSecrets({
+      actor: ActorType.USER,
+      actorId: "user-1",
+      actorOrgId: "org-1",
+      actorAuthMethod: ActorAuthMethod.JWT,
+      projectId: "project-1",
+      query: "sk_live",
+      mode: SecretSearchMode.Value,
+      environments: ["prod"],
+      secretPath: "/payments",
+      includeImports: false,
+      viewSecretValue: true,
+      limit: 20,
+    });
+
+    expect(result[0]?.secretValue).toBe("sk_live_secret");
+  });
+});
```

## Intended Flaws

### Flaw 1: Project-wide search bypasses environment and path-scoped secret permissions

- `type`: `permission_bypass`
- `location`: `backend/src/services/secret-search/secret-search-service.ts:128-145`, `:147-166`, `backend/src/services/secret-search/secret-search-dal.ts:21-52`
- `learner_prompt`: Does the new search service prove that the actor can read each matched secret in its actual environment and secret path?

Expected answer:

- Identify: The service only checks `ProjectPermissionActions.Read` on `ProjectPermissionSub.Project`. Existing secret reads check secret permissions against `ProjectPermissionSub.Secrets` with `{ environment, secretPath }`. The new DAL then fetches rows across project environments and paths, and the service decrypts/searches them without per-row `ReadValue` or `DescribeSecret` permission checks.
- Impact: A user or identity with limited access to one environment/path can search secrets in another environment/path. Even if `viewSecretValue=false`, key names, comments, paths, environments, and whether a value matched the query can leak. With `viewSecretValue=true`, the endpoint can return secret values the actor should never be able to read.
- Fix direction: Search should be scoped to authorized folders/environments before decryption. Either require explicit `environment` and `secretPath` and reuse `getSecretsRaw`, or build an authorized folder set by applying `hasSecretReadValueOrDescribePermission(permission, ReadValue/DescribeSecret, { environment, secretPath })` per candidate path before decrypting. `viewSecretValue=true` must require `ReadValue`; key-only results may be allowed with `DescribeSecret` only.

Hints:

1. Compare this service's permission check to the existing V4 list secrets route in `backend/src/server/routes/v4/secret-router.ts` and the `getSecretsRaw` path in `backend/src/services/secret/secret-service.ts`.
2. Secret permissions in Infisical are not just project-level; they include environment and secret path subject fields.
3. The dangerous line is where `ProjectPermissionActions.Read` on `ProjectPermissionSub.Project` is treated as enough before decrypting every candidate row.

### Flaw 2: Matched plaintext secrets are written to logs

- `type`: `observability_gap`
- `location`: `backend/src/services/secret-search/secret-search-service.ts:181-194`
- `learner_prompt`: Are logs/telemetry safe for a feature that decrypts and searches secret values?

Expected answer:

- Identify: The service logs `secretKey`, `secretValue`, and `secretComment` for every match. Those fields are decrypted plaintext.
- Impact: Secrets can leak into application logs, log drains, observability vendors, support bundles, or incident exports. This defeats the purpose of encrypted secret storage and massively expands the blast radius of one search request.
- Fix direction: Never log plaintext secret values or comments. Use redacted structured logs with project id, actor id/type, result count, mode, and maybe hash/truncated non-sensitive identifiers. If a matched field must be tracked, log only an enum like `matchedField: "value"` and count. Audit logs should also avoid the raw search query if users may search for a secret value; store a hash or omit it.

Hints:

1. Search features tend to put the user's query and matched fields into debug logs. That is dangerous here.
2. Follow the decrypted `scored` object after `scoreMatch`.
3. The logger call includes `secretValue: scored.secretValue`.

## Final Expert Debrief

### Product-level change

The PR is trying to make secret discovery easier in large projects by letting a user search across environments and paths. The product need is real: people often know `STRIPE` or `DATABASE_URL` but not where the secret lives.

### Changed contracts

- Public API contract: a new project-wide search endpoint can inspect secret keys, values, and comments.
- Permission contract: the route changes secret access from environment/path-scoped reads to a broad project-level operation.
- Data confidentiality contract: encrypted values are decrypted during search and can be returned or logged.
- Audit/telemetry contract: searches become a new high-sensitivity event type.

### Failure modes

- A developer with access to `dev` can infer or read `prod` secrets.
- Service tokens with narrow scopes can discover secrets outside their intended scope.
- A user can search for `sk_live` and learn whether production payment keys exist even when values are hidden.
- Plaintext secret values and comments land in logs and external observability systems.
- Tests pass because they assert happy-path search and do not create a permission with access to only one environment/path.

### Reviewer thought process

A strong reviewer starts with the operation the product is enabling: search turns many secret rows into candidates before a human chooses one. That is very different from reading a known secret. The natural review path is to ask which existing permission dimensions narrow a normal secret read, then verify the search pipeline applies those same dimensions before decrypting, matching, returning, or logging anything.

The second question is: "Where does plaintext exist after decryption?" In secret-management systems, plaintext should have the smallest possible lifetime and audience. The logger call is a bigger problem than missing polish because logs are often copied, indexed, retained, and accessed by more people than the production database.

### Better implementation direction

- Make search default to one explicit environment and path, matching `GET /v4/secrets`.
- For project-wide search, first compute authorized folders/environments for the actor and action.
- Support separate result modes: `DescribeSecret` can reveal key/path metadata, `ReadValue` is required to search or return values.
- Never decrypt rows that are outside the actor's authorized scope.
- Avoid logging raw queries if query may contain secret values.
- Log redacted counts and high-level search mode only.
- Add tests for a user with access to `dev:/app` but not `prod:/app`.
- Add tests proving `viewSecretValue=true` requires `ReadValue`, not just project read.

## Correctness Verdict Rubric

The learner is correct on flaw 1 if they mention all three:

- the PR checks broad project read instead of secret read/describe permission,
- environment and path-scoped permissions are bypassed,
- the fix is authorized folder/environment filtering before decrypting/searching.

The learner is correct on flaw 2 if they mention all three:

- plaintext decrypted secret fields are logged,
- logs/telemetry become a secret exfiltration surface,
- the fix is strict redaction and non-sensitive audit metadata.

## Why This Case Exists

This case trains a fundamental review instinct: a useful product feature can still be unacceptable if it changes the permission boundary. "Search everything" is almost always a security-sensitive phrase. The reviewer should learn to follow authorization and plaintext lifetime, not just whether the route returns the right shape.
