# TS-010: tRPC Admin Internal Batch Endpoint

## Metadata

- `id`: TS-010
- `source_repo`: [trpc/trpc](https://github.com/trpc/trpc)
- `repo_area`: client links, HTTP batch transport, request parsing, fetch adapter, response envelopes, batching tests
- `mode`: synthetic_degraded
- `difficulty`: 1
- `target_diff_lines`: 891
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about runtime API contracts, batching semantics, retries, partial success, HTTP status envelopes, and type-only guarantees without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds an optional internal batch endpoint for admin tools.

Some admin screens need to run a small group of tRPC calls together, such as loading account state, updating a flag, and recording an audit note. The new link sends a single POST request to an internal endpoint and returns typed results to the caller.

The PR adds:

- a new `internalBatchLink`,
- a server-side `resolveInternalBatchResponse` helper,
- `internalBatching` fetch adapter options,
- support for mixed query and mutation calls in a single internal batch,
- per-item result and error envelopes,
- tests for success, partial failure, mixed query/mutation calls, and retry behavior.

## Existing Code Context

The real tRPC codebase already has these relevant contracts:

- `packages/client/src/links/httpBatchLink.ts` creates separate data loaders for queries and mutations. A query batch and a mutation batch do not share the same transport request.
- `packages/client/src/links/httpBatchStreamLink.ts` follows the same query/mutation separation while adding streaming response support.
- `packages/server/src/unstable-core-do-not-import/http/contentType.ts` parses `batch=1` requests and rejects mixed procedure types with `Cannot mix procedure types in call`.
- `packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts` maps procedure type to accepted HTTP methods. Mutations require POST, queries use GET unless method override is explicitly enabled, and subscriptions are not batchable.
- `packages/server/src/unstable-core-do-not-import/http/getHTTPStatusCode.ts` returns `207` for a batch response when item statuses differ.
- `packages/client/src/internals/dataLoader.ts` batches only operations accepted by its loader validation function; it does not imply transactionality.
- `packages/tests/server/batching.test.ts` verifies batching behavior, disabled batching errors, error paths, and batch indices.
- `packages/tests/server/methodOverride.test.ts` documents that method override is a deliberate opt-in and does not allow GET mutations.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `packages/client/src/links/internalBatchLink.ts`
- `packages/client/src/links.ts`
- `packages/server/src/unstable-core-do-not-import/http/internalBatch.ts`
- `packages/server/src/unstable-core-do-not-import/http/types.ts`
- `packages/server/src/adapters/fetch/fetchRequestHandler.ts`
- `packages/tests/server/internalBatchLink.test.ts`

The line references below use synthetic PR line numbers. The represented diff is intentionally focused on the transport/runtime contract rather than app-specific UI.

## Diff

```diff
diff --git a/packages/client/src/links/internalBatchLink.ts b/packages/client/src/links/internalBatchLink.ts
new file mode 100644
index 0000000000..3e0f4f4d1b
--- /dev/null
+++ b/packages/client/src/links/internalBatchLink.ts
@@ -0,0 +1,219 @@
+import type {
+  AnyClientTypes,
+  AnyRouter,
+  ProcedureType,
+  TRPCResponse,
+} from '@trpc/server/unstable-core-do-not-import';
+import { observable } from '@trpc/server/observable';
+import { transformResult } from '@trpc/server/unstable-core-do-not-import';
+import type { BatchLoader } from '../internals/dataLoader';
+import { dataLoader } from '../internals/dataLoader';
+import { allAbortSignals } from '../internals/signals';
+import type { FetchEsque } from '../internals/types';
+import { getFetch } from '../getFetch';
+import { TRPCClientError } from '../TRPCClientError';
+import type { Operation, TRPCLink, HTTPHeaders } from './types';
+import type { TransformerOptions } from '../unstable-internals';
+import { getTransformer } from '../unstable-internals';
+
+export type InternalBatchMode = 'best-effort' | 'atomic';
+
+export type InternalBatchItem = {
+  id: number;
+  type: Exclude<ProcedureType, 'subscription'>;
+  path: string;
+  input: unknown;
+};
+
+export type InternalBatchRequest = {
+  mode: InternalBatchMode;
+  calls: InternalBatchItem[];
+};
+
+export type InternalBatchSuccess<TData = unknown> = {
+  ok: true;
+  id: number;
+  data: TData;
+};
+
+export type InternalBatchFailure = {
+  ok: false;
+  id: number;
+  error: {
+    message: string;
+    code: string;
+    data?: unknown;
+  };
+};
+
+export type InternalBatchEnvelope<TData = unknown> = {
+  ok: boolean;
+  mode: InternalBatchMode;
+  results: Array<InternalBatchSuccess<TData> | InternalBatchFailure>;
+};
+
+export type InternalBatchLinkOptions<TRoot extends AnyClientTypes> =
+  TransformerOptions<TRoot> & {
+    url: string | URL;
+    fetch?: FetchEsque;
+    mode?: InternalBatchMode;
+    maxItems?: number;
+    headers?:
+      | HTTPHeaders
+      | ((opts: {
+          opList: Operation[];
+        }) => HTTPHeaders | Promise<HTTPHeaders>);
+  };
+
+function arrayToRecord(values: unknown[]) {
+  const record: Record<number, unknown> = {};
+  for (let index = 0; index < values.length; index++) {
+    record[index] = values[index];
+  }
+  return record;
+}
+
+async function resolveHeaders(
+  headers:
+    | HTTPHeaders
+    | ((opts: { opList: Operation[] }) => HTTPHeaders | Promise<HTTPHeaders>)
+    | undefined,
+  opList: Operation[]
+) {
+  if (!headers) {
+    return {};
+  }
+  const value = typeof headers === 'function' ? await headers({ opList }) : headers;
+  if (Symbol.iterator in value) {
+    return Object.fromEntries(value);
+  }
+  return value;
+}
+
+export function internalBatchLink<TRouter extends AnyRouter>(
+  opts: InternalBatchLinkOptions<TRouter['_def']['_config']['$types']>
+): TRPCLink<TRouter> {
+  const transformer = getTransformer(opts.transformer);
+  const url = opts.url.toString().replace(/\/$/, '');
+  const maxItems = opts.maxItems ?? 25;
+  const mode = opts.mode ?? 'atomic';
+
+  return () => {
+    const loader: BatchLoader<Operation, { json: TRPCResponse; response: Response }> = {
+      validate(ops) {
+        return ops.length <= maxItems;
+      },
+      async fetch(ops) {
+        const signal = allAbortSignals(...ops.map((op) => op.signal));
+        const request: InternalBatchRequest = {
+          mode,
+          calls: ops.map((op) => ({
+            id: op.id,
+            type: op.type as Exclude<ProcedureType, 'subscription'>,
+            path: op.path,
+            input: transformer.input.serialize(op.input),
+          })),
+        };
+
+        const response = await getFetch(opts.fetch)(`${url}/_batch`, {
+          method: 'POST',
+          signal,
+          headers: {
+            'content-type': 'application/json',
+            'trpc-internal-batch': '1',
+            ...(await resolveHeaders(opts.headers, ops)),
+          },
+          body: JSON.stringify(request),
+        });
+
+        const envelope = (await response.json()) as InternalBatchEnvelope;
+        if (!Array.isArray(envelope.results)) {
+          throw new Error('Invalid internal batch response');
+        }
+
+        const byId = new Map(envelope.results.map((result) => [result.id, result]));
+
+        return ops.map((op) => {
+          const item = byId.get(op.id);
+          if (!item) {
+            return {
+              response,
+              json: {
+                error: {
+                  message: 'Missing internal batch item result',
+                  code: -32603,
+                  data: {
+                    code: 'INTERNAL_SERVER_ERROR',
+                    httpStatus: 500,
+                    path: op.path,
+                  },
+                },
+              },
+            };
+          }
+
+          if (!item.ok) {
+            return {
+              response,
+              json: {
+                error: {
+                  message: item.error.message,
+                  code: -32603,
+                  data: {
+                    code: item.error.code,
+                    httpStatus: response.status,
+                    path: op.path,
+                    cause: item.error.data,
+                  },
+                },
+              },
+            };
+          }
+
+          return {
+            response,
+            json: {
+              result: {
+                data: item.data,
+              },
+            },
+          };
+        });
+      },
+    };
+
+    const batch = dataLoader(loader);
+
+    return ({ op }) => {
+      return observable((observer) => {
+        if (op.type === 'subscription') {
+          throw new Error(
+            'Subscriptions are unsupported by `internalBatchLink` - use httpSubscriptionLink or wsLink',
+          );
+        }
+
+        let response: Response | undefined;
+        batch
+          .load(op)
+          .then((res) => {
+            response = res.response;
+            const transformed = transformResult(res.json, transformer.output);
+            if (!transformed.ok) {
+              observer.error(
+                TRPCClientError.from(transformed.error, {
+                  meta: {
+                    response: res.response,
+                  },
+                })
+              );
+              return;
+            }
+            observer.next({
+              context: {
+                response: res.response,
+                internalBatchMode: mode,
+              },
+              result: transformed.result,
+            });
+            observer.complete();
+          })
+          .catch((cause) => {
+            observer.error(
+              TRPCClientError.from(cause, {
+                meta: response ? { response } : undefined,
+              })
+            );
+          });
+
+        return () => {
+          // Intentionally leave request lifetime tied to the batch signal.
+        };
+      });
+    };
+  };
+}
diff --git a/packages/client/src/links.ts b/packages/client/src/links.ts
index 4d589dff64..89ef286cc5 100644
--- a/packages/client/src/links.ts
+++ b/packages/client/src/links.ts
@@ -3,6 +3,7 @@ export * from './links/httpLink';
 export * from './links/httpBatchLink';
 export * from './links/httpBatchStreamLink';
+export * from './links/internalBatchLink';
 export * from './links/httpSubscriptionLink';
 export * from './links/loggerLink';
 export * from './links/retryLink';
diff --git a/packages/server/src/unstable-core-do-not-import/http/internalBatch.ts b/packages/server/src/unstable-core-do-not-import/http/internalBatch.ts
new file mode 100644
index 0000000000..d7a81614f7
--- /dev/null
+++ b/packages/server/src/unstable-core-do-not-import/http/internalBatch.ts
@@ -0,0 +1,234 @@
+import { getErrorShape } from '../error/getErrorShape';
+import { getTRPCErrorFromUnknown, TRPCError } from '../error/TRPCError';
+import type { ProcedureType } from '../procedure';
+import type { AnyRouter, inferRouterContext } from '../router';
+import { getProcedureAtPath } from '../router';
+import { transformTRPCResponse } from '../transformer';
+import type {
+  HTTPBaseHandlerOptions,
+  ResolveHTTPRequestOptionsContextFn,
+  TRPCRequestInfo,
+} from './types';
+
+type InternalBatchMode = 'best-effort' | 'atomic';
+
+type InternalBatchRequestItem = {
+  id: number;
+  type: Exclude<ProcedureType, 'subscription'>;
+  path: string;
+  input: unknown;
+};
+
+type InternalBatchRequestBody = {
+  mode?: InternalBatchMode;
+  calls?: InternalBatchRequestItem[];
+};
+
+type InternalBatchResult =
+  | {
+      ok: true;
+      id: number;
+      data: unknown;
+    }
+  | {
+      ok: false;
+      id: number;
+      error: {
+        code: string;
+        message: string;
+        data?: unknown;
+      };
+    };
+
+type ResolveInternalBatchOptions<TRouter extends AnyRouter> =
+  HTTPBaseHandlerOptions<TRouter, Request> & {
+    req: Request;
+    createContext: ResolveHTTPRequestOptionsContextFn<TRouter>;
+    endpoint: string;
+    maxInternalBatchSize?: number;
+  };
+
+function isObject(value: unknown): value is Record<string, unknown> {
+  return typeof value === 'object' && value !== null && !Array.isArray(value);
+}
+
+function getHTTPStatus(results: InternalBatchResult[]) {
+  if (results.length === 0) {
+    return 400;
+  }
+  if (results.every((result) => result.ok)) {
+    return 200;
+  }
+  if (results.every((result) => !result.ok)) {
+    return 400;
+  }
+  return 200;
+}
+
+async function parseBody(req: Request): Promise<InternalBatchRequestBody> {
+  const body = await req.json();
+  if (!isObject(body)) {
+    throw new TRPCError({
+      code: 'BAD_REQUEST',
+      message: 'Internal batch body must be an object',
+    });
+  }
+  return body as InternalBatchRequestBody;
+}
+
+function validateBody(body: InternalBatchRequestBody, maxBatchSize: number) {
+  const calls = body.calls ?? [];
+  if (!Array.isArray(calls)) {
+    throw new TRPCError({
+      code: 'BAD_REQUEST',
+      message: 'Internal batch calls must be an array',
+    });
+  }
+  if (calls.length === 0) {
+    throw new TRPCError({
+      code: 'BAD_REQUEST',
+      message: 'Internal batch must contain at least one call',
+    });
+  }
+  if (calls.length > maxBatchSize) {
+    throw new TRPCError({
+      code: 'BAD_REQUEST',
+      message: 'Internal batch exceeds maximum size',
+    });
+  }
+  for (const call of calls) {
+    if (
+      !isObject(call) ||
+      typeof call.id !== 'number' ||
+      typeof call.path !== 'string' ||
+      (call.type !== 'query' && call.type !== 'mutation')
+    ) {
+      throw new TRPCError({
+        code: 'BAD_REQUEST',
+        message: 'Invalid internal batch call',
+      });
+    }
+  }
+  return calls;
+}
+
+function makeInfo(calls: InternalBatchRequestItem[]): TRPCRequestInfo {
+  return {
+    isBatchCall: true,
+    accept: null,
+    type: calls.some((call) => call.type === 'mutation') ? 'mutation' : 'query',
+    calls: calls.map((call, index) => ({
+      batchIndex: index,
+      path: call.path,
+      procedure: undefined,
+      getRawInput: async () => call.input,
+      result: () => call.input,
+    })),
+    connectionParams: null,
+    signal: undefined,
+    url: null,
+  };
+}
+
+export async function resolveInternalBatchResponse<TRouter extends AnyRouter>(
+  opts: ResolveInternalBatchOptions<TRouter>
+): Promise<Response> {
+  const headers = new Headers([['content-type', 'application/json']]);
+  const maxBatchSize =
+    opts.maxInternalBatchSize ?? opts.maxBatchSize ?? Number.POSITIVE_INFINITY;
+
+  try {
+    if (opts.req.method !== 'POST') {
+      throw new TRPCError({
+        code: 'METHOD_NOT_SUPPORTED',
+        message: 'Internal batch endpoint only supports POST',
+      });
+    }
+
+    const body = await parseBody(opts.req);
+    const calls = validateBody(body, maxBatchSize);
+    const info = makeInfo(calls);
+    const ctx = await opts.createContext({ info });
+    const results: InternalBatchResult[] = [];
+
+    for (const call of calls) {
+      try {
+        const procedure = await getProcedureAtPath(opts.router, call.path);
+        if (!procedure) {
+          throw new TRPCError({
+            code: 'NOT_FOUND',
+            message: `No procedure found on path "${call.path}"`,
+          });
+        }
+
+        if (procedure._def.type !== call.type) {
+          throw new TRPCError({
+            code: 'BAD_REQUEST',
+            message: `Procedure "${call.path}" is a ${procedure._def.type}, not a ${call.type}`,
+          });
+        }
+
+        const data = await procedure({
+          path: call.path,
+          getRawInput: async () =>
+            opts.router._def._config.transformer.input.deserialize(call.input),
+          ctx,
+          type: call.type,
+          signal: opts.req.signal,
+          batchIndex: call.id,
+        });
+
+        results.push({
+          ok: true,
+          id: call.id,
+          data,
+        });
+      } catch (cause) {
+        const error = getTRPCErrorFromUnknown(cause);
+        opts.onError?.({
+          error,
+          path: call.path,
+          input: call.input,
+          ctx: ctx as inferRouterContext<TRouter>,
+          type: call.type,
+          req: opts.req,
+        });
+
+        results.push({
+          ok: false,
+          id: call.id,
+          error: {
+            code: error.code,
+            message: error.message,
+            data: getErrorShape({
+              config: opts.router._def._config,
+              ctx,
+              error,
+              input: call.input,
+              path: call.path,
+              type: call.type,
+            }).data,
+          },
+        });
+      }
+    }
+
+    const envelope = {
+      ok: results.every((result) => result.ok),
+      mode: body.mode ?? 'atomic',
+      results,
+    };
+
+    return new Response(
+      JSON.stringify(transformTRPCResponse(opts.router._def._config, envelope)),
+      {
+        status: getHTTPStatus(results),
+        headers,
+      }
+    );
+  } catch (cause) {
+    const error = getTRPCErrorFromUnknown(cause);
+    opts.onError?.({
+      error,
+      path: undefined,
+      input: undefined,
+      ctx: undefined,
+      type: 'unknown',
+      req: opts.req,
+    });
+    const errorShape = getErrorShape({
+      config: opts.router._def._config,
+      ctx: undefined,
+      error,
+      input: undefined,
+      path: undefined,
+      type: 'unknown',
+    });
+
+    return new Response(
+      JSON.stringify({
+        ok: false,
+        mode: 'atomic',
+        results: [],
+        error: errorShape,
+      }),
+      {
+        status: 400,
+        headers,
+      }
+    );
+  }
+}
diff --git a/packages/server/src/unstable-core-do-not-import/http/types.ts b/packages/server/src/unstable-core-do-not-import/http/types.ts
index 2bf65e10a5..ccf8cc2fd9 100644
--- a/packages/server/src/unstable-core-do-not-import/http/types.ts
+++ b/packages/server/src/unstable-core-do-not-import/http/types.ts
@@ -162,6 +162,18 @@ export interface BaseHandlerOptions<TRouter extends AnyRouter, TRequest> {
    * @default unlimited
    */
   maxBatchSize?: number;
+  /**
+   * Enables the internal batch endpoint at `${endpoint}/_batch`.
+   *
+   * This is intended for first-party admin clients that want to batch
+   * several small tRPC calls together.
+   *
+   * @default false
+   */
+  internalBatching?: {
+    enabled: boolean;
+    maxBatchSize?: number;
+  };
 }
diff --git a/packages/server/src/adapters/fetch/fetchRequestHandler.ts b/packages/server/src/adapters/fetch/fetchRequestHandler.ts
index 61e384ba31..5c3e5648e9 100644
--- a/packages/server/src/adapters/fetch/fetchRequestHandler.ts
+++ b/packages/server/src/adapters/fetch/fetchRequestHandler.ts
@@ -11,6 +11,7 @@
 import type { AnyRouter } from '../../@trpc/server';
 import type { ResolveHTTPRequestOptionsContextFn } from '../../@trpc/server/http';
 import { resolveResponse } from '../../@trpc/server/http';
+import { resolveInternalBatchResponse } from '../../unstable-core-do-not-import/http/internalBatch';
 import type { FetchHandlerRequestOptions } from './types';
 
 const trimSlashes = (path: string): string => {
@@ -35,6 +36,21 @@ export async function fetchRequestHandler<TRouter extends AnyRouter>(
   const endpoint = trimSlashes(opts.endpoint);
   const path = trimSlashes(pathname.slice(endpoint.length));
 
+  if (
+    opts.internalBatching?.enabled &&
+    path === '_batch' &&
+    opts.req.headers.get('trpc-internal-batch') === '1'
+  ) {
+    return await resolveInternalBatchResponse({
+      ...opts,
+      req: opts.req,
+      endpoint,
+      createContext,
+      maxInternalBatchSize: opts.internalBatching.maxBatchSize,
+      onError(o) {
+        opts?.onError?.({ ...o, req: opts.req });
+      },
+    });
+  }
+
   return await resolveResponse({
     ...opts,
     req: opts.req,
diff --git a/packages/tests/server/internalBatchLink.test.ts b/packages/tests/server/internalBatchLink.test.ts
new file mode 100644
index 0000000000..d2f30f248e
--- /dev/null
+++ b/packages/tests/server/internalBatchLink.test.ts
@@ -0,0 +1,291 @@
+import { createTRPCClient, internalBatchLink, retryLink } from '@trpc/client';
+import { initTRPC, TRPCError } from '@trpc/server';
+import { waitError } from '@trpc/server/__tests__/waitError';
+import { createHTTPServer } from '@trpc/server/adapters/standalone';
+import { z } from 'zod';
+
+const t = initTRPC
+  .context<{
+    userId: string;
+    isAdmin: boolean;
+  }>()
+  .create();
+
+function createRouter(state: {
+  flags: Record<string, boolean>;
+  audit: string[];
+  reads: number;
+}) {
+  const adminProcedure = t.procedure.use((opts) => {
+    if (!opts.ctx.isAdmin) {
+      throw new TRPCError({
+        code: 'FORBIDDEN',
+        message: 'Admin only',
+      });
+    }
+    return opts.next();
+  });
+
+  return t.router({
+    account: t.router({
+      get: adminProcedure
+        .input(z.object({ id: z.string() }))
+        .query(({ input }) => {
+          state.reads++;
+          return {
+            id: input.id,
+            beta: state.flags[input.id] ?? false,
+          };
+        }),
+      setFlag: adminProcedure
+        .input(z.object({ id: z.string(), value: z.boolean() }))
+        .mutation(({ input }) => {
+          state.flags[input.id] = input.value;
+          return {
+            id: input.id,
+            beta: input.value,
+          };
+        }),
+      audit: adminProcedure
+        .input(z.object({ id: z.string(), message: z.string() }))
+        .mutation(({ input }) => {
+          state.audit.push(`${input.id}:${input.message}`);
+          return {
+            count: state.audit.length,
+          };
+        }),
+      fail: adminProcedure.mutation(() => {
+        throw new TRPCError({
+          code: 'BAD_REQUEST',
+          message: 'cannot update locked account',
+        });
+      }),
+    }),
+  });
+}
+
+async function createCtx() {
+  const state = {
+    flags: {},
+    audit: [],
+    reads: 0,
+  };
+  const router = createRouter(state);
+  const server = createHTTPServer({
+    router,
+    createContext() {
+      return {
+        userId: 'admin_1',
+        isAdmin: true,
+      };
+    },
+    internalBatching: {
+      enabled: true,
+      maxBatchSize: 10,
+    },
+  });
+  await server.listen(0);
+
+  const url = `http://localhost:${server.server.address().port}`;
+  const client = createTRPCClient<typeof router>({
+    links: [
+      internalBatchLink({
+        url,
+      }),
+    ],
+  });
+
+  return {
+    router,
+    server,
+    state,
+    client,
+    close: () => server.server.close(),
+  };
+}
+
+describe('internalBatchLink', () => {
+  it('batches multiple admin queries', async () => {
+    const ctx = await createCtx();
+    try {
+      const [first, second] = await Promise.all([
+        ctx.client.account.get.query({ id: 'acct_1' }),
+        ctx.client.account.get.query({ id: 'acct_2' }),
+      ]);
+
+      expect(first).toEqual({
+        id: 'acct_1',
+        beta: false,
+      });
+      expect(second).toEqual({
+        id: 'acct_2',
+        beta: false,
+      });
+      expect(ctx.state.reads).toBe(2);
+    } finally {
+      ctx.close();
+    }
+  });
+
+  it('batches admin mutations', async () => {
+    const ctx = await createCtx();
+    try {
+      const [flag, audit] = await Promise.all([
+        ctx.client.account.setFlag.mutate({
+          id: 'acct_1',
+          value: true,
+        }),
+        ctx.client.account.audit.mutate({
+          id: 'acct_1',
+          message: 'enabled beta',
+        }),
+      ]);
+
+      expect(flag).toEqual({
+        id: 'acct_1',
+        beta: true,
+      });
+      expect(audit).toEqual({
+        count: 1,
+      });
+      expect(ctx.state.flags.acct_1).toBe(true);
+      expect(ctx.state.audit).toEqual(['acct_1:enabled beta']);
+    } finally {
+      ctx.close();
+    }
+  });
+
+  it('supports a query and mutation in one internal batch', async () => {
+    const ctx = await createCtx();
+    try {
+      const [before, flag, after] = await Promise.all([
+        ctx.client.account.get.query({ id: 'acct_1' }),
+        ctx.client.account.setFlag.mutate({
+          id: 'acct_1',
+          value: true,
+        }),
+        ctx.client.account.get.query({ id: 'acct_1' }),
+      ]);
+
+      expect(before).toEqual({
+        id: 'acct_1',
+        beta: false,
+      });
+      expect(flag).toEqual({
+        id: 'acct_1',
+        beta: true,
+      });
+      expect(after).toEqual({
+        id: 'acct_1',
+        beta: true,
+      });
+    } finally {
+      ctx.close();
+    }
+  });
+
+  it('returns partial results when one item fails in atomic mode', async () => {
+    const ctx = await createCtx();
+    try {
+      const results = await Promise.allSettled([
+        ctx.client.account.setFlag.mutate({
+          id: 'acct_1',
+          value: true,
+        }),
+        ctx.client.account.fail.mutate(),
+        ctx.client.account.audit.mutate({
+          id: 'acct_1',
+          message: 'attempted locked update',
+        }),
+      ]);
+
+      expect(results[0]).toMatchObject({
+        status: 'fulfilled',
+        value: {
+          id: 'acct_1',
+          beta: true,
+        },
+      });
+      expect(results[1].status).toBe('rejected');
+      expect(results[2]).toMatchObject({
+        status: 'fulfilled',
+        value: {
+          count: 1,
+        },
+      });
+      expect(ctx.state.flags.acct_1).toBe(true);
+      expect(ctx.state.audit).toEqual(['acct_1:attempted locked update']);
+    } finally {
+      ctx.close();
+    }
+  });
+
+  it('surfaces item errors through TRPCClientError', async () => {
+    const ctx = await createCtx();
+    try {
+      const err = await waitError(
+        ctx.client.account.fail.mutate(),
+        TRPCError,
+      );
+
+      expect(err.message).toContain('cannot update locked account');
+    } finally {
+      ctx.close();
+    }
+  });
+
+  it('can be composed with retryLink for admin workflows', async () => {
+    const state = {
+      flags: {},
+      audit: [],
+      reads: 0,
+    };
+    const router = createRouter(state);
+    let requestCount = 0;
+    const server = createHTTPServer({
+      router,
+      createContext() {
+        return {
+          userId: 'admin_1',
+          isAdmin: true,
+        };
+      },
+      internalBatching: {
+        enabled: true,
+      },
+    });
+    await server.listen(0);
+
+    const url = `http://localhost:${server.server.address().port}`;
+    const client = createTRPCClient<typeof router>({
+      links: [
+        retryLink({
+          retry() {
+            return requestCount++ === 0;
+          },
+        }),
+        internalBatchLink({
+          url,
+          fetch: async (input, init) => {
+            const response = await fetch(input, init);
+            if (requestCount === 0) {
+              throw new Error('network dropped after request');
+            }
+            return response;
+          },
+        }),
+      ],
+    });
+
+    try {
+      const results = await Promise.all([
+        client.account.setFlag.mutate({
+          id: 'acct_1',
+          value: true,
+        }),
+        client.account.audit.mutate({
+          id: 'acct_1',
+          message: 'enabled beta',
+        }),
+      ]);
+
+      expect(results).toEqual([
+        {
+          id: 'acct_1',
+          beta: true,
+        },
+        {
+          count: 2,
+        },
+      ]);
+      expect(state.flags.acct_1).toBe(true);
+      expect(state.audit).toEqual([
+        'acct_1:enabled beta',
+        'acct_1:enabled beta',
+      ]);
+    } finally {
+      server.server.close();
+    }
+  });
+});
```

## Intended Flaws

### Flaw 1: The API Claims Atomic Batch Semantics But Executes Partial Mutations

- `type`: `contract_mismatch`
- `location`: `packages/client/src/links/internalBatchLink.ts:20-61`, `packages/server/src/unstable-core-do-not-import/http/internalBatch.ts:58-65`, `packages/server/src/unstable-core-do-not-import/http/internalBatch.ts:127-205`, `packages/tests/server/internalBatchLink.test.ts:160-207`
- `learner_prompt`: Does the new `atomic` batch mode mean all operations commit or none of them do?

Expected answer:

- `identify`: The client defaults `mode` to `atomic`, and the new types expose a single batch envelope, but the server loops through calls one at a time, catches item errors, keeps executing later calls, and returns `200` for mixed success/failure. There is no transaction, rollback, or explicit partial-success contract. The test named "returns partial results when one item fails in atomic mode" accepts the contradiction.
- `impact`: Admin code can reasonably believe a batch is all-or-nothing. In production, the first mutation can succeed, the second can fail, and the third can still run. That creates state the caller did not intend: flags can change without the paired audit event, audit events can be written after a failed guarded mutation, and client retry/error handling may summarize the whole workflow incorrectly because the HTTP response looks successful.
- `fix_direction`: Remove the fake atomic mode or implement a real runtime contract. If atomicity is supported, it needs a transaction/compensating boundary provided by the application, not a generic transport loop. If partial success is supported, make it explicit in the type, response status, docs, and client API; do not default to `atomic`, and make callers handle each item outcome.

Hints:

1. Type names and runtime guarantees are separate contracts.
2. Follow what happens after the second item throws in the server loop.
3. The test that says partial results happen in `atomic` mode is locking in the bug.

### Flaw 2: Mixed Query/Mutation Batching Breaks Retry And Side-Effect Semantics

- `type`: `idempotency_gap`
- `location`: `packages/client/src/links/internalBatchLink.ts:87-128`, `packages/server/src/unstable-core-do-not-import/http/internalBatch.ts:107-125`, `packages/tests/server/internalBatchLink.test.ts:136-158`, `packages/tests/server/internalBatchLink.test.ts:220-291`
- `learner_prompt`: What happens when a batch containing mutations is retried after the server already processed it?

Expected answer:

- `identify`: The new link batches all operations through one loader regardless of procedure type, so queries and mutations share one POST body. That bypasses tRPC's existing separation between query batches and mutation batches, plus the server's existing rejection of mixed procedure types. The retry test demonstrates duplicate side effects: a network error after the request causes the whole batch to run again and writes the audit mutation twice.
- `impact`: Queries and mutations have different transport expectations. Queries are safe to retry and cache; mutations are side effects and need idempotency or deliberate caller control. Mixing them in a single internal batch makes retry behavior dangerous: admin actions such as invite, disable account, reset token, or write audit note can run twice while the client thinks it recovered from a network blip. Query results inside the same batch can also observe mutation ordering that is not part of the normal tRPC contract.
- `fix_direction`: Preserve the procedure-type boundary. Keep query and mutation loaders separate, reject mixed procedure types at the internal endpoint too, and do not compose mutating batches with automatic retry unless every mutation has an idempotency key. If an admin workflow needs ordered multi-step mutation semantics, expose a domain-specific procedure such as `admin.account.updateFlagWithAudit` rather than inventing a generic mixed batch transport.

Hints:

1. Compare this link to `httpBatchLink`, which has separate loaders for query and mutation.
2. Search the server parser for the existing mixed procedure type rejection in `packages/server/src/unstable-core-do-not-import/http/contentType.ts`.
3. The retry test's duplicated audit entry is not a harmless assertion. It is the production failure mode.

## Final Expert Debrief

### Correctness Verdict

For flaw 1, a correct answer must identify that "atomic" is only a type/config word here. The runtime executes partial mutations and keeps going after errors. Answers that merely say "error handling is weird" are incomplete unless they explain the false all-or-nothing contract.

For flaw 2, a correct answer must identify the mixed query/mutation retry problem. Answers that only say "batching mutations is risky" are incomplete unless they connect the risk to retries, idempotency, and the existing tRPC separation of procedure types.

### Product-Level Change

The PR tries to reduce round-trips for first-party admin clients. That is a plausible product need: admin tools often need to fetch state, mutate it, and log the action. The problem is that transport convenience is being treated as a workflow abstraction.

### Changed Contracts

- Client link contract: a new link can batch any non-subscription operation through one request.
- Server adapter contract: fetch adapters can route `${endpoint}/_batch` outside the normal HTTP request parser.
- Procedure-type contract: queries and mutations can now share one request in this internal path.
- Error contract: a batch can return HTTP 200 while containing failed items.
- Retry contract: automatic retry can replay a request containing side effects.

### Failure Modes

An admin screen batches `setFlag`, `failIfLocked`, and `audit`. `setFlag` succeeds, `failIfLocked` fails, and `audit` still runs. The UI sees one failed item but the product state has already moved. If the user refreshes or retries, there is no single source of truth for which operations should be repeated.

A network connection drops after the server receives a batch containing two mutations. `retryLink` retries the request. The flag write is idempotent by coincidence, but the audit note is appended twice. In a real admin system, this pattern can duplicate invites, revoke tokens twice, or enqueue multiple jobs.

### Reviewer Thought Process

A strong reviewer starts by comparing the new path to the established one. tRPC already has batch semantics: separate query and mutation loaders, mixed procedure rejection, per-item envelopes, and HTTP status aggregation. A new "internal" shortcut must preserve those contracts or explicitly replace them.

The second move is to ask whether the abstraction is a transport optimization or a workflow primitive. If it promises atomicity, where is the transaction? If it permits retries, where are the idempotency keys? If it mixes queries and mutations, what ordering and caching semantics does the caller get?

### Better Implementation Direction

- Keep internal batching on the normal HTTP parsing path where possible.
- Reject mixed procedure types in the internal endpoint too.
- Use separate loaders for queries and mutations.
- Remove the `atomic` option unless there is a real transaction/compensation mechanism.
- Return explicit partial-success envelopes and status codes when partial success is the intended behavior.
- Disable automatic retry for mutating internal batches unless every item has an idempotency key.
- Prefer domain-specific admin procedures for ordered multi-step side effects.

## Why This Case Exists

This case trains reviewers to distrust type-shaped comfort when the runtime contract says something else. Large AI-generated PRs often add "safe" helpers that look elegant in TypeScript but bypass the hard-won invariants in the existing system.
