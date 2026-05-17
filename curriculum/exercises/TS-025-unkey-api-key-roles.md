# TS-025: Unkey API-Key Roles

## Metadata

- `id`: TS-025
- `source_repo`: [unkeyed/unkey](https://github.com/unkeyed/unkey)
- `repo_area`: dashboard key RBAC, role and permission join tables, API-key creation, key verification permission expansion, verification cache semantics
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 1,050-1,300
- `represented_diff_lines`: 1,273
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about workspace boundaries, API-key RBAC, role-permission expansion, mutable authorization, data-plane caches, and snapshot tradeoffs without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds reusable roles to API keys.

Today admins can attach permissions directly to each key. That works for a few keys, but it becomes tedious when a workspace has many service keys with the same access profile. The new flow lets admins assign one or more workspace roles to a key. The key receives all permissions from those roles plus any direct permissions assigned during creation.

The PR adds:

- `keys_roles` and `key_role_permission_snapshots` schema,
- a tRPC mutation for updating a key's assigned roles,
- permission resolution helpers used by key creation and key RBAC updates,
- role update hooks that record audit events for affected keys,
- tests for assigning roles, creating keys with roles, and verifying the effective permission list.

## Existing Code Context

The real Unkey codebase already has these relevant contracts:

- `web/internal/db/src/schema/rbac.ts` models `roles`, `permissions`, `keys_roles`, `keys_permissions`, and `roles_permissions` as workspace-owned RBAC tables.
- `web/apps/dashboard/lib/trpc/routers/key/create.ts` resolves `keyAuth` through `ctx.workspace.id` before creating a key and writes the key with `workspaceId: ctx.workspace.id`.
- `web/apps/dashboard/lib/trpc/routers/key/rbac/update-rbac.ts` verifies that the key belongs to `ctx.workspace.id`, validates role IDs and permission IDs in that workspace, then writes `keys_roles` and `keys_permissions`.
- `web/apps/dashboard/lib/trpc/routers/authorization/roles/upsert.ts` checks that any key IDs or permission IDs attached to a role also belong to the current workspace.
- `internal/services/keys/db/queries/key_find_for_verification.sql` and `pkg/db/queries/key_find_live_by_hash.sql` expand direct permissions and role-derived permissions from join tables when loading a key for verification.
- `internal/services/keys/get.go` caches loaded key data, including decoded roles and permissions, so permission updates must either be reflected at runtime through live expansion and cache invalidation, or be explicitly modeled as immutable snapshots with clear versioning.
- Some verification joins rely on the write path keeping `keys_roles`, `keys_permissions`, and `roles_permissions` internally consistent. That makes workspace-scoped writes and role mutation semantics part of the security contract, not just dashboard hygiene.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `web/internal/db/src/schema/rbac.ts`
- `web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.ts`
- `web/apps/dashboard/lib/trpc/routers/key/rbac/resolve-effective-permissions.ts`
- `web/apps/dashboard/lib/trpc/routers/key/rbac/create-key-with-roles.ts`
- `web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.ts`
- `web/apps/dashboard/lib/trpc/routers/authorization/roles/upsert.ts`
- `web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.test.ts`
- `web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.test.ts`
- `web/apps/dashboard/lib/trpc/routers/key/rbac/fixtures.ts`

The line references below use synthetic PR line numbers. The represented diff is focused on backend/API behavior, data contracts, tests, and authorization semantics.

## Diff

```diff
diff --git a/web/internal/db/src/schema/rbac.ts b/web/internal/db/src/schema/rbac.ts
index 4b60b51d3..6454f9d71 100644
--- a/web/internal/db/src/schema/rbac.ts
+++ b/web/internal/db/src/schema/rbac.ts
@@ -1,17 +1,26 @@
 import { relations } from "drizzle-orm";
-import { bigint, index, mysqlTable, unique, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
+import {
+  bigint,
+  index,
+  json,
+  mysqlTable,
+  text,
+  unique,
+  uniqueIndex,
+  varchar,
+} from "drizzle-orm/mysql-core";
 import { keys } from "./keys";
 import { workspaces } from "./workspaces";
 
 export const permissions = mysqlTable(
   "permissions",
   {
     pk: bigint("pk", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
     id: varchar("id", { length: 256 }).notNull().unique(),
     workspaceId: varchar("workspace_id", { length: 256 }).notNull(),
     name: varchar("name", { length: 512 }).notNull(),
     slug: varchar("slug", { length: 128 }).notNull(),
     description: varchar("description", { length: 512 }),
     createdAtM: bigint("created_at_m", { mode: "number" })
       .notNull()
@@ -44,6 +53,20 @@ export const keysPermissions = mysqlTable(
     unique("key_id_permission_id_idx").on(table.keyId, table.permissionId),
   ],
 );
 
+export const keyRolePermissionSnapshots = mysqlTable(
+  "key_role_permission_snapshots",
+  {
+    pk: bigint("pk", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
+    keyId: varchar("key_id", { length: 256 }).notNull(),
+    workspaceId: varchar("workspace_id", { length: 256 }).notNull(),
+    roleIds: json("role_ids").$type<string[]>().notNull(),
+    permissionSlugs: json("permission_slugs").$type<string[]>().notNull(),
+    reason: text("reason").notNull(),
+    createdAtM: bigint("created_at_m", { mode: "number" }).notNull(),
+  },
+  (table) => [uniqueIndex("key_role_snapshot_key_id").on(table.keyId)],
+);
+
 export const keysPermissionsRelations = relations(keysPermissions, ({ one }) => ({
   key: one(keys, {
     fields: [keysPermissions.keyId],
     references: [keys.id],
@@ -92,6 +115,9 @@ export const rolesRelations = relations(roles, ({ one, many }) => ({
   permissions: many(rolesPermissions, {
     relationName: "roles_rolesPermissions",
   }),
+  keySnapshots: many(keyRolePermissionSnapshots, {
+    relationName: "roles_key_role_permission_snapshots",
+  }),
 }));
 
 export const rolesPermissions = mysqlTable(
@@ -151,3 +177,15 @@ export const keysRolesRelations = relations(keysRoles, ({ one }) => ({
     relationName: "keys_roles_key_relations",
   }),
 }));
+
+export const keyRolePermissionSnapshotRelations = relations(
+  keyRolePermissionSnapshots,
+  ({ one }) => ({
+    key: one(keys, {
+      fields: [keyRolePermissionSnapshots.keyId],
+      references: [keys.id],
+      relationName: "keys_key_role_permission_snapshots",
+    }),
+  }),
+);
diff --git a/web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.ts b/web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.ts
new file mode 100644
index 000000000..9c2d62d44
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.ts
@@ -0,0 +1,216 @@
+import { insertAuditLogs } from "@/lib/audit";
+import { and, db, eq, schema } from "@/lib/db";
+import { ratelimit, withRatelimit, workspaceProcedure } from "@/lib/trpc/trpc";
+import { TRPCError } from "@trpc/server";
+import { z } from "zod";
+import {
+  buildRolePermissionSnapshot,
+  persistRolePermissionSnapshot,
+} from "./role-permission-snapshot";
+
+const updateKeyRolesInput = z.object({
+  keyId: z.string().min(1),
+  roleIds: z.array(z.string().min(1)).default([]),
+  directPermissionIds: z.array(z.string().min(1)).default([]),
+  reason: z.string().trim().max(400).optional(),
+});
+
+const updateKeyRolesResponse = z.object({
+  keyId: z.string(),
+  assignedRoleIds: z.array(z.string()),
+  directPermissionIds: z.array(z.string()),
+  effectivePermissionSlugs: z.array(z.string()),
+});
+
+type UpdateKeyRolesResult = z.infer<typeof updateKeyRolesResponse>;
+
+export const updateKeyRoles = workspaceProcedure
+  .use(withRatelimit(ratelimit.update))
+  .input(updateKeyRolesInput)
+  .output(updateKeyRolesResponse)
+  .mutation(async ({ ctx, input }): Promise<UpdateKeyRolesResult> => {
+    const workspaceId = ctx.workspace.id;
+
+    const key = await db.query.keys.findFirst({
+      where: (table, { and, eq, isNull }) =>
+        and(eq(table.id, input.keyId), eq(table.workspaceId, workspaceId), isNull(table.deletedAtM)),
+      columns: {
+        id: true,
+        name: true,
+        workspaceId: true,
+        keyAuthId: true,
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
+    const uniqueRoleIds = Array.from(new Set(input.roleIds));
+    const uniqueDirectPermissionIds = Array.from(new Set(input.directPermissionIds));
+
+    const roles =
+      uniqueRoleIds.length === 0
+        ? []
+        : await db.query.roles.findMany({
+            where: (table, { inArray }) => inArray(table.id, uniqueRoleIds),
+            columns: {
+              id: true,
+              name: true,
+              workspaceId: true,
+            },
+            with: {
+              permissions: {
+                with: {
+                  permission: {
+                    columns: {
+                      id: true,
+                      slug: true,
+                      workspaceId: true,
+                    },
+                  },
+                },
+              },
+            },
+          });
+
+    if (roles.length !== uniqueRoleIds.length) {
+      const foundIds = new Set(roles.map((role) => role.id));
+      const missing = uniqueRoleIds.filter((roleId) => !foundIds.has(roleId));
+      throw new TRPCError({
+        code: "BAD_REQUEST",
+        message: `Could not find roles: ${missing.join(", ")}`,
+      });
+    }
+
+    const directPermissions =
+      uniqueDirectPermissionIds.length === 0
+        ? []
+        : await db.query.permissions.findMany({
+            where: (table, { and, eq, inArray }) =>
+              and(eq(table.workspaceId, workspaceId), inArray(table.id, uniqueDirectPermissionIds)),
+            columns: {
+              id: true,
+              slug: true,
+            },
+          });
+
+    if (directPermissions.length !== uniqueDirectPermissionIds.length) {
+      const foundIds = new Set(directPermissions.map((permission) => permission.id));
+      const missing = uniqueDirectPermissionIds.filter((permissionId) => !foundIds.has(permissionId));
+      throw new TRPCError({
+        code: "BAD_REQUEST",
+        message: `Could not find permissions: ${missing.join(", ")}`,
+      });
+    }
+
+    const snapshot = buildRolePermissionSnapshot({
+      roles,
+      directPermissions,
+      reason: input.reason ?? "key_rbac_update",
+    });
+
+    await db.transaction(async (tx) => {
+      await tx
+        .delete(schema.keysRoles)
+        .where(and(eq(schema.keysRoles.keyId, key.id), eq(schema.keysRoles.workspaceId, workspaceId)));
+
+      if (uniqueRoleIds.length > 0) {
+        await tx.insert(schema.keysRoles).values(
+          roles.map((role) => ({
+            keyId: key.id,
+            roleId: role.id,
+            workspaceId,
+          })),
+        );
+      }
+
+      await tx
+        .delete(schema.keysPermissions)
+        .where(
+          and(
+            eq(schema.keysPermissions.keyId, key.id),
+            eq(schema.keysPermissions.workspaceId, workspaceId),
+          ),
+        );
+
+      if (uniqueDirectPermissionIds.length > 0) {
+        await tx.insert(schema.keysPermissions).values(
+          directPermissions.map((permission) => ({
+            keyId: key.id,
+            permissionId: permission.id,
+            workspaceId,
+          })),
+        );
+      }
+
+      await persistRolePermissionSnapshot(tx, {
+        keyId: key.id,
+        workspaceId,
+        roleIds: uniqueRoleIds,
+        permissionSlugs: snapshot.effectivePermissionSlugs,
+        reason: snapshot.reason,
+      });
+
+      await insertAuditLogs(tx, {
+        workspaceId,
+        actor: {
+          type: "user",
+          id: ctx.user.id,
+        },
+        event: "authorization.connect_role_and_key",
+        description: `Updated key roles for ${key.id}`,
+        resources: [
+          {
+            type: "key",
+            id: key.id,
+            name: key.name ?? undefined,
+          },
+          ...roles.map((role) => ({
+            type: "role" as const,
+            id: role.id,
+            name: role.name,
+          })),
+        ],
+        context: {
+          location: ctx.audit.location,
+          userAgent: ctx.audit.userAgent,
+        },
+      });
+    });
+
+    return {
+      keyId: key.id,
+      assignedRoleIds: uniqueRoleIds,
+      directPermissionIds: uniqueDirectPermissionIds,
+      effectivePermissionSlugs: snapshot.effectivePermissionSlugs,
+    };
+  });
+
+export async function previewKeyRoleUpdate(input: {
+  workspaceId: string;
+  keyId: string;
+  roleIds: string[];
+  directPermissionIds: string[];
+}) {
+  const key = await db.query.keys.findFirst({
+    where: (table, { and, eq, isNull }) =>
+      and(eq(table.workspaceId, input.workspaceId), eq(table.id, input.keyId), isNull(table.deletedAtM)),
+    columns: { id: true },
+  });
+
+  if (!key) {
+    return {
+      ok: false as const,
+      reason: "key_not_found" as const,
+    };
+  }
+
+  const roles = await db.query.roles.findMany({
+    where: (table, { inArray }) => inArray(table.id, input.roleIds),
+    columns: {
+      id: true,
+      name: true,
+      workspaceId: true,
+    },
+  });
+
+  const directPermissions = await db.query.permissions.findMany({
+    where: (table, { and, eq, inArray }) =>
+      and(eq(table.workspaceId, input.workspaceId), inArray(table.id, input.directPermissionIds)),
+    columns: {
+      id: true,
+      slug: true,
+    },
+  });
+
+  return {
+    ok: true as const,
+    roles,
+    directPermissions,
+  };
+}
diff --git a/web/apps/dashboard/lib/trpc/routers/key/rbac/resolve-effective-permissions.ts b/web/apps/dashboard/lib/trpc/routers/key/rbac/resolve-effective-permissions.ts
new file mode 100644
index 000000000..cdb7f23a2
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/rbac/resolve-effective-permissions.ts
@@ -0,0 +1,160 @@
+import { db, eq, inArray, schema } from "@/lib/db";
+import { TRPCError } from "@trpc/server";
+
+export type EffectivePermissionSource =
+  | {
+      type: "direct";
+      permissionId: string;
+      slug: string;
+    }
+  | {
+      type: "role";
+      roleId: string;
+      roleName: string;
+      permissionId: string;
+      slug: string;
+    };
+
+export type EffectivePermissionResult = {
+  sources: EffectivePermissionSource[];
+  slugs: string[];
+};
+
+export async function resolveEffectivePermissionsForRoles(input: {
+  workspaceId: string;
+  roleIds: string[];
+  directPermissionIds: string[];
+}): Promise<EffectivePermissionResult> {
+  const roleIds = Array.from(new Set(input.roleIds));
+  const directPermissionIds = Array.from(new Set(input.directPermissionIds));
+
+  const rolePermissionRows =
+    roleIds.length === 0
+      ? []
+      : await db
+          .select({
+            roleId: schema.roles.id,
+            roleName: schema.roles.name,
+            roleWorkspaceId: schema.roles.workspaceId,
+            permissionId: schema.permissions.id,
+            permissionWorkspaceId: schema.permissions.workspaceId,
+            slug: schema.permissions.slug,
+          })
+          .from(schema.roles)
+          .innerJoin(
+            schema.rolesPermissions,
+            eq(schema.rolesPermissions.roleId, schema.roles.id),
+          )
+          .innerJoin(
+            schema.permissions,
+            eq(schema.permissions.id, schema.rolesPermissions.permissionId),
+          )
+          .where(inArray(schema.roles.id, roleIds));
+
+  const directPermissionRows =
+    directPermissionIds.length === 0
+      ? []
+      : await db.query.permissions.findMany({
+          where: (table, { and, eq, inArray }) =>
+            and(eq(table.workspaceId, input.workspaceId), inArray(table.id, directPermissionIds)),
+          columns: {
+            id: true,
+            slug: true,
+          },
+        });
+
+  if (directPermissionRows.length !== directPermissionIds.length) {
+    throw new TRPCError({
+      code: "BAD_REQUEST",
+      message: "One or more direct permissions are not available in this workspace",
+    });
+  }
+
+  const sources: EffectivePermissionSource[] = [];
+
+  for (const row of rolePermissionRows) {
+    sources.push({
+      type: "role",
+      roleId: row.roleId,
+      roleName: row.roleName,
+      permissionId: row.permissionId,
+      slug: row.slug,
+    });
+  }
+
+  for (const row of directPermissionRows) {
+    sources.push({
+      type: "direct",
+      permissionId: row.id,
+      slug: row.slug,
+    });
+  }
+
+  return {
+    sources,
+    slugs: Array.from(new Set(sources.map((source) => source.slug))).sort(),
+  };
+}
+
+export async function resolveEffectivePermissionsForKey(input: {
+  workspaceId: string;
+  keyId: string;
+}): Promise<EffectivePermissionResult> {
+  const key = await db.query.keys.findFirst({
+    where: (table, { and, eq, isNull }) =>
+      and(eq(table.workspaceId, input.workspaceId), eq(table.id, input.keyId), isNull(table.deletedAtM)),
+    columns: {
+      id: true,
+    },
+  });
+
+  if (!key) {
+    throw new TRPCError({
+      code: "NOT_FOUND",
+      message: "Key not found",
+    });
+  }
+
+  const [assignedRoles, directPermissions] = await Promise.all([
+    db.query.keysRoles.findMany({
+      where: (table, { eq }) => eq(table.keyId, input.keyId),
+      columns: {
+        roleId: true,
+      },
+    }),
+    db.query.keysPermissions.findMany({
+      where: (table, { eq }) => eq(table.keyId, input.keyId),
+      columns: {
+        permissionId: true,
+      },
+    }),
+  ]);
+
+  return resolveEffectivePermissionsForRoles({
+    workspaceId: input.workspaceId,
+    roleIds: assignedRoles.map((role) => role.roleId),
+    directPermissionIds: directPermissions.map((permission) => permission.permissionId),
+  });
+}
+
+export async function assertRolesCanBeAssignedToKey(input: {
+  workspaceId: string;
+  roleIds: string[];
+}) {
+  if (input.roleIds.length === 0) {
+    return [];
+  }
+
+  const roles = await db.query.roles.findMany({
+    where: (table, { inArray }) => inArray(table.id, input.roleIds),
+    columns: {
+      id: true,
+      name: true,
+      workspaceId: true,
+    },
+  });
+
+  if (roles.length !== input.roleIds.length) {
+    throw new TRPCError({
+      code: "BAD_REQUEST",
+      message: "Role not found",
+    });
+  }
+
+  return roles;
+}
diff --git a/web/apps/dashboard/lib/trpc/routers/key/rbac/create-key-with-roles.ts b/web/apps/dashboard/lib/trpc/routers/key/rbac/create-key-with-roles.ts
new file mode 100644
index 000000000..f66dbe3a1
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/rbac/create-key-with-roles.ts
@@ -0,0 +1,147 @@
+import type { CreateKeyInput } from "@/app/(app)/[workspaceSlug]/apis/[apiId]/_components/create-key/create-key.schema";
+import { insertAuditLogs } from "@/lib/audit";
+import { db, schema } from "@/lib/db";
+import type { Transaction } from "@unkey/db";
+import { newId } from "@unkey/id";
+import {
+  buildRolePermissionSnapshot,
+  persistRolePermissionSnapshot,
+} from "./role-permission-snapshot";
+import { assertRolesCanBeAssignedToKey } from "./resolve-effective-permissions";
+
+type CreateKeyWithRolesInput = CreateKeyInput & {
+  storeEncryptedKeys: boolean;
+  hash: string;
+  start: string;
+  roleIds?: string[];
+  directPermissionIds?: string[];
+};
+
+type CreateKeyWithRolesContext = {
+  workspace: { id: string };
+  user: { id: string };
+  audit: {
+    location: string;
+    userAgent?: string;
+  };
+};
+
+export async function createKeyWithRolesCore(
+  input: CreateKeyWithRolesInput,
+  ctx: CreateKeyWithRolesContext,
+  tx: Transaction,
+) {
+  const roleIds = Array.from(new Set(input.roleIds ?? []));
+  const directPermissionIds = Array.from(new Set(input.directPermissionIds ?? []));
+  const roles = await assertRolesCanBeAssignedToKey({
+    workspaceId: ctx.workspace.id,
+    roleIds,
+  });
+
+  const directPermissions =
+    directPermissionIds.length === 0
+      ? []
+      : await tx.query.permissions.findMany({
+          where: (table, { and, eq, inArray }) =>
+            and(eq(table.workspaceId, ctx.workspace.id), inArray(table.id, directPermissionIds)),
+          columns: {
+            id: true,
+            slug: true,
+          },
+        });
+
+  const keyId = newId("key");
+  const createdAt = Date.now();
+
+  await tx.insert(schema.keys).values({
+    id: keyId,
+    keyAuthId: input.keyAuthId,
+    name: input.name,
+    hash: input.hash,
+    start: input.start,
+    identityId: input.identityId,
+    ownerId: input.externalId,
+    meta: JSON.stringify(input.meta ?? {}),
+    workspaceId: ctx.workspace.id,
+    forWorkspaceId: null,
+    expires: input.expires ? new Date(input.expires) : null,
+    createdAtM: createdAt,
+    updatedAtM: null,
+    remaining: input.remaining,
+    refillDay: input.refill?.refillDay ?? null,
+    refillAmount: input.refill?.amount ?? null,
+    lastRefillAt: input.refill ? new Date() : null,
+    enabled: input.enabled,
+    environment: input.environment,
+  });
+
+  if (roleIds.length > 0) {
+    await tx.insert(schema.keysRoles).values(
+      roles.map((role) => ({
+        keyId,
+        roleId: role.id,
+        workspaceId: ctx.workspace.id,
+      })),
+    );
+  }
+
+  if (directPermissions.length > 0) {
+    await tx.insert(schema.keysPermissions).values(
+      directPermissions.map((permission) => ({
+        keyId,
+        permissionId: permission.id,
+        workspaceId: ctx.workspace.id,
+      })),
+    );
+  }
+
+  const snapshot = buildRolePermissionSnapshot({
+    roles,
+    directPermissions,
+    reason: "key_create",
+  });
+
+  await persistRolePermissionSnapshot(tx, {
+    keyId,
+    workspaceId: ctx.workspace.id,
+    roleIds,
+    permissionSlugs: snapshot.effectivePermissionSlugs,
+    reason: snapshot.reason,
+  });
+
+  await insertAuditLogs(tx, {
+    workspaceId: ctx.workspace.id,
+    actor: {
+      type: "user",
+      id: ctx.user.id,
+    },
+    event: "key.create",
+    description: `Created ${keyId} with ${roleIds.length} role(s)`,
+    resources: [
+      {
+        type: "key",
+        id: keyId,
+        name: input.name,
+      },
+      ...roles.map((role) => ({
+        type: "role" as const,
+        id: role.id,
+        name: role.name,
+      })),
+    ],
+    context: {
+      location: ctx.audit.location,
+      userAgent: ctx.audit.userAgent,
+    },
+  });
+
+  return {
+    keyId,
+    effectivePermissionSlugs: snapshot.effectivePermissionSlugs,
+  };
+}
+
+export async function createKeyWithRoles(input: CreateKeyWithRolesInput, ctx: CreateKeyWithRolesContext) {
+  return db.transaction(async (tx) => createKeyWithRolesCore(input, ctx, tx));
+}
diff --git a/web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.ts b/web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.ts
new file mode 100644
index 000000000..04c4f4509
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.ts
@@ -0,0 +1,159 @@
+import { and, eq, schema } from "@/lib/db";
+import type { Transaction } from "@unkey/db";
+
+type RoleWithPermissions = {
+  id: string;
+  name: string;
+  workspaceId: string;
+  permissions?: {
+    permission: {
+      id: string;
+      slug: string;
+      workspaceId: string;
+    } | null;
+  }[];
+};
+
+type DirectPermission = {
+  id: string;
+  slug: string;
+};
+
+export type RolePermissionSnapshot = {
+  roleIds: string[];
+  directPermissionIds: string[];
+  effectivePermissionSlugs: string[];
+  reason: string;
+};
+
+export function buildRolePermissionSnapshot(input: {
+  roles: RoleWithPermissions[];
+  directPermissions: DirectPermission[];
+  reason: string;
+}): RolePermissionSnapshot {
+  const roleIds = input.roles.map((role) => role.id);
+  const directPermissionIds = input.directPermissions.map((permission) => permission.id);
+  const slugs = new Set<string>();
+
+  for (const role of input.roles) {
+    for (const rolePermission of role.permissions ?? []) {
+      if (!rolePermission.permission) {
+        continue;
+      }
+      slugs.add(rolePermission.permission.slug);
+    }
+  }
+
+  for (const permission of input.directPermissions) {
+    slugs.add(permission.slug);
+  }
+
+  return {
+    roleIds,
+    directPermissionIds,
+    effectivePermissionSlugs: Array.from(slugs).sort(),
+    reason: input.reason,
+  };
+}
+
+export async function persistRolePermissionSnapshot(
+  tx: Transaction,
+  input: {
+    keyId: string;
+    workspaceId: string;
+    roleIds: string[];
+    permissionSlugs: string[];
+    reason: string;
+  },
+) {
+  await tx
+    .delete(schema.keyRolePermissionSnapshots)
+    .where(
+      and(
+        eq(schema.keyRolePermissionSnapshots.keyId, input.keyId),
+        eq(schema.keyRolePermissionSnapshots.workspaceId, input.workspaceId),
+      ),
+    );
+
+  await tx.insert(schema.keyRolePermissionSnapshots).values({
+    keyId: input.keyId,
+    workspaceId: input.workspaceId,
+    roleIds: input.roleIds,
+    permissionSlugs: input.permissionSlugs,
+    reason: input.reason,
+    createdAtM: Date.now(),
+  });
+}
+
+export async function readRolePermissionSnapshot(
+  tx: Transaction,
+  input: {
+    keyId: string;
+    workspaceId: string;
+  },
+) {
+  const snapshot = await tx.query.keyRolePermissionSnapshots.findFirst({
+    where: (table, { and, eq }) =>
+      and(eq(table.keyId, input.keyId), eq(table.workspaceId, input.workspaceId)),
+    columns: {
+      keyId: true,
+      workspaceId: true,
+      roleIds: true,
+      permissionSlugs: true,
+      reason: true,
+      createdAtM: true,
+    },
+  });
+
+  if (!snapshot) {
+    return {
+      keyId: input.keyId,
+      workspaceId: input.workspaceId,
+      roleIds: [],
+      permissionSlugs: [],
+      reason: "empty",
+      createdAtM: 0,
+    };
+  }
+
+  return snapshot;
+}
+
+export async function resolvePermissionSlugsForVerification(
+  tx: Transaction,
+  input: {
+    keyId: string;
+    workspaceId: string;
+  },
+) {
+  const snapshot = await readRolePermissionSnapshot(tx, input);
+
+  return {
+    keyId: input.keyId,
+    workspaceId: input.workspaceId,
+    permissionSlugs: snapshot.permissionSlugs,
+    roleIds: snapshot.roleIds,
+    fromSnapshotCreatedAt: snapshot.createdAtM,
+  };
+}
diff --git a/web/apps/dashboard/lib/trpc/routers/authorization/roles/upsert.ts b/web/apps/dashboard/lib/trpc/routers/authorization/roles/upsert.ts
index 30790cc22..f4c6708b2 100644
--- a/web/apps/dashboard/lib/trpc/routers/authorization/roles/upsert.ts
+++ b/web/apps/dashboard/lib/trpc/routers/authorization/roles/upsert.ts
@@ -1,12 +1,16 @@
 import { rbacRoleSchema } from "@/app/(app)/[workspaceSlug]/authorization/roles/components/upsert-role/upsert-role.schema";
 import { insertAuditLogs } from "@/lib/audit";
 import { and, db, eq, schema } from "@/lib/db";
 import { workspaceProcedure } from "@/lib/trpc/trpc";
 import { TRPCError } from "@trpc/server";
 import type { Transaction } from "@unkey/db";
 import { newId } from "@unkey/id";
+import { readRolePermissionSnapshot } from "../../key/rbac/role-permission-snapshot";
 
 async function assertKeysInWorkspace(tx: Transaction, workspaceId: string, keyIds: string[]) {
   if (keyIds.length === 0) {
     return;
   }
@@ -96,6 +100,7 @@ export const upsertRole = workspaceProcedure
     await db.transaction(async (tx) => {
       if (isUpdate && input.roleId) {
         const updateRoleId: string = input.roleId;
+        const affectedKeyIds = input.keyIds ?? [];
 
         const existingRole = await tx.query.roles.findFirst({
           where: (table, { and, eq }) =>
@@ -171,6 +176,41 @@ export const upsertRole = workspaceProcedure
             );
           }
         }
+
+        if (affectedKeyIds.length > 0) {
+          const snapshotReads = await Promise.all(
+            affectedKeyIds.map((keyId) =>
+              readRolePermissionSnapshot(tx, {
+                keyId,
+                workspaceId: ctx.workspace.id,
+              }),
+            ),
+          );
+
+          await insertAuditLogs(
+            tx,
+            snapshotReads.map((snapshot) => ({
+              workspaceId: ctx.workspace.id,
+              event: "authorization.connect_role_and_key",
+              actor: {
+                type: "user",
+                id: ctx.user.id,
+              },
+              description: `Role ${updateRoleId} changed; key ${snapshot.keyId} keeps ${snapshot.permissionSlugs.length} effective permission(s)`,
+              resources: [
+                {
+                  type: "role",
+                  id: updateRoleId,
+                  name: input.roleName,
+                },
+                {
+                  type: "key",
+                  id: snapshot.keyId,
+                },
+              ],
+              context: {
+                userAgent: ctx.audit.userAgent,
+                location: ctx.audit.location,
+              },
+              correlationId,
+            })),
+          );
+        }
 
         await insertAuditLogs(tx, {
           workspaceId: ctx.workspace.id,
diff --git a/web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.test.ts b/web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.test.ts
new file mode 100644
index 000000000..31ec8b9f1
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.test.ts
@@ -0,0 +1,205 @@
+import { describe, expect, it } from "vitest";
+import { buildRolePermissionSnapshot } from "./role-permission-snapshot";
+import {
+  makeDirectPermission,
+  makeKey,
+  makeRole,
+  makeRoleWithPermissions,
+  workspaceAlpha,
+  workspaceBeta,
+} from "./fixtures";
+
+describe("updateKeyRoles", () => {
+  it("deduplicates role permission slugs", () => {
+    const readPermission = makeDirectPermission({
+      id: "perm_read",
+      slug: "documents.read",
+      workspaceId: workspaceAlpha.id,
+    });
+    const writePermission = makeDirectPermission({
+      id: "perm_write",
+      slug: "documents.write",
+      workspaceId: workspaceAlpha.id,
+    });
+
+    const editor = makeRoleWithPermissions({
+      id: "role_editor",
+      name: "Editor",
+      workspaceId: workspaceAlpha.id,
+      permissions: [readPermission, writePermission],
+    });
+
+    const duplicateReader = makeRoleWithPermissions({
+      id: "role_reader",
+      name: "Reader",
+      workspaceId: workspaceAlpha.id,
+      permissions: [readPermission],
+    });
+
+    const snapshot = buildRolePermissionSnapshot({
+      roles: [editor, duplicateReader],
+      directPermissions: [readPermission],
+      reason: "test",
+    });
+
+    expect(snapshot.effectivePermissionSlugs).toEqual(["documents.read", "documents.write"]);
+    expect(snapshot.roleIds).toEqual(["role_editor", "role_reader"]);
+  });
+
+  it("previews a same-workspace key role update", async () => {
+    const key = makeKey({
+      id: "key_alpha",
+      name: "Alpha service",
+      workspaceId: workspaceAlpha.id,
+    });
+    const role = makeRole({
+      id: "role_writer",
+      name: "Writer",
+      workspaceId: workspaceAlpha.id,
+    });
+    const permission = makeDirectPermission({
+      id: "perm_write",
+      slug: "documents.write",
+      workspaceId: workspaceAlpha.id,
+    });
+
+    expect(key.workspaceId).toBe(role.workspaceId);
+    expect(permission.workspaceId).toBe(workspaceAlpha.id);
+    expect(role.name).toBe("Writer");
+  });
+
+  it("treats empty roles as no effective role permissions", () => {
+    const snapshot = buildRolePermissionSnapshot({
+      roles: [],
+      directPermissions: [],
+      reason: "empty",
+    });
+
+    expect(snapshot.roleIds).toEqual([]);
+    expect(snapshot.directPermissionIds).toEqual([]);
+    expect(snapshot.effectivePermissionSlugs).toEqual([]);
+  });
+
+  it("keeps direct permissions when no roles are assigned", () => {
+    const permission = makeDirectPermission({
+      id: "perm_logs_read",
+      slug: "logs.read",
+      workspaceId: workspaceAlpha.id,
+    });
+
+    const snapshot = buildRolePermissionSnapshot({
+      roles: [],
+      directPermissions: [permission],
+      reason: "direct_only",
+    });
+
+    expect(snapshot.effectivePermissionSlugs).toEqual(["logs.read"]);
+  });
+
+  it("supports assigning multiple roles to a service key", () => {
+    const reader = makeRoleWithPermissions({
+      id: "role_reader",
+      name: "Reader",
+      workspaceId: workspaceAlpha.id,
+      permissions: [
+        makeDirectPermission({
+          id: "perm_read",
+          slug: "documents.read",
+          workspaceId: workspaceAlpha.id,
+        }),
+      ],
+    });
+    const billing = makeRoleWithPermissions({
+      id: "role_billing",
+      name: "Billing",
+      workspaceId: workspaceAlpha.id,
+      permissions: [
+        makeDirectPermission({
+          id: "perm_invoices",
+          slug: "invoices.read",
+          workspaceId: workspaceAlpha.id,
+        }),
+      ],
+    });
+
+    const snapshot = buildRolePermissionSnapshot({
+      roles: [reader, billing],
+      directPermissions: [],
+      reason: "multi_role",
+    });
+
+    expect(snapshot.roleIds).toEqual(["role_reader", "role_billing"]);
+    expect(snapshot.effectivePermissionSlugs).toEqual(["documents.read", "invoices.read"]);
+  });
+
+  it("keeps role metadata for audit display", () => {
+    const role = makeRoleWithPermissions({
+      id: "role_support",
+      name: "Support",
+      workspaceId: workspaceAlpha.id,
+      permissions: [
+        makeDirectPermission({
+          id: "perm_tickets_read",
+          slug: "tickets.read",
+          workspaceId: workspaceAlpha.id,
+        }),
+      ],
+    });
+
+    const snapshot = buildRolePermissionSnapshot({
+      roles: [role],
+      directPermissions: [],
+      reason: "audit_display",
+    });
+
+    expect(snapshot.roleIds).toContain("role_support");
+    expect(role.name).toBe("Support");
+  });
+
+  it("can represent same role names in different workspaces", () => {
+    const alphaAdmin = makeRole({
+      id: "role_alpha_admin",
+      name: "Admin",
+      workspaceId: workspaceAlpha.id,
+    });
+    const betaAdmin = makeRole({
+      id: "role_beta_admin",
+      name: "Admin",
+      workspaceId: workspaceBeta.id,
+    });
+
+    expect(alphaAdmin.name).toBe(betaAdmin.name);
+    expect(alphaAdmin.workspaceId).not.toBe(betaAdmin.workspaceId);
+  });
+
+  it("documents the preview return shape", async () => {
+    const preview = {
+      ok: true,
+      roles: [
+        makeRole({
+          id: "role_reader",
+          name: "Reader",
+          workspaceId: workspaceAlpha.id,
+        }),
+      ],
+      directPermissions: [
+        makeDirectPermission({
+          id: "perm_documents_read",
+          slug: "documents.read",
+          workspaceId: workspaceAlpha.id,
+        }),
+      ],
+    };
+
+    expect(preview.ok).toBe(true);
+    expect(preview.roles).toHaveLength(1);
+    expect(preview.directPermissions).toHaveLength(1);
+  });
+});
diff --git a/web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.test.ts b/web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.test.ts
new file mode 100644
index 000000000..0d4ea78c7
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.test.ts
@@ -0,0 +1,125 @@
+import { describe, expect, it } from "vitest";
+import { buildRolePermissionSnapshot } from "./role-permission-snapshot";
+import { makeDirectPermission, makeRoleWithPermissions, workspaceAlpha } from "./fixtures";
+
+describe("role permission snapshot", () => {
+  it("records the permissions available when the key is created", () => {
+    const read = makeDirectPermission({
+      id: "perm_read",
+      slug: "documents.read",
+      workspaceId: workspaceAlpha.id,
+    });
+    const role = makeRoleWithPermissions({
+      id: "role_reader",
+      name: "Reader",
+      workspaceId: workspaceAlpha.id,
+      permissions: [read],
+    });
+
+    const snapshot = buildRolePermissionSnapshot({
+      roles: [role],
+      directPermissions: [],
+      reason: "key_create",
+    });
+
+    expect(snapshot.effectivePermissionSlugs).toEqual(["documents.read"]);
+  });
+
+  it("does not change an old snapshot when the role object is edited later", () => {
+    const read = makeDirectPermission({
+      id: "perm_read",
+      slug: "documents.read",
+      workspaceId: workspaceAlpha.id,
+    });
+    const write = makeDirectPermission({
+      id: "perm_write",
+      slug: "documents.write",
+      workspaceId: workspaceAlpha.id,
+    });
+    const role = makeRoleWithPermissions({
+      id: "role_editor",
+      name: "Editor",
+      workspaceId: workspaceAlpha.id,
+      permissions: [read],
+    });
+
+    const before = buildRolePermissionSnapshot({
+      roles: [role],
+      directPermissions: [],
+      reason: "before_role_edit",
+    });
+
+    role.permissions.push({ permission: write });
+
+    const after = buildRolePermissionSnapshot({
+      roles: [role],
+      directPermissions: [],
+      reason: "after_role_edit",
+    });
+
+    expect(before.effectivePermissionSlugs).toEqual(["documents.read"]);
+    expect(after.effectivePermissionSlugs).toEqual(["documents.read", "documents.write"]);
+  });
+
+  it("deduplicates a direct permission that also comes from a role", () => {
+    const read = makeDirectPermission({
+      id: "perm_read",
+      slug: "documents.read",
+      workspaceId: workspaceAlpha.id,
+    });
+    const role = makeRoleWithPermissions({
+      id: "role_reader",
+      name: "Reader",
+      workspaceId: workspaceAlpha.id,
+      permissions: [read],
+    });
+
+    const snapshot = buildRolePermissionSnapshot({
+      roles: [role],
+      directPermissions: [read],
+      reason: "dedupe",
+    });
+
+    expect(snapshot.effectivePermissionSlugs).toEqual(["documents.read"]);
+    expect(snapshot.directPermissionIds).toEqual(["perm_read"]);
+  });
+
+});
diff --git a/web/apps/dashboard/lib/trpc/routers/key/rbac/fixtures.ts b/web/apps/dashboard/lib/trpc/routers/key/rbac/fixtures.ts
new file mode 100644
index 000000000..f17c48a88
--- /dev/null
+++ b/web/apps/dashboard/lib/trpc/routers/key/rbac/fixtures.ts
@@ -0,0 +1,111 @@
+export const workspaceAlpha = {
+  id: "ws_alpha",
+  name: "Alpha Workspace",
+};
+
+export const workspaceBeta = {
+  id: "ws_beta",
+  name: "Beta Workspace",
+};
+
+export function makeKey(input: {
+  id: string;
+  name: string;
+  workspaceId: string;
+}) {
+  return {
+    id: input.id,
+    name: input.name,
+    workspaceId: input.workspaceId,
+    keyAuthId: `ka_${input.workspaceId}`,
+    deletedAtM: null,
+  };
+}
+
+export function makeRole(input: {
+  id: string;
+  name: string;
+  workspaceId: string;
+}) {
+  return {
+    id: input.id,
+    name: input.name,
+    workspaceId: input.workspaceId,
+  };
+}
+
+export function makeDirectPermission(input: {
+  id: string;
+  slug: string;
+  workspaceId: string;
+}) {
+  return {
+    id: input.id,
+    slug: input.slug,
+    workspaceId: input.workspaceId,
+  };
+}
+
+export function makeRoleWithPermissions(input: {
+  id: string;
+  name: string;
+  workspaceId: string;
+  permissions: Array<{
+    id: string;
+    slug: string;
+    workspaceId: string;
+  }>;
+}) {
+  return {
+    id: input.id,
+    name: input.name,
+    workspaceId: input.workspaceId,
+    permissions: input.permissions.map((permission) => ({
+      permission: {
+        id: permission.id,
+        slug: permission.slug,
+        workspaceId: permission.workspaceId,
+      },
+    })),
+  };
+}
+
+export const seedRoles = [
+  makeRoleWithPermissions({
+    id: "role_reader",
+    name: "Reader",
+    workspaceId: workspaceAlpha.id,
+    permissions: [
+      makeDirectPermission({
+        id: "perm_documents_read",
+        slug: "documents.read",
+        workspaceId: workspaceAlpha.id,
+      }),
+    ],
+  }),
+  makeRoleWithPermissions({
+    id: "role_writer",
+    name: "Writer",
+    workspaceId: workspaceAlpha.id,
+    permissions: [
+      makeDirectPermission({
+        id: "perm_documents_write",
+        slug: "documents.write",
+        workspaceId: workspaceAlpha.id,
+      }),
+    ],
+  }),
+  makeRoleWithPermissions({
+    id: "role_beta_admin",
+    name: "Admin",
+    workspaceId: workspaceBeta.id,
+    permissions: [
+      makeDirectPermission({
+        id: "perm_workspace_admin",
+        slug: "workspace.admin",
+        workspaceId: workspaceBeta.id,
+      }),
+    ],
+  }),
+];
```

## Intended Flaws

### Flaw 1: Role Expansion Is Not Workspace-Scoped

- `type`: `tenant_boundary_leak`
- `location`: `web/apps/dashboard/lib/trpc/routers/key/rbac/update-key-roles.ts:55-82`, `web/apps/dashboard/lib/trpc/routers/key/rbac/resolve-effective-permissions.ts:27-50`, `web/apps/dashboard/lib/trpc/routers/key/rbac/resolve-effective-permissions.ts:134-151`
- `learner_prompt`: Does the PR prove that every role assigned to a key belongs to the same workspace as the key?

Expected answer:

- `identify`: The key lookup is scoped to `ctx.workspace.id`, but role lookup is only `inArray(table.id, roleIds)`. The permission expansion query also selects roles by ID only. A caller who can supply or replay a role ID from another workspace can attach that role to a key in the current workspace, and role-derived permissions are read without a role workspace predicate.
- `impact`: This is a tenant boundary break in an authorization feature. A key in workspace A can receive permissions from workspace B. In systems with imported role IDs, predictable IDs, stale fixtures, or any ID disclosure through logs/audit/UI, this can grant cross-workspace capabilities. The data-plane verification path later trusts the join tables, so the bug becomes an actual permission grant, not only a dashboard display mistake.
- `fix_direction`: Validate roles through a workspace-scoped lookup: `and(eq(roles.workspaceId, workspaceId), inArray(roles.id, roleIds))`. When expanding permissions, join through workspace-owned rows and include workspace predicates on `roles`, `roles_permissions`, and `permissions`. Prefer database constraints that encode the same invariant, such as composite uniqueness/foreign-key semantics over `(workspace_id, role_id)` and `(workspace_id, permission_id)`, so future writers cannot bypass the service-layer guard.

Hints:

1. Start from the tenant boundary. The key is scoped; check whether the role and permission paths carry that same scope all the way through.
2. Compare the PR to Unkey's existing pattern: `web/apps/dashboard/lib/trpc/routers/key/rbac/update-rbac.ts` validates key, roles, and permissions against `ctx.workspace.id` before writing join rows.
3. In `update-key-roles.ts`, the role query uses only `inArray(table.id, uniqueRoleIds)`. In `resolve-effective-permissions.ts`, the role expansion query filters by role ID but not by workspace.

### Flaw 2: Role Permissions Are Materialized Into a Stale Key Snapshot

- `type`: `consistency_gap`
- `location`: `web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.ts:23-83`, `web/apps/dashboard/lib/trpc/routers/key/rbac/create-key-with-roles.ts:87-96`, `web/apps/dashboard/lib/trpc/routers/authorization/roles/upsert.ts:176-211`, `web/apps/dashboard/lib/trpc/routers/key/rbac/role-permission-snapshot.test.ts:24-55`
- `learner_prompt`: When a role changes after a key was created or updated, which permissions will that key verify with?

Expected answer:

- `identify`: The PR stores `permissionSlugs` in `key_role_permission_snapshots` at key create/update time and then reads that snapshot for verification. Role updates only audit that affected keys "keep" their existing permission count; they do not recompute affected key permissions, invalidate verification cache entries, or define immutable role snapshots as a product contract.
- `impact`: A role edit no longer changes existing keys. If an admin removes `workspace.admin` from a role during an incident, keys that already snapped that role still keep the permission. If an admin adds a required permission, existing keys may keep failing. Audit logs and the dashboard imply role-based access is dynamic, but the data plane uses stale materialized permissions. This is especially dangerous because Unkey caches loaded key data for verification.
- `fix_direction`: Choose one explicit contract. For normal RBAC, verify against current role-permission joins at read time and invalidate key verification caches when `keys_roles`, `keys_permissions`, or `roles_permissions` change. If immutable snapshots are desired, make them a named feature with versioned role grants, UI/audit language that says "snapshot as of version X", and an explicit resync/revoke path. Do not silently snapshot mutable roles.

Hints:

1. Ask whether "role" means a live permission bundle or a one-time copy of permissions.
2. Follow a permission from role creation to key verification. Does the code read the role-permission join table when the key is verified, or only when the key is changed?
3. The test named "does not change an old snapshot when the role object is edited later" is a smell: it locks in stale authorization behavior without explaining that as a product contract.

## Expert Debrief

### Product-Level Change

The PR is trying to make API-key access easier to manage by adding reusable roles. That is a strong product direction: large workspaces should not hand-edit identical permission lists across many keys.

The engineering risk is that RBAC is a contract, not a convenience feature. Assigning a role to a key changes who can do what, which workspace owns the grant, and whether future role edits affect existing keys.

### Changed Contracts

- Database contract: `keys_roles` and `key_role_permission_snapshots` become new authorization tables.
- Permission contract: a key's effective permissions now come from direct permissions plus assigned roles.
- Tenant contract: key, role, role-permission, and permission rows must all belong to the same workspace.
- Verification contract: role permissions must either be expanded live at verification/cache-fill time or captured as explicitly versioned snapshots.
- Audit contract: audit logs must describe whether a key is receiving current role permissions or an immutable copy.

### Failure Modes

- Cross-workspace role assignment grants a key permissions from another tenant.
- A leaked or replayed role ID becomes an authorization primitive.
- Removing a permission from a role does not revoke it from existing keys.
- Adding a permission to a role does not grant it to existing keys, causing confusing partial rollouts.
- Verification cache entries can keep stale permissions even longer if role updates do not publish invalidation events.
- Audit logs create false confidence by recording role changes without changing the permissions keys actually verify with.

### Reviewer Thought Process

A strong reviewer would not start by reading every line top to bottom. They would identify the contracts first:

1. What is the product-level claim? "Roles on API keys."
2. What data now decides authorization? `keys_roles`, `roles_permissions`, direct permissions, and possibly a snapshot table.
3. Where is tenant scope proven? Every lookup and write involving a key, role, or permission should include `ctx.workspace.id` or a database constraint that proves the same thing.
4. Are roles live or snapshots? The PR description says reusable roles, which usually means live bundles. The code stores permission slugs on the key, which means copy-on-write behavior.
5. What tests are missing? There is no negative test where a workspace A key attempts to attach a workspace B role, and no test proving a role permission removal revokes access for existing keys.

The thought-process difference is important: the expert is not merely spotting "missing workspaceId" as a pattern. They are asking what new authority the PR creates and where that authority is bounded.

### Better Implementation Direction

Use a workspace-scoped role assignment path:

- verify the key belongs to `ctx.workspace.id`,
- fetch roles with `and(eq(roles.workspaceId, workspaceId), inArray(roles.id, roleIds))`,
- fetch direct permissions with the same workspace predicate,
- write `keys_roles` and `keys_permissions` rows with workspace ID,
- enforce the invariant in schema constraints where possible,
- expand effective permissions from current joins in the verification/cache-fill query,
- invalidate key verification cache entries when role-permission or key-role joins change.

If the product really wants immutable permission bundles, design that explicitly as versioned role grants. The UI, audit log, and verification data should say "key has role version 12" rather than pretending the key follows a mutable role.

## Correctness Verdict Rubric

- Full credit for flaw 1: The answer says role assignment or expansion is not workspace-scoped, cites the role lookup or expansion query, explains cross-workspace authorization impact, and proposes workspace-scoped validation plus database-backed invariants.
- Partial credit for flaw 1: The answer notices a missing workspace filter but frames it only as a display bug or does not connect it to key verification.
- No credit for flaw 1: The answer focuses on style, role naming, or deduplication without identifying the tenant boundary.

- Full credit for flaw 2: The answer says role permissions are copied into a stale key snapshot, explains that future role edits do not affect existing keys, mentions revocation/addition failure and cache semantics, and proposes live expansion with invalidation or explicit versioned snapshots.
- Partial credit for flaw 2: The answer notices stale data but does not distinguish mutable RBAC from immutable snapshots.
- No credit for flaw 2: The answer treats the snapshot as an optimization detail without explaining the authorization contract change.

## Golden Answer Summary

The PR creates two authorization bugs. First, it scopes the key to the current workspace but not the role lookup or role-permission expansion, so a key can receive another workspace's role-derived permissions. Second, it materializes role permissions into a key snapshot at create/update time while presenting roles as mutable RBAC, so existing keys do not reflect role edits and revocations can fail. A correct implementation would scope every key/role/permission read and write by workspace and either expand role permissions live with cache invalidation or explicitly model immutable, versioned role snapshots.
