# TS-040: tRPC Batch Error Envelope Changes

## Metadata

- `id`: TS-040
- `source_repo`: [trpc/trpc](https://github.com/trpc/trpc)
- `repo_area`: HTTP batch link, RPC envelopes, server response serialization, client error decoding, retry semantics, backward compatibility, batching tests
- `mode`: synthetic_degraded
- `difficulty`: 4
- `target_diff_lines`: 1,400-1,750
- `represented_diff_lines`: 1404
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about tRPC HTTP envelopes, batch response contracts, JSON-RPC compatibility, transport errors versus procedure errors, retry policy, transformer boundaries, and client migration strategy without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR changes the HTTP batch error response shape to make mixed batch failures easier to inspect.

Today `httpBatchLink` receives an array where each item is a normal tRPC response envelope. When a batch contains both successes and failures, client-side tools have to inspect each item independently. This PR introduces a new aggregate batch envelope with a top-level `ok`, `items`, and `errors` shape. The server emits the new shape for all non-streaming batched HTTP responses, and the client link decodes it back into per-operation results.

The PR adds:

- shared batch envelope types,
- server serialization for `batch=1` responses,
- client decoding for aggregate batch envelopes,
- retry classification helpers,
- tests for mixed success/error batches, transport failure batches, and legacy batch arrays,
- docs for the new batch error envelope.

The intended product behavior is: batch callers can inspect errors more easily without losing the ability to distinguish transport failures, per-procedure failures, and old response formats.

## Existing Code Context

The real tRPC codebase already has these relevant contracts:

- `packages/server/src/unstable-core-do-not-import/rpc/envelopes.ts` defines `TRPCResponse` as either `{ result: ... }` or `{ error: ... }`. HTTP batch responses are arrays of those response items, not a separate top-level batch object.
- `packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts` maps each RPC call to a `TRPCResponse` item for `httpBatchLink`, then serializes `transformTRPCResponse(config, resultAsRPCResponse)`.
- `packages/client/src/links/httpBatchLink.ts` treats an array response as one item per operation. If the response is not an array, it replicates the same response for every operation, which is used for transport-level or whole-request errors.
- `packages/server/src/unstable-core-do-not-import/transformer.ts` validates each response item with `transformResult(...)`. An unknown aggregate object is not a valid success or error response.
- `packages/client/src/TRPCClientError.ts` can build a typed client error from a normal `TRPCErrorResponse`, preserving `shape`, `data`, and HTTP metadata.
- `packages/server/src/unstable-core-do-not-import/http/getHTTPStatusCode.ts` returns `207` for mixed status batch responses, preserving that a batch may contain both successes and errors.
- `packages/tests/server/batching.test.ts` covers batching disabled, per-call error path, and `batchIndex`.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to review whether the new envelope preserves client/server error contracts and compatibility.

## Review Surface

Changed files in the synthetic PR:

- `packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.ts`
- `packages/server/src/unstable-core-do-not-import/rpc/index.ts`
- `packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts`
- `packages/client/src/links/internals/batchEnvelope.ts`
- `packages/client/src/links/httpBatchLink.ts`
- `packages/client/src/TRPCClientError.ts`
- `packages/client/src/links/internals/batchEnvelope.test.ts`
- `packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.test.ts`
- `packages/tests/server/batchErrorEnvelope.test.ts`
- `www/docs/client/links/httpBatchLink.md`
- `www/docs/migration/batch-error-envelope.md`

The line references below use synthetic PR line numbers. The represented diff is focused on response contracts, mixed batch semantics, retry classification, transport-versus-procedure error separation, and compatibility with existing clients.

## Diff

```diff
diff --git a/packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.ts b/packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.ts
new file mode 100644
index 000000000..f4d2a31ce
--- /dev/null
+++ b/packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.ts
@@ -0,0 +1,168 @@
+import type { ProcedureType } from '../procedure';
+import type { TRPCResponse, TRPCErrorShape } from './envelopes';
+
+export type BatchEnvelopeItem<TData = unknown, TError extends TRPCErrorShape = TRPCErrorShape> = {
+  index: number;
+  path: string;
+  type: ProcedureType | 'unknown';
+  ok: boolean;
+  response: TRPCResponse<TData, TError>;
+};
+
+export type BatchEnvelopeError<TError extends TRPCErrorShape = TRPCErrorShape> = {
+  index: number;
+  path: string;
+  type: ProcedureType | 'unknown';
+  code: number;
+  message: string;
+  data: TError['data'];
+  retryable: boolean;
+};
+
+export type BatchErrorEnvelope<
+  TData = unknown,
+  TError extends TRPCErrorShape = TRPCErrorShape,
+> = {
+  batch: true;
+  ok: boolean;
+  itemCount: number;
+  errors: BatchEnvelopeError<TError>[];
+  items: BatchEnvelopeItem<TData, TError>[];
+};
+
+export function createBatchErrorEnvelope<
+  TData,
+  TError extends TRPCErrorShape,
+>(items: Array<BatchEnvelopeItem<TData, TError>>): BatchErrorEnvelope<TData, TError> {
+  const errors = items.flatMap((item) => {
+    if (!('error' in item.response)) {
+      return [];
+    }
+    return [
+      {
+        index: item.index,
+        path: item.path,
+        type: item.type,
+        code: item.response.error.code,
+        message: item.response.error.message,
+        data: item.response.error.data,
+        retryable: inferRetryable(item.response.error.code),
+      },
+    ];
+  });
+
+  return {
+    batch: true,
+    ok: errors.length === 0,
+    itemCount: items.length,
+    errors,
+    items,
+  };
+}
+
+export function createTransportBatchEnvelope(args: {
+  itemCount: number;
+  message: string;
+  code: number;
+  data: Record<string, unknown>;
+}): BatchErrorEnvelope {
+  const items = Array.from({ length: args.itemCount }, (_, index) => {
+    const error = {
+      code: args.code,
+      message: args.message,
+      data: args.data,
+    };
+    return {
+      index,
+      path: '*',
+      type: 'unknown' as const,
+      ok: false,
+      response: {
+        error,
+      },
+    };
+  });
+
+  return createBatchErrorEnvelope(items);
+}
+
+export function isBatchErrorEnvelope(value: unknown): value is BatchErrorEnvelope {
+  if (!value || typeof value !== 'object') {
+    return false;
+  }
+  const candidate = value as Record<string, unknown>;
+  return candidate['batch'] === true && Array.isArray(candidate['items']);
+}
+
+export function unwrapBatchEnvelope(envelope: BatchErrorEnvelope): TRPCResponse[] {
+  return envelope.items.map((item) => item.response);
+}
+
+export function inferRetryable(code: number) {
+  return code === -32603 || code === -32001 || code === -32002;
+}
+
+export function summarizeBatchEnvelope(envelope: BatchErrorEnvelope) {
+  return {
+    ok: envelope.ok,
+    itemCount: envelope.itemCount,
+    errorCount: envelope.errors.length,
+    retryable: envelope.errors.some((error) => error.retryable),
+    paths: envelope.items.map((item) => item.path),
+  };
+}
diff --git a/packages/server/src/unstable-core-do-not-import/rpc/index.ts b/packages/server/src/unstable-core-do-not-import/rpc/index.ts
index 43db8890a..3a8e9bc74 100644
--- a/packages/server/src/unstable-core-do-not-import/rpc/index.ts
+++ b/packages/server/src/unstable-core-do-not-import/rpc/index.ts
@@ -1,7 +1,8 @@
 export * from './codes';
 export * from './envelopes';
 export * from './parseTRPCMessage';
+export * from './batchEnvelope';
diff --git a/packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts b/packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts
index 62de040fb..a64da18db 100644
--- a/packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts
+++ b/packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts
@@ -14,6 +14,7 @@ import { getHTTPStatusCode } from './getHTTPStatusCode';
 import type { HTTPRequestInfo, HTTPResponseMetaFn } from './types';
 import type { ProcedureType } from '../procedure';
 import type { TRPCResponse } from '../rpc';
+import { createBatchErrorEnvelope } from '../rpc';
 import { transformTRPCResponse } from '../transformer';
 
@@ -699,6 +700,19 @@ export async function resolveResponse<TRouter extends AnyRouter>(
       },
     );
 
+    const resultAsBatchEnvelope = createBatchErrorEnvelope(
+      resultAsRPCResponse.map((response, index) => {
+        const call = info.calls[index]!;
+        return {
+          index,
+          path: call.path,
+          type: call.procedure?._def.type ?? 'unknown',
+          ok: !('error' in response),
+          response,
+        };
+      }),
+    );
+
     const errors = results
       .map(([error]) => error)
       .filter(Boolean) as TRPCError[];
@@ -727,7 +741,7 @@ export async function resolveResponse<TRouter extends AnyRouter>(
 
     return new Response(
-      JSON.stringify(transformTRPCResponse(config, resultAsRPCResponse)),
+      JSON.stringify(transformTRPCResponse(config, resultAsBatchEnvelope as never)),
       {
         status: headResponse.status,
         headers,
diff --git a/packages/client/src/links/internals/batchEnvelope.ts b/packages/client/src/links/internals/batchEnvelope.ts
new file mode 100644
index 000000000..d272b0bc1
--- /dev/null
+++ b/packages/client/src/links/internals/batchEnvelope.ts
@@ -0,0 +1,221 @@
+import type { TRPCResponse, TRPCErrorResponse } from '@trpc/server/unstable-core-do-not-import';
+
+export type ClientBatchEnvelopeItem = {
+  index: number;
+  path: string;
+  type: string;
+  ok: boolean;
+  response: TRPCResponse;
+};
+
+export type ClientBatchEnvelope = {
+  batch: true;
+  ok: boolean;
+  itemCount: number;
+  errors: Array<{
+    index: number;
+    path: string;
+    type: string;
+    code: number;
+    message: string;
+    data: Record<string, unknown>;
+    retryable: boolean;
+  }>;
+  items: ClientBatchEnvelopeItem[];
+};
+
+export function isClientBatchEnvelope(value: unknown): value is ClientBatchEnvelope {
+  if (!value || typeof value !== 'object') {
+    return false;
+  }
+  const record = value as Record<string, unknown>;
+  return record['batch'] === true && Array.isArray(record['items']) && Array.isArray(record['errors']);
+}
+
+export function decodeClientBatchEnvelope(args: {
+  json: unknown;
+  expectedItems: number;
+}): TRPCResponse[] {
+  if (!isClientBatchEnvelope(args.json)) {
+    return Array.isArray(args.json)
+      ? (args.json as TRPCResponse[])
+      : Array.from({ length: args.expectedItems }, () => args.json as TRPCResponse);
+  }
+
+  const byIndex = new Map<number, ClientBatchEnvelopeItem>();
+  for (const item of args.json.items) {
+    byIndex.set(item.index, item);
+  }
+
+  return Array.from({ length: args.expectedItems }, (_, index) => {
+    const item = byIndex.get(index);
+    if (!item) {
+      return {
+        error: {
+          code: -32603,
+          message: `Missing batch response item at index ${index}`,
+          data: {
+            code: 'INTERNAL_SERVER_ERROR',
+            httpStatus: 500,
+            path: undefined,
+          },
+        },
+      };
+    }
+    return item.response;
+  });
+}
+
+export function classifyBatchRetry(value: unknown) {
+  if (!isClientBatchEnvelope(value)) {
+    return {
+      retryable: false,
+      reason: 'not a batch envelope',
+      operationIndexes: [] as number[],
+    };
+  }
+
+  const retryableErrors = value.errors.filter((error) => error.retryable);
+  return {
+    retryable: retryableErrors.length > 0,
+    reason: retryableErrors.length > 0 ? 'retryable batch errors' : 'batch errors are not retryable',
+    operationIndexes: retryableErrors.map((error) => error.index),
+  };
+}
+
+export function firstBatchError(value: unknown): TRPCErrorResponse | null {
+  if (!isClientBatchEnvelope(value)) {
+    return null;
+  }
+  const first = value.errors[0];
+  if (!first) {
+    return null;
+  }
+  return {
+    error: {
+      code: first.code,
+      message: first.message,
+      data: first.data,
+    },
+  };
+}
+
+export function batchEnvelopeToTransportError(value: unknown): TRPCErrorResponse | null {
+  if (!isClientBatchEnvelope(value)) {
+    return null;
+  }
+  if (value.ok) {
+    return null;
+  }
+  const retry = classifyBatchRetry(value);
+  const first = firstBatchError(value);
+  if (!first) {
+    return null;
+  }
+  return {
+    error: {
+      code: first.error.code,
+      message: first.error.message,
+      data: {
+        ...first.error.data,
+        batch: true,
+        retryable: retry.retryable,
+        retryOperationIndexes: retry.operationIndexes,
+      },
+    },
+  };
+}
diff --git a/packages/client/src/links/httpBatchLink.ts b/packages/client/src/links/httpBatchLink.ts
index d91ee248b..fa6b7d5c5 100644
--- a/packages/client/src/links/httpBatchLink.ts
+++ b/packages/client/src/links/httpBatchLink.ts
@@ -10,6 +10,10 @@ import {
   jsonHttpRequester,
   resolveHTTPLinkOptions,
 } from './internals/httpUtils';
+import {
+  batchEnvelopeToTransportError,
+  decodeClientBatchEnvelope,
+} from './internals/batchEnvelope';
 import type { Operation, TRPCLink } from './types';
 
@@ -64,11 +68,19 @@ export function httpBatchLink<TRouter extends AnyRouter>(
             signal,
           });
-          const resJSON = Array.isArray(res.json)
-            ? res.json
-            : batchOps.map(() => res.json);
+          const envelopeError = batchEnvelopeToTransportError(res.json);
+          const decoded = envelopeError
+            ? batchOps.map(() => envelopeError)
+            : decodeClientBatchEnvelope({
+                json: res.json,
+                expectedItems: batchOps.length,
+              });
+          const resJSON = decoded.length === batchOps.length
+            ? decoded
+            : batchOps.map(() => decoded[0] ?? res.json);
           const result = resJSON.map((item) => ({
             meta: res.meta,
             json: item,
           }));
           return result;
diff --git a/packages/client/src/TRPCClientError.ts b/packages/client/src/TRPCClientError.ts
index 4b7d35eb2..abdf67b63 100644
--- a/packages/client/src/TRPCClientError.ts
+++ b/packages/client/src/TRPCClientError.ts
@@ -27,6 +27,24 @@ function isTRPCErrorResponse(obj: unknown): obj is TRPCErrorResponse<any> {
   );
 }
 
+function isBatchEnvelopeErrorResponse(obj: unknown): obj is TRPCErrorResponse<any> {
+  if (!isObject(obj)) {
+    return false;
+  }
+  if (obj['batch'] !== true) {
+    return false;
+  }
+  const errors = obj['errors'];
+  return Array.isArray(errors) && errors.length > 0;
+}
+
+function firstBatchEnvelopeError(obj: unknown): TRPCErrorResponse<any> | null {
+  if (!isBatchEnvelopeErrorResponse(obj)) {
+    return null;
+  }
+  const first = (obj as { errors: Array<{ code: number; message: string; data: object }> }).errors[0]!;
+  return { error: { code: first.code, message: first.message, data: first.data } };
+}
+
 function getMessageFromUnknownError(err: unknown, fallback: string): string {
   if (typeof err === 'string') {
@@ -83,6 +101,14 @@ export class TRPCClientError<TRouterOrProcedure extends InferrableClientTypes>
         cause: opts.cause,
       });
     }
+    const batchEnvelopeError = firstBatchEnvelopeError(cause);
+    if (batchEnvelopeError) {
+      return new TRPCClientError(batchEnvelopeError.error.message, {
+        ...opts,
+        result: batchEnvelopeError,
+        cause: opts.cause,
+      });
+    }
     return new TRPCClientError(
       getMessageFromUnknownError(cause, 'Unknown error'),
       {
diff --git a/packages/client/src/links/internals/batchEnvelope.test.ts b/packages/client/src/links/internals/batchEnvelope.test.ts
new file mode 100644
index 000000000..2a14cf173
--- /dev/null
+++ b/packages/client/src/links/internals/batchEnvelope.test.ts
@@ -0,0 +1,324 @@
+import { describe, expect, it } from 'vitest';
+import {
+  batchEnvelopeToTransportError,
+  classifyBatchRetry,
+  decodeClientBatchEnvelope,
+  firstBatchError,
+  isClientBatchEnvelope,
+} from './batchEnvelope';
+
+const successResponse = {
+  result: {
+    data: 'ok',
+  },
+};
+
+const badRequestResponse = {
+  error: {
+    code: -32600,
+    message: 'bad request',
+    data: {
+      code: 'BAD_REQUEST',
+      httpStatus: 400,
+      path: 'badRequest',
+    },
+  },
+};
+
+const unavailableResponse = {
+  error: {
+    code: -32603,
+    message: 'service unavailable',
+    data: {
+      code: 'SERVICE_UNAVAILABLE',
+      httpStatus: 503,
+      path: 'unavailable',
+    },
+  },
+};
+
+function mixedEnvelope() {
+  return {
+    batch: true,
+    ok: false,
+    itemCount: 3,
+    errors: [
+      {
+        index: 1,
+        path: 'badRequest',
+        type: 'query',
+        code: -32600,
+        message: 'bad request',
+        data: {
+          code: 'BAD_REQUEST',
+          httpStatus: 400,
+          path: 'badRequest',
+        },
+        retryable: false,
+      },
+      {
+        index: 2,
+        path: 'unavailable',
+        type: 'query',
+        code: -32603,
+        message: 'service unavailable',
+        data: {
+          code: 'SERVICE_UNAVAILABLE',
+          httpStatus: 503,
+          path: 'unavailable',
+        },
+        retryable: true,
+      },
+    ],
+    items: [
+      {
+        index: 0,
+        path: 'ok',
+        type: 'query',
+        ok: true,
+        response: successResponse,
+      },
+      {
+        index: 1,
+        path: 'badRequest',
+        type: 'query',
+        ok: false,
+        response: badRequestResponse,
+      },
+      {
+        index: 2,
+        path: 'unavailable',
+        type: 'query',
+        ok: false,
+        response: unavailableResponse,
+      },
+    ],
+  };
+}
+
+describe('isClientBatchEnvelope', () => {
+  it('accepts aggregate batch envelopes', () => {
+    expect(isClientBatchEnvelope(mixedEnvelope())).toBe(true);
+  });
+
+  it('rejects legacy response arrays', () => {
+    expect(isClientBatchEnvelope([successResponse, badRequestResponse])).toBe(false);
+  });
+
+  it('rejects ordinary error responses', () => {
+    expect(isClientBatchEnvelope(badRequestResponse)).toBe(false);
+  });
+});
+
+describe('decodeClientBatchEnvelope', () => {
+  it('decodes aggregate envelope items by index', () => {
+    const decoded = decodeClientBatchEnvelope({
+      json: mixedEnvelope(),
+      expectedItems: 3,
+    });
+
+    expect(decoded).toEqual([successResponse, badRequestResponse, unavailableResponse]);
+  });
+
+  it('preserves legacy response arrays', () => {
+    const decoded = decodeClientBatchEnvelope({
+      json: [successResponse, badRequestResponse],
+      expectedItems: 2,
+    });
+
+    expect(decoded).toEqual([successResponse, badRequestResponse]);
+  });
+
+  it('duplicates a non-array response for every expected item', () => {
+    const decoded = decodeClientBatchEnvelope({
+      json: badRequestResponse,
+      expectedItems: 2,
+    });
+
+    expect(decoded).toEqual([badRequestResponse, badRequestResponse]);
+  });
+
+  it('creates synthetic errors for missing aggregate items', () => {
+    const envelope = mixedEnvelope();
+    envelope.items = envelope.items.filter((item) => item.index !== 1);
+
+    const decoded = decodeClientBatchEnvelope({
+      json: envelope,
+      expectedItems: 3,
+    });
+
+    expect(decoded[1]).toMatchObject({
+      error: {
+        code: -32603,
+        message: 'Missing batch response item at index 1',
+      },
+    });
+  });
+
+  it('uses the requested operation count instead of envelope itemCount', () => {
+    const envelope = mixedEnvelope();
+    envelope.itemCount = 100;
+
+    const decoded = decodeClientBatchEnvelope({
+      json: envelope,
+      expectedItems: 2,
+    });
+
+    expect(decoded).toEqual([successResponse, badRequestResponse]);
+  });
+});
+
+describe('classifyBatchRetry', () => {
+  it('marks a batch retryable when any item error is retryable', () => {
+    const retry = classifyBatchRetry(mixedEnvelope());
+
+    expect(retry).toEqual({
+      retryable: true,
+      reason: 'retryable batch errors',
+      operationIndexes: [2],
+    });
+  });
+
+  it('marks a batch non-retryable when no item error is retryable', () => {
+    const envelope = mixedEnvelope();
+    envelope.errors = envelope.errors.filter((error) => !error.retryable);
+    envelope.items = envelope.items.slice(0, 2);
+    envelope.itemCount = 2;
+
+    const retry = classifyBatchRetry(envelope);
+
+    expect(retry).toEqual({
+      retryable: false,
+      reason: 'batch errors are not retryable',
+      operationIndexes: [],
+    });
+  });
+
+  it('ignores non-envelope values', () => {
+    expect(classifyBatchRetry([badRequestResponse])).toEqual({
+      retryable: false,
+      reason: 'not a batch envelope',
+      operationIndexes: [],
+    });
+  });
+});
+
+describe('firstBatchError', () => {
+  it('returns the first aggregate error as a normal tRPC error response', () => {
+    expect(firstBatchError(mixedEnvelope())).toEqual({
+      error: {
+        code: -32600,
+        message: 'bad request',
+        data: {
+          code: 'BAD_REQUEST',
+          httpStatus: 400,
+          path: 'badRequest',
+        },
+      },
+    });
+  });
+
+  it('returns null for successful envelopes', () => {
+    const envelope = {
+      batch: true,
+      ok: true,
+      itemCount: 1,
+      errors: [],
+      items: [
+        {
+          index: 0,
+          path: 'ok',
+          type: 'query',
+          ok: true,
+          response: successResponse,
+        },
+      ],
+    };
+
+    expect(firstBatchError(envelope)).toBeNull();
+  });
+});
+
+describe('batchEnvelopeToTransportError', () => {
+  it('turns the first item error into a batch transport-like error', () => {
+    const converted = batchEnvelopeToTransportError(mixedEnvelope());
+
+    expect(converted).toEqual({
+      error: {
+        code: -32600,
+        message: 'bad request',
+        data: {
+          code: 'BAD_REQUEST',
+          httpStatus: 400,
+          path: 'badRequest',
+          batch: true,
+          retryable: true,
+          retryOperationIndexes: [2],
+        },
+      },
+    });
+  });
+
+  it('returns null for successful envelopes', () => {
+    expect(
+      batchEnvelopeToTransportError({
+        batch: true,
+        ok: true,
+        itemCount: 1,
+        errors: [],
+        items: [
+          {
+            index: 0,
+            path: 'ok',
+            type: 'query',
+            ok: true,
+            response: successResponse,
+          },
+        ],
+      }),
+    ).toBeNull();
+  });
+});
diff --git a/packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.test.ts b/packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.test.ts
new file mode 100644
index 000000000..fd30f3c5a
--- /dev/null
+++ b/packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.test.ts
@@ -0,0 +1,276 @@
+import { describe, expect, it } from 'vitest';
+import {
+  createBatchErrorEnvelope,
+  createTransportBatchEnvelope,
+  inferRetryable,
+  isBatchErrorEnvelope,
+  summarizeBatchEnvelope,
+  unwrapBatchEnvelope,
+} from './batchEnvelope';
+
+const okItem = {
+  index: 0,
+  path: 'post.list',
+  type: 'query' as const,
+  ok: true,
+  response: {
+    result: {
+      data: [{ id: 'post_1' }],
+    },
+  },
+};
+
+const badInputItem = {
+  index: 1,
+  path: 'post.byId',
+  type: 'query' as const,
+  ok: false,
+  response: {
+    error: {
+      code: -32600,
+      message: 'Invalid input',
+      data: {
+        code: 'BAD_REQUEST',
+        httpStatus: 400,
+        path: 'post.byId',
+      },
+    },
+  },
+};
+
+const unavailableItem = {
+  index: 2,
+  path: 'post.latest',
+  type: 'query' as const,
+  ok: false,
+  response: {
+    error: {
+      code: -32603,
+      message: 'Database unavailable',
+      data: {
+        code: 'SERVICE_UNAVAILABLE',
+        httpStatus: 503,
+        path: 'post.latest',
+      },
+    },
+  },
+};
+
+describe('createBatchErrorEnvelope', () => {
+  it('wraps successes and errors in an aggregate object', () => {
+    const envelope = createBatchErrorEnvelope([okItem, badInputItem, unavailableItem]);
+
+    expect(envelope.batch).toBe(true);
+    expect(envelope.ok).toBe(false);
+    expect(envelope.itemCount).toBe(3);
+    expect(envelope.items).toHaveLength(3);
+    expect(envelope.errors).toEqual([
+      {
+        index: 1,
+        path: 'post.byId',
+        type: 'query',
+        code: -32600,
+        message: 'Invalid input',
+        data: {
+          code: 'BAD_REQUEST',
+          httpStatus: 400,
+          path: 'post.byId',
+        },
+        retryable: false,
+      },
+      {
+        index: 2,
+        path: 'post.latest',
+        type: 'query',
+        code: -32603,
+        message: 'Database unavailable',
+        data: {
+          code: 'SERVICE_UNAVAILABLE',
+          httpStatus: 503,
+          path: 'post.latest',
+        },
+        retryable: true,
+      },
+    ]);
+  });
+
+  it('marks all-success envelopes as ok', () => {
+    const envelope = createBatchErrorEnvelope([okItem]);
+
+    expect(envelope).toMatchObject({
+      batch: true,
+      ok: true,
+      itemCount: 1,
+      errors: [],
+    });
+  });
+});
+
+describe('createTransportBatchEnvelope', () => {
+  it('creates one synthetic error response per expected item', () => {
+    const envelope = createTransportBatchEnvelope({
+      itemCount: 3,
+      message: 'Batching is not enabled on the server',
+      code: -32600,
+      data: {
+        code: 'BAD_REQUEST',
+        httpStatus: 400,
+      },
+    });
+
+    expect(envelope.items).toHaveLength(3);
+    expect(envelope.errors).toHaveLength(3);
+    expect(envelope.items[0]).toMatchObject({
+      index: 0,
+      path: '*',
+      type: 'unknown',
+      ok: false,
+    });
+    expect(envelope.items[1]).toMatchObject({
+      index: 1,
+      path: '*',
+      type: 'unknown',
+      ok: false,
+    });
+    expect(envelope.items[2]).toMatchObject({
+      index: 2,
+      path: '*',
+      type: 'unknown',
+      ok: false,
+    });
+  });
+});
+
+describe('isBatchErrorEnvelope', () => {
+  it('recognizes aggregate envelope objects', () => {
+    expect(isBatchErrorEnvelope(createBatchErrorEnvelope([okItem]))).toBe(true);
+  });
+
+  it('rejects legacy response arrays', () => {
+    expect(isBatchErrorEnvelope([okItem.response])).toBe(false);
+  });
+
+  it('rejects ordinary responses', () => {
+    expect(isBatchErrorEnvelope(okItem.response)).toBe(false);
+  });
+});
+
+describe('unwrapBatchEnvelope', () => {
+  it('returns the underlying tRPC responses in item order', () => {
+    const envelope = createBatchErrorEnvelope([okItem, badInputItem]);
+
+    expect(unwrapBatchEnvelope(envelope)).toEqual([okItem.response, badInputItem.response]);
+  });
+});
+
+describe('inferRetryable', () => {
+  it('marks internal server errors retryable', () => {
+    expect(inferRetryable(-32603)).toBe(true);
+  });
+
+  it('marks bad request errors non-retryable', () => {
+    expect(inferRetryable(-32600)).toBe(false);
+  });
+});
+
+describe('summarizeBatchEnvelope', () => {
+  it('summarizes paths and retryability', () => {
+    const envelope = createBatchErrorEnvelope([okItem, badInputItem, unavailableItem]);
+
+    expect(summarizeBatchEnvelope(envelope)).toEqual({
+      ok: false,
+      itemCount: 3,
+      errorCount: 2,
+      retryable: true,
+      paths: ['post.list', 'post.byId', 'post.latest'],
+    });
+  });
+});
diff --git a/packages/tests/server/batchErrorEnvelope.test.ts b/packages/tests/server/batchErrorEnvelope.test.ts
new file mode 100644
index 000000000..db1eeaa11
--- /dev/null
+++ b/packages/tests/server/batchErrorEnvelope.test.ts
@@ -0,0 +1,391 @@
+import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from '@trpc/client';
+import { testServerAndClientResource } from '@trpc/client/__tests__/testClientResource';
+import { initTRPC, TRPCError } from '@trpc/server';
+import { waitError } from '@trpc/server/__tests__/waitError';
+import { describe, expect, it, vi } from 'vitest';
+import { z } from 'zod';
+
+const t = initTRPC.create();
+
+const router = t.router({
+  ok: t.procedure.input(z.string()).query((opts) => {
+    return `ok:${opts.input}`;
+  }),
+  badRequest: t.procedure.query(() => {
+    throw new TRPCError({
+      code: 'BAD_REQUEST',
+      message: 'bad request from procedure',
+    });
+  }),
+  unavailable: t.procedure.query(() => {
+    throw new TRPCError({
+      code: 'SERVICE_UNAVAILABLE',
+      message: 'temporary outage',
+    });
+  }),
+});
+
+describe('batch error envelope', () => {
+  it('returns success and error items from the same batch', async () => {
+    await using ctx = testServerAndClientResource(router, {
+      server: {},
+      clientLink: 'httpBatchLink',
+    });
+
+    const results = await Promise.allSettled([
+      ctx.client.ok.query('a'),
+      ctx.client.badRequest.query(),
+    ]);
+
+    expect(results[0]).toMatchObject({
+      status: 'fulfilled',
+      value: 'ok:a',
+    });
+    expect(results[1].status).toBe('rejected');
+    const err = (results[1] as PromiseRejectedResult).reason as TRPCClientError<typeof router>;
+    expect(err.data?.code).toBe('BAD_REQUEST');
+    expect(err.message).toBe('bad request from procedure');
+  });
+
+  it('maps a retryable procedure error to every operation in the batch', async () => {
+    await using ctx = testServerAndClientResource(router, {
+      server: {},
+      clientLink: 'httpBatchLink',
+    });
+
+    const err = await waitError(
+      Promise.all([
+        ctx.client.ok.query('a'),
+        ctx.client.unavailable.query(),
+      ]),
+      TRPCClientError<typeof router>,
+    );
+
+    expect(err).toBeInstanceOf(TRPCClientError);
+    expect(err.data?.code).toBe('SERVICE_UNAVAILABLE');
+    expect(err.data?.retryable).toBe(true);
+    expect(err.data?.batch).toBe(true);
+  });
+
+  it('supports legacy batch arrays', async () => {
+    const fetch = vi.fn(async () => {
+      return new Response(
+        JSON.stringify([
+          { result: { data: 'one' } },
+          {
+            error: {
+              code: -32600,
+              message: 'legacy bad request',
+              data: {
+                code: 'BAD_REQUEST',
+                httpStatus: 400,
+                path: 'badRequest',
+              },
+            },
+          },
+        ]),
+        {
+          status: 207,
+          headers: { 'content-type': 'application/json' },
+        },
+      );
+    });
+
+    const client = createTestClient(fetch);
+    const results = await Promise.allSettled([
+      client.ok.query('a'),
+      client.badRequest.query(),
+    ]);
+
+    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'one' });
+    expect(results[1].status).toBe('rejected');
+  });
+
+  it('accepts a new aggregate envelope without a feature header', async () => {
+    const fetch = vi.fn(async () => {
+      return new Response(
+        JSON.stringify({
+          batch: true,
+          ok: false,
+          itemCount: 2,
+          errors: [
+            {
+              index: 1,
+              path: 'badRequest',
+              type: 'query',
+              code: -32600,
+              message: 'bad request from procedure',
+              data: {
+                code: 'BAD_REQUEST',
+                httpStatus: 400,
+                path: 'badRequest',
+              },
+              retryable: false,
+            },
+          ],
+          items: [
+            {
+              index: 0,
+              path: 'ok',
+              type: 'query',
+              ok: true,
+              response: { result: { data: 'ok:a' } },
+            },
+            {
+              index: 1,
+              path: 'badRequest',
+              type: 'query',
+              ok: false,
+              response: {
+                error: {
+                  code: -32600,
+                  message: 'bad request from procedure',
+                  data: {
+                    code: 'BAD_REQUEST',
+                    httpStatus: 400,
+                    path: 'badRequest',
+                  },
+                },
+              },
+            },
+          ],
+        }),
+        {
+          status: 207,
+          headers: { 'content-type': 'application/json' },
+        },
+      );
+    });
+
+    const client = createTestClient(fetch);
+    const results = await Promise.allSettled([
+      client.ok.query('a'),
+      client.badRequest.query(),
+    ]);
+
+    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'ok:a' });
+    expect(results[1].status).toBe('rejected');
+  });
+});
+
+function createTestClient(fetch: typeof globalThis.fetch) {
+  return createTRPCProxyClient<typeof router>({
+    links: [
+      httpBatchLink({
+        url: 'http://localhost/trpc',
+        fetch,
+      }),
+    ],
+  });
+}
diff --git a/www/docs/client/links/httpBatchLink.md b/www/docs/client/links/httpBatchLink.md
index 1fa612750..522a47d01 100644
--- a/www/docs/client/links/httpBatchLink.md
+++ b/www/docs/client/links/httpBatchLink.md
@@ -72,6 +72,126 @@ The `httpBatchLink` batches an array of individual tRPC operations into a single
 });
 ```
 
+## Batch error envelope
+
+When a batch contains one or more failed operations, the server now returns an
+aggregate envelope:
+
+```json
+{
+  "batch": true,
+  "ok": false,
+  "itemCount": 2,
+  "errors": [
+    {
+      "index": 1,
+      "path": "post.byId",
+      "type": "query",
+      "code": -32600,
+      "message": "Invalid input",
+      "retryable": false
+    }
+  ],
+  "items": [
+    {
+      "index": 0,
+      "path": "post.list",
+      "type": "query",
+      "ok": true,
+      "response": {
+        "result": {
+          "data": []
+        }
+      }
+    },
+    {
+      "index": 1,
+      "path": "post.byId",
+      "type": "query",
+      "ok": false,
+      "response": {
+        "error": {
+          "code": -32600,
+          "message": "Invalid input"
+        }
+      }
+    }
+  ]
+}
+```
+
+The `items` array contains the normal tRPC response for every operation. The
+top-level `errors` array is a convenience summary for logging, retries, and
+debugging.
+
+Existing clients can continue using `httpBatchLink`. The link automatically
+detects the aggregate envelope and maps it back to individual operation results.
+
+### Retry behavior
+
+If any item in the aggregate envelope is retryable, the client treats the whole
+batch as retryable. This keeps retry links simple because they can inspect one
+error object rather than every operation.
+
+A batch with one `SERVICE_UNAVAILABLE` operation and one successful operation
+will surface a retryable batch error. Retrying the batch may replay successful
+operations as well as failed operations.
+
+### Compatibility
+
+The aggregate envelope is emitted for all non-streaming batched HTTP responses.
+Clients that do not understand the shape should upgrade to the latest
+`@trpc/client`.
+
+Streaming batch links continue using their existing newline-delimited envelope
+format.
+
 ## Reference
 
 ```ts
diff --git a/www/docs/migration/batch-error-envelope.md b/www/docs/migration/batch-error-envelope.md
new file mode 100644
index 000000000..e7e0fd0a8
--- /dev/null
+++ b/www/docs/migration/batch-error-envelope.md
@@ -0,0 +1,312 @@
+# Batch error envelope migration
+
+The batch error envelope changes the JSON returned by non-streaming HTTP batch
+requests. This guide explains how to migrate clients and servers.
+
+## Previous response shape
+
+Older servers return an array of tRPC response envelopes:
+
+```json
+[
+  {
+    "result": {
+      "data": "first"
+    }
+  },
+  {
+    "error": {
+      "code": -32600,
+      "message": "Invalid input",
+      "data": {
+        "code": "BAD_REQUEST",
+        "httpStatus": 400,
+        "path": "second"
+      }
+    }
+  }
+]
+```
+
+Each item belongs to the operation at the same batch index.
+
+## New response shape
+
+New servers return an aggregate object:
+
+```json
+{
+  "batch": true,
+  "ok": false,
+  "itemCount": 2,
+  "errors": [
+    {
+      "index": 1,
+      "path": "second",
+      "type": "query",
+      "code": -32600,
+      "message": "Invalid input",
+      "retryable": false
+    }
+  ],
+  "items": [
+    {
+      "index": 0,
+      "path": "first",
+      "type": "query",
+      "ok": true,
+      "response": {
+        "result": {
+          "data": "first"
+        }
+      }
+    },
+    {
+      "index": 1,
+      "path": "second",
+      "type": "query",
+      "ok": false,
+      "response": {
+        "error": {
+          "code": -32600,
+          "message": "Invalid input"
+        }
+      }
+    }
+  ]
+}
+```
+
+The `items[n].response` field is still the normal tRPC response for operation
+`n`. The top-level `errors` array summarizes failed items.
+
+## Client upgrade
+
+Upgrade `@trpc/client` before upgrading servers that emit the aggregate shape.
+The updated `httpBatchLink` understands both old arrays and new aggregate
+objects.
+
+```ts
+import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
+
+export const client = createTRPCProxyClient<AppRouter>({
+  links: [
+    httpBatchLink({
+      url: '/api/trpc',
+    }),
+  ],
+});
+```
+
+No client option is required. The link detects the envelope automatically.
+
+## Server upgrade
+
+Servers emit the aggregate envelope for every non-streaming batched response.
+No router configuration is required.
+
+```ts
+import { initTRPC } from '@trpc/server';
+
+const t = initTRPC.create();
+```
+
+Streaming batch links are unchanged.
+
+## Retry behavior
+
+The aggregate envelope contains a `retryable` boolean for every summarized
+error. The client marks the batch retryable if any summarized error is retryable.
+
+This means a batch containing one success and one retryable error can be retried
+as a whole. If the successful operation was a mutation, the mutation may run
+again.
+
+Applications that use mutation batching should either avoid retrying batches or
+make mutations idempotent.
+
+## Mixed statuses
+
+Servers still return `207` for mixed success and error batches.
+
+```txt
+HTTP/1.1 207 Multi-Status
+content-type: application/json
+```
+
+The response body contains `ok: false` when at least one item failed.
+
+## Logging
+
+The top-level `errors` array is designed for logs:
+
+```ts
+function logBatchEnvelope(envelope: BatchErrorEnvelope) {
+  for (const error of envelope.errors) {
+    logger.warn('tRPC batch item failed', {
+      index: error.index,
+      path: error.path,
+      type: error.type,
+      code: error.code,
+      retryable: error.retryable,
+    });
+  }
+}
+```
+
+Use `items` when you need to resolve a particular operation result.
+
+## Compatibility table
+
+| Server | Client | Result |
+|---|---|---|
+| Old array server | Old client | Works |
+| Old array server | New client | Works |
+| New envelope server | New client | Works |
+| New envelope server | Old client | Upgrade client |
+
+## Operational rollout
+
+Recommended rollout order:
+
+1. Upgrade clients.
+2. Verify clients can decode legacy array responses.
+3. Upgrade servers.
+4. Monitor transform errors and batch retry counts.
+
+If transform errors increase, check that all clients have been upgraded.
+
+## Example mixed batch
+
+```ts
+const results = await Promise.allSettled([
+  client.post.list.query(),
+  client.post.byId.query({ id: 'missing' }),
+]);
+
+if (results[0].status === 'fulfilled') {
+  console.log(results[0].value);
+}
+
+if (results[1].status === 'rejected') {
+  console.error(results[1].reason);
+}
+```
+
+The first result can still fulfill while the second rejects.
+
+## Whole-batch errors
+
+Some errors affect every item:
+
+- batching disabled on the server,
+- context creation failure,
+- invalid request body,
+- failed content type parsing,
+- network failure before the server returns JSON.
+
+These errors may be repeated for every operation.
+
+Procedure errors should remain attached to their operation index.
+
+## Debugging malformed envelopes
+
+If the client receives fewer `items` than expected, it creates an internal error
+for the missing indexes. This prevents promises from hanging forever.
+
+```json
+{
+  "error": {
+    "code": -32603,
+    "message": "Missing batch response item at index 1"
+  }
+}
+```
+
+Malformed envelopes should be treated as server bugs.
+
+## Notes for library authors
+
+Libraries that inspect `TRPCClientError.meta.responseJSON` may now see either:
+
+- a legacy array of tRPC responses,
+- an aggregate batch envelope,
+- a single response object for non-batch calls.
+
+Inspect `batch === true` before reading `items`.
+
+## Notes for custom links
+
+Custom links that sit after `httpBatchLink` continue receiving normal
+per-operation results.
+
+Custom terminating links that implement their own HTTP batching must either
+return legacy arrays or implement the aggregate envelope decoder.
+
+## Rollback
+
+Rollback server deployment first if old clients still exist. New clients can
+decode old arrays, but old clients cannot decode aggregate envelopes.
+
+After rollback, no client changes are required.
+
+## Metrics
+
+Track the number of aggregate envelopes decoded by clients and the number of
+batch-level retry decisions. A sudden rise in transform failures indicates an
+old client still receiving the new shape.
+
+Recommended counters:
+
+- `trpc.batch_envelope.decoded`
+- `trpc.batch_envelope.transform_error`
+- `trpc.batch_envelope.retry_all`
+- `trpc.batch_envelope.retry_item`
+
+Dashboards should split these by client package version so a mixed fleet is
+visible during rollout.
```

## Intended Flaws

### Flaw 1: The new aggregate envelope collapses transport and per-call error semantics

The client turns any retryable item in the batch envelope into a transport-like error for every operation in the batch.

Relevant line references:

- `packages/client/src/links/internals/batchEnvelope.ts:69-83` classifies retryability by scanning top-level envelope errors rather than preserving the operation-specific error as operation-specific.
- `packages/client/src/links/internals/batchEnvelope.ts:103-124` converts the first batch error into a single error with `batch: true`, `retryable`, and `retryOperationIndexes`.
- `packages/client/src/links/httpBatchLink.ts:70-79` maps that aggregate error to every batched operation before `transformResult(...)` runs.
- `packages/tests/server/batchErrorEnvelope.test.ts:50-67` expects one retryable procedure failure to reject the whole `Promise.all` with a batch-level retryable error.
- `www/docs/client/links/httpBatchLink.md:132-138` documents that any retryable item makes the whole batch retryable, including successful operations.

Why this is a real flaw:

A batch can fail at two different layers. The whole HTTP request can fail, which is a transport failure that legitimately affects every operation. Or one procedure inside a successful HTTP batch can fail, which should be delivered only to that operation. This PR blurs those layers: a single `SERVICE_UNAVAILABLE` procedure result can become a batch-level retry signal for all operations. Retry links may replay operations that already succeeded, mutations can run twice, and clients lose the ability to reason about per-call error ownership.

Better implementation direction:

Keep the canonical batch response as an array of per-operation `{ result } | { error }` items. If a summary is useful, expose it as metadata that does not replace per-item semantics. Retry classification should happen per operation unless the HTTP request itself failed or the server returned a whole-request envelope because it could not dispatch the batch.

### Flaw 2: The server unconditionally returns a new response shape that old clients cannot decode

The server emits the aggregate envelope for every non-streaming batch, even though existing clients expect an array of `TRPCResponse` items.

Relevant line references:

- `packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts:703-714` wraps normal batch items into `resultAsBatchEnvelope`.
- `packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts:742-746` serializes the aggregate envelope instead of the existing `resultAsRPCResponse` array.
- `packages/server/src/unstable-core-do-not-import/rpc/batchEnvelope.ts:22-54` defines a top-level `{ batch, ok, itemCount, errors, items }` object that is not a `TRPCResponse` item.
- `packages/tests/server/batchErrorEnvelope.test.ts:104-162` accepts the new envelope without any feature negotiation or version gate.
- `www/docs/client/links/httpBatchLink.md:142-144` says clients that do not understand the shape should upgrade.

Why this is a real flaw:

tRPC clients and servers are often upgraded independently. The old `httpBatchLink` sees a non-array JSON response and replicates it to every operation, then `transformResult(...)` fails because `{ batch: true, ... }` has neither `result` nor `error`. That turns ordinary mixed batches into "Unable to transform response from server" for old clients. This is a wire-protocol compatibility break.

Better implementation direction:

Version or negotiate the new envelope. For example, only emit it when the client sends an explicit `trpc-accept` value or a new batch-envelope header. Otherwise keep returning the existing array. The client should dual-decode old and new shapes during the migration window, and docs should give a compatibility matrix rather than requiring lockstep upgrades.

## Hints

### Flaw 1 Hints

1. Follow a batch with one success and one retryable procedure error. Which operation receives the retryable error?
2. Where should retry logic live: on the whole HTTP request, or on the individual procedure result?
3. What changes if the successful operation is a mutation?

### Flaw 2 Hints

1. What does the old `httpBatchLink` do when the response JSON is not an array?
2. Does `{ batch: true, items: [...] }` satisfy the existing `TRPCResponse` shape?
3. Where is the feature negotiation that lets old clients keep receiving the old array shape?

## Expected Answer

A strong review should say that the product-level change is a batch debugging/error-summary envelope, but the implementation changes the wire contract and error ownership model.

For flaw 1, the learner should identify that a per-procedure error is promoted into a batch-level/transport-like error and then mapped to every operation. The impact is unsafe retry behavior and duplicate successful operation replay. The fix is per-operation retry classification, with whole-batch errors reserved for actual transport or dispatch failures.

For flaw 2, the learner should identify that the server unconditionally returns a new top-level shape. The impact is old clients breaking on normal batched responses. The fix is feature-gated negotiation or dual-format compatibility.

The best answers cite both server and client changes. The bug is not just in one side; it is a contract mismatch across the protocol boundary.

## Expert Debrief

At the product level, the PR is trying to make batch failures easier to inspect. That is useful. But protocol changes are dangerous because every client, server, link, retry layer, transformer, and error formatter depends on the envelope shape.

The contract change is bigger than it looks. Before this PR, a batch response is an array of ordinary tRPC response envelopes. Each operation owns its own result or error. After this PR, the server can return a new aggregate object, and the client may convert one item error into a batch-level error sent to every operation.

The failure modes are practical:

- A successful mutation is retried because another batched query returned `SERVICE_UNAVAILABLE`.
- An old client receives `{ batch: true }`, treats it as every operation's response, and throws a transform error.
- Retry links cannot distinguish HTTP request failure from procedure failure.
- Error formatters and transformers are bypassed or applied to a shape they were not designed to validate.
- Mixed batch status and path ownership become harder to reason about.

The reviewer thought process should be: first identify the wire contract, then ask whether the PR preserves it for old clients and old servers. Then classify every error by ownership: transport, batch dispatch, or procedure item. If those ownership levels get collapsed, retries and observability become dangerous.

The better implementation is incremental. Keep the old array as the canonical response. Add optional summary metadata only when explicitly negotiated. Teach the new client to decode both formats. Preserve per-item errors and let retry links decide per operation. Only use a whole-batch error when the server could not produce per-operation responses.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: collapsed transport/per-call error semantics and unconditional incompatible response shape. It explains retry duplication and old-client breakage, and suggests per-item semantics plus negotiated migration.
- `partial`: The answer finds one flaw completely and mentions compatibility or retry risk without tying it to the exact protocol boundary.
- `miss`: The answer focuses on naming, type definitions, or docs wording while missing the envelope contract and retry semantics.
