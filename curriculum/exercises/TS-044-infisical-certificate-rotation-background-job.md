# TS-044: Infisical Certificate Rotation Background Job

## Metadata

- `id`: TS-044
- `source_repo`: [Infisical/infisical](https://github.com/Infisical/infisical)
- `repo_area`: certificate manager, certificate renewal, PKI sync, queue workers, cron jobs, project-scoped certificate data, revocation lifecycle
- `mode`: synthetic_degraded
- `difficulty`: 5
- `target_diff_lines`: 1,500-1,900
- `represented_diff_lines`: 1538
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about certificate lifecycles, multi-tenant background workers, queued rotations, revocation semantics, PKI sync distribution, and staged rollout contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds a certificate rotation worker for Certificate Manager. The goal is to automatically rotate certificates before expiry instead of relying on operators to trigger renewal from the UI or API.

Today Infisical already supports certificate issuance, renewal configuration, subscriber auto-renewal, and PKI sync. This PR adds a new general rotation job that scans due certificates, issues replacements, revokes old certificates, updates sync rows, and emits audit logs.

The PR adds:

- a `certificate-rotation` queue and daily cron,
- a DAL for finding due certificates and recording rotation jobs,
- a rotation service that issues a replacement certificate,
- sync handoff for certificate sync destinations,
- migration and schema updates,
- tests for global scanning, noisy tenants, and rotation ordering,
- docs for operating automatic certificate rotation.

The intended product behavior is: certificates rotate before expiry without one tenant starving another and without breaking services that still trust the old certificate during rollout.

## Existing Code Context

The real Infisical codebase already has these relevant contracts:

- `backend/src/queue/queue-service.ts` defines typed queue names, job names, and payloads. New queue jobs become part of a typed background-job contract, not just local helper calls.
- `backend/src/lib/cron/cron-job.ts` registers distributed cron handlers with run hashes, leases, retries, and handler timeouts. Cron jobs should be bounded and resumable because every registered handler runs in the shared worker environment.
- `backend/src/services/certificate/certificate-dal.ts` stores certificates with `projectId`, `caId`, `profileId`, `pkiSubscriberId`, `renewBeforeDays`, `renewedFromCertificateId`, `renewedByCertificateId`, `revokedAt`, and `status`. Certificate rotation is inherently project and lifecycle scoped.
- `backend/src/services/certificate-v3/certificate-v3-queue.ts` uses a daily cron for v3 auto-renewal and records success or failure with the certificate's `projectId`. The project boundary is used for audit and product semantics.
- `backend/src/services/certificate-v3/certificate-v3-service.ts` validates renewal eligibility, creates replacement certificates, records `renewedFromCertificateId` and `renewedByCertificateId`, copies metadata, and triggers PKI sync after renewal.
- `backend/src/services/certificate/certificate-service.ts` revokes certificates by calling upstream CA revocation first for external CAs, then writes local `REVOKED` state, triggers PKI sync, rebuilds CRLs for internal CAs, and queues revocation alerts. Revocation is not a harmless local status flip.
- `backend/src/services/pki-sync/pki-sync-queue.ts` filters out certificates that already have `renewedByCertificateId`, pushes active certificates to destinations, and has per-connection concurrency protection. Distribution to destinations is its own lifecycle.
- `backend/src/services/pki-subscriber/pki-subscriber-queue.ts` auto-renews subscribers in batches and uses subscriber `projectId`, CA state, operation status, and audit logs as part of the contract.
- `backend/src/keystore/keystore.ts` already contains lock prefixes for PKI sync, certificate subscriber ordering, and app connection concurrency. Lock key granularity decides whether unrelated tenants block each other.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the rotation worker is fair across tenants and whether it preserves a safe certificate overlap contract during rollout.

## Review Surface

Changed files in the synthetic PR:

- `backend/src/db/migrations/20260516091000_certificate-rotation.ts`
- `backend/src/db/schemas/models.ts`
- `backend/src/db/schemas/certificates.ts`
- `backend/src/queue/queue-service.ts`
- `backend/src/keystore/keystore.ts`
- `backend/src/services/certificate-rotation/certificate-rotation-types.ts`
- `backend/src/services/certificate-rotation/certificate-rotation-dal.ts`
- `backend/src/services/certificate-rotation/certificate-rotation-service.ts`
- `backend/src/services/certificate-rotation/certificate-rotation-queue.ts`
- `backend/src/services/certificate-rotation/index.ts`
- `backend/src/server/routes/index.ts`
- `backend/src/services/certificate-rotation/certificate-rotation-dal.test.ts`
- `backend/src/services/certificate-rotation/certificate-rotation-service.test.ts`
- `docs/certificate-rotation-worker.md`
- `docs/runbooks/certificate-rotation-worker.md`

The line references below use synthetic PR line numbers. The represented diff is focused on job partitioning, tenant fairness, lifecycle state, revocation ordering, sync handoff, and tests that normalize an unsafe contract.

## Diff

```diff
diff --git a/backend/src/db/migrations/20260516091000_certificate-rotation.ts b/backend/src/db/migrations/20260516091000_certificate-rotation.ts
new file mode 100644
index 0000000000..92db99a129
--- /dev/null
+++ b/backend/src/db/migrations/20260516091000_certificate-rotation.ts
@@ -0,0 +1,117 @@
+import { Knex } from "knex";
+
+import { TableName } from "../schemas";
+
+export async function up(knex: Knex): Promise<void> {
+  const hasRotationTable = await knex.schema.hasTable(TableName.CertificateRotationJob);
+  if (!hasRotationTable) {
+    await knex.schema.createTable(TableName.CertificateRotationJob, (t) => {
+      t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
+      t.uuid("certificateId").notNullable().references("id").inTable(TableName.Certificate).onDelete("CASCADE");
+      t.string("projectId").notNullable();
+      t.uuid("profileId").nullable();
+      t.uuid("caId").nullable();
+      t.string("status").notNullable().defaultTo("queued");
+      t.timestamp("dueAt", { useTz: true }).notNullable();
+      t.timestamp("startedAt", { useTz: true }).nullable();
+      t.timestamp("completedAt", { useTz: true }).nullable();
+      t.uuid("newCertificateId").nullable().references("id").inTable(TableName.Certificate).onDelete("SET NULL");
+      t.text("errorMessage").nullable();
+      t.integer("attempt").notNullable().defaultTo(0);
+      t.jsonb("metadata").nullable();
+      t.timestamp("createdAt", { useTz: true }).notNullable().defaultTo(knex.fn.now());
+      t.timestamp("updatedAt", { useTz: true }).notNullable().defaultTo(knex.fn.now());
+      t.unique(["certificateId", "status"], {
+        indexName: "certificate_rotation_jobs_certificate_status_unique"
+      });
+      t.index(["status", "dueAt"], "certificate_rotation_jobs_status_due_at_idx");
+      t.index(["projectId", "status", "dueAt"], "certificate_rotation_jobs_project_status_due_at_idx");
+    });
+  }
+
+  const hasRotationEnabled = await knex.schema.hasColumn(TableName.Certificate, "rotationEnabled");
+  const hasRotationWindowDays = await knex.schema.hasColumn(TableName.Certificate, "rotationWindowDays");
+  const hasLastRotatedAt = await knex.schema.hasColumn(TableName.Certificate, "lastRotatedAt");
+  const hasRotationError = await knex.schema.hasColumn(TableName.Certificate, "rotationError");
+
+  await knex.schema.alterTable(TableName.Certificate, (t) => {
+    if (!hasRotationEnabled) t.boolean("rotationEnabled").notNullable().defaultTo(false);
+    if (!hasRotationWindowDays) t.integer("rotationWindowDays").nullable();
+    if (!hasLastRotatedAt) t.timestamp("lastRotatedAt", { useTz: true }).nullable();
+    if (!hasRotationError) t.text("rotationError").nullable();
+  });
+
+  await knex.raw(`
+    UPDATE "${TableName.Certificate}"
+    SET "rotationEnabled" = true,
+        "rotationWindowDays" = "renewBeforeDays"
+    WHERE "renewBeforeDays" IS NOT NULL
+      AND "renewBeforeDays" > 0
+      AND "rotationEnabled" = false
+  `);
+}
+
+export async function down(knex: Knex): Promise<void> {
+  const hasRotationTable = await knex.schema.hasTable(TableName.CertificateRotationJob);
+  if (hasRotationTable) {
+    await knex.schema.dropTable(TableName.CertificateRotationJob);
+  }
+
+  const hasRotationEnabled = await knex.schema.hasColumn(TableName.Certificate, "rotationEnabled");
+  const hasRotationWindowDays = await knex.schema.hasColumn(TableName.Certificate, "rotationWindowDays");
+  const hasLastRotatedAt = await knex.schema.hasColumn(TableName.Certificate, "lastRotatedAt");
+  const hasRotationError = await knex.schema.hasColumn(TableName.Certificate, "rotationError");
+
+  await knex.schema.alterTable(TableName.Certificate, (t) => {
+    if (hasRotationError) t.dropColumn("rotationError");
+    if (hasLastRotatedAt) t.dropColumn("lastRotatedAt");
+    if (hasRotationWindowDays) t.dropColumn("rotationWindowDays");
+    if (hasRotationEnabled) t.dropColumn("rotationEnabled");
+  });
+}
diff --git a/backend/src/db/schemas/models.ts b/backend/src/db/schemas/models.ts
index 20e71e45d2..f7c4f0dc45 100644
--- a/backend/src/db/schemas/models.ts
+++ b/backend/src/db/schemas/models.ts
@@ -20,6 +20,7 @@ export enum TableName {
   CertificateAuthorityCrl = "certificate_authority_crl",
   Certificate = "certificates",
   CertificateBody = "certificate_bodies",
+  CertificateRotationJob = "certificate_rotation_jobs",
   CertificateRequests = "certificate_requests",
   CertificateSecret = "certificate_secrets",
   CertificateTemplate = "certificate_templates",
diff --git a/backend/src/db/schemas/certificates.ts b/backend/src/db/schemas/certificates.ts
index c2bc1d38c2..f1c715dbd0 100644
--- a/backend/src/db/schemas/certificates.ts
+++ b/backend/src/db/schemas/certificates.ts
@@ -47,6 +47,10 @@ export const CertificatesSchema = z.object({
   isCA: z.boolean().nullable().optional(),
   pathLength: z.number().nullable().optional(),
   source: z.string().nullable().optional(),
+  rotationEnabled: z.boolean().default(false),
+  rotationWindowDays: z.number().nullable().optional(),
+  lastRotatedAt: z.date().nullable().optional(),
+  rotationError: z.string().nullable().optional(),
   discoveryMetadata: z.unknown().nullable().optional(),
   externalMetadata: z.unknown().nullable().optional()
 });
diff --git a/backend/src/queue/queue-service.ts b/backend/src/queue/queue-service.ts
index 02f164a1f2..8ae58aef0b 100644
--- a/backend/src/queue/queue-service.ts
+++ b/backend/src/queue/queue-service.ts
@@ -27,6 +27,7 @@ import {
   TAppConnectionCredentialRotationRotateJobPayload,
   TAppConnectionCredentialRotationSendNotificationJobPayload
 } from "@app/services/app-connection/credential-rotation/app-connection-credential-rotation-types";
+import { TCertificateRotationRotateJobPayload } from "@app/services/certificate-rotation/certificate-rotation-types";
 import { CaType } from "@app/services/certificate-authority/certificate-authority-enums";
 import { ExternalPlatforms } from "@app/services/external-migration/external-migration-types";
 import { TCreateUserNotificationDTO } from "@app/services/notification/notification-types";
@@ -90,6 +91,7 @@ export enum QueueName {
   PkiDiscoveryScan = "pki-discovery-scan",
   AppConnectionCredentialRotation = "app-connection-credential-rotation",
   AppConnectionCredentialRotationRotate = "app-connection-credential-rotation-rotate",
+  CertificateRotation = "certificate-rotation",
   AuditLogClickHouseBatch = "audit-log-clickhouse-batch",
   PamDiscoveryScan = "pam-discovery-scan",
   CaAutoRenewal = "ca-auto-renewal",
@@ -158,6 +160,8 @@ export enum QueueJobs {
   AppConnectionCredentialRotationQueueRotations = "app-connection-credential-rotation-queue-rotations",
   AppConnectionCredentialRotationRotate = "app-connection-credential-rotation-rotate",
   AppConnectionCredentialRotationSendNotification = "app-connection-credential-rotation-send-notification",
+  CertificateRotationQueueDue = "certificate-rotation-queue-due",
+  CertificateRotationRotate = "certificate-rotation-rotate",
   AuditLogClickHouseBatch = "audit-log-clickhouse-batch-job",
   PamDiscoverySourceRunScan = "pam-discovery-run-scan",
   PamDiscoveryScheduledScan = "pam-discovery-scheduled-scan",
@@ -448,6 +452,17 @@ export type TQueueJobTypes = {
     name: QueueJobs.AppConnectionCredentialRotationRotate;
     payload: TAppConnectionCredentialRotationRotateJobPayload;
   };
+  [QueueName.CertificateRotation]:
+    | {
+        name: QueueJobs.CertificateRotationQueueDue;
+        payload: undefined;
+      }
+    | {
+        name: QueueJobs.CertificateRotationRotate;
+        payload: TCertificateRotationRotateJobPayload;
+      };
   [QueueName.AuditLogClickHouseBatch]: {
     name: QueueJobs.AuditLogClickHouseBatch;
     payload: undefined;
@@ -596,7 +611,8 @@ export const queueServiceFactory = (redisCfg: TRedisConfigKeys): TQueueServiceFactory => {
       "app-connection-credential-rotation",
       "daily-secret-sync-retry-job",
       "ca-daily-auto-renewal",
+      "certificate-rotation"
     ];
     await Promise.allSettled(
       staleQueueNames.map(async (name) => {
diff --git a/backend/src/keystore/keystore.ts b/backend/src/keystore/keystore.ts
index f6e5641b3d..cb2e29b4d1 100644
--- a/backend/src/keystore/keystore.ts
+++ b/backend/src/keystore/keystore.ts
@@ -61,6 +61,8 @@ export const KeyStorePrefixes = {
     `ca-order-certificate-for-subscriber-lock-${subscriberId}` as const,
   SecretSyncLastRunTimestamp: (syncId: string) => `secret-sync-last-run-${syncId}` as const,
+  CertificateRotationRunLock: () => "certificate-rotation-global-run-lock" as const,
+  CertificateRotationCertLock: (certificateId: string) => `certificate-rotation-cert-${certificateId}` as const,
   IdentityAccessTokenStatusUpdate: (identityAccessTokenId: string) =>
     `identity-access-token-status:${identityAccessTokenId}`,
   IdentityTokenUsesRemaining: (identityId: string, jti: string) =>
diff --git a/backend/src/services/certificate-rotation/certificate-rotation-types.ts b/backend/src/services/certificate-rotation/certificate-rotation-types.ts
new file mode 100644
index 0000000000..70e9ac11df
--- /dev/null
+++ b/backend/src/services/certificate-rotation/certificate-rotation-types.ts
@@ -0,0 +1,126 @@
+import { TCertificates } from "@app/db/schemas";
+
+export enum CertificateRotationJobStatus {
+  Queued = "queued",
+  Running = "running",
+  Rotated = "rotated",
+  Failed = "failed",
+  Skipped = "skipped"
+}
+
+export type TCertificateRotationJob = {
+  id: string;
+  certificateId: string;
+  projectId: string;
+  profileId?: string | null;
+  caId?: string | null;
+  status: CertificateRotationJobStatus;
+  dueAt: Date;
+  startedAt?: Date | null;
+  completedAt?: Date | null;
+  newCertificateId?: string | null;
+  errorMessage?: string | null;
+  attempt: number;
+  metadata?: Record<string, unknown> | null;
+  createdAt: Date;
+  updatedAt: Date;
+};
+
+export type TCertificateRotationDueCertificate = TCertificates & {
+  profileName?: string | null;
+  caName?: string | null;
+  hasPrivateKey: boolean;
+};
+
+export type TCertificateRotationRotateJobPayload = {
+  rotationJobId: string;
+  certificateId: string;
+};
+
+export type TFindDueCertificatesDTO = {
+  now: Date;
+  limit: number;
+};
+
+export type TCreateRotationJobDTO = {
+  certificateId: string;
+  projectId: string;
+  profileId?: string | null;
+  caId?: string | null;
+  dueAt: Date;
+  metadata?: Record<string, unknown>;
+};
+
+export type TMarkRotationRunningDTO = {
+  rotationJobId: string;
+};
+
+export type TMarkRotationRotatedDTO = {
+  rotationJobId: string;
+  newCertificateId: string;
+};
+
+export type TMarkRotationFailedDTO = {
+  rotationJobId: string;
+  error: unknown;
+};
+
+export type TCertificateRotationStats = {
+  queued: number;
+  rotated: number;
+  failed: number;
+  skipped: number;
+};
+
+export type TQueueDueRotationsResult = {
+  scanned: number;
+  queued: number;
+  skipped: number;
+};
+
+export type TRotateCertificateResult = {
+  rotationJobId: string;
+  certificateId: string;
+  newCertificateId: string;
+  revokedOldCertificate: boolean;
+};
+
+export const CERTIFICATE_ROTATION_CONFIG = {
+  DAILY_CRON_PATTERN: "0 * * * *",
+  DUE_CERTIFICATE_LIMIT: 5000,
+  QUEUE_JOB_ATTEMPTS: 3,
+  QUEUE_BACKOFF_MS: 10000,
+  LOCK_TTL_SECONDS: 60 * 30,
+  DEFAULT_ROTATION_WINDOW_DAYS: 14
+} as const;
diff --git a/backend/src/services/certificate-rotation/certificate-rotation-dal.ts b/backend/src/services/certificate-rotation/certificate-rotation-dal.ts
new file mode 100644
index 0000000000..d9eab48e71
--- /dev/null
+++ b/backend/src/services/certificate-rotation/certificate-rotation-dal.ts
@@ -0,0 +1,279 @@
+import { Knex } from "knex";
+
+import { TableName, TCertificates } from "@app/db/schemas";
+import { TDbClient } from "@app/db";
+import { DatabaseError } from "@app/lib/errors";
+import { ormify, selectAllTableCols } from "@app/lib/knex";
+import { CertStatus } from "@app/services/certificate/certificate-types";
+
+import {
+  CertificateRotationJobStatus,
+  TCertificateRotationDueCertificate,
+  TCertificateRotationJob,
+  TCreateRotationJobDTO,
+  TFindDueCertificatesDTO,
+  TMarkRotationFailedDTO,
+  TMarkRotationRotatedDTO,
+  TMarkRotationRunningDTO
+} from "./certificate-rotation-types";
+
+export type TCertificateRotationDALFactory = ReturnType<typeof certificateRotationDALFactory>;
+
+export const certificateRotationDALFactory = (db: TDbClient) => {
+  const rotationJobOrm = ormify(db, TableName.CertificateRotationJob);
+
+  const findDueCertificates = async ({
+    now,
+    limit
+  }: TFindDueCertificatesDTO): Promise<TCertificateRotationDueCertificate[]> => {
+    try {
+      const rows = (await db
+        .replicaNode()(TableName.Certificate)
+        .select(selectAllTableCols(TableName.Certificate))
+        .select(db.ref("slug").withSchema(TableName.PkiCertificateProfile).as("profileName"))
+        .select(db.ref("name").withSchema(TableName.CertificateAuthority).as("caName"))
+        .select(db.ref(`${TableName.CertificateSecret}.certId`).as("privateKeyRef"))
+        .leftJoin(
+          TableName.PkiCertificateProfile,
+          `${TableName.Certificate}.profileId`,
+          `${TableName.PkiCertificateProfile}.id`
+        )
+        .leftJoin(
+          TableName.CertificateAuthority,
+          `${TableName.Certificate}.caId`,
+          `${TableName.CertificateAuthority}.id`
+        )
+        .innerJoin(TableName.CertificateSecret, `${TableName.Certificate}.id`, `${TableName.CertificateSecret}.certId`)
+        .where(`${TableName.Certificate}.rotationEnabled`, true)
+        .where(`${TableName.Certificate}.status`, CertStatus.ACTIVE)
+        .whereNull(`${TableName.Certificate}.revokedAt`)
+        .whereNull(`${TableName.Certificate}.renewedByCertificateId`)
+        .whereNotNull(`${TableName.Certificate}.notAfter`)
+        .where((qb: Knex.QueryBuilder) => {
+          void qb
+            .whereRaw(
+              `"${TableName.Certificate}"."notAfter" - INTERVAL '1 day' * COALESCE("${TableName.Certificate}"."rotationWindowDays", 14) <= ?`,
+              [now]
+            )
+            .orWhere(`${TableName.Certificate}.notAfter`, "<=", now);
+        })
+        .orderBy(`${TableName.Certificate}.notAfter`, "asc")
+        .limit(limit)) as Array<TCertificates & { profileName?: string; caName?: string; privateKeyRef?: string }>;
+
+      return rows.map((row) => ({
+        ...row,
+        hasPrivateKey: Boolean(row.privateKeyRef)
+      }));
+    } catch (error) {
+      throw new DatabaseError({ error, name: "Find certificates due for rotation" });
+    }
+  };
+
+  const findQueuedRotationForCertificate = async (certificateId: string): Promise<TCertificateRotationJob | undefined> => {
+    try {
+      return await db
+        .replicaNode()(TableName.CertificateRotationJob)
+        .where({ certificateId })
+        .whereIn("status", [CertificateRotationJobStatus.Queued, CertificateRotationJobStatus.Running])
+        .first();
+    } catch (error) {
+      throw new DatabaseError({ error, name: "Find queued certificate rotation" });
+    }
+  };
+
+  const createRotationJob = async (dto: TCreateRotationJobDTO, tx?: Knex): Promise<TCertificateRotationJob> => {
+    try {
+      const existing = await findQueuedRotationForCertificate(dto.certificateId);
+      if (existing) return existing;
+
+      const [job] = await (tx || db)(TableName.CertificateRotationJob)
+        .insert({
+          certificateId: dto.certificateId,
+          projectId: dto.projectId,
+          profileId: dto.profileId,
+          caId: dto.caId,
+          dueAt: dto.dueAt,
+          metadata: dto.metadata || null,
+          status: CertificateRotationJobStatus.Queued
+        })
+        .returning("*");
+
+      return job;
+    } catch (error) {
+      throw new DatabaseError({ error, name: "Create certificate rotation job" });
+    }
+  };
+
+  const markRunning = async ({ rotationJobId }: TMarkRotationRunningDTO): Promise<TCertificateRotationJob> => {
+    try {
+      const [job] = await db(TableName.CertificateRotationJob)
+        .where({ id: rotationJobId })
+        .update({
+          status: CertificateRotationJobStatus.Running,
+          startedAt: new Date(),
+          updatedAt: new Date()
+        })
+        .returning("*");
+      return job;
+    } catch (error) {
+      throw new DatabaseError({ error, name: "Mark certificate rotation running" });
+    }
+  };
+
+  const markRotated = async ({ rotationJobId, newCertificateId }: TMarkRotationRotatedDTO): Promise<TCertificateRotationJob> => {
+    try {
+      const [job] = await db(TableName.CertificateRotationJob)
+        .where({ id: rotationJobId })
+        .update({
+          status: CertificateRotationJobStatus.Rotated,
+          newCertificateId,
+          completedAt: new Date(),
+          updatedAt: new Date()
+        })
+        .returning("*");
+      return job;
+    } catch (error) {
+      throw new DatabaseError({ error, name: "Mark certificate rotation rotated" });
+    }
+  };
+
+  const markFailed = async ({ rotationJobId, error }: TMarkRotationFailedDTO): Promise<TCertificateRotationJob> => {
+    try {
+      const message = error instanceof Error ? error.message : String(error);
+      const [job] = await db(TableName.CertificateRotationJob)
+        .where({ id: rotationJobId })
+        .update({
+          status: CertificateRotationJobStatus.Failed,
+          errorMessage: message.substring(0, 2048),
+          completedAt: new Date(),
+          updatedAt: new Date()
+        })
+        .returning("*");
+      return job;
+    } catch (dbError) {
+      throw new DatabaseError({ error: dbError, name: "Mark certificate rotation failed" });
+    }
+  };
+
+  const markCertificateRotated = async ({
+    oldCertificateId,
+    newCertificateId
+  }: {
+    oldCertificateId: string;
+    newCertificateId: string;
+  }) => {
+    try {
+      await db(TableName.Certificate)
+        .where({ id: oldCertificateId })
+        .update({
+          renewedByCertificateId: newCertificateId,
+          lastRotatedAt: new Date(),
+          rotationError: null,
+          updatedAt: new Date()
+        });
+    } catch (error) {
+      throw new DatabaseError({ error, name: "Mark certificate rotated" });
+    }
+  };
+
+  const recordCertificateRotationError = async ({
+    certificateId,
+    error
+  }: {
+    certificateId: string;
+    error: unknown;
+  }) => {
+    try {
+      const message = error instanceof Error ? error.message : String(error);
+      await db(TableName.Certificate)
+        .where({ id: certificateId })
+        .update({
+          rotationError: message.substring(0, 2048),
+          updatedAt: new Date()
+        });
+    } catch (dbError) {
+      throw new DatabaseError({ error: dbError, name: "Record certificate rotation error" });
+    }
+  };
+
+  const countByStatus = async (): Promise<Record<CertificateRotationJobStatus, number>> => {
+    try {
+      const rows = await db
+        .replicaNode()(TableName.CertificateRotationJob)
+        .select("status")
+        .count("* as count")
+        .groupBy("status");
+
+      const result = {
+        [CertificateRotationJobStatus.Queued]: 0,
+        [CertificateRotationJobStatus.Running]: 0,
+        [CertificateRotationJobStatus.Rotated]: 0,
+        [CertificateRotationJobStatus.Failed]: 0,
+        [CertificateRotationJobStatus.Skipped]: 0
+      };
+
+      rows.forEach((row: { status: CertificateRotationJobStatus; count: string }) => {
+        result[row.status] = Number(row.count);
+      });
+
+      return result;
+    } catch (error) {
+      throw new DatabaseError({ error, name: "Count certificate rotation jobs by status" });
+    }
+  };
+
+  return {
+    ...rotationJobOrm,
+    findDueCertificates,
+    findQueuedRotationForCertificate,
+    createRotationJob,
+    markRunning,
+    markRotated,
+    markFailed,
+    markCertificateRotated,
+    recordCertificateRotationError,
+    countByStatus
+  };
+};
diff --git a/backend/src/services/certificate-rotation/certificate-rotation-service.ts b/backend/src/services/certificate-rotation/certificate-rotation-service.ts
new file mode 100644
index 0000000000..ef48e05bc8
--- /dev/null
+++ b/backend/src/services/certificate-rotation/certificate-rotation-service.ts
@@ -0,0 +1,374 @@
+import { EventType, TAuditLogServiceFactory } from "@app/ee/services/audit-log/audit-log-types";
+import { KeyStorePrefixes, TKeyStoreFactory } from "@app/keystore/keystore";
+import { logger } from "@app/lib/logger";
+import { ActorType } from "@app/services/auth/auth-type";
+import { TCertificateDALFactory } from "@app/services/certificate/certificate-dal";
+import { CertStatus } from "@app/services/certificate/certificate-types";
+import { TCertificateServiceFactory } from "@app/services/certificate/certificate-service";
+import { TCertificateV3ServiceFactory } from "@app/services/certificate-v3/certificate-v3-service";
+import { TCertificateSyncDALFactory } from "@app/services/certificate-sync/certificate-sync-dal";
+import { TPkiSyncDALFactory } from "@app/services/pki-sync/pki-sync-dal";
+import { TPkiSyncQueueFactory } from "@app/services/pki-sync/pki-sync-queue";
+import { triggerAutoSyncForCertificate } from "@app/services/pki-sync/pki-sync-utils";
+
+import { TCertificateRotationDALFactory } from "./certificate-rotation-dal";
+import {
+  CERTIFICATE_ROTATION_CONFIG,
+  CertificateRotationJobStatus,
+  TQueueDueRotationsResult,
+  TRotateCertificateResult
+} from "./certificate-rotation-types";
+
+type TCertificateRotationServiceFactoryDep = {
+  certificateRotationDAL: TCertificateRotationDALFactory;
+  certificateDAL: Pick<TCertificateDALFactory, "findById" | "updateById" | "transaction">;
+  certificateV3Service: Pick<TCertificateV3ServiceFactory, "renewCertificate">;
+  certificateService: Pick<TCertificateServiceFactory, "revokeCert">;
+  certificateSyncDAL: Pick<TCertificateSyncDALFactory, "findPkiSyncIdsByCertificateId" | "addCertificates">;
+  pkiSyncDAL: Pick<TPkiSyncDALFactory, "find">;
+  pkiSyncQueue: Pick<TPkiSyncQueueFactory, "queuePkiSyncSyncCertificatesById">;
+  keyStore: Pick<TKeyStoreFactory, "acquireLock">;
+  auditLogService: Pick<TAuditLogServiceFactory, "createAuditLog">;
+};
+
+export type TCertificateRotationServiceFactory = ReturnType<typeof certificateRotationServiceFactory>;
+
+export const certificateRotationServiceFactory = ({
+  certificateRotationDAL,
+  certificateDAL,
+  certificateV3Service,
+  certificateService,
+  certificateSyncDAL,
+  pkiSyncDAL,
+  pkiSyncQueue,
+  keyStore,
+  auditLogService
+}: TCertificateRotationServiceFactoryDep) => {
+  const queueDueRotations = async (): Promise<TQueueDueRotationsResult> => {
+    const lock = await keyStore.acquireLock(
+      [KeyStorePrefixes.CertificateRotationRunLock()],
+      CERTIFICATE_ROTATION_CONFIG.LOCK_TTL_SECONDS * 1000
+    );
+
+    try {
+      const now = new Date();
+      const dueCertificates = await certificateRotationDAL.findDueCertificates({
+        now,
+        limit: CERTIFICATE_ROTATION_CONFIG.DUE_CERTIFICATE_LIMIT
+      });
+
+      let queued = 0;
+      let skipped = 0;
+
+      for (const certificate of dueCertificates) {
+        try {
+          if (!certificate.profileId || !certificate.caId) {
+            skipped += 1;
+            await certificateRotationDAL.recordCertificateRotationError({
+              certificateId: certificate.id,
+              error: "Certificate is missing profile or CA"
+            });
+            continue;
+          }
+
+          const existingJob = await certificateRotationDAL.findQueuedRotationForCertificate(certificate.id);
+          if (existingJob) {
+            skipped += 1;
+            continue;
+          }
+
+          await certificateRotationDAL.createRotationJob({
+            certificateId: certificate.id,
+            projectId: certificate.projectId,
+            profileId: certificate.profileId,
+            caId: certificate.caId,
+            dueAt: certificate.notAfter,
+            metadata: {
+              commonName: certificate.commonName,
+              profileName: certificate.profileName,
+              caName: certificate.caName
+            }
+          });
+
+          queued += 1;
+        } catch (error) {
+          skipped += 1;
+          logger.error(error, `Failed to queue certificate rotation for certificate ${certificate.id}`);
+          await certificateRotationDAL.recordCertificateRotationError({
+            certificateId: certificate.id,
+            error
+          });
+        }
+      }
+
+      logger.info(
+        {
+          scanned: dueCertificates.length,
+          queued,
+          skipped
+        },
+        "Queued due certificate rotations"
+      );
+
+      return {
+        scanned: dueCertificates.length,
+        queued,
+        skipped
+      };
+    } finally {
+      await lock.release();
+    }
+  };
+
+  const rotateCertificate = async (rotationJobId: string): Promise<TRotateCertificateResult> => {
+    const rotationJob = await certificateRotationDAL.markRunning({ rotationJobId });
+    const originalCert = await certificateDAL.findById(rotationJob.certificateId);
+
+    if (!originalCert) {
+      await certificateRotationDAL.markFailed({
+        rotationJobId,
+        error: "Certificate not found"
+      });
+      throw new Error("Certificate not found");
+    }
+
+    if (originalCert.status !== CertStatus.ACTIVE || originalCert.revokedAt) {
+      await certificateRotationDAL.markFailed({
+        rotationJobId,
+        error: "Certificate is not active"
+      });
+      throw new Error("Certificate is not active");
+    }
+
+    try {
+      const renewalResult = await certificateV3Service.renewCertificate({
+        actor: ActorType.PLATFORM,
+        actorId: "",
+        actorAuthMethod: null,
+        actorOrgId: "",
+        certificateId: originalCert.id,
+        internal: true
+      });
+
+      if (!renewalResult.certificateId) {
+        throw new Error("Renewal did not return a replacement certificate id");
+      }
+
+      await certificateRotationDAL.markCertificateRotated({
+        oldCertificateId: originalCert.id,
+        newCertificateId: renewalResult.certificateId
+      });
+
+      await certificateService.revokeCert({
+        actor: ActorType.PLATFORM,
+        actorId: "",
+        actorAuthMethod: null,
+        actorOrgId: "",
+        certificateId: originalCert.id,
+        revocationReason: "superseded"
+      });
+
+      await triggerAutoSyncForCertificate(renewalResult.certificateId, {
+        certificateSyncDAL,
+        pkiSyncDAL,
+        pkiSyncQueue
+      });
+
+      await certificateRotationDAL.markRotated({
+        rotationJobId,
+        newCertificateId: renewalResult.certificateId
+      });
+
+      await auditLogService.createAuditLog({
+        projectId: originalCert.projectId,
+        actor: {
+          type: ActorType.PLATFORM,
+          metadata: {}
+        },
+        event: {
+          type: EventType.AUTOMATED_RENEW_CERTIFICATE,
+          metadata: {
+            certificateId: originalCert.id,
+            newCertificateId: renewalResult.certificateId,
+            commonName: originalCert.commonName || "",
+            profileId: originalCert.profileId || "",
+            rotationJobId
+          }
+        }
+      });
+
+      return {
+        rotationJobId,
+        certificateId: originalCert.id,
+        newCertificateId: renewalResult.certificateId,
+        revokedOldCertificate: true
+      };
+    } catch (error) {
+      await certificateRotationDAL.markFailed({
+        rotationJobId,
+        error
+      });
+      await certificateRotationDAL.recordCertificateRotationError({
+        certificateId: originalCert.id,
+        error
+      });
+      await auditLogService.createAuditLog({
+        projectId: originalCert.projectId,
+        actor: {
+          type: ActorType.PLATFORM,
+          metadata: {}
+        },
+        event: {
+          type: EventType.AUTOMATED_RENEW_CERTIFICATE_FAILED,
+          metadata: {
+            certificateId: originalCert.id,
+            commonName: originalCert.commonName || "",
+            profileId: originalCert.profileId || "",
+            rotationJobId,
+            error: error instanceof Error ? error.message : String(error)
+          }
+        }
+      });
+      throw error;
+    }
+  };
+
+  const getStats = async () => {
+    const counts = await certificateRotationDAL.countByStatus();
+    return {
+      queued: counts[CertificateRotationJobStatus.Queued],
+      rotated: counts[CertificateRotationJobStatus.Rotated],
+      failed: counts[CertificateRotationJobStatus.Failed],
+      skipped: counts[CertificateRotationJobStatus.Skipped]
+    };
+  };
+
+  return {
+    queueDueRotations,
+    rotateCertificate,
+    getStats
+  };
+};
diff --git a/backend/src/services/certificate-rotation/certificate-rotation-queue.ts b/backend/src/services/certificate-rotation/certificate-rotation-queue.ts
new file mode 100644
index 0000000000..84ad7f2d0f
--- /dev/null
+++ b/backend/src/services/certificate-rotation/certificate-rotation-queue.ts
@@ -0,0 +1,237 @@
+import { CronJobName, TCronJobFactory } from "@app/lib/cron/cron-job";
+import { logger } from "@app/lib/logger";
+import { QueueJobs, QueueName, TQueueServiceFactory } from "@app/queue";
+
+import { TCertificateRotationDALFactory } from "./certificate-rotation-dal";
+import { TCertificateRotationServiceFactory } from "./certificate-rotation-service";
+import { CERTIFICATE_ROTATION_CONFIG } from "./certificate-rotation-types";
+
+type TCertificateRotationQueueFactoryDep = {
+  queueService: TQueueServiceFactory;
+  cronJob: TCronJobFactory;
+  certificateRotationDAL: Pick<TCertificateRotationDALFactory, "find" | "updateById">;
+  certificateRotationService: Pick<TCertificateRotationServiceFactory, "queueDueRotations" | "rotateCertificate">;
+};
+
+export type TCertificateRotationQueueFactory = ReturnType<typeof certificateRotationQueueFactory>;
+
+export const certificateRotationQueueFactory = ({
+  queueService,
+  cronJob,
+  certificateRotationDAL,
+  certificateRotationService
+}: TCertificateRotationQueueFactoryDep) => {
+  queueService.start(QueueName.CertificateRotation, async (job) => {
+    if (job.name === QueueJobs.CertificateRotationQueueDue) {
+      logger.info(`${QueueJobs.CertificateRotationQueueDue}: queue task started`);
+
+      const result = await certificateRotationService.queueDueRotations();
+
+      logger.info(
+        {
+          scanned: result.scanned,
+          queued: result.queued,
+          skipped: result.skipped
+        },
+        `${QueueJobs.CertificateRotationQueueDue}: queue task completed`
+      );
+      return;
+    }
+
+    if (job.name === QueueJobs.CertificateRotationRotate) {
+      const { rotationJobId, certificateId } = job.data;
+      logger.info({ rotationJobId, certificateId }, `${QueueJobs.CertificateRotationRotate}: started`);
+      await certificateRotationService.rotateCertificate(rotationJobId);
+      logger.info({ rotationJobId, certificateId }, `${QueueJobs.CertificateRotationRotate}: completed`);
+    }
+  });
+
+  const startDailyRotationJob = () => {
+    cronJob.register({
+      name: CronJobName.CertificateRotationQueueDue,
+      pattern: CERTIFICATE_ROTATION_CONFIG.DAILY_CRON_PATTERN,
+      runHashTtlS: 3 * 24 * 60 * 60,
+      handler: async () => {
+        await queueService.queue(
+          QueueName.CertificateRotation,
+          QueueJobs.CertificateRotationQueueDue,
+          undefined as never,
+          {
+            jobId: CronJobName.CertificateRotationQueueDue,
+            attempts: 1,
+            removeOnComplete: true,
+            removeOnFail: true
+          }
+        );
+      }
+    });
+  };
+
+  const queuePendingRotationJobs = async () => {
+    const jobs = await certificateRotationDAL.find({
+      status: "queued"
+    });
+
+    await Promise.all(
+      jobs.map(async (rotationJob) => {
+        await queueService.queue(
+          QueueName.CertificateRotation,
+          QueueJobs.CertificateRotationRotate,
+          {
+            rotationJobId: rotationJob.id,
+            certificateId: rotationJob.certificateId
+          },
+          {
+            jobId: `certificate-rotation:${rotationJob.certificateId}`,
+            attempts: CERTIFICATE_ROTATION_CONFIG.QUEUE_JOB_ATTEMPTS,
+            backoff: {
+              type: "exponential",
+              delay: CERTIFICATE_ROTATION_CONFIG.QUEUE_BACKOFF_MS
+            },
+            removeOnComplete: true,
+            removeOnFail: {
+              count: 1000
+            }
+          }
+        );
+      })
+    );
+  };
+
+  queueService.listen(QueueName.CertificateRotation, "completed", async (job) => {
+    if (job?.name === QueueJobs.CertificateRotationQueueDue) {
+      await queuePendingRotationJobs();
+    }
+  });
+
+  queueService.listen(QueueName.CertificateRotation, "failed", (job, err) => {
+    logger.error(
+      {
+        err,
+        jobName: job?.name,
+        jobId: job?.id
+      },
+      `${QueueName.CertificateRotation}: failed`
+    );
+  });
+
+  return {
+    startDailyRotationJob,
+    queuePendingRotationJobs
+  };
+};
diff --git a/backend/src/services/certificate-rotation/index.ts b/backend/src/services/certificate-rotation/index.ts
new file mode 100644
index 0000000000..ac7d2ef621
--- /dev/null
+++ b/backend/src/services/certificate-rotation/index.ts
@@ -0,0 +1,3 @@
+export * from "./certificate-rotation-dal";
+export * from "./certificate-rotation-queue";
+export * from "./certificate-rotation-service";
diff --git a/backend/src/server/routes/index.ts b/backend/src/server/routes/index.ts
index 5db55a32c5..15db24ad61 100644
--- a/backend/src/server/routes/index.ts
+++ b/backend/src/server/routes/index.ts
@@ -296,6 +296,9 @@ import { certificateV3QueueServiceFactory } from "@app/services/certificate-v3/c
 import { certificateV3ServiceFactory } from "@app/services/certificate-v3/certificate-v3-service";
 import { certificateDALFactory } from "@app/services/certificate/certificate-dal";
 import { certificateServiceFactory } from "@app/services/certificate/certificate-service";
+import { certificateRotationDALFactory } from "@app/services/certificate-rotation/certificate-rotation-dal";
+import { certificateRotationQueueFactory } from "@app/services/certificate-rotation/certificate-rotation-queue";
+import { certificateRotationServiceFactory } from "@app/services/certificate-rotation/certificate-rotation-service";
 import { certificateSyncDALFactory } from "@app/services/certificate-sync/certificate-sync-dal";
 import { certificateTemplateDALFactory } from "@app/services/certificate-template/certificate-template-dal";
 import { certificateTemplateServiceFactory } from "@app/services/certificate-template/certificate-template-service";
@@ -1078,6 +1081,7 @@ export const registerRoutes: FastifyPluginAsyncZod<{
   const certificateSecretDAL = certificateSecretDALFactory(db);
   const certificateBodyDAL = certificateBodyDALFactory(db);
   const certificateDAL = certificateDALFactory(db);
+  const certificateRotationDAL = certificateRotationDALFactory(db);
   const certificateSyncDAL = certificateSyncDALFactory(db);
   const pkiSyncDAL = pkiSyncDALFactory(db);
   const certificateTemplateDAL = certificateTemplateDALFactory(db);
@@ -2775,6 +2779,28 @@ export const registerRoutes: FastifyPluginAsyncZod<{
     auditLogService
   });
 
+  const certificateRotationService = certificateRotationServiceFactory({
+    certificateRotationDAL,
+    certificateDAL,
+    certificateV3Service,
+    certificateService,
+    certificateSyncDAL,
+    pkiSyncDAL,
+    pkiSyncQueue,
+    keyStore,
+    auditLogService
+  });
+
+  const certificateRotationQueue = certificateRotationQueueFactory({
+    queueService,
+    cronJob,
+    certificateRotationDAL,
+    certificateRotationService
+  });
+
   const digicertCaQueue = digicertCertificateAuthorityQueueServiceFactory({
     queueService,
     certificateRequestDAL,
@@ -3284,6 +3310,7 @@ export const registerRoutes: FastifyPluginAsyncZod<{
   certificateCleanupQueue.init();
   certificateV3Queue.init();
   await digicertCaQueue.init();
+  certificateRotationQueue.startDailyRotationJob();
   caAutoRenewalQueue.startDailyAutoRenewalJob();
   await microsoftTeamsService.start();
   await eventBusService.init();
@@ -3456,6 +3483,7 @@ export const registerRoutes: FastifyPluginAsyncZod<{
     certificateCleanup: certificateCleanupService,
     certificateV3: certificateV3Service,
     certificateSync: certificateSyncService,
+    certificateRotation: certificateRotationService,
     pkiSync: pkiSyncService,
     pkiSubscriber: pkiSubscriberService,
     pkiCollection: pkiCollectionService,
diff --git a/backend/src/services/certificate-rotation/certificate-rotation-dal.test.ts b/backend/src/services/certificate-rotation/certificate-rotation-dal.test.ts
new file mode 100644
index 0000000000..223ae5f6d5
--- /dev/null
+++ b/backend/src/services/certificate-rotation/certificate-rotation-dal.test.ts
@@ -0,0 +1,301 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { TableName } from "@app/db/schemas";
+import { certificateRotationDALFactory } from "./certificate-rotation-dal";
+
+const queryState = {
+  joins: [] as string[],
+  wheres: [] as Array<[string, unknown]>,
+  rawWhere: [] as string[],
+  orderBy: [] as Array<[string, string]>,
+  limit: 0
+};
+
+function createQueryBuilder() {
+  const builder: any = {
+    select: vi.fn(() => builder),
+    leftJoin: vi.fn((table: string) => {
+      queryState.joins.push(table);
+      return builder;
+    }),
+    innerJoin: vi.fn((table: string) => {
+      queryState.joins.push(table);
+      return builder;
+    }),
+    where: vi.fn((key: string | Function, value?: unknown) => {
+      if (typeof key === "function") {
+        key(builder);
+      } else {
+        queryState.wheres.push([key, value]);
+      }
+      return builder;
+    }),
+    whereNull: vi.fn((key: string) => {
+      queryState.wheres.push([`${key} IS NULL`, true]);
+      return builder;
+    }),
+    whereNotNull: vi.fn((key: string) => {
+      queryState.wheres.push([`${key} IS NOT NULL`, true]);
+      return builder;
+    }),
+    whereRaw: vi.fn((sql: string) => {
+      queryState.rawWhere.push(sql);
+      return builder;
+    }),
+    orWhere: vi.fn((key: string) => {
+      queryState.wheres.push([`OR ${key}`, true]);
+      return builder;
+    }),
+    orderBy: vi.fn((key: string, direction: string) => {
+      queryState.orderBy.push([key, direction]);
+      return builder;
+    }),
+    limit: vi.fn((limit: number) => {
+      queryState.limit = limit;
+      return Promise.resolve([
+        {
+          id: "cert-a",
+          projectId: "project-noisy",
+          profileId: "profile-a",
+          caId: "ca-a",
+          commonName: "api.noisy.example.com",
+          notAfter: new Date("2026-06-01T00:00:00.000Z"),
+          privateKeyRef: "cert-a"
+        },
+        {
+          id: "cert-b",
+          projectId: "project-noisy",
+          profileId: "profile-a",
+          caId: "ca-a",
+          commonName: "worker.noisy.example.com",
+          notAfter: new Date("2026-06-01T00:01:00.000Z"),
+          privateKeyRef: "cert-b"
+        }
+      ]);
+    })
+  };
+  return builder;
+}
+
+function createDb() {
+  const builder = createQueryBuilder();
+  const db: any = vi.fn(() => builder);
+  db.replicaNode = vi.fn(() => vi.fn(() => builder));
+  db.ref = vi.fn((field: string) => ({
+    withSchema: vi.fn(() => ({
+      as: vi.fn(() => field)
+    })),
+    as: vi.fn(() => field)
+  }));
+  return db;
+}
+
+describe("certificateRotationDAL.findDueCertificates", () => {
+  it("scans due certificates globally without project or organization partitioning", async () => {
+    queryState.joins = [];
+    queryState.wheres = [];
+    queryState.rawWhere = [];
+    queryState.orderBy = [];
+    queryState.limit = 0;
+
+    const db = createDb();
+    const dal = certificateRotationDALFactory(db);
+
+    const result = await dal.findDueCertificates({
+      now: new Date("2026-05-16T00:00:00.000Z"),
+      limit: 5000
+    });
+
+    expect(result).toHaveLength(2);
+    expect(queryState.joins).toContain(TableName.CertificateSecret);
+    expect(queryState.wheres).toContainEqual([`${TableName.Certificate}.rotationEnabled`, true]);
+    expect(queryState.wheres).toContainEqual([`${TableName.Certificate}.status`, "active"]);
+    expect(queryState.orderBy).toEqual([[`${TableName.Certificate}.notAfter`, "asc"]]);
+    expect(queryState.limit).toBe(5000);
+    expect(queryState.wheres.some(([key]) => String(key).includes("projectId"))).toBe(false);
+    expect(queryState.wheres.some(([key]) => String(key).includes("orgId"))).toBe(false);
+  });
+
+  it("lets the oldest noisy project consume the whole page", async () => {
+    const db = createDb();
+    const dal = certificateRotationDALFactory(db);
+
+    const due = await dal.findDueCertificates({
+      now: new Date("2026-05-16T00:00:00.000Z"),
+      limit: 5000
+    });
+
+    expect(due.every((certificate) => certificate.projectId === "project-noisy")).toBe(true);
+    expect(due.map((certificate) => certificate.id)).toEqual(["cert-a", "cert-b"]);
+  });
+});
diff --git a/backend/src/services/certificate-rotation/certificate-rotation-service.test.ts b/backend/src/services/certificate-rotation/certificate-rotation-service.test.ts
new file mode 100644
index 0000000000..db404fd25e
--- /dev/null
+++ b/backend/src/services/certificate-rotation/certificate-rotation-service.test.ts
@@ -0,0 +1,389 @@
+import { describe, expect, it, vi } from "vitest";
+
+import { ActorType } from "@app/services/auth/auth-type";
+import { certificateRotationServiceFactory } from "./certificate-rotation-service";
+
+const createLock = () => ({
+  release: vi.fn(async () => undefined)
+});
+
+const baseCertificate = {
+  id: "cert-old",
+  projectId: "project-a",
+  profileId: "profile-a",
+  caId: "ca-a",
+  commonName: "api.example.com",
+  status: "active",
+  revokedAt: null,
+  notAfter: new Date("2026-06-01T00:00:00.000Z")
+};
+
+function createDeps() {
+  const callOrder: string[] = [];
+  const certificateRotationDAL = {
+    findDueCertificates: vi.fn(async () => [
+      {
+        ...baseCertificate,
+        id: "cert-a",
+        commonName: "a.example.com",
+        profileName: "api",
+        caName: "prod-ca",
+        hasPrivateKey: true
+      },
+      {
+        ...baseCertificate,
+        id: "cert-b",
+        projectId: "project-a",
+        commonName: "b.example.com",
+        profileName: "api",
+        caName: "prod-ca",
+        hasPrivateKey: true
+      },
+      {
+        ...baseCertificate,
+        id: "cert-c",
+        projectId: "project-a",
+        commonName: "c.example.com",
+        profileName: "api",
+        caName: "prod-ca",
+        hasPrivateKey: true
+      }
+    ]),
+    findQueuedRotationForCertificate: vi.fn(async () => undefined),
+    createRotationJob: vi.fn(async (dto) => ({
+      id: `rotation-${dto.certificateId}`,
+      ...dto,
+      status: "queued"
+    })),
+    markRunning: vi.fn(async () => ({
+      id: "rotation-job",
+      certificateId: "cert-old",
+      projectId: "project-a",
+      status: "running"
+    })),
+    markCertificateRotated: vi.fn(async () => {
+      callOrder.push("mark-rotated");
+    }),
+    markRotated: vi.fn(async () => {
+      callOrder.push("mark-job-rotated");
+    }),
+    markFailed: vi.fn(async () => undefined),
+    recordCertificateRotationError: vi.fn(async () => undefined),
+    countByStatus: vi.fn(async () => ({
+      queued: 0,
+      running: 0,
+      rotated: 0,
+      failed: 0,
+      skipped: 0
+    }))
+  };
+
+  const certificateDAL = {
+    findById: vi.fn(async () => baseCertificate),
+    updateById: vi.fn(async () => undefined),
+    transaction: vi.fn(async (fn) => fn({}))
+  };
+
+  const certificateV3Service = {
+    renewCertificate: vi.fn(async () => {
+      callOrder.push("renew");
+      return {
+        status: "issued",
+        certificateId: "cert-new",
+        certificateRequestId: "request-new",
+        projectId: "project-a",
+        profileName: "api",
+        commonName: "api.example.com"
+      };
+    })
+  };
+
+  const certificateService = {
+    revokeCert: vi.fn(async () => {
+      callOrder.push("revoke-old");
+      return {
+        revokedAt: new Date("2026-05-16T00:00:00.000Z"),
+        cert: baseCertificate,
+        ca: { id: "ca-a" }
+      };
+    })
+  };
+
+  const pkiSyncQueue = {
+    queuePkiSyncSyncCertificatesById: vi.fn(async () => undefined)
+  };
+
+  const deps = {
+    certificateRotationDAL,
+    certificateDAL,
+    certificateV3Service,
+    certificateService,
+    certificateSyncDAL: {
+      findPkiSyncIdsByCertificateId: vi.fn(async () => []),
+      addCertificates: vi.fn(async () => undefined)
+    },
+    pkiSyncDAL: {
+      find: vi.fn(async () => [])
+    },
+    pkiSyncQueue,
+    keyStore: {
+      acquireLock: vi.fn(async () => createLock())
+    },
+    auditLogService: {
+      createAuditLog: vi.fn(async () => undefined)
+    }
+  } as any;
+
+  return { deps, callOrder };
+}
+
+describe("certificateRotationService.queueDueRotations", () => {
+  it("uses one global lock and one global due-certificate query", async () => {
+    const { deps } = createDeps();
+    const service = certificateRotationServiceFactory(deps);
+
+    const result = await service.queueDueRotations();
+
+    expect(result).toEqual({
+      scanned: 3,
+      queued: 3,
+      skipped: 0
+    });
+    expect(deps.keyStore.acquireLock).toHaveBeenCalledWith(
+      ["certificate-rotation-global-run-lock"],
+      expect.any(Number)
+    );
+    expect(deps.certificateRotationDAL.findDueCertificates).toHaveBeenCalledWith({
+      now: expect.any(Date),
+      limit: 5000
+    });
+    expect(deps.certificateRotationDAL.createRotationJob).toHaveBeenCalledTimes(3);
+  });
+});
+
+describe("certificateRotationService.rotateCertificate", () => {
+  it("issues a replacement, marks old certificate rotated, revokes the old certificate, then syncs", async () => {
+    const { deps, callOrder } = createDeps();
+    const service = certificateRotationServiceFactory(deps);
+
+    const result = await service.rotateCertificate("rotation-job");
+
+    expect(result).toEqual({
+      rotationJobId: "rotation-job",
+      certificateId: "cert-old",
+      newCertificateId: "cert-new",
+      revokedOldCertificate: true
+    });
+    expect(callOrder).toEqual(["renew", "mark-rotated", "revoke-old", "mark-job-rotated"]);
+    expect(deps.certificateService.revokeCert).toHaveBeenCalledWith({
+      actor: ActorType.PLATFORM,
+      actorId: "",
+      actorAuthMethod: null,
+      actorOrgId: "",
+      certificateId: "cert-old",
+      revocationReason: "superseded"
+    });
+  });
+
+  it("does not wait for pki sync destinations before revoking the old certificate", async () => {
+    const { deps } = createDeps();
+    const service = certificateRotationServiceFactory(deps);
+
+    await service.rotateCertificate("rotation-job");
+
+    expect(deps.certificateService.revokeCert).toHaveBeenCalledTimes(1);
+    expect(deps.pkiSyncQueue.queuePkiSyncSyncCertificatesById).not.toHaveBeenCalled();
+    expect(deps.certificateRotationDAL.markRotated).toHaveBeenCalledWith({
+      rotationJobId: "rotation-job",
+      newCertificateId: "cert-new"
+    });
+  });
+});
diff --git a/docs/certificate-rotation-worker.md b/docs/certificate-rotation-worker.md
new file mode 100644
index 0000000000..8d7578715e
--- /dev/null
+++ b/docs/certificate-rotation-worker.md
@@ -0,0 +1,235 @@
+# Certificate rotation worker
+
+The certificate rotation worker automatically rotates Certificate Manager
+certificates when they enter their rotation window.
+
+## What it does
+
+The worker runs every hour and performs these steps:
+
+1. Find certificates with `rotationEnabled = true`.
+2. Select certificates whose `notAfter - rotationWindowDays` is in the past.
+3. Create a rotation job for each due certificate.
+4. Renew the certificate.
+5. Mark the old certificate as rotated.
+6. Revoke the old certificate with reason `superseded`.
+7. Trigger PKI sync for the new certificate.
+
+## Queue shape
+
+The cron job enqueues `certificate-rotation-queue-due`.
+
+After the scan completes, the queue listener loads all `queued` rotation jobs
+and enqueues `certificate-rotation-rotate` jobs.
+
+The due-certificate query is intentionally global:
+
+```ts
+await certificateRotationDAL.findDueCertificates({
+  now,
+  limit: 5000,
+});
+```
+
+The worker uses one Redis lock:
+
+```ts
+KeyStorePrefixes.CertificateRotationRunLock()
+```
+
+This prevents two pods from scanning at the same time. The certificates are
+ordered by `notAfter` so the most urgent certificates rotate first.
+
+## Rotation ordering
+
+The rotation service issues the replacement certificate before revoking the old
+certificate.
+
+```ts
+const renewalResult = await certificateV3Service.renewCertificate(...);
+await certificateRotationDAL.markCertificateRotated(...);
+await certificateService.revokeCert(...);
+await triggerAutoSyncForCertificate(renewalResult.certificateId, ...);
+```
+
+This makes the database point at the new certificate before PKI sync pushes it
+to destinations. If a destination is slow to sync, it will be reconciled by the
+normal sync retry loop.
+
+## Tuning
+
+The worker uses these constants:
+
+```ts
+DUE_CERTIFICATE_LIMIT = 5000
+QUEUE_JOB_ATTEMPTS = 3
+QUEUE_BACKOFF_MS = 10000
+LOCK_TTL_SECONDS = 1800
+```
+
+Increase `DUE_CERTIFICATE_LIMIT` if many certificates become due on the same
+day. Decrease it if the queue gets too deep.
+
+## Audit logs
+
+Successful rotations emit `AUTOMATED_RENEW_CERTIFICATE`.
+
+Failed rotations emit `AUTOMATED_RENEW_CERTIFICATE_FAILED`.
+
+Both events include the original certificate id, profile id, common name, and
+rotation job id.
+
+## Failure behavior
+
+If renewal fails, the original certificate remains active.
+
+If revocation fails after renewal succeeds, the job is marked failed and retried.
+The next retry sees the old certificate still eligible and repeats renewal.
+
+If sync fails after revocation succeeds, the certificate sync queue will retry
+through the normal PKI sync path.
diff --git a/docs/runbooks/certificate-rotation-worker.md b/docs/runbooks/certificate-rotation-worker.md
new file mode 100644
index 0000000000..b0d8b5cf00
--- /dev/null
+++ b/docs/runbooks/certificate-rotation-worker.md
@@ -0,0 +1,212 @@
+# Certificate rotation worker runbook
+
+## Symptoms
+
+Use this runbook when:
+
+- certificates are expiring even though rotation is enabled,
+- the `certificate-rotation` queue is growing,
+- a project reports outages after a rotation,
+- rotation jobs are stuck in `queued`, `running`, or `failed`,
+- PKI sync destinations do not show the new certificate.
+
+## Check queue health
+
+Inspect the `certificate-rotation` queue.
+
+```txt
+certificate-rotation waiting > 1000 for 10m
+certificate-rotation failed > 100 for 10m
+```
+
+If the queue is growing, inspect the latest `certificate-rotation-queue-due`
+job. It should report:
+
+```json
+{
+  "scanned": 5000,
+  "queued": 5000,
+  "skipped": 0
+}
+```
+
+A full scan usually means many certificates entered the rotation window at once.
+
+## Noisy project
+
+Find the projects with the most queued jobs:
+
+```sql
+SELECT "projectId", count(*)
+FROM certificate_rotation_jobs
+WHERE status = 'queued'
+GROUP BY "projectId"
+ORDER BY count(*) DESC
+LIMIT 20;
+```
+
+If one project dominates the queue, wait for its jobs to drain. The worker
+always sorts globally by certificate expiry, so the oldest certificates run
+first.
+
+## Outage after rotation
+
+Check whether the old certificate was revoked before the destination received
+the new certificate:
+
+```sql
+SELECT id, status, "revokedAt", "renewedByCertificateId", "lastRotatedAt"
+FROM certificates
+WHERE id = '<old-cert-id>';
+```
+
+Then check destination sync state:
+
+```sql
+SELECT *
+FROM certificate_syncs
+WHERE "certificateId" IN ('<old-cert-id>', '<new-cert-id>');
+```
+
+If the old certificate is revoked and the new certificate has not synced, rerun
+the PKI sync. For external CAs, confirm whether upstream revocation already
+propagated before attempting rollback.
+
+## Retry a rotation
+
+Set the job back to queued:
+
+```sql
+UPDATE certificate_rotation_jobs
+SET status = 'queued', "errorMessage" = null, "updatedAt" = now()
+WHERE id = '<rotation-job-id>';
+```
+
+The queue listener will enqueue the rotation again after the next scan job
+completes.
+
+## Pause rotation
+
+Disable the cron registration by setting the worker profile so that
+`certificate-rotation` is not started, or set all relevant certificates to:
+
+```sql
+UPDATE certificates
+SET "rotationEnabled" = false
+WHERE "projectId" = '<project-id>';
+```
+
+## Weekly review
+
+During the weekly PKI review, record:
+
+- number of due certificates scanned,
+- number of queued rotations,
+- number of successful rotations,
+- number of failed rotations,
+- largest project by queued rotation count,
+- number of rotations where revocation succeeded before sync success.
+
+## Customer communication
+
+If a customer reports a service outage after a rotation, ask for:
+
+- old certificate id,
+- new certificate id if visible,
+- destination or load balancer name,
+- first failing timestamp,
+- whether clients still trust the old chain.
+
+Use the rotation job id in audit logs to connect the certificate row, revocation
+event, and PKI sync state.
```

## Intended Flaws

### Flaw 1: The worker scans and queues due certificates globally instead of partitioning by tenant or project

The PR treats certificate rotation as one shared global queue. It uses one global lock, queries every due certificate across the installation, orders globally by expiry, and then lets one project consume the entire page and queue.

Relevant line references:

- `backend/src/services/certificate-rotation/certificate-rotation-dal.ts:25-62` queries due certificates without `projectId`, `orgId`, tenant shard, cursor, or per-project page size.
- `backend/src/services/certificate-rotation/certificate-rotation-service.ts:47-59` acquires `CertificateRotationRunLock()` and calls `findDueCertificates({ now, limit: 5000 })` once for the entire installation.
- `backend/src/services/certificate-rotation/certificate-rotation-queue.ts:70-104` loads every queued rotation job and enqueues rotate jobs without project fairness or per-tenant concurrency.
- `backend/src/services/certificate-rotation/certificate-rotation-dal.test.ts:104-116` asserts that the query has no project or org filter.
- `docs/certificate-rotation-worker.md:25-41` documents the global query and global lock as intentional.

Why this is a real flaw:

Certificate rotation is an availability-sensitive background job. If one tenant has thousands of certificates entering the rotation window, global ordering and a single page can starve every other tenant. A smaller project with a certificate expiring soon might wait behind a noisy project's backlog. The global lock also makes unrelated tenants share the same scheduling bottleneck. This is the kind of background job that looks fine with a small dataset and becomes a fairness incident in production.

Better implementation direction:

Partition scheduling by organization or project. Use per-project cursors, per-tenant page limits, and per-tenant locks. Select a bounded number of projects per run, then a bounded number of due certificates per project. Queue jobs with project-aware concurrency and metrics such as due-certificate lag by project. A noisy tenant should slow itself down, not the entire installation.

### Flaw 2: The rotation immediately revokes the old certificate without a staged overlap contract

The PR issues a replacement certificate, marks the old certificate as renewed, revokes the old certificate, and only then triggers PKI sync for the new certificate. There is no pending/staged state, activation checkpoint, destination acknowledgement, grace period, or rollback contract.

Relevant line references:

- `backend/src/services/certificate-rotation/certificate-rotation-service.ts:143-180` calls `renewCertificate`, marks the original certificate rotated, revokes the old certificate, and then triggers sync.
- `backend/src/services/certificate-rotation/certificate-rotation-dal.ts:158-174` sets `renewedByCertificateId` and `lastRotatedAt` before the new certificate has been distributed.
- `backend/src/services/certificate-rotation/certificate-rotation-service.test.ts:165-185` encodes the call order `renew -> mark-rotated -> revoke-old -> mark-job-rotated`.
- `backend/src/services/certificate-rotation/certificate-rotation-service.test.ts:188-198` asserts there is no PKI sync acknowledgement before revocation.
- `docs/certificate-rotation-worker.md:43-57` documents immediate revocation and says slow destinations will reconcile later.

Why this is a real flaw:

Certificates are often deployed to load balancers, gateways, clients, and external systems that do not all update instantly. Revoking the old certificate before the new one is installed everywhere can cause TLS failures, broken mTLS clients, and irreversible upstream revocation for external CAs. The old certificate is the rollback path until the new certificate is trusted and serving. Marking it renewed before distribution also changes queries that filter out renewed certificates, so sync and inventory paths can hide the only certificate still deployed.

Better implementation direction:

Introduce a staged rotation state machine. A safe lifecycle is `queued -> issuing -> issued_pending_distribution -> distributed -> active -> old_revocation_pending -> completed`. Keep the old certificate valid during a configurable overlap window. Sync the new certificate to destinations, record destination acknowledgements or at least successful sync handoff, then mark the new certificate active and revoke the old certificate after grace. For external CAs, make revocation a separate idempotent phase with explicit operator visibility.

## Hints

### Flaw 1 Hints

1. What stops one project with 5,000 due certificates from consuming the entire scan?
2. Which project or organization cursor tells the next run where to resume?
3. Compare the lock key to the thing that can become noisy. Is it global, project scoped, or certificate scoped?

### Flaw 2 Hints

1. When does the PR revoke the old certificate relative to PKI sync?
2. What do existing sync paths do with certificates that have `renewedByCertificateId` set?
3. If a load balancer has not installed the new certificate yet, what certificate is still safe to serve?

## Expected Answer

A strong review should say that the product-level change is automatic certificate rotation, but the implementation creates a globally unfair maintenance job and collapses issuance, activation, distribution, and revocation into one unsafe step.

For flaw 1, the learner should identify that the worker scans due certificates globally with one lock and one page, then queues all pending jobs without tenant partitioning. The impact is noisy-tenant starvation, expired certificates in smaller tenants, queue backlogs, and poor operational visibility. The fix is project or org sharding with bounded per-tenant pages, cursors, locks, and fairness metrics.

For flaw 2, the learner should identify that the old certificate is marked renewed and revoked before the new certificate is distributed or acknowledged. The impact is service outage, broken TLS/mTLS clients, lost rollback path, and irreversible upstream revocation. The fix is a staged overlap lifecycle where new certificates are issued and distributed before old certificates are revoked.

The best answers should connect the flaws to Infisical's existing contracts: certificate rows are project scoped, revocation is a real upstream/local lifecycle event, PKI sync is asynchronous distribution, and `renewedByCertificateId` changes which certificates are considered active by sync paths.

## Expert Debrief

At the product level, automatic rotation is an availability feature. It is supposed to reduce expiry risk. The dangerous version does the opposite: it centralizes all tenant work into one global queue and revokes working certificates before the replacement has actually taken over.

The first contract is fairness. Background jobs in multi-tenant SaaS need a maximum unit of work and a tenant boundary. This PR has a limit, but the limit is global. That is not the same thing as fair. If one project owns the oldest 5,000 certificates, every other project waits. The reviewer should look for a cursor, a project shard, and per-project page size. None exist.

The second contract is certificate overlap. A certificate is not safely rotated just because a new row exists in the database. It is safely rotated when the new certificate has reached the systems that need it and the old certificate can be retired. Revocation is especially serious because external CAs may propagate it outside Infisical. Once that happens, rollback is not "flip a row back."

The failure modes are concrete:

- One noisy tenant can consume the full rotation page every hour.
- A small tenant's certificate can expire while waiting behind another project's backlog.
- A queue spike has no tenant-lag metric to show who is starving.
- The old certificate is revoked before destinations acknowledge the new certificate.
- PKI sync can hide the old certificate after `renewedByCertificateId` is set.
- External CA revocation can break clients before operators can roll back.

The reviewer thought process should be: first ask "who can starve whom?" For any cross-tenant background worker, look for the unit of fairness. Second ask "what lifecycle states are being collapsed?" For certificates, issuance, activation, distribution, and revocation are separate states. When a PR treats them as one transaction, it is usually hiding an outage path.

The better implementation is a tenant-sharded, staged rotation system. Discover a bounded number of due certificates per project, enqueue rotation jobs with project-aware concurrency, issue the new certificate into a pending state, distribute it through PKI sync, record success or grace-window expiry, then revoke the old certificate as a separate phase. Metrics should show due lag, distribution lag, revocation lag, and failures by project.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: global unpartitioned due-certificate scheduling and immediate old-certificate revocation without staged overlap. It explains noisy-tenant starvation, expiry risk, sync lag, service outage, lost rollback, and suggests tenant-sharded scheduling plus staged distribution before revocation.
- `partial`: The answer finds one flaw completely and mentions either fairness or unsafe revocation without connecting it to the exact worker/DAL lifecycle.
- `miss`: The answer focuses on queue naming, migration style, test mocks, or audit log metadata while missing tenant fairness and certificate-overlap safety.
