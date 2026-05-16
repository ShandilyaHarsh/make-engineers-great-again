# TS-055: Infisical Secret Access Audit Events

## Metadata

- `id`: TS-055
- `source_repo`: [Infisical/infisical](https://github.com/Infisical/infisical)
- `repo_area`: secret access audit logs, event schemas, event metadata compatibility, permission outcomes, secret read routes, audit log queries, ClickHouse/Postgres audit storage, compliance exports
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,800-2,200
- `represented_diff_lines`: 1801
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Infisical audit logs, secret-read permissions, event schema compatibility, compliance exports, denied access logging, and audit-query contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds richer secret-access audit events for Infisical. Customers want audit logs to answer more than "a secret was fetched"; they want to know whether the access was allowed or denied, whether the value was revealed, which access path was used, and which route/API version produced the log.

The PR adds:

- a normalized secret-access audit metadata schema,
- a builder for single-secret and list-secret access events,
- route integration for V4 secret list/get endpoints,
- audit log filtering helpers for access outcome and schema version,
- tests for single-secret, list-secret, denied, service-token, and compatibility cases,
- docs for dashboards, SIEM consumers, and compliance exports.

The intended product behavior is: secret-access auditing should become more precise without breaking existing audit-log consumers, and audit rows should describe what actually happened after permission checks.

## Existing Code Context

The real Infisical codebase already has these relevant contracts:

- `backend/src/ee/services/audit-log/audit-log-types.ts` defines `EventType.GET_SECRET = "get-secret"` and `EventType.GET_SECRETS = "get-secrets"` as existing audit event names.
- `backend/src/ee/services/audit-log/audit-log-types.ts` has typed metadata for `GetSecretEvent` and `GetSecretsEvent`; existing single-secret metadata includes `environment`, `secretPath`, `secretId`, `secretKey`, `secretVersion`, and optional `secretMetadata`.
- `backend/src/ee/services/audit-log/audit-log-types.ts` includes `filterableSecretEvents`, which makes secret audit filters special for `GET_SECRET` and other secret events.
- `backend/src/ee/services/audit-log/audit-log-service.ts` validates that an audit log has project or org context, attaches permission metadata from request context, and pushes the event to the audit log queue.
- `backend/src/ee/services/audit-log/audit-log-queue.ts` stores `eventType` and `eventMetadata` in Postgres or ClickHouse-backed audit log paths and can stream logs to external destinations.
- `backend/src/ee/services/audit-log/audit-log-dal.ts` filters audit rows by `eventType` and `eventMetadata`, including special `environment`, `secretPath`, and `secretKey` filters for secret events.
- `backend/src/ee/services/audit-log/audit-log-clickhouse-dal.ts` mirrors those filters through ClickHouse `JSONExtractString` calls.
- `backend/src/server/routes/v4/secret-router.ts` calls `server.services.secret.getSecretsRaw` or `getSecretByNameRaw` first, then emits `GET_SECRETS` or `GET_SECRET`.
- `backend/src/services/secret/secret-service.ts` enforces read-value/describe permission with `throwIfMissingSecretReadValueOrDescribePermission` inside secret read paths.
- `backend/src/server/plugins/audit-log.ts` populates `req.auditLogInfo` with actor, user agent, IP, and request metadata before route handlers emit audit logs.
- `backend/src/db/schemas/audit-logs.ts` stores `eventType` as a string and `eventMetadata` as unknown JSON; downstream compatibility depends on stable event names and metadata keys.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the new audit event model preserves existing audit contracts and truthfully records secret access outcomes.

## Review Surface

Changed files in the synthetic PR:

- `backend/src/ee/services/audit-log/audit-log-types.ts`
- `backend/src/ee/services/audit-log/secret-access-audit-event.ts`
- `backend/src/ee/services/audit-log/secret-access-audit-event.test.ts`
- `backend/src/ee/services/audit-log/secret-access-audit-compat.test.ts`
- `backend/src/ee/services/audit-log/audit-log-dal.ts`
- `backend/src/ee/services/audit-log/audit-log-clickhouse-dal.ts`
- `backend/src/server/routes/v4/secret-router.ts`
- `backend/src/server/routes/v4/secret-router.audit.test.ts`
- `docs/security/secret-access-audit-events.md`

The line references below use synthetic PR line numbers. The represented diff is focused on event contract compatibility, audit truthfulness after permission checks, and tests/docs that encode the wrong behavior.

## Diff

```diff
diff --git a/backend/src/ee/services/audit-log/audit-log-types.ts b/backend/src/ee/services/audit-log/audit-log-types.ts
index 80e6c3d8d2..522de84e5a 100644
--- a/backend/src/ee/services/audit-log/audit-log-types.ts
+++ b/backend/src/ee/services/audit-log/audit-log-types.ts
@@ -150,6 +150,7 @@ export enum EventType {
   GET_SECRETS = "get-secrets",
   GET_SECRET = "get-secret",
   REVEAL_SECRET = "reveal-secret",
+  SECRET_ACCESS_DENIED = "secret-access-denied",
   CREATE_SECRET = "create-secret",
   CREATE_SECRETS = "create-secrets",
   UPDATE_SECRET = "update-secret",
@@ -846,8 +847,9 @@ export const filterableSecretEvents: EventType[] = [
   EventType.DELETE_SECRETS,
   EventType.CREATE_SECRETS,
   EventType.UPDATE_SECRETS,
   EventType.CREATE_SECRET,
   EventType.UPDATE_SECRET,
-  EventType.DELETE_SECRET
+  EventType.DELETE_SECRET,
+  EventType.SECRET_ACCESS_DENIED
 ];
@@ -978,34 +980,121 @@ export type Actor =
   | ScepAccountActor
   | GatewayActor;
 
+export enum SecretAccessAuditOutcome {
+  Allowed = "allowed",
+  Denied = "denied"
+}
+
+export enum SecretAccessAuditMode {
+  List = "list",
+  Single = "single"
+}
+
+export enum SecretAccessAuditValueVisibility {
+  Hidden = "hidden",
+  Revealed = "revealed",
+  Unknown = "unknown"
+}
+
+export type SecretAccessAuditPrincipal = {
+  actorType: ActorType;
+  actorId: string;
+  authMethod?: string;
+  name?: string;
+};
+
+export type SecretAccessAuditRequest = {
+  route: "v4.secrets.list" | "v4.secrets.get";
+  apiVersion: "v4";
+  projectId: string;
+  environment: string;
+  secretPath: string;
+  requestedSecretKey?: string;
+  recursive?: boolean;
+  includeImports?: boolean;
+  includePersonalOverrides?: boolean;
+  expandSecretReferences?: boolean;
+  viewSecretValue?: boolean;
+  userAgentType?: UserAgentType;
+};
+
+export type SecretAccessAuditItem = {
+  secretId?: string;
+  secretKey: string;
+  secretVersion?: number;
+  secretPath: string;
+  environment: string;
+  valueVisibility: SecretAccessAuditValueVisibility;
+  imported?: boolean;
+  personalOverride?: boolean;
+};
+
+export type SecretAccessAuditMetadata = {
+  schemaVersion: 2;
+  mode: SecretAccessAuditMode;
+  outcome: SecretAccessAuditOutcome;
+  request: SecretAccessAuditRequest;
+  principal: SecretAccessAuditPrincipal;
+  secrets: SecretAccessAuditItem[];
+  deniedReason?: string;
+  numberOfSecrets: number;
+};
+
 interface GetSecretsEvent {
   type: EventType.GET_SECRETS;
-  metadata: {
-    environment: string;
-    secretPath: string;
-    numberOfSecrets: number;
-  };
+  metadata: SecretAccessAuditMetadata;
 }
 
-type TSecretMetadata = { key: string; value: string }[];
+type TSecretMetadata = { key: string; value: string; isEncrypted?: boolean }[];
 
 interface GetSecretEvent {
   type: EventType.GET_SECRET;
-  metadata: {
-    environment: string;
-    secretPath: string;
-    secretId: string;
-    secretKey: string;
-    secretVersion: number;
-    secretMetadata?: TSecretMetadata;
-  };
+  metadata: SecretAccessAuditMetadata;
+}
+
+interface SecretAccessDeniedEvent {
+  type: EventType.SECRET_ACCESS_DENIED;
+  metadata: SecretAccessAuditMetadata;
 }
 
 interface CreateSecretEvent {
   type: EventType.CREATE_SECRET;
   metadata: {
@@ -6594,6 +6683,7 @@ export type Event =
   | JoinSubOrganizationEvent
   | GetSecretsEvent
   | GetSecretEvent
+  | SecretAccessDeniedEvent
   | CreateSecretEvent
   | CreateSecretBatchEvent
   | UpdateSecretEvent
diff --git a/backend/src/ee/services/audit-log/secret-access-audit-event.ts b/backend/src/ee/services/audit-log/secret-access-audit-event.ts
new file mode 100644
index 0000000000..f4b1a3126e
--- /dev/null
+++ b/backend/src/ee/services/audit-log/secret-access-audit-event.ts
@@ -0,0 +1,194 @@
+import type { TCreateAuditLogDTO } from "./audit-log-types";
+import {
+  EventType,
+  SecretAccessAuditMode,
+  SecretAccessAuditOutcome,
+  SecretAccessAuditValueVisibility,
+  type AuditLogInfo,
+  type SecretAccessAuditItem,
+  type SecretAccessAuditMetadata,
+  type SecretAccessAuditPrincipal,
+  type SecretAccessAuditRequest,
+  type TAuditLogServiceFactory
+} from "./audit-log-types";
+import type { ActorType } from "@app/services/auth/auth-type";
+
+type SecretAccessRoute = "v4.secrets.list" | "v4.secrets.get";
+
+type SecretAccessAuditInput = {
+  auditLogService: Pick<TAuditLogServiceFactory, "createAuditLog">;
+  auditLogInfo: AuditLogInfo;
+  projectId: string;
+  actorType: ActorType;
+  actorId: string;
+  actorAuthMethod?: string;
+  route: SecretAccessRoute;
+  environment: string;
+  secretPath: string;
+  secretKey?: string;
+  recursive?: boolean;
+  includeImports?: boolean;
+  includePersonalOverrides?: boolean;
+  expandSecretReferences?: boolean;
+  viewSecretValue?: boolean;
+  userAgentType?: SecretAccessAuditRequest["userAgentType"];
+};
+
+type SecretAccessAuditSuccessInput = SecretAccessAuditInput & {
+  outcome?: SecretAccessAuditOutcome.Allowed;
+  secrets: Array<{
+    id?: string;
+    key: string;
+    version?: number;
+    path?: string;
+    environment?: string;
+    valueHidden?: boolean;
+    imported?: boolean;
+    personalOverride?: boolean;
+  }>;
+};
+
+type SecretAccessAuditDeniedInput = SecretAccessAuditInput & {
+  outcome: SecretAccessAuditOutcome.Denied;
+  deniedReason: string;
+};
+
+export async function auditSecretAccessStarted(input: SecretAccessAuditInput) {
+  const event = buildSecretAccessAuditEvent({
+    ...input,
+    outcome: SecretAccessAuditOutcome.Allowed,
+    secrets: input.secretKey
+      ? [
+          {
+            key: input.secretKey,
+            path: input.secretPath,
+            environment: input.environment,
+            valueHidden: input.viewSecretValue === false
+          }
+        ]
+      : []
+  });
+
+  await input.auditLogService.createAuditLog({
+    projectId: input.projectId,
+    ...input.auditLogInfo,
+    event
+  });
+}
+
+export async function auditSecretAccessSucceeded(input: SecretAccessAuditSuccessInput) {
+  const event = buildSecretAccessAuditEvent(input);
+
+  await input.auditLogService.createAuditLog({
+    projectId: input.projectId,
+    ...input.auditLogInfo,
+    event
+  });
+}
+
+export async function auditSecretAccessDenied(input: SecretAccessAuditDeniedInput) {
+  const event = buildSecretAccessAuditEvent(input);
+
+  await input.auditLogService.createAuditLog({
+    projectId: input.projectId,
+    ...input.auditLogInfo,
+    event
+  });
+}
+
+export function buildSecretAccessAuditEvent(input: SecretAccessAuditSuccessInput | SecretAccessAuditDeniedInput) {
+  const metadata = buildSecretAccessAuditMetadata(input);
+
+  if (input.outcome === SecretAccessAuditOutcome.Denied) {
+    return {
+      type: EventType.SECRET_ACCESS_DENIED,
+      metadata
+    };
+  }
+
+  return {
+    type: input.route === "v4.secrets.list" ? EventType.GET_SECRETS : EventType.GET_SECRET,
+    metadata
+  };
+}
+
+export function buildSecretAccessAuditMetadata(
+  input: SecretAccessAuditSuccessInput | SecretAccessAuditDeniedInput
+): SecretAccessAuditMetadata {
+  const principal: SecretAccessAuditPrincipal = {
+    actorType: input.actorType,
+    actorId: input.actorId,
+    authMethod: input.actorAuthMethod
+  };
+
+  const request: SecretAccessAuditRequest = {
+    route: input.route,
+    apiVersion: "v4",
+    projectId: input.projectId,
+    environment: input.environment,
+    secretPath: input.secretPath,
+    requestedSecretKey: input.secretKey,
+    recursive: input.recursive,
+    includeImports: input.includeImports,
+    includePersonalOverrides: input.includePersonalOverrides,
+    expandSecretReferences: input.expandSecretReferences,
+    viewSecretValue: input.viewSecretValue,
+    userAgentType: input.userAgentType
+  };
+
+  const secrets =
+    "secrets" in input
+      ? input.secrets.map((secret): SecretAccessAuditItem => {
+          const valueVisibility =
+            secret.valueHidden === true
+              ? SecretAccessAuditValueVisibility.Hidden
+              : input.viewSecretValue === false
+                ? SecretAccessAuditValueVisibility.Hidden
+                : SecretAccessAuditValueVisibility.Revealed;
+
+          return {
+            secretId: secret.id,
+            secretKey: secret.key,
+            secretVersion: secret.version,
+            secretPath: secret.path ?? input.secretPath,
+            environment: secret.environment ?? input.environment,
+            valueVisibility,
+            imported: secret.imported,
+            personalOverride: secret.personalOverride
+          };
+        })
+      : [];
+
+  return {
+    schemaVersion: 2,
+    mode: input.route === "v4.secrets.list" ? SecretAccessAuditMode.List : SecretAccessAuditMode.Single,
+    outcome: input.outcome,
+    request,
+    principal,
+    secrets,
+    deniedReason: "deniedReason" in input ? input.deniedReason : undefined,
+    numberOfSecrets: secrets.length
+  };
+}
+
+export function getSecretAccessMetadataForLegacyFilters(event: TCreateAuditLogDTO["event"]) {
+  if (event.type !== EventType.GET_SECRET && event.type !== EventType.GET_SECRETS) {
+    return event.metadata;
+  }
+
+  if (!("schemaVersion" in event.metadata)) {
+    return event.metadata;
+  }
+
+  const metadata = event.metadata as SecretAccessAuditMetadata;
+  const firstSecret = metadata.secrets[0];
+
+  return {
+    environment: metadata.request.environment,
+    secretPath: metadata.request.secretPath,
+    secretKey: firstSecret?.secretKey ?? metadata.request.requestedSecretKey,
+    secretId: firstSecret?.secretId,
+    secretVersion: firstSecret?.secretVersion,
+    numberOfSecrets: metadata.numberOfSecrets
+  };
+}
diff --git a/backend/src/ee/services/audit-log/secret-access-audit-event.test.ts b/backend/src/ee/services/audit-log/secret-access-audit-event.test.ts
new file mode 100644
index 0000000000..601337f4cc
--- /dev/null
+++ b/backend/src/ee/services/audit-log/secret-access-audit-event.test.ts
@@ -0,0 +1,231 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { ActorType } from "@app/services/auth/auth-type";
+
+import {
+  auditSecretAccessDenied,
+  auditSecretAccessStarted,
+  auditSecretAccessSucceeded,
+  buildSecretAccessAuditEvent,
+  getSecretAccessMetadataForLegacyFilters
+} from "./secret-access-audit-event";
+import {
+  EventType,
+  SecretAccessAuditMode,
+  SecretAccessAuditOutcome,
+  SecretAccessAuditValueVisibility,
+  UserAgentType
+} from "./audit-log-types";
+
+describe("secret access audit event builder", () => {
+  it("builds the new schema on the existing get-secret event type", () => {
+    const event = buildSecretAccessAuditEvent({
+      ...baseInput(),
+      route: "v4.secrets.get",
+      secretKey: "DATABASE_URL",
+      outcome: SecretAccessAuditOutcome.Allowed,
+      secrets: [
+        {
+          id: "sec_123",
+          key: "DATABASE_URL",
+          version: 7,
+          valueHidden: false
+        }
+      ]
+    });
+
+    expect(event.type).to.equal(EventType.GET_SECRET);
+    expect(event.metadata).toMatchObject({
+      schemaVersion: 2,
+      mode: SecretAccessAuditMode.Single,
+      outcome: SecretAccessAuditOutcome.Allowed,
+      numberOfSecrets: 1,
+      request: {
+        route: "v4.secrets.get",
+        apiVersion: "v4",
+        projectId: "proj_123",
+        environment: "prod",
+        secretPath: "/payments",
+        requestedSecretKey: "DATABASE_URL"
+      }
+    });
+    expect(event.metadata.secrets[0]).toMatchObject({
+      secretId: "sec_123",
+      secretKey: "DATABASE_URL",
+      secretVersion: 7,
+      valueVisibility: SecretAccessAuditValueVisibility.Revealed
+    });
+  });
+
+  it("builds the new schema on the existing get-secrets event type", () => {
+    const event = buildSecretAccessAuditEvent({
+      ...baseInput(),
+      route: "v4.secrets.list",
+      outcome: SecretAccessAuditOutcome.Allowed,
+      includeImports: true,
+      recursive: true,
+      secrets: [
+        {
+          id: "sec_1",
+          key: "DATABASE_URL",
+          version: 2,
+          valueHidden: true
+        },
+        {
+          id: "sec_2",
+          key: "STRIPE_KEY",
+          version: 4,
+          imported: true,
+          valueHidden: false
+        }
+      ]
+    });
+
+    expect(event.type).to.equal(EventType.GET_SECRETS);
+    expect(event.metadata.schemaVersion).to.equal(2);
+    expect(event.metadata.mode).to.equal(SecretAccessAuditMode.List);
+    expect(event.metadata.numberOfSecrets).to.equal(2);
+    expect(event.metadata.secrets.map((secret) => secret.secretKey)).to.deep.equal(["DATABASE_URL", "STRIPE_KEY"]);
+  });
+
+  it("builds denied access as a dedicated event type", () => {
+    const event = buildSecretAccessAuditEvent({
+      ...baseInput(),
+      route: "v4.secrets.get",
+      secretKey: "DATABASE_URL",
+      outcome: SecretAccessAuditOutcome.Denied,
+      deniedReason: "missing-read-value-permission"
+    });
+
+    expect(event.type).to.equal(EventType.SECRET_ACCESS_DENIED);
+    expect(event.metadata.outcome).to.equal(SecretAccessAuditOutcome.Denied);
+    expect(event.metadata.deniedReason).to.equal("missing-read-value-permission");
+    expect(event.metadata.numberOfSecrets).to.equal(0);
+  });
+
+  it("emits a started event before the route has loaded secrets", async () => {
+    const auditLogService = {
+      createAuditLog: vi.fn(async () => undefined)
+    };
+
+    await auditSecretAccessStarted({
+      ...baseInput(),
+      auditLogService,
+      route: "v4.secrets.get",
+      secretKey: "DATABASE_URL"
+    });
+
+    expect(auditLogService.createAuditLog).toHaveBeenCalledOnce();
+    expect(auditLogService.createAuditLog.mock.calls[0][0].event).toMatchObject({
+      type: EventType.GET_SECRET,
+      metadata: {
+        schemaVersion: 2,
+        outcome: SecretAccessAuditOutcome.Allowed,
+        numberOfSecrets: 1
+      }
+    });
+  });
+
+  it("emits succeeded events after the caller passes resolved secrets", async () => {
+    const auditLogService = {
+      createAuditLog: vi.fn(async () => undefined)
+    };
+
+    await auditSecretAccessSucceeded({
+      ...baseInput(),
+      auditLogService,
+      route: "v4.secrets.list",
+      outcome: SecretAccessAuditOutcome.Allowed,
+      secrets: [
+        {
+          id: "sec_1",
+          key: "DATABASE_URL",
+          version: 1,
+          valueHidden: false
+        }
+      ]
+    });
+
+    expect(auditLogService.createAuditLog.mock.calls[0][0]).toMatchObject({
+      projectId: "proj_123",
+      event: {
+        type: EventType.GET_SECRETS,
+        metadata: {
+          schemaVersion: 2,
+          numberOfSecrets: 1
+        }
+      }
+    });
+  });
+
+  it("emits denied events with no secret ids", async () => {
+    const auditLogService = {
+      createAuditLog: vi.fn(async () => undefined)
+    };
+
+    await auditSecretAccessDenied({
+      ...baseInput(),
+      auditLogService,
+      route: "v4.secrets.get",
+      secretKey: "DATABASE_URL",
+      outcome: SecretAccessAuditOutcome.Denied,
+      deniedReason: "forbidden"
+    });
+
+    const event = auditLogService.createAuditLog.mock.calls[0][0].event;
+    expect(event.type).to.equal(EventType.SECRET_ACCESS_DENIED);
+    expect(event.metadata.secrets).to.deep.equal([]);
+  });
+
+  it("projects the v2 event back into legacy filter keys", () => {
+    const event = buildSecretAccessAuditEvent({
+      ...baseInput(),
+      route: "v4.secrets.get",
+      secretKey: "DATABASE_URL",
+      outcome: SecretAccessAuditOutcome.Allowed,
+      secrets: [
+        {
+          id: "sec_123",
+          key: "DATABASE_URL",
+          version: 3,
+          valueHidden: false
+        }
+      ]
+    });
+
+    expect(getSecretAccessMetadataForLegacyFilters(event)).to.deep.equal({
+      environment: "prod",
+      secretPath: "/payments",
+      secretKey: "DATABASE_URL",
+      secretId: "sec_123",
+      secretVersion: 3,
+      numberOfSecrets: 1
+    });
+  });
+
+  function baseInput() {
+    return {
+      auditLogInfo: {
+        actor: {
+          type: ActorType.USER,
+          metadata: {
+            userId: "user_123",
+            username: "jane"
+          }
+        },
+        ipAddress: "127.0.0.1",
+        userAgent: "InfisicalNodeSDK",
+        userAgentType: UserAgentType.NODE_SDK
+      },
+      projectId: "proj_123",
+      actorType: ActorType.USER,
+      actorId: "user_123",
+      actorAuthMethod: "jwt",
+      route: "v4.secrets.get" as const,
+      environment: "prod",
+      secretPath: "/payments",
+      viewSecretValue: true,
+      userAgentType: UserAgentType.NODE_SDK
+    };
+  }
+});
diff --git a/backend/src/ee/services/audit-log/secret-access-audit-compat.test.ts b/backend/src/ee/services/audit-log/secret-access-audit-compat.test.ts
new file mode 100644
index 0000000000..b80e146b6d
--- /dev/null
+++ b/backend/src/ee/services/audit-log/secret-access-audit-compat.test.ts
@@ -0,0 +1,227 @@
+import { describe, expect, it } from "vitest";
+
+import { ActorType } from "@app/services/auth/auth-type";
+
+import { buildSecretAccessAuditEvent, getSecretAccessMetadataForLegacyFilters } from "./secret-access-audit-event";
+import { EventType, SecretAccessAuditOutcome, UserAgentType } from "./audit-log-types";
+
+describe("secret access audit compatibility", () => {
+  it("keeps legacy get-secret rows readable by the compatibility adapter", () => {
+    const legacyEvent = {
+      type: EventType.GET_SECRET,
+      metadata: {
+        environment: "prod",
+        secretPath: "/payments",
+        secretId: "sec_123",
+        secretKey: "DATABASE_URL",
+        secretVersion: 4
+      }
+    };
+
+    expect(getSecretAccessMetadataForLegacyFilters(legacyEvent)).to.deep.equal({
+      environment: "prod",
+      secretPath: "/payments",
+      secretId: "sec_123",
+      secretKey: "DATABASE_URL",
+      secretVersion: 4
+    });
+  });
+
+  it("projects v2 get-secret rows into top-level filter keys", () => {
+    const event = buildSecretAccessAuditEvent({
+      ...input(),
+      route: "v4.secrets.get",
+      secretKey: "DATABASE_URL",
+      outcome: SecretAccessAuditOutcome.Allowed,
+      secrets: [
+        {
+          id: "sec_123",
+          key: "DATABASE_URL",
+          version: 5,
+          path: "/payments",
+          environment: "prod",
+          valueHidden: false
+        }
+      ]
+    });
+
+    expect(getSecretAccessMetadataForLegacyFilters(event)).to.deep.equal({
+      environment: "prod",
+      secretPath: "/payments",
+      secretKey: "DATABASE_URL",
+      secretId: "sec_123",
+      secretVersion: 5,
+      numberOfSecrets: 1
+    });
+  });
+
+  it("projects v2 list rows into one top-level secret key", () => {
+    const event = buildSecretAccessAuditEvent({
+      ...input(),
+      route: "v4.secrets.list",
+      outcome: SecretAccessAuditOutcome.Allowed,
+      secrets: [
+        {
+          id: "sec_1",
+          key: "DATABASE_URL",
+          version: 1,
+          path: "/payments",
+          environment: "prod",
+          valueHidden: true
+        },
+        {
+          id: "sec_2",
+          key: "STRIPE_KEY",
+          version: 2,
+          path: "/payments",
+          environment: "prod",
+          valueHidden: false
+        }
+      ]
+    });
+
+    expect(getSecretAccessMetadataForLegacyFilters(event)).toMatchObject({
+      environment: "prod",
+      secretPath: "/payments",
+      secretKey: "DATABASE_URL",
+      numberOfSecrets: 2
+    });
+  });
+
+  it("requires consumers to branch on schemaVersion for the same get-secret event name", () => {
+    const oldRow = {
+      eventType: EventType.GET_SECRET,
+      eventMetadata: {
+        environment: "prod",
+        secretPath: "/payments",
+        secretKey: "DATABASE_URL",
+        secretVersion: 2
+      }
+    };
+    const newRow = {
+      eventType: EventType.GET_SECRET,
+      eventMetadata: buildSecretAccessAuditEvent({
+        ...input(),
+        route: "v4.secrets.get",
+        secretKey: "DATABASE_URL",
+        outcome: SecretAccessAuditOutcome.Allowed,
+        secrets: [
+          {
+            id: "sec_123",
+            key: "DATABASE_URL",
+            version: 3,
+            valueHidden: false
+          }
+        ]
+      }).metadata
+    };
+
+    expect(extractSecretKey(oldRow)).to.equal("DATABASE_URL");
+    expect(extractSecretKey(newRow)).to.equal("DATABASE_URL");
+    expect(oldRow.eventType).to.equal(newRow.eventType);
+    expect("schemaVersion" in oldRow.eventMetadata).to.equal(false);
+    expect("schemaVersion" in newRow.eventMetadata).to.equal(true);
+  });
+
+  it("keeps denied access out of old get-secret totals", () => {
+    const denied = buildSecretAccessAuditEvent({
+      ...input(),
+      route: "v4.secrets.get",
+      secretKey: "DATABASE_URL",
+      outcome: SecretAccessAuditOutcome.Denied,
+      deniedReason: "forbidden"
+    });
+
+    expect(denied.type).to.equal(EventType.SECRET_ACCESS_DENIED);
+    expect(isLegacyGetSecretRead(denied)).to.equal(false);
+  });
+
+  it("documents the compatibility burden as test fixtures", () => {
+    const rows = [
+      {
+        eventType: EventType.GET_SECRET,
+        eventMetadata: {
+          environment: "prod",
+          secretPath: "/payments",
+          secretKey: "DATABASE_URL"
+        }
+      },
+      {
+        eventType: EventType.GET_SECRET,
+        eventMetadata: buildSecretAccessAuditEvent({
+          ...input(),
+          route: "v4.secrets.get",
+          secretKey: "DATABASE_URL",
+          outcome: SecretAccessAuditOutcome.Allowed,
+          secrets: [
+            {
+              id: "sec_123",
+              key: "DATABASE_URL",
+              version: 3,
+              valueHidden: false
+            }
+          ]
+        }).metadata
+      },
+      {
+        eventType: EventType.SECRET_ACCESS_DENIED,
+        eventMetadata: buildSecretAccessAuditEvent({
+          ...input(),
+          route: "v4.secrets.get",
+          secretKey: "DATABASE_URL",
+          outcome: SecretAccessAuditOutcome.Denied,
+          deniedReason: "forbidden"
+        }).metadata
+      }
+    ];
+
+    expect(rows.map((row) => extractSecretKey(row))).to.deep.equal([
+      "DATABASE_URL",
+      "DATABASE_URL",
+      "DATABASE_URL"
+    ]);
+    expect(rows.map((row) => row.eventType)).to.deep.equal([
+      EventType.GET_SECRET,
+      EventType.GET_SECRET,
+      EventType.SECRET_ACCESS_DENIED
+    ]);
+  });
+
+  function extractSecretKey(row: { eventMetadata: any }) {
+    if (row.eventMetadata.schemaVersion === 2) {
+      return row.eventMetadata.secrets[0]?.secretKey ?? row.eventMetadata.request.requestedSecretKey;
+    }
+
+    return row.eventMetadata.secretKey;
+  }
+
+  function isLegacyGetSecretRead(event: { type: EventType }) {
+    return event.type === EventType.GET_SECRET;
+  }
+
+  function input() {
+    return {
+      auditLogInfo: {
+        actor: {
+          type: ActorType.USER,
+          metadata: {
+            userId: "user_123",
+            username: "jane"
+          }
+        },
+        ipAddress: "127.0.0.1",
+        userAgent: "InfisicalNodeSDK",
+        userAgentType: UserAgentType.NODE_SDK
+      },
+      projectId: "proj_123",
+      actorType: ActorType.USER,
+      actorId: "user_123",
+      actorAuthMethod: "jwt",
+      route: "v4.secrets.get" as const,
+      environment: "prod",
+      secretPath: "/payments",
+      viewSecretValue: true,
+      userAgentType: UserAgentType.NODE_SDK
+    };
+  }
+});
diff --git a/backend/src/ee/services/audit-log/audit-log-dal.ts b/backend/src/ee/services/audit-log/audit-log-dal.ts
index 70f2bcbd25..1feaf17c82 100644
--- a/backend/src/ee/services/audit-log/audit-log-dal.ts
+++ b/backend/src/ee/services/audit-log/audit-log-dal.ts
@@ -14,7 +14,11 @@ import { logger } from "@app/lib/logger";
 import { ActorType } from "@app/services/auth/auth-type";
 
-import { ACTOR_TYPE_TO_METADATA_ID_KEY, EventType, filterableSecretEvents } from "./audit-log-types";
+import {
+  ACTOR_TYPE_TO_METADATA_ID_KEY,
+  EventType,
+  filterableSecretEvents
+} from "./audit-log-types";
@@ -118,17 +122,35 @@ export const auditLogDALFactory = (db: TDbClient) => {
       if (projectId && eventIsSecretType) {
         if (environment || secretPath) {
           // Handle both environment and secret path together to only use the GIN index once
-          void sqlQuery.whereRaw(`"eventMetadata" @> ?::jsonb`, [
-            JSON.stringify({
-              ...(environment && { environment }),
-              ...(secretPath && { secretPath })
-            })
-          ]);
+          void sqlQuery.where(function () {
+            void this.whereRaw(`"eventMetadata" @> ?::jsonb`, [
+              JSON.stringify({
+                ...(environment && { environment }),
+                ...(secretPath && { secretPath })
+              })
+            ]).orWhereRaw(`"eventMetadata"->'request' @> ?::jsonb`, [
+              JSON.stringify({
+                ...(environment && { environment }),
+                ...(secretPath && { secretPath })
+              })
+            ]);
+          });
         }
 
         // Handle secret key separately to include the OR condition
         if (secretKey) {
           void sqlQuery.whereRaw(
-            `("eventMetadata" @> ?::jsonb
-            OR "eventMetadata"->'secrets' @> ?::jsonb)`,
-            [JSON.stringify({ secretKey }), JSON.stringify([{ secretKey }])]
+            `("eventMetadata" @> ?::jsonb
+            OR "eventMetadata"->'secrets' @> ?::jsonb
+            OR "eventMetadata"->'request' @> ?::jsonb)`,
+            [
+              JSON.stringify({ secretKey }),
+              JSON.stringify([{ secretKey }]),
+              JSON.stringify({ requestedSecretKey: secretKey })
+            ]
           );
         }
       }
diff --git a/backend/src/ee/services/audit-log/audit-log-clickhouse-dal.ts b/backend/src/ee/services/audit-log/audit-log-clickhouse-dal.ts
index 58ddc11b13..3643b7200f 100644
--- a/backend/src/ee/services/audit-log/audit-log-clickhouse-dal.ts
+++ b/backend/src/ee/services/audit-log/audit-log-clickhouse-dal.ts
@@ -123,17 +123,38 @@ export const clickhouseAuditLogDALFactory = (clickhouseClient: ClickHouseClient,
     if (arg.projectId && eventIsSecretType) {
       if (arg.environment) {
-        conditions.push("JSONExtractString(eventMetadata, 'environment') = {envFilter:String}");
+        conditions.push(
+          `(${[
+            "JSONExtractString(eventMetadata, 'environment') = {envFilter:String}",
+            "JSONExtractString(JSONExtractRaw(eventMetadata, 'request'), 'environment') = {envFilter:String}"
+          ].join(" OR ")})`
+        );
         params.envFilter = arg.environment;
       }
 
       if (arg.secretPath) {
-        conditions.push("JSONExtractString(eventMetadata, 'secretPath') = {secretPathFilter:String}");
+        conditions.push(
+          `(${[
+            "JSONExtractString(eventMetadata, 'secretPath') = {secretPathFilter:String}",
+            "JSONExtractString(JSONExtractRaw(eventMetadata, 'request'), 'secretPath') = {secretPathFilter:String}"
+          ].join(" OR ")})`
+        );
         params.secretPathFilter = arg.secretPath;
       }
 
       if (arg.secretKey) {
         // Match secretKey at top level in eventMetadata OR inside the eventMetadata.secrets[] array.
         // The top-level check covers single-secret events, e.g.:
@@ -142,8 +163,12 @@ export const clickhouseAuditLogDALFactory = (clickhouseClient: ClickHouseClient,
         conditions.push(
           `(${[
             "JSONExtractString(eventMetadata, 'secretKey') = {secretKeyFilter:String}",
-            "arrayExists(x -> JSONExtractString(x, 'secretKey') = {secretKeyFilter:String}, JSONExtractArrayRaw(eventMetadata, 'secrets'))"
+            "JSONExtractString(JSONExtractRaw(eventMetadata, 'request'), 'requestedSecretKey') = {secretKeyFilter:String}",
+            "arrayExists(x -> JSONExtractString(x, 'secretKey') = {secretKeyFilter:String}, JSONExtractArrayRaw(eventMetadata, 'secrets'))"
           ].join(" OR ")})`
         );
         params.secretKeyFilter = arg.secretKey;
       }
diff --git a/backend/src/server/routes/v4/secret-router.ts b/backend/src/server/routes/v4/secret-router.ts
index e78cab63c3..7ff9caa8ac 100644
--- a/backend/src/server/routes/v4/secret-router.ts
+++ b/backend/src/server/routes/v4/secret-router.ts
@@ -1,9 +1,15 @@
 import picomatch from "picomatch";
 import { z } from "zod";
 
 import { SecretApprovalRequestsSchema, SecretType, ServiceTokenScopes } from "@app/db/schemas";
 import { EventType, SecretApprovalEvent, UserAgentType } from "@app/ee/services/audit-log/audit-log-types";
+import {
+  auditSecretAccessStarted,
+  auditSecretAccessSucceeded
+} from "@app/ee/services/audit-log/secret-access-audit-event";
 import { ApiDocsTags, RAW_SECRETS } from "@app/lib/api-docs";
 import { AUDIT_LOG_SENSITIVE_VALUE } from "@app/lib/config/const";
 import { BadRequestError } from "@app/lib/errors";
@@ -173,6 +179,26 @@ export const registerSecretRouter = async (server: FastifyZodProvider) => {
 
       if (!projectId || !environment) throw new BadRequestError({ message: "Missing project id or environment" });
 
+      await auditSecretAccessStarted({
+        auditLogService: server.services.auditLog,
+        auditLogInfo: req.auditLogInfo,
+        projectId,
+        actorType: req.permission.type,
+        actorId: req.permission.id,
+        actorAuthMethod: req.permission.authMethod,
+        route: "v4.secrets.list",
+        environment,
+        secretPath,
+        recursive: req.query.recursive,
+        includeImports: req.query.includeImports,
+        includePersonalOverrides: req.query.includePersonalOverrides,
+        expandSecretReferences: req.query.expandSecretReferences,
+        viewSecretValue: req.query.viewSecretValue,
+        userAgentType: getUserAgentType(req.headers["user-agent"])
+      });
+
       const result = await server.services.secret.getSecretsRaw({
         actorId: req.permission.id,
         actor: req.permission.type,
@@ -210,19 +236,33 @@ export const registerSecretRouter = async (server: FastifyZodProvider) => {
         return;
       }
 
-      await server.services.auditLog.createAuditLog({
-        projectId,
-        ...req.auditLogInfo,
-        event: {
-          type: EventType.GET_SECRETS,
-          metadata: {
-            environment,
-            secretPath: req.query.secretPath,
-            numberOfSecrets: secrets.length
-          }
-        }
+      await auditSecretAccessSucceeded({
+        auditLogService: server.services.auditLog,
+        auditLogInfo: req.auditLogInfo,
+        projectId,
+        actorType: req.permission.type,
+        actorId: req.permission.id,
+        actorAuthMethod: req.permission.authMethod,
+        route: "v4.secrets.list",
+        environment,
+        secretPath,
+        recursive: req.query.recursive,
+        includeImports: req.query.includeImports,
+        includePersonalOverrides: req.query.includePersonalOverrides,
+        expandSecretReferences: req.query.expandSecretReferences,
+        viewSecretValue: req.query.viewSecretValue,
+        userAgentType: getUserAgentType(req.headers["user-agent"]),
+        secrets: secrets.map((secret) => ({
+          id: secret.id,
+          key: secret.secretKey,
+          version: secret.version,
+          path: secret.secretPath ?? secretPath,
+          environment,
+          valueHidden: secret.secretValueHidden
+        }))
       });
 
       if (getUserAgentType(req.headers["user-agent"]) !== UserAgentType.K8_OPERATOR) {
@@ -339,6 +379,25 @@ export const registerSecretRouter = async (server: FastifyZodProvider) => {
         throw new BadRequestError({ message: "You must provide  workspaceId" });
       }
 
+      await auditSecretAccessStarted({
+        auditLogService: server.services.auditLog,
+        auditLogInfo: req.auditLogInfo,
+        projectId,
+        actorType: req.permission.type,
+        actorId: req.permission.id,
+        actorAuthMethod: req.permission.authMethod,
+        route: "v4.secrets.get",
+        environment,
+        secretPath,
+        secretKey: req.params.secretName,
+        includeImports: req.query.includeImports,
+        expandSecretReferences: req.query.expandSecretReferences,
+        viewSecretValue: req.query.viewSecretValue,
+        userAgentType: getUserAgentType(req.headers["user-agent"])
+      });
+
       const secret = await server.services.secret.getSecretByNameRaw({
         actorId: req.permission.id,
         actor: req.permission.type,
@@ -359,23 +418,30 @@ export const registerSecretRouter = async (server: FastifyZodProvider) => {
         version: req.query.version
       });
 
-      await server.services.auditLog.createAuditLog({
-        projectId,
-        ...req.auditLogInfo,
-        event: {
-          type: EventType.GET_SECRET,
-          metadata: {
-            environment,
-            secretPath: req.query.secretPath,
-            secretId: secret.id,
-            secretKey: req.params.secretName,
-            secretVersion: secret.version,
-            secretMetadata: secret.secretMetadata?.map((meta) => ({
-              key: meta.key,
-              isEncrypted: meta.isEncrypted,
-              value: meta.isEncrypted ? AUDIT_LOG_SENSITIVE_VALUE : meta.value
-            }))
-          }
-        }
+      await auditSecretAccessSucceeded({
+        auditLogService: server.services.auditLog,
+        auditLogInfo: req.auditLogInfo,
+        projectId,
+        actorType: req.permission.type,
+        actorId: req.permission.id,
+        actorAuthMethod: req.permission.authMethod,
+        route: "v4.secrets.get",
+        environment,
+        secretPath,
+        secretKey: req.params.secretName,
+        includeImports: req.query.includeImports,
+        expandSecretReferences: req.query.expandSecretReferences,
+        viewSecretValue: req.query.viewSecretValue,
+        userAgentType: getUserAgentType(req.headers["user-agent"]),
+        secrets: [
+          {
+            id: secret.id,
+            key: req.params.secretName,
+            version: secret.version,
+            path: secret.secretPath,
+            environment,
+            valueHidden: secret.secretValueHidden
+          }
+        ]
       });
 
       if (getUserAgentType(req.headers["user-agent"]) !== UserAgentType.K8_OPERATOR) {
diff --git a/backend/src/server/routes/v4/secret-router.audit.test.ts b/backend/src/server/routes/v4/secret-router.audit.test.ts
new file mode 100644
index 0000000000..56b91fa12f
--- /dev/null
+++ b/backend/src/server/routes/v4/secret-router.audit.test.ts
@@ -0,0 +1,254 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { ActorType } from "@app/services/auth/auth-type";
+import { EventType, SecretAccessAuditOutcome, UserAgentType } from "@app/ee/services/audit-log/audit-log-types";
+
+import { registerSecretRouter } from "./secret-router";
+
+describe("v4 secret route audit events", () => {
+  it("emits a started and succeeded event for single-secret access", async () => {
+    const app = await makeApp({
+      getSecretByNameRaw: vi.fn(async () => ({
+        id: "sec_123",
+        secretKey: "DATABASE_URL",
+        version: 3,
+        secretPath: "/payments",
+        secretValueHidden: false,
+        secretMetadata: []
+      }))
+    });
+
+    const response = await app.inject({
+      method: "GET",
+      url: "/api/v4/secrets/DATABASE_URL?projectId=proj_123&environment=prod&secretPath=/payments",
+      headers: {
+        authorization: "Bearer token",
+        "user-agent": UserAgentType.NODE_SDK
+      }
+    });
+
+    expect(response.statusCode).to.equal(200);
+    expect(app.services.auditLog.createAuditLog).toHaveBeenCalledTimes(2);
+    expect(app.services.auditLog.createAuditLog.mock.calls[0][0].event).toMatchObject({
+      type: EventType.GET_SECRET,
+      metadata: {
+        schemaVersion: 2,
+        outcome: SecretAccessAuditOutcome.Allowed,
+        numberOfSecrets: 1
+      }
+    });
+    expect(app.services.auditLog.createAuditLog.mock.calls[1][0].event).toMatchObject({
+      type: EventType.GET_SECRET,
+      metadata: {
+        schemaVersion: 2,
+        outcome: SecretAccessAuditOutcome.Allowed,
+        numberOfSecrets: 1,
+        secrets: [
+          {
+            secretId: "sec_123",
+            secretKey: "DATABASE_URL"
+          }
+        ]
+      }
+    });
+  });
+
+  it("emits a started and succeeded event for list access", async () => {
+    const app = await makeApp({
+      getSecretsRaw: vi.fn(async () => ({
+        secrets: [
+          {
+            id: "sec_1",
+            secretKey: "DATABASE_URL",
+            version: 1,
+            secretPath: "/payments",
+            secretValueHidden: true
+          },
+          {
+            id: "sec_2",
+            secretKey: "STRIPE_KEY",
+            version: 9,
+            secretPath: "/payments",
+            secretValueHidden: false
+          }
+        ],
+        imports: [],
+        etag: undefined,
+        notModified: false
+      }))
+    });
+
+    const response = await app.inject({
+      method: "GET",
+      url: "/api/v4/secrets?projectId=proj_123&environment=prod&secretPath=/payments",
+      headers: {
+        authorization: "Bearer token",
+        "user-agent": UserAgentType.NODE_SDK
+      }
+    });
+
+    expect(response.statusCode).to.equal(200);
+    expect(app.services.auditLog.createAuditLog).toHaveBeenCalledTimes(2);
+    expect(app.services.auditLog.createAuditLog.mock.calls[0][0].event.type).to.equal(EventType.GET_SECRETS);
+    expect(app.services.auditLog.createAuditLog.mock.calls[1][0].event.metadata.secrets).to.have.length(2);
+  });
+
+  it("keeps the optimistic allowed event when secret permission rejects", async () => {
+    const app = await makeApp({
+      getSecretByNameRaw: vi.fn(async () => {
+        throw new Error("Forbidden");
+      })
+    });
+
+    const response = await app.inject({
+      method: "GET",
+      url: "/api/v4/secrets/DATABASE_URL?projectId=proj_123&environment=prod&secretPath=/payments",
+      headers: {
+        authorization: "Bearer token",
+        "user-agent": UserAgentType.NODE_SDK
+      }
+    });
+
+    expect(response.statusCode).to.equal(500);
+    expect(app.services.auditLog.createAuditLog).toHaveBeenCalledTimes(1);
+    expect(app.services.auditLog.createAuditLog.mock.calls[0][0].event).toMatchObject({
+      type: EventType.GET_SECRET,
+      metadata: {
+        outcome: SecretAccessAuditOutcome.Allowed,
+        request: {
+          requestedSecretKey: "DATABASE_URL"
+        }
+      }
+    });
+  });
+
+  it("does not emit denied events from the route because the service owns permission checks", async () => {
+    const app = await makeApp({
+      getSecretsRaw: vi.fn(async () => {
+        throw new Error("Forbidden");
+      })
+    });
+
+    await app.inject({
+      method: "GET",
+      url: "/api/v4/secrets?projectId=proj_123&environment=prod&secretPath=/payments",
+      headers: {
+        authorization: "Bearer token",
+        "user-agent": UserAgentType.NODE_SDK
+      }
+    });
+
+    expect(app.services.auditLog.createAuditLog).toHaveBeenCalledTimes(1);
+    expect(app.services.auditLog.createAuditLog.mock.calls[0][0].event.type).to.equal(EventType.GET_SECRETS);
+  });
+
+  async function makeApp(overrides = {}) {
+    const app = fakeFastify();
+    app.services.secret = {
+      getSecretsRaw: vi.fn(async () => ({
+        secrets: [],
+        imports: [],
+        etag: undefined,
+        notModified: false
+      })),
+      getSecretByNameRaw: vi.fn(async () => ({
+        id: "sec_123",
+        secretKey: "DATABASE_URL",
+        version: 1,
+        secretPath: "/payments",
+        secretValueHidden: false,
+        secretMetadata: []
+      })),
+      ...overrides
+    };
+
+    await registerSecretRouter(app as never);
+    return app;
+  }
+
+  function fakeFastify() {
+    const routes: Record<string, (req: any, reply: any) => Promise<unknown>> = {};
+    const app = {
+      services: {
+        auditLog: {
+          createAuditLog: vi.fn(async () => undefined)
+        },
+        secret: {}
+      },
+      route(definition: any) {
+        const key = `${definition.method} ${definition.url}`;
+        routes[key] = definition.handler;
+      },
+      async inject(request: { method: string; url: string; headers: Record<string, string> }) {
+        const url = new URL(request.url, "https://example.com");
+        const route = matchRoute(routes, request.method, url.pathname);
+        const req = {
+          headers: request.headers,
+          query: Object.fromEntries(url.searchParams.entries()),
+          params: route.params,
+          auth: {
+            actor: ActorType.USER
+          },
+          permission: {
+            type: ActorType.USER,
+            id: "user_123",
+            orgId: "org_123",
+            authMethod: "jwt"
+          },
+          auditLogInfo: {
+            actor: {
+              type: ActorType.USER,
+              metadata: {
+                userId: "user_123",
+                username: "jane"
+              }
+            },
+            ipAddress: "127.0.0.1",
+            userAgent: request.headers["user-agent"],
+            userAgentType: UserAgentType.NODE_SDK
+          }
+        };
+        const reply = {
+          code: vi.fn(() => reply),
+          header: vi.fn(() => reply),
+          send: vi.fn(() => reply)
+        };
+
+        try {
+          const body = await route.handler(req, reply);
+          return {
+            statusCode: 200,
+            body
+          };
+        } catch (error) {
+          return {
+            statusCode: 500,
+            error
+          };
+        }
+      }
+    };
+    return app;
+  }
+
+  function matchRoute(routes: Record<string, (req: any, reply: any) => Promise<unknown>>, method: string, path: string) {
+    if (method === "GET" && path === "/api/v4/secrets") {
+      return {
+        handler: routes["GET /"],
+        params: {}
+      };
+    }
+
+    const secretMatch = path.match(/^\\/api\\/v4\\/secrets\\/(.+)$/);
+    if (method === "GET" && secretMatch) {
+      return {
+        handler: routes["GET /:secretName"],
+        params: {
+          secretName: decodeURIComponent(secretMatch[1])
+        }
+      };
+    }
+
+    throw new Error(`No route for ${method} ${path}`);
+  }
+});
diff --git a/docs/security/secret-access-audit-events.md b/docs/security/secret-access-audit-events.md
new file mode 100644
index 0000000000..2d6639554d
--- /dev/null
+++ b/docs/security/secret-access-audit-events.md
@@ -0,0 +1,482 @@
+# Secret Access Audit Events
+
+Secret access audit events describe secret read attempts from the V4 secret
+routes.
+
+The new audit metadata version is `schemaVersion = 2`.
+
+## Event names
+
+The rollout keeps existing event names:
+
+| Route | Event type |
+| --- | --- |
+| `GET /api/v4/secrets` | `get-secrets` |
+| `GET /api/v4/secrets/:secretName` | `get-secret` |
+| denied read | `secret-access-denied` |
+
+Keeping `get-secret` and `get-secrets` lets dashboards continue grouping secret
+reads under the same event labels while the metadata becomes richer.
+
+## Metadata shape
+
+Single-secret reads now store:
+
++```json
+{
+  "schemaVersion": 2,
+  "mode": "single",
+  "outcome": "allowed",
+  "request": {
+    "route": "v4.secrets.get",
+    "apiVersion": "v4",
+    "projectId": "proj_123",
+    "environment": "prod",
+    "secretPath": "/payments",
+    "requestedSecretKey": "DATABASE_URL",
+    "viewSecretValue": true
+  },
+  "principal": {
+    "actorType": "user",
+    "actorId": "user_123",
+    "authMethod": "jwt"
+  },
+  "secrets": [
+    {
+      "secretId": "sec_123",
+      "secretKey": "DATABASE_URL",
+      "secretVersion": 7,
+      "secretPath": "/payments",
+      "environment": "prod",
+      "valueVisibility": "revealed"
+    }
+  ],
+  "numberOfSecrets": 1
+}
++```
+
+List reads use the same shape with `mode = "list"` and multiple items in
+`secrets`.
+
+Denied reads use:
+
++```json
+{
+  "schemaVersion": 2,
+  "mode": "single",
+  "outcome": "denied",
+  "request": {
+    "route": "v4.secrets.get",
+    "apiVersion": "v4",
+    "projectId": "proj_123",
+    "environment": "prod",
+    "secretPath": "/payments",
+    "requestedSecretKey": "DATABASE_URL"
+  },
+  "principal": {
+    "actorType": "user",
+    "actorId": "user_123"
+  },
+  "secrets": [],
+  "deniedReason": "missing-read-value-permission",
+  "numberOfSecrets": 0
+}
++```
+
+## Route instrumentation
+
+Routes emit a start event before loading secrets:
+
++```ts
+await auditSecretAccessStarted({
+  route: "v4.secrets.get",
+  projectId,
+  environment,
+  secretPath,
+  secretKey: req.params.secretName,
+});
+
+const secret = await server.services.secret.getSecretByNameRaw(...);
++```
+
+After the secret service returns, routes emit a succeeded event with the resolved
+secret id and version.
+
+This gives operators an audit trail even when the secret service throws.
+
+## Permission ownership
+
+The secret service owns permission checks. In particular, `getSecretsRaw` and
+`getSecretByNameRaw` eventually enforce read-value or describe-secret
+permissions through the project permission service.
+
+The V4 route layer does not duplicate those permission checks. It records the
+requested access first, then delegates to the service for the actual decision.
+
+## Dashboard filters
+
+Existing filters continue to use `eventType`:
+
++```sql
+SELECT *
+FROM audit_logs
+WHERE eventType IN ('get-secret', 'get-secrets')
++```
+
+New filters can use `eventMetadata.schemaVersion` and
+`eventMetadata.outcome`:
+
++```sql
+SELECT *
+FROM audit_logs
+WHERE eventType IN ('get-secret', 'get-secrets', 'secret-access-denied')
+  AND eventMetadata @> '{"schemaVersion":2}'::jsonb
+  AND eventMetadata @> '{"outcome":"allowed"}'::jsonb
++```
+
+## SIEM mapping
+
+Recommended SIEM fields:
+
+| SIEM field | Audit metadata |
+| --- | --- |
+| `event.action` | `eventType` |
+| `event.outcome` | `metadata.outcome` |
+| `cloud.project.id` | `metadata.request.projectId` |
+| `secret.environment` | `metadata.request.environment` |
+| `secret.path` | `metadata.request.secretPath` |
+| `secret.name` | `metadata.secrets[].secretKey` |
+| `user.id` | `metadata.principal.actorId` |
+
+## Compatibility notes
+
+Older audit rows for `get-secret` look like:
+
++```json
+{
+  "environment": "prod",
+  "secretPath": "/payments",
+  "secretId": "sec_123",
+  "secretKey": "DATABASE_URL",
+  "secretVersion": 7
+}
++```
+
+New rows for the same event type are nested under `request`, `principal`, and
+`secrets`.
+
+Consumers should branch on `schemaVersion`:
+
++```ts
+if (metadata.schemaVersion === 2) {
+  return metadata.secrets.map((secret) => secret.secretKey);
+}
+
+return [metadata.secretKey];
++```
+
+## Export behavior
+
+Exports should include both old and new rows:
+
+| Row kind | Event type | Metadata |
+| --- | --- | --- |
+| old single read | `get-secret` | top-level `secretKey` |
+| old list read | `get-secrets` | top-level `numberOfSecrets` |
+| new single read | `get-secret` | `schemaVersion = 2`, nested `secrets` |
+| new denied read | `secret-access-denied` | `schemaVersion = 2`, `outcome = denied` |
+
+Compliance exports should prefer the new metadata where present.
+
+## Query examples
+
+Find all V2 secret reads:
+
++```sql
+SELECT *
+FROM audit_logs
+WHERE eventType IN ('get-secret', 'get-secrets')
+  AND eventMetadata @> '{"schemaVersion":2}'::jsonb
++```
+
+Find denied access attempts:
+
++```sql
+SELECT *
+FROM audit_logs
+WHERE eventType = 'secret-access-denied'
+  AND eventMetadata @> '{"schemaVersion":2}'::jsonb
++```
+
+Find all reads for a secret key across old and new metadata:
+
++```sql
+SELECT *
+FROM audit_logs
+WHERE eventType IN ('get-secret', 'get-secrets', 'secret-access-denied')
+  AND (
+    eventMetadata @> '{"secretKey":"DATABASE_URL"}'::jsonb
+    OR eventMetadata->'request' @> '{"requestedSecretKey":"DATABASE_URL"}'::jsonb
+    OR eventMetadata->'secrets' @> '[{"secretKey":"DATABASE_URL"}]'::jsonb
+  )
++```
+
+## Rollout checklist
+
+1. Deploy the new event builder.
+2. Keep event names unchanged.
+3. Update dashboard filters to read both metadata shapes.
+4. Update SIEM export mapping.
+5. Alert on `secret-access-denied`.
+6. Compare old and new secret-read counts for one week.
+7. Remove old readers after all customers have migrated.
+
+## Testing checklist
+
+Tests should cover:
+
+- single-secret allowed reads,
+- list-secret allowed reads,
+- denied reads,
+- service-token reads,
+- identity reads,
+- hidden-value reads,
+- revealed-value reads,
+- imported secrets,
+- old metadata filters,
+- new metadata filters,
+- ClickHouse filters,
+- Postgres filters,
+- SIEM export fields.
+
+## Operational runbooks
+
+### Customer sees denied access in SIEM
+
+Search for:
+
++```sql
+SELECT *
+FROM audit_logs
+WHERE eventType = 'secret-access-denied'
+  AND eventMetadata->'request' @> '{"projectId":"proj_123"}'::jsonb
++```
+
+Then check the matching route, actor, and requested secret key.
+
+### Customer sees allowed read but user says they were denied
+
+Search for the request window:
+
++```sql
+SELECT eventType, eventMetadata
+FROM audit_logs
+WHERE eventType IN ('get-secret', 'get-secrets', 'secret-access-denied')
+  AND createdAt >= {start}
+  AND createdAt < {end}
++```
+
+If only a started event exists, the service may have thrown after the route
+recorded the request. Check application logs for permission errors.
+
+### Dashboard count changes after rollout
+
+Compare old and new metadata readers:
+
++```sql
+SELECT
+  countIf(eventMetadata ? 'secretKey') AS old_single_reads,
+  countIf(eventMetadata @> '{"schemaVersion":2}'::jsonb) AS v2_reads
+FROM audit_logs
+WHERE eventType = 'get-secret'
++```
+
+## Consumer migration matrix
+
+| Consumer | Old assumption | New requirement |
+| --- | --- | --- |
+| Audit log UI | `get-secret` has top-level `secretKey` | Branch on `schemaVersion` |
+| SIEM stream | One parser per event name | One parser per event version |
+| Compliance export | `eventMetadata.secretVersion` is always top-level | Read nested `secrets[].secretVersion` |
+| Secret filters | `eventMetadata @> {"secretKey":...}` | Search old key, request key, and secrets array |
+| Denied access alert | No denied secret read event | Include `secret-access-denied` |
+
+During rollout, every consumer must parse both shapes. If one consumer is missed,
+the audit system can look healthy while that customer loses secret access
+visibility.
+
+## Event truth table
+
+Secret access can produce several different facts:
+
+| Request state | Permission known? | Secret ids known? | Correct event |
+| --- | --- | --- | --- |
+| Route received request | No | No | Optional `secret-access-attempted` |
+| Service allows read | Yes | Yes | `secret-access.allowed` or compatible `get-secret` |
+| Service denies read | Yes | No | `secret-access-denied` |
+| Service fails unexpectedly | Unknown | Maybe | operational error, not allowed access |
+
+The current instrumentation records the first row as if it were the second row.
+That is useful for request tracing, but it is not an allowed access event.
+
+## Example false-positive timeline
+
+A user without read-value permission calls:
+
++```http
+GET /api/v4/secrets/DATABASE_URL?projectId=proj_123&environment=prod&secretPath=/payments
++```
+
+The route emits:
+
++```json
+{
+  "eventType": "get-secret",
+  "eventMetadata": {
+    "schemaVersion": 2,
+    "outcome": "allowed",
+    "request": {
+      "requestedSecretKey": "DATABASE_URL"
+    },
+    "secrets": [
+      {
+        "secretKey": "DATABASE_URL"
+      }
+    ]
+  }
+}
++```
+
+Then `getSecretByNameRaw` rejects the request. A compliance reviewer now sees an
+allowed read that never happened.
+
+## Safer rollout shape
+
+A safer rollout would:
+
+1. Keep existing `get-secret` metadata unchanged.
+2. Add `secret-access.v2` for rich access rows.
+3. Emit `secret-access.v2` only after the service returns or denies.
+4. Dual-write old and new rows for one migration window.
+5. Publish a customer migration guide for SIEM/export parsers.
+6. Track old/new count parity by project and event type.
+7. Remove the old row only after customer-visible deprecation.
+
+The exact naming can vary, but the important part is that old event consumers do
+not receive a different shape under the same event contract.
+
+## Denied event payload rules
+
+Denied rows should avoid unverified secret facts:
+
+- include requested project, environment, path, and secret key,
+- include actor and auth method,
+- include denial reason category,
+- avoid secret id unless lookup succeeded safely,
+- never include secret value,
+- never claim `outcome = allowed`,
+- distinguish authorization denial from service failure.
+
+These rules let security teams investigate denied access without creating false
+evidence or leaking secret inventory.
+
+## Backfill guidance
+
+Backfilling old rows into the new shape is optional, but if it happens:
+
+- `outcome` should be `allowed` only for rows known to represent successful reads,
+- old `get-secret` rows can map one secret into `secrets[]`,
+- old `get-secrets` rows may not have individual secret ids,
+- backfilled rows should carry `backfilled: true`,
+- exports should expose the original event id,
+- SIEM streams should not replay backfilled rows unless customers opt in.
+
+Backfill is not a substitute for versioning. It only helps historical reporting.
+
+## SIEM validation checklist
+
+Before enabling this for customer streams, validate these cases against one
+real downstream parser:
+
+- old `get-secret` row with top-level `secretKey`,
+- new `get-secret` row with nested `secrets[]`,
+- new `get-secrets` row with multiple secrets,
+- denied row with no resolved secret id,
+- hidden-value row,
+- revealed-value row,
+- service-token actor,
+- identity actor,
+- user actor,
+- imported secret row,
+- personal override row.
+
+The parser should produce the same normalized columns for old and new allowed
+reads:
+
+| Normalized column | Required for old rows | Required for new rows |
+| --- | --- | --- |
+| `event_type` | yes | yes |
+| `event_version` | inferred `1` | `schemaVersion` |
+| `event_outcome` | inferred `allowed` | `outcome` |
+| `project_id` | audit row project id | `metadata.request.projectId` |
+| `environment` | `metadata.environment` | `metadata.request.environment` |
+| `secret_path` | `metadata.secretPath` | `metadata.request.secretPath` |
+| `secret_key` | `metadata.secretKey` | `metadata.secrets[].secretKey` |
+| `actor_id` | actor metadata | `metadata.principal.actorId` |
+
+If any column becomes blank only for v2 rows, the rollout is a breaking change
+for that consumer.
+
+## Count parity checks
+
+Run count parity before and after rollout:
+
++```sql
+SELECT
+  eventType,
+  count() AS rows
+FROM audit_logs
+WHERE createdAt >= {start}
+  AND createdAt < {end}
+  AND eventType IN ('get-secret', 'get-secrets', 'secret-access-denied')
+GROUP BY eventType
+ORDER BY eventType
++```
+
+Then compare normalized allowed reads:
+
++```sql
+SELECT
+  coalesce(eventMetadata->>'secretKey', eventMetadata->'request'->>'requestedSecretKey') AS secret_key,
+  count() AS rows
+FROM audit_logs
+WHERE createdAt >= {start}
+  AND createdAt < {end}
+  AND eventType IN ('get-secret', 'get-secrets')
+GROUP BY secret_key
+ORDER BY rows DESC
++```
+
+A sudden drop in `secret_key` coverage is a schema migration problem, not a
+traffic change.
+
+Parity checks should be reviewed by:
+
+- platform engineering,
+- security engineering,
+- support,
+- customer success for impacted enterprise accounts.
+
+## Reviewer questions
+
+When reviewing audit changes, ask:
+
+- Is the event name a stable contract?
+- If metadata shape changes, how do old consumers know which shape they received?
+- Does the audit row describe an attempted action, an allowed action, or a denied action?
+- Is the row emitted after the system knows the outcome?
+- Can dashboard filters find old and new rows?
+- Can SIEM exports parse the event without customer-specific code changes?
+- Does a denied read leak secret IDs or values?
+- Does an allowed read include enough context to support compliance review?
+- Are tests blessing the actual compliance semantics or only route call order?
```

## Intended Flaws

### Flaw 1: The PR changes the `get-secret` / `get-secrets` metadata contract in place

The PR keeps the existing `EventType.GET_SECRET` and `EventType.GET_SECRETS` event names but replaces their metadata interfaces with the new nested `SecretAccessAuditMetadata` shape. Existing consumers that listen for `get-secret` and expect top-level `environment`, `secretPath`, `secretKey`, or `secretVersion` now receive `schemaVersion`, `request`, `principal`, and `secrets` instead.

Relevant line references:

- `backend/src/ee/services/audit-log/audit-log-types.ts:1032-1041` introduces the new nested secret-access metadata shape.
- `backend/src/ee/services/audit-log/audit-log-types.ts:1045-1056` replaces the old `GET_SECRETS` and `GET_SECRET` metadata interfaces in place.
- `backend/src/ee/services/audit-log/secret-access-audit-event.ts:109-112` continues emitting the old `GET_SECRET` / `GET_SECRETS` event names for the new shape.
- `backend/src/ee/services/audit-log/secret-access-audit-event.test.ts:21-50` asserts the new schema is emitted under the existing `get-secret` event type.
- `backend/src/ee/services/audit-log/secret-access-audit-compat.test.ts:91-119` shows consumers must branch on `schemaVersion` for the same `get-secret` event name.
- `docs/security/secret-access-audit-events.md:10-19` documents that the rollout keeps existing event names while metadata changes.
- `docs/security/secret-access-audit-events.md:165-173` shows old and new `get-secret` rows have incompatible metadata shapes.

Why this is a real flaw:

Audit logs are product and compliance contracts, not internal DTOs. Customers stream them to SIEMs, export them for auditors, and build dashboards around event names. If `get-secret` changes shape in place, consumers can silently drop secret-key filters, compliance exports can produce blank columns, and incident response queries can miss new rows. The compatibility helper does not protect external consumers that read the event stream directly.

Better implementation direction:

Version the event contract explicitly. Use a new event type such as `secret-access.v2`, or keep `get-secret` metadata backward-compatible and add new fields without moving existing keys. If richer denied/allowed semantics need a new shape, dual-write during migration and publish a deprecation window. Queries and exports should handle both versions deliberately, not by quietly changing what an old event name means.

### Flaw 2: The route emits `allowed` audit events before the permission outcome is known

The new route integration calls `auditSecretAccessStarted` before `getSecretsRaw` or `getSecretByNameRaw`. Those service calls are the paths that enforce read permissions. The start event is recorded as `outcome: "allowed"`, so a request that later fails permission can still leave an audit row claiming allowed secret access.

Relevant line references:

- `backend/src/ee/services/audit-log/secret-access-audit-event.ts:56-70` builds a pre-service event with `outcome: "allowed"`.
- `backend/src/server/routes/v4/secret-router.ts:182-199` emits a list-secret audit event before the service read completes.
- `backend/src/server/routes/v4/secret-router.ts:382-398` emits a single-secret audit event before the service read completes.
- `backend/src/server/routes/v4/secret-router.audit.test.ts:96-123` asserts a failed permission path still keeps an `allowed` `GET_SECRET` audit event.
- `docs/security/secret-access-audit-events.md:88-105` documents pre-service emission as the route instrumentation model.
- `docs/security/secret-access-audit-events.md:322-351` tells operators that an allowed read can exist when the service later denies the request.

Why this is a real flaw:

Audit logs must distinguish attempted access, allowed access, and denied access. A false allowed read is worse than a missing row because it creates incorrect compliance evidence: it can make an innocent user appear to have accessed a secret, make a denied attack look successful, and make incident timelines untrustworthy. The current Infisical shape emits secret-read audit logs after the secret service returns, which means the route has the actual secret id/version and knows the read succeeded.

Better implementation direction:

Emit the allowed access event after the permission-enforcing service returns. If product needs denied attempts too, catch permission errors at a boundary that can classify them safely and emit a separate denied/attempted event with no secret value and no unverified secret id. Do not label pre-decision events as allowed; call them attempts or defer them until the outcome is known.

## Hints

### Flaw 1 Hints

1. What do external audit-log consumers key on first: event name or TypeScript interface name?
2. What happens to a SIEM parser that expects `eventMetadata.secretKey` for every `get-secret` row?
3. How would you roll out a new compliance event schema without breaking existing customers?

### Flaw 2 Hints

1. Which layer actually knows whether the actor can read the secret value?
2. What does `outcome: "allowed"` mean if the next awaited call throws `Forbidden`?
3. Should an audit row describe an attempt, a denial, or a successful access? Where is that decision known?

## Expected Answer

A strong review should say that the product-level change is valuable: secret-access audit logs should capture richer compliance context, including actor, route, value visibility, access outcome, and denied attempts. But the implementation violates two audit fundamentals: stable event contracts and truthful event timing.

For flaw 1, the learner should identify that the PR changes the metadata shape of existing `get-secret` and `get-secrets` events in place. The impact is broken SIEM consumers, dashboard filters, exports, and customer automation that rely on old metadata keys. The fix is to introduce a versioned event contract, dual-write during migration, or preserve old top-level keys while adding new fields.

For flaw 2, the learner should identify that routes emit an `allowed` audit event before the permission-enforcing secret service call. The impact is false compliance evidence and misleading incident timelines when permission later fails. The fix is to emit allowed events after successful service reads and emit separate denied/attempt events only after the failure is classified.

The best answers should connect both flaws to Infisical's existing contracts: audit logs are queued/stored/streamed by event type and metadata, secret routes currently emit read audit logs after service calls, and secret services own read permission checks.

## Expert Debrief

At the product level, this PR is aiming at the right thing. Secret access is one of the most audit-sensitive actions in a secrets platform. Customers want to know who read what, from where, through which API, whether the value was revealed, and whether a denied access attempt happened.

The first contract is compatibility. Audit event names are not private implementation details. They are part of the customer's data pipeline. If a customer has a SIEM rule that says `eventType = get-secret` and reads `eventMetadata.secretKey`, changing `get-secret` to a nested v2 object is a breaking API change even if TypeScript compiles internally.

The second contract is truthfulness. An audit event can be an attempt, a denial, or a successful access, but it must say which one it is. A pre-permission event labeled `allowed` is not a harmless early log; it is false evidence.

The failure modes are concrete:

- A SIEM parser keeps listening for `get-secret` but emits blank `secret.name` because the key moved into `metadata.secrets[]`.
- A compliance export undercounts reads because old SQL filters only check top-level `secretKey`.
- A denied request creates an `allowed` read row before `getSecretByNameRaw` throws.
- An incident responder thinks a user read `DATABASE_URL` even though permission enforcement rejected the request.
- The new denied event type exists but the route tests prove denied paths do not use it.

The reviewer thought process should be: audit logs are append-only contracts with external consumers. First ask whether the event name and metadata shape are versioned. Then ask whether the event is emitted at the point where the system knows the outcome. Finally, check tests and docs: here they bless both the compatibility break and the false allowed event, so the issue is not an accidental typo.

The better implementation is to preserve old `GET_SECRET` / `GET_SECRETS` shape or dual-write a new versioned event, emit allowed rows only after successful reads, and emit denied/attempt rows only after classifying permission failures. Compatibility and truthfulness matter more than a neat internal schema.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: existing `get-secret` / `get-secrets` metadata is changed in place, and `allowed` audit rows are emitted before permission outcome is known. It explains broken external consumers/compliance exports and false access evidence, and suggests versioned/dual-written audit events plus post-decision allowed/denied emission.
- `partial`: The answer finds one flaw completely and mentions either generic backward compatibility or generic audit ordering without tying it to event names, metadata shape, and permission-enforcing service calls.
- `miss`: The answer focuses on naming, enum style, test mocks, or query syntax while missing the event contract break and false allowed audit rows.
