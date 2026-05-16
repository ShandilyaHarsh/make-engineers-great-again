# TS-009: Unkey Editable API-Key Metadata

## Metadata

- `id`: TS-009
- `source_repo`: [unkeyed/unkey](https://github.com/unkeyed/unkey)
- `repo_area`: dashboard key router, key metadata schema, control-plane key mutations, verifier key lookup, verification cache invalidation boundary
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 818
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about tenant scoping, control-plane/data-plane boundaries, verifier caches, metadata contracts, and cache invalidation without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR lets workspace admins edit API-key metadata after a key has been created.

Customers can attach metadata such as `plan`, `customerId`, `region`, or `teamId` to an existing key. A subset of metadata keys can be marked as public so the edge verifier can include them in auth context for downstream services.

The PR adds:

- a dashboard mutation for replacing key metadata,
- a dashboard mutation for choosing which metadata keys are public,
- validation for metadata key/value size,
- an audit helper for key metadata changes,
- tests for metadata updates, public metadata selection, and verification responses.

## Existing Code Context

The real Unkey codebase already has these relevant contracts:

- `web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts` is a dashboard mutation. In the real implementation it uses `workspaceProcedure`, parses metadata, looks up the key with `ctx.workspace.id`, and writes audit logs.
- Other dashboard key mutations such as `updateName.ts` and `updateEnabled.ts` first establish that the key belongs to the current workspace, then update using that scoped key.
- Low-level generated key update SQL can update by key id alone; callers are responsible for performing tenant ownership checks before calling it.
- `internal/services/keys/db/queries/key_find_for_verification.sql` loads key data for verification by hash and includes `k.workspace_id`, `k.meta`, `k.enabled`, permissions, roles, and rate limits.
- `internal/services/keys/get.go` reads verification key data through an SWR cache keyed by key hash.
- `internal/services/caches/caches.go` defines `VerificationKeyByHash` and documents the distributed cache invalidation model used by edge verification.
- `internal/services/keys/get_migrated.go` explicitly removes cached key entries after key hash migration.
- `cmd/api/keys/update_key.go` tells operators that key updates are expected to propagate to edge regions through cache invalidation within a bounded window.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `web/apps/dashboard/lib/schemas/key-metadata.ts`
- `web/apps/dashboard/lib/trpc/routers/key/metadataAudit.ts`
- `web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts`
- `web/apps/dashboard/lib/trpc/routers/key/updatePublicMetadata.ts`
- `web/apps/dashboard/lib/trpc/routers/key/index.ts`
- `web/apps/dashboard/test/key-metadata.test.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on TypeScript control-plane code and tests. The data-plane verifier is included in the existing code context because the review question is about the boundary between these surfaces.

## Diff

```diff
diff --git a/web/apps/dashboard/lib/schemas/key-metadata.ts b/web/apps/dashboard/lib/schemas/key-metadata.ts
new file mode 100644
index 0000000000..9b219a4ec8
--- /dev/null
+++ b/web/apps/dashboard/lib/schemas/key-metadata.ts
@@ -0,0 +1,142 @@
+import { z } from "zod";
+
+export const metadataKeySchema = z
+  .string()
+  .trim()
+  .min(1, "Metadata keys cannot be empty")
+  .max(64, "Metadata keys must be at most 64 characters")
+  .regex(
+    /^[a-zA-Z0-9_.:-]+$/,
+    "Metadata keys can only contain letters, numbers, dots, underscores, colons, and dashes"
+  );
+
+export const metadataPrimitiveSchema = z.union([
+  z.string().max(512, "Metadata string values must be at most 512 characters"),
+  z.number().finite(),
+  z.boolean(),
+  z.null(),
+]);
+
+export type MetadataPrimitive = z.infer<typeof metadataPrimitiveSchema>;
+
+export type KeyMetadataValue =
+  | MetadataPrimitive
+  | KeyMetadataValue[]
+  | { [key: string]: KeyMetadataValue };
+
+export type KeyMetadata = Record<string, KeyMetadataValue>;
+
+const keyMetadataValueSchema: z.ZodType<KeyMetadataValue> = z.lazy(() =>
+  z.union([
+    metadataPrimitiveSchema,
+    z.array(keyMetadataValueSchema).max(25, "Metadata arrays must contain at most 25 items"),
+    z.record(metadataKeySchema, keyMetadataValueSchema),
+  ])
+);
+
+export const keyMetadataSchema = z
+  .record(metadataKeySchema, keyMetadataValueSchema)
+  .default({})
+  .superRefine((metadata, ctx) => {
+    const encoded = JSON.stringify(metadata);
+
+    if (encoded.length > 8_192) {
+      ctx.addIssue({
+        code: z.ZodIssueCode.custom,
+        message: "Metadata must be at most 8KB when encoded as JSON",
+      });
+    }
+
+    if (Object.keys(metadata).length > 40) {
+      ctx.addIssue({
+        code: z.ZodIssueCode.custom,
+        message: "Metadata can contain at most 40 top-level keys",
+      });
+    }
+  });
+
+export const publicMetadataKeysSchema = z
+  .array(metadataKeySchema)
+  .max(10, "At most 10 metadata keys can be exposed to verification responses")
+  .default([])
+  .transform((keys) => Array.from(new Set(keys)).sort());
+
+export const updateKeyMetadataInputSchema = z.object({
+  keyId: z.string().min(1),
+  metadata: keyMetadataSchema,
+  publicMetadataKeys: publicMetadataKeysSchema.optional(),
+});
+
+export const updatePublicMetadataInputSchema = z.object({
+  keyId: z.string().min(1),
+  publicMetadataKeys: publicMetadataKeysSchema,
+});
+
+export type UpdateKeyMetadataInput = z.infer<typeof updateKeyMetadataInputSchema>;
+export type UpdatePublicMetadataInput = z.infer<typeof updatePublicMetadataInputSchema>;
+
+export function pickPublicMetadata(
+  metadata: KeyMetadata,
+  publicMetadataKeys: string[]
+): KeyMetadata {
+  const result: KeyMetadata = {};
+
+  for (const key of publicMetadataKeys) {
+    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
+      result[key] = metadata[key];
+    }
+  }
+
+  return result;
+}
+
+export function summarizeMetadataKeys(metadata: KeyMetadata): string[] {
+  return Object.keys(metadata).sort();
+}
+
+export function summarizeMetadataChange(params: {
+  before: KeyMetadata | null;
+  after: KeyMetadata;
+  beforePublicKeys: string[];
+  afterPublicKeys: string[];
+}) {
+  const beforeKeys = new Set(Object.keys(params.before ?? {}));
+  const afterKeys = new Set(Object.keys(params.after));
+  const added: string[] = [];
+  const removed: string[] = [];
+  const changed: string[] = [];
+
+  for (const key of afterKeys) {
+    if (!beforeKeys.has(key)) {
+      added.push(key);
+      continue;
+    }
+
+    const beforeValue = JSON.stringify(params.before?.[key]);
+    const afterValue = JSON.stringify(params.after[key]);
+    if (beforeValue !== afterValue) {
+      changed.push(key);
+    }
+  }
+
+  for (const key of beforeKeys) {
+    if (!afterKeys.has(key)) {
+      removed.push(key);
+    }
+  }
+
+  return {
+    added: added.sort(),
+    removed: removed.sort(),
+    changed: changed.sort(),
+    publicMetadataKeysBefore: params.beforePublicKeys,
+    publicMetadataKeysAfter: params.afterPublicKeys,
+  };
+}
+
+export function normalizeMetadataForStorage(params: {
+  metadata: KeyMetadata;
+  publicMetadataKeys?: string[];
+}) {
+  const publicMetadataKeys = params.publicMetadataKeys ?? [];
+
+  return {
+    meta: params.metadata,
+    metadataKeys: summarizeMetadataKeys(params.metadata),
+    publicMeta: pickPublicMetadata(params.metadata, publicMetadataKeys),
+    publicMetaKeys: publicMetadataKeys,
+  };
+}
diff --git a/web/apps/dashboard/lib/trpc/routers/key/metadataAudit.ts b/web/apps/dashboard/lib/trpc/routers/key/metadataAudit.ts
new file mode 100644
index 0000000000..10d0db1f91
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/metadataAudit.ts
@@ -0,0 +1,84 @@
+import type { AuditLog, Database } from "@/lib/db";
+import type { KeyMetadata } from "@/lib/schemas/key-metadata";
+import { summarizeMetadataChange } from "@/lib/schemas/key-metadata";
+
+export type KeyMetadataAuditParams = {
+  db: Database;
+  audit: AuditLog;
+  workspaceId: string;
+  actorId: string;
+  keyId: string;
+  before: KeyMetadata | null;
+  after: KeyMetadata;
+  beforePublicKeys: string[];
+  afterPublicKeys: string[];
+  requestId?: string;
+};
+
+export async function recordKeyMetadataAudit(params: KeyMetadataAuditParams) {
+  const diff = summarizeMetadataChange({
+    before: params.before,
+    after: params.after,
+    beforePublicKeys: params.beforePublicKeys,
+    afterPublicKeys: params.afterPublicKeys,
+  });
+
+  await params.audit.insert({
+    workspaceId: params.workspaceId,
+    actorId: params.actorId,
+    event: "key.metadata.update",
+    description: "Updated API key metadata",
+    resources: [
+      {
+        type: "key",
+        id: params.keyId,
+      },
+    ],
+    context: {
+      requestId: params.requestId ?? null,
+      addedKeys: diff.added,
+      removedKeys: diff.removed,
+      changedKeys: diff.changed,
+      publicMetadataKeysBefore: diff.publicMetadataKeysBefore,
+      publicMetadataKeysAfter: diff.publicMetadataKeysAfter,
+    },
+  });
+}
+
+export type KeyMetadataChangeEvent = {
+  type: "key.metadata.changed";
+  workspaceId: string;
+  keyId: string;
+  changedKeys: string[];
+  publicMetadataKeys: string[];
+  emittedAt: number;
+};
+
+export function buildMetadataChangeEvent(params: {
+  workspaceId: string;
+  keyId: string;
+  before: KeyMetadata | null;
+  after: KeyMetadata;
+  publicMetadataKeys: string[];
+}): KeyMetadataChangeEvent {
+  const diff = summarizeMetadataChange({
+    before: params.before,
+    after: params.after,
+    beforePublicKeys: [],
+    afterPublicKeys: params.publicMetadataKeys,
+  });
+
+  return {
+    type: "key.metadata.changed",
+    workspaceId: params.workspaceId,
+    keyId: params.keyId,
+    changedKeys: [...diff.added, ...diff.removed, ...diff.changed],
+    publicMetadataKeys: params.publicMetadataKeys,
+    emittedAt: Date.now(),
+  };
+}
+
+export async function publishMetadataChangeEvent(event: KeyMetadataChangeEvent) {
+  await Promise.resolve(event);
+}
diff --git a/web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts b/web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts
index 2a1a2b86ad..7b518e55d0 100644
--- a/web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts
+++ b/web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts
@@ -1,46 +1,177 @@
+import { TRPCError } from "@trpc/server";
+import { and, eq, isNull } from "drizzle-orm";
+import { z } from "zod";
 import { db, schema } from "@/lib/db";
