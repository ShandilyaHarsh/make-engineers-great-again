# TS-074: Infisical Encrypted Secret Value Search

## Metadata

- `id`: TS-074
- `source_repo`: [Infisical/infisical](https://github.com/Infisical/infisical)
- `repo_area`: secret storage, encrypted secret values/comments, secret folder reads, project bot key decryption, blind-indexed secret lookup, v4 secrets API, audit logging, search performance, plaintext exposure boundaries
- `mode`: synthetic_degraded
- `difficulty`: 8
- `target_diff_lines`: 2,250-2,800
- `represented_diff_lines`: 2381
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask about encrypted search, blind indexes, secret read-value permissions, audit logs, request-path decryption, and searchable projections without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds an encrypted secret value search endpoint to Infisical. Users can search by a substring that appears inside a secret value, secret comment, or secret key, across an environment and optionally across all folders under a path.

The PR adds:

- request/response schemas for secret value search,
- a DAL helper to gather candidate secrets from folders,
- a service that decrypts candidates and filters plaintext in memory,
- a v4 search route under `/secrets/search/value`,
- registration/wiring for the new service,
- an audit table for search events,
- tests for decrypted value matching and pagination,
- docs explaining broad recursive search behavior.

The intended product behavior is: an operator can find a secret when they remember part of the value or comment but do not remember the key name or folder.

## Existing Code Context

The real Infisical codebase already has these relevant contracts:

- `backend/src/db/schemas/secrets-v2.ts` stores secret values/comments as encrypted fields such as `encryptedValue` and `encryptedComment`; legacy secret service paths also operate on encrypted value/comment ciphertext, IV, and tag fields.
- Secret names use a blind index path. `buildSecretBlindIndexFromName` lets the system find a secret by name without decrypting every key in a folder.
- `backend/src/services/secret/secret-dal.ts` has folder-scoped readers such as `findByFolderId`, `findByFolderIds`, and `findByBlindIndexes`. These return encrypted rows scoped by folder/user rather than searchable plaintext values.
- `backend/src/services/secret/secret-fns.ts` exposes `decryptSecretRaw`, which decrypts key/value/comment material with the project bot key, and `conditionallyHideSecretValue`, which preserves the read-value permission boundary.
- `backend/src/services/secret/secret-service.ts` checks project permissions before fetching/decrypting secrets and distinguishes describe-style access from value exposure.
- Secret version rows include redaction-related fields, which is a strong hint that plaintext secret values are sensitive not just in API responses but also in storage, logs, and historical records.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to decide whether this feature respects Infisical's encrypted storage/search contracts and whether it can run safely as a high-traffic SaaS endpoint.

## Review Surface

Changed files in the synthetic PR:

- `backend/src/services/secret-search/secret-search-types.ts`
- `backend/src/services/secret-search/secret-search-dal.ts`
- `backend/src/services/secret-search/secret-search-fns.ts`
- `backend/src/services/secret-search/secret-search-service.ts`
- `backend/src/server/routes/v4/secret-search-router.ts`
- `backend/src/server/routes/v4/index.ts`
- `backend/src/services/secret/secret-search-registration.ts`
- `backend/src/db/migrations/20260605000000_secret_value_search_audit.ts`
- `backend/src/services/secret-search/__tests__/secret-search-service.test.ts`
- `docs/secret-value-search.md`

The line references below use synthetic PR line numbers. The represented diff is focused on encrypted-data search design, request-path decryption, pagination/count contracts, permission boundaries, plaintext snippets, audit persistence, and tests/docs that normalize unsafe behavior.

## Diff

```diff
diff --git a/backend/src/services/secret-search/secret-search-types.ts b/backend/src/services/secret-search/secret-search-types.ts
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/backend/src/services/secret-search/secret-search-types.ts
@@ -0,0 +1,192 @@
+import { z } from "zod";
+
+import { SecretType } from "@app/db/schemas";
+import { ActorAuthMethod, ActorType } from "@app/services/auth/auth-type";
+
+export const SecretValueSearchScopeSchema = z.object({
+  projectId: z.string().uuid(),
+  environment: z.string().min(1),
+  secretPath: z.string().default("/"),
+  recursive: z.boolean().default(true),
+  includePersonal: z.boolean().default(false),
+  includeComments: z.boolean().default(true),
+  includeSecretValues: z.boolean().default(true),
+  includePlaintextSnippets: z.boolean().default(true),
+  tagSlugs: z.string().array().default([])
+});
+
+export const SearchEncryptedSecretValuesRequestSchema = SecretValueSearchScopeSchema.extend({
+  query: z.string().trim().min(2).max(512),
+  limit: z.number().int().min(1).max(100).default(25),
+  offset: z.number().int().min(0).default(0),
+  sort: z.enum(["updatedAt", "createdAt", "path"]).default("updatedAt")
+});
+
+export const SecretSearchMatchSchema = z.object({
+  field: z.enum(["value", "comment", "key"]),
+  snippet: z.string().optional(),
+  plaintext: z.string().optional(),
+  matchedAt: z.number().int().min(0)
+});
+
+export const SecretSearchResultSchema = z.object({
+  id: z.string().uuid(),
+  key: z.string(),
+  type: z.nativeEnum(SecretType),
+  environment: z.string(),
+  secretPath: z.string(),
+  tags: z.object({ id: z.string(), slug: z.string(), color: z.string().nullable().optional() }).array(),
+  valueSnippet: z.string().optional(),
+  commentSnippet: z.string().optional(),
+  matchedPlaintext: z.string().optional(),
+  match: SecretSearchMatchSchema,
+  updatedAt: z.date(),
+  createdAt: z.date()
+});
+
+export const SearchEncryptedSecretValuesResponseSchema = z.object({
+  totalCount: z.number().int().min(0),
+  scannedCount: z.number().int().min(0),
+  decryptedCount: z.number().int().min(0),
+  secrets: SecretSearchResultSchema.array(),
+  nextOffset: z.number().int().nullable(),
+  searchedAt: z.string()
+});
+
+export type TSearchEncryptedSecretValuesRequest = z.infer<typeof SearchEncryptedSecretValuesRequestSchema>;
+export type TSearchEncryptedSecretValuesResponse = z.infer<typeof SearchEncryptedSecretValuesResponseSchema>;
+export type TSecretSearchResult = z.infer<typeof SecretSearchResultSchema>;
+export type TSecretValueSearchScope = z.infer<typeof SecretValueSearchScopeSchema>;
+
+export type TSecretValueSearchAuth = {
+  actor: ActorType;
+  actorId: string;
+  actorAuthMethod: ActorAuthMethod;
+  actorOrgId?: string;
+};
+
+export type TSecretValueSearchCandidate = {
+  id: string;
+  folderId: string;
+  type: SecretType;
+  userId?: string | null;
+  secretKeyCiphertext: string;
+  secretKeyIV: string;
+  secretKeyTag: string;
+  secretValueCiphertext: string;
+  secretValueIV: string;
+  secretValueTag: string;
+  secretCommentCiphertext?: string | null;
+  secretCommentIV?: string | null;
+  secretCommentTag?: string | null;
+  skipMultilineEncoding?: boolean;
+  tags: Array<{ id: string; slug: string; color?: string | null }>;
+  createdAt: Date;
+  updatedAt: Date;
+};
+
+export type TDecryptedSearchCandidate = TSecretValueSearchCandidate & {
+  key: string;
+  value: string;
+  comment: string;
+  workspace: string;
+  environment: string;
+  secretPath: string;
+};
+
+export const SEARCHABLE_SECRET_VALUE_FIELDS = ["value", "comment", "key"] as const;
+export const secretValueSearchExample_001 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000001", environment: "prod", secretPath: "/service/1", query: "token-1", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_002 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000002", environment: "prod", secretPath: "/service/2", query: "token-2", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_003 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000003", environment: "prod", secretPath: "/customers/segment-3", query: "token-3", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_004 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000004", environment: "prod", secretPath: "/service/4", query: "token-4", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_005 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000005", environment: "prod", secretPath: "/payments/provider-5", query: "token-5", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_006 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000006", environment: "prod", secretPath: "/customers/segment-6", query: "token-6", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_007 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000007", environment: "prod", secretPath: "/service/7", query: "token-7", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_008 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000008", environment: "prod", secretPath: "/service/8", query: "token-8", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_009 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000009", environment: "prod", secretPath: "/customers/segment-9", query: "token-9", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_010 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000010", environment: "prod", secretPath: "/payments/provider-10", query: "token-10", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_011 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000011", environment: "prod", secretPath: "/service/11", query: "token-11", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_012 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000012", environment: "prod", secretPath: "/customers/segment-12", query: "token-12", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_013 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000013", environment: "prod", secretPath: "/service/13", query: "token-13", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_014 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000014", environment: "prod", secretPath: "/service/14", query: "token-14", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_015 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000015", environment: "prod", secretPath: "/payments/provider-15", query: "token-15", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_016 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000016", environment: "prod", secretPath: "/service/16", query: "token-16", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_017 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000017", environment: "prod", secretPath: "/service/17", query: "token-17", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_018 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000018", environment: "prod", secretPath: "/customers/segment-18", query: "token-18", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_019 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000019", environment: "prod", secretPath: "/service/19", query: "token-19", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_020 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000020", environment: "prod", secretPath: "/payments/provider-20", query: "token-20", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_021 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000021", environment: "prod", secretPath: "/customers/segment-21", query: "token-21", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_022 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000022", environment: "prod", secretPath: "/service/22", query: "token-22", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_023 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000023", environment: "prod", secretPath: "/service/23", query: "token-23", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_024 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000024", environment: "prod", secretPath: "/customers/segment-24", query: "token-24", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_025 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000025", environment: "prod", secretPath: "/payments/provider-25", query: "token-25", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_026 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000026", environment: "prod", secretPath: "/service/26", query: "token-26", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_027 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000027", environment: "prod", secretPath: "/customers/segment-27", query: "token-27", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_028 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000028", environment: "prod", secretPath: "/service/28", query: "token-28", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_029 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000029", environment: "prod", secretPath: "/service/29", query: "token-29", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_030 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000030", environment: "prod", secretPath: "/payments/provider-30", query: "token-30", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_031 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000031", environment: "prod", secretPath: "/service/31", query: "token-31", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_032 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000032", environment: "prod", secretPath: "/service/32", query: "token-32", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_033 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000033", environment: "prod", secretPath: "/customers/segment-33", query: "token-33", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_034 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000034", environment: "prod", secretPath: "/service/34", query: "token-34", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_035 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000035", environment: "prod", secretPath: "/payments/provider-35", query: "token-35", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_036 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000036", environment: "prod", secretPath: "/customers/segment-36", query: "token-36", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_037 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000037", environment: "prod", secretPath: "/service/37", query: "token-37", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_038 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000038", environment: "prod", secretPath: "/service/38", query: "token-38", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_039 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000039", environment: "prod", secretPath: "/customers/segment-39", query: "token-39", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_040 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000040", environment: "prod", secretPath: "/payments/provider-40", query: "token-40", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_041 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000041", environment: "prod", secretPath: "/service/41", query: "token-41", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_042 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000042", environment: "prod", secretPath: "/customers/segment-42", query: "token-42", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_043 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000043", environment: "prod", secretPath: "/service/43", query: "token-43", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_044 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000044", environment: "prod", secretPath: "/service/44", query: "token-44", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_045 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000045", environment: "prod", secretPath: "/payments/provider-45", query: "token-45", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_046 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000046", environment: "prod", secretPath: "/service/46", query: "token-46", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_047 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000047", environment: "prod", secretPath: "/service/47", query: "token-47", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_048 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000048", environment: "prod", secretPath: "/customers/segment-48", query: "token-48", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_049 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000049", environment: "prod", secretPath: "/service/49", query: "token-49", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_050 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000050", environment: "prod", secretPath: "/payments/provider-50", query: "token-50", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_051 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000051", environment: "prod", secretPath: "/customers/segment-51", query: "token-51", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_052 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000052", environment: "prod", secretPath: "/service/52", query: "token-52", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_053 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000053", environment: "prod", secretPath: "/service/53", query: "token-53", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_054 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000054", environment: "prod", secretPath: "/customers/segment-54", query: "token-54", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_055 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000055", environment: "prod", secretPath: "/payments/provider-55", query: "token-55", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_056 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000056", environment: "prod", secretPath: "/service/56", query: "token-56", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_057 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000057", environment: "prod", secretPath: "/customers/segment-57", query: "token-57", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_058 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000058", environment: "prod", secretPath: "/service/58", query: "token-58", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_059 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000059", environment: "prod", secretPath: "/service/59", query: "token-59", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_060 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000060", environment: "prod", secretPath: "/payments/provider-60", query: "token-60", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_061 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000061", environment: "prod", secretPath: "/service/61", query: "token-61", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_062 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000062", environment: "prod", secretPath: "/service/62", query: "token-62", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_063 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000063", environment: "prod", secretPath: "/customers/segment-63", query: "token-63", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_064 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000064", environment: "prod", secretPath: "/service/64", query: "token-64", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_065 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000065", environment: "prod", secretPath: "/payments/provider-65", query: "token-65", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_066 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000066", environment: "prod", secretPath: "/customers/segment-66", query: "token-66", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_067 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000067", environment: "prod", secretPath: "/service/67", query: "token-67", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_068 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000068", environment: "prod", secretPath: "/service/68", query: "token-68", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_069 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000069", environment: "prod", secretPath: "/customers/segment-69", query: "token-69", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_070 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000070", environment: "prod", secretPath: "/payments/provider-70", query: "token-70", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_071 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000071", environment: "prod", secretPath: "/service/71", query: "token-71", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_072 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000072", environment: "prod", secretPath: "/customers/segment-72", query: "token-72", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_073 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000073", environment: "prod", secretPath: "/service/73", query: "token-73", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_074 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000074", environment: "prod", secretPath: "/service/74", query: "token-74", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_075 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000075", environment: "prod", secretPath: "/payments/provider-75", query: "token-75", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_076 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000076", environment: "prod", secretPath: "/service/76", query: "token-76", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_077 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000077", environment: "prod", secretPath: "/service/77", query: "token-77", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_078 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000078", environment: "prod", secretPath: "/customers/segment-78", query: "token-78", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_079 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000079", environment: "prod", secretPath: "/service/79", query: "token-79", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_080 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000080", environment: "prod", secretPath: "/payments/provider-80", query: "token-80", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_081 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000081", environment: "prod", secretPath: "/customers/segment-81", query: "token-81", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_082 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000082", environment: "prod", secretPath: "/service/82", query: "token-82", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_083 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000083", environment: "prod", secretPath: "/service/83", query: "token-83", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_084 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000084", environment: "prod", secretPath: "/customers/segment-84", query: "token-84", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_085 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000085", environment: "prod", secretPath: "/payments/provider-85", query: "token-85", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_086 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000086", environment: "prod", secretPath: "/service/86", query: "token-86", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_087 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000087", environment: "prod", secretPath: "/customers/segment-87", query: "token-87", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_088 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000088", environment: "prod", secretPath: "/service/88", query: "token-88", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_089 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000089", environment: "prod", secretPath: "/service/89", query: "token-89", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_090 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000090", environment: "prod", secretPath: "/payments/provider-90", query: "token-90", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_091 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000091", environment: "prod", secretPath: "/service/91", query: "token-91", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_092 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000092", environment: "prod", secretPath: "/service/92", query: "token-92", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_093 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000093", environment: "prod", secretPath: "/customers/segment-93", query: "token-93", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_094 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000094", environment: "prod", secretPath: "/service/94", query: "token-94", includeComments: true, includePlaintextSnippets: true, limit: 25, offset: 0 });
+export const secretValueSearchExample_095 = SearchEncryptedSecretValuesRequestSchema.parse({ projectId: "00000000-0000-0000-0000-000000000095", environment: "prod", secretPath: "/payments/provider-95", query: "token-95", includeComments: false, includePlaintextSnippets: true, limit: 25, offset: 0 });
diff --git a/backend/src/services/secret-search/secret-search-dal.ts b/backend/src/services/secret-search/secret-search-dal.ts
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/backend/src/services/secret-search/secret-search-dal.ts
@@ -0,0 +1,223 @@
+import { Knex } from "knex";
+
+import { SecretType, TableName } from "@app/db/schemas";
+import { selectAllTableCols } from "@app/db/utils";
+import { DatabaseError } from "@app/lib/errors";
+import { sqlNestRelationships } from "@app/lib/knex";
+
+import { TSecretValueSearchCandidate } from "./secret-search-types";
+
+type TSecretSearchDALFactoryDeps = {
+  db: Knex;
+};
+
+type TFindCandidateSecretsForValueSearch = {
+  projectId: string;
+  environment: string;
+  folderIds: string[];
+  includePersonal: boolean;
+  actorId: string;
+  tagSlugs: string[];
+};
+
+export const secretSearchDALFactory = ({ db }: TSecretSearchDALFactoryDeps) => {
+  const findCandidateSecretsForValueSearch = async (filter: TFindCandidateSecretsForValueSearch, tx?: Knex) => {
+    try {
+      if (!filter.folderIds.length) return [];
+
+      const query = (tx || db.replicaNode())(TableName.Secret)
+        .whereIn(`${TableName.Secret}.folderId`, filter.folderIds)
+        .where((builder) => {
+          void builder.where({ [`${TableName.Secret}.type`]: SecretType.Shared, [`${TableName.Secret}.userId`]: null });
+          if (filter.includePersonal) {
+            void builder.orWhere({ [`${TableName.Secret}.type`]: SecretType.Personal, [`${TableName.Secret}.userId`]: filter.actorId });
+          }
+        })
+        .leftJoin(TableName.JnSecretTag, `${TableName.Secret}.id`, `${TableName.JnSecretTag}.${TableName.Secret}Id`)
+        .leftJoin(TableName.SecretTag, `${TableName.JnSecretTag}.${TableName.SecretTag}Id`, `${TableName.SecretTag}.id`)
+        .select(selectAllTableCols(TableName.Secret))
+        .select(db.ref("id").withSchema(TableName.SecretTag).as("tagId"))
+        .select(db.ref("color").withSchema(TableName.SecretTag).as("tagColor"))
+        .select(db.ref("slug").withSchema(TableName.SecretTag).as("tagSlug"))
+        .orderBy(`${TableName.Secret}.updatedAt`, "desc");
+
+      if (filter.tagSlugs.length) {
+        void query.whereIn(`${TableName.SecretTag}.slug`, filter.tagSlugs);
+      }
+
+      const rows = await query;
+
+      return sqlNestRelationships({
+        data: rows,
+        key: "id",
+        parentMapper: (row) => row as TSecretValueSearchCandidate,
+        childrenMapper: [
+          {
+            key: "tagId",
+            label: "tags" as const,
+            mapper: ({ tagId: id, tagColor: color, tagSlug: slug }) => ({ id, color, slug })
+          }
+        ]
+      });
+    } catch (error) {
+      throw new DatabaseError({ error, name: "find candidate secrets for value search" });
+    }
+  };
+
+  const countCandidateSecretsForValueSearch = async (filter: TFindCandidateSecretsForValueSearch, tx?: Knex) => {
+    try {
+      const row = await (tx || db.replicaNode())(TableName.Secret)
+        .whereIn(`${TableName.Secret}.folderId`, filter.folderIds)
+        .where((builder) => {
+          void builder.where({ [`${TableName.Secret}.type`]: SecretType.Shared, [`${TableName.Secret}.userId`]: null });
+          if (filter.includePersonal) {
+            void builder.orWhere({ [`${TableName.Secret}.type`]: SecretType.Personal, [`${TableName.Secret}.userId`]: filter.actorId });
+          }
+        })
+        .count<{ count: string }>("id as count")
+        .first();
+
+      return Number(row?.count ?? 0);
+    } catch (error) {
+      throw new DatabaseError({ error, name: "count candidate secrets for value search" });
+    }
+  };
+
+  return {
+    findCandidateSecretsForValueSearch,
+    countCandidateSecretsForValueSearch
+  };
+};
+
+export type TSecretSearchDALFactory = ReturnType<typeof secretSearchDALFactory>;
+
+export const secretSearchDalProjection_001 = { folderOrdinal: 1, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_002 = { folderOrdinal: 2, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_003 = { folderOrdinal: 3, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_004 = { folderOrdinal: 4, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_005 = { folderOrdinal: 5, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_006 = { folderOrdinal: 6, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_007 = { folderOrdinal: 7, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_008 = { folderOrdinal: 8, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_009 = { folderOrdinal: 9, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_010 = { folderOrdinal: 10, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_011 = { folderOrdinal: 11, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_012 = { folderOrdinal: 12, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_013 = { folderOrdinal: 13, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_014 = { folderOrdinal: 14, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_015 = { folderOrdinal: 15, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_016 = { folderOrdinal: 16, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_017 = { folderOrdinal: 17, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_018 = { folderOrdinal: 18, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_019 = { folderOrdinal: 19, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_020 = { folderOrdinal: 20, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_021 = { folderOrdinal: 21, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_022 = { folderOrdinal: 22, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_023 = { folderOrdinal: 23, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_024 = { folderOrdinal: 24, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_025 = { folderOrdinal: 25, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_026 = { folderOrdinal: 26, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_027 = { folderOrdinal: 27, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_028 = { folderOrdinal: 28, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_029 = { folderOrdinal: 29, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_030 = { folderOrdinal: 30, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_031 = { folderOrdinal: 31, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_032 = { folderOrdinal: 32, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_033 = { folderOrdinal: 33, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_034 = { folderOrdinal: 34, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_035 = { folderOrdinal: 35, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_036 = { folderOrdinal: 36, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_037 = { folderOrdinal: 37, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_038 = { folderOrdinal: 38, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_039 = { folderOrdinal: 39, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_040 = { folderOrdinal: 40, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_041 = { folderOrdinal: 41, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_042 = { folderOrdinal: 42, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_043 = { folderOrdinal: 43, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_044 = { folderOrdinal: 44, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_045 = { folderOrdinal: 45, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_046 = { folderOrdinal: 46, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_047 = { folderOrdinal: 47, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_048 = { folderOrdinal: 48, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_049 = { folderOrdinal: 49, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_050 = { folderOrdinal: 50, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_051 = { folderOrdinal: 51, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_052 = { folderOrdinal: 52, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_053 = { folderOrdinal: 53, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_054 = { folderOrdinal: 54, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_055 = { folderOrdinal: 55, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_056 = { folderOrdinal: 56, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_057 = { folderOrdinal: 57, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_058 = { folderOrdinal: 58, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_059 = { folderOrdinal: 59, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_060 = { folderOrdinal: 60, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_061 = { folderOrdinal: 61, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_062 = { folderOrdinal: 62, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_063 = { folderOrdinal: 63, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_064 = { folderOrdinal: 64, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_065 = { folderOrdinal: 65, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_066 = { folderOrdinal: 66, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_067 = { folderOrdinal: 67, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_068 = { folderOrdinal: 68, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_069 = { folderOrdinal: 69, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_070 = { folderOrdinal: 70, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_071 = { folderOrdinal: 71, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_072 = { folderOrdinal: 72, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_073 = { folderOrdinal: 73, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_074 = { folderOrdinal: 74, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_075 = { folderOrdinal: 75, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_076 = { folderOrdinal: 76, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_077 = { folderOrdinal: 77, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_078 = { folderOrdinal: 78, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_079 = { folderOrdinal: 79, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_080 = { folderOrdinal: 80, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_081 = { folderOrdinal: 81, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_082 = { folderOrdinal: 82, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_083 = { folderOrdinal: 83, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_084 = { folderOrdinal: 84, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_085 = { folderOrdinal: 85, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_086 = { folderOrdinal: 86, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_087 = { folderOrdinal: 87, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_088 = { folderOrdinal: 88, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_089 = { folderOrdinal: 89, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_090 = { folderOrdinal: 90, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_091 = { folderOrdinal: 91, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_092 = { folderOrdinal: 92, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_093 = { folderOrdinal: 93, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_094 = { folderOrdinal: 94, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_095 = { folderOrdinal: 95, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_096 = { folderOrdinal: 96, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_097 = { folderOrdinal: 97, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_098 = { folderOrdinal: 98, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_099 = { folderOrdinal: 99, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_100 = { folderOrdinal: 100, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_101 = { folderOrdinal: 101, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_102 = { folderOrdinal: 102, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_103 = { folderOrdinal: 103, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_104 = { folderOrdinal: 104, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_105 = { folderOrdinal: 105, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_106 = { folderOrdinal: 106, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_107 = { folderOrdinal: 107, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_108 = { folderOrdinal: 108, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_109 = { folderOrdinal: 109, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_110 = { folderOrdinal: 110, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_111 = { folderOrdinal: 111, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_112 = { folderOrdinal: 112, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_113 = { folderOrdinal: 113, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_114 = { folderOrdinal: 114, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_115 = { folderOrdinal: 115, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_116 = { folderOrdinal: 116, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_117 = { folderOrdinal: 117, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_118 = { folderOrdinal: 118, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_119 = { folderOrdinal: 119, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_120 = { folderOrdinal: 120, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_121 = { folderOrdinal: 121, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_122 = { folderOrdinal: 122, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_123 = { folderOrdinal: 123, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_124 = { folderOrdinal: 124, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_125 = { folderOrdinal: 125, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_126 = { folderOrdinal: 126, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_127 = { folderOrdinal: 127, tagSlug: "support", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_128 = { folderOrdinal: 128, tagSlug: "payment", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_129 = { folderOrdinal: 129, tagSlug: "runtime", includesEncryptedValue: true, includesEncryptedComment: false, appliesDatabaseSearchPredicate: false } as const;
+export const secretSearchDalProjection_130 = { folderOrdinal: 130, tagSlug: "deploy", includesEncryptedValue: true, includesEncryptedComment: true, appliesDatabaseSearchPredicate: false } as const;
diff --git a/backend/src/services/secret-search/secret-search-fns.ts b/backend/src/services/secret-search/secret-search-fns.ts
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/backend/src/services/secret-search/secret-search-fns.ts
@@ -0,0 +1,252 @@
+import { crypto, SymmetricKeySize } from "@app/lib/crypto/cryptography";
+import { INFISICAL_SECRET_VALUE_HIDDEN_MASK, decryptSecretRaw } from "@app/services/secret/secret-fns";
+
+import { TDecryptedSearchCandidate, TSecretSearchResult, TSecretValueSearchCandidate } from "./secret-search-types";
+
+type TDecryptCandidateForSearch = {
+  candidate: TSecretValueSearchCandidate & { workspace: string; environment: string; secretPath: string; secretValueHidden?: boolean };
+  botKey: string;
+};
+
+export const normalizeSearchQuery = (query: string) => query.trim().toLowerCase();
+
+export const decryptCandidateForSearch = ({ candidate, botKey }: TDecryptCandidateForSearch): TDecryptedSearchCandidate => {
+  const decrypted = decryptSecretRaw(
+    {
+      ...candidate,
+      secretValueHidden: false,
+      workspace: candidate.workspace,
+      environment: candidate.environment,
+      secretPath: candidate.secretPath
+    },
+    botKey
+  );
+
+  return {
+    ...candidate,
+    key: decrypted.secretKey,
+    value: decrypted.secretValue === INFISICAL_SECRET_VALUE_HIDDEN_MASK ? "" : decrypted.secretValue,
+    comment: decrypted.secretComment ?? "",
+    workspace: candidate.workspace,
+    environment: candidate.environment,
+    secretPath: candidate.secretPath
+  };
+};
+
+const findMatchIndex = (source: string, query: string) => source.toLowerCase().indexOf(query);
+
+export const makePlaintextSnippet = (source: string, matchIndex: number, radius = 32) => {
+  if (matchIndex < 0) return undefined;
+  const start = Math.max(0, matchIndex - radius);
+  const end = Math.min(source.length, matchIndex + radius);
+  return source.slice(start, end);
+};
+
+export const candidateMatchesPlaintext = (candidate: TDecryptedSearchCandidate, query: string, includeComments: boolean) => {
+  const normalized = normalizeSearchQuery(query);
+  const valueIndex = findMatchIndex(candidate.value, normalized);
+  if (valueIndex >= 0) return { field: "value" as const, matchedAt: valueIndex, plaintext: candidate.value };
+
+  const keyIndex = findMatchIndex(candidate.key, normalized);
+  if (keyIndex >= 0) return { field: "key" as const, matchedAt: keyIndex, plaintext: candidate.key };
+
+  if (includeComments) {
+    const commentIndex = findMatchIndex(candidate.comment, normalized);
+    if (commentIndex >= 0) return { field: "comment" as const, matchedAt: commentIndex, plaintext: candidate.comment };
+  }
+
+  return undefined;
+};
+
+export const toSecretSearchResult = ({
+  candidate,
+  query,
+  includePlaintextSnippets
+}: {
+  candidate: TDecryptedSearchCandidate;
+  query: string;
+  includePlaintextSnippets: boolean;
+}): TSecretSearchResult => {
+  const match = candidateMatchesPlaintext(candidate, query, true);
+  const snippet = match ? makePlaintextSnippet(match.plaintext, match.matchedAt) : undefined;
+
+  return {
+    id: candidate.id,
+    key: candidate.key,
+    type: candidate.type,
+    environment: candidate.environment,
+    secretPath: candidate.secretPath,
+    tags: candidate.tags ?? [],
+    valueSnippet: includePlaintextSnippets && match?.field === "value" ? snippet : undefined,
+    commentSnippet: includePlaintextSnippets && match?.field === "comment" ? snippet : undefined,
+    matchedPlaintext: includePlaintextSnippets ? match?.plaintext : undefined,
+    match: {
+      field: match?.field ?? "key",
+      snippet,
+      plaintext: includePlaintextSnippets ? match?.plaintext : undefined,
+      matchedAt: match?.matchedAt ?? 0
+    },
+    updatedAt: candidate.updatedAt,
+    createdAt: candidate.createdAt
+  };
+};
+
+export const decryptLegacyValueForFixture = (ciphertext: string, iv: string, tag: string, key: string) => {
+  return crypto.encryption().symmetric().decrypt({ ciphertext, iv, tag, key, keySize: SymmetricKeySize.Bits128 });
+};
+
+export const plaintextSecretSearchFixture_001 = { field: "comment", plaintext: "fixture-secret-value-1-contains-token-001", query: "token-001", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_002 = { field: "key", plaintext: "fixture-secret-value-2-contains-token-002", query: "token-002", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_003 = { field: "value", plaintext: "fixture-secret-value-3-contains-token-003", query: "token-003", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_004 = { field: "comment", plaintext: "fixture-secret-value-4-contains-token-004", query: "token-004", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_005 = { field: "key", plaintext: "fixture-secret-value-5-contains-token-005", query: "token-005", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_006 = { field: "value", plaintext: "fixture-secret-value-6-contains-token-006", query: "token-006", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_007 = { field: "comment", plaintext: "fixture-secret-value-7-contains-token-007", query: "token-007", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_008 = { field: "key", plaintext: "fixture-secret-value-8-contains-token-008", query: "token-008", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_009 = { field: "value", plaintext: "fixture-secret-value-9-contains-token-009", query: "token-009", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_010 = { field: "comment", plaintext: "fixture-secret-value-10-contains-token-010", query: "token-010", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_011 = { field: "key", plaintext: "fixture-secret-value-11-contains-token-011", query: "token-011", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_012 = { field: "value", plaintext: "fixture-secret-value-12-contains-token-012", query: "token-012", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_013 = { field: "comment", plaintext: "fixture-secret-value-13-contains-token-013", query: "token-013", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_014 = { field: "key", plaintext: "fixture-secret-value-14-contains-token-014", query: "token-014", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_015 = { field: "value", plaintext: "fixture-secret-value-15-contains-token-015", query: "token-015", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_016 = { field: "comment", plaintext: "fixture-secret-value-16-contains-token-016", query: "token-016", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_017 = { field: "key", plaintext: "fixture-secret-value-17-contains-token-017", query: "token-017", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_018 = { field: "value", plaintext: "fixture-secret-value-18-contains-token-018", query: "token-018", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_019 = { field: "comment", plaintext: "fixture-secret-value-19-contains-token-019", query: "token-019", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_020 = { field: "key", plaintext: "fixture-secret-value-20-contains-token-020", query: "token-020", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_021 = { field: "value", plaintext: "fixture-secret-value-21-contains-token-021", query: "token-021", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_022 = { field: "comment", plaintext: "fixture-secret-value-22-contains-token-022", query: "token-022", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_023 = { field: "key", plaintext: "fixture-secret-value-23-contains-token-023", query: "token-023", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_024 = { field: "value", plaintext: "fixture-secret-value-24-contains-token-024", query: "token-024", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_025 = { field: "comment", plaintext: "fixture-secret-value-25-contains-token-025", query: "token-025", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_026 = { field: "key", plaintext: "fixture-secret-value-26-contains-token-026", query: "token-026", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_027 = { field: "value", plaintext: "fixture-secret-value-27-contains-token-027", query: "token-027", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_028 = { field: "comment", plaintext: "fixture-secret-value-28-contains-token-028", query: "token-028", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_029 = { field: "key", plaintext: "fixture-secret-value-29-contains-token-029", query: "token-029", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_030 = { field: "value", plaintext: "fixture-secret-value-30-contains-token-030", query: "token-030", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_031 = { field: "comment", plaintext: "fixture-secret-value-31-contains-token-031", query: "token-031", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_032 = { field: "key", plaintext: "fixture-secret-value-32-contains-token-032", query: "token-032", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_033 = { field: "value", plaintext: "fixture-secret-value-33-contains-token-033", query: "token-033", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_034 = { field: "comment", plaintext: "fixture-secret-value-34-contains-token-034", query: "token-034", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_035 = { field: "key", plaintext: "fixture-secret-value-35-contains-token-035", query: "token-035", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_036 = { field: "value", plaintext: "fixture-secret-value-36-contains-token-036", query: "token-036", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_037 = { field: "comment", plaintext: "fixture-secret-value-37-contains-token-037", query: "token-037", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_038 = { field: "key", plaintext: "fixture-secret-value-38-contains-token-038", query: "token-038", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_039 = { field: "value", plaintext: "fixture-secret-value-39-contains-token-039", query: "token-039", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_040 = { field: "comment", plaintext: "fixture-secret-value-40-contains-token-040", query: "token-040", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_041 = { field: "key", plaintext: "fixture-secret-value-41-contains-token-041", query: "token-041", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_042 = { field: "value", plaintext: "fixture-secret-value-42-contains-token-042", query: "token-042", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_043 = { field: "comment", plaintext: "fixture-secret-value-43-contains-token-043", query: "token-043", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_044 = { field: "key", plaintext: "fixture-secret-value-44-contains-token-044", query: "token-044", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_045 = { field: "value", plaintext: "fixture-secret-value-45-contains-token-045", query: "token-045", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_046 = { field: "comment", plaintext: "fixture-secret-value-46-contains-token-046", query: "token-046", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_047 = { field: "key", plaintext: "fixture-secret-value-47-contains-token-047", query: "token-047", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_048 = { field: "value", plaintext: "fixture-secret-value-48-contains-token-048", query: "token-048", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_049 = { field: "comment", plaintext: "fixture-secret-value-49-contains-token-049", query: "token-049", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_050 = { field: "key", plaintext: "fixture-secret-value-50-contains-token-050", query: "token-050", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_051 = { field: "value", plaintext: "fixture-secret-value-51-contains-token-051", query: "token-051", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_052 = { field: "comment", plaintext: "fixture-secret-value-52-contains-token-052", query: "token-052", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_053 = { field: "key", plaintext: "fixture-secret-value-53-contains-token-053", query: "token-053", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_054 = { field: "value", plaintext: "fixture-secret-value-54-contains-token-054", query: "token-054", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_055 = { field: "comment", plaintext: "fixture-secret-value-55-contains-token-055", query: "token-055", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_056 = { field: "key", plaintext: "fixture-secret-value-56-contains-token-056", query: "token-056", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_057 = { field: "value", plaintext: "fixture-secret-value-57-contains-token-057", query: "token-057", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_058 = { field: "comment", plaintext: "fixture-secret-value-58-contains-token-058", query: "token-058", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_059 = { field: "key", plaintext: "fixture-secret-value-59-contains-token-059", query: "token-059", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_060 = { field: "value", plaintext: "fixture-secret-value-60-contains-token-060", query: "token-060", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_061 = { field: "comment", plaintext: "fixture-secret-value-61-contains-token-061", query: "token-061", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_062 = { field: "key", plaintext: "fixture-secret-value-62-contains-token-062", query: "token-062", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_063 = { field: "value", plaintext: "fixture-secret-value-63-contains-token-063", query: "token-063", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_064 = { field: "comment", plaintext: "fixture-secret-value-64-contains-token-064", query: "token-064", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_065 = { field: "key", plaintext: "fixture-secret-value-65-contains-token-065", query: "token-065", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_066 = { field: "value", plaintext: "fixture-secret-value-66-contains-token-066", query: "token-066", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_067 = { field: "comment", plaintext: "fixture-secret-value-67-contains-token-067", query: "token-067", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_068 = { field: "key", plaintext: "fixture-secret-value-68-contains-token-068", query: "token-068", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_069 = { field: "value", plaintext: "fixture-secret-value-69-contains-token-069", query: "token-069", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_070 = { field: "comment", plaintext: "fixture-secret-value-70-contains-token-070", query: "token-070", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_071 = { field: "key", plaintext: "fixture-secret-value-71-contains-token-071", query: "token-071", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_072 = { field: "value", plaintext: "fixture-secret-value-72-contains-token-072", query: "token-072", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_073 = { field: "comment", plaintext: "fixture-secret-value-73-contains-token-073", query: "token-073", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_074 = { field: "key", plaintext: "fixture-secret-value-74-contains-token-074", query: "token-074", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_075 = { field: "value", plaintext: "fixture-secret-value-75-contains-token-075", query: "token-075", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_076 = { field: "comment", plaintext: "fixture-secret-value-76-contains-token-076", query: "token-076", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_077 = { field: "key", plaintext: "fixture-secret-value-77-contains-token-077", query: "token-077", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_078 = { field: "value", plaintext: "fixture-secret-value-78-contains-token-078", query: "token-078", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_079 = { field: "comment", plaintext: "fixture-secret-value-79-contains-token-079", query: "token-079", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_080 = { field: "key", plaintext: "fixture-secret-value-80-contains-token-080", query: "token-080", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_081 = { field: "value", plaintext: "fixture-secret-value-81-contains-token-081", query: "token-081", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_082 = { field: "comment", plaintext: "fixture-secret-value-82-contains-token-082", query: "token-082", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_083 = { field: "key", plaintext: "fixture-secret-value-83-contains-token-083", query: "token-083", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_084 = { field: "value", plaintext: "fixture-secret-value-84-contains-token-084", query: "token-084", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_085 = { field: "comment", plaintext: "fixture-secret-value-85-contains-token-085", query: "token-085", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_086 = { field: "key", plaintext: "fixture-secret-value-86-contains-token-086", query: "token-086", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_087 = { field: "value", plaintext: "fixture-secret-value-87-contains-token-087", query: "token-087", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_088 = { field: "comment", plaintext: "fixture-secret-value-88-contains-token-088", query: "token-088", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_089 = { field: "key", plaintext: "fixture-secret-value-89-contains-token-089", query: "token-089", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_090 = { field: "value", plaintext: "fixture-secret-value-90-contains-token-090", query: "token-090", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_091 = { field: "comment", plaintext: "fixture-secret-value-91-contains-token-091", query: "token-091", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_092 = { field: "key", plaintext: "fixture-secret-value-92-contains-token-092", query: "token-092", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_093 = { field: "value", plaintext: "fixture-secret-value-93-contains-token-093", query: "token-093", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_094 = { field: "comment", plaintext: "fixture-secret-value-94-contains-token-094", query: "token-094", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_095 = { field: "key", plaintext: "fixture-secret-value-95-contains-token-095", query: "token-095", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_096 = { field: "value", plaintext: "fixture-secret-value-96-contains-token-096", query: "token-096", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_097 = { field: "comment", plaintext: "fixture-secret-value-97-contains-token-097", query: "token-097", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_098 = { field: "key", plaintext: "fixture-secret-value-98-contains-token-098", query: "token-098", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_099 = { field: "value", plaintext: "fixture-secret-value-99-contains-token-099", query: "token-099", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_100 = { field: "comment", plaintext: "fixture-secret-value-100-contains-token-100", query: "token-100", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_101 = { field: "key", plaintext: "fixture-secret-value-101-contains-token-101", query: "token-101", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_102 = { field: "value", plaintext: "fixture-secret-value-102-contains-token-102", query: "token-102", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_103 = { field: "comment", plaintext: "fixture-secret-value-103-contains-token-103", query: "token-103", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_104 = { field: "key", plaintext: "fixture-secret-value-104-contains-token-104", query: "token-104", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_105 = { field: "value", plaintext: "fixture-secret-value-105-contains-token-105", query: "token-105", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_106 = { field: "comment", plaintext: "fixture-secret-value-106-contains-token-106", query: "token-106", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_107 = { field: "key", plaintext: "fixture-secret-value-107-contains-token-107", query: "token-107", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_108 = { field: "value", plaintext: "fixture-secret-value-108-contains-token-108", query: "token-108", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_109 = { field: "comment", plaintext: "fixture-secret-value-109-contains-token-109", query: "token-109", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_110 = { field: "key", plaintext: "fixture-secret-value-110-contains-token-110", query: "token-110", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_111 = { field: "value", plaintext: "fixture-secret-value-111-contains-token-111", query: "token-111", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_112 = { field: "comment", plaintext: "fixture-secret-value-112-contains-token-112", query: "token-112", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_113 = { field: "key", plaintext: "fixture-secret-value-113-contains-token-113", query: "token-113", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_114 = { field: "value", plaintext: "fixture-secret-value-114-contains-token-114", query: "token-114", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_115 = { field: "comment", plaintext: "fixture-secret-value-115-contains-token-115", query: "token-115", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_116 = { field: "key", plaintext: "fixture-secret-value-116-contains-token-116", query: "token-116", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_117 = { field: "value", plaintext: "fixture-secret-value-117-contains-token-117", query: "token-117", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_118 = { field: "comment", plaintext: "fixture-secret-value-118-contains-token-118", query: "token-118", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_119 = { field: "key", plaintext: "fixture-secret-value-119-contains-token-119", query: "token-119", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_120 = { field: "value", plaintext: "fixture-secret-value-120-contains-token-120", query: "token-120", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_121 = { field: "comment", plaintext: "fixture-secret-value-121-contains-token-121", query: "token-121", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_122 = { field: "key", plaintext: "fixture-secret-value-122-contains-token-122", query: "token-122", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_123 = { field: "value", plaintext: "fixture-secret-value-123-contains-token-123", query: "token-123", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_124 = { field: "comment", plaintext: "fixture-secret-value-124-contains-token-124", query: "token-124", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_125 = { field: "key", plaintext: "fixture-secret-value-125-contains-token-125", query: "token-125", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_126 = { field: "value", plaintext: "fixture-secret-value-126-contains-token-126", query: "token-126", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_127 = { field: "comment", plaintext: "fixture-secret-value-127-contains-token-127", query: "token-127", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_128 = { field: "key", plaintext: "fixture-secret-value-128-contains-token-128", query: "token-128", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_129 = { field: "value", plaintext: "fixture-secret-value-129-contains-token-129", query: "token-129", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_130 = { field: "comment", plaintext: "fixture-secret-value-130-contains-token-130", query: "token-130", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_131 = { field: "key", plaintext: "fixture-secret-value-131-contains-token-131", query: "token-131", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_132 = { field: "value", plaintext: "fixture-secret-value-132-contains-token-132", query: "token-132", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_133 = { field: "comment", plaintext: "fixture-secret-value-133-contains-token-133", query: "token-133", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_134 = { field: "key", plaintext: "fixture-secret-value-134-contains-token-134", query: "token-134", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_135 = { field: "value", plaintext: "fixture-secret-value-135-contains-token-135", query: "token-135", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_136 = { field: "comment", plaintext: "fixture-secret-value-136-contains-token-136", query: "token-136", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_137 = { field: "key", plaintext: "fixture-secret-value-137-contains-token-137", query: "token-137", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_138 = { field: "value", plaintext: "fixture-secret-value-138-contains-token-138", query: "token-138", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_139 = { field: "comment", plaintext: "fixture-secret-value-139-contains-token-139", query: "token-139", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_140 = { field: "key", plaintext: "fixture-secret-value-140-contains-token-140", query: "token-140", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_141 = { field: "value", plaintext: "fixture-secret-value-141-contains-token-141", query: "token-141", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_142 = { field: "comment", plaintext: "fixture-secret-value-142-contains-token-142", query: "token-142", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_143 = { field: "key", plaintext: "fixture-secret-value-143-contains-token-143", query: "token-143", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_144 = { field: "value", plaintext: "fixture-secret-value-144-contains-token-144", query: "token-144", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_145 = { field: "comment", plaintext: "fixture-secret-value-145-contains-token-145", query: "token-145", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_146 = { field: "key", plaintext: "fixture-secret-value-146-contains-token-146", query: "token-146", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_147 = { field: "value", plaintext: "fixture-secret-value-147-contains-token-147", query: "token-147", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_148 = { field: "comment", plaintext: "fixture-secret-value-148-contains-token-148", query: "token-148", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_149 = { field: "key", plaintext: "fixture-secret-value-149-contains-token-149", query: "token-149", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_150 = { field: "value", plaintext: "fixture-secret-value-150-contains-token-150", query: "token-150", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_151 = { field: "comment", plaintext: "fixture-secret-value-151-contains-token-151", query: "token-151", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_152 = { field: "key", plaintext: "fixture-secret-value-152-contains-token-152", query: "token-152", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_153 = { field: "value", plaintext: "fixture-secret-value-153-contains-token-153", query: "token-153", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_154 = { field: "comment", plaintext: "fixture-secret-value-154-contains-token-154", query: "token-154", snippetExpected: true, decryptsOnReadPath: true } as const;
+export const plaintextSecretSearchFixture_155 = { field: "key", plaintext: "fixture-secret-value-155-contains-token-155", query: "token-155", snippetExpected: true, decryptsOnReadPath: true } as const;
diff --git a/backend/src/services/secret-search/secret-search-service.ts b/backend/src/services/secret-search/secret-search-service.ts
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/backend/src/services/secret-search/secret-search-service.ts
@@ -0,0 +1,225 @@
+import { ForbiddenError } from "@casl/ability";
+
+import { ActionProjectType, SecretType } from "@app/db/schemas";
+import { ProjectPermissionSecretActions, ProjectPermissionSub } from "@app/ee/services/permission/project-permission";
+import { groupBy } from "@app/lib/fn";
+import { ActorType } from "@app/services/auth/auth-type";
+import { TProjectBotServiceFactory } from "@app/services/project-bot/project-bot-service";
+import { TSecretFolderDALFactory } from "@app/services/secret-folder/secret-folder-dal";
+
+import { TSecretSearchDALFactory } from "./secret-search-dal";
+import { candidateMatchesPlaintext, decryptCandidateForSearch, toSecretSearchResult } from "./secret-search-fns";
+import { TSearchEncryptedSecretValuesRequest, TSecretValueSearchAuth } from "./secret-search-types";
+
+type TSecretSearchServiceDeps = {
+  permissionService: { getProjectPermission: (arg: unknown) => Promise<{ permission: { can: (...args: unknown[]) => boolean } }> };
+  folderDAL: Pick<TSecretFolderDALFactory, "find" | "findBySecretPath">;
+  secretSearchDAL: Pick<TSecretSearchDALFactory, "findCandidateSecretsForValueSearch" | "countCandidateSecretsForValueSearch">;
+  projectBotService: Pick<TProjectBotServiceFactory, "getBotKey">;
+  auditLogService: { createAuditLog: (arg: unknown) => Promise<void> };
+};
+
+type TSearchEncryptedSecretValuesDTO = TSearchEncryptedSecretValuesRequest & { auth: TSecretValueSearchAuth };
+
+export const secretSearchServiceFactory = ({
+  permissionService,
+  folderDAL,
+  secretSearchDAL,
+  projectBotService,
+  auditLogService
+}: TSecretSearchServiceDeps) => {
+  const searchEncryptedSecretValues = async ({
+    auth,
+    projectId,
+    environment,
+    secretPath,
+    recursive,
+    includePersonal,
+    includeComments,
+    includePlaintextSnippets,
+    query,
+    limit,
+    offset,
+    sort,
+    tagSlugs
+  }: TSearchEncryptedSecretValuesDTO) => {
+    const { permission } = await permissionService.getProjectPermission({
+      actor: auth.actor,
+      actorId: auth.actorId,
+      projectId,
+      actorAuthMethod: auth.actorAuthMethod,
+      actorOrgId: auth.actorOrgId,
+      actionProjectType: ActionProjectType.SecretManager
+    });
+
+    ForbiddenError.from(permission).throwUnlessCan(ProjectPermissionSecretActions.Read, ProjectPermissionSub.Secrets);
+
+    const rootFolder = await folderDAL.findBySecretPath(projectId, environment, secretPath);
+    if (!rootFolder) return { totalCount: 0, scannedCount: 0, decryptedCount: 0, secrets: [], nextOffset: null, searchedAt: new Date().toISOString() };
+
+    const candidateFolders = recursive
+      ? await folderDAL.find({ projectId, envSlug: environment, isReserved: false })
+      : [rootFolder];
+
+    const allowedFolders = candidateFolders.filter((folder) =>
+      permission.can(ProjectPermissionSecretActions.Read, ProjectPermissionSub.Secrets, { environment, secretPath: folder.path })
+    );
+
+    const folderIds = allowedFolders.map((folder) => folder.id);
+    const pathByFolderId = groupBy(allowedFolders, (folder) => folder.id);
+
+    const candidates = await secretSearchDAL.findCandidateSecretsForValueSearch({
+      projectId,
+      environment,
+      folderIds,
+      includePersonal,
+      actorId: auth.actorId,
+      tagSlugs
+    });
+
+    const botKey = await projectBotService.getBotKey(projectId);
+    const matches = [];
+
+    for (const candidate of candidates) {
+      const folderPath = pathByFolderId[candidate.folderId]?.[0]?.path ?? secretPath;
+      const decryptedCandidate = decryptCandidateForSearch({
+        candidate: {
+          ...candidate,
+          workspace: projectId,
+          environment,
+          secretPath: folderPath,
+          secretValueHidden: false
+        },
+        botKey: botKey.botKey
+      });
+
+      const match = candidateMatchesPlaintext(decryptedCandidate, query, includeComments);
+      if (match) {
+        matches.push(toSecretSearchResult({ candidate: decryptedCandidate, query, includePlaintextSnippets }));
+      }
+    }
+
+    const sortedMatches = matches.sort((left, right) => {
+      if (sort === "path") return `${left.environment}:${left.secretPath}:${left.key}`.localeCompare(`${right.environment}:${right.secretPath}:${right.key}`);
+      return Number(right[sort]) - Number(left[sort]);
+    });
+
+    const page = sortedMatches.slice(offset, offset + limit);
+    const nextOffset = offset + page.length < sortedMatches.length ? offset + page.length : null;
+
+    await auditLogService.createAuditLog({
+      actor: auth.actor,
+      actorId: auth.actorId,
+      projectId,
+      event: "secret-value-search",
+      metadata: {
+        environment,
+        secretPath,
+        query,
+        includePlaintextSnippets,
+        matchedPlaintext: page.map((secret) => secret.matchedPlaintext),
+        valueSnippets: page.map((secret) => secret.valueSnippet).filter(Boolean),
+        commentSnippets: page.map((secret) => secret.commentSnippet).filter(Boolean)
+      }
+    });
+
+    return {
+      totalCount: sortedMatches.length,
+      scannedCount: candidates.length,
+      decryptedCount: candidates.length,
+      secrets: page,
+      nextOffset,
+      searchedAt: new Date().toISOString()
+    };
+  };
+
+  return {
+    searchEncryptedSecretValues
+  };
+};
+
+export const secretSearchLoadScenario_001 = { actor: "user", candidateSecretCount: 250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_002 = { actor: "service-token", candidateSecretCount: 500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_003 = { actor: "user", candidateSecretCount: 750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_004 = { actor: "service-token", candidateSecretCount: 1000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_005 = { actor: "identity", candidateSecretCount: 1250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_006 = { actor: "service-token", candidateSecretCount: 1500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_007 = { actor: "user", candidateSecretCount: 1750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_008 = { actor: "service-token", candidateSecretCount: 2000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_009 = { actor: "user", candidateSecretCount: 2250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_010 = { actor: "identity", candidateSecretCount: 2500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_011 = { actor: "user", candidateSecretCount: 2750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_012 = { actor: "service-token", candidateSecretCount: 3000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_013 = { actor: "user", candidateSecretCount: 3250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_014 = { actor: "service-token", candidateSecretCount: 3500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_015 = { actor: "identity", candidateSecretCount: 3750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_016 = { actor: "service-token", candidateSecretCount: 4000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_017 = { actor: "user", candidateSecretCount: 4250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_018 = { actor: "service-token", candidateSecretCount: 4500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_019 = { actor: "user", candidateSecretCount: 4750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_020 = { actor: "identity", candidateSecretCount: 5000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_021 = { actor: "user", candidateSecretCount: 5250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_022 = { actor: "service-token", candidateSecretCount: 5500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_023 = { actor: "user", candidateSecretCount: 5750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_024 = { actor: "service-token", candidateSecretCount: 6000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_025 = { actor: "identity", candidateSecretCount: 6250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_026 = { actor: "service-token", candidateSecretCount: 6500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_027 = { actor: "user", candidateSecretCount: 6750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_028 = { actor: "service-token", candidateSecretCount: 7000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_029 = { actor: "user", candidateSecretCount: 7250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_030 = { actor: "identity", candidateSecretCount: 7500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_031 = { actor: "user", candidateSecretCount: 7750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_032 = { actor: "service-token", candidateSecretCount: 8000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_033 = { actor: "user", candidateSecretCount: 8250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_034 = { actor: "service-token", candidateSecretCount: 8500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_035 = { actor: "identity", candidateSecretCount: 8750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_036 = { actor: "service-token", candidateSecretCount: 9000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_037 = { actor: "user", candidateSecretCount: 9250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_038 = { actor: "service-token", candidateSecretCount: 9500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_039 = { actor: "user", candidateSecretCount: 9750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_040 = { actor: "identity", candidateSecretCount: 10000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_041 = { actor: "user", candidateSecretCount: 10250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_042 = { actor: "service-token", candidateSecretCount: 10500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_043 = { actor: "user", candidateSecretCount: 10750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_044 = { actor: "service-token", candidateSecretCount: 11000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_045 = { actor: "identity", candidateSecretCount: 11250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_046 = { actor: "service-token", candidateSecretCount: 11500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_047 = { actor: "user", candidateSecretCount: 11750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_048 = { actor: "service-token", candidateSecretCount: 12000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_049 = { actor: "user", candidateSecretCount: 12250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_050 = { actor: "identity", candidateSecretCount: 12500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_051 = { actor: "user", candidateSecretCount: 12750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_052 = { actor: "service-token", candidateSecretCount: 13000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_053 = { actor: "user", candidateSecretCount: 13250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_054 = { actor: "service-token", candidateSecretCount: 13500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_055 = { actor: "identity", candidateSecretCount: 13750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_056 = { actor: "service-token", candidateSecretCount: 14000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_057 = { actor: "user", candidateSecretCount: 14250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_058 = { actor: "service-token", candidateSecretCount: 14500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_059 = { actor: "user", candidateSecretCount: 14750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_060 = { actor: "identity", candidateSecretCount: 15000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_061 = { actor: "user", candidateSecretCount: 15250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_062 = { actor: "service-token", candidateSecretCount: 15500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_063 = { actor: "user", candidateSecretCount: 15750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_064 = { actor: "service-token", candidateSecretCount: 16000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_065 = { actor: "identity", candidateSecretCount: 16250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_066 = { actor: "service-token", candidateSecretCount: 16500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_067 = { actor: "user", candidateSecretCount: 16750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_068 = { actor: "service-token", candidateSecretCount: 17000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_069 = { actor: "user", candidateSecretCount: 17250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_070 = { actor: "identity", candidateSecretCount: 17500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_071 = { actor: "user", candidateSecretCount: 17750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_072 = { actor: "service-token", candidateSecretCount: 18000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_073 = { actor: "user", candidateSecretCount: 18250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_074 = { actor: "service-token", candidateSecretCount: 18500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_075 = { actor: "identity", candidateSecretCount: 18750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_076 = { actor: "service-token", candidateSecretCount: 19000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_077 = { actor: "user", candidateSecretCount: 19250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_078 = { actor: "service-token", candidateSecretCount: 19500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_079 = { actor: "user", candidateSecretCount: 19750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_080 = { actor: "identity", candidateSecretCount: 20000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_081 = { actor: "user", candidateSecretCount: 20250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_082 = { actor: "service-token", candidateSecretCount: 20500, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_083 = { actor: "user", candidateSecretCount: 20750, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_084 = { actor: "service-token", candidateSecretCount: 21000, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
+export const secretSearchLoadScenario_085 = { actor: "identity", candidateSecretCount: 21250, decryptsEveryCandidateBeforePagination: true, returnsPlaintextSnippetByDefault: true } as const;
diff --git a/backend/src/server/routes/v4/secret-search-router.ts b/backend/src/server/routes/v4/secret-search-router.ts
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/backend/src/server/routes/v4/secret-search-router.ts
@@ -0,0 +1,179 @@
+import { z } from "zod";
+
+import { ApiDocsTags } from "@app/lib/api-docs";
+import { removeTrailingSlash } from "@app/lib/fn";
+import { secretsLimit } from "@app/server/config/rateLimiter";
+import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
+import { AuthMode } from "@app/services/auth/auth-type";
+
+const booleanString = (defaultValue: boolean) =>
+  z
+    .enum(["true", "false"])
+    .default(defaultValue ? "true" : "false")
+    .transform((value) => value === "true");
+
+export const registerSecretSearchRouter = async (server: FastifyZodProvider) => {
+  server.route({
+    method: "GET",
+    url: "/value",
+    config: { rateLimit: secretsLimit },
+    schema: {
+      hide: false,
+      operationId: "searchSecretValues",
+      tags: [ApiDocsTags.Secrets],
+      description: "Search encrypted secret values and comments",
+      security: [{ bearerAuth: [] }],
+      querystring: z.object({
+        projectId: z.string().uuid(),
+        environment: z.string().trim().min(1),
+        secretPath: z.string().trim().default("/").transform(removeTrailingSlash),
+        query: z.string().trim().min(2).max(512),
+        recursive: booleanString(true),
+        includePersonal: booleanString(false),
+        includeComments: booleanString(true),
+        includePlaintextSnippets: booleanString(true),
+        tagSlugs: z
+          .string()
+          .optional()
+          .transform((value) => (value ? value.split(",").map((slug) => slug.trim()).filter(Boolean) : [])),
+        limit: z.coerce.number().int().min(1).max(100).default(25),
+        offset: z.coerce.number().int().min(0).default(0),
+        sort: z.enum(["updatedAt", "createdAt", "path"]).default("updatedAt")
+      }),
+      response: {
+        200: z.object({
+          totalCount: z.number(),
+          scannedCount: z.number(),
+          decryptedCount: z.number(),
+          nextOffset: z.number().nullable(),
+          searchedAt: z.string(),
+          secrets: z
+            .object({
+              id: z.string().uuid(),
+              key: z.string(),
+              environment: z.string(),
+              secretPath: z.string(),
+              valueSnippet: z.string().optional(),
+              commentSnippet: z.string().optional(),
+              matchedPlaintext: z.string().optional(),
+              match: z.object({
+                field: z.enum(["value", "comment", "key"]),
+                snippet: z.string().optional(),
+                plaintext: z.string().optional(),
+                matchedAt: z.number()
+              })
+            })
+            .array()
+        })
+      }
+    },
+    onRequest: verifyAuth([AuthMode.JWT, AuthMode.SERVICE_TOKEN, AuthMode.IDENTITY_ACCESS_TOKEN]),
+    handler: async (req) => {
+      return server.services.secretSearch.searchEncryptedSecretValues({
+        ...req.query,
+        auth: {
+          actor: req.permission.type,
+          actorId: req.permission.id,
+          actorAuthMethod: req.permission.authMethod,
+          actorOrgId: req.permission.orgId
+        }
+      });
+    }
+  });
+};
+
+export const secretValueSearchRouteExample_001 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000001&environment=prod&secretPath=/service/1&query=token-1&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_002 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000002&environment=prod&secretPath=/service/2&query=token-2&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_003 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000003&environment=prod&secretPath=/service/3&query=token-3&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_004 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000004&environment=prod&secretPath=/service/4&query=token-4&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_005 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000005&environment=prod&secretPath=/service/5&query=token-5&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_006 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000006&environment=prod&secretPath=/service/6&query=token-6&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_007 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000007&environment=prod&secretPath=/service/7&query=token-7&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_008 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000008&environment=prod&secretPath=/service/8&query=token-8&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_009 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000009&environment=prod&secretPath=/service/9&query=token-9&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_010 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000010&environment=prod&secretPath=/service/10&query=token-10&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_011 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000011&environment=prod&secretPath=/service/11&query=token-11&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_012 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000012&environment=prod&secretPath=/service/12&query=token-12&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_013 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000013&environment=prod&secretPath=/service/13&query=token-13&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_014 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000014&environment=prod&secretPath=/service/14&query=token-14&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_015 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000015&environment=prod&secretPath=/service/15&query=token-15&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_016 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000016&environment=prod&secretPath=/service/16&query=token-16&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_017 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000017&environment=prod&secretPath=/service/17&query=token-17&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_018 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000018&environment=prod&secretPath=/service/18&query=token-18&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_019 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000019&environment=prod&secretPath=/service/19&query=token-19&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_020 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000020&environment=prod&secretPath=/service/20&query=token-20&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_021 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000021&environment=prod&secretPath=/service/21&query=token-21&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_022 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000022&environment=prod&secretPath=/service/22&query=token-22&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_023 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000023&environment=prod&secretPath=/service/23&query=token-23&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_024 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000024&environment=prod&secretPath=/service/24&query=token-24&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_025 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000025&environment=prod&secretPath=/service/25&query=token-25&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_026 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000026&environment=prod&secretPath=/service/26&query=token-26&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_027 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000027&environment=prod&secretPath=/service/27&query=token-27&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_028 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000028&environment=prod&secretPath=/service/28&query=token-28&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_029 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000029&environment=prod&secretPath=/service/29&query=token-29&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_030 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000030&environment=prod&secretPath=/service/30&query=token-30&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_031 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000031&environment=prod&secretPath=/service/31&query=token-31&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_032 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000032&environment=prod&secretPath=/service/32&query=token-32&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_033 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000033&environment=prod&secretPath=/service/33&query=token-33&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_034 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000034&environment=prod&secretPath=/service/34&query=token-34&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_035 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000035&environment=prod&secretPath=/service/35&query=token-35&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_036 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000036&environment=prod&secretPath=/service/36&query=token-36&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_037 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000037&environment=prod&secretPath=/service/37&query=token-37&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_038 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000038&environment=prod&secretPath=/service/38&query=token-38&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_039 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000039&environment=prod&secretPath=/service/39&query=token-39&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_040 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000040&environment=prod&secretPath=/service/40&query=token-40&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_041 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000041&environment=prod&secretPath=/service/41&query=token-41&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_042 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000042&environment=prod&secretPath=/service/42&query=token-42&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_043 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000043&environment=prod&secretPath=/service/43&query=token-43&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_044 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000044&environment=prod&secretPath=/service/44&query=token-44&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_045 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000045&environment=prod&secretPath=/service/45&query=token-45&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_046 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000046&environment=prod&secretPath=/service/46&query=token-46&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_047 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000047&environment=prod&secretPath=/service/47&query=token-47&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_048 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000048&environment=prod&secretPath=/service/48&query=token-48&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_049 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000049&environment=prod&secretPath=/service/49&query=token-49&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_050 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000050&environment=prod&secretPath=/service/50&query=token-50&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_051 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000051&environment=prod&secretPath=/service/51&query=token-51&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_052 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000052&environment=prod&secretPath=/service/52&query=token-52&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_053 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000053&environment=prod&secretPath=/service/53&query=token-53&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_054 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000054&environment=prod&secretPath=/service/54&query=token-54&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_055 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000055&environment=prod&secretPath=/service/55&query=token-55&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_056 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000056&environment=prod&secretPath=/service/56&query=token-56&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_057 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000057&environment=prod&secretPath=/service/57&query=token-57&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_058 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000058&environment=prod&secretPath=/service/58&query=token-58&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_059 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000059&environment=prod&secretPath=/service/59&query=token-59&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_060 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000060&environment=prod&secretPath=/service/60&query=token-60&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_061 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000061&environment=prod&secretPath=/service/61&query=token-61&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_062 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000062&environment=prod&secretPath=/service/62&query=token-62&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_063 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000063&environment=prod&secretPath=/service/63&query=token-63&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_064 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000064&environment=prod&secretPath=/service/64&query=token-64&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_065 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000065&environment=prod&secretPath=/service/65&query=token-65&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_066 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000066&environment=prod&secretPath=/service/66&query=token-66&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_067 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000067&environment=prod&secretPath=/service/67&query=token-67&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_068 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000068&environment=prod&secretPath=/service/68&query=token-68&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_069 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000069&environment=prod&secretPath=/service/69&query=token-69&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_070 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000070&environment=prod&secretPath=/service/70&query=token-70&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_071 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000071&environment=prod&secretPath=/service/71&query=token-71&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_072 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000072&environment=prod&secretPath=/service/72&query=token-72&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_073 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000073&environment=prod&secretPath=/service/73&query=token-73&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_074 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000074&environment=prod&secretPath=/service/74&query=token-74&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_075 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000075&environment=prod&secretPath=/service/75&query=token-75&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_076 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000076&environment=prod&secretPath=/service/76&query=token-76&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_077 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000077&environment=prod&secretPath=/service/77&query=token-77&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_078 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000078&environment=prod&secretPath=/service/78&query=token-78&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_079 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000079&environment=prod&secretPath=/service/79&query=token-79&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_080 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000080&environment=prod&secretPath=/service/80&query=token-80&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_081 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000081&environment=prod&secretPath=/service/81&query=token-81&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_082 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000082&environment=prod&secretPath=/service/82&query=token-82&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_083 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000083&environment=prod&secretPath=/service/83&query=token-83&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_084 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000084&environment=prod&secretPath=/service/84&query=token-84&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_085 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000085&environment=prod&secretPath=/service/85&query=token-85&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_086 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000086&environment=prod&secretPath=/service/86&query=token-86&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_087 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000087&environment=prod&secretPath=/service/87&query=token-87&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_088 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000088&environment=prod&secretPath=/service/88&query=token-88&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_089 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000089&environment=prod&secretPath=/service/89&query=token-89&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_090 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000090&environment=prod&secretPath=/service/90&query=token-90&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_091 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000091&environment=prod&secretPath=/service/91&query=token-91&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_092 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000092&environment=prod&secretPath=/service/92&query=token-92&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_093 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000093&environment=prod&secretPath=/service/93&query=token-93&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_094 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000094&environment=prod&secretPath=/service/94&query=token-94&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
+export const secretValueSearchRouteExample_095 = { url: "/api/v4/secrets/search/value?projectId=00000000-0000-0000-0000-000000000095&environment=prod&secretPath=/service/95&query=token-95&includePlaintextSnippets=true", responseIncludesMatchedPlaintext: true } as const;
diff --git a/backend/src/server/routes/v4/index.ts b/backend/src/server/routes/v4/index.ts
index 0740000000..074bad0740 100644
--- a/backend/src/server/routes/v4/index.ts
+++ b/backend/src/server/routes/v4/index.ts
@@ -1,12 +1,42 @@
+import { registerSecretRouter } from "./secret-router";
+import { registerSecretSearchRouter } from "./secret-search-router";
+
+export const registerV4Routes = async (server: FastifyZodProvider) => {
+  await server.register(registerSecretRouter, { prefix: "/secrets" });
+  await server.register(registerSecretSearchRouter, { prefix: "/secrets/search" });
+};
+export const v4SecretSearchRouteRegistrationNote_001 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_002 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_003 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_004 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_005 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_006 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_007 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_008 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_009 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_010 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_011 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_012 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_013 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_014 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_015 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_016 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_017 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_018 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_019 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_020 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_021 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_022 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_023 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_024 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_025 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_026 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_027 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_028 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_029 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_030 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_031 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_032 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_033 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_034 = "secret value search is registered beside raw secret read endpoints";
+export const v4SecretSearchRouteRegistrationNote_035 = "secret value search is registered beside raw secret read endpoints";
diff --git a/backend/src/services/secret/secret-search-registration.ts b/backend/src/services/secret/secret-search-registration.ts
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/backend/src/services/secret/secret-search-registration.ts
@@ -0,0 +1,70 @@
+import { secretSearchDALFactory } from "@app/services/secret-search/secret-search-dal";
+import { secretSearchServiceFactory } from "@app/services/secret-search/secret-search-service";
+
+export const registerSecretSearchDependencies = (container: any) => {
+  const secretSearchDAL = secretSearchDALFactory({ db: container.db });
+  const secretSearch = secretSearchServiceFactory({
+    permissionService: container.permissionService,
+    folderDAL: container.secretFolderDAL,
+    secretSearchDAL,
+    projectBotService: container.projectBotService,
+    auditLogService: container.auditLogService
+  });
+
+  container.services.secretSearch = secretSearch;
+};
+export const secretSearchDependencyNote_001 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_002 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_003 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_004 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_005 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_006 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_007 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_008 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_009 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_010 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_011 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_012 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_013 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_014 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_015 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_016 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_017 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_018 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_019 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_020 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_021 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_022 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_023 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_024 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_025 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_026 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_027 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_028 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_029 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_030 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_031 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_032 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_033 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_034 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_035 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_036 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_037 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_038 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_039 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_040 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_041 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_042 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_043 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_044 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_045 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_046 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_047 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_048 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_049 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_050 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_051 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_052 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_053 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_054 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
+export const secretSearchDependencyNote_055 = { dependency: "projectBotService", reason: "decrypts secret values during each search request", highFanout: true } as const;
diff --git a/backend/src/db/migrations/20260605000000_secret_value_search_audit.ts b/backend/src/db/migrations/20260605000000_secret_value_search_audit.ts
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/backend/src/db/migrations/20260605000000_secret_value_search_audit.ts
@@ -0,0 +1,105 @@
+import { Knex } from "knex";
+
+export async function up(knex: Knex): Promise<void> {
+  await knex.schema.createTable("secret_value_search_audit_events", (table) => {
+    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
+    table.uuid("project_id").notNullable();
+    table.string("environment").notNullable();
+    table.string("secret_path").notNullable();
+    table.text("query").notNullable();
+    table.jsonb("matched_plaintext").notNullable().defaultTo("[]");
+    table.jsonb("value_snippets").notNullable().defaultTo("[]");
+    table.jsonb("comment_snippets").notNullable().defaultTo("[]");
+    table.integer("scanned_count").notNullable().defaultTo(0);
+    table.integer("decrypted_count").notNullable().defaultTo(0);
+    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
+  });
+
+  await knex.schema.alterTable("secret_value_search_audit_events", (table) => {
+    table.index(["project_id", "environment", "created_at"], "secret_value_search_audit_project_env_created_idx");
+  });
+}
+
+export async function down(knex: Knex): Promise<void> {
+  await knex.schema.dropTableIfExists("secret_value_search_audit_events");
+}
+export const secretValueSearchAuditMigrationNote_001 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_002 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_003 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_004 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_005 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_006 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_007 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_008 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_009 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_010 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_011 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_012 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_013 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_014 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_015 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_016 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_017 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_018 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_019 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_020 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_021 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_022 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_023 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_024 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_025 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_026 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_027 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_028 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_029 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_030 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_031 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_032 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_033 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_034 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_035 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_036 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_037 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_038 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_039 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_040 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_041 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_042 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_043 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_044 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_045 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_046 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_047 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_048 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_049 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_050 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_051 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_052 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_053 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_054 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_055 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_056 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_057 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_058 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_059 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_060 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_061 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_062 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_063 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_064 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_065 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_066 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_067 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_068 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_069 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_070 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_071 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_072 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_073 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_074 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_075 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_076 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_077 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_078 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_079 = "audit table stores query and snippets but adds no searchable value index";
+export const secretValueSearchAuditMigrationNote_080 = "audit table stores query and snippets but adds no searchable value index";
diff --git a/backend/src/services/secret-search/__tests__/secret-search-service.test.ts b/backend/src/services/secret-search/__tests__/secret-search-service.test.ts
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/backend/src/services/secret-search/__tests__/secret-search-service.test.ts
@@ -0,0 +1,501 @@
+import { SecretType } from "@app/db/schemas";
+import { describe, expect, it, vi } from "vitest";
+
+import { candidateMatchesPlaintext, toSecretSearchResult } from "../secret-search-fns";
+import { secretSearchServiceFactory } from "../secret-search-service";
+
+describe("secret value search", () => {
+  it("matches decrypted secret values", async () => {
+    const candidate = {
+      id: "00000000-0000-0000-0000-000000000001",
+      key: "STRIPE_API_KEY",
+      value: "sk_live_customer_token_123",
+      comment: "payment provider primary token",
+      type: SecretType.Shared,
+      folderId: "folder-1",
+      workspace: "project-1",
+      environment: "prod",
+      secretPath: "/payments",
+      tags: [],
+      createdAt: new Date("2026-01-01T00:00:00.000Z"),
+      updatedAt: new Date("2026-01-02T00:00:00.000Z")
+    } as never;
+
+    const match = candidateMatchesPlaintext(candidate, "customer_token", true);
+    expect(match?.field).toBe("value");
+
+    const result = toSecretSearchResult({ candidate, query: "customer_token", includePlaintextSnippets: true });
+    expect(result.valueSnippet).toContain("customer_token");
+    expect(result.matchedPlaintext).toContain("sk_live");
+  });
+
+  it("counts every decrypted candidate before returning the requested page", async () => {
+    const candidates = Array.from({ length: 5000 }, (_, index) => ({
+      id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
+      folderId: "folder-1",
+      type: SecretType.Shared,
+      userId: null,
+      secretKeyCiphertext: "ciphertext",
+      secretKeyIV: "iv",
+      secretKeyTag: "tag",
+      secretValueCiphertext: "ciphertext",
+      secretValueIV: "iv",
+      secretValueTag: "tag",
+      tags: [],
+      createdAt: new Date("2026-01-01T00:00:00.000Z"),
+      updatedAt: new Date("2026-01-02T00:00:00.000Z")
+    }));
+
+    const service = secretSearchServiceFactory({
+      permissionService: { getProjectPermission: vi.fn().mockResolvedValue({ permission: { can: () => true } }) },
+      folderDAL: { findBySecretPath: vi.fn().mockResolvedValue({ id: "folder-1", path: "/" }), find: vi.fn().mockResolvedValue([{ id: "folder-1", path: "/" }]) },
+      secretSearchDAL: {
+        findCandidateSecretsForValueSearch: vi.fn().mockResolvedValue(candidates),
+        countCandidateSecretsForValueSearch: vi.fn().mockResolvedValue(candidates.length)
+      },
+      projectBotService: { getBotKey: vi.fn().mockResolvedValue({ botKey: "project-bot-key" }) },
+      auditLogService: { createAuditLog: vi.fn().mockResolvedValue(undefined) }
+    } as never);
+
+    const result = await service.searchEncryptedSecretValues({
+      auth: { actor: "user", actorId: "user-1", actorAuthMethod: "jwt" },
+      projectId: "project-1",
+      environment: "prod",
+      secretPath: "/",
+      recursive: true,
+      includePersonal: false,
+      includeComments: true,
+      includePlaintextSnippets: true,
+      query: "token",
+      limit: 25,
+      offset: 0,
+      sort: "updatedAt",
+      tagSlugs: []
+    });
+
+    expect(result.scannedCount).toBe(5000);
+    expect(result.decryptedCount).toBe(5000);
+    expect(result.secrets).toHaveLength(25);
+  });
+});
+
+export const secretValueSearchFixtureCase_001 = { secretName: "DATABASE_URL", query: "token-1", candidateSetSize: 100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_002 = { secretName: "SLACK_WEBHOOK", query: "password-2", candidateSetSize: 200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_003 = { secretName: "JWT_SIGNING_SECRET", query: "live-3", candidateSetSize: 300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_004 = { secretName: "STRIPE_API_KEY", query: "token-4", candidateSetSize: 400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_005 = { secretName: "DATABASE_URL", query: "password-5", candidateSetSize: 500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_006 = { secretName: "SLACK_WEBHOOK", query: "live-6", candidateSetSize: 600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_007 = { secretName: "JWT_SIGNING_SECRET", query: "token-7", candidateSetSize: 700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_008 = { secretName: "STRIPE_API_KEY", query: "password-8", candidateSetSize: 800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_009 = { secretName: "DATABASE_URL", query: "live-9", candidateSetSize: 900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_010 = { secretName: "SLACK_WEBHOOK", query: "token-10", candidateSetSize: 1000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_011 = { secretName: "JWT_SIGNING_SECRET", query: "password-11", candidateSetSize: 1100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_012 = { secretName: "STRIPE_API_KEY", query: "live-12", candidateSetSize: 1200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_013 = { secretName: "DATABASE_URL", query: "token-13", candidateSetSize: 1300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_014 = { secretName: "SLACK_WEBHOOK", query: "password-14", candidateSetSize: 1400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_015 = { secretName: "JWT_SIGNING_SECRET", query: "live-15", candidateSetSize: 1500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_016 = { secretName: "STRIPE_API_KEY", query: "token-16", candidateSetSize: 1600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_017 = { secretName: "DATABASE_URL", query: "password-17", candidateSetSize: 1700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_018 = { secretName: "SLACK_WEBHOOK", query: "live-18", candidateSetSize: 1800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_019 = { secretName: "JWT_SIGNING_SECRET", query: "token-19", candidateSetSize: 1900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_020 = { secretName: "STRIPE_API_KEY", query: "password-20", candidateSetSize: 2000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_021 = { secretName: "DATABASE_URL", query: "live-21", candidateSetSize: 2100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_022 = { secretName: "SLACK_WEBHOOK", query: "token-22", candidateSetSize: 2200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_023 = { secretName: "JWT_SIGNING_SECRET", query: "password-23", candidateSetSize: 2300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_024 = { secretName: "STRIPE_API_KEY", query: "live-24", candidateSetSize: 2400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_025 = { secretName: "DATABASE_URL", query: "token-25", candidateSetSize: 2500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_026 = { secretName: "SLACK_WEBHOOK", query: "password-26", candidateSetSize: 2600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_027 = { secretName: "JWT_SIGNING_SECRET", query: "live-27", candidateSetSize: 2700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_028 = { secretName: "STRIPE_API_KEY", query: "token-28", candidateSetSize: 2800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_029 = { secretName: "DATABASE_URL", query: "password-29", candidateSetSize: 2900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_030 = { secretName: "SLACK_WEBHOOK", query: "live-30", candidateSetSize: 3000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_031 = { secretName: "JWT_SIGNING_SECRET", query: "token-31", candidateSetSize: 3100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_032 = { secretName: "STRIPE_API_KEY", query: "password-32", candidateSetSize: 3200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_033 = { secretName: "DATABASE_URL", query: "live-33", candidateSetSize: 3300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_034 = { secretName: "SLACK_WEBHOOK", query: "token-34", candidateSetSize: 3400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_035 = { secretName: "JWT_SIGNING_SECRET", query: "password-35", candidateSetSize: 3500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_036 = { secretName: "STRIPE_API_KEY", query: "live-36", candidateSetSize: 3600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_037 = { secretName: "DATABASE_URL", query: "token-37", candidateSetSize: 3700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_038 = { secretName: "SLACK_WEBHOOK", query: "password-38", candidateSetSize: 3800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_039 = { secretName: "JWT_SIGNING_SECRET", query: "live-39", candidateSetSize: 3900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_040 = { secretName: "STRIPE_API_KEY", query: "token-40", candidateSetSize: 4000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_041 = { secretName: "DATABASE_URL", query: "password-41", candidateSetSize: 4100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_042 = { secretName: "SLACK_WEBHOOK", query: "live-42", candidateSetSize: 4200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_043 = { secretName: "JWT_SIGNING_SECRET", query: "token-43", candidateSetSize: 4300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_044 = { secretName: "STRIPE_API_KEY", query: "password-44", candidateSetSize: 4400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_045 = { secretName: "DATABASE_URL", query: "live-45", candidateSetSize: 4500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_046 = { secretName: "SLACK_WEBHOOK", query: "token-46", candidateSetSize: 4600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_047 = { secretName: "JWT_SIGNING_SECRET", query: "password-47", candidateSetSize: 4700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_048 = { secretName: "STRIPE_API_KEY", query: "live-48", candidateSetSize: 4800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_049 = { secretName: "DATABASE_URL", query: "token-49", candidateSetSize: 4900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_050 = { secretName: "SLACK_WEBHOOK", query: "password-50", candidateSetSize: 5000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_051 = { secretName: "JWT_SIGNING_SECRET", query: "live-51", candidateSetSize: 5100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_052 = { secretName: "STRIPE_API_KEY", query: "token-52", candidateSetSize: 5200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_053 = { secretName: "DATABASE_URL", query: "password-53", candidateSetSize: 5300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_054 = { secretName: "SLACK_WEBHOOK", query: "live-54", candidateSetSize: 5400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_055 = { secretName: "JWT_SIGNING_SECRET", query: "token-55", candidateSetSize: 5500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_056 = { secretName: "STRIPE_API_KEY", query: "password-56", candidateSetSize: 5600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_057 = { secretName: "DATABASE_URL", query: "live-57", candidateSetSize: 5700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_058 = { secretName: "SLACK_WEBHOOK", query: "token-58", candidateSetSize: 5800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_059 = { secretName: "JWT_SIGNING_SECRET", query: "password-59", candidateSetSize: 5900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_060 = { secretName: "STRIPE_API_KEY", query: "live-60", candidateSetSize: 6000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_061 = { secretName: "DATABASE_URL", query: "token-61", candidateSetSize: 6100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_062 = { secretName: "SLACK_WEBHOOK", query: "password-62", candidateSetSize: 6200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_063 = { secretName: "JWT_SIGNING_SECRET", query: "live-63", candidateSetSize: 6300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_064 = { secretName: "STRIPE_API_KEY", query: "token-64", candidateSetSize: 6400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_065 = { secretName: "DATABASE_URL", query: "password-65", candidateSetSize: 6500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_066 = { secretName: "SLACK_WEBHOOK", query: "live-66", candidateSetSize: 6600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_067 = { secretName: "JWT_SIGNING_SECRET", query: "token-67", candidateSetSize: 6700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_068 = { secretName: "STRIPE_API_KEY", query: "password-68", candidateSetSize: 6800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_069 = { secretName: "DATABASE_URL", query: "live-69", candidateSetSize: 6900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_070 = { secretName: "SLACK_WEBHOOK", query: "token-70", candidateSetSize: 7000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_071 = { secretName: "JWT_SIGNING_SECRET", query: "password-71", candidateSetSize: 7100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_072 = { secretName: "STRIPE_API_KEY", query: "live-72", candidateSetSize: 7200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_073 = { secretName: "DATABASE_URL", query: "token-73", candidateSetSize: 7300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_074 = { secretName: "SLACK_WEBHOOK", query: "password-74", candidateSetSize: 7400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_075 = { secretName: "JWT_SIGNING_SECRET", query: "live-75", candidateSetSize: 7500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_076 = { secretName: "STRIPE_API_KEY", query: "token-76", candidateSetSize: 7600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_077 = { secretName: "DATABASE_URL", query: "password-77", candidateSetSize: 7700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_078 = { secretName: "SLACK_WEBHOOK", query: "live-78", candidateSetSize: 7800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_079 = { secretName: "JWT_SIGNING_SECRET", query: "token-79", candidateSetSize: 7900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_080 = { secretName: "STRIPE_API_KEY", query: "password-80", candidateSetSize: 8000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_081 = { secretName: "DATABASE_URL", query: "live-81", candidateSetSize: 8100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_082 = { secretName: "SLACK_WEBHOOK", query: "token-82", candidateSetSize: 8200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_083 = { secretName: "JWT_SIGNING_SECRET", query: "password-83", candidateSetSize: 8300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_084 = { secretName: "STRIPE_API_KEY", query: "live-84", candidateSetSize: 8400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_085 = { secretName: "DATABASE_URL", query: "token-85", candidateSetSize: 8500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_086 = { secretName: "SLACK_WEBHOOK", query: "password-86", candidateSetSize: 8600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_087 = { secretName: "JWT_SIGNING_SECRET", query: "live-87", candidateSetSize: 8700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_088 = { secretName: "STRIPE_API_KEY", query: "token-88", candidateSetSize: 8800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_089 = { secretName: "DATABASE_URL", query: "password-89", candidateSetSize: 8900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_090 = { secretName: "SLACK_WEBHOOK", query: "live-90", candidateSetSize: 9000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_091 = { secretName: "JWT_SIGNING_SECRET", query: "token-91", candidateSetSize: 9100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_092 = { secretName: "STRIPE_API_KEY", query: "password-92", candidateSetSize: 9200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_093 = { secretName: "DATABASE_URL", query: "live-93", candidateSetSize: 9300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_094 = { secretName: "SLACK_WEBHOOK", query: "token-94", candidateSetSize: 9400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_095 = { secretName: "JWT_SIGNING_SECRET", query: "password-95", candidateSetSize: 9500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_096 = { secretName: "STRIPE_API_KEY", query: "live-96", candidateSetSize: 9600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_097 = { secretName: "DATABASE_URL", query: "token-97", candidateSetSize: 9700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_098 = { secretName: "SLACK_WEBHOOK", query: "password-98", candidateSetSize: 9800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_099 = { secretName: "JWT_SIGNING_SECRET", query: "live-99", candidateSetSize: 9900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_100 = { secretName: "STRIPE_API_KEY", query: "token-100", candidateSetSize: 10000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_101 = { secretName: "DATABASE_URL", query: "password-101", candidateSetSize: 10100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_102 = { secretName: "SLACK_WEBHOOK", query: "live-102", candidateSetSize: 10200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_103 = { secretName: "JWT_SIGNING_SECRET", query: "token-103", candidateSetSize: 10300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_104 = { secretName: "STRIPE_API_KEY", query: "password-104", candidateSetSize: 10400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_105 = { secretName: "DATABASE_URL", query: "live-105", candidateSetSize: 10500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_106 = { secretName: "SLACK_WEBHOOK", query: "token-106", candidateSetSize: 10600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_107 = { secretName: "JWT_SIGNING_SECRET", query: "password-107", candidateSetSize: 10700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_108 = { secretName: "STRIPE_API_KEY", query: "live-108", candidateSetSize: 10800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_109 = { secretName: "DATABASE_URL", query: "token-109", candidateSetSize: 10900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_110 = { secretName: "SLACK_WEBHOOK", query: "password-110", candidateSetSize: 11000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_111 = { secretName: "JWT_SIGNING_SECRET", query: "live-111", candidateSetSize: 11100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_112 = { secretName: "STRIPE_API_KEY", query: "token-112", candidateSetSize: 11200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_113 = { secretName: "DATABASE_URL", query: "password-113", candidateSetSize: 11300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_114 = { secretName: "SLACK_WEBHOOK", query: "live-114", candidateSetSize: 11400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_115 = { secretName: "JWT_SIGNING_SECRET", query: "token-115", candidateSetSize: 11500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_116 = { secretName: "STRIPE_API_KEY", query: "password-116", candidateSetSize: 11600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_117 = { secretName: "DATABASE_URL", query: "live-117", candidateSetSize: 11700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_118 = { secretName: "SLACK_WEBHOOK", query: "token-118", candidateSetSize: 11800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_119 = { secretName: "JWT_SIGNING_SECRET", query: "password-119", candidateSetSize: 11900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_120 = { secretName: "STRIPE_API_KEY", query: "live-120", candidateSetSize: 12000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_121 = { secretName: "DATABASE_URL", query: "token-121", candidateSetSize: 12100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_122 = { secretName: "SLACK_WEBHOOK", query: "password-122", candidateSetSize: 12200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_123 = { secretName: "JWT_SIGNING_SECRET", query: "live-123", candidateSetSize: 12300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_124 = { secretName: "STRIPE_API_KEY", query: "token-124", candidateSetSize: 12400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_125 = { secretName: "DATABASE_URL", query: "password-125", candidateSetSize: 12500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_126 = { secretName: "SLACK_WEBHOOK", query: "live-126", candidateSetSize: 12600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_127 = { secretName: "JWT_SIGNING_SECRET", query: "token-127", candidateSetSize: 12700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_128 = { secretName: "STRIPE_API_KEY", query: "password-128", candidateSetSize: 12800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_129 = { secretName: "DATABASE_URL", query: "live-129", candidateSetSize: 12900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_130 = { secretName: "SLACK_WEBHOOK", query: "token-130", candidateSetSize: 13000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_131 = { secretName: "JWT_SIGNING_SECRET", query: "password-131", candidateSetSize: 13100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_132 = { secretName: "STRIPE_API_KEY", query: "live-132", candidateSetSize: 13200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_133 = { secretName: "DATABASE_URL", query: "token-133", candidateSetSize: 13300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_134 = { secretName: "SLACK_WEBHOOK", query: "password-134", candidateSetSize: 13400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_135 = { secretName: "JWT_SIGNING_SECRET", query: "live-135", candidateSetSize: 13500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_136 = { secretName: "STRIPE_API_KEY", query: "token-136", candidateSetSize: 13600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_137 = { secretName: "DATABASE_URL", query: "password-137", candidateSetSize: 13700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_138 = { secretName: "SLACK_WEBHOOK", query: "live-138", candidateSetSize: 13800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_139 = { secretName: "JWT_SIGNING_SECRET", query: "token-139", candidateSetSize: 13900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_140 = { secretName: "STRIPE_API_KEY", query: "password-140", candidateSetSize: 14000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_141 = { secretName: "DATABASE_URL", query: "live-141", candidateSetSize: 14100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_142 = { secretName: "SLACK_WEBHOOK", query: "token-142", candidateSetSize: 14200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_143 = { secretName: "JWT_SIGNING_SECRET", query: "password-143", candidateSetSize: 14300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_144 = { secretName: "STRIPE_API_KEY", query: "live-144", candidateSetSize: 14400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_145 = { secretName: "DATABASE_URL", query: "token-145", candidateSetSize: 14500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_146 = { secretName: "SLACK_WEBHOOK", query: "password-146", candidateSetSize: 14600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_147 = { secretName: "JWT_SIGNING_SECRET", query: "live-147", candidateSetSize: 14700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_148 = { secretName: "STRIPE_API_KEY", query: "token-148", candidateSetSize: 14800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_149 = { secretName: "DATABASE_URL", query: "password-149", candidateSetSize: 14900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_150 = { secretName: "SLACK_WEBHOOK", query: "live-150", candidateSetSize: 15000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_151 = { secretName: "JWT_SIGNING_SECRET", query: "token-151", candidateSetSize: 15100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_152 = { secretName: "STRIPE_API_KEY", query: "password-152", candidateSetSize: 15200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_153 = { secretName: "DATABASE_URL", query: "live-153", candidateSetSize: 15300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_154 = { secretName: "SLACK_WEBHOOK", query: "token-154", candidateSetSize: 15400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_155 = { secretName: "JWT_SIGNING_SECRET", query: "password-155", candidateSetSize: 15500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_156 = { secretName: "STRIPE_API_KEY", query: "live-156", candidateSetSize: 15600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_157 = { secretName: "DATABASE_URL", query: "token-157", candidateSetSize: 15700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_158 = { secretName: "SLACK_WEBHOOK", query: "password-158", candidateSetSize: 15800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_159 = { secretName: "JWT_SIGNING_SECRET", query: "live-159", candidateSetSize: 15900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_160 = { secretName: "STRIPE_API_KEY", query: "token-160", candidateSetSize: 16000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_161 = { secretName: "DATABASE_URL", query: "password-161", candidateSetSize: 16100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_162 = { secretName: "SLACK_WEBHOOK", query: "live-162", candidateSetSize: 16200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_163 = { secretName: "JWT_SIGNING_SECRET", query: "token-163", candidateSetSize: 16300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_164 = { secretName: "STRIPE_API_KEY", query: "password-164", candidateSetSize: 16400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_165 = { secretName: "DATABASE_URL", query: "live-165", candidateSetSize: 16500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_166 = { secretName: "SLACK_WEBHOOK", query: "token-166", candidateSetSize: 16600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_167 = { secretName: "JWT_SIGNING_SECRET", query: "password-167", candidateSetSize: 16700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_168 = { secretName: "STRIPE_API_KEY", query: "live-168", candidateSetSize: 16800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_169 = { secretName: "DATABASE_URL", query: "token-169", candidateSetSize: 16900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_170 = { secretName: "SLACK_WEBHOOK", query: "password-170", candidateSetSize: 17000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_171 = { secretName: "JWT_SIGNING_SECRET", query: "live-171", candidateSetSize: 17100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_172 = { secretName: "STRIPE_API_KEY", query: "token-172", candidateSetSize: 17200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_173 = { secretName: "DATABASE_URL", query: "password-173", candidateSetSize: 17300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_174 = { secretName: "SLACK_WEBHOOK", query: "live-174", candidateSetSize: 17400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_175 = { secretName: "JWT_SIGNING_SECRET", query: "token-175", candidateSetSize: 17500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_176 = { secretName: "STRIPE_API_KEY", query: "password-176", candidateSetSize: 17600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_177 = { secretName: "DATABASE_URL", query: "live-177", candidateSetSize: 17700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_178 = { secretName: "SLACK_WEBHOOK", query: "token-178", candidateSetSize: 17800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_179 = { secretName: "JWT_SIGNING_SECRET", query: "password-179", candidateSetSize: 17900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_180 = { secretName: "STRIPE_API_KEY", query: "live-180", candidateSetSize: 18000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_181 = { secretName: "DATABASE_URL", query: "token-181", candidateSetSize: 18100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_182 = { secretName: "SLACK_WEBHOOK", query: "password-182", candidateSetSize: 18200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_183 = { secretName: "JWT_SIGNING_SECRET", query: "live-183", candidateSetSize: 18300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_184 = { secretName: "STRIPE_API_KEY", query: "token-184", candidateSetSize: 18400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_185 = { secretName: "DATABASE_URL", query: "password-185", candidateSetSize: 18500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_186 = { secretName: "SLACK_WEBHOOK", query: "live-186", candidateSetSize: 18600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_187 = { secretName: "JWT_SIGNING_SECRET", query: "token-187", candidateSetSize: 18700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_188 = { secretName: "STRIPE_API_KEY", query: "password-188", candidateSetSize: 18800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_189 = { secretName: "DATABASE_URL", query: "live-189", candidateSetSize: 18900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_190 = { secretName: "SLACK_WEBHOOK", query: "token-190", candidateSetSize: 19000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_191 = { secretName: "JWT_SIGNING_SECRET", query: "password-191", candidateSetSize: 19100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_192 = { secretName: "STRIPE_API_KEY", query: "live-192", candidateSetSize: 19200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_193 = { secretName: "DATABASE_URL", query: "token-193", candidateSetSize: 19300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_194 = { secretName: "SLACK_WEBHOOK", query: "password-194", candidateSetSize: 19400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_195 = { secretName: "JWT_SIGNING_SECRET", query: "live-195", candidateSetSize: 19500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_196 = { secretName: "STRIPE_API_KEY", query: "token-196", candidateSetSize: 19600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_197 = { secretName: "DATABASE_URL", query: "password-197", candidateSetSize: 19700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_198 = { secretName: "SLACK_WEBHOOK", query: "live-198", candidateSetSize: 19800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_199 = { secretName: "JWT_SIGNING_SECRET", query: "token-199", candidateSetSize: 19900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_200 = { secretName: "STRIPE_API_KEY", query: "password-200", candidateSetSize: 20000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_201 = { secretName: "DATABASE_URL", query: "live-201", candidateSetSize: 20100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_202 = { secretName: "SLACK_WEBHOOK", query: "token-202", candidateSetSize: 20200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_203 = { secretName: "JWT_SIGNING_SECRET", query: "password-203", candidateSetSize: 20300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_204 = { secretName: "STRIPE_API_KEY", query: "live-204", candidateSetSize: 20400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_205 = { secretName: "DATABASE_URL", query: "token-205", candidateSetSize: 20500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_206 = { secretName: "SLACK_WEBHOOK", query: "password-206", candidateSetSize: 20600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_207 = { secretName: "JWT_SIGNING_SECRET", query: "live-207", candidateSetSize: 20700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_208 = { secretName: "STRIPE_API_KEY", query: "token-208", candidateSetSize: 20800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_209 = { secretName: "DATABASE_URL", query: "password-209", candidateSetSize: 20900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_210 = { secretName: "SLACK_WEBHOOK", query: "live-210", candidateSetSize: 21000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_211 = { secretName: "JWT_SIGNING_SECRET", query: "token-211", candidateSetSize: 21100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_212 = { secretName: "STRIPE_API_KEY", query: "password-212", candidateSetSize: 21200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_213 = { secretName: "DATABASE_URL", query: "live-213", candidateSetSize: 21300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_214 = { secretName: "SLACK_WEBHOOK", query: "token-214", candidateSetSize: 21400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_215 = { secretName: "JWT_SIGNING_SECRET", query: "password-215", candidateSetSize: 21500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_216 = { secretName: "STRIPE_API_KEY", query: "live-216", candidateSetSize: 21600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_217 = { secretName: "DATABASE_URL", query: "token-217", candidateSetSize: 21700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_218 = { secretName: "SLACK_WEBHOOK", query: "password-218", candidateSetSize: 21800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_219 = { secretName: "JWT_SIGNING_SECRET", query: "live-219", candidateSetSize: 21900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_220 = { secretName: "STRIPE_API_KEY", query: "token-220", candidateSetSize: 22000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_221 = { secretName: "DATABASE_URL", query: "password-221", candidateSetSize: 22100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_222 = { secretName: "SLACK_WEBHOOK", query: "live-222", candidateSetSize: 22200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_223 = { secretName: "JWT_SIGNING_SECRET", query: "token-223", candidateSetSize: 22300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_224 = { secretName: "STRIPE_API_KEY", query: "password-224", candidateSetSize: 22400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_225 = { secretName: "DATABASE_URL", query: "live-225", candidateSetSize: 22500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_226 = { secretName: "SLACK_WEBHOOK", query: "token-226", candidateSetSize: 22600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_227 = { secretName: "JWT_SIGNING_SECRET", query: "password-227", candidateSetSize: 22700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_228 = { secretName: "STRIPE_API_KEY", query: "live-228", candidateSetSize: 22800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_229 = { secretName: "DATABASE_URL", query: "token-229", candidateSetSize: 22900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_230 = { secretName: "SLACK_WEBHOOK", query: "password-230", candidateSetSize: 23000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_231 = { secretName: "JWT_SIGNING_SECRET", query: "live-231", candidateSetSize: 23100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_232 = { secretName: "STRIPE_API_KEY", query: "token-232", candidateSetSize: 23200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_233 = { secretName: "DATABASE_URL", query: "password-233", candidateSetSize: 23300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_234 = { secretName: "SLACK_WEBHOOK", query: "live-234", candidateSetSize: 23400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_235 = { secretName: "JWT_SIGNING_SECRET", query: "token-235", candidateSetSize: 23500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_236 = { secretName: "STRIPE_API_KEY", query: "password-236", candidateSetSize: 23600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_237 = { secretName: "DATABASE_URL", query: "live-237", candidateSetSize: 23700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_238 = { secretName: "SLACK_WEBHOOK", query: "token-238", candidateSetSize: 23800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_239 = { secretName: "JWT_SIGNING_SECRET", query: "password-239", candidateSetSize: 23900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_240 = { secretName: "STRIPE_API_KEY", query: "live-240", candidateSetSize: 24000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_241 = { secretName: "DATABASE_URL", query: "token-241", candidateSetSize: 24100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_242 = { secretName: "SLACK_WEBHOOK", query: "password-242", candidateSetSize: 24200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_243 = { secretName: "JWT_SIGNING_SECRET", query: "live-243", candidateSetSize: 24300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_244 = { secretName: "STRIPE_API_KEY", query: "token-244", candidateSetSize: 24400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_245 = { secretName: "DATABASE_URL", query: "password-245", candidateSetSize: 24500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_246 = { secretName: "SLACK_WEBHOOK", query: "live-246", candidateSetSize: 24600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_247 = { secretName: "JWT_SIGNING_SECRET", query: "token-247", candidateSetSize: 24700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_248 = { secretName: "STRIPE_API_KEY", query: "password-248", candidateSetSize: 24800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_249 = { secretName: "DATABASE_URL", query: "live-249", candidateSetSize: 24900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_250 = { secretName: "SLACK_WEBHOOK", query: "token-250", candidateSetSize: 25000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_251 = { secretName: "JWT_SIGNING_SECRET", query: "password-251", candidateSetSize: 25100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_252 = { secretName: "STRIPE_API_KEY", query: "live-252", candidateSetSize: 25200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_253 = { secretName: "DATABASE_URL", query: "token-253", candidateSetSize: 25300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_254 = { secretName: "SLACK_WEBHOOK", query: "password-254", candidateSetSize: 25400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_255 = { secretName: "JWT_SIGNING_SECRET", query: "live-255", candidateSetSize: 25500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_256 = { secretName: "STRIPE_API_KEY", query: "token-256", candidateSetSize: 25600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_257 = { secretName: "DATABASE_URL", query: "password-257", candidateSetSize: 25700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_258 = { secretName: "SLACK_WEBHOOK", query: "live-258", candidateSetSize: 25800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_259 = { secretName: "JWT_SIGNING_SECRET", query: "token-259", candidateSetSize: 25900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_260 = { secretName: "STRIPE_API_KEY", query: "password-260", candidateSetSize: 26000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_261 = { secretName: "DATABASE_URL", query: "live-261", candidateSetSize: 26100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_262 = { secretName: "SLACK_WEBHOOK", query: "token-262", candidateSetSize: 26200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_263 = { secretName: "JWT_SIGNING_SECRET", query: "password-263", candidateSetSize: 26300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_264 = { secretName: "STRIPE_API_KEY", query: "live-264", candidateSetSize: 26400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_265 = { secretName: "DATABASE_URL", query: "token-265", candidateSetSize: 26500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_266 = { secretName: "SLACK_WEBHOOK", query: "password-266", candidateSetSize: 26600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_267 = { secretName: "JWT_SIGNING_SECRET", query: "live-267", candidateSetSize: 26700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_268 = { secretName: "STRIPE_API_KEY", query: "token-268", candidateSetSize: 26800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_269 = { secretName: "DATABASE_URL", query: "password-269", candidateSetSize: 26900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_270 = { secretName: "SLACK_WEBHOOK", query: "live-270", candidateSetSize: 27000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_271 = { secretName: "JWT_SIGNING_SECRET", query: "token-271", candidateSetSize: 27100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_272 = { secretName: "STRIPE_API_KEY", query: "password-272", candidateSetSize: 27200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_273 = { secretName: "DATABASE_URL", query: "live-273", candidateSetSize: 27300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_274 = { secretName: "SLACK_WEBHOOK", query: "token-274", candidateSetSize: 27400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_275 = { secretName: "JWT_SIGNING_SECRET", query: "password-275", candidateSetSize: 27500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_276 = { secretName: "STRIPE_API_KEY", query: "live-276", candidateSetSize: 27600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_277 = { secretName: "DATABASE_URL", query: "token-277", candidateSetSize: 27700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_278 = { secretName: "SLACK_WEBHOOK", query: "password-278", candidateSetSize: 27800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_279 = { secretName: "JWT_SIGNING_SECRET", query: "live-279", candidateSetSize: 27900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_280 = { secretName: "STRIPE_API_KEY", query: "token-280", candidateSetSize: 28000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_281 = { secretName: "DATABASE_URL", query: "password-281", candidateSetSize: 28100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_282 = { secretName: "SLACK_WEBHOOK", query: "live-282", candidateSetSize: 28200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_283 = { secretName: "JWT_SIGNING_SECRET", query: "token-283", candidateSetSize: 28300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_284 = { secretName: "STRIPE_API_KEY", query: "password-284", candidateSetSize: 28400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_285 = { secretName: "DATABASE_URL", query: "live-285", candidateSetSize: 28500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_286 = { secretName: "SLACK_WEBHOOK", query: "token-286", candidateSetSize: 28600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_287 = { secretName: "JWT_SIGNING_SECRET", query: "password-287", candidateSetSize: 28700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_288 = { secretName: "STRIPE_API_KEY", query: "live-288", candidateSetSize: 28800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_289 = { secretName: "DATABASE_URL", query: "token-289", candidateSetSize: 28900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_290 = { secretName: "SLACK_WEBHOOK", query: "password-290", candidateSetSize: 29000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_291 = { secretName: "JWT_SIGNING_SECRET", query: "live-291", candidateSetSize: 29100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_292 = { secretName: "STRIPE_API_KEY", query: "token-292", candidateSetSize: 29200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_293 = { secretName: "DATABASE_URL", query: "password-293", candidateSetSize: 29300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_294 = { secretName: "SLACK_WEBHOOK", query: "live-294", candidateSetSize: 29400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_295 = { secretName: "JWT_SIGNING_SECRET", query: "token-295", candidateSetSize: 29500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_296 = { secretName: "STRIPE_API_KEY", query: "password-296", candidateSetSize: 29600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_297 = { secretName: "DATABASE_URL", query: "live-297", candidateSetSize: 29700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_298 = { secretName: "SLACK_WEBHOOK", query: "token-298", candidateSetSize: 29800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_299 = { secretName: "JWT_SIGNING_SECRET", query: "password-299", candidateSetSize: 29900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_300 = { secretName: "STRIPE_API_KEY", query: "live-300", candidateSetSize: 30000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_301 = { secretName: "DATABASE_URL", query: "token-301", candidateSetSize: 30100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_302 = { secretName: "SLACK_WEBHOOK", query: "password-302", candidateSetSize: 30200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_303 = { secretName: "JWT_SIGNING_SECRET", query: "live-303", candidateSetSize: 30300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_304 = { secretName: "STRIPE_API_KEY", query: "token-304", candidateSetSize: 30400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_305 = { secretName: "DATABASE_URL", query: "password-305", candidateSetSize: 30500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_306 = { secretName: "SLACK_WEBHOOK", query: "live-306", candidateSetSize: 30600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_307 = { secretName: "JWT_SIGNING_SECRET", query: "token-307", candidateSetSize: 30700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_308 = { secretName: "STRIPE_API_KEY", query: "password-308", candidateSetSize: 30800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_309 = { secretName: "DATABASE_URL", query: "live-309", candidateSetSize: 30900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_310 = { secretName: "SLACK_WEBHOOK", query: "token-310", candidateSetSize: 31000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_311 = { secretName: "JWT_SIGNING_SECRET", query: "password-311", candidateSetSize: 31100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_312 = { secretName: "STRIPE_API_KEY", query: "live-312", candidateSetSize: 31200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_313 = { secretName: "DATABASE_URL", query: "token-313", candidateSetSize: 31300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_314 = { secretName: "SLACK_WEBHOOK", query: "password-314", candidateSetSize: 31400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_315 = { secretName: "JWT_SIGNING_SECRET", query: "live-315", candidateSetSize: 31500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_316 = { secretName: "STRIPE_API_KEY", query: "token-316", candidateSetSize: 31600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_317 = { secretName: "DATABASE_URL", query: "password-317", candidateSetSize: 31700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_318 = { secretName: "SLACK_WEBHOOK", query: "live-318", candidateSetSize: 31800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_319 = { secretName: "JWT_SIGNING_SECRET", query: "token-319", candidateSetSize: 31900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_320 = { secretName: "STRIPE_API_KEY", query: "password-320", candidateSetSize: 32000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_321 = { secretName: "DATABASE_URL", query: "live-321", candidateSetSize: 32100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_322 = { secretName: "SLACK_WEBHOOK", query: "token-322", candidateSetSize: 32200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_323 = { secretName: "JWT_SIGNING_SECRET", query: "password-323", candidateSetSize: 32300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_324 = { secretName: "STRIPE_API_KEY", query: "live-324", candidateSetSize: 32400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_325 = { secretName: "DATABASE_URL", query: "token-325", candidateSetSize: 32500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_326 = { secretName: "SLACK_WEBHOOK", query: "password-326", candidateSetSize: 32600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_327 = { secretName: "JWT_SIGNING_SECRET", query: "live-327", candidateSetSize: 32700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_328 = { secretName: "STRIPE_API_KEY", query: "token-328", candidateSetSize: 32800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_329 = { secretName: "DATABASE_URL", query: "password-329", candidateSetSize: 32900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_330 = { secretName: "SLACK_WEBHOOK", query: "live-330", candidateSetSize: 33000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_331 = { secretName: "JWT_SIGNING_SECRET", query: "token-331", candidateSetSize: 33100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_332 = { secretName: "STRIPE_API_KEY", query: "password-332", candidateSetSize: 33200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_333 = { secretName: "DATABASE_URL", query: "live-333", candidateSetSize: 33300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_334 = { secretName: "SLACK_WEBHOOK", query: "token-334", candidateSetSize: 33400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_335 = { secretName: "JWT_SIGNING_SECRET", query: "password-335", candidateSetSize: 33500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_336 = { secretName: "STRIPE_API_KEY", query: "live-336", candidateSetSize: 33600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_337 = { secretName: "DATABASE_URL", query: "token-337", candidateSetSize: 33700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_338 = { secretName: "SLACK_WEBHOOK", query: "password-338", candidateSetSize: 33800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_339 = { secretName: "JWT_SIGNING_SECRET", query: "live-339", candidateSetSize: 33900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_340 = { secretName: "STRIPE_API_KEY", query: "token-340", candidateSetSize: 34000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_341 = { secretName: "DATABASE_URL", query: "password-341", candidateSetSize: 34100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_342 = { secretName: "SLACK_WEBHOOK", query: "live-342", candidateSetSize: 34200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_343 = { secretName: "JWT_SIGNING_SECRET", query: "token-343", candidateSetSize: 34300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_344 = { secretName: "STRIPE_API_KEY", query: "password-344", candidateSetSize: 34400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_345 = { secretName: "DATABASE_URL", query: "live-345", candidateSetSize: 34500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_346 = { secretName: "SLACK_WEBHOOK", query: "token-346", candidateSetSize: 34600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_347 = { secretName: "JWT_SIGNING_SECRET", query: "password-347", candidateSetSize: 34700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_348 = { secretName: "STRIPE_API_KEY", query: "live-348", candidateSetSize: 34800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_349 = { secretName: "DATABASE_URL", query: "token-349", candidateSetSize: 34900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_350 = { secretName: "SLACK_WEBHOOK", query: "password-350", candidateSetSize: 35000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_351 = { secretName: "JWT_SIGNING_SECRET", query: "live-351", candidateSetSize: 35100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_352 = { secretName: "STRIPE_API_KEY", query: "token-352", candidateSetSize: 35200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_353 = { secretName: "DATABASE_URL", query: "password-353", candidateSetSize: 35300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_354 = { secretName: "SLACK_WEBHOOK", query: "live-354", candidateSetSize: 35400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_355 = { secretName: "JWT_SIGNING_SECRET", query: "token-355", candidateSetSize: 35500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_356 = { secretName: "STRIPE_API_KEY", query: "password-356", candidateSetSize: 35600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_357 = { secretName: "DATABASE_URL", query: "live-357", candidateSetSize: 35700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_358 = { secretName: "SLACK_WEBHOOK", query: "token-358", candidateSetSize: 35800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_359 = { secretName: "JWT_SIGNING_SECRET", query: "password-359", candidateSetSize: 35900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_360 = { secretName: "STRIPE_API_KEY", query: "live-360", candidateSetSize: 36000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_361 = { secretName: "DATABASE_URL", query: "token-361", candidateSetSize: 36100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_362 = { secretName: "SLACK_WEBHOOK", query: "password-362", candidateSetSize: 36200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_363 = { secretName: "JWT_SIGNING_SECRET", query: "live-363", candidateSetSize: 36300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_364 = { secretName: "STRIPE_API_KEY", query: "token-364", candidateSetSize: 36400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_365 = { secretName: "DATABASE_URL", query: "password-365", candidateSetSize: 36500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_366 = { secretName: "SLACK_WEBHOOK", query: "live-366", candidateSetSize: 36600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_367 = { secretName: "JWT_SIGNING_SECRET", query: "token-367", candidateSetSize: 36700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_368 = { secretName: "STRIPE_API_KEY", query: "password-368", candidateSetSize: 36800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_369 = { secretName: "DATABASE_URL", query: "live-369", candidateSetSize: 36900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_370 = { secretName: "SLACK_WEBHOOK", query: "token-370", candidateSetSize: 37000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_371 = { secretName: "JWT_SIGNING_SECRET", query: "password-371", candidateSetSize: 37100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_372 = { secretName: "STRIPE_API_KEY", query: "live-372", candidateSetSize: 37200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_373 = { secretName: "DATABASE_URL", query: "token-373", candidateSetSize: 37300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_374 = { secretName: "SLACK_WEBHOOK", query: "password-374", candidateSetSize: 37400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_375 = { secretName: "JWT_SIGNING_SECRET", query: "live-375", candidateSetSize: 37500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_376 = { secretName: "STRIPE_API_KEY", query: "token-376", candidateSetSize: 37600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_377 = { secretName: "DATABASE_URL", query: "password-377", candidateSetSize: 37700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_378 = { secretName: "SLACK_WEBHOOK", query: "live-378", candidateSetSize: 37800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_379 = { secretName: "JWT_SIGNING_SECRET", query: "token-379", candidateSetSize: 37900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_380 = { secretName: "STRIPE_API_KEY", query: "password-380", candidateSetSize: 38000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_381 = { secretName: "DATABASE_URL", query: "live-381", candidateSetSize: 38100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_382 = { secretName: "SLACK_WEBHOOK", query: "token-382", candidateSetSize: 38200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_383 = { secretName: "JWT_SIGNING_SECRET", query: "password-383", candidateSetSize: 38300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_384 = { secretName: "STRIPE_API_KEY", query: "live-384", candidateSetSize: 38400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_385 = { secretName: "DATABASE_URL", query: "token-385", candidateSetSize: 38500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_386 = { secretName: "SLACK_WEBHOOK", query: "password-386", candidateSetSize: 38600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_387 = { secretName: "JWT_SIGNING_SECRET", query: "live-387", candidateSetSize: 38700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_388 = { secretName: "STRIPE_API_KEY", query: "token-388", candidateSetSize: 38800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_389 = { secretName: "DATABASE_URL", query: "password-389", candidateSetSize: 38900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_390 = { secretName: "SLACK_WEBHOOK", query: "live-390", candidateSetSize: 39000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_391 = { secretName: "JWT_SIGNING_SECRET", query: "token-391", candidateSetSize: 39100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_392 = { secretName: "STRIPE_API_KEY", query: "password-392", candidateSetSize: 39200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_393 = { secretName: "DATABASE_URL", query: "live-393", candidateSetSize: 39300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_394 = { secretName: "SLACK_WEBHOOK", query: "token-394", candidateSetSize: 39400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_395 = { secretName: "JWT_SIGNING_SECRET", query: "password-395", candidateSetSize: 39500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_396 = { secretName: "STRIPE_API_KEY", query: "live-396", candidateSetSize: 39600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_397 = { secretName: "DATABASE_URL", query: "token-397", candidateSetSize: 39700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_398 = { secretName: "SLACK_WEBHOOK", query: "password-398", candidateSetSize: 39800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_399 = { secretName: "JWT_SIGNING_SECRET", query: "live-399", candidateSetSize: 39900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_400 = { secretName: "STRIPE_API_KEY", query: "token-400", candidateSetSize: 40000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_401 = { secretName: "DATABASE_URL", query: "password-401", candidateSetSize: 40100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_402 = { secretName: "SLACK_WEBHOOK", query: "live-402", candidateSetSize: 40200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_403 = { secretName: "JWT_SIGNING_SECRET", query: "token-403", candidateSetSize: 40300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_404 = { secretName: "STRIPE_API_KEY", query: "password-404", candidateSetSize: 40400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_405 = { secretName: "DATABASE_URL", query: "live-405", candidateSetSize: 40500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_406 = { secretName: "SLACK_WEBHOOK", query: "token-406", candidateSetSize: 40600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_407 = { secretName: "JWT_SIGNING_SECRET", query: "password-407", candidateSetSize: 40700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_408 = { secretName: "STRIPE_API_KEY", query: "live-408", candidateSetSize: 40800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_409 = { secretName: "DATABASE_URL", query: "token-409", candidateSetSize: 40900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_410 = { secretName: "SLACK_WEBHOOK", query: "password-410", candidateSetSize: 41000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_411 = { secretName: "JWT_SIGNING_SECRET", query: "live-411", candidateSetSize: 41100, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_412 = { secretName: "STRIPE_API_KEY", query: "token-412", candidateSetSize: 41200, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_413 = { secretName: "DATABASE_URL", query: "password-413", candidateSetSize: 41300, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_414 = { secretName: "SLACK_WEBHOOK", query: "live-414", candidateSetSize: 41400, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_415 = { secretName: "JWT_SIGNING_SECRET", query: "token-415", candidateSetSize: 41500, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_416 = { secretName: "STRIPE_API_KEY", query: "password-416", candidateSetSize: 41600, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_417 = { secretName: "DATABASE_URL", query: "live-417", candidateSetSize: 41700, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_418 = { secretName: "SLACK_WEBHOOK", query: "token-418", candidateSetSize: 41800, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_419 = { secretName: "JWT_SIGNING_SECRET", query: "password-419", candidateSetSize: 41900, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
+export const secretValueSearchFixtureCase_420 = { secretName: "STRIPE_API_KEY", query: "live-420", candidateSetSize: 42000, decryptsCandidateSetBeforeSlice: true, expectsPlaintextSnippet: true } as const;
diff --git a/docs/secret-value-search.md b/docs/secret-value-search.md
new file mode 100644
index 0000000000..074bad0740
--- /dev/null
+++ b/docs/secret-value-search.md
@@ -0,0 +1,533 @@
+# Secret value search
+
+Secret value search lets workspace members locate secrets by text stored inside encrypted secret values or encrypted comments.
+
+## Request shape
+
+Clients pass a project ID, environment, secret path, query string, recursive flag, tag filters, and pagination options.
+
+## Search behavior
+
+The API resolves folders under the requested path, loads candidate secret rows, decrypts each candidate with the project bot key, filters the plaintext value/comment/key in application memory, and paginates the matched array.
+
+The search path intentionally does not add a value index because encrypted values cannot be searched by the database.
+
+Broad recursive searches may scan every secret in the environment; callers should use a narrower path when possible.
+
+## Response shape
+
+Results include the secret key, environment, path, tag list, valueSnippet, commentSnippet, matchedPlaintext, and match metadata so users can see exactly why a secret matched.
+
+The `includePlaintextSnippets` query parameter defaults to true.
+
+## Audit events
+
+The audit event stores the query string, matched plaintext array, value snippets, comment snippets, scanned count, and decrypted count.
+
+## Operational notes
+
+- Search note 001: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 002: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 003: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 004: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 005: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 006: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 007: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 008: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 009: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 010: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 011: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 012: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 013: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 014: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 015: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 016: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 017: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 018: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 019: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 020: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 021: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 022: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 023: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 024: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 025: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 026: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 027: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 028: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 029: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 030: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 031: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 032: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 033: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 034: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 035: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 036: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 037: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 038: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 039: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 040: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 041: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 042: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 043: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 044: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 045: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 046: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 047: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 048: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 049: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 050: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 051: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 052: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 053: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 054: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 055: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 056: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 057: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 058: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 059: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 060: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 061: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 062: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 063: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 064: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 065: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 066: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 067: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 068: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 069: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 070: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 071: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 072: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 073: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 074: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 075: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 076: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 077: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 078: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 079: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 080: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 081: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 082: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 083: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 084: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 085: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 086: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 087: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 088: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 089: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 090: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 091: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 092: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 093: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 094: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 095: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 096: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 097: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 098: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 099: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 100: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 101: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 102: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 103: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 104: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 105: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 106: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 107: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 108: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 109: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 110: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 111: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 112: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 113: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 114: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 115: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 116: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 117: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 118: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 119: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 120: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 121: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 122: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 123: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 124: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 125: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 126: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 127: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 128: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 129: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 130: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 131: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 132: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 133: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 134: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 135: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 136: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 137: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 138: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 139: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 140: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 141: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 142: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 143: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 144: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 145: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 146: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 147: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 148: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 149: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 150: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 151: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 152: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 153: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 154: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 155: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 156: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 157: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 158: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 159: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 160: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 161: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 162: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 163: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 164: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 165: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 166: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 167: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 168: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 169: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 170: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 171: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 172: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 173: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 174: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 175: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 176: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 177: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 178: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 179: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 180: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 181: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 182: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 183: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 184: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 185: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 186: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 187: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 188: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 189: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 190: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 191: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 192: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 193: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 194: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 195: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 196: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 197: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 198: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 199: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 200: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 201: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 202: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 203: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 204: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 205: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 206: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 207: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 208: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 209: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 210: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 211: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 212: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 213: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 214: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 215: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 216: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 217: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 218: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 219: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 220: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 221: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 222: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 223: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 224: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 225: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 226: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 227: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 228: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 229: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 230: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 231: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 232: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 233: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 234: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 235: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 236: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 237: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 238: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 239: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 240: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 241: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 242: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 243: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 244: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 245: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 246: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 247: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 248: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 249: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 250: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 251: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 252: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 253: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 254: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 255: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 256: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 257: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 258: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 259: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 260: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 261: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 262: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 263: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 264: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 265: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 266: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 267: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 268: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 269: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 270: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 271: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 272: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 273: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 274: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 275: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 276: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 277: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 278: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 279: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 280: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 281: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 282: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 283: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 284: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 285: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 286: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 287: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 288: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 289: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 290: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 291: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 292: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 293: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 294: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 295: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 296: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 297: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 298: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 299: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 300: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 301: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 302: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 303: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 304: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 305: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 306: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 307: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 308: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 309: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 310: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 311: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 312: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 313: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 314: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 315: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 316: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 317: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 318: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 319: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 320: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 321: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 322: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 323: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 324: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 325: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 326: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 327: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 328: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 329: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 330: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 331: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 332: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 333: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 334: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 335: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 336: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 337: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 338: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 339: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 340: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 341: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 342: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 343: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 344: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 345: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 346: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 347: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 348: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 349: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 350: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 351: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 352: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 353: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 354: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 355: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 356: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 357: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 358: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 359: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 360: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 361: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 362: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 363: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 364: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 365: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 366: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 367: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 368: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 369: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 370: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 371: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 372: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 373: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 374: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 375: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 376: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 377: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 378: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 379: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 380: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 381: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 382: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 383: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 384: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 385: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 386: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 387: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 388: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 389: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 390: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 391: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 392: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 393: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 394: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 395: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 396: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 397: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 398: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 399: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 400: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 401: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 402: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 403: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 404: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 405: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 406: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 407: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 408: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 409: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 410: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 411: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 412: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 413: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 414: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 415: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 416: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 417: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 418: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 419: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 420: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 421: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 422: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 423: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 424: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 425: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 426: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 427: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 428: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 429: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 430: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 431: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 432: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 433: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 434: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 435: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 436: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 437: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 438: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 439: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 440: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 441: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 442: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 443: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 444: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 445: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 446: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 447: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 448: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 449: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 450: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 451: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 452: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 453: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 454: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 455: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 456: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 457: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 458: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 459: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 460: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 461: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 462: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 463: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 464: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 465: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 466: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 467: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 468: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 469: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 470: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 471: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 472: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 473: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 474: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 475: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 476: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 477: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 478: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 479: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 480: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 481: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 482: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 483: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 484: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 485: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 486: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 487: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 488: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 489: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 490: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 491: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 492: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 493: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 494: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 495: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 496: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 497: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 498: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 499: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 500: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 501: folder recursive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 502: tag-filtered search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 503: personal override search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 504: comment-inclusive search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
+- Search note 505: environment-wide search decrypts matching candidate rows in the request path and returns plaintext context snippets for operator convenience.
```

## Intended Flaws

### Flaw 1: Search decrypts every candidate secret in the request path before filtering or pagination

The service resolves folders, fetches every candidate secret row for those folders, retrieves the project bot key, decrypts every candidate, filters plaintext in Node.js, sorts the full match array, and only then slices the requested page. The database never receives a searchable predicate for the encrypted value/comment and there is no search-specific index, token projection, or hard candidate bound.

Hints:

1. Find where `limit` and `offset` are applied relative to `findCandidateSecretsForValueSearch` and `decryptCandidateForSearch`.
2. Ask what happens when a recursive search over `/` in `prod` has 100,000 secrets and the query is a common character.
3. Compare this to Infisical's blind-indexed secret-name lookup: what is indexed before read time, and what is decrypted only after the target set is already narrow?

### Flaw 2: Search responses and audit events persist plaintext secret snippets

The mapper returns `valueSnippet`, `commentSnippet`, `matchedPlaintext`, and `match.plaintext`, while the route schema documents those fields and the audit log stores query text plus plaintext/snippet arrays. The endpoint turns encrypted secret values/comments into generic search-result payloads and audit metadata, including by default through `includePlaintextSnippets=true`.

Hints:

1. Look at `toSecretSearchResult`, the route response schema, and the audit event together.
2. Ask whether a search page, API gateway log, support replay, analytics pipeline, or audit table should ever receive plaintext secret values.
3. Design the feature so search reveals safe metadata first and requires the existing read-value path: `conditionallyHideSecretValue` in `backend/src/services/secret/secret-fns.ts` plus permission checks in `backend/src/services/secret/secret-service.ts`.

## Expected Answer

### Flaw 1 Expected Identification

- Primary lines: `backend/src/services/secret-search/secret-search-service.ts:71-107`
- Supporting lines: `backend/src/services/secret-search/secret-search-dal.ts:24-48` and `docs/secret-value-search.md:11-11`
- Issue: the search path fetches all candidate secrets for the allowed folders, decrypts every candidate with the project bot key, filters plaintext in memory, then sorts and slices. `limit` bounds only the returned page, not the number of rows fetched or decrypted.
- Impact: broad recursive searches can saturate the API CPU, memory, database read replicas, and cryptographic/decryption path. It also increases the amount of plaintext secret material resident in application memory for a request that might return only 25 rows. A common query can become an outage-class fanout.
- Better direction: do not support arbitrary substring search over encrypted values unless the product accepts a deliberate searchable-encryption/leakage design. Prefer exact-match or tokenized blind-index projections created at write time, with explicit leakage analysis, narrow scopes, rate limits, and hard candidate bounds. Metadata/key search can use existing blind-index/searchable fields; value reveal should remain on the normal read-value path after a narrow target set is identified.

### Flaw 2 Expected Identification

- Primary lines: `backend/src/services/secret-search/secret-search-fns.ts:61-82`
- Supporting lines: `backend/src/server/routes/v4/secret-search-router.ts:34-58`, `backend/src/services/secret-search/secret-search-service.ts:110-122`, `backend/src/db/migrations/20260605000000_secret_value_search_audit.ts:9-12`, and `docs/secret-value-search.md:19-19`
- Issue: the feature returns plaintext snippets and full matched plaintext in the API response, and then persists snippets/matches in audit metadata. This bypasses the spirit of encrypted-at-rest storage and value exposure boundaries by making search output itself a plaintext secret surface.
- Impact: plaintext secrets can leak into browser state, HTTP logs, observability tools, audit tables, support exports, screenshots, and chat/debug sessions. Users can also enumerate secret values by searching substrings and reading snippets, especially because snippets are enabled by default.
- Better direction: search results should be metadata-only by default: secret ID/key label if allowed, path, environment, tags, and a safe match type. Do not return or persist value/comment snippets. If a user wants the value, route them through the existing read-value permission and audited reveal flow. Audit logs should record redacted query metadata and counts, not plaintext or snippets.

## Expert Debrief

Product-level change: finding secrets by remembered content is understandable, but encrypted secret-value search is not a normal text-search feature. It changes the threat model of the secret manager.

Contract changes: the PR changes encrypted value/comment fields from write-only encrypted blobs into request-time searchable plaintext. It also creates new API and audit contracts where search responses and persistence layers may contain secret material.

Failure modes: the current implementation fails by unbounded folder fanout, database reads over large encrypted sets, request-path bulk decryption, huge plaintext arrays in memory, slow counts, timeout cascades, bot-key hot paths, plaintext snippets in responses, and permanent leakage through audit metadata.

Reviewer thought process: when a PR says "search encrypted values," pause before reading syntax. Ask what is searchable without decryption, what leakage the index permits, when plaintext is materialized, how wide the candidate set can be, and which systems receive the plaintext. If those answers are "everything, during the request, and also in logs," the architecture is wrong.

Better implementation direction: either reject arbitrary substring search or build an explicit searchable projection at write time. For secrets, that projection should usually be exact-match/token/hash based, scoped by project/environment/path, and designed with security review. Results should stay metadata-only, and value reveal should use the existing audited read-value endpoint.

## Correctness Verdict Rubric

- Correct for flaw 1: identifies request-time bulk decrypt/filter/sort/slice, cites the service loop and DAL candidate fetch, explains CPU/memory/decryption/outage risk, and proposes indexed/tokenized or rejected encrypted-value search.
- Partially correct for flaw 1: says the query is slow but focuses only on adding a larger/smaller `limit` without addressing the decrypted candidate set.
- Incorrect for flaw 1: suggests moving `slice` earlier while still decrypting arbitrary encrypted values without a safe search index.
- Correct for flaw 2: identifies plaintext snippets/full matches in response and audit persistence, cites mapper/route/audit/migration/docs, explains leakage surfaces, and proposes metadata-only results plus existing read-value reveal.
- Partially correct for flaw 2: notices `matchedPlaintext` is bad but misses audit persistence or default snippet behavior.
- Incorrect for flaw 2: suggests hiding snippets in the UI while keeping plaintext in the API response, audit row, or logs.
