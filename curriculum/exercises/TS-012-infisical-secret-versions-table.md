# TS-012: Infisical Secret Versions Table

## Metadata

- `id`: TS-012
- `source_repo`: [Infisical/infisical](https://github.com/Infisical/infisical)
- `repo_area`: Knex migrations, generated database schemas, secret v2 bridge DAL, secret version DAL, secret service helpers, project secret sync tests
- `mode`: synthetic_degraded
- `difficulty`: 2
- `target_diff_lines`: 985
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about schema rollouts, secret value storage, history tables, rollback safety, rolling deploys, and migration backfills without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR makes secret versions the canonical storage location for encrypted secret values.

Today `secrets_v2` stores the current encrypted value and `secret_versions_v2` stores historical copies. This duplicates encrypted payloads and makes some version-history operations harder to reason about. The PR adds a `currentVersionId` pointer on `secrets_v2`, moves value/comment/reminder fields into `secret_versions_v2`, and updates the secret read/update paths to load the current version through that pointer.

The PR adds:

- a migration that backfills `currentVersionId` for existing secrets,
- generated schema updates for `secrets_v2`,
- DAL helpers that join secrets to their current version,
- service changes that read current value fields from `secret_versions_v2`,
- write-path changes that create a new version and then update the pointer,
- tests for listing, updating, and syncing secrets after migration.

## Existing Code Context

The real Infisical codebase already has these relevant contracts:

- `backend/src/db/schemas/secrets-v2.ts` defines `SecretsV2Schema`, where current secret rows contain `key`, `encryptedValue`, `encryptedComment`, reminder fields, metadata, `version`, and `folderId`.
- `backend/src/db/schemas/secret-versions-v2.ts` defines `SecretVersionsV2Schema`, where each historical row contains the encrypted value fields, `secretId`, `folderId`, actor fields, and redaction fields.
- `backend/src/db/migrations/20240730181850_secret-v2.ts` creates `secrets_v2`, `secret_versions_v2`, tag junctions, approval-request tables, and snapshot tables. It keeps current secret data and version data separate but duplicated.
- `backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts` centralizes current secret reads and cache invalidation through `SecretServiceCacheKeys`.
- `backend/src/services/secret-v2-bridge/secret-version-dal.ts` has version lookup helpers such as `findLatestVersionByFolderId`, `findLatestVersionMany`, and version-history queries with actors.
- `backend/src/services/secret-v2-bridge/secret-v2-bridge-fns.ts` inserts secret version rows while updating current secret rows for rename/reference updates.
- `backend/src/db/migrations/20250602155451_fix-secret-versions.ts` shows a batched repair migration for missing secret versions. It chunks secret IDs and does not pretend rollback is trivial.
- `backend/src/db/migrations/20260305133310_secret-key-index.ts` and `20260306202508_add-missing-secret-versions-v2-indexes.ts` show production index work using `CREATE INDEX CONCURRENTLY` with `transaction: false`.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `backend/src/db/migrations/20260510103000_canonical_secret_versions_v2.ts`
- `backend/src/db/schemas/secrets-v2.ts`
- `backend/src/db/schemas/secret-versions-v2.ts`
- `backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts`
- `backend/src/services/secret-v2-bridge/secret-version-dal.ts`
- `backend/src/services/secret-v2-bridge/secret-v2-bridge-fns.ts`
- `backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts`
- `backend/src/services/secret-v2-bridge/secret-v2-bridge-service.test.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on migration safety, storage contracts, and runtime compatibility while old and new code coexist.

## Diff

```diff
diff --git a/backend/src/db/migrations/20260510103000_canonical_secret_versions_v2.ts b/backend/src/db/migrations/20260510103000_canonical_secret_versions_v2.ts
new file mode 100644
index 0000000000..e1a2a82b15
--- /dev/null
+++ b/backend/src/db/migrations/20260510103000_canonical_secret_versions_v2.ts
@@ -0,0 +1,211 @@
+/* eslint-disable no-await-in-loop */
+import { Knex } from "knex";
+
+import { chunkArray } from "@app/lib/fn";
+import { selectAllTableCols } from "@app/lib/knex";
+import { logger } from "@app/lib/logger";
+
+import { TableName } from "../schemas";
+import { createOnUpdateTrigger, dropOnUpdateTrigger } from "../utils";
+
+const BATCH_SIZE = 5000;
+const INSERT_BATCH_SIZE = 9000;
+
+type TSecretV2Row = {
+  id: string;
+  version: number;
+  type: string;
+  key: string;
+  encryptedValue: Buffer | null;
+  encryptedComment: Buffer | null;
+  reminderNote: string | null;
+  reminderRepeatDays: number | null;
+  skipMultilineEncoding: boolean | null;
+  metadata: unknown;
+  userId: string | null;
+  folderId: string;
+  createdAt: Date;
+  updatedAt: Date;
+};
+
+type TVersionRow = {
+  id: string;
+  secretId: string;
+  version: number;
+};
+
+const getLatestVersionsBySecretId = async (knex: Knex, secretIds: string[]) => {
+  const rows = await knex(TableName.SecretVersionV2)
+    .whereIn("secretId", secretIds)
+    .select("id", "secretId", "version")
+    .orderBy("version", "desc");
+
+  return rows.reduce<Record<string, TVersionRow>>((acc, row) => {
+    if (!acc[row.secretId]) {
+      acc[row.secretId] = row;
+    }
+    return acc;
+  }, {});
+};
+
+const createInitialVersionRows = async (knex: Knex, secrets: TSecretV2Row[]) => {
+  if (!secrets.length) return [];
+
+  const versionRows = secrets.map((secret) => ({
+    secretId: secret.id,
+    version: secret.version,
+    type: secret.type,
+    key: secret.key,
+    encryptedValue: secret.encryptedValue,
+    encryptedComment: secret.encryptedComment,
+    reminderNote: secret.reminderNote,
+    reminderRepeatDays: secret.reminderRepeatDays,
+    skipMultilineEncoding: secret.skipMultilineEncoding,
+    metadata: secret.metadata,
+    folderId: secret.folderId,
+    userId: secret.userId,
+    actorType: "platform",
+    createdAt: secret.createdAt,
+    updatedAt: secret.updatedAt
+  }));
+
+  const created = [];
+  for (const batch of chunkArray(versionRows, INSERT_BATCH_SIZE)) {
+    const inserted = await knex.batchInsert(TableName.SecretVersionV2, batch).returning(["id", "secretId", "version"]);
+    created.push(...inserted);
+  }
+
+  return created;
+};
+
+const backfillCurrentVersionIds = async (knex: Knex) => {
+  logger.info("canonical-secret-versions: starting backfill");
+
+  let processed = 0;
+  let secrets: TSecretV2Row[];
+  do {
+    secrets = await knex(TableName.SecretV2)
+      .whereNull("currentVersionId")
+      .select(selectAllTableCols(TableName.SecretV2))
+      .orderBy("id", "asc")
+      .limit(BATCH_SIZE);
+
+    if (!secrets.length) break;
+
+    const secretIds = secrets.map((secret) => secret.id);
+    const latestVersions = await getLatestVersionsBySecretId(knex, secretIds);
+    const missingVersionSecrets = secrets.filter((secret) => !latestVersions[secret.id]);
+    const createdVersions = await createInitialVersionRows(knex, missingVersionSecrets);
+
+    const versionsBySecretId = {
+      ...latestVersions,
+      ...createdVersions.reduce<Record<string, TVersionRow>>((acc, row) => {
+        acc[row.secretId] = row;
+        return acc;
+      }, {})
+    };
+
+    for (const secret of secrets) {
+      const latestVersion = versionsBySecretId[secret.id];
+      if (!latestVersion) continue;
+
+      await knex(TableName.SecretV2)
+        .where({ id: secret.id })
+        .update({
+          currentVersionId: latestVersion.id,
+          version: latestVersion.version,
+          updatedAt: knex.fn.now()
+        });
+    }
+
+    processed += secrets.length;
+    logger.info(`canonical-secret-versions: processed ${processed} secrets`);
+  } while (secrets.length > 0);
+
+  logger.info("canonical-secret-versions: backfill complete");
+};
+
+export async function up(knex: Knex): Promise<void> {
+  const hasCurrentVersionId = await knex.schema.hasColumn(TableName.SecretV2, "currentVersionId");
+
+  if (!hasCurrentVersionId) {
+    await knex.schema.alterTable(TableName.SecretV2, (table) => {
+      table.uuid("currentVersionId").nullable();
+      table.foreign("currentVersionId").references("id").inTable(TableName.SecretVersionV2).onDelete("RESTRICT");
+      table.index("currentVersionId");
+    });
+  }
+
+  await backfillCurrentVersionIds(knex);
+
+  await knex.schema.alterTable(TableName.SecretV2, (table) => {
+    table.uuid("currentVersionId").notNullable().alter();
+  });
+
+  await knex.schema.alterTable(TableName.SecretV2, (table) => {
+    table.dropColumn("encryptedValue");
+    table.dropColumn("encryptedComment");
+    table.dropColumn("reminderNote");
+    table.dropColumn("reminderRepeatDays");
+    table.dropColumn("skipMultilineEncoding");
+    table.dropColumn("metadata");
+  });
+
+  await knex.schema.alterTable(TableName.SecretVersionV2, (table) => {
+    table.unique(["secretId", "version"]);
+  });
+
+  await createOnUpdateTrigger(knex, TableName.SecretV2);
+}
+
+export async function down(knex: Knex): Promise<void> {
+  const hasEncryptedValue = await knex.schema.hasColumn(TableName.SecretV2, "encryptedValue");
+
+  if (!hasEncryptedValue) {
+    await knex.schema.alterTable(TableName.SecretV2, (table) => {
+      table.binary("encryptedValue");
+      table.binary("encryptedComment");
+      table.string("reminderNote");
+      table.integer("reminderRepeatDays");
+      table.boolean("skipMultilineEncoding").defaultTo(false);
+      table.jsonb("metadata");
+    });
+  }
+
+  const secrets = await knex(TableName.SecretV2)
+    .join(TableName.SecretVersionV2, `${TableName.SecretV2}.currentVersionId`, `${TableName.SecretVersionV2}.id`)
+    .select(
+      knex.ref("id").withSchema(TableName.SecretV2).as("secretId"),
+      knex.ref("encryptedValue").withSchema(TableName.SecretVersionV2).as("encryptedValue"),
+      knex.ref("encryptedComment").withSchema(TableName.SecretVersionV2).as("encryptedComment"),
+      knex.ref("reminderNote").withSchema(TableName.SecretVersionV2).as("reminderNote"),
+      knex.ref("reminderRepeatDays").withSchema(TableName.SecretVersionV2).as("reminderRepeatDays"),
+      knex.ref("skipMultilineEncoding").withSchema(TableName.SecretVersionV2).as("skipMultilineEncoding"),
+      knex.ref("metadata").withSchema(TableName.SecretVersionV2).as("metadata")
+    );
+
+  for (const batch of chunkArray(secrets, BATCH_SIZE)) {
+    for (const secret of batch) {
+      await knex(TableName.SecretV2).where({ id: secret.secretId }).update({
+        encryptedValue: secret.encryptedValue,
+        encryptedComment: secret.encryptedComment,
+        reminderNote: secret.reminderNote,
+        reminderRepeatDays: secret.reminderRepeatDays,
+        skipMultilineEncoding: secret.skipMultilineEncoding,
+        metadata: secret.metadata
+      });
+    }
+  }
+
+  if (await knex.schema.hasColumn(TableName.SecretV2, "currentVersionId")) {
+    await knex.schema.alterTable(TableName.SecretV2, (table) => {
+      table.dropIndex("currentVersionId");
+      table.dropColumn("currentVersionId");
+    });
+  }
+
+  await dropOnUpdateTrigger(knex, TableName.SecretV2);
+  await createOnUpdateTrigger(knex, TableName.SecretV2);
+}
diff --git a/backend/src/db/schemas/secrets-v2.ts b/backend/src/db/schemas/secrets-v2.ts
index 2117d922af..742ce58823 100644
--- a/backend/src/db/schemas/secrets-v2.ts
+++ b/backend/src/db/schemas/secrets-v2.ts
@@ -7,8 +7,6 @@ import { z } from "zod";
 
 import { zodBuffer } from "@app/lib/zod";
 
-import { TImmutableDBKeys } from "./models";
+import { TImmutableDBKeys } from "./models";
 
 export const SecretsV2Schema = z.object({
   id: z.string().uuid(),
@@ -16,18 +14,11 @@ export const SecretsV2Schema = z.object({
   version: z.number().default(1),
   type: z.string().default("shared"),
   key: z.string(),
-  encryptedValue: zodBuffer.nullable().optional(),
-  encryptedComment: zodBuffer.nullable().optional(),
-  reminderNote: z.string().nullable().optional(),
-  reminderRepeatDays: z.number().nullable().optional(),
-  skipMultilineEncoding: z.boolean().default(false).nullable().optional(),
-  metadata: z.unknown().nullable().optional(),
+  currentVersionId: z.string().uuid(),
   userId: z.string().uuid().nullable().optional(),
   folderId: z.string().uuid(),
   createdAt: z.date(),
   updatedAt: z.date()
 });
 
 export type TSecretsV2 = z.infer<typeof SecretsV2Schema>;
 export type TSecretsV2Insert = Omit<z.input<typeof SecretsV2Schema>, TImmutableDBKeys>;
 export type TSecretsV2Update = Partial<Omit<z.input<typeof SecretsV2Schema>, TImmutableDBKeys>>;
diff --git a/backend/src/db/schemas/secret-versions-v2.ts b/backend/src/db/schemas/secret-versions-v2.ts
index 7a335e3b41..8a9e4083a6 100644
--- a/backend/src/db/schemas/secret-versions-v2.ts
+++ b/backend/src/db/schemas/secret-versions-v2.ts
@@ -15,11 +15,11 @@ export const SecretVersionsV2Schema = z.object({
   type: z.string().default("shared"),
   key: z.string(),
   encryptedValue: zodBuffer.nullable().optional(),
   encryptedComment: zodBuffer.nullable().optional(),
   reminderNote: z.string().nullable().optional(),
   reminderRepeatDays: z.number().nullable().optional(),
-  skipMultilineEncoding: z.boolean().default(false).nullable().optional(),
+  skipMultilineEncoding: z.boolean().default(false),
   metadata: z.unknown().nullable().optional(),
   envId: z.string().uuid().nullable().optional(),
   secretId: z.string().uuid(),
   folderId: z.string().uuid(),
   userId: z.string().uuid().nullable().optional(),
diff --git a/backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts b/backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts
index 8869a441aa..e15f2ce24e 100644
--- a/backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts
+++ b/backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts
@@ -16,7 +16,8 @@ import {
   buildFindFilter,
   ormify,
   selectAllTableCols,
   sqlNestRelationships,
+  TFindFilter,
   TFindOpt
 } from "@app/lib/knex";
 import { OrderByDirection } from "@app/lib/types";
@@ -49,6 +50,62 @@ interface TSecretV2DalArg {
 export const SECRET_DAL_TTL = () => applyJitter(10 * 60, 2 * 60);
 export const SECRET_DAL_VERSION_TTL = "15m";
 export const MAX_SECRET_CACHE_BYTES = 25 * 1024 * 1024;
+
+const selectSecretWithCurrentVersion = (db: TDbClient) => [
+  selectAllTableCols(TableName.SecretV2),
+  db.ref("id").withSchema(TableName.SecretVersionV2).as("currentVersionRowId"),
+  db.ref("encryptedValue").withSchema(TableName.SecretVersionV2).as("encryptedValue"),
+  db.ref("encryptedComment").withSchema(TableName.SecretVersionV2).as("encryptedComment"),
+  db.ref("reminderNote").withSchema(TableName.SecretVersionV2).as("reminderNote"),
+  db.ref("reminderRepeatDays").withSchema(TableName.SecretVersionV2).as("reminderRepeatDays"),
+  db.ref("skipMultilineEncoding").withSchema(TableName.SecretVersionV2).as("skipMultilineEncoding"),
+  db.ref("metadata").withSchema(TableName.SecretVersionV2).as("metadata"),
+  db.ref("actorType").withSchema(TableName.SecretVersionV2).as("currentVersionActorType")
+];
+
+const mapCurrentVersionSecret = (row: Record<string, unknown>) => {
+  const parsed = SecretsV2Schema.parse(row);
+
+  return {
+    _id: parsed.id,
+    ...parsed,
+    encryptedValue: row.encryptedValue as Buffer | null,
+    encryptedComment: row.encryptedComment as Buffer | null,
+    reminderNote: row.reminderNote as string | null,
+    reminderRepeatDays: row.reminderRepeatDays as number | null,
+    skipMultilineEncoding: row.skipMultilineEncoding as boolean,
+    metadata: row.metadata,
+    currentVersion: {
+      id: row.currentVersionRowId as string,
+      actorType: row.currentVersionActorType as string | null,
+      version: parsed.version
+    }
+  };
+};
+
+const joinCurrentVersion = (query: Knex.QueryBuilder) => {
+  void query.innerJoin(TableName.SecretVersionV2, (join) => {
+    void join
+      .on(`${TableName.SecretVersionV2}.id`, `${TableName.SecretV2}.currentVersionId`)
+      .andOn(`${TableName.SecretVersionV2}.secretId`, `${TableName.SecretV2}.id`);
+  });
+  return query;
+};
+
+type TCurrentSecret = TSecretsV2 & {
+  encryptedValue: Buffer | null;
+  encryptedComment: Buffer | null;
+  reminderNote: string | null;
+  reminderRepeatDays: number | null;
+  skipMultilineEncoding: boolean;
+  metadata: unknown;
+  currentVersion: {
+    id: string;
+    version: number;
+    actorType: string | null;
+  };
+};
+
 export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
   const secretOrm = ormify(db, TableName.SecretV2);
 
@@ -64,32 +121,24 @@ export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
   const findOne = async (filter: Partial<TSecretsV2>, tx?: Knex) => {
     try {
       const docs = await (tx || db.replicaNode())(TableName.SecretV2)
-        // eslint-disable-next-line @typescript-eslint/no-misused-promises
         .where(buildFindFilter(filter, TableName.SecretV2))
+        .modify(joinCurrentVersion)
         .leftJoin(
           TableName.SecretV2JnTag,
           `${TableName.SecretV2}.id`,
           `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
         )
@@ -99,20 +148,15 @@ export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
         .leftJoin(
           TableName.SecretReminderRecipients,
           `${TableName.SecretV2}.id`,
           `${TableName.SecretReminderRecipients}.secretId`
         )
         .leftJoin(TableName.Users, `${TableName.SecretReminderRecipients}.userId`, `${TableName.Users}.id`)
-        .select(selectAllTableCols(TableName.SecretV2))
+        .select(selectSecretWithCurrentVersion(db))
         .select(db.ref("id").withSchema(TableName.SecretReminderRecipients).as("reminderRecipientId"))
         .select(db.ref("username").withSchema(TableName.Users).as("reminderRecipientUsername"))
         .select(db.ref("email").withSchema(TableName.Users).as("reminderRecipientEmail"))
         .select(db.ref("id").withSchema(TableName.Users).as("reminderRecipientUserId"))
         .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
         .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
         .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"))
         .select(db.ref("rotationId").withSchema(TableName.SecretRotationV2SecretMapping))
         .select(db.ref("honeyTokenId").withSchema(TableName.HoneyTokenSecretMapping).as("honeyTokenId"));
       const data = sqlNestRelationships({
         data: docs,
         key: "id",
-        parentMapper: (el) => ({
-          _id: el.id,
-          ...SecretsV2Schema.parse(el),
-          isHoneyTokenSecret: Boolean(el.honeyTokenId),
-          isRotatedSecret: Boolean(el.rotationId),
-          rotationId: el.rotationId
-        }),
+        parentMapper: (el) => ({
+          ...mapCurrentVersionSecret(el),
+          isHoneyTokenSecret: Boolean(el.honeyTokenId),
+          isRotatedSecret: Boolean(el.rotationId),
+          rotationId: el.rotationId
+        }),
         childrenMapper: [
           {
             key: "tagId",
@@ -145,28 +189,30 @@ export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
       return data?.[0];
     } catch (error) {
       throw new DatabaseError({ error, name: `${TableName.SecretV2}: FindOne` });
     }
   };
 
-  const find = async (filter: TFindFilter<TSecretsV2 & { projectId?: string }>, opts: TFindOpt<TSecretsV2> = {}) => {
+  const find = async (
+    filter: TFindFilter<TSecretsV2 & { projectId?: string }>,
+    opts: TFindOpt<TSecretsV2> = {}
+  ): Promise<TCurrentSecret[]> => {
     const { offset, limit, sort, tx } = opts;
     try {
       const query = (tx || db.replicaNode())(TableName.SecretV2)
-        // eslint-disable-next-line @typescript-eslint/no-misused-promises
         .where(buildFindFilter(filter))
+        .modify(joinCurrentVersion)
         .leftJoin(
           TableName.SecretV2JnTag,
           `${TableName.SecretV2}.id`,
           `${TableName.SecretV2JnTag}.${TableName.SecretV2}Id`
         )
@@ -185,7 +231,7 @@ export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
         .leftJoin(TableName.ResourceMetadata, `${TableName.SecretV2}.id`, `${TableName.ResourceMetadata}.secretId`)
         .leftJoin(
           TableName.SecretRotationV2SecretMapping,
           `${TableName.SecretV2}.id`,
           `${TableName.SecretRotationV2SecretMapping}.secretId`
         )
@@ -197,7 +243,7 @@ export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
         .leftJoin(TableName.SecretFolder, `${TableName.SecretV2}.folderId`, `${TableName.SecretFolder}.id`)
         .leftJoin(TableName.Environment, `${TableName.SecretFolder}.envId`, `${TableName.Environment}.id`)
         .select(
           db.ref("id").withSchema(TableName.ResourceMetadata).as("metadataId"),
           db.ref("key").withSchema(TableName.ResourceMetadata).as("metadataKey"),
           db.ref("encryptedValue").withSchema(TableName.ResourceMetadata).as("metadataEncryptedValue"),
           db.ref("value").withSchema(TableName.ResourceMetadata).as("metadataValue")
         )
-        .select(selectAllTableCols(TableName.SecretV2))
+        .select(selectSecretWithCurrentVersion(db))
         .select(db.ref("projectId").withSchema(TableName.Environment).as("environmentProjectId"))
         .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
         .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
         .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"))
         .select(db.ref("rotationId").withSchema(TableName.SecretRotationV2SecretMapping))
@@ -219,18 +265,13 @@ export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
       const data = sqlNestRelationships({
         data: docs,
         key: "id",
-        parentMapper: (el) => ({
-          _id: el.id,
-          ...SecretsV2Schema.parse(el),
-          isHoneyTokenSecret: Boolean(el.honeyTokenId),
-          rotationId: el.rotationId,
-          isRotatedSecret: Boolean(el.rotationId),
-          projectId: el.environmentProjectId
-        }),
+        parentMapper: (el) => ({
+          ...mapCurrentVersionSecret(el),
+          isHoneyTokenSecret: Boolean(el.honeyTokenId),
+          rotationId: el.rotationId,
+          isRotatedSecret: Boolean(el.rotationId),
+          projectId: el.environmentProjectId
+        }),
         childrenMapper: [
           {
             key: "tagId",
@@ -281,15 +322,44 @@ export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
       return data;
     } catch (error) {
       throw new DatabaseError({ error, name: `${TableName.SecretV2}: Find` });
     }
   };
 
   const update = async (filter: Partial<TSecretsV2>, data: Omit<TSecretsV2Update, "version">, tx?: Knex) => {
     try {
-      const sec = await (tx || db)(TableName.SecretV2)
+      const sec = await (tx || db)(TableName.SecretV2)
         .where(filter)
         .update(data)
         .increment("version", 1)
         .returning("*");
       return sec;
     } catch (error) {
       throw new DatabaseError({ error, name: "update secret" });
     }
   };
+
+  const updateCurrentVersionId = async (
+    secretId: string,
+    currentVersionId: string,
+    version: number,
+    tx?: Knex
+  ): Promise<TSecretsV2> => {
+    try {
+      const [secret] = await (tx || db)(TableName.SecretV2)
+        .where({ id: secretId })
+        .update({
+          currentVersionId,
+          version,
+          updatedAt: db.fn.now()
+        })
+        .returning("*");
+
+      if (!secret) {
+        throw new NotFoundError({ message: `Secret ${secretId} not found` });
+      }
+
+      return secret;
+    } catch (error) {
+      throw new DatabaseError({ error, name: "update current secret version" });
+    }
+  };
@@ -540,6 +610,7 @@ export const secretV2BridgeDALFactory = ({ db, keyStore }: TSecretV2DalArg) => {
     ...secretOrm,
     findOne,
     find,
     update,
+    updateCurrentVersionId,
     bulkUpdate,
     bulkUpdateNoVersionIncrement,
     findByFolderId,
diff --git a/backend/src/services/secret-v2-bridge/secret-version-dal.ts b/backend/src/services/secret-v2-bridge/secret-version-dal.ts
index eab72b23c3..c4b4c7f8a9 100644
--- a/backend/src/services/secret-v2-bridge/secret-version-dal.ts
+++ b/backend/src/services/secret-v2-bridge/secret-version-dal.ts
@@ -20,6 +20,31 @@ export type TSecretVersionV2DALFactory = ReturnType<typeof secretVersionV2Bridge
 export const secretVersionV2BridgeDALFactory = (db: TDbClient) => {
   const secretVersionV2Orm = ormify(db, TableName.SecretVersionV2);
 
+  const createCurrentVersion = async (
+    data: Omit<TSecretVersionsV2, "id" | "createdAt" | "updatedAt">,
+    tx?: Knex
+  ) => {
+    try {
+      const [version] = await (tx || db)(TableName.SecretVersionV2).insert(data).returning("*");
+      return version;
+    } catch (error) {
+      throw new DatabaseError({ error, name: "CreateCurrentSecretVersion" });
+    }
+  };
+
+  const findCurrentBySecretIds = async (secretIds: string[], tx?: Knex) => {
+    try {
+      if (!secretIds.length) return {};
+      const rows = await (tx || db.replicaNode())(TableName.SecretVersionV2)
+        .join(TableName.SecretV2, `${TableName.SecretV2}.currentVersionId`, `${TableName.SecretVersionV2}.id`)
+        .whereIn(`${TableName.SecretV2}.id`, secretIds)
+        .select(selectAllTableCols(TableName.SecretVersionV2));
+      return rows.reduce<Record<string, TSecretVersionsV2>>((acc, row) => ({ ...acc, [row.secretId]: row }), {});
+    } catch (error) {
+      throw new DatabaseError({ error, name: "FindCurrentBySecretIds" });
+    }
+  };
+
   const findOne = async (filter: Partial<TSecretVersionsV2>, tx?: Knex) => {
     try {
       const doc = await (tx || db.replicaNode())(TableName.SecretVersionV2)
@@ -527,6 +552,8 @@ export const secretVersionV2BridgeDALFactory = (db: TDbClient) => {
   return {
     ...secretVersionV2Orm,
     pruneExcessVersions,
+    createCurrentVersion,
+    findCurrentBySecretIds,
     findLatestVersionMany,
     bulkUpdate,
     findLatestVersionByFolderId,
diff --git a/backend/src/services/secret-v2-bridge/secret-v2-bridge-fns.ts b/backend/src/services/secret-v2-bridge/secret-v2-bridge-fns.ts
index 5fd2dd8b20..b5f3ab51df 100644
--- a/backend/src/services/secret-v2-bridge/secret-v2-bridge-fns.ts
+++ b/backend/src/services/secret-v2-bridge/secret-v2-bridge-fns.ts
@@ -858,28 +858,55 @@ export const fnSecretBulkUpdateV2 = async ({
   const secrets = await secretDAL.bulkUpdate(sanitizedInputSecrets, tx);
   const secretVersions = await secretVersionDAL.insertMany(
     secrets.map(({ id, createdAt, updatedAt, ...secret }) => ({
       ...secret,
       secretId: id
     })),
     tx
   );
+
+  await Promise.all(
+    secretVersions.map((version) =>
+      secretDAL.updateCurrentVersionId(version.secretId, version.id, version.version, tx)
+    )
+  );
+
   await secretDAL.upsertSecretReferences(
     inputSecrets
       .filter(({ data: { references } }) => Boolean(references))
       .map(({ data: { references = [] } }, i) => ({
         secretId: secrets[i].id,
         references
       })),
     tx
   );
@@ -962,6 +989,39 @@ export const fnSecretBulkMoveV2 = async ({
   const movedSecrets = await secretDAL.bulkUpdateNoVersionIncrement(
     inputSecrets.map(({ id, folderId, version, ...rest }) => ({
       id,
       folderId: destinationFolderId,
       version,
       ...rest
     })),
     tx
   );
+
+  const movedVersions = await secretVersionDAL.insertMany(
+    movedSecrets.map((secret) => ({
+      secretId: secret.id,
+      version: secret.version + 1,
+      key: secret.key,
+      encryptedValue: secret.encryptedValue,
+      encryptedComment: secret.encryptedComment,
+      reminderNote: secret.reminderNote,
+      reminderRepeatDays: secret.reminderRepeatDays,
+      skipMultilineEncoding: secret.skipMultilineEncoding,
+      metadata: secret.metadata,
+      folderId: destinationFolderId,
+      userId: secret.userId,
+      actorType: actor.type
+    })),
+    tx
+  );
+
+  await Promise.all(
+    movedVersions.map((version) =>
+      secretDAL.updateCurrentVersionId(version.secretId, version.id, version.version, tx)
+    )
+  );
 
   await folderCommitService.createCommit(
     {
       actor,
@@ -1138,21 +1198,42 @@ export const fnUpdateSecretLinkedReferences = async ({
       const updatedSecret = await secretDAL.updateById(
         secretToUpdate.id,
-        { encryptedValue: newEncryptedValue, $incr: { version: 1 } },
+        { $incr: { version: 1 } },
         tx
       );
 
       // Track updated secret by ID to avoid duplicates
       updatedSecretsMap.set(secretToUpdate.id, {
         secret: updatedSecret,
         newEncryptedValue,
         newVersion: updatedSecret.version
       });
     }
   }
@@ -1167,19 +1248,31 @@ export const fnUpdateSecretLinkedReferences = async ({
     const secretVersions = await secretVersionDAL.insertMany(
       folderSecrets.map(({ secret, newEncryptedValue, newVersion }) => ({
         secretId: secret.id,
         version: newVersion,
         key: secret.key,
         encryptedValue: newEncryptedValue,
         encryptedComment: secret.encryptedComment,
         skipMultilineEncoding: secret.skipMultilineEncoding,
         type: secret.type,
         metadata: secret.metadata,
         folderId: secret.folderId,
         userId: secret.userId,
         actorType: ActorType.PLATFORM
       })),
       tx
     );
+
+    await Promise.all(
+      secretVersions.map((version) =>
+        secretDAL.updateCurrentVersionId(version.secretId, version.id, version.version, tx)
+      )
+    );
 
     const changes = secretVersions.map((sv) => ({
       type: CommitType.ADD,
       isUpdate: true,
       secretVersionId: sv.id
     }));
diff --git a/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts b/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts
index 9289d9a3fa..02a3a28e61 100644
--- a/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts
+++ b/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts
@@ -269,11 +269,21 @@ export const secretV2BridgeServiceFactory = ({
     const encryptedSecret = await secretDAL.findOne({
       folderId,
       type,
       key,
       ...(type === SecretType.Personal ? { userId } : {})
     });
 
+    if (!encryptedSecret.currentVersionId) {
+      throw new NotFoundError({
+        message: `Secret ${key} has not been migrated to current versions`
+      });
+    }
+
     if (!encryptedSecret) {
       throw new NotFoundError({
         message: `Secret ${key} not found`
       });
     }
@@ -329,12 +339,12 @@ export const secretV2BridgeServiceFactory = ({
       id: encryptedSecret.id,
       version: encryptedSecret.version,
       type: encryptedSecret.type,
       secretKey: encryptedSecret.key,
       secretValue: encryptedSecret.encryptedValue
-        ? decryptor({ cipherTextBlob: encryptedSecret.encryptedValue }).toString()
-        : "",
+        ? decryptor({ cipherTextBlob: encryptedSecret.encryptedValue }).toString()
+        : "",
       secretValueHidden,
       secretComment: encryptedSecret.encryptedComment
         ? decryptor({ cipherTextBlob: encryptedSecret.encryptedComment }).toString()
         : "",
       skipMultilineEncoding: encryptedSecret.skipMultilineEncoding,
@@ -672,16 +682,26 @@ export const secretV2BridgeServiceFactory = ({
     const encryptedSecrets = await secretDAL.find(
       {
         folderId,
         type: SecretType.Shared
       },
       { sort: [[SecretsOrderBy.Name, OrderByDirection.ASC]] }
     );
 
+    const unversionedSecrets = encryptedSecrets.filter((secret) => !secret.currentVersionId);
+    if (unversionedSecrets.length) {
+      throw new BadRequestError({
+        message: `Folder contains ${unversionedSecrets.length} secrets without current versions`
+      });
+    }
+
     return encryptedSecrets.map((encryptedSecret) => {
       const secretValue = encryptedSecret.encryptedValue
         ? decryptor({ cipherTextBlob: encryptedSecret.encryptedValue }).toString()
         : "";
 
       return {
         id: encryptedSecret.id,
@@ -1701,18 +1721,29 @@ export const secretV2BridgeServiceFactory = ({
       const [updatedSecret] = await secretDAL.update(
         {
           id: secret.id,
           folderId
         },
         {
           key: encryptedKey,
-          encryptedValue: encryptedValue.cipherTextBlob,
-          encryptedComment: encryptedComment?.cipherTextBlob,
           reminderNote,
           reminderRepeatDays,
           skipMultilineEncoding,
           metadata,
           userId
         },
         tx
       );
 
+      const newVersion = await secretVersionDAL.createCurrentVersion(
+        {
+          secretId: updatedSecret.id,
+          version: updatedSecret.version,
+          key: encryptedKey,
+          encryptedValue: encryptedValue.cipherTextBlob,
+          encryptedComment: encryptedComment?.cipherTextBlob,
+          reminderNote,
+          reminderRepeatDays,
+          skipMultilineEncoding,
+          metadata,
+          folderId,
+          userId,
+          actorType: actor.type
+        },
+        tx
+      );
+      await secretDAL.updateCurrentVersionId(updatedSecret.id, newVersion.id, newVersion.version, tx);
+
       return updatedSecret;
     });
@@ -2408,21 +2439,32 @@ export const secretV2BridgeServiceFactory = ({
     const encryptedSecrets = await secretDAL.find(
       {
         folderId,
         $in: {
           id: localSecretIds
         }
       },
       { tx }
     );
 
-    const latestSecretVersions = await secretVersionDAL.findLatestVersionMany(folderId, localSecretIds, tx);
+    const latestSecretVersions = await secretVersionDAL.findCurrentBySecretIds(localSecretIds, tx);
 
     const changes = encryptedSecrets.map((secret) => {
       const latestVersion = latestSecretVersions[secret.id];
+      if (!latestVersion) {
+        throw new BadRequestError({
+          message: `Cannot create commit because secret ${secret.key} is not migrated`
+        });
+      }
+
       return {
         type: CommitType.ADD,
         isUpdate: false,
         secretVersionId: latestVersion.id
       };
     });
@@ -3881,6 +3923,23 @@ export const secretV2BridgeServiceFactory = ({
     return secretVersionDAL.findVersionsBySecretIdWithActors({
       secretId,
       projectId,
       secretVersions,
       findOpt
     });
   };
+
+  const assertFolderIsCanonical = async (folderId: string) => {
+    const secrets = await secretDAL.find(
+      {
+        folderId
+      },
+      { limit: 500 }
+    );
+
+    const missingVersionPointers = secrets.filter((secret) => !secret.currentVersionId);
+    if (missingVersionPointers.length) {
+      throw new BadRequestError({
+        message: "Secret folder has not completed the canonical version migration"
+      });
+    }
+  };
@@ -4031,6 +4090,7 @@ export const secretV2BridgeServiceFactory = ({
     getSecrets,
     getSecretById,
     getSecretVersions,
+    assertFolderIsCanonical,
     createSecrets,
     updateSecrets,
     deleteSecrets,
diff --git a/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.test.ts b/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.test.ts
index 2e85b9900c..32dc80134a 100644
--- a/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.test.ts
+++ b/backend/src/services/secret-v2-bridge/secret-v2-bridge-service.test.ts
@@ -41,6 +41,38 @@ describe("secret v2 bridge service", () => {
     vi.clearAllMocks();
   });
 
+  const canonicalSecret = {
+    id: "secret-1",
+    version: 2,
+    type: SecretType.Shared,
+    key: "DATABASE_URL",
+    currentVersionId: "version-2",
+    folderId: "folder-1",
+    userId: null,
+    encryptedValue: Buffer.from("encrypted-value"),
+    encryptedComment: Buffer.from("encrypted-comment"),
+    reminderNote: null,
+    reminderRepeatDays: null,
+    skipMultilineEncoding: false,
+    metadata: null,
+    currentVersion: {
+      id: "version-2",
+      version: 2,
+      actorType: "user"
+    }
+  };
+
+  const canonicalVersion = {
+    id: "version-2",
+    secretId: "secret-1",
+    version: 2,
+    key: "DATABASE_URL",
+    encryptedValue: Buffer.from("encrypted-value"),
+    encryptedComment: Buffer.from("encrypted-comment"),
+    reminderNote: null,
+    reminderRepeatDays: null,
+    skipMultilineEncoding: false,
+    metadata: null,
+    folderId: "folder-1",
+    userId: null
+  };
+
   it("returns shared secrets from their current version rows", async () => {
     secretDAL.find.mockResolvedValue([canonicalSecret]);
     decryptor.mockImplementation(({ cipherTextBlob }) => cipherTextBlob.toString());
@@ -54,10 +86,13 @@ describe("secret v2 bridge service", () => {
 
     expect(result).toEqual([
       expect.objectContaining({
         id: "secret-1",
         secretKey: "DATABASE_URL",
         secretValue: "encrypted-value",
         version: 2
       })
     ]);
+    expect(secretDAL.find).toHaveBeenCalledWith(
+      expect.objectContaining({ folderId: "folder-1", type: SecretType.Shared }),
+      expect.anything()
+    );
   });
 
   it("updates a secret by creating a new version and moving the current pointer", async () => {
@@ -79,24 +114,67 @@ describe("secret v2 bridge service", () => {
     secretVersionDAL.createCurrentVersion.mockResolvedValue({
       ...canonicalVersion,
       id: "version-3",
       version: 3
     });
     secretDAL.updateCurrentVersionId.mockResolvedValue({
       ...canonicalSecret,
       version: 3,
       currentVersionId: "version-3"
     });
 
     await service.updateSecrets({
       actor,
       projectId: "project-1",
       environment: "dev",
       secretPath: "/",
       secrets: [
         {
           secretKey: "DATABASE_URL",
           secretValue: "postgres://new",
           type: SecretType.Shared
         }
       ]
     });
 
     expect(secretVersionDAL.createCurrentVersion).toHaveBeenCalledWith(
       expect.objectContaining({
         secretId: "secret-1",
         version: 3,
         key: expect.any(String),
         encryptedValue: expect.any(Buffer)
       }),
       expect.anything()
     );
     expect(secretDAL.updateCurrentVersionId).toHaveBeenCalledWith("secret-1", "version-3", 3, expect.anything());
   });
+
+  it("creates commits with current version ids", async () => {
+    secretDAL.find.mockResolvedValue([canonicalSecret]);
+    secretVersionDAL.findCurrentBySecretIds.mockResolvedValue({
+      "secret-1": canonicalVersion
+    });
+    folderCommitService.createCommit.mockResolvedValue({ id: "commit-1" });
+
+    await service.createCommitForFolder({
+      actor,
+      folderId: "folder-1",
+      projectId: "project-1",
+      secretIds: ["secret-1"],
+      message: "Initial commit"
+    });
+
+    expect(secretVersionDAL.findCurrentBySecretIds).toHaveBeenCalledWith(["secret-1"], expect.anything());
+    expect(folderCommitService.createCommit).toHaveBeenCalledWith(
+      expect.objectContaining({
+        changes: [
+          {
+            type: CommitType.ADD,
+            isUpdate: false,
+            secretVersionId: "version-2"
+          }
+        ]
+      }),
+      expect.anything()
+    );
+  });
+
+  it("syncs canonical folders", async () => {
+    secretDAL.find.mockResolvedValue([canonicalSecret]);
+    secretQueueService.syncSecrets.mockResolvedValue(undefined);
+
+    await service.syncFolder({
+      actor,
+      folderId: "folder-1",
+      projectId: "project-1",
+      environmentSlug: "dev",
+      secretPath: "/"
+    });
+
+    expect(secretQueueService.syncSecrets).toHaveBeenCalledWith(
+      expect.objectContaining({
+        projectId: "project-1",
+        environmentSlug: "dev",
+        secretPath: "/"
+      })
+    );
+  });
 });
```

## Intended Flaws

### Flaw 1: Destructive Storage Migration Is Coupled To The Same Deploy

- `type`: `unsafe_migration`
- `location`: `backend/src/db/migrations/20260510103000_canonical_secret_versions_v2.ts:112-146`, `backend/src/db/migrations/20260510103000_canonical_secret_versions_v2.ts:148-193`, `backend/src/db/schemas/secrets-v2.ts:14-24`
- `learner_prompt`: What happens if this migration fails halfway, or if the app must roll back after the columns are dropped?

Expected answer:

- `identify`: The migration adds `currentVersionId`, backfills every row, makes the column `NOT NULL`, then drops `encryptedValue`, `encryptedComment`, reminder fields, `skipMultilineEncoding`, and `metadata` from `secrets_v2` in the same deploy. The generated schema is updated as if those fields no longer exist at all. That removes the old storage contract before a compatibility window has proven every read and write path can use versions.
- `impact`: Rollback becomes unsafe. Older application code still expects the encrypted value fields on `secrets_v2`, so a rollback after the drop cannot read or write current secrets. If the backfill has a bug, misses rows, or is killed after some `currentVersionId` updates, the only authoritative current secret values may be split between old columns and version rows. In a secrets product, this can produce missing secrets, broken syncs, failed rotations, and data-loss risk during incident recovery.
- `fix_direction`: Use an additive, multi-phase migration. First add nullable `currentVersionId` and any needed indexes without dropping old columns. Deploy dual-write code that writes both the current row and the version row. Backfill in a resumable background job with checkpoints, metrics, and retries. Deploy dual-read code that prefers version rows but falls back to old columns. Only after backfill completion is observable and old binaries are gone should a later cleanup migration make the pointer non-null and drop old columns.

Hints:

1. Follow the migration after the backfill finishes. Which fields disappear from `secrets_v2`?
2. Think about a rollback to the previous application binary after this migration has already run.
3. A secrets table stores customer-critical encrypted data. Treat duplicated storage removal as a staged contract change, not one schema diff.

### Flaw 2: Read Paths Assume Every Secret Already Has A Current Version Row

- `type`: `rollout_risk`
- `location`: `backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts:50-111`, `backend/src/services/secret-v2-bridge/secret-v2-bridge-dal.ts:121-189`, `backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts:269-339`, `backend/src/services/secret-v2-bridge/secret-v2-bridge-service.ts:672-704`, `backend/src/services/secret-v2-bridge/secret-v2-bridge-service.test.ts:41-166`
- `learner_prompt`: Do these read paths work while old rows are not backfilled yet, or while old and new app versions run at the same time?

Expected answer:

- `identify`: The DAL uses an `innerJoin` from `secrets_v2.currentVersionId` to `secret_versions_v2.id` for `findOne` and `find`. The service throws when a secret or folder does not have a current version pointer. The tests only create canonical secrets with `currentVersionId` and never cover legacy rows that still have encrypted values on `secrets_v2` but no pointer.
- `impact`: During a rolling deploy or delayed backfill, old secrets can vanish from list responses because the inner join filters them out. Direct lookups can throw "not migrated" errors, sync and commit creation can fail, and project folders can appear empty or broken even though the old current values still exist. If old workers write secrets using the old path while new web nodes read through the pointer, users get intermittent behavior depending on which process handled the write.
- `fix_direction`: Make reads deployment-compatible. Use a left join to current version rows, and map a current secret from the version row when present or from the legacy `secrets_v2` columns when absent. Keep schemas nullable during rollout. Add tests for unbackfilled rows, mixed folders, old-writer/new-reader interaction, and partial backfill. Only replace fallback reads with strict pointer reads after the migration is complete and old writers cannot run.

Hints:

1. `innerJoin` is a contract: rows without a matching current version do not appear.
2. The test fixtures all start in the final state. Look for a test with `currentVersionId: null`.
3. Rolling deploys mean new readers can observe rows written by old writers for a while.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the destructive same-deploy storage contract change. Answers that only say "the migration is big" are incomplete unless they explain why dropping the old encrypted value columns before a compatibility window creates rollback and data-loss risk.

For flaw 2, a correct answer must identify the runtime compatibility break caused by strict current-version joins and service-level "not migrated" errors. Answers that only say "currentVersionId can be null" are incomplete unless they connect that null state to disappearing secrets, 500s, and rolling-deploy behavior.

### Product-Level Change

The PR tries to reduce duplication and make version history the source of truth for current secret values. That is a reasonable destination: secret history, redaction, commits, and rollback are easier to reason about when every value-bearing change is represented as a version row.

### Changed Contracts

- Storage contract: `secrets_v2` no longer owns encrypted value/comment/reminder/metadata fields; it points to a row in `secret_versions_v2`.
- Read contract: secret list and lookup now require a current version row to hydrate value fields.
- Write contract: updates must create a version row and then move the current pointer.
- Migration contract: every existing secret must receive exactly one valid current pointer before strict reads are safe.
- Rollback contract: old binaries still need the old columns until the cleanup phase is deliberately complete.

### Failure Modes

A self-hosted customer has millions of secrets. The migration adds the pointer and starts the inline backfill. It is killed after half the rows are updated. New app code deploys and uses an inner join against `currentVersionId`. Half the folders now list only some secrets; direct lookups fail for the rest.

Another customer rolls back after a production issue unrelated to secrets. The database has already dropped `secrets_v2.encryptedValue`. The previous binary reads from that column and cannot hydrate any secret values, turning a routine rollback into a secret outage.

### Reviewer Thought Process

A strong reviewer asks what the final storage model is, then asks how the system gets there. Removing duplicated data is not just a refactor; it is a live contract migration. The important review question is not "does the final state compile?" but "can old writers, new readers, the backfill, and rollback coexist?"

The second habit is to inspect joins and generated schemas for hidden strictness. A required Zod field and an inner join often mean the code only works after the world is fully migrated. Production spends real time in the in-between state.

### Better Implementation Direction

- Add nullable `currentVersionId` and supporting indexes in an additive migration.
- Keep old encrypted columns until a later cleanup phase.
- Dual-write current secret rows and version rows.
- Dual-read with a version-row preference and old-column fallback.
- Backfill current pointers with a resumable background migration, not as mandatory deploy-time work.
- Add telemetry for missing pointers and backfill progress.
- Add tests for legacy rows, partially migrated rows, mixed old/new writers, rollback compatibility, and final strict mode.

## Why This Case Exists

This case trains one of the core senior-engineering review instincts: storage migrations have time as a dimension. A PR can look cleaner in the final model while being unsafe in the path from old model to new model. Great reviewers protect the path.
