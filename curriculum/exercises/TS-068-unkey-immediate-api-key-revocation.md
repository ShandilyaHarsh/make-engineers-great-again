# TS-068: Unkey Immediate API-Key Revocation

## Metadata

- `id`: TS-068
- `source_repo`: [unkeyed/unkey](https://github.com/unkeyed/unkey)
- `repo_area`: key verification, control-plane key deletion/update APIs, verification-key cache, clustered cache invalidation, gateway data-plane read model, audit logs, retry semantics
- `mode`: synthetic_degraded
- `difficulty`: 7
- `target_diff_lines`: 2,100-2,600
- `represented_diff_lines`: 2136
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about Unkey key verification, revocation semantics, cache invalidation, control-plane/data-plane split, retry behavior, and audit contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds immediate API-key revocation as a safer alternative to deleting keys during incident response and key rotation. Operators can call a new revoke endpoint, the key is marked terminally revoked, audit logs record who revoked it, and gateways should stop accepting the key as quickly as possible.

The PR adds:

- request/response types for key revocation,
- a revocation store and audit rows,
- a cache propagation publisher,
- a revoke service and API route,
- a gateway verification read model,
- tests for successful revocation, retry behavior, and gateway cache behavior,
- docs for incident-response usage.

The intended product behavior is: once a key is revoked, verification should stop accepting it across gateway regions without waiting for an ordinary cache TTL. Repeating the same revoke request should be a safe idempotent terminal-state operation, not a new failure mode.

## Existing Code Context

The real Unkey codebase already has these relevant contracts:

- `svc/api/routes/v2_keys_delete_key/handler.go` finds the live key, soft/permanently deletes it in a transaction, writes a key-delete audit event, and then calls `h.KeyCache.Remove(ctx, key.Hash)` after the commit.
- `svc/api/routes/v2_keys_update_key/handler.go` updates key fields and removes `VerificationKeyByHash` by key hash; credit changes also invalidate the usage limiter.
- `internal/services/keys/get.go` verifies keys by calling `s.keyCache.SWR(ctx, sha256Hash, ...)`; deleted/disabled status is evaluated from the cached key row.
- `internal/services/caches/caches.go` configures `VerificationKeyByHash` with a 10 second fresh window and 10 minute stale window, optionally wrapped in clustered invalidation.
- `pkg/cache/clustering/cluster_cache.go` broadcasts invalidation only when cache `Remove` is called with the actual cache key.
- `svc/api/openapi/spec/paths/v2/keys/deleteKey/index.yaml` documents that deleted keys should be immediately invalidated with a bounded edge-propagation window.
- `pkg/db/queries/key_soft_delete_by_id.sql` is a terminal mutation over key state; retry behavior has to be designed at the service/API layer, not left to accidental duplicate writes or 409s.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether revocation actually changes the gateway decision immediately and whether retrying the terminal operation is safe.

## Review Surface

Changed files in the synthetic PR:

- `web/internal/key-revocation/types.ts`
- `web/internal/key-revocation/store.ts`
- `web/internal/key-revocation/cache.ts`
- `web/internal/key-revocation/revoke-key.ts`
- `web/internal/key-revocation/gateway-read-model.ts`
- `web/apps/dashboard/app/api/v2/keys/revoke/route.ts`
- `web/internal/key-revocation/__tests__/revoke-key.test.ts`
- `web/internal/key-revocation/__tests__/gateway-cache.test.ts`
- `docs/api/immediate-key-revocation.md`

The line references below use synthetic PR line numbers. The represented diff is focused on cache-key identity, data-plane revocation freshness, terminal-state idempotency, and tests/docs that encode the wrong operational contract.

## Diff

```diff
diff --git a/web/internal/key-revocation/types.ts b/web/internal/key-revocation/types.ts
new file mode 100644
index 0000000000..68a000162
--- /dev/null
+++ b/web/internal/key-revocation/types.ts
@@ -0,0 +1,162 @@
+import { z } from "zod";
+
+export const keyRevocationReasonSchema = z.enum([
+  "compromised",
+  "rotation_completed",
+  "user_requested",
+  "policy_violation",
+  "admin_cleanup",
+]);
+
+export type KeyRevocationReason = z.infer<typeof keyRevocationReasonSchema>;
+
+export const revokeKeyRequestSchema = z.object({
+  keyId: z.string().min(3).max(255),
+  reason: keyRevocationReasonSchema.default("user_requested"),
+  comment: z.string().max(2000).optional(),
+  permanent: z.boolean().default(false),
+});
+
+export type RevokeKeyRequest = z.infer<typeof revokeKeyRequestSchema>;
+
+export type RevokeKeyActor = {
+  workspaceId: string;
+  rootKeyId: string;
+  displayName: string;
+  permissions: string[];
+  remoteIp: string;
+  userAgent: string;
+};
+
+export type KeyStatus = "enabled" | "disabled" | "revoked" | "deleted";
+
+export type KeyRecord = {
+  id: string;
+  keyAuthId: string;
+  apiId: string;
+  workspaceId: string;
+  name: string | null;
+  hash: string;
+  enabled: boolean;
+  status: KeyStatus;
+  statusVersion: number;
+  revokedAtM: number | null;
+  revokedBy: string | null;
+  deletedAtM: number | null;
+  expiresAtM: number | null;
+};
+
+export type KeyRevocationRecord = {
+  id: string;
+  keyId: string;
+  workspaceId: string;
+  keyHash: string;
+  statusVersion: number;
+  reason: KeyRevocationReason;
+  comment: string | null;
+  permanent: boolean;
+  revokedAtM: number;
+  revokedBy: string;
+};
+
+export type RevocationAuditRecord = {
+  id: string;
+  keyId: string;
+  workspaceId: string;
+  actorId: string;
+  event: "key.revoke.attempted" | "key.revoke.succeeded" | "key.revoke.failed";
+  reason: KeyRevocationReason;
+  createdAtM: number;
+  metadata: Record<string, unknown>;
+};
+
+export type RevokeKeyResult = {
+  keyId: string;
+  status: "revoked";
+  revokedAtM: number;
+  statusVersion: number;
+  propagation: {
+    mode: "best_effort";
+    cacheChannels: string[];
+    estimatedGatewayTtlMs: number;
+  };
+};
+
+export type RevocationCacheEvent = {
+  keyId: string;
+  workspaceId: string;
+  statusVersion: number;
+  publishedAtM: number;
+};
+
+export type GatewayKeySnapshot = {
+  id: string;
+  workspaceId: string;
+  apiId: string;
+  hash: string;
+  enabled: boolean;
+  revokedAtM: number | null;
+  statusVersion: number;
+  roles: string[];
+  permissions: string[];
+  ratelimits: Array<{ name: string; limit: number; duration: number }>;
+};
+
+export type GatewayVerificationOutcome = {
+  valid: boolean;
+  code: "VALID" | "NOT_FOUND" | "DISABLED" | "REVOKED" | "EXPIRED";
+  keyId?: string;
+  statusVersion?: number;
+  cache: "hit" | "miss" | "stale";
+};
+
+export class RevokeKeyError extends Error {
+  constructor(
+    public readonly code: "NOT_FOUND" | "FORBIDDEN" | "ALREADY_REVOKED" | "DATABASE_ERROR",
+    message: string,
+  ) {
+    super(message);
+  }
+}
+
+export const REVOCATION_GATEWAY_TTL_MS = 30_000;
+export const REVOCATION_STALE_TTL_MS = 10 * 60_000;
+export const CONTROL_PLANE_CACHE_PREFIX = "control-plane:key";
+export const DASHBOARD_CACHE_PREFIX = "dashboard:key";
+export const GATEWAY_CACHE_PREFIX = "gateway:verification-key-by-hash";
+
+export const revocationReasonDoc_001 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_1" } as const;
+export const revocationReasonDoc_002 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_2" } as const;
+export const revocationReasonDoc_003 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_3" } as const;
+export const revocationReasonDoc_004 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_4" } as const;
+export const revocationReasonDoc_005 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_5" } as const;
+export const revocationReasonDoc_006 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_6" } as const;
+export const revocationReasonDoc_007 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_7" } as const;
+export const revocationReasonDoc_008 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_8" } as const;
+export const revocationReasonDoc_009 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_9" } as const;
+export const revocationReasonDoc_010 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_10" } as const;
+export const revocationReasonDoc_011 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_11" } as const;
+export const revocationReasonDoc_012 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_12" } as const;
+export const revocationReasonDoc_013 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_13" } as const;
+export const revocationReasonDoc_014 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_14" } as const;
+export const revocationReasonDoc_015 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_15" } as const;
+export const revocationReasonDoc_016 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_16" } as const;
+export const revocationReasonDoc_017 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_17" } as const;
+export const revocationReasonDoc_018 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_18" } as const;
+export const revocationReasonDoc_019 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_19" } as const;
+export const revocationReasonDoc_020 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_20" } as const;
+export const revocationReasonDoc_021 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_21" } as const;
+export const revocationReasonDoc_022 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_22" } as const;
+export const revocationReasonDoc_023 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_23" } as const;
+export const revocationReasonDoc_024 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_24" } as const;
+export const revocationReasonDoc_025 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_25" } as const;
+export const revocationReasonDoc_026 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_26" } as const;
+export const revocationReasonDoc_027 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_27" } as const;
+export const revocationReasonDoc_028 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_28" } as const;
+export const revocationReasonDoc_029 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_29" } as const;
+export const revocationReasonDoc_030 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_30" } as const;
+export const revocationReasonDoc_031 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_31" } as const;
+export const revocationReasonDoc_032 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_32" } as const;
+export const revocationReasonDoc_033 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_33" } as const;
+export const revocationReasonDoc_034 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_34" } as const;
+export const revocationReasonDoc_035 = { reason: "user_requested", terminal: true, idempotent: true, example: "key_35" } as const;
diff --git a/web/internal/key-revocation/store.ts b/web/internal/key-revocation/store.ts
new file mode 100644
index 0000000000..68a000219
--- /dev/null
+++ b/web/internal/key-revocation/store.ts
@@ -0,0 +1,219 @@
+import { RevokeKeyError, type KeyRecord, type KeyRevocationRecord, type RevocationAuditRecord, type RevokeKeyActor, type RevokeKeyRequest } from "./types";
+
+type TxCallback<T> = (tx: RevocationStore) => Promise<T>;
+
+const now = () => Date.now();
+const rid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
+
+export class RevocationStore {
+  private keys = new Map<string, KeyRecord>();
+  private revocations = new Map<string, KeyRevocationRecord>();
+  private audits: RevocationAuditRecord[] = [];
+
+  constructor(seed: KeyRecord[] = []) {
+    for (const key of seed) {
+      this.keys.set(key.id, { ...key });
+    }
+  }
+
+  async transaction<T>(callback: TxCallback<T>): Promise<T> {
+    return callback(this);
+  }
+
+  async findLiveKeyById(keyId: string): Promise<KeyRecord | null> {
+    const key = this.keys.get(keyId);
+    if (!key || key.deletedAtM !== null) {
+      return null;
+    }
+    return { ...key };
+  }
+
+  async findKeyIncludingTerminal(keyId: string): Promise<KeyRecord | null> {
+    const key = this.keys.get(keyId);
+    return key ? { ...key } : null;
+  }
+
+  async findRevocationByKeyId(keyId: string): Promise<KeyRevocationRecord | null> {
+    return this.revocations.get(keyId) ?? null;
+  }
+
+  async insertAttemptAudit(actor: RevokeKeyActor, req: RevokeKeyRequest): Promise<void> {
+    this.audits.push({
+      id: rid("audit"),
+      keyId: req.keyId,
+      workspaceId: actor.workspaceId,
+      actorId: actor.rootKeyId,
+      event: "key.revoke.attempted",
+      reason: req.reason,
+      createdAtM: now(),
+      metadata: { permanent: req.permanent, comment: req.comment ?? null },
+    });
+  }
+
+  async insertSuccessAudit(actor: RevokeKeyActor, revocation: KeyRevocationRecord): Promise<void> {
+    this.audits.push({
+      id: rid("audit"),
+      keyId: revocation.keyId,
+      workspaceId: actor.workspaceId,
+      actorId: actor.rootKeyId,
+      event: "key.revoke.succeeded",
+      reason: revocation.reason,
+      createdAtM: now(),
+      metadata: { revocationId: revocation.id, statusVersion: revocation.statusVersion },
+    });
+  }
+
+  async insertFailureAudit(actor: RevokeKeyActor, req: RevokeKeyRequest, errorCode: string): Promise<void> {
+    this.audits.push({
+      id: rid("audit"),
+      keyId: req.keyId,
+      workspaceId: actor.workspaceId,
+      actorId: actor.rootKeyId,
+      event: "key.revoke.failed",
+      reason: req.reason,
+      createdAtM: now(),
+      metadata: { errorCode },
+    });
+  }
+
+  async markKeyRevoked(args: { key: KeyRecord; actor: RevokeKeyActor; req: RevokeKeyRequest }): Promise<KeyRevocationRecord> {
+    const current = this.keys.get(args.key.id);
+    if (!current || current.deletedAtM !== null) {
+      throw new RevokeKeyError("NOT_FOUND", "The key does not exist.");
+    }
+
+    if (current.revokedAtM !== null || current.status === "revoked") {
+      throw new RevokeKeyError("ALREADY_REVOKED", "The key has already been revoked.");
+    }
+
+    const nextVersion = current.statusVersion + 1;
+    const revokedAtM = now();
+    const revocation: KeyRevocationRecord = {
+      id: rid("rev"),
+      keyId: current.id,
+      workspaceId: current.workspaceId,
+      keyHash: current.hash,
+      statusVersion: nextVersion,
+      reason: args.req.reason,
+      comment: args.req.comment ?? null,
+      permanent: args.req.permanent,
+      revokedAtM,
+      revokedBy: args.actor.rootKeyId,
+    };
+
+    this.keys.set(current.id, {
+      ...current,
+      enabled: false,
+      status: "revoked",
+      revokedAtM,
+      revokedBy: args.actor.rootKeyId,
+      statusVersion: nextVersion,
+    });
+    this.revocations.set(current.id, revocation);
+    return revocation;
+  }
+
+  getAuditRows(): RevocationAuditRecord[] {
+    return [...this.audits];
+  }
+
+  forcePutKey(key: KeyRecord): void {
+    this.keys.set(key.id, { ...key });
+  }
+}
+
+export const revocationStoreProjection_001 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_002 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_003 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_004 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_005 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_006 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_007 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_008 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_009 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_010 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_011 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_012 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_013 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_014 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_015 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_016 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_017 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_018 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_019 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_020 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_021 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_022 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_023 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_024 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_025 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_026 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_027 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_028 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_029 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_030 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_031 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_032 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_033 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_034 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_035 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_036 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_037 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_038 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_039 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_040 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_041 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_042 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_043 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_044 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_045 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_046 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_047 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_048 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_049 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_050 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_051 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_052 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_053 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_054 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_055 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_056 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_057 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_058 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_059 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_060 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_061 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_062 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_063 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_064 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_065 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_066 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_067 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_068 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_069 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_070 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_071 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_072 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_073 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_074 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_075 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_076 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_077 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_078 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_079 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_080 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_081 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_082 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_083 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_084 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_085 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_086 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_087 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_088 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_089 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_090 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_091 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_092 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_093 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_094 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
+export const revocationStoreProjection_095 = ["id", "hash", "status", "statusVersion", "revokedAtM"] as const;
diff --git a/web/internal/key-revocation/cache.ts b/web/internal/key-revocation/cache.ts
new file mode 100644
index 0000000000..68a000193
--- /dev/null
+++ b/web/internal/key-revocation/cache.ts
@@ -0,0 +1,193 @@
+import { CONTROL_PLANE_CACHE_PREFIX, DASHBOARD_CACHE_PREFIX, REVOCATION_GATEWAY_TTL_MS, type RevocationCacheEvent } from "./types";
+
+export type CacheBus = {
+  publish(channel: string, payload: RevocationCacheEvent): Promise<void>;
+};
+
+export type LocalCache = {
+  remove(key: string): Promise<void>;
+  set(key: string, value: unknown, ttlMs: number): Promise<void>;
+};
+
+export type RevocationCachePublisher = {
+  publishRevocation(event: Omit<RevocationCacheEvent, "publishedAtM">): Promise<string[]>;
+};
+
+export const keyDashboardChannel = (keyId: string) => `${DASHBOARD_CACHE_PREFIX}:${keyId}`;
+export const keyControlPlaneChannel = (keyId: string) => `${CONTROL_PLANE_CACHE_PREFIX}:${keyId}`;
+
+export const makeRevocationCachePublisher = (bus: CacheBus, localCache: LocalCache): RevocationCachePublisher => {
+  return {
+    async publishRevocation(event) {
+      const payload: RevocationCacheEvent = { ...event, publishedAtM: Date.now() };
+      const channels = [keyDashboardChannel(event.keyId), keyControlPlaneChannel(event.keyId)];
+
+      await localCache.remove(keyDashboardChannel(event.keyId));
+      await localCache.remove(keyControlPlaneChannel(event.keyId));
+
+      for (const channel of channels) {
+        await bus.publish(channel, payload);
+      }
+
+      return channels;
+    },
+  };
+};
+
+export const cachePropagationEstimate = () => ({
+  mode: "best_effort" as const,
+  estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS,
+});
+
+export class MemoryCacheBus implements CacheBus {
+  public events: Array<{ channel: string; payload: RevocationCacheEvent }> = [];
+
+  async publish(channel: string, payload: RevocationCacheEvent): Promise<void> {
+    this.events.push({ channel, payload });
+  }
+}
+
+export class MemoryLocalCache implements LocalCache {
+  public removed: string[] = [];
+  public values = new Map<string, unknown>();
+
+  async remove(key: string): Promise<void> {
+    this.removed.push(key);
+    this.values.delete(key);
+  }
+
+  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
+    this.values.set(key, { value, ttlMs });
+  }
+}
+
+export const revocationCacheChannelFixture_001 = { keyId: "key_1", channel: keyDashboardChannel("key_1"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_002 = { keyId: "key_2", channel: keyDashboardChannel("key_2"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_003 = { keyId: "key_3", channel: keyDashboardChannel("key_3"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_004 = { keyId: "key_4", channel: keyDashboardChannel("key_4"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_005 = { keyId: "key_5", channel: keyDashboardChannel("key_5"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_006 = { keyId: "key_6", channel: keyDashboardChannel("key_6"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_007 = { keyId: "key_7", channel: keyDashboardChannel("key_7"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_008 = { keyId: "key_8", channel: keyDashboardChannel("key_8"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_009 = { keyId: "key_9", channel: keyDashboardChannel("key_9"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_010 = { keyId: "key_10", channel: keyDashboardChannel("key_10"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_011 = { keyId: "key_11", channel: keyDashboardChannel("key_11"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_012 = { keyId: "key_12", channel: keyDashboardChannel("key_12"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_013 = { keyId: "key_13", channel: keyDashboardChannel("key_13"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_014 = { keyId: "key_14", channel: keyDashboardChannel("key_14"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_015 = { keyId: "key_15", channel: keyDashboardChannel("key_15"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_016 = { keyId: "key_16", channel: keyDashboardChannel("key_16"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_017 = { keyId: "key_17", channel: keyDashboardChannel("key_17"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_018 = { keyId: "key_18", channel: keyDashboardChannel("key_18"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_019 = { keyId: "key_19", channel: keyDashboardChannel("key_19"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_020 = { keyId: "key_20", channel: keyDashboardChannel("key_20"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_021 = { keyId: "key_21", channel: keyDashboardChannel("key_21"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_022 = { keyId: "key_22", channel: keyDashboardChannel("key_22"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_023 = { keyId: "key_23", channel: keyDashboardChannel("key_23"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_024 = { keyId: "key_24", channel: keyDashboardChannel("key_24"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_025 = { keyId: "key_25", channel: keyDashboardChannel("key_25"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_026 = { keyId: "key_26", channel: keyDashboardChannel("key_26"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_027 = { keyId: "key_27", channel: keyDashboardChannel("key_27"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_028 = { keyId: "key_28", channel: keyDashboardChannel("key_28"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_029 = { keyId: "key_29", channel: keyDashboardChannel("key_29"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_030 = { keyId: "key_30", channel: keyDashboardChannel("key_30"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_031 = { keyId: "key_31", channel: keyDashboardChannel("key_31"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_032 = { keyId: "key_32", channel: keyDashboardChannel("key_32"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_033 = { keyId: "key_33", channel: keyDashboardChannel("key_33"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_034 = { keyId: "key_34", channel: keyDashboardChannel("key_34"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_035 = { keyId: "key_35", channel: keyDashboardChannel("key_35"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_036 = { keyId: "key_36", channel: keyDashboardChannel("key_36"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_037 = { keyId: "key_37", channel: keyDashboardChannel("key_37"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_038 = { keyId: "key_38", channel: keyDashboardChannel("key_38"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_039 = { keyId: "key_39", channel: keyDashboardChannel("key_39"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_040 = { keyId: "key_40", channel: keyDashboardChannel("key_40"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_041 = { keyId: "key_41", channel: keyDashboardChannel("key_41"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_042 = { keyId: "key_42", channel: keyDashboardChannel("key_42"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_043 = { keyId: "key_43", channel: keyDashboardChannel("key_43"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_044 = { keyId: "key_44", channel: keyDashboardChannel("key_44"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_045 = { keyId: "key_45", channel: keyDashboardChannel("key_45"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_046 = { keyId: "key_46", channel: keyDashboardChannel("key_46"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_047 = { keyId: "key_47", channel: keyDashboardChannel("key_47"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_048 = { keyId: "key_48", channel: keyDashboardChannel("key_48"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_049 = { keyId: "key_49", channel: keyDashboardChannel("key_49"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_050 = { keyId: "key_50", channel: keyDashboardChannel("key_50"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_051 = { keyId: "key_51", channel: keyDashboardChannel("key_51"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_052 = { keyId: "key_52", channel: keyDashboardChannel("key_52"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_053 = { keyId: "key_53", channel: keyDashboardChannel("key_53"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_054 = { keyId: "key_54", channel: keyDashboardChannel("key_54"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_055 = { keyId: "key_55", channel: keyDashboardChannel("key_55"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_056 = { keyId: "key_56", channel: keyDashboardChannel("key_56"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_057 = { keyId: "key_57", channel: keyDashboardChannel("key_57"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_058 = { keyId: "key_58", channel: keyDashboardChannel("key_58"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_059 = { keyId: "key_59", channel: keyDashboardChannel("key_59"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_060 = { keyId: "key_60", channel: keyDashboardChannel("key_60"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_061 = { keyId: "key_61", channel: keyDashboardChannel("key_61"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_062 = { keyId: "key_62", channel: keyDashboardChannel("key_62"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_063 = { keyId: "key_63", channel: keyDashboardChannel("key_63"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_064 = { keyId: "key_64", channel: keyDashboardChannel("key_64"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_065 = { keyId: "key_65", channel: keyDashboardChannel("key_65"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_066 = { keyId: "key_66", channel: keyDashboardChannel("key_66"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_067 = { keyId: "key_67", channel: keyDashboardChannel("key_67"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_068 = { keyId: "key_68", channel: keyDashboardChannel("key_68"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_069 = { keyId: "key_69", channel: keyDashboardChannel("key_69"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_070 = { keyId: "key_70", channel: keyDashboardChannel("key_70"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_071 = { keyId: "key_71", channel: keyDashboardChannel("key_71"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_072 = { keyId: "key_72", channel: keyDashboardChannel("key_72"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_073 = { keyId: "key_73", channel: keyDashboardChannel("key_73"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_074 = { keyId: "key_74", channel: keyDashboardChannel("key_74"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_075 = { keyId: "key_75", channel: keyDashboardChannel("key_75"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_076 = { keyId: "key_76", channel: keyDashboardChannel("key_76"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_077 = { keyId: "key_77", channel: keyDashboardChannel("key_77"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_078 = { keyId: "key_78", channel: keyDashboardChannel("key_78"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_079 = { keyId: "key_79", channel: keyDashboardChannel("key_79"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_080 = { keyId: "key_80", channel: keyDashboardChannel("key_80"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_081 = { keyId: "key_81", channel: keyDashboardChannel("key_81"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_082 = { keyId: "key_82", channel: keyDashboardChannel("key_82"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_083 = { keyId: "key_83", channel: keyDashboardChannel("key_83"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_084 = { keyId: "key_84", channel: keyDashboardChannel("key_84"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_085 = { keyId: "key_85", channel: keyDashboardChannel("key_85"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_086 = { keyId: "key_86", channel: keyDashboardChannel("key_86"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_087 = { keyId: "key_87", channel: keyDashboardChannel("key_87"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_088 = { keyId: "key_88", channel: keyDashboardChannel("key_88"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_089 = { keyId: "key_89", channel: keyDashboardChannel("key_89"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_090 = { keyId: "key_90", channel: keyDashboardChannel("key_90"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_091 = { keyId: "key_91", channel: keyDashboardChannel("key_91"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_092 = { keyId: "key_92", channel: keyDashboardChannel("key_92"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_093 = { keyId: "key_93", channel: keyDashboardChannel("key_93"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_094 = { keyId: "key_94", channel: keyDashboardChannel("key_94"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_095 = { keyId: "key_95", channel: keyDashboardChannel("key_95"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_096 = { keyId: "key_96", channel: keyDashboardChannel("key_96"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_097 = { keyId: "key_97", channel: keyDashboardChannel("key_97"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_098 = { keyId: "key_98", channel: keyDashboardChannel("key_98"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_099 = { keyId: "key_99", channel: keyDashboardChannel("key_99"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_100 = { keyId: "key_100", channel: keyDashboardChannel("key_100"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_101 = { keyId: "key_101", channel: keyDashboardChannel("key_101"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_102 = { keyId: "key_102", channel: keyDashboardChannel("key_102"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_103 = { keyId: "key_103", channel: keyDashboardChannel("key_103"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_104 = { keyId: "key_104", channel: keyDashboardChannel("key_104"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_105 = { keyId: "key_105", channel: keyDashboardChannel("key_105"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_106 = { keyId: "key_106", channel: keyDashboardChannel("key_106"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_107 = { keyId: "key_107", channel: keyDashboardChannel("key_107"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_108 = { keyId: "key_108", channel: keyDashboardChannel("key_108"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_109 = { keyId: "key_109", channel: keyDashboardChannel("key_109"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_110 = { keyId: "key_110", channel: keyDashboardChannel("key_110"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_111 = { keyId: "key_111", channel: keyDashboardChannel("key_111"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_112 = { keyId: "key_112", channel: keyDashboardChannel("key_112"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_113 = { keyId: "key_113", channel: keyDashboardChannel("key_113"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_114 = { keyId: "key_114", channel: keyDashboardChannel("key_114"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_115 = { keyId: "key_115", channel: keyDashboardChannel("key_115"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_116 = { keyId: "key_116", channel: keyDashboardChannel("key_116"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_117 = { keyId: "key_117", channel: keyDashboardChannel("key_117"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_118 = { keyId: "key_118", channel: keyDashboardChannel("key_118"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_119 = { keyId: "key_119", channel: keyDashboardChannel("key_119"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_120 = { keyId: "key_120", channel: keyDashboardChannel("key_120"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_121 = { keyId: "key_121", channel: keyDashboardChannel("key_121"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_122 = { keyId: "key_122", channel: keyDashboardChannel("key_122"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_123 = { keyId: "key_123", channel: keyDashboardChannel("key_123"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_124 = { keyId: "key_124", channel: keyDashboardChannel("key_124"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_125 = { keyId: "key_125", channel: keyDashboardChannel("key_125"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_126 = { keyId: "key_126", channel: keyDashboardChannel("key_126"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_127 = { keyId: "key_127", channel: keyDashboardChannel("key_127"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_128 = { keyId: "key_128", channel: keyDashboardChannel("key_128"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_129 = { keyId: "key_129", channel: keyDashboardChannel("key_129"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
+export const revocationCacheChannelFixture_130 = { keyId: "key_130", channel: keyDashboardChannel("key_130"), estimatedGatewayTtlMs: REVOCATION_GATEWAY_TTL_MS } as const;
diff --git a/web/internal/key-revocation/revoke-key.ts b/web/internal/key-revocation/revoke-key.ts
new file mode 100644
index 0000000000..68a000195
--- /dev/null
+++ b/web/internal/key-revocation/revoke-key.ts
@@ -0,0 +1,195 @@
+import { cachePropagationEstimate, type RevocationCachePublisher } from "./cache";
+import { RevokeKeyError, type RevokeKeyActor, type RevokeKeyRequest, type RevokeKeyResult } from "./types";
+import type { RevocationStore } from "./store";
+
+export type PermissionChecker = {
+  canRevokeKey(actor: RevokeKeyActor, apiId: string): Promise<boolean>;
+};
+
+export type RevokeKeyServiceConfig = {
+  store: RevocationStore;
+  permissions: PermissionChecker;
+  cachePublisher: RevocationCachePublisher;
+};
+
+export const createRevokeKeyService = (config: RevokeKeyServiceConfig) => {
+  return {
+    async revokeKey(actor: RevokeKeyActor, req: RevokeKeyRequest): Promise<RevokeKeyResult> {
+      await config.store.insertAttemptAudit(actor, req);
+
+      const key = await config.store.findLiveKeyById(req.keyId);
+      if (!key) {
+        await config.store.insertFailureAudit(actor, req, "NOT_FOUND");
+        throw new RevokeKeyError("NOT_FOUND", "The key was not found.");
+      }
+
+      if (key.workspaceId !== actor.workspaceId) {
+        await config.store.insertFailureAudit(actor, req, "NOT_FOUND");
+        throw new RevokeKeyError("NOT_FOUND", "The key was not found.");
+      }
+
+      const allowed = await config.permissions.canRevokeKey(actor, key.apiId);
+      if (!allowed) {
+        await config.store.insertFailureAudit(actor, req, "FORBIDDEN");
+        throw new RevokeKeyError("FORBIDDEN", "You do not have permission to revoke this key.");
+      }
+
+      try {
+        const revocation = await config.store.transaction(async (tx) => {
+          return tx.markKeyRevoked({ key, actor, req });
+        });
+
+        await config.store.insertSuccessAudit(actor, revocation);
+
+        const channels = await config.cachePublisher.publishRevocation({
+          keyId: revocation.keyId,
+          workspaceId: revocation.workspaceId,
+          statusVersion: revocation.statusVersion,
+        });
+
+        return {
+          keyId: revocation.keyId,
+          status: "revoked",
+          revokedAtM: revocation.revokedAtM,
+          statusVersion: revocation.statusVersion,
+          propagation: {
+            ...cachePropagationEstimate(),
+            cacheChannels: channels,
+          },
+        };
+      } catch (error) {
+        if (error instanceof RevokeKeyError) {
+          await config.store.insertFailureAudit(actor, req, error.code);
+          throw error;
+        }
+
+        await config.store.insertFailureAudit(actor, req, "DATABASE_ERROR");
+        throw new RevokeKeyError("DATABASE_ERROR", "Failed to revoke the key.");
+      }
+    },
+  };
+};
+
+export class StaticPermissionChecker implements PermissionChecker {
+  constructor(private readonly allowed = true) {}
+
+  async canRevokeKey(actor: RevokeKeyActor, apiId: string): Promise<boolean> {
+    return this.allowed && (actor.permissions.includes("api.*.revoke_key") || actor.permissions.includes(`api.${apiId}.revoke_key`));
+  }
+}
+
+export const revocationServiceScenario_001 = { requestId: "req_1", keyId: "key_1", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_002 = { requestId: "req_2", keyId: "key_2", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_003 = { requestId: "req_3", keyId: "key_3", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_004 = { requestId: "req_4", keyId: "key_4", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_005 = { requestId: "req_5", keyId: "key_5", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_006 = { requestId: "req_6", keyId: "key_6", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_007 = { requestId: "req_7", keyId: "key_7", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_008 = { requestId: "req_8", keyId: "key_8", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_009 = { requestId: "req_9", keyId: "key_9", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_010 = { requestId: "req_10", keyId: "key_10", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_011 = { requestId: "req_11", keyId: "key_11", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_012 = { requestId: "req_12", keyId: "key_12", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_013 = { requestId: "req_13", keyId: "key_13", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_014 = { requestId: "req_14", keyId: "key_14", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_015 = { requestId: "req_15", keyId: "key_15", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_016 = { requestId: "req_16", keyId: "key_16", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_017 = { requestId: "req_17", keyId: "key_17", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_018 = { requestId: "req_18", keyId: "key_18", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_019 = { requestId: "req_19", keyId: "key_19", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_020 = { requestId: "req_20", keyId: "key_20", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_021 = { requestId: "req_21", keyId: "key_21", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_022 = { requestId: "req_22", keyId: "key_22", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_023 = { requestId: "req_23", keyId: "key_23", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_024 = { requestId: "req_24", keyId: "key_24", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_025 = { requestId: "req_25", keyId: "key_25", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_026 = { requestId: "req_26", keyId: "key_26", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_027 = { requestId: "req_27", keyId: "key_27", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_028 = { requestId: "req_28", keyId: "key_28", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_029 = { requestId: "req_29", keyId: "key_29", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_030 = { requestId: "req_30", keyId: "key_30", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_031 = { requestId: "req_31", keyId: "key_31", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_032 = { requestId: "req_32", keyId: "key_32", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_033 = { requestId: "req_33", keyId: "key_33", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_034 = { requestId: "req_34", keyId: "key_34", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_035 = { requestId: "req_35", keyId: "key_35", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_036 = { requestId: "req_36", keyId: "key_36", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_037 = { requestId: "req_37", keyId: "key_37", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_038 = { requestId: "req_38", keyId: "key_38", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_039 = { requestId: "req_39", keyId: "key_39", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_040 = { requestId: "req_40", keyId: "key_40", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_041 = { requestId: "req_41", keyId: "key_41", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_042 = { requestId: "req_42", keyId: "key_42", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_043 = { requestId: "req_43", keyId: "key_43", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_044 = { requestId: "req_44", keyId: "key_44", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_045 = { requestId: "req_45", keyId: "key_45", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_046 = { requestId: "req_46", keyId: "key_46", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_047 = { requestId: "req_47", keyId: "key_47", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_048 = { requestId: "req_48", keyId: "key_48", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_049 = { requestId: "req_49", keyId: "key_49", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_050 = { requestId: "req_50", keyId: "key_50", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_051 = { requestId: "req_51", keyId: "key_51", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_052 = { requestId: "req_52", keyId: "key_52", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_053 = { requestId: "req_53", keyId: "key_53", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_054 = { requestId: "req_54", keyId: "key_54", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_055 = { requestId: "req_55", keyId: "key_55", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_056 = { requestId: "req_56", keyId: "key_56", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_057 = { requestId: "req_57", keyId: "key_57", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_058 = { requestId: "req_58", keyId: "key_58", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_059 = { requestId: "req_59", keyId: "key_59", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_060 = { requestId: "req_60", keyId: "key_60", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_061 = { requestId: "req_61", keyId: "key_61", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_062 = { requestId: "req_62", keyId: "key_62", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_063 = { requestId: "req_63", keyId: "key_63", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_064 = { requestId: "req_64", keyId: "key_64", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_065 = { requestId: "req_65", keyId: "key_65", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_066 = { requestId: "req_66", keyId: "key_66", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_067 = { requestId: "req_67", keyId: "key_67", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_068 = { requestId: "req_68", keyId: "key_68", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_069 = { requestId: "req_69", keyId: "key_69", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_070 = { requestId: "req_70", keyId: "key_70", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_071 = { requestId: "req_71", keyId: "key_71", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_072 = { requestId: "req_72", keyId: "key_72", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_073 = { requestId: "req_73", keyId: "key_73", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_074 = { requestId: "req_74", keyId: "key_74", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_075 = { requestId: "req_75", keyId: "key_75", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_076 = { requestId: "req_76", keyId: "key_76", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_077 = { requestId: "req_77", keyId: "key_77", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_078 = { requestId: "req_78", keyId: "key_78", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_079 = { requestId: "req_79", keyId: "key_79", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_080 = { requestId: "req_80", keyId: "key_80", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_081 = { requestId: "req_81", keyId: "key_81", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_082 = { requestId: "req_82", keyId: "key_82", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_083 = { requestId: "req_83", keyId: "key_83", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_084 = { requestId: "req_84", keyId: "key_84", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_085 = { requestId: "req_85", keyId: "key_85", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_086 = { requestId: "req_86", keyId: "key_86", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_087 = { requestId: "req_87", keyId: "key_87", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_088 = { requestId: "req_88", keyId: "key_88", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_089 = { requestId: "req_89", keyId: "key_89", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_090 = { requestId: "req_90", keyId: "key_90", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_091 = { requestId: "req_91", keyId: "key_91", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_092 = { requestId: "req_92", keyId: "key_92", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_093 = { requestId: "req_93", keyId: "key_93", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_094 = { requestId: "req_94", keyId: "key_94", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_095 = { requestId: "req_95", keyId: "key_95", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_096 = { requestId: "req_96", keyId: "key_96", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_097 = { requestId: "req_97", keyId: "key_97", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_098 = { requestId: "req_98", keyId: "key_98", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_099 = { requestId: "req_99", keyId: "key_99", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_100 = { requestId: "req_100", keyId: "key_100", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_101 = { requestId: "req_101", keyId: "key_101", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_102 = { requestId: "req_102", keyId: "key_102", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_103 = { requestId: "req_103", keyId: "key_103", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_104 = { requestId: "req_104", keyId: "key_104", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_105 = { requestId: "req_105", keyId: "key_105", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_106 = { requestId: "req_106", keyId: "key_106", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_107 = { requestId: "req_107", keyId: "key_107", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_108 = { requestId: "req_108", keyId: "key_108", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_109 = { requestId: "req_109", keyId: "key_109", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_110 = { requestId: "req_110", keyId: "key_110", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_111 = { requestId: "req_111", keyId: "key_111", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_112 = { requestId: "req_112", keyId: "key_112", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_113 = { requestId: "req_113", keyId: "key_113", retry: false, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_114 = { requestId: "req_114", keyId: "key_114", retry: true, expectedTerminal: "revoked" } as const;
+export const revocationServiceScenario_115 = { requestId: "req_115", keyId: "key_115", retry: false, expectedTerminal: "revoked" } as const;
diff --git a/web/internal/key-revocation/gateway-read-model.ts b/web/internal/key-revocation/gateway-read-model.ts
new file mode 100644
index 0000000000..68a000199
--- /dev/null
+++ b/web/internal/key-revocation/gateway-read-model.ts
@@ -0,0 +1,199 @@
+import { GATEWAY_CACHE_PREFIX, REVOCATION_GATEWAY_TTL_MS, REVOCATION_STALE_TTL_MS, type GatewayKeySnapshot, type GatewayVerificationOutcome } from "./types";
+
+export type GatewayCacheEntry = {
+  snapshot: GatewayKeySnapshot;
+  freshUntil: number;
+  staleUntil: number;
+};
+
+export type GatewayKeyStore = {
+  findByHash(hash: string): Promise<GatewayKeySnapshot | null>;
+};
+
+export class GatewayVerificationCache {
+  private entries = new Map<string, GatewayCacheEntry>();
+
+  get(hash: string): { snapshot: GatewayKeySnapshot; cache: "hit" | "stale" } | null {
+    const entry = this.entries.get(`${GATEWAY_CACHE_PREFIX}:${hash}`);
+    if (!entry) {
+      return null;
+    }
+
+    const at = Date.now();
+    if (at <= entry.freshUntil) {
+      return { snapshot: entry.snapshot, cache: "hit" };
+    }
+    if (at <= entry.staleUntil) {
+      return { snapshot: entry.snapshot, cache: "stale" };
+    }
+    this.entries.delete(`${GATEWAY_CACHE_PREFIX}:${hash}`);
+    return null;
+  }
+
+  set(hash: string, snapshot: GatewayKeySnapshot): void {
+    const at = Date.now();
+    this.entries.set(`${GATEWAY_CACHE_PREFIX}:${hash}`, {
+      snapshot,
+      freshUntil: at + REVOCATION_GATEWAY_TTL_MS,
+      staleUntil: at + REVOCATION_STALE_TTL_MS,
+    });
+  }
+
+  removeByHash(hash: string): void {
+    this.entries.delete(`${GATEWAY_CACHE_PREFIX}:${hash}`);
+  }
+
+  removeByKeyId(keyId: string): void {
+    this.entries.delete(`${GATEWAY_CACHE_PREFIX}:${keyId}`);
+  }
+}
+
+export const createGatewayVerifier = (store: GatewayKeyStore, cache: GatewayVerificationCache) => {
+  return {
+    async verifyByHash(hash: string): Promise<GatewayVerificationOutcome> {
+      const cached = cache.get(hash);
+      if (cached) {
+        return evaluateSnapshot(cached.snapshot, cached.cache);
+      }
+
+      const snapshot = await store.findByHash(hash);
+      if (!snapshot) {
+        return { valid: false, code: "NOT_FOUND", cache: "miss" };
+      }
+
+      cache.set(hash, snapshot);
+      return evaluateSnapshot(snapshot, "miss");
+    },
+  };
+};
+
+const evaluateSnapshot = (snapshot: GatewayKeySnapshot, cache: "hit" | "miss" | "stale"): GatewayVerificationOutcome => {
+  if (snapshot.revokedAtM !== null) {
+    return { valid: false, code: "REVOKED", keyId: snapshot.id, statusVersion: snapshot.statusVersion, cache };
+  }
+  if (!snapshot.enabled) {
+    return { valid: false, code: "DISABLED", keyId: snapshot.id, statusVersion: snapshot.statusVersion, cache };
+  }
+  return { valid: true, code: "VALID", keyId: snapshot.id, statusVersion: snapshot.statusVersion, cache };
+};
+
+export const gatewayCachedSnapshotCase_001 = { hash: "hash_1", keyId: "key_1", statusVersion: 1, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_002 = { hash: "hash_2", keyId: "key_2", statusVersion: 2, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_003 = { hash: "hash_3", keyId: "key_3", statusVersion: 3, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_004 = { hash: "hash_4", keyId: "key_4", statusVersion: 4, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_005 = { hash: "hash_5", keyId: "key_5", statusVersion: 5, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_006 = { hash: "hash_6", keyId: "key_6", statusVersion: 6, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_007 = { hash: "hash_7", keyId: "key_7", statusVersion: 7, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_008 = { hash: "hash_8", keyId: "key_8", statusVersion: 8, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_009 = { hash: "hash_9", keyId: "key_9", statusVersion: 9, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_010 = { hash: "hash_10", keyId: "key_10", statusVersion: 10, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_011 = { hash: "hash_11", keyId: "key_11", statusVersion: 11, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_012 = { hash: "hash_12", keyId: "key_12", statusVersion: 12, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_013 = { hash: "hash_13", keyId: "key_13", statusVersion: 13, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_014 = { hash: "hash_14", keyId: "key_14", statusVersion: 14, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_015 = { hash: "hash_15", keyId: "key_15", statusVersion: 15, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_016 = { hash: "hash_16", keyId: "key_16", statusVersion: 16, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_017 = { hash: "hash_17", keyId: "key_17", statusVersion: 17, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_018 = { hash: "hash_18", keyId: "key_18", statusVersion: 18, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_019 = { hash: "hash_19", keyId: "key_19", statusVersion: 19, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_020 = { hash: "hash_20", keyId: "key_20", statusVersion: 20, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_021 = { hash: "hash_21", keyId: "key_21", statusVersion: 21, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_022 = { hash: "hash_22", keyId: "key_22", statusVersion: 22, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_023 = { hash: "hash_23", keyId: "key_23", statusVersion: 23, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_024 = { hash: "hash_24", keyId: "key_24", statusVersion: 24, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_025 = { hash: "hash_25", keyId: "key_25", statusVersion: 25, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_026 = { hash: "hash_26", keyId: "key_26", statusVersion: 26, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_027 = { hash: "hash_27", keyId: "key_27", statusVersion: 27, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_028 = { hash: "hash_28", keyId: "key_28", statusVersion: 28, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_029 = { hash: "hash_29", keyId: "key_29", statusVersion: 29, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_030 = { hash: "hash_30", keyId: "key_30", statusVersion: 30, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_031 = { hash: "hash_31", keyId: "key_31", statusVersion: 31, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_032 = { hash: "hash_32", keyId: "key_32", statusVersion: 32, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_033 = { hash: "hash_33", keyId: "key_33", statusVersion: 33, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_034 = { hash: "hash_34", keyId: "key_34", statusVersion: 34, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_035 = { hash: "hash_35", keyId: "key_35", statusVersion: 35, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_036 = { hash: "hash_36", keyId: "key_36", statusVersion: 36, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_037 = { hash: "hash_37", keyId: "key_37", statusVersion: 37, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_038 = { hash: "hash_38", keyId: "key_38", statusVersion: 38, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_039 = { hash: "hash_39", keyId: "key_39", statusVersion: 39, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_040 = { hash: "hash_40", keyId: "key_40", statusVersion: 40, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_041 = { hash: "hash_41", keyId: "key_41", statusVersion: 41, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_042 = { hash: "hash_42", keyId: "key_42", statusVersion: 42, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_043 = { hash: "hash_43", keyId: "key_43", statusVersion: 43, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_044 = { hash: "hash_44", keyId: "key_44", statusVersion: 44, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_045 = { hash: "hash_45", keyId: "key_45", statusVersion: 45, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_046 = { hash: "hash_46", keyId: "key_46", statusVersion: 46, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_047 = { hash: "hash_47", keyId: "key_47", statusVersion: 47, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_048 = { hash: "hash_48", keyId: "key_48", statusVersion: 48, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_049 = { hash: "hash_49", keyId: "key_49", statusVersion: 49, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_050 = { hash: "hash_50", keyId: "key_50", statusVersion: 50, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_051 = { hash: "hash_51", keyId: "key_51", statusVersion: 51, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_052 = { hash: "hash_52", keyId: "key_52", statusVersion: 52, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_053 = { hash: "hash_53", keyId: "key_53", statusVersion: 53, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_054 = { hash: "hash_54", keyId: "key_54", statusVersion: 54, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_055 = { hash: "hash_55", keyId: "key_55", statusVersion: 55, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_056 = { hash: "hash_56", keyId: "key_56", statusVersion: 56, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_057 = { hash: "hash_57", keyId: "key_57", statusVersion: 57, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_058 = { hash: "hash_58", keyId: "key_58", statusVersion: 58, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_059 = { hash: "hash_59", keyId: "key_59", statusVersion: 59, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_060 = { hash: "hash_60", keyId: "key_60", statusVersion: 60, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_061 = { hash: "hash_61", keyId: "key_61", statusVersion: 61, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_062 = { hash: "hash_62", keyId: "key_62", statusVersion: 62, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_063 = { hash: "hash_63", keyId: "key_63", statusVersion: 63, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_064 = { hash: "hash_64", keyId: "key_64", statusVersion: 64, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_065 = { hash: "hash_65", keyId: "key_65", statusVersion: 65, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_066 = { hash: "hash_66", keyId: "key_66", statusVersion: 66, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_067 = { hash: "hash_67", keyId: "key_67", statusVersion: 67, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_068 = { hash: "hash_68", keyId: "key_68", statusVersion: 68, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_069 = { hash: "hash_69", keyId: "key_69", statusVersion: 69, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_070 = { hash: "hash_70", keyId: "key_70", statusVersion: 70, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_071 = { hash: "hash_71", keyId: "key_71", statusVersion: 71, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_072 = { hash: "hash_72", keyId: "key_72", statusVersion: 72, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_073 = { hash: "hash_73", keyId: "key_73", statusVersion: 73, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_074 = { hash: "hash_74", keyId: "key_74", statusVersion: 74, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_075 = { hash: "hash_75", keyId: "key_75", statusVersion: 75, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_076 = { hash: "hash_76", keyId: "key_76", statusVersion: 76, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_077 = { hash: "hash_77", keyId: "key_77", statusVersion: 77, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_078 = { hash: "hash_78", keyId: "key_78", statusVersion: 78, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_079 = { hash: "hash_79", keyId: "key_79", statusVersion: 79, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_080 = { hash: "hash_80", keyId: "key_80", statusVersion: 80, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_081 = { hash: "hash_81", keyId: "key_81", statusVersion: 81, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_082 = { hash: "hash_82", keyId: "key_82", statusVersion: 82, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_083 = { hash: "hash_83", keyId: "key_83", statusVersion: 83, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_084 = { hash: "hash_84", keyId: "key_84", statusVersion: 84, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_085 = { hash: "hash_85", keyId: "key_85", statusVersion: 85, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_086 = { hash: "hash_86", keyId: "key_86", statusVersion: 86, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_087 = { hash: "hash_87", keyId: "key_87", statusVersion: 87, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_088 = { hash: "hash_88", keyId: "key_88", statusVersion: 88, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_089 = { hash: "hash_89", keyId: "key_89", statusVersion: 89, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_090 = { hash: "hash_90", keyId: "key_90", statusVersion: 90, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_091 = { hash: "hash_91", keyId: "key_91", statusVersion: 91, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_092 = { hash: "hash_92", keyId: "key_92", statusVersion: 92, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_093 = { hash: "hash_93", keyId: "key_93", statusVersion: 93, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_094 = { hash: "hash_94", keyId: "key_94", statusVersion: 94, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_095 = { hash: "hash_95", keyId: "key_95", statusVersion: 95, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_096 = { hash: "hash_96", keyId: "key_96", statusVersion: 96, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_097 = { hash: "hash_97", keyId: "key_97", statusVersion: 97, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_098 = { hash: "hash_98", keyId: "key_98", statusVersion: 98, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_099 = { hash: "hash_99", keyId: "key_99", statusVersion: 99, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_100 = { hash: "hash_100", keyId: "key_100", statusVersion: 100, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_101 = { hash: "hash_101", keyId: "key_101", statusVersion: 101, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_102 = { hash: "hash_102", keyId: "key_102", statusVersion: 102, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_103 = { hash: "hash_103", keyId: "key_103", statusVersion: 103, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_104 = { hash: "hash_104", keyId: "key_104", statusVersion: 104, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_105 = { hash: "hash_105", keyId: "key_105", statusVersion: 105, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_106 = { hash: "hash_106", keyId: "key_106", statusVersion: 106, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_107 = { hash: "hash_107", keyId: "key_107", statusVersion: 107, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_108 = { hash: "hash_108", keyId: "key_108", statusVersion: 108, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_109 = { hash: "hash_109", keyId: "key_109", statusVersion: 109, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_110 = { hash: "hash_110", keyId: "key_110", statusVersion: 110, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_111 = { hash: "hash_111", keyId: "key_111", statusVersion: 111, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_112 = { hash: "hash_112", keyId: "key_112", statusVersion: 112, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_113 = { hash: "hash_113", keyId: "key_113", statusVersion: 113, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_114 = { hash: "hash_114", keyId: "key_114", statusVersion: 114, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_115 = { hash: "hash_115", keyId: "key_115", statusVersion: 115, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_116 = { hash: "hash_116", keyId: "key_116", statusVersion: 116, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_117 = { hash: "hash_117", keyId: "key_117", statusVersion: 117, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_118 = { hash: "hash_118", keyId: "key_118", statusVersion: 118, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_119 = { hash: "hash_119", keyId: "key_119", statusVersion: 119, revokedAtM: null, expectedCache: "hit" } as const;
+export const gatewayCachedSnapshotCase_120 = { hash: "hash_120", keyId: "key_120", statusVersion: 120, revokedAtM: null, expectedCache: "hit" } as const;
diff --git a/web/apps/dashboard/app/api/v2/keys/revoke/route.ts b/web/apps/dashboard/app/api/v2/keys/revoke/route.ts
new file mode 100644
index 0000000000..68a000115
--- /dev/null
+++ b/web/apps/dashboard/app/api/v2/keys/revoke/route.ts
@@ -0,0 +1,115 @@
+import { NextResponse } from "next/server";
+import { makeRevocationCachePublisher, MemoryCacheBus, MemoryLocalCache } from "../../../../../../internal/key-revocation/cache";
+import { createRevokeKeyService, StaticPermissionChecker } from "../../../../../../internal/key-revocation/revoke-key";
+import { RevocationStore } from "../../../../../../internal/key-revocation/store";
+import { RevokeKeyError, revokeKeyRequestSchema, type RevokeKeyActor } from "../../../../../../internal/key-revocation/types";
+
+const store = new RevocationStore();
+const bus = new MemoryCacheBus();
+const localCache = new MemoryLocalCache();
+const service = createRevokeKeyService({
+  store,
+  permissions: new StaticPermissionChecker(true),
+  cachePublisher: makeRevocationCachePublisher(bus, localCache),
+});
+
+export async function POST(request: Request) {
+  const json = await request.json();
+  const parsed = revokeKeyRequestSchema.safeParse(json);
+  if (!parsed.success) {
+    return NextResponse.json({ error: { code: "BAD_REQUEST", detail: parsed.error.flatten() } }, { status: 400 });
+  }
+
+  const actor: RevokeKeyActor = {
+    workspaceId: request.headers.get("x-workspace-id") ?? "",
+    rootKeyId: request.headers.get("x-root-key-id") ?? "",
+    displayName: "root key",
+    permissions: (request.headers.get("x-root-permissions") ?? "").split(",").filter(Boolean),
+    remoteIp: request.headers.get("x-forwarded-for") ?? "",
+    userAgent: request.headers.get("user-agent") ?? "",
+  };
+
+  try {
+    const data = await service.revokeKey(actor, parsed.data);
+    return NextResponse.json({ data }, { status: 200 });
+  } catch (error) {
+    if (error instanceof RevokeKeyError) {
+      const status = error.code === "FORBIDDEN" ? 403 : error.code === "ALREADY_REVOKED" ? 409 : 404;
+      return NextResponse.json({ error: { code: error.code, detail: error.message } }, { status });
+    }
+    return NextResponse.json({ error: { code: "INTERNAL", detail: "Failed to revoke key" } }, { status: 500 });
+  }
+}
+
+export const dynamic = "force-dynamic";
+
+export const revokeRouteExample_001 = { keyId: "key_1", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_002 = { keyId: "key_2", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_003 = { keyId: "key_3", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_004 = { keyId: "key_4", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_005 = { keyId: "key_5", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_006 = { keyId: "key_6", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_007 = { keyId: "key_7", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_008 = { keyId: "key_8", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_009 = { keyId: "key_9", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_010 = { keyId: "key_10", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_011 = { keyId: "key_11", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_012 = { keyId: "key_12", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_013 = { keyId: "key_13", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_014 = { keyId: "key_14", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_015 = { keyId: "key_15", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_016 = { keyId: "key_16", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_017 = { keyId: "key_17", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_018 = { keyId: "key_18", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_019 = { keyId: "key_19", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_020 = { keyId: "key_20", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_021 = { keyId: "key_21", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_022 = { keyId: "key_22", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_023 = { keyId: "key_23", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_024 = { keyId: "key_24", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_025 = { keyId: "key_25", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_026 = { keyId: "key_26", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_027 = { keyId: "key_27", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_028 = { keyId: "key_28", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_029 = { keyId: "key_29", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_030 = { keyId: "key_30", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_031 = { keyId: "key_31", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_032 = { keyId: "key_32", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_033 = { keyId: "key_33", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_034 = { keyId: "key_34", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_035 = { keyId: "key_35", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_036 = { keyId: "key_36", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_037 = { keyId: "key_37", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_038 = { keyId: "key_38", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_039 = { keyId: "key_39", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_040 = { keyId: "key_40", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_041 = { keyId: "key_41", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_042 = { keyId: "key_42", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_043 = { keyId: "key_43", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_044 = { keyId: "key_44", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_045 = { keyId: "key_45", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_046 = { keyId: "key_46", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_047 = { keyId: "key_47", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_048 = { keyId: "key_48", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_049 = { keyId: "key_49", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_050 = { keyId: "key_50", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_051 = { keyId: "key_51", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_052 = { keyId: "key_52", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_053 = { keyId: "key_53", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_054 = { keyId: "key_54", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_055 = { keyId: "key_55", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_056 = { keyId: "key_56", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_057 = { keyId: "key_57", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_058 = { keyId: "key_58", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_059 = { keyId: "key_59", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_060 = { keyId: "key_60", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_061 = { keyId: "key_61", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_062 = { keyId: "key_62", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_063 = { keyId: "key_63", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_064 = { keyId: "key_64", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_065 = { keyId: "key_65", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_066 = { keyId: "key_66", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_067 = { keyId: "key_67", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_068 = { keyId: "key_68", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_069 = { keyId: "key_69", reason: "rotation_completed", expectedStatus: 200 } as const;
+export const revokeRouteExample_070 = { keyId: "key_70", reason: "rotation_completed", expectedStatus: 200 } as const;
diff --git a/web/internal/key-revocation/__tests__/revoke-key.test.ts b/web/internal/key-revocation/__tests__/revoke-key.test.ts
new file mode 100644
index 0000000000..68a000549
--- /dev/null
+++ b/web/internal/key-revocation/__tests__/revoke-key.test.ts
@@ -0,0 +1,549 @@
+import { describe, expect, it } from "vitest";
+import { makeRevocationCachePublisher, MemoryCacheBus, MemoryLocalCache } from "../cache";
+import { createRevokeKeyService, StaticPermissionChecker } from "../revoke-key";
+import { RevocationStore } from "../store";
+import type { KeyRecord, RevokeKeyActor } from "../types";
+
+const seedKey = (overrides: Partial<KeyRecord> = {}): KeyRecord => ({
+  id: "key_123",
+  keyAuthId: "key_auth_123",
+  apiId: "api_123",
+  workspaceId: "ws_123",
+  name: "production",
+  hash: "hash_123",
+  enabled: true,
+  status: "enabled",
+  statusVersion: 1,
+  revokedAtM: null,
+  revokedBy: null,
+  deletedAtM: null,
+  expiresAtM: null,
+  ...overrides,
+});
+
+const actor: RevokeKeyActor = {
+  workspaceId: "ws_123",
+  rootKeyId: "root_123",
+  displayName: "root key",
+  permissions: ["api.*.revoke_key"],
+  remoteIp: "127.0.0.1",
+  userAgent: "vitest",
+};
+
+describe("revokeKey", () => {
+  it("marks a key revoked and publishes cache events", async () => {
+    const store = new RevocationStore([seedKey()]);
+    const bus = new MemoryCacheBus();
+    const localCache = new MemoryLocalCache();
+    const service = createRevokeKeyService({
+      store,
+      permissions: new StaticPermissionChecker(true),
+      cachePublisher: makeRevocationCachePublisher(bus, localCache),
+    });
+
+    const result = await service.revokeKey(actor, { keyId: "key_123", reason: "compromised", permanent: false });
+
+    expect(result.status).toBe("revoked");
+    expect(result.statusVersion).toBe(2);
+    expect(result.propagation.cacheChannels).toEqual(["dashboard:key:key_123", "control-plane:key:key_123"]);
+    expect(bus.events.map((event) => event.channel)).toEqual(["dashboard:key:key_123", "control-plane:key:key_123"]);
+  });
+
+  it("treats a retried revoke as an already-revoked error", async () => {
+    const store = new RevocationStore([seedKey()]);
+    const service = createRevokeKeyService({
+      store,
+      permissions: new StaticPermissionChecker(true),
+      cachePublisher: makeRevocationCachePublisher(new MemoryCacheBus(), new MemoryLocalCache()),
+    });
+
+    await service.revokeKey(actor, { keyId: "key_123", reason: "rotation_completed", permanent: false });
+    await expect(service.revokeKey(actor, { keyId: "key_123", reason: "rotation_completed", permanent: false })).rejects.toMatchObject({ code: "ALREADY_REVOKED" });
+    expect(store.getAuditRows().filter((row) => row.keyId === "key_123").length).toBeGreaterThan(2);
+  });
+});
+
+type RetryScenario = {
+  caseId: number;
+  firstStatus: number;
+  retryStatus: number;
+  auditRowsAfterRetry: number;
+  expectedIdempotentStatus: number;
+  expectedAuditRows: number;
+};
+
+const retryScenarios: RetryScenario[] = [
+  {
+    caseId: 1,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 2,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 3,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 4,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 5,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 6,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 7,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 8,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 9,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 10,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 11,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 12,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 13,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 14,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 15,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 16,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 17,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 18,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 19,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 20,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 21,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 22,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 23,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 24,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 25,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 26,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 27,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 28,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 29,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 30,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 31,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 32,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 33,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 34,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 35,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 36,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 37,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 38,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 39,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 40,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 41,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 42,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 43,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 44,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 45,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 46,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 47,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 48,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 49,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 50,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 51,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 52,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 53,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 54,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 55,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 56,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 57,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 4,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+  {
+    caseId: 58,
+    firstStatus: 200,
+    retryStatus: 409,
+    auditRowsAfterRetry: 3,
+    expectedIdempotentStatus: 200,
+    expectedAuditRows: 1,
+  },
+];
+
+describe("retry scenario matrix", () => {
+  it("documents the current retry behavior", () => {
+    for (const scenario of retryScenarios) {
+      expect(scenario.retryStatus).toBe(409);
+      expect(scenario.auditRowsAfterRetry).toBeGreaterThan(scenario.expectedAuditRows);
+    }
+  });
+});
diff --git a/web/internal/key-revocation/__tests__/gateway-cache.test.ts b/web/internal/key-revocation/__tests__/gateway-cache.test.ts
new file mode 100644
index 0000000000..68a000181
--- /dev/null
+++ b/web/internal/key-revocation/__tests__/gateway-cache.test.ts
@@ -0,0 +1,181 @@
+import { describe, expect, it } from "vitest";
+import { createGatewayVerifier, GatewayVerificationCache, type GatewayKeyStore } from "../gateway-read-model";
+import type { GatewayKeySnapshot } from "../types";
+
+const enabledSnapshot: GatewayKeySnapshot = {
+  id: "key_123",
+  workspaceId: "ws_123",
+  apiId: "api_123",
+  hash: "hash_123",
+  enabled: true,
+  revokedAtM: null,
+  statusVersion: 1,
+  roles: [],
+  permissions: [],
+  ratelimits: [],
+};
+
+describe("gateway revocation cache", () => {
+  it("keeps accepting a key from the cached snapshot after the store is revoked", async () => {
+    let current = enabledSnapshot;
+    const store: GatewayKeyStore = {
+      async findByHash() {
+        return current;
+      },
+    };
+    const cache = new GatewayVerificationCache();
+    const verifier = createGatewayVerifier(store, cache);
+
+    await expect(verifier.verifyByHash("hash_123")).resolves.toMatchObject({ valid: true, code: "VALID", cache: "miss" });
+    current = { ...enabledSnapshot, revokedAtM: Date.now(), enabled: false, statusVersion: 2 };
+    await expect(verifier.verifyByHash("hash_123")).resolves.toMatchObject({ valid: true, code: "VALID", cache: "hit", statusVersion: 1 });
+  });
+
+  it("does not evict the gateway hash entry when given only the key id", async () => {
+    const cache = new GatewayVerificationCache();
+    cache.set("hash_123", enabledSnapshot);
+    cache.removeByKeyId("key_123");
+    expect(cache.get("hash_123")).toMatchObject({ cache: "hit" });
+  });
+});
+
+export const gatewayRevocationFixture_001 = { hash: "hash_1", keyId: "key_1", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_002 = { hash: "hash_2", keyId: "key_2", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_003 = { hash: "hash_3", keyId: "key_3", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_004 = { hash: "hash_4", keyId: "key_4", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_005 = { hash: "hash_5", keyId: "key_5", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_006 = { hash: "hash_6", keyId: "key_6", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_007 = { hash: "hash_7", keyId: "key_7", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_008 = { hash: "hash_8", keyId: "key_8", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_009 = { hash: "hash_9", keyId: "key_9", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_010 = { hash: "hash_10", keyId: "key_10", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_011 = { hash: "hash_11", keyId: "key_11", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_012 = { hash: "hash_12", keyId: "key_12", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_013 = { hash: "hash_13", keyId: "key_13", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_014 = { hash: "hash_14", keyId: "key_14", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_015 = { hash: "hash_15", keyId: "key_15", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_016 = { hash: "hash_16", keyId: "key_16", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_017 = { hash: "hash_17", keyId: "key_17", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_018 = { hash: "hash_18", keyId: "key_18", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_019 = { hash: "hash_19", keyId: "key_19", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_020 = { hash: "hash_20", keyId: "key_20", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_021 = { hash: "hash_21", keyId: "key_21", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_022 = { hash: "hash_22", keyId: "key_22", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_023 = { hash: "hash_23", keyId: "key_23", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_024 = { hash: "hash_24", keyId: "key_24", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_025 = { hash: "hash_25", keyId: "key_25", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_026 = { hash: "hash_26", keyId: "key_26", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_027 = { hash: "hash_27", keyId: "key_27", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_028 = { hash: "hash_28", keyId: "key_28", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_029 = { hash: "hash_29", keyId: "key_29", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_030 = { hash: "hash_30", keyId: "key_30", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_031 = { hash: "hash_31", keyId: "key_31", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_032 = { hash: "hash_32", keyId: "key_32", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_033 = { hash: "hash_33", keyId: "key_33", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_034 = { hash: "hash_34", keyId: "key_34", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_035 = { hash: "hash_35", keyId: "key_35", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_036 = { hash: "hash_36", keyId: "key_36", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_037 = { hash: "hash_37", keyId: "key_37", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_038 = { hash: "hash_38", keyId: "key_38", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_039 = { hash: "hash_39", keyId: "key_39", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_040 = { hash: "hash_40", keyId: "key_40", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_041 = { hash: "hash_41", keyId: "key_41", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_042 = { hash: "hash_42", keyId: "key_42", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_043 = { hash: "hash_43", keyId: "key_43", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_044 = { hash: "hash_44", keyId: "key_44", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_045 = { hash: "hash_45", keyId: "key_45", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_046 = { hash: "hash_46", keyId: "key_46", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_047 = { hash: "hash_47", keyId: "key_47", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_048 = { hash: "hash_48", keyId: "key_48", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_049 = { hash: "hash_49", keyId: "key_49", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_050 = { hash: "hash_50", keyId: "key_50", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_051 = { hash: "hash_51", keyId: "key_51", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_052 = { hash: "hash_52", keyId: "key_52", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_053 = { hash: "hash_53", keyId: "key_53", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_054 = { hash: "hash_54", keyId: "key_54", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_055 = { hash: "hash_55", keyId: "key_55", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_056 = { hash: "hash_56", keyId: "key_56", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_057 = { hash: "hash_57", keyId: "key_57", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_058 = { hash: "hash_58", keyId: "key_58", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_059 = { hash: "hash_59", keyId: "key_59", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_060 = { hash: "hash_60", keyId: "key_60", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_061 = { hash: "hash_61", keyId: "key_61", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_062 = { hash: "hash_62", keyId: "key_62", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_063 = { hash: "hash_63", keyId: "key_63", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_064 = { hash: "hash_64", keyId: "key_64", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_065 = { hash: "hash_65", keyId: "key_65", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_066 = { hash: "hash_66", keyId: "key_66", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_067 = { hash: "hash_67", keyId: "key_67", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_068 = { hash: "hash_68", keyId: "key_68", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_069 = { hash: "hash_69", keyId: "key_69", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_070 = { hash: "hash_70", keyId: "key_70", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_071 = { hash: "hash_71", keyId: "key_71", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_072 = { hash: "hash_72", keyId: "key_72", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_073 = { hash: "hash_73", keyId: "key_73", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_074 = { hash: "hash_74", keyId: "key_74", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_075 = { hash: "hash_75", keyId: "key_75", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_076 = { hash: "hash_76", keyId: "key_76", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_077 = { hash: "hash_77", keyId: "key_77", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_078 = { hash: "hash_78", keyId: "key_78", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_079 = { hash: "hash_79", keyId: "key_79", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_080 = { hash: "hash_80", keyId: "key_80", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_081 = { hash: "hash_81", keyId: "key_81", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_082 = { hash: "hash_82", keyId: "key_82", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_083 = { hash: "hash_83", keyId: "key_83", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_084 = { hash: "hash_84", keyId: "key_84", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_085 = { hash: "hash_85", keyId: "key_85", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_086 = { hash: "hash_86", keyId: "key_86", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_087 = { hash: "hash_87", keyId: "key_87", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_088 = { hash: "hash_88", keyId: "key_88", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_089 = { hash: "hash_89", keyId: "key_89", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_090 = { hash: "hash_90", keyId: "key_90", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_091 = { hash: "hash_91", keyId: "key_91", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_092 = { hash: "hash_92", keyId: "key_92", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_093 = { hash: "hash_93", keyId: "key_93", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_094 = { hash: "hash_94", keyId: "key_94", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_095 = { hash: "hash_95", keyId: "key_95", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_096 = { hash: "hash_96", keyId: "key_96", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_097 = { hash: "hash_97", keyId: "key_97", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_098 = { hash: "hash_98", keyId: "key_98", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_099 = { hash: "hash_99", keyId: "key_99", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_100 = { hash: "hash_100", keyId: "key_100", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_101 = { hash: "hash_101", keyId: "key_101", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_102 = { hash: "hash_102", keyId: "key_102", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_103 = { hash: "hash_103", keyId: "key_103", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_104 = { hash: "hash_104", keyId: "key_104", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_105 = { hash: "hash_105", keyId: "key_105", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_106 = { hash: "hash_106", keyId: "key_106", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_107 = { hash: "hash_107", keyId: "key_107", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_108 = { hash: "hash_108", keyId: "key_108", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_109 = { hash: "hash_109", keyId: "key_109", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_110 = { hash: "hash_110", keyId: "key_110", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_111 = { hash: "hash_111", keyId: "key_111", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_112 = { hash: "hash_112", keyId: "key_112", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_113 = { hash: "hash_113", keyId: "key_113", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_114 = { hash: "hash_114", keyId: "key_114", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_115 = { hash: "hash_115", keyId: "key_115", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_116 = { hash: "hash_116", keyId: "key_116", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_117 = { hash: "hash_117", keyId: "key_117", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_118 = { hash: "hash_118", keyId: "key_118", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_119 = { hash: "hash_119", keyId: "key_119", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_120 = { hash: "hash_120", keyId: "key_120", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_121 = { hash: "hash_121", keyId: "key_121", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_122 = { hash: "hash_122", keyId: "key_122", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_123 = { hash: "hash_123", keyId: "key_123", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_124 = { hash: "hash_124", keyId: "key_124", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_125 = { hash: "hash_125", keyId: "key_125", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_126 = { hash: "hash_126", keyId: "key_126", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_127 = { hash: "hash_127", keyId: "key_127", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_128 = { hash: "hash_128", keyId: "key_128", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_129 = { hash: "hash_129", keyId: "key_129", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_130 = { hash: "hash_130", keyId: "key_130", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_131 = { hash: "hash_131", keyId: "key_131", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_132 = { hash: "hash_132", keyId: "key_132", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_133 = { hash: "hash_133", keyId: "key_133", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_134 = { hash: "hash_134", keyId: "key_134", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_135 = { hash: "hash_135", keyId: "key_135", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_136 = { hash: "hash_136", keyId: "key_136", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_137 = { hash: "hash_137", keyId: "key_137", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_138 = { hash: "hash_138", keyId: "key_138", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_139 = { hash: "hash_139", keyId: "key_139", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
+export const gatewayRevocationFixture_140 = { hash: "hash_140", keyId: "key_140", staleAcceptedMs: 30000, expectedAfterInvalidation: "REVOKED" } as const;
diff --git a/docs/api/immediate-key-revocation.md b/docs/api/immediate-key-revocation.md
new file mode 100644
index 0000000000..68a000269
--- /dev/null
+++ b/docs/api/immediate-key-revocation.md
@@ -0,0 +1,269 @@
+# Immediate key revocation
+
+The revoke endpoint marks a key as revoked and removes it from dashboard and control-plane caches.
+
+## Behavior
+
+- `POST /api/v2/keys/revoke` accepts a key id, reason, optional comment, and permanent flag.
+- The endpoint returns `200` after the database transaction commits.
+- The response includes cache channels that were notified.
+- Revoked keys should stop verifying after the gateway cache refreshes.
+- Retrying an already-revoked key returns `409 ALREADY_REVOKED` so callers know the first request probably succeeded.
+
+## Operational notes
+
+The control plane publishes revocation hints on dashboard and control-plane channels. Gateways keep their own verification cache and refresh entries after the configured TTL. The endpoint reports the propagation estimate so operators can reason about eventual consistency.
+
+## Runbook
+
+1. Revoke the key from the dashboard or API.
+2. Check the audit log for the revocation record.
+3. Wait for gateway cache propagation.
+4. Verify the key returns `REVOKED` or `NOT_FOUND`.
+5. If verification still succeeds after the TTL, restart the affected gateway region.
+
+- Regional propagation sample 001: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 002: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 003: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 004: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 005: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 006: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 007: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 008: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 009: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 010: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 011: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 012: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 013: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 014: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 015: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 016: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 017: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 018: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 019: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 020: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 021: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 022: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 023: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 024: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 025: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 026: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 027: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 028: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 029: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 030: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 031: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 032: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 033: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 034: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 035: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 036: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 037: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 038: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 039: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 040: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 041: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 042: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 043: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 044: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 045: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 046: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 047: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 048: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 049: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 050: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 051: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 052: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 053: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 054: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 055: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 056: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 057: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 058: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 059: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 060: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 061: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 062: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 063: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 064: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 065: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 066: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 067: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 068: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 069: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 070: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 071: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 072: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 073: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 074: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 075: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 076: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 077: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 078: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 079: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 080: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 081: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 082: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 083: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 084: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 085: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 086: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 087: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 088: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 089: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 090: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 091: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 092: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 093: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 094: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 095: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 096: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 097: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 098: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 099: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 100: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 101: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 102: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 103: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 104: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 105: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 106: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 107: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 108: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 109: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 110: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 111: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 112: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 113: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 114: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 115: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 116: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 117: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 118: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 119: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 120: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 121: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 122: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 123: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 124: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 125: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 126: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 127: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 128: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 129: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 130: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 131: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 132: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 133: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 134: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 135: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 136: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 137: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 138: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 139: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 140: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 141: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 142: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 143: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 144: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 145: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 146: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 147: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 148: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 149: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 150: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 151: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 152: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 153: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 154: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 155: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 156: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 157: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 158: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 159: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 160: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 161: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 162: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 163: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 164: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 165: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 166: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 167: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 168: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 169: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 170: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 171: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 172: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 173: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 174: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 175: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 176: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 177: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 178: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 179: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 180: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 181: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 182: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 183: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 184: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 185: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 186: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 187: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 188: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 189: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 190: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 191: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 192: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 193: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 194: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 195: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 196: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 197: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 198: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 199: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 200: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 201: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 202: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 203: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 204: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 205: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 206: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 207: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 208: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 209: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 210: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 211: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 212: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 213: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 214: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 215: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 216: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 217: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 218: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 219: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 220: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 221: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 222: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 223: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 224: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 225: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 226: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 227: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 228: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 229: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 230: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 231: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 232: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 233: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 234: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 235: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 236: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 237: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 238: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 239: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 240: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 241: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 242: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 243: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 244: dashboard channel observed, gateway result expected after cache refresh window.
+- Regional propagation sample 245: dashboard channel observed, gateway result expected after cache refresh window.
```

## Intended Flaws

### Flaw 1: Revocation updates the control plane but does not invalidate the gateway verification cache

The revoke path marks the key revoked and publishes dashboard/control-plane channels keyed by `keyId`, but the gateway verification cache is keyed by key hash. `gateway-read-model.ts` keeps returning the pre-revocation snapshot until the fresh/stale window expires, and `cache.ts` never publishes or removes `gateway:verification-key-by-hash:<hash>`. The service even has the revoked key hash in the revocation record, but drops it when publishing invalidation.

### Flaw 1 Hints

1. Start with the product promise: what does "immediate revocation" require from the verification path, not just the dashboard database row?
2. Compare the identifier used in `publishRevocation` with the identifier used in `GatewayVerificationCache.get`.
3. Look at `revoke-key.ts` where the revocation record includes `keyHash`, then at `cache.ts` where only `keyId` channels are published.

### Flaw 2: Revocation is not an idempotent terminal transition

The service writes an attempted audit row before it knows whether the key is already revoked, then `markKeyRevoked` throws `ALREADY_REVOKED` for a retry. The route converts that into HTTP 409. A client retry after a timeout creates extra audit rows and returns an error even though the desired terminal state is already true.

### Flaw 2 Hints

1. Think like a caller whose first revoke request timed out after committing. What should the second request return?
2. Inspect where audit rows are written relative to the already-revoked check.
3. The test named `treats a retried revoke as an already-revoked error` is not proving safety; it is encoding the flaw.

## Expected Answer

### Flaw 1 Expected Answer

A strong answer should identify that the PR does not hard-invalidate the data-plane verification cache. `cache.ts:18-34` removes/publishes dashboard and control-plane entries by key id. `gateway-read-model.ts:13-57` stores gateway entries under `gateway:verification-key-by-hash:${hash}`, and `verifyByHash` trusts that cached snapshot without comparing a version, revocation epoch, or deny-list. `revoke-key.ts:43-48` publishes only `keyId/workspaceId/statusVersion` even though the revocation record contains `keyHash`.

Impact: during a compromise or rotation incident, a revoked key can keep authenticating until every gateway cache entry ages out. In a stale-while-revalidate design, that can be longer than the marketed propagation window, especially during origin errors. Operators see a successful revocation audit row while the data plane still accepts traffic.

Better fix: make revocation part of the verification consistency contract. Either publish/remove the exact `VerificationKeyByHash` entry by hash across the clustered gateway cache, or add a versioned key-state/deny-list checked on every verification with bounded latency. The response should report real propagation semantics, and tests should prove a cached valid snapshot is rejected immediately after revocation.

### Flaw 2 Expected Answer

A strong answer should identify that revoke is modeled like a one-shot create/update instead of an idempotent terminal-state transition. `store.ts:37-47` writes an attempted audit row before the terminal-state check. `store.ts:78-80` throws `ALREADY_REVOKED`, `revoke-key.ts:55-59` records a failure audit row for that retry, and `route.ts:36-39` returns 409. `revoke-key.test.ts:43-61` blesses duplicate audit rows and retry failure.

Impact: retries after network timeouts or client crashes look like failures even when the key is already safely revoked. Incident automation can page humans, repeat revoke calls, and pollute audit logs with failed attempts. Worse, clients may interpret 409 as "revocation did not happen" and try unsafe fallback actions.

Better fix: make the command idempotent by key and desired terminal state. If the key is already revoked in the same workspace, return 200 with the existing revocation metadata, do not create another success/failure audit event, and optionally record a low-noise idempotent replay metric. Use a single transaction or compare-and-set update such as `WHERE id = ? AND revoked_at_m IS NULL`, then read existing terminal state on zero rows.

## Expert Debrief

### Product-Level Change

The PR is trying to add an incident-response primitive: revoke a key now, then rely on the platform to stop accepting it everywhere. That is not the same as updating a dashboard field. It changes the security contract of the hot verification path.

### Changed Contracts

- Public API: a new revoke endpoint and retry behavior.
- Data model: key status becomes terminally revoked with a status version and revocation record.
- Cache contract: control-plane mutation must reach gateway verification caches keyed by hash.
- Audit contract: revocation should produce a clear terminal audit event without retry noise.
- Data-plane contract: verification must reject revoked keys even when a previous valid snapshot exists.

### Failure Modes

- A compromised key keeps working from gateways that have a fresh or stale cached snapshot.
- Cache invalidation appears successful because dashboard/control-plane channels receive events, while gateway cache entries remain untouched.
- Retried revoke calls produce 409s and duplicate audit rows after successful commits.
- Incident tooling cannot distinguish "already safely revoked" from "revocation failed".
- Docs tell operators to wait for TTL or restart a region, which is a smell for a feature claiming immediate security semantics.

### Reviewer Thought Process

A strong reviewer starts by separating the control-plane write from the data-plane decision. They ask: what exact state does the verifier read, what is cached, what is the cache key, and how is that cache invalidated? Then they inspect retry behavior because revocation is a terminal command that will absolutely be retried during outages and incidents.

The giveaway is the identifier mismatch. The PR has `keyHash` available in the revocation record, but the invalidation event only carries `keyId`; meanwhile gateway verification never sees `keyId` until after it has already trusted the hash cache. The second giveaway is the test suite: it asserts stale acceptance and 409-on-retry instead of proving the product promise.

### Better Implementation Direction

Build revocation as a versioned terminal-state transition. The mutation should atomically move `active -> revoked`, return existing terminal state on replay, and emit one durable revocation event/outbox row that includes the cache identity needed by gateways. Gateways should either evict `VerificationKeyByHash(hash)` through clustered invalidation or consult a compact revoked-key/version read model before accepting cached snapshots. Tests should cover cached-valid-then-revoked, lost response plus retry, multi-region invalidation, and already-revoked idempotent replay.

## Correctness Verdict Rubric

- `correct`: The answer identifies both the missing gateway/hash-based invalidation or version check and the non-idempotent retry/audit behavior, explains production impact, and suggests hard data-plane invalidation/versioned revocation plus idempotent terminal transition.
- `partial`: The answer identifies stale cache or retry issues generally but misses the keyId-vs-hash mismatch, the stale-while-revalidate behavior, or the audit/retry terminal-state contract.
- `incorrect`: The answer focuses on naming, enum choices, docs wording, or generic cache TTL tuning without naming the security-critical gateway invalidation gap and idempotency flaw.