+import { workspaceProcedure } from "@/lib/trpc";
+import {
+  normalizeMetadataForStorage,
+  updateKeyMetadataInputSchema,
+  type KeyMetadata,
+} from "@/lib/schemas/key-metadata";
+import {
+  buildMetadataChangeEvent,
+  publishMetadataChangeEvent,
+  recordKeyMetadataAudit,
+} from "./metadataAudit";
 
-export const updateMetadata = workspaceProcedure
-  .input(z.object({ keyId: z.string(), metadata: z.string() }))
-  .mutation(async ({ ctx, input }) => {
-    const metadata = JSON.parse(input.metadata);
+export const updateMetadata = workspaceProcedure
+  .input(updateKeyMetadataInputSchema)
+  .mutation(async ({ ctx, input }) => {
+    const key = await db.query.keys.findFirst({
+      where: (table) =>
+        and(
+          eq(table.id, input.keyId),
+          isNull(table.deletedAtM)
+        ),
+      columns: {
+        id: true,
+        name: true,
+        workspaceId: true,
+        keyAuthId: true,
+        hash: true,
+        meta: true,
+        publicMetaKeys: true,
+      },
+    });
+
+    if (!key) {
+      throw new TRPCError({
+        code: "NOT_FOUND",
+        message: "Key not found",
+      });
+    }
+
+    const beforeMetadata = (key.meta ?? null) as KeyMetadata | null;
+    const beforePublicKeys = key.publicMetaKeys ?? [];
+    const afterPublicKeys = input.publicMetadataKeys ?? beforePublicKeys;
+    const normalized = normalizeMetadataForStorage({
+      metadata: input.metadata,
+      publicMetadataKeys: afterPublicKeys,
+    });
 
     await db.transaction(async (tx) => {
-      await tx
-        .update(schema.keys)
-        .set({ meta: metadata, updatedAtM: Date.now() })
-        .where(eq(schema.keys.id, input.keyId));
+      await tx
+        .update(schema.keys)
+        .set({
+          meta: normalized.meta,
+          metadataKeys: normalized.metadataKeys,
+          publicMeta: normalized.publicMeta,
+          publicMetaKeys: normalized.publicMetaKeys,
+          metadataUpdatedAtM: Date.now(),
+          updatedAtM: Date.now(),
+        })
+        .where(eq(schema.keys.id, key.id));
 
-      await ctx.audit.insert({
-        workspaceId: ctx.workspace.id,
-        event: "key.update",
-        resources: [{ type: "key", id: input.keyId }],
+      await recordKeyMetadataAudit({
+        db: tx,
+        audit: ctx.audit,
+        workspaceId: ctx.workspace.id,
+        actorId: ctx.user.id,
+        keyId: key.id,
+        before: beforeMetadata,
+        after: input.metadata,
+        beforePublicKeys,
+        afterPublicKeys,
+        requestId: ctx.requestId,
       });
     });
 
+    const event = buildMetadataChangeEvent({
+      workspaceId: ctx.workspace.id,
+      keyId: key.id,
+      before: beforeMetadata,
+      after: input.metadata,
+      publicMetadataKeys: afterPublicKeys,
+    });
+
+    await publishMetadataChangeEvent(event);
+
     return {
-      ok: true,
+      keyId: key.id,
+      metadata: normalized.meta,
+      publicMetadata: normalized.publicMeta,
+      publicMetadataKeys: normalized.publicMetaKeys,
+      metadataUpdatedAt: new Date().toISOString(),
     };
   });
+
+export const parseMetadataPreview = workspaceProcedure
+  .input(
+    z.object({
+      metadata: updateKeyMetadataInputSchema.shape.metadata,
+      publicMetadataKeys: updateKeyMetadataInputSchema.shape.publicMetadataKeys.optional(),
+    })
+  )
+  .mutation(async ({ input }) => {
+    const publicMetadataKeys = input.publicMetadataKeys ?? [];
+    const normalized = normalizeMetadataForStorage({
+      metadata: input.metadata,
+      publicMetadataKeys,
+    });
+
+    return {
+      metadataKeys: normalized.metadataKeys,
+      publicMetadata: normalized.publicMeta,
+      publicMetadataKeys: normalized.publicMetaKeys,
+      encodedBytes: Buffer.byteLength(JSON.stringify(input.metadata), "utf8"),
+    };
+  });
diff --git a/web/apps/dashboard/lib/trpc/routers/key/updatePublicMetadata.ts b/web/apps/dashboard/lib/trpc/routers/key/updatePublicMetadata.ts
new file mode 100644
index 0000000000..8e821a1117
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/updatePublicMetadata.ts
@@ -0,0 +1,152 @@
+import { TRPCError } from "@trpc/server";
+import { and, eq, isNull } from "drizzle-orm";
+import { db, schema } from "@/lib/db";
+import { workspaceProcedure } from "@/lib/trpc";
+import {
+  normalizeMetadataForStorage,
+  updatePublicMetadataInputSchema,
+  type KeyMetadata,
+} from "@/lib/schemas/key-metadata";
+import {
+  buildMetadataChangeEvent,
+  publishMetadataChangeEvent,
+  recordKeyMetadataAudit,
+} from "./metadataAudit";
+
+export const updatePublicMetadata = workspaceProcedure
+  .input(updatePublicMetadataInputSchema)
+  .mutation(async ({ ctx, input }) => {
+    const key = await db.query.keys.findFirst({
+      where: (table) =>
+        and(
+          eq(table.id, input.keyId),
+          isNull(table.deletedAtM)
+        ),
+      columns: {
+        id: true,
+        name: true,
+        workspaceId: true,
+        hash: true,
+        meta: true,
+        publicMetaKeys: true,
+      },
+    });
+
+    if (!key) {
+      throw new TRPCError({
+        code: "NOT_FOUND",
+        message: "Key not found",
+      });
+    }
+
+    const metadata = (key.meta ?? {}) as KeyMetadata;
+    const invalidKeys = input.publicMetadataKeys.filter(
+      (metadataKey) => !Object.prototype.hasOwnProperty.call(metadata, metadataKey)
+    );
+
+    if (invalidKeys.length > 0) {
+      throw new TRPCError({
+        code: "BAD_REQUEST",
+        message: `Unknown metadata keys cannot be public: ${invalidKeys.join(", ")}`,
+      });
+    }
+
+    const normalized = normalizeMetadataForStorage({
+      metadata,
+      publicMetadataKeys: input.publicMetadataKeys,
+    });
+
+    await db.transaction(async (tx) => {
+      await tx
+        .update(schema.keys)
+        .set({
+          publicMeta: normalized.publicMeta,
+          publicMetaKeys: normalized.publicMetaKeys,
+          metadataUpdatedAtM: Date.now(),
+          updatedAtM: Date.now(),
+        })
+        .where(eq(schema.keys.id, key.id));
+
+      await recordKeyMetadataAudit({
+        db: tx,
+        audit: ctx.audit,
+        workspaceId: ctx.workspace.id,
+        actorId: ctx.user.id,
+        keyId: key.id,
+        before: metadata,
+        after: metadata,
+        beforePublicKeys: key.publicMetaKeys ?? [],
+        afterPublicKeys: normalized.publicMetaKeys,
+        requestId: ctx.requestId,
+      });
+    });
+
+    const event = buildMetadataChangeEvent({
+      workspaceId: ctx.workspace.id,
+      keyId: key.id,
+      before: metadata,
+      after: metadata,
+      publicMetadataKeys: normalized.publicMetaKeys,
+    });
+
+    await publishMetadataChangeEvent(event);
+
+    return {
+      keyId: key.id,
+      publicMetadata: normalized.publicMeta,
+      publicMetadataKeys: normalized.publicMetaKeys,
+      metadataUpdatedAt: new Date().toISOString(),
+    };
+  });
diff --git a/web/apps/dashboard/lib/trpc/routers/key/index.ts b/web/apps/dashboard/lib/trpc/routers/key/index.ts
index b7d96b1b33..49d7fd4dc9 100644
--- a/web/apps/dashboard/lib/trpc/routers/key/index.ts
+++ b/web/apps/dashboard/lib/trpc/routers/key/index.ts
@@ -19,6 +19,8 @@ import { updateName } from "./updateName";
 import { updateEnabled } from "./updateEnabled";
+import { updateMetadata, parseMetadataPreview } from "./updateMetadata";
+import { updatePublicMetadata } from "./updatePublicMetadata";
 import { updateRatelimit } from "./updateRatelimit";
 
 export const keyRouter = router({
@@ -36,6 +38,9 @@ export const keyRouter = router({
   updateName,
   updateEnabled,
+  updateMetadata,
+  updatePublicMetadata,
+  parseMetadataPreview,
   updateRatelimit,
 });
diff --git a/web/apps/dashboard/test/key-metadata.test.ts b/web/apps/dashboard/test/key-metadata.test.ts
new file mode 100644
index 0000000000..e0a87d421b
--- /dev/null
+++ b/web/apps/dashboard/test/key-metadata.test.ts
@@ -0,0 +1,283 @@
+import { describe, expect, it, vi } from "vitest";
+import { appRouter } from "@/lib/trpc/root";
+import { createCallerFactory } from "@/lib/trpc/testing";
+import { createTestWorkspace, createTestKey, createTestUser } from "@/test/factories";
+import { db, schema } from "@/lib/db";
+import { eq } from "drizzle-orm";
+
+describe("key metadata mutations", () => {
+  it("updates key metadata from the dashboard", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const key = await createTestKey({
+      workspaceId: workspace.id,
+      meta: {
+        plan: "free",
+      },
+    });
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+    });
+
+    const result = await caller.key.updateMetadata({
+      keyId: key.id,
+      metadata: {
+        plan: "pro",
+        region: "iad",
+        customerId: "cus_123",
+      },
+      publicMetadataKeys: ["plan", "region"],
+    });
+
+    expect(result.keyId).toBe(key.id);
+    expect(result.metadata).toEqual({
+      plan: "pro",
+      region: "iad",
+      customerId: "cus_123",
+    });
+    expect(result.publicMetadata).toEqual({
+      plan: "pro",
+      region: "iad",
+    });
+
+    const stored = await db.query.keys.findFirst({
+      where: (table) => eq(table.id, key.id),
+      columns: {
+        meta: true,
+        publicMeta: true,
+        publicMetaKeys: true,
+        metadataUpdatedAtM: true,
+      },
+    });
+
+    expect(stored?.meta).toEqual({
+      plan: "pro",
+      region: "iad",
+      customerId: "cus_123",
+    });
+    expect(stored?.publicMeta).toEqual({
+      plan: "pro",
+      region: "iad",
+    });
+    expect(stored?.publicMetaKeys).toEqual(["plan", "region"]);
+    expect(stored?.metadataUpdatedAtM).toBeGreaterThan(0);
+  });
+
+  it("keeps existing public metadata keys when metadata is replaced without a public key list", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const key = await createTestKey({
+      workspaceId: workspace.id,
+      meta: {
+        plan: "free",
+        customerId: "cus_123",
+      },
+      publicMetaKeys: ["plan"],
+    });
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+    });
+
+    const result = await caller.key.updateMetadata({
+      keyId: key.id,
+      metadata: {
+        plan: "enterprise",
+        customerId: "cus_123",
+        region: "sfo",
+      },
+    });
+
+    expect(result.publicMetadataKeys).toEqual(["plan"]);
+    expect(result.publicMetadata).toEqual({
+      plan: "enterprise",
+    });
+  });
+
+  it("updates public metadata keys separately", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const key = await createTestKey({
+      workspaceId: workspace.id,
+      meta: {
+        plan: "pro",
+        region: "iad",
+        customerId: "cus_123",
+      },
+      publicMetaKeys: ["plan"],
+    });
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+    });
+
+    const result = await caller.key.updatePublicMetadata({
+      keyId: key.id,
+      publicMetadataKeys: ["region", "plan"],
+    });
+
+    expect(result.publicMetadataKeys).toEqual(["plan", "region"]);
+    expect(result.publicMetadata).toEqual({
+      plan: "pro",
+      region: "iad",
+    });
+  });
+
+  it("rejects public metadata keys that are not present on the key", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const key = await createTestKey({
+      workspaceId: workspace.id,
+      meta: {
+        plan: "pro",
+      },
+    });
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+    });
+
+    await expect(
+      caller.key.updatePublicMetadata({
+        keyId: key.id,
+        publicMetadataKeys: ["plan", "unknown"],
+      })
+    ).rejects.toMatchObject({
+      code: "BAD_REQUEST",
+    });
+  });
+
+  it("normalizes duplicate public metadata keys", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const key = await createTestKey({
+      workspaceId: workspace.id,
+      meta: {
+        plan: "pro",
+        region: "iad",
+      },
+    });
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+    });
+
+    const result = await caller.key.updatePublicMetadata({
+      keyId: key.id,
+      publicMetadataKeys: ["region", "plan", "region"],
+    });
+
+    expect(result.publicMetadataKeys).toEqual(["plan", "region"]);
+  });
+
+  it("records an audit entry for metadata updates", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const key = await createTestKey({
+      workspaceId: workspace.id,
+      meta: {
+        plan: "free",
+      },
+    });
+    const auditInsert = vi.fn();
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+      audit: {
+        insert: auditInsert,
+      },
+    });
+
+    await caller.key.updateMetadata({
+      keyId: key.id,
+      metadata: {
+        plan: "pro",
+      },
+      publicMetadataKeys: ["plan"],
+    });
+
+    expect(auditInsert).toHaveBeenCalledWith(
+      expect.objectContaining({
+        workspaceId: workspace.id,
+        actorId: user.id,
+        event: "key.metadata.update",
+        resources: [
+          {
+            type: "key",
+            id: key.id,
+          },
+        ],
+      })
+    );
+  });
+
+  it("returns public metadata in verification fixtures after metadata update", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const key = await createTestKey({
+      workspaceId: workspace.id,
+      meta: {
+        plan: "free",
+      },
+      publicMetaKeys: ["plan"],
+    });
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+    });
+
+    await caller.key.updateMetadata({
+      keyId: key.id,
+      metadata: {
+        plan: "enterprise",
+        region: "iad",
+      },
+      publicMetadataKeys: ["plan", "region"],
+    });
+
+    const stored = await db.query.keys.findFirst({
+      where: (table) => eq(table.id, key.id),
+      columns: {
+        publicMeta: true,
+      },
+    });
+
+    expect(stored?.publicMeta).toEqual({
+      plan: "enterprise",
+      region: "iad",
+    });
+  });
+
+  it("updates metadata for a key even when the key belongs to another test workspace fixture", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const otherWorkspace = await createTestWorkspace();
+    const key = await createTestKey({
+      workspaceId: otherWorkspace.id,
+      meta: {
+        plan: "free",
+      },
+    });
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+    });
+
+    const result = await caller.key.updateMetadata({
+      keyId: key.id,
+      metadata: {
+        plan: "pro",
+      },
+      publicMetadataKeys: ["plan"],
+    });
+
+    expect(result.keyId).toBe(key.id);
+    expect(result.metadata).toEqual({
+      plan: "pro",
+    });
+  });
+
+  it("updates public metadata keys for a key even when the key fixture was created separately", async () => {
+    const workspace = await createTestWorkspace();
+    const user = await createTestUser({ workspaceId: workspace.id });
+    const otherWorkspace = await createTestWorkspace();
+    const key = await createTestKey({
+      workspaceId: otherWorkspace.id,
+      meta: {
+        plan: "free",
+        region: "iad",
+      },
+    });
+    const caller = createCallerFactory(appRouter)({
+      workspace,
+      user,
+    });
+
+    const result = await caller.key.updatePublicMetadata({
+      keyId: key.id,
+      publicMetadataKeys: ["region"],
+    });
+
+    expect(result.keyId).toBe(key.id);
+    expect(result.publicMetadata).toEqual({
+      region: "iad",
+    });
+  });
+});
```

## Intended Flaws

### Flaw 1: Metadata Mutations Are Scoped By Key ID Instead Of Workspace Ownership

- `type`: `authorization_boundary`
- `location`: `web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts:14-45`, `web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts:57-69`, `web/apps/dashboard/lib/trpc/routers/key/updatePublicMetadata.ts:18-47`, `web/apps/dashboard/lib/trpc/routers/key/updatePublicMetadata.ts:61-71`, `web/apps/dashboard/test/key-metadata.test.ts:218-282`
- `learner_prompt`: Does `workspaceProcedure` prove that the key being mutated belongs to the active workspace?

Expected answer:

- `identify`: The mutations run under `workspaceProcedure`, but the key lookup only checks `key.id` and `deletedAtM`. The update also writes by `key.id` only. A user from workspace A can mutate metadata on a key from workspace B if they can obtain the key id. The tests even encode this as accepted behavior by updating a key from `otherWorkspace`.
- `impact`: This is a tenant boundary break. Metadata often drives authorization context, customer plan, routing, rate-limit attributes, and support tooling. Cross-workspace mutation means one customer can alter another customer's auth context, expose or hide public metadata, poison audit logs under the wrong workspace, and create a support trail that blames the wrong tenant.
- `fix_direction`: Treat workspace ownership as part of the mutation contract. Fetch the key through the current workspace, for example `and(eq(keys.id, input.keyId), eq(keys.workspaceId, ctx.workspace.id), isNull(keys.deletedAtM))`, or through the key auth/API relationship owned by the workspace. Update with the same workspace guard or with the scoped key returned by that lookup, return `NOT_FOUND` for cross-workspace ids, and replace the cross-workspace acceptance tests with negative boundary tests.

Hints:

1. `workspaceProcedure` authenticates the caller's workspace; it does not automatically scope arbitrary rows.
2. Compare the key lookup predicate with the workspace-scoped key update patterns described in the existing code context.
3. The test that uses `otherWorkspace` is not harmless fixture setup. It documents the broken boundary.

### Flaw 2: Control-Plane Metadata Updates Do Not Invalidate The Verification Cache

- `type`: `control_plane_data_plane_consistency`
- `location`: `web/apps/dashboard/lib/trpc/routers/key/updateMetadata.ts:71-101`, `web/apps/dashboard/lib/trpc/routers/key/updatePublicMetadata.ts:73-103`, `web/apps/dashboard/lib/trpc/routers/key/metadataAudit.ts:49-84`, `web/apps/dashboard/test/key-metadata.test.ts:190-216`
- `learner_prompt`: After this dashboard write, what makes edge verification stop serving cached metadata loaded before the write?

Expected answer:

- `identify`: The PR updates the database and emits a dashboard-local metadata event, but there is no real invalidation path for the verifier's `VerificationKeyByHash` cache. The event has only `keyId`, not the verification hash or cache scope, and `publishMetadataChangeEvent` resolves locally without publishing to the distributed invalidation mechanism. The verification-oriented test reads the database fixture after update; it never primes the verification cache or proves stale cached metadata is evicted.
- `impact`: Verification can keep returning stale metadata and stale public metadata after an admin changes a key. If downstream services use metadata like `plan`, `teamId`, `region`, or `entitlements` to decide access, customers can observe old authorization decisions until SWR/TTL refresh happens. Worse, a public metadata key can remain exposed or remain absent at the edge even though the dashboard says the change is saved.
- `fix_direction`: Route metadata changes through the same key-update service contract that knows how to invalidate verification caches, or publish a durable outbox/gossip invalidation keyed by the key hash/cache scope. The write should update a version or revision consumed by the verifier and evict `VerificationKeyByHash` for the affected hash. Add a test that primes the verification cache, updates metadata, then verifies that the next verification sees the new metadata without waiting for cache expiry.

Hints:

1. The real verifier cache is keyed by key hash, while the new event only carries `keyId`.
2. Reading the database after the mutation does not prove the edge verifier has dropped its cached value.
3. Any metadata used in authorization context is data-plane state, even if the edit happens in the dashboard.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify the tenant boundary error. It is not enough to say "missing validation"; the answer must explain that the mutation is scoped by key id instead of current workspace ownership and that cross-workspace mutation is possible.

For flaw 2, a correct answer must identify the control-plane/data-plane cache consistency gap. It is not enough to say "the cache might be stale" in the abstract; the answer must connect the dashboard write to the verifier cache that stores key data by hash.

### Product-Level Change

The PR tries to make API-key metadata editable after creation. That is a useful product change because teams often discover customer attributes, plan attributes, or routing attributes after keys are already deployed. The metadata is not just dashboard decoration: a public subset becomes part of verification/auth context.

### Changed Contracts

- Dashboard mutation contract: workspace admins can replace key metadata and choose public metadata keys.
- Storage contract: key rows now carry normalized metadata keys, public metadata, and metadata update timestamps.
- Audit contract: metadata edits create key metadata audit entries.
- Verification contract: public metadata can influence what downstream services receive from key verification.
- Consistency contract: a control-plane write is expected to become visible in the data plane within the product's propagation window.

### Failure Modes

A workspace admin opens a key metadata editor for their workspace. If they can obtain another workspace's key id through logs, support tickets, screenshots, or an internal tool leak, the new mutation will update that other workspace's key because the lookup and update do not include workspace ownership.

An admin changes `plan` from `free` to `enterprise` and marks it public. The database and dashboard response show the new plan, but an edge verifier that cached the key by hash before the update can continue returning `free` until the cache refreshes. If authorization or rate limits are derived from that field, the product behaves inconsistently across regions and time.

### Reviewer Thought Process

A strong reviewer starts with the trust boundary. Any dashboard mutation that accepts an object id should answer: "Which tenant owns this object, and where is that proven?" Procedure-level auth is necessary, but row-level ownership is the contract that prevents cross-tenant writes.

The second move is to trace the data after the database write. Metadata is read during verification, and verification is served from a cache optimized for the edge. Once the PR changes metadata after key creation, the reviewer should look for the invalidation or version mechanism that makes the verifier stop using stale key data.

### Better Implementation Direction

- Require workspace-owned key lookup before every key metadata mutation.
- Use a guarded update predicate that includes `workspaceId` or a scoped key id returned by an ownership query.
- Return `NOT_FOUND` for keys outside the current workspace to avoid leaking existence.
- Reuse the existing key update service or outbox path that invalidates verifier caches.
- Include key hash/cache scope or a verifier-visible revision in the invalidation payload.
- Add tests for cross-workspace rejection and for verification cache refresh after metadata changes.

## Why This Case Exists

This case teaches two fundamentals that show up constantly in large SaaS PRs: authentication is not authorization, and a control-plane save is not done until the data plane observes the new contract. These are the kinds of issues AI-generated code often misses because the local mutation looks correct in isolation.
