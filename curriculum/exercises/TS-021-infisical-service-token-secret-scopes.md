# TS-021: Infisical Service Token Secret Scopes

## Metadata

- `id`: TS-021
- `source_repo`: [Infisical/infisical](https://github.com/Infisical/infisical)
- `repo_area`: service tokens, secret manager API, CASL project permissions, path/environment scopes, secret read services, audit coverage
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 950-1,200
- `represented_diff_lines`: 1,123
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about auth boundaries, service-token scopes, route/service layering, wildcard semantics, secret imports, and permission tests without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds normalized resource scopes for Infisical service tokens.

Service tokens already support `read` and `write` permissions over `{ environment, secretPath }` scopes, but customers want to create tokens that are easier to audit and reason about. This change adds an explicit service-token scope service, persists a normalized scope document, and applies the new scope checks to V3/V4 secret-read endpoints.

The PR adds:

- a migration for normalized service-token resource scopes,
- a service-token scope matcher,
- route checks for V3 and V4 secret reads,
- a service helper for reading secrets by service token,
- audit metadata for allowed resource scopes,
- e2e coverage for env/path wildcard reads.

## Existing Code Context

The real Infisical codebase already has these relevant contracts:

- `backend/src/db/schemas/models.ts` defines `ServiceTokenScopes` as an array of `{ environment, secretPath }`.
- `backend/src/services/service-token/service-token-service.ts` creates service tokens after validating that the creator's project permission boundary covers the requested scopes.
- `backend/src/ee/services/permission/project-permission.ts` builds a CASL ability for service tokens with `$glob` over `secretPath` and an exact `environment` condition.
- `backend/src/server/routes/v3/deprecated-secret-router.ts` and `backend/src/server/routes/v4/secret-router.ts` accept `AuthMode.SERVICE_TOKEN` for secret reads, parse `req.auth.serviceToken.scopes`, and pass `req.permission` into the secret service.
- `backend/src/services/secret/secret-service.ts` and `backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts` call `permissionService.getProjectPermission` and then enforce secret read permissions inside the service layer.
- `backend/e2e-test/routes/v2/service-token.spec.ts` already covers a service token scoped to `/` being denied access to `/nested/deep`, and a token scoped to one environment being denied access to another environment.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `backend/src/db/migrations/20260516092100_add_service_token_resource_scopes.ts`
- `backend/src/services/service-token/service-token-scope-types.ts`
- `backend/src/services/service-token/service-token-scope-service.ts`
- `backend/src/services/service-token/service-token-service.ts`
- `backend/src/services/secret/secret-service.ts`
- `backend/src/server/routes/v4/secret-router.ts`
- `backend/src/server/routes/v3/deprecated-secret-router.ts`
- `backend/e2e-test/routes/v2/service-token-resource-scopes.spec.ts`

The line references below use synthetic PR line numbers. The represented diff focuses on the auth boundary, service-layer contract, wildcard matching rules, and tests.

## Diff

```diff
diff --git a/backend/src/db/migrations/20260516092100_add_service_token_resource_scopes.ts b/backend/src/db/migrations/20260516092100_add_service_token_resource_scopes.ts
new file mode 100644
index 000000000..e04cfc7bf
--- /dev/null
+++ b/backend/src/db/migrations/20260516092100_add_service_token_resource_scopes.ts
@@ -0,0 +1,78 @@
+import { Knex } from "knex";
+
+import { TableName } from "../schemas";
+
+const TABLE = "service_token_resource_scopes";
+
+export async function up(knex: Knex): Promise<void> {
+  const exists = await knex.schema.hasTable(TABLE);
+  if (exists) {
+    return;
+  }
+
+  await knex.schema.createTable(TABLE, (table) => {
+    table.uuid("id", { primaryKey: true }).defaultTo(knex.fn.uuid());
+    table.uuid("serviceTokenId").notNullable();
+    table.uuid("projectId").notNullable();
+    table.string("resource").notNullable();
+    table.string("action").notNullable();
+    table.string("environment").notNullable();
+    table.string("secretPath").notNullable().defaultTo("/");
+    table.boolean("includeImports").notNullable().defaultTo(false);
+    table.boolean("recursive").notNullable().defaultTo(false);
+    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());
+    table.timestamp("updatedAt").notNullable().defaultTo(knex.fn.now());
+
+    table
+      .foreign("serviceTokenId")
+      .references("id")
+      .inTable(TableName.ServiceToken)
+      .onDelete("CASCADE");
+    table.foreign("projectId").references("id").inTable(TableName.Project).onDelete("CASCADE");
+    table.index(["serviceTokenId", "resource", "action"]);
+    table.index(["projectId", "environment"]);
+  });
+
+  await knex.raw(`
+    INSERT INTO service_token_resource_scopes (
+      "serviceTokenId",
+      "projectId",
+      "resource",
+      "action",
+      "environment",
+      "secretPath",
+      "includeImports",
+      "recursive"
+    )
+    SELECT
+      st.id,
+      st."projectId",
+      'secrets',
+      CASE
+        WHEN st.permissions ? 'read' THEN 'read'
+        ELSE 'write'
+      END,
+      COALESCE(scope_item ->> 'environment', '*'),
+      COALESCE(scope_item ->> 'secretPath', '/**'),
+      false,
+      false
+    FROM service_tokens st
+    CROSS JOIN LATERAL jsonb_array_elements(st.scopes::jsonb) AS scope_item
+    WHERE st.scopes IS NOT NULL
+  `);
+}
+
+export async function down(knex: Knex): Promise<void> {
+  await knex.schema.dropTableIfExists(TABLE);
+}
diff --git a/backend/src/services/service-token/service-token-scope-types.ts b/backend/src/services/service-token/service-token-scope-types.ts
new file mode 100644
index 000000000..9ca438dd2
--- /dev/null
+++ b/backend/src/services/service-token/service-token-scope-types.ts
@@ -0,0 +1,137 @@
+import { z } from "zod";
+
+import { ActorAuthMethod, ActorType } from "../auth/auth-type";
+
+export enum ServiceTokenResource {
+  Secrets = "secrets",
+  SecretImports = "secretImports",
+  SecretFolders = "secretFolders"
+}
+
+export enum ServiceTokenResourceAction {
+  Read = "read",
+  Write = "write",
+  Describe = "describe"
+}
+
+export const ServiceTokenResourceScopeSchema = z.object({
+  resource: z.nativeEnum(ServiceTokenResource).default(ServiceTokenResource.Secrets),
+  action: z.nativeEnum(ServiceTokenResourceAction),
+  environment: z.string().trim().min(1).default("*"),
+  secretPath: z.string().trim().min(1).default("/**"),
+  includeImports: z.boolean().default(false),
+  recursive: z.boolean().default(false)
+});
+
+export const ServiceTokenResourceScopesSchema = z.array(ServiceTokenResourceScopeSchema).default([]);
+
+export type TServiceTokenResourceScope = z.infer<typeof ServiceTokenResourceScopeSchema>;
+
+export type TServiceTokenScopeActor = {
+  actorId: string;
+  actor: ActorType;
+  actorOrgId: string;
+  actorAuthMethod: ActorAuthMethod;
+};
+
+export type TSecretScopeTarget = {
+  projectId: string;
+  environment: string;
+  secretPath: string;
+  secretName?: string;
+  includeImports?: boolean;
+  recursive?: boolean;
+};
+
+export type TAssertServiceTokenSecretReadDTO = TServiceTokenScopeActor &
+  TSecretScopeTarget & {
+    scopes: TServiceTokenResourceScope[];
+  };
+
+export type TNormalizeLegacyScopeDTO = {
+  permissions: string[];
+  scopes: Array<{
+    environment: string;
+    secretPath?: string;
+  }>;
+};
+
+export type TServiceTokenScopeDAL = {
+  insertMany: (
+    serviceTokenId: string,
+    projectId: string,
+    scopes: TServiceTokenResourceScope[]
+  ) => Promise<void>;
+  findByServiceTokenId: (serviceTokenId: string) => Promise<TServiceTokenResourceScope[]>;
+  deleteByServiceTokenId: (serviceTokenId: string) => Promise<void>;
+};
+
+export class ServiceTokenScopeError extends Error {
+  public readonly statusCode = 403;
+  public readonly error = "PermissionDenied";
+
+  constructor(message: string) {
+    super(message);
+    this.name = "ServiceTokenScopeError";
+  }
+}
+
+export const normalizeSecretPathForServiceTokenScope = (input: string) => {
+  if (!input || input === ".") {
+    return "/";
+  }
+
+  const withLeadingSlash = input.startsWith("/") ? input : `/${input}`;
+  const withoutDuplicateSlashes = withLeadingSlash.replace(/\/{2,}/g, "/");
+  const trimmed = withoutDuplicateSlashes.length > 1 ? withoutDuplicateSlashes.replace(/\/$/g, "") : "/";
+  return trimmed || "/";
+};
+
+export const normalizeLegacyScopes = ({ permissions, scopes }: TNormalizeLegacyScopeDTO) => {
+  const actions = new Set<ServiceTokenResourceAction>();
+  if (permissions.includes("read")) {
+    actions.add(ServiceTokenResourceAction.Read);
+    actions.add(ServiceTokenResourceAction.Describe);
+  }
+  if (permissions.includes("write")) {
+    actions.add(ServiceTokenResourceAction.Write);
+  }
+
+  return scopes.flatMap((scope) =>
+    [...actions].map((action) => ({
+      resource: ServiceTokenResource.Secrets,
+      action,
+      environment: scope.environment || "*",
+      secretPath: normalizeSecretPathForServiceTokenScope(scope.secretPath ?? "/**"),
+      includeImports: false,
+      recursive: false
+    }))
+  );
+};
+
+export const scopeToAuditMetadata = (scope: TServiceTokenResourceScope) => ({
+  resource: scope.resource,
+  action: scope.action,
+  environment: scope.environment,
+  secretPath: scope.secretPath,
+  includeImports: scope.includeImports,
+  recursive: scope.recursive
+});
diff --git a/backend/src/services/service-token/service-token-scope-service.ts b/backend/src/services/service-token/service-token-scope-service.ts
new file mode 100644
index 000000000..d5df5d51e
--- /dev/null
+++ b/backend/src/services/service-token/service-token-scope-service.ts
@@ -0,0 +1,188 @@
+import picomatch from "picomatch";
+
+import { ForbiddenRequestError } from "@app/lib/errors";
+import { logger } from "@app/lib/logger";
+
+import { ActorType } from "../auth/auth-type";
+import {
+  normalizeLegacyScopes,
+  normalizeSecretPathForServiceTokenScope,
+  ServiceTokenResource,
+  ServiceTokenResourceAction,
+  ServiceTokenResourceScopesSchema,
+  ServiceTokenScopeError,
+  scopeToAuditMetadata,
+  TAssertServiceTokenSecretReadDTO,
+  TNormalizeLegacyScopeDTO,
+  TSecretScopeTarget,
+  TServiceTokenResourceScope,
+  TServiceTokenScopeDAL
+} from "./service-token-scope-types";
+
+type TServiceTokenScopeServiceFactoryDep = {
+  serviceTokenScopeDAL: TServiceTokenScopeDAL;
+};
+
+export type TServiceTokenScopeServiceFactory = ReturnType<typeof serviceTokenScopeServiceFactory>;
+
+const toMatcherInput = ({ environment, secretPath }: Pick<TSecretScopeTarget, "environment" | "secretPath">) => {
+  const normalizedPath = normalizeSecretPathForServiceTokenScope(secretPath);
+  return `${environment}:${normalizedPath}`;
+};
+
+const toMatcherPattern = (scope: TServiceTokenResourceScope) => {
+  const environment = scope.environment || "*";
+  const secretPath = normalizeSecretPathForServiceTokenScope(scope.secretPath || "/**");
+  return `${environment}:${secretPath}`;
+};
+
+const hasReadAction = (scope: TServiceTokenResourceScope) =>
+  scope.resource === ServiceTokenResource.Secrets &&
+  (scope.action === ServiceTokenResourceAction.Read || scope.action === ServiceTokenResourceAction.Describe);
+
+const matchesSecretReadScope = (scope: TServiceTokenResourceScope, target: TSecretScopeTarget) => {
+  if (!hasReadAction(scope)) {
+    return false;
+  }
+
+  if (target.includeImports && !scope.includeImports) {
+    return false;
+  }
+
+  if (target.recursive && !scope.recursive && !scope.secretPath.endsWith("/**")) {
+    return false;
+  }
+
+  const matcherInput = toMatcherInput(target);
+  const matcherPattern = toMatcherPattern(scope);
+
+  return picomatch.isMatch(matcherInput, matcherPattern, {
+    contains: true,
+    strictSlashes: false,
+    bash: true
+  });
+};
+
+const getAllowedScopes = (scopes: TServiceTokenResourceScope[], target: TSecretScopeTarget) =>
+  scopes.filter((scope) => matchesSecretReadScope(scope, target));
+
+export const serviceTokenScopeServiceFactory = ({ serviceTokenScopeDAL }: TServiceTokenScopeServiceFactoryDep) => {
+  const createScopesForServiceToken = async ({
+    serviceTokenId,
+    projectId,
+    permissions,
+    scopes
+  }: TNormalizeLegacyScopeDTO & {
+    serviceTokenId: string;
+    projectId: string;
+  }) => {
+    const normalized = normalizeLegacyScopes({ permissions, scopes });
+    if (!normalized.length) {
+      return [];
+    }
+
+    await serviceTokenScopeDAL.insertMany(serviceTokenId, projectId, normalized);
+    return normalized;
+  };
+
+  const getScopesForServiceToken = async (serviceTokenId: string) => {
+    const scopes = await serviceTokenScopeDAL.findByServiceTokenId(serviceTokenId);
+    return ServiceTokenResourceScopesSchema.parse(scopes);
+  };
+
+  const assertCanReadSecrets = async ({
+    actor,
+    actorId,
+    actorAuthMethod,
+    actorOrgId,
+    scopes,
+    ...target
+  }: TAssertServiceTokenSecretReadDTO) => {
+    if (actor !== ActorType.SERVICE) {
+      return {
+        allowed: true,
+        reason: "non-service-actor",
+        allowedScopes: [] as TServiceTokenResourceScope[]
+      };
+    }
+
+    const parsedScopes = ServiceTokenResourceScopesSchema.parse(scopes);
+    const allowedScopes = getAllowedScopes(parsedScopes, target);
+
+    if (!allowedScopes.length) {
+      logger.warn(
+        {
+          actorId,
+          actorAuthMethod,
+          actorOrgId,
+          projectId: target.projectId,
+          environment: target.environment,
+          secretPath: target.secretPath
+        },
+        "Service token denied by resource scope"
+      );
+      throw new ServiceTokenScopeError("Service token does not have access to the requested secret path");
+    }
+
+    return {
+      allowed: true,
+      reason: "matched-service-token-scope",
+      allowedScopes
+    };
+  };
+
+  const assertCanReadSecretByName = async ({
+    secretName,
+    ...dto
+  }: TAssertServiceTokenSecretReadDTO & {
+    secretName: string;
+  }) => {
+    return assertCanReadSecrets({
+      ...dto,
+      secretName
+    });
+  };
+
+  const getAuditScopeMetadata = (allowedScopes: TServiceTokenResourceScope[]) =>
+    allowedScopes.map((scope) => scopeToAuditMetadata(scope));
+
+  const assertScopeOrThrow = async (dto: TAssertServiceTokenSecretReadDTO) => {
+    try {
+      return await assertCanReadSecrets(dto);
+    } catch (error) {
+      if (error instanceof ServiceTokenScopeError) {
+        throw new ForbiddenRequestError({
+          message: error.message,
+          name: error.name
+        });
+      }
+      throw error;
+    }
+  };
+
+  return {
+    createScopesForServiceToken,
+    getScopesForServiceToken,
+    assertCanReadSecrets,
+    assertCanReadSecretByName,
+    getAuditScopeMetadata,
+    assertScopeOrThrow
+  };
+};
diff --git a/backend/src/services/service-token/service-token-service.ts b/backend/src/services/service-token/service-token-service.ts
index 47e9f6d01..a2d4bf920 100644
--- a/backend/src/services/service-token/service-token-service.ts
+++ b/backend/src/services/service-token/service-token-service.ts
@@ -21,6 +21,7 @@ import { TProjectDALFactory } from "../project/project-dal";
 import { TProjectEnvDALFactory } from "../project-env/project-env-dal";
 import { SmtpTemplates, TSmtpService } from "../smtp/smtp-service";
 import { TUserDALFactory } from "../user/user-dal";
+import { TServiceTokenScopeServiceFactory } from "./service-token-scope-service";
 import { TServiceTokenDALFactory } from "./service-token-dal";
 import {
   TCreateServiceTokenDTO,
@@ -41,6 +42,7 @@ type TServiceTokenServiceFactoryDep = {
   projectDAL: Pick<TProjectDALFactory, "findById">;
   accessTokenQueue: Pick<TAccessTokenQueueServiceFactory, "updateServiceTokenStatus">;
   smtpService: Pick<TSmtpService, "sendMail">;
+  serviceTokenScopeService: Pick<TServiceTokenScopeServiceFactory, "createScopesForServiceToken">;
 };
 
 export type TServiceTokenServiceFactory = ReturnType<typeof serviceTokenServiceFactory>;
@@ -55,7 +57,8 @@ export const serviceTokenServiceFactory = ({
   projectDAL,
   accessTokenQueue,
   smtpService,
-  orgDAL
+  orgDAL,
+  serviceTokenScopeService
 }: TServiceTokenServiceFactoryDep) => {
   const createServiceToken = async ({
     iv,
@@ -149,6 +152,16 @@ export const serviceTokenServiceFactory = ({
       projectId
     });
 
+    const resourceScopes = await serviceTokenScopeService.createScopesForServiceToken({
+      serviceTokenId: serviceToken.id,
+      projectId,
+      permissions,
+      scopes
+    });
+
+    logger.info({ serviceTokenId: serviceToken.id, resourceScopes }, "Created service token resource scopes");
+
     const token = `st.${serviceToken.id.toString()}.${secret}`;
 
     return { token, serviceToken };
@@ -247,6 +260,15 @@ export const serviceTokenServiceFactory = ({
       parentOrgId: serviceTokenOrgDetails.parentOrgId || serviceTokenOrgDetails.id,
       rootOrgId: serviceTokenOrgDetails.rootOrgId || serviceTokenOrgDetails.id
     };
   };
 
+  const getServiceTokenResourceScopes = async (actorId: string) => {
+    const serviceToken = await serviceTokenDAL.findById(actorId);
+    if (!serviceToken) {
+      throw new NotFoundError({ message: `Service token with ID '${actorId}' not found` });
+    }
+    return serviceToken.scopes;
+  };
+
   const notifyExpiringTokens = async () => {
     const appCfg = getConfig();
     let processedCount = 0;
@@ -303,6 +325,7 @@ export const serviceTokenServiceFactory = ({
     deleteServiceToken,
     getServiceToken,
     getProjectServiceTokens,
+    getServiceTokenResourceScopes,
     fnValidateServiceToken,
     notifyExpiringTokens
   };
diff --git a/backend/src/services/secret/secret-service.ts b/backend/src/services/secret/secret-service.ts
index 9b96b18b3..ab572cb2d 100644
--- a/backend/src/services/secret/secret-service.ts
+++ b/backend/src/services/secret/secret-service.ts
@@ -49,6 +49,7 @@ import { TProjectDALFactory } from "../project/project-dal";
 import { TProjectEnvDALFactory } from "../project-env/project-env-dal";
 import { TProjectBotServiceFactory } from "../project/project-bot-service";
 import { ActorType } from "../auth/auth-type";
+import { TServiceTokenDALFactory } from "../service-token/service-token-dal";
 import { TSecretApprovalPolicyServiceFactory } from "../secret-approval-policy/secret-approval-policy-service";
 import { SecretImportReferencesBehavior } from "../secret-import/secret-import-types";
 import { TSecretV2BridgeServiceFactory } from "../secret-v2-bridge/secret-v2-bridge-service";
@@ -132,6 +133,7 @@ type TSecretServiceFactoryDep = {
   projectBotService: Pick<TProjectBotServiceFactory, "getBotKey">;
   projectDAL: Pick<TProjectDALFactory, "findById">;
   projectEnvDAL: Pick<TProjectEnvDALFactory, "findBySlugs">;
+  serviceTokenDAL: Pick<TServiceTokenDALFactory, "findById">;
   secretApprovalPolicyService: Pick<TSecretApprovalPolicyServiceFactory, "getSecretApprovalPolicy">;
   secretV2BridgeService: Pick<
     TSecretV2BridgeServiceFactory,
@@ -158,6 +160,7 @@ export const secretServiceFactory = ({
   projectEnvDAL,
   projectBotService,
   projectDAL,
+  serviceTokenDAL,
   secretApprovalPolicyService,
   secretV2BridgeService
 }: TSecretServiceFactoryDep) => {
@@ -1400,6 +1403,117 @@ export const secretServiceFactory = ({
     return secrets;
   };
 
+  const getSecretsForServiceToken = async ({
+    serviceTokenId,
+    projectId,
+    environment,
+    secretPath,
+    includeImports,
+    recursive,
+    expandSecretReferences,
+    viewSecretValue,
+    ifNoneMatch
+  }: {
+    serviceTokenId: string;
+    projectId: string;
+    environment: string;
+    secretPath: string;
+    includeImports?: boolean;
+    recursive?: boolean;
+    expandSecretReferences?: boolean;
+    viewSecretValue?: boolean;
+    ifNoneMatch?: string;
+  }) => {
+    const serviceToken = await serviceTokenDAL.findById(serviceTokenId);
+    if (!serviceToken) {
+      throw new NotFoundError({
+        message: `Service token with ID '${serviceTokenId}' not found`,
+        name: "ServiceTokenNotFound"
+      });
+    }
+    const project = await projectDAL.findById(projectId);
+    if (!project) {
+      throw new NotFoundError({
+        message: `Project with ID '${projectId}' not found`,
+        name: "ProjectNotFound"
+      });
+    }
+
+    return getSecretsRaw({
+      secretImportReferencesBehavior: SecretImportReferencesBehavior.Relative,
+      personalOverridesBehavior: PersonalOverridesBehavior.NeverInclude,
+      actorId: serviceToken.id,
+      actor: ActorType.SERVICE,
+      actorOrgId: project.orgId,
+      actorAuthMethod: null,
+      environment,
+      projectId,
+      path: secretPath,
+      includeImports,
+      recursive,
+      expandSecretReferences,
+      viewSecretValue,
+      ifNoneMatch
+    });
+  };
+
+  const getSecretByNameForServiceToken = async ({
+    serviceTokenId,
+    projectId,
+    environment,
+    secretPath,
+    secretName,
+    type,
+    includeImports,
+    expandSecretReferences,
+    viewSecretValue,
+    version
+  }: {
+    serviceTokenId: string;
+    projectId: string;
+    environment: string;
+    secretPath: string;
+    secretName: string;
+    type: SecretType;
+    includeImports?: boolean;
+    expandSecretReferences?: boolean;
+    viewSecretValue?: boolean;
+    version?: number;
+  }) => {
+    const serviceToken = await serviceTokenDAL.findById(serviceTokenId);
+    if (!serviceToken) {
+      throw new NotFoundError({
+        message: `Service token with ID '${serviceTokenId}' not found`,
+        name: "ServiceTokenNotFound"
+      });
+    }
+    const project = await projectDAL.findById(projectId);
+    if (!project) {
+      throw new NotFoundError({
+        message: `Project with ID '${projectId}' not found`,
+        name: "ProjectNotFound"
+      });
+    }
+
+    return getSecretByNameRaw({
+      actorId: serviceToken.id,
+      actor: ActorType.SERVICE,
+      actorOrgId: project.orgId,
+      actorAuthMethod: null,
+      environment,
+      projectId,
+      path: secretPath,
+      secretName,
+      type,
+      includeImports,
+      expandSecretReferences,
+      viewSecretValue,
+      version
+    });
+  };
+
   const getSecretsRaw = async ({
     projectId,
     path,
@@ -3615,6 +3717,8 @@ export const secretServiceFactory = ({
     updateSecret,
     getSecretByName,
     getSecrets,
+    getSecretsForServiceToken,
+    getSecretByNameForServiceToken,
     getSecretsRaw,
     getSecretByNameRaw,
     createSecretRaw,
diff --git a/backend/src/server/routes/v4/secret-router.ts b/backend/src/server/routes/v4/secret-router.ts
index 4cafe20be..fb089d355 100644
--- a/backend/src/server/routes/v4/secret-router.ts
+++ b/backend/src/server/routes/v4/secret-router.ts
@@ -1,7 +1,7 @@
 import picomatch from "picomatch";
 import { z } from "zod";
 
-import { SecretApprovalRequestsSchema, SecretType, ServiceTokenScopes } from "@app/db/schemas";
+import { SecretApprovalRequestsSchema, SecretType, ServiceTokenScopes } from "@app/db/schemas";
 import { EventType } from "@app/ee/services/audit-log/audit-log-types";
 import { ProjectPermissionSecretActions } from "@app/ee/services/permission/project-permission";
 import { ApiDocsTags, RAW_SECRETS } from "@app/lib/api-docs";
@@ -31,6 +31,13 @@ const removeTrailingSlash = (str: string) => {
   return str.length > 1 ? str.replace(/\/$/g, "") : str;
 };
 
+const getServiceTokenScopesFromRequest = async (server: FastifyZodProvider, req: FastifyRequest) => {
+  if (req.auth.actor !== ActorType.SERVICE) {
+    return [];
+  }
+
+  return server.services.serviceTokenScope.getScopesForServiceToken(req.permission.id);
+};
+
 export const registerSecretRouter = async (server: FastifyZodProvider) => {
   server.route({
     method: "GET",
@@ -168,13 +179,24 @@ export const registerSecretRouter = async (server: FastifyZodProvider) => {
       let { secretPath, environment, projectId } = req.query;
       if (req.auth.actor === ActorType.SERVICE) {
         const scope = ServiceTokenScopes.parse(req.auth.serviceToken.scopes);
+        const resourceScopes = await getServiceTokenScopesFromRequest(server, req);
         const isSingleScope = scope.length === 1;
         if (isSingleScope && !picomatch.scan(scope[0].secretPath).isGlob) {
           secretPath = scope[0].secretPath;
           environment = scope[0].environment;
           projectId = req.auth.serviceToken.projectId;
         }
+        await server.services.serviceTokenScope.assertScopeOrThrow({
+          actorId: req.permission.id,
+          actor: req.permission.type,
+          actorOrgId: req.permission.orgId,
+          actorAuthMethod: req.permission.authMethod,
+          projectId,
+          environment,
+          secretPath,
+          includeImports: req.query.includeImports,
+          recursive: req.query.recursive,
+          scopes: resourceScopes
+        });
       }
 
       if (!projectId || !environment) throw new BadRequestError({ message: "Missing project id or environment" });
@@ -218,6 +240,14 @@ export const registerSecretRouter = async (server: FastifyZodProvider) => {
           metadata: {
             environment,
             secretPath: req.query.secretPath,
+            serviceTokenScopes:
+              req.auth.actor === ActorType.SERVICE
+                ? server.services.serviceTokenScope.getAuditScopeMetadata(
+                    await getServiceTokenScopesFromRequest(server, req)
+                  )
+                : undefined,
             numberOfSecrets: secrets.length
           }
         }
@@ -329,13 +359,25 @@ export const registerSecretRouter = async (server: FastifyZodProvider) => {
       let { secretPath, environment, projectId } = req.query;
       if (req.auth.actor === ActorType.SERVICE) {
         const scope = ServiceTokenScopes.parse(req.auth.serviceToken.scopes);
+        const resourceScopes = await getServiceTokenScopesFromRequest(server, req);
         const isSingleScope = scope.length === 1;
         if (isSingleScope && !picomatch.scan(scope[0].secretPath).isGlob) {
           secretPath = scope[0].secretPath;
           environment = scope[0].environment;
           projectId = req.auth.serviceToken.projectId;
         }
+        await server.services.serviceTokenScope.assertScopeOrThrow({
+          actorId: req.permission.id,
+          actor: req.permission.type,
+          actorOrgId: req.permission.orgId,
+          actorAuthMethod: req.permission.authMethod,
+          projectId,
+          environment,
+          secretPath,
+          secretName: req.params.secretName,
+          includeImports: req.query.includeImports,
+          scopes: resourceScopes
+        });
       }
 
       if (!environment) throw new BadRequestError({ message: "Missing environment" });
@@ -382,6 +424,14 @@ export const registerSecretRouter = async (server: FastifyZodProvider) => {
             environment,
             secretPath: req.query.secretPath,
             secretId: secret.id,
+            serviceTokenScopes:
+              req.auth.actor === ActorType.SERVICE
+                ? server.services.serviceTokenScope.getAuditScopeMetadata(
+                    await getServiceTokenScopesFromRequest(server, req)
+                  )
+                : undefined,
             secretKey: req.params.secretName,
             secretVersion: secret.version,
             secretMetadata: secret.secretMetadata?.map((meta) => ({
diff --git a/backend/src/server/routes/v3/deprecated-secret-router.ts b/backend/src/server/routes/v3/deprecated-secret-router.ts
index 07cb2a563..14b318750 100644
--- a/backend/src/server/routes/v3/deprecated-secret-router.ts
+++ b/backend/src/server/routes/v3/deprecated-secret-router.ts
@@ -1,6 +1,6 @@
 import picomatch from "picomatch";
 import { z } from "zod";
-import { SecretApprovalRequestsSchema, SecretsSchema, SecretType, ServiceTokenScopes } from "@app/db/schemas";
+import { SecretApprovalRequestsSchema, SecretsSchema, SecretType, ServiceTokenScopes } from "@app/db/schemas";
 import { EventType } from "@app/ee/services/audit-log/audit-log-types";
 import { ProjectPermissionSecretActions } from "@app/ee/services/permission/project-permission";
 import { ApiDocsTags, SECRETS } from "@app/lib/api-docs";
@@ -32,6 +32,13 @@ const removeTrailingSlash = (str: string) => {
   return str.length > 1 ? str.replace(/\/$/g, "") : str;
 };
 
+const getServiceTokenScopesFromRequest = async (server: FastifyZodProvider, req: FastifyRequest) => {
+  if (req.auth.actor !== ActorType.SERVICE) {
+    return [];
+  }
+
+  return server.services.serviceTokenScope.getScopesForServiceToken(req.permission.id);
+};
+
 export const registerDeprecatedSecretRouter = async (server: FastifyZodProvider) => {
   server.route({
     method: "GET",
@@ -282,13 +293,24 @@ export const registerDeprecatedSecretRouter = async (server: FastifyZodProvider)
       let { secretPath, environment, workspaceId } = req.query;
       if (req.auth.actor === ActorType.SERVICE) {
         const scope = ServiceTokenScopes.parse(req.auth.serviceToken.scopes);
+        const resourceScopes = await getServiceTokenScopesFromRequest(server, req);
         const isSingleScope = scope.length === 1;
         if (isSingleScope && !picomatch.scan(scope[0].secretPath).isGlob) {
           secretPath = scope[0].secretPath;
           environment = scope[0].environment;
           workspaceId = req.auth.serviceToken.projectId;
         }
+        await server.services.serviceTokenScope.assertScopeOrThrow({
+          actorId: req.permission.id,
+          actor: req.permission.type,
+          actorOrgId: req.permission.orgId,
+          actorAuthMethod: req.permission.authMethod,
+          projectId: workspaceId,
+          environment,
+          secretPath,
+          includeImports: req.query.include_imports,
+          recursive: req.query.recursive,
+          scopes: resourceScopes
+        });
       } else {
         const projectId = await server.services.project.extractProjectIdFromSlug({
           projectSlug: req.query.workspaceSlug,
@@ -350,6 +372,14 @@ export const registerDeprecatedSecretRouter = async (server: FastifyZodProvider)
           metadata: {
             environment,
             secretPath: req.query.secretPath,
+            serviceTokenScopes:
+              req.auth.actor === ActorType.SERVICE
+                ? server.services.serviceTokenScope.getAuditScopeMetadata(
+                    await getServiceTokenScopesFromRequest(server, req)
+                  )
+                : undefined,
             numberOfSecrets: secrets.length
           }
         }
@@ -450,13 +480,25 @@ export const registerDeprecatedSecretRouter = async (server: FastifyZodProvider)
       let { secretPath, environment, workspaceId } = req.query;
       if (req.auth.actor === ActorType.SERVICE) {
         const scope = ServiceTokenScopes.parse(req.auth.serviceToken.scopes);
+        const resourceScopes = await getServiceTokenScopesFromRequest(server, req);
         const isSingleScope = scope.length === 1;
         if (isSingleScope && !picomatch.scan(scope[0].secretPath).isGlob) {
           secretPath = scope[0].secretPath;
           environment = scope[0].environment;
           workspaceId = req.auth.serviceToken.projectId;
         }
+        await server.services.serviceTokenScope.assertScopeOrThrow({
+          actorId: req.permission.id,
+          actor: req.permission.type,
+          actorOrgId: req.permission.orgId,
+          actorAuthMethod: req.permission.authMethod,
+          projectId: workspaceId,
+          environment,
+          secretPath,
+          secretName: req.params.secretName,
+          includeImports: req.query.include_imports,
+          scopes: resourceScopes
+        });
       } else {
         const projectId = await server.services.project.extractProjectIdFromSlug({
           projectSlug: workspaceSlug,
@@ -511,6 +553,14 @@ export const registerDeprecatedSecretRouter = async (server: FastifyZodProvider)
             environment,
             secretPath: req.query.secretPath,
             secretId: secret.id,
+            serviceTokenScopes:
+              req.auth.actor === ActorType.SERVICE
+                ? server.services.serviceTokenScope.getAuditScopeMetadata(
+                    await getServiceTokenScopesFromRequest(server, req)
+                  )
+                : undefined,
             secretKey: req.params.secretName,
             secretVersion: secret.version,
             secretMetadata:
diff --git a/backend/e2e-test/routes/v2/service-token-resource-scopes.spec.ts b/backend/e2e-test/routes/v2/service-token-resource-scopes.spec.ts
new file mode 100644
index 000000000..30b9ae40a
--- /dev/null
+++ b/backend/e2e-test/routes/v2/service-token-resource-scopes.spec.ts
@@ -0,0 +1,274 @@
+import { expect, test, describe, beforeAll, afterAll } from "vitest";
+
+import { SecretType } from "@app/db/schemas";
+import { testServer } from "@app/server";
+import { seedData1 } from "@app/server/test-fixtures/seed-data";
+import { crypto } from "@app/lib/crypto/cryptography";
+import { ServiceTokenResource, ServiceTokenResourceAction } from "@app/services/service-token/service-token-scope-types";
+
+const encryptSecret = (projectKey: string, key: string, value: string, comment: string) => {
+  const encryptedValue = crypto.encryption().symmetric().encrypt({
+    text: value,
+    key: projectKey
+  });
+  const encryptedComment = crypto.encryption().symmetric().encrypt({
+    text: comment,
+    key: projectKey
+  });
+  return {
+    secretName: key,
+    secretValueCiphertext: encryptedValue.ciphertext,
+    secretValueIV: encryptedValue.iv,
+    secretValueTag: encryptedValue.tag,
+    secretCommentCiphertext: encryptedComment.ciphertext,
+    secretCommentIV: encryptedComment.iv,
+    secretCommentTag: encryptedComment.tag
+  };
+};
+
+const createServiceToken = async ({
+  secretPath,
+  environment,
+  permissions = ["read"],
+  resourceScopes
+}: {
+  secretPath: string;
+  environment: string;
+  permissions?: string[];
+  resourceScopes?: Array<{
+    resource: ServiceTokenResource;
+    action: ServiceTokenResourceAction;
+    environment: string;
+    secretPath: string;
+    includeImports?: boolean;
+    recursive?: boolean;
+  }>;
+}) => {
+  const res = await testServer.inject({
+    method: "POST",
+    url: "/api/v2/service-token",
+    headers: {
+      authorization: `Bearer ${seedData1.jwtAuthToken}`
+    },
+    body: {
+      name: `resource-scope-${Date.now()}`,
+      workspaceId: seedData1.project.id,
+      scopes: [
+        {
+          environment,
+          secretPath
+        }
+      ],
+      resourceScopes,
+      permissions,
+      encryptedKey: "encrypted-key",
+      iv: "iv",
+      tag: "tag"
+    }
+  });
+  expect(res.statusCode).toBe(200);
+  return res.json().serviceToken as string;
+};
+
+const createSecret = async ({
+  token,
+  path,
+  environment,
+  key,
+  value
+}: {
+  token: string;
+  path: string;
+  environment: string;
+  key: string;
+  value: string;
+}) => {
+  const res = await testServer.inject({
+    method: "POST",
+    url: `/api/v3/secrets/${key}`,
+    headers: {
+      authorization: `Bearer ${token}`
+    },
+    body: {
+      workspaceId: seedData1.project.id,
+      environment,
+      secretPath: path,
+      type: SecretType.Shared,
+      ...encryptSecret(seedData1.projectKey, key, value, "")
+    }
+  });
+  expect([200, 409]).toContain(res.statusCode);
+};
+
+const listSecrets = async ({
+  token,
+  path,
+  environment,
+  recursive = false
+}: {
+  token: string;
+  path: string;
+  environment: string;
+  recursive?: boolean;
+}) =>
+  testServer.inject({
+    method: "GET",
+    url: "/api/v4/secrets",
+    headers: {
+      authorization: `Bearer ${token}`
+    },
+    query: {
+      projectId: seedData1.project.id,
+      environment,
+      secretPath: path,
+      recursive: String(recursive),
+      viewSecretValue: "true"
+    }
+  });
+
+describe("service token resource scopes", () => {
+  let setupToken: string;
+
+  beforeAll(async () => {
+    setupToken = await createServiceToken({
+      environment: seedData1.environment.slug,
+      secretPath: "/**",
+      permissions: ["read", "write"]
+    });
+
+    await createSecret({
+      token: setupToken,
+      path: "/ops",
+      environment: seedData1.environment.slug,
+      key: "OPS_TOKEN",
+      value: "ops-value"
+    });
+    await createSecret({
+      token: setupToken,
+      path: "/ops/nested",
+      environment: seedData1.environment.slug,
+      key: "NESTED_OPS_TOKEN",
+      value: "nested-value"
+    });
+    await createSecret({
+      token: setupToken,
+      path: "/production",
+      environment: seedData1.environment.slug,
+      key: "PRODUCTION_TOKEN",
+      value: "production-value"
+    });
+  });
+
+  afterAll(async () => {
+    await testServer.inject({
+      method: "DELETE",
+      url: "/api/v2/service-token/current",
+      headers: {
+        authorization: `Bearer ${setupToken}`
+      }
+    });
+  });
+
+  test("allows a token to read an exact scoped folder", async () => {
+    const token = await createServiceToken({
+      environment: seedData1.environment.slug,
+      secretPath: "/ops",
+      resourceScopes: [
+        {
+          resource: ServiceTokenResource.Secrets,
+          action: ServiceTokenResourceAction.Read,
+          environment: seedData1.environment.slug,
+          secretPath: "/ops"
+        }
+      ]
+    });
+
+    const res = await listSecrets({
+      token,
+      environment: seedData1.environment.slug,
+      path: "/ops"
+    });
+
+    expect(res.statusCode).toBe(200);
+    expect(res.json().secrets).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          secretKey: "OPS_TOKEN",
+          secretPath: "/ops"
+        })
+      ])
+    );
+  });
+
+  test("denies a sibling folder outside the service token scope", async () => {
+    const token = await createServiceToken({
+      environment: seedData1.environment.slug,
+      secretPath: "/ops",
+      resourceScopes: [
+        {
+          resource: ServiceTokenResource.Secrets,
+          action: ServiceTokenResourceAction.Read,
+          environment: seedData1.environment.slug,
+          secretPath: "/ops"
+        }
+      ]
+    });
+
+    const res = await listSecrets({
+      token,
+      environment: seedData1.environment.slug,
+      path: "/billing"
+    });
+
+    expect(res.statusCode).toBe(403);
+    expect(res.json().error).toBe("PermissionDenied");
+  });
+
+  test("allows recursive reads when the scope ends in a recursive wildcard", async () => {
+    const token = await createServiceToken({
+      environment: seedData1.environment.slug,
+      secretPath: "/ops/**",
+      resourceScopes: [
+        {
+          resource: ServiceTokenResource.Secrets,
+          action: ServiceTokenResourceAction.Read,
+          environment: seedData1.environment.slug,
+          secretPath: "/ops/**",
+          recursive: true
+        }
+      ]
+    });
+
+    const res = await listSecrets({
+      token,
+      environment: seedData1.environment.slug,
+      path: "/ops/nested",
+      recursive: true
+    });
+
+    expect(res.statusCode).toBe(200);
+    expect(res.json().secrets).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          secretKey: "NESTED_OPS_TOKEN",
+          secretPath: "/ops/nested"
+        })
+      ])
+    );
+  });
+
+  test("supports environment wildcard tokens for automation projects", async () => {
+    const token = await createServiceToken({
+      environment: "*",
+      secretPath: "/ops/**",
+      resourceScopes: [
+        {
+          resource: ServiceTokenResource.Secrets,
+          action: ServiceTokenResourceAction.Read,
+          environment: "*",
+          secretPath: "/ops/**",
+          recursive: true
+        }
+      ]
+    });
+
+    const res = await listSecrets({
+      token,
+      environment: seedData1.environment.slug,
+      path: "/ops/nested",
+      recursive: true
+    });
+
+    expect(res.statusCode).toBe(200);
+  });
+
+  test("supports prefix scopes for environment groups", async () => {
+    const token = await createServiceToken({
+      environment: `${seedData1.environment.slug}*`,
+      secretPath: "/prod",
+      resourceScopes: [
+        {
+          resource: ServiceTokenResource.Secrets,
+          action: ServiceTokenResourceAction.Read,
+          environment: `${seedData1.environment.slug}*`,
+          secretPath: "/prod"
+        }
+      ]
+    });
+
+    const res = await listSecrets({
+      token,
+      environment: seedData1.environment.slug,
+      path: "/production"
+    });
+
+    expect(res.statusCode).toBe(200);
+  });
+});
```

## Intended Flaws

### Flaw 1: Service-Token Authorization Lives At The Route Boundary, While New Service Helpers Bypass It

- `type`: `authorization_boundary`
- `location`: `backend/src/server/routes/v4/secret-router.ts:179-231`, `backend/src/server/routes/v3/deprecated-secret-router.ts:293-344`, `backend/src/services/secret/secret-service.ts:1403-1519`, `backend/src/services/secret/secret-service.ts:3729-3732`
- `learner_prompt`: Is the new scope rule enforced by the secret domain service, or only by the HTTP handlers that remembered to call it?

Expected answer:

- `identify`: The PR checks service-token resource scopes inside the V3/V4 route handlers before calling `getSecretsRaw` and `getSecretByNameRaw`, but the new exported service helpers `getSecretsForServiceToken` and `getSecretByNameForServiceToken` read secrets as `ActorType.SERVICE` without calling `serviceTokenScope.assertScopeOrThrow` or requiring an already-authorized capability. Any internal caller, job, CLI path, sync path, or future route that uses these helpers bypasses the new scope model.
- `impact`: The product now tells customers that service tokens are constrained by resource scopes, but the invariant only holds for a subset of HTTP routes. A later background job or internal endpoint can accidentally expose secrets outside the token's intended environment/path because the service API itself does not make the authorization state explicit. This is exactly how permission bugs survive review: the happy route is guarded, the domain operation is not.
- `fix_direction`: Move the service-token scope decision into the secret service boundary or require callers to pass a typed, pre-authorized read capability produced by a single authorization service. `getSecretsRaw` / `getSecretByNameRaw` should either enforce service-token scopes whenever `actor === SERVICE` or reject service-token callers unless an authorization proof is present. Add direct service-level tests and tests for every non-route caller that can read secrets with a service token.

Hints:

1. Look for the files that export new secret-reading functions.
2. Ask what happens when a caller reaches the service without going through `secret-router.ts`.
3. A permission check is only durable if the API that performs the sensitive operation cannot be called without it.

### Flaw 2: Wildcard Matching Is A Broad Glob Contract Masquerading As A Scope Model

- `type`: `permission_modeling`
- `location`: `backend/src/db/migrations/20260516092100_add_service_token_resource_scopes.ts:42-55`, `backend/src/services/service-token/service-token-scope-types.ts:15-21`, `backend/src/services/service-token/service-token-scope-types.ts:80-91`, `backend/src/services/service-token/service-token-scope-service.ts:27-63`, `backend/e2e-test/routes/v2/service-token-resource-scopes.spec.ts:234-272`
- `learner_prompt`: Are `*`, `/prod`, `/prod/**`, and environment prefixes precise authorization resources or ad hoc string patterns?

Expected answer:

- `identify`: The PR turns environments and secret paths into broad picomatch patterns. Defaults fall back to `environment: "*"`, `secretPath: "/**"`, the matcher uses `contains: true`, and tests bless prefix behavior where a scope for `/prod` can read `/production`. This is not a crisp resource model; it is a string search over `environment:path` that can over-match.
- `impact`: A token meant for a folder, environment group, or automation namespace can read more secrets than the creator intended. Prefix collisions such as `/prod` versus `/production`, environment globs such as `prod*`, and migration defaults such as `*`/`/**` become silent privilege expansion. Audit logs then record an allowed scope, making the access look legitimate after the fact.
- `fix_direction`: Model service-token scopes as explicit resources and actions: project id, environment id or exact slug, canonical secret-path segments, optional recursive containment, and action enum. Implement path containment with normalized segment comparison instead of `picomatch.contains`. If wildcard or all-environment scopes are truly needed, make them explicit scope kinds with UI copy, audit copy, boundary validation, and negative tests for sibling/prefix collisions.

Hints:

1. Search for `contains: true`.
2. Compare a path segment model with string-prefix matching.
3. Any wildcard accepted in token creation becomes part of the security contract customers rely on.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that the authorization check is route-local and that the newly exported secret service helpers can read as a service token without enforcing the same scope. Answers that only say "add more route checks" miss the architectural problem.

For flaw 2, a correct answer must identify the over-broad glob semantics, especially `contains: true`, `*`/`/**` defaults, and prefix collisions like `/prod` matching `/production`. Answers that only say "wildcards are risky" are incomplete unless they explain how the matcher changes the permission contract.

### Product-Level Change

The PR tries to make service-token scopes easier to audit by creating normalized resource scopes for secret reads. At the product level, customers should be able to hand an automation a token that can read exactly the intended environment/path and no more.

### Changed Contracts

- Data contract: service-token scopes are now duplicated into a normalized resource-scope table.
- Authorization contract: service-token secret reads are supposed to be governed by resource/action/environment/path scopes.
- API contract: V3/V4 secret read routes now perform explicit service-token scope checks before returning secrets.
- Service contract: secret service exports service-token-specific read helpers, which means internal callers now have a tempting privileged path.
- Audit contract: allowed service-token scopes appear in secret-read audit metadata.

### Failure Modes

A token is created for `/prod` because the operator wants a deployment job to read only production-folder secrets. The matcher uses `contains: true`, so the token also matches `/production`, `/shared/prod`, or other prefix-like paths depending on input shape. The job can read secrets the operator did not authorize.

A future import preview job calls `secret.getSecretsForServiceToken` directly because the helper name looks exactly right. It passes a token id, project id, environment, and path. The helper reads secrets as `ActorType.SERVICE` and never checks the normalized resource scopes, so the route-level guard is skipped completely.

### Reviewer Thought Process

A strong reviewer treats authorization as a system invariant. They do not stop once they see a route check; they follow the sensitive operation down to the service API and ask whether every caller is forced through the same decision point.

Then they translate wildcard code into customer-visible semantics. If the code says `contains: true`, the product now says "a scope may match substrings." That is almost never what a security scope means.

### Better Implementation Direction

- Keep one service-token authorization path for all secret reads.
- Require a typed authorization context or capability object at the secret service boundary.
- Reject service-token reads when scope state is missing, stale, or unparseable.
- Replace broad glob matching with exact environment identity plus canonical path containment.
- Make recursive or all-environment scopes explicit scope kinds, not string tricks.
- Add direct service tests, negative sibling-path tests, environment-prefix collision tests, and mixed legacy/new-scope migration tests.

## Why This Case Exists

This case trains the reviewer to see beyond "the route has a check." In mature systems, the hard bugs sit at boundaries: HTTP route versus domain service, permission model versus matcher implementation, and migration defaults versus customer trust.
