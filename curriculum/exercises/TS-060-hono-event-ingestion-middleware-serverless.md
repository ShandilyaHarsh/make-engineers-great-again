# TS-060: Hono Event Ingestion Middleware For Serverless Runtimes

## Metadata

- `id`: TS-060
- `source_repo`: [honojs/hono](https://github.com/honojs/hono)
- `repo_area`: HonoRequest body cache, raw Request semantics, middleware contracts, validator/body parsing, cloneRawRequest, Web ReadableStream handling, serverless and edge runtime portability, middleware exports
- `mode`: synthetic_degraded
- `difficulty`: 6
- `target_diff_lines`: 1,900-2,400
- `represented_diff_lines`: 1952
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about Fetch Request body consumption, Hono body caching, clone/tee contracts, Node vs Web streams, edge/runtime portability, and event-ingestion middleware design without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds an event ingestion middleware for Hono apps running on serverless platforms. The goal is to make webhook/event endpoints easier to build: verify a request signature, parse and normalize the event payload, attach the parsed event to `c.var`, and then let the route handler apply product-specific logic.

The PR adds:

- `eventIngestion()` middleware,
- JSON, NDJSON, and raw payload support,
- HMAC signature verification,
- event id/type/timestamp extraction,
- optional replay-window validation,
- context variables for parsed events,
- tests for verified events, invalid signatures, and downstream handlers,
- docs and package exports.

The intended product behavior is: middleware may inspect the request body, but downstream handlers and validators must still be able to read the same body. The middleware must work in Hono's runtime-portable environment, including Cloudflare Workers, Deno, Bun, Vercel Edge, Node, and AWS Lambda adapters.

## Existing Code Context

The real Hono codebase already has these relevant contracts:

- `src/request.ts` implements `HonoRequest.text()`, `json()`, `arrayBuffer()`, `blob()`, and `formData()` through an internal `bodyCache`. Reading through `c.req` lets later reads reuse cached data.
- `src/request.ts` exports `cloneRawRequest(c.req)`, which clones the raw `Request` and reconstructs it from Hono's body cache when a Hono request method already consumed the body.
- `src/request.test.ts` verifies that calling `req.text()`, `req.json()`, and `req.arrayBuffer()` can be mixed because Hono reconstructs derived body forms from the cache.
- `src/request.test.ts` also verifies that consuming `req.raw.text()` directly leaves `bodyCache` empty and makes cloning impossible.
- `src/validator/validator.ts` reads JSON through `c.req.json()` and form bodies through `c.req.arrayBuffer()`, relying on HonoRequest caching rather than direct raw body reads.
- `src/middleware/body-limit/index.ts` reads a Web `ReadableStream` through `getReader()` and then reconstructs `c.req.raw = new Request(c.req.raw, { body: new ReadableStream(...) })` before calling `next()`.
- Hono adapters support web-standard request runtimes such as Cloudflare Workers, Deno, Bun, service workers, Vercel, Netlify, Lambda Edge, and AWS Lambda. Node-specific APIs appear inside Node/AWS adapter code, not generic middleware.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

The PR description is assumed to be true. Your job is to verify whether this middleware preserves Hono's request-body and runtime-portability contracts.

## Review Surface

Changed files in the synthetic PR:

- `src/middleware/event-ingestion/types.ts`
- `src/middleware/event-ingestion/body-reader.ts`
- `src/middleware/event-ingestion/signature.ts`
- `src/middleware/event-ingestion/index.ts`
- `src/middleware/event-ingestion/index.test.ts`
- `src/middleware/event-ingestion/runtime.test.ts`
- `src/middleware/event-ingestion/types.test.ts`
- `src/middleware/event-ingestion/README.md`
- `src/index.ts`
- `package.json`

The line references below use synthetic PR line numbers. The represented diff is focused on body consumption, downstream middleware compatibility, and runtime portability.

## Diff

```diff
diff --git a/src/middleware/event-ingestion/types.ts b/src/middleware/event-ingestion/types.ts
new file mode 100644
index 000000000..d9e2f6134
--- /dev/null
+++ b/src/middleware/event-ingestion/types.ts
@@ -0,0 +1,211 @@
+import type { Context } from '../../context'
+
+export type EventIngestionPayloadFormat = 'json' | 'ndjson' | 'raw'
+
+export type EventIngestionSignatureAlgorithm = 'sha1' | 'sha256' | 'sha512'
+
+export type EventIngestionClock = {
+  now(): number
+}
+
+export type EventIngestionVerifier = {
+  algorithm: EventIngestionSignatureAlgorithm
+  secret: string | ((c: Context) => string | Promise<string>)
+  headerName?: string
+  encoding?: 'hex' | 'base64'
+  prefix?: string
+}
+
+export type EventIngestionReplayWindow = {
+  headerName: string
+  toleranceSeconds: number
+}
+
+export type EventIngestionIdExtractor = {
+  headerName?: string
+  bodyPath?: string
+  fallback?: 'hash' | 'none'
+}
+
+export type EventIngestionTypeExtractor = {
+  headerName?: string
+  bodyPath?: string
+  fallback?: string
+}
+
+export type EventIngestionOptions = {
+  format?: EventIngestionPayloadFormat
+  verifier?: EventIngestionVerifier
+  replayWindow?: EventIngestionReplayWindow
+  id?: EventIngestionIdExtractor
+  type?: EventIngestionTypeExtractor
+  maxBodyBytes?: number
+  exposeRawBody?: boolean
+  variableName?: string
+  clock?: EventIngestionClock
+  onInvalidSignature?: (c: Context, reason: string) => Response | Promise<Response>
+  onInvalidPayload?: (c: Context, reason: string) => Response | Promise<Response>
+}
+
+export type EventIngestionMetadata = {
+  receivedAt: string
+  signatureVerified: boolean
+  signatureHeader: string | null
+  replayTimestamp: string | null
+  contentType: string | null
+  contentLength: number | null
+  payloadBytes: number
+}
+
+export type IngestedEvent<TPayload = unknown> = {
+  id: string | null
+  type: string | null
+  payload: TPayload
+  rawBody?: string
+  metadata: EventIngestionMetadata
+}
+
+export type EventIngestionVariables<TPayload = unknown> = {
+  event: IngestedEvent<TPayload>
+  eventPayload: TPayload
+  eventRawBody?: string
+}
+
+export type EventIngestionBody = {
+  raw: string
+  bytes: Uint8Array
+  contentType: string | null
+  contentLength: number | null
+}
+
+export type EventIngestionParseResult = {
+  payload: unknown
+  rawBody: string
+}
+
+export type EventIngestionFailure = {
+  status: number
+  code: string
+  message: string
+}
+
+export const DEFAULT_EVENT_VARIABLE = 'event'
+export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
+export const DEFAULT_SIGNATURE_HEADER = 'x-hono-signature'
+
+export function defaultClock(): EventIngestionClock {
+  return {
+    now: () => Date.now(),
+  }
+}
+
+export function defaultInvalidSignatureResponse(reason: string) {
+  return new Response(
+    JSON.stringify({
+      error: 'invalid_signature',
+      message: reason,
+    }),
+    {
+      status: 401,
+      headers: {
+        'content-type': 'application/json; charset=utf-8',
+      },
+    }
+  )
+}
+
+export function defaultInvalidPayloadResponse(reason: string) {
+  return new Response(
+    JSON.stringify({
+      error: 'invalid_event_payload',
+      message: reason,
+    }),
+    {
+      status: 400,
+      headers: {
+        'content-type': 'application/json; charset=utf-8',
+      },
+    }
+  )
+}
+
+export function getPathValue(payload: unknown, path: string | undefined): unknown {
+  if (!path || !payload || typeof payload !== 'object') {
+    return undefined
+  }
+
+  const parts = path.split('.')
+  let current: unknown = payload
+  for (const part of parts) {
+    if (!current || typeof current !== 'object') {
+      return undefined
+    }
+    current = (current as Record<string, unknown>)[part]
+  }
+  return current
+}
+
+export function stringifyHeaderValue(value: unknown): string | null {
+  if (typeof value === 'string') {
+    return value
+  }
+  if (typeof value === 'number' || typeof value === 'boolean') {
+    return String(value)
+  }
+  return null
+}
+
+export function parseContentLength(value: string | null): number | null {
+  if (!value) {
+    return null
+  }
+
+  const parsed = Number(value)
+  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
+}
+
+export function createMetadata({
+  body,
+  signatureVerified,
+  signatureHeader,
+  replayTimestamp,
+  clock,
+}: {
+  body: EventIngestionBody
+  signatureVerified: boolean
+  signatureHeader: string | null
+  replayTimestamp: string | null
+  clock: EventIngestionClock
+}): EventIngestionMetadata {
+  return {
+    receivedAt: new Date(clock.now()).toISOString(),
+    signatureVerified,
+    signatureHeader,
+    replayTimestamp,
+    contentType: body.contentType,
+    contentLength: body.contentLength,
+    payloadBytes: body.bytes.byteLength,
+  }
+}
+
+declare module '../..' {
+  interface ContextVariableMap extends EventIngestionVariables {}
+}
diff --git a/src/middleware/event-ingestion/body-reader.ts b/src/middleware/event-ingestion/body-reader.ts
new file mode 100644
index 000000000..1af8f15cf
--- /dev/null
+++ b/src/middleware/event-ingestion/body-reader.ts
@@ -0,0 +1,222 @@
+import { Readable } from 'node:stream'
+import type { Context } from '../../context'
+import {
+  DEFAULT_MAX_BODY_BYTES,
+  type EventIngestionBody,
+  type EventIngestionPayloadFormat,
+  type EventIngestionParseResult,
+} from './types'
+
+const decoder = new TextDecoder()
+
+async function readNodeStream(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
+  const chunks: Uint8Array[] = []
+  for await (const chunk of stream) {
+    if (typeof chunk === 'string') {
+      chunks.push(new TextEncoder().encode(chunk))
+    } else if (chunk instanceof Uint8Array) {
+      chunks.push(chunk)
+    } else {
+      chunks.push(new Uint8Array(chunk as ArrayBuffer))
+    }
+  }
+
+  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
+  const bytes = new Uint8Array(total)
+  let offset = 0
+  for (const chunk of chunks) {
+    bytes.set(chunk, offset)
+    offset += chunk.byteLength
+  }
+  return bytes
+}
+
+export async function readRawBodyAsBuffer(c: Context): Promise<Uint8Array> {
+  const body = c.req.raw.body
+  if (!body) {
+    return new Uint8Array()
+  }
+
+  const nodeReadable = Readable.fromWeb(body as unknown as ReadableStream<Uint8Array>)
+  return readNodeStream(nodeReadable)
+}
+
+export async function readEventBody(c: Context, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
+  const contentLength = c.req.raw.headers.get('content-length')
+  if (contentLength && Number(contentLength) > maxBodyBytes) {
+    throw new Error(`Event body exceeds ${maxBodyBytes} bytes`)
+  }
+
+  const bytes = await readRawBodyAsBuffer(c)
+  if (bytes.byteLength > maxBodyBytes) {
+    throw new Error(`Event body exceeds ${maxBodyBytes} bytes`)
+  }
+
+  return {
+    raw: decoder.decode(bytes),
+    bytes,
+    contentType: c.req.raw.headers.get('content-type'),
+    contentLength: contentLength ? Number(contentLength) : null,
+  } satisfies EventIngestionBody
+}
+
+export function parseNdjson(raw: string) {
+  if (!raw.trim()) {
+    return []
+  }
+  return raw
+    .split('\n')
+    .filter((line) => line.trim().length > 0)
+    .map((line) => JSON.parse(line))
+}
+
+export function parseEventBody(
+  body: EventIngestionBody,
+  format: EventIngestionPayloadFormat
+): EventIngestionParseResult {
+  if (format === 'raw') {
+    return {
+      payload: body.raw,
+      rawBody: body.raw,
+    }
+  }
+
+  if (format === 'ndjson') {
+    return {
+      payload: parseNdjson(body.raw),
+      rawBody: body.raw,
+    }
+  }
+
+  return {
+    payload: body.raw ? JSON.parse(body.raw) : {},
+    rawBody: body.raw,
+  }
+}
+
+export async function readBodyForEventIngestion({
+  c,
+  format,
+  maxBodyBytes,
+}: {
+  c: Context
+  format: EventIngestionPayloadFormat
+  maxBodyBytes?: number
+}) {
+  const body = await readEventBody(c, maxBodyBytes)
+  const parsed = parseEventBody(body, format)
+
+  return {
+    body,
+    parsed,
+  }
+}
+
+export async function readBodyForSignature(c: Context) {
+  return readEventBody(c)
+}
+
+export function bodyToString(body: Uint8Array) {
+  return decoder.decode(body)
+}
+
+export function parseJsonPath(payload: unknown, path: string) {
+  const parts = path.split('.')
+  let value = payload
+  for (const part of parts) {
+    if (!value || typeof value !== 'object') {
+      return undefined
+    }
+    value = (value as Record<string, unknown>)[part]
+  }
+  return value
+}
+
+export function normalizeBodyForLogging(body: EventIngestionBody) {
+  return {
+    contentType: body.contentType,
+    contentLength: body.contentLength,
+    payloadBytes: body.bytes.byteLength,
+  }
+}
diff --git a/src/middleware/event-ingestion/signature.ts b/src/middleware/event-ingestion/signature.ts
new file mode 100644
index 000000000..f648aa64e
--- /dev/null
+++ b/src/middleware/event-ingestion/signature.ts
@@ -0,0 +1,206 @@
+import { createHmac, timingSafeEqual } from 'node:crypto'
+import type { Context } from '../../context'
+import type { EventIngestionBody, EventIngestionVerifier } from './types'
+import { DEFAULT_SIGNATURE_HEADER } from './types'
+
+export type SignatureVerificationResult = {
+  verified: boolean
+  header: string | null
+  expected: string | null
+  reason?: string
+}
+
+function stripPrefix(value: string, prefix: string | undefined) {
+  if (!prefix) {
+    return value
+  }
+
+  return value.startsWith(prefix) ? value.slice(prefix.length) : value
+}
+
+async function resolveSecret(c: Context, verifier: EventIngestionVerifier) {
+  if (typeof verifier.secret === 'function') {
+    return verifier.secret(c)
+  }
+  return verifier.secret
+}
+
+function digestBody({
+  body,
+  secret,
+  verifier,
+}: {
+  body: EventIngestionBody
+  secret: string
+  verifier: EventIngestionVerifier
+}) {
+  const hmac = createHmac(verifier.algorithm, secret)
+  hmac.update(Buffer.from(body.bytes))
+  return hmac.digest(verifier.encoding ?? 'hex')
+}
+
+function secureCompare(left: string, right: string) {
+  const leftBuffer = Buffer.from(left)
+  const rightBuffer = Buffer.from(right)
+  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
+    return false
+  }
+  return timingSafeEqual(leftBuffer, rightBuffer)
+}
+
+export async function verifyEventSignature({
+  c,
+  body,
+  verifier,
+}: {
+  c: Context
+  body: EventIngestionBody
+  verifier?: EventIngestionVerifier
+}): Promise<SignatureVerificationResult> {
+  if (!verifier) {
+    return {
+      verified: false,
+      header: null,
+      expected: null,
+    }
+  }
+
+  const headerName = verifier.headerName ?? DEFAULT_SIGNATURE_HEADER
+  const signatureHeader = c.req.raw.headers.get(headerName)
+  if (!signatureHeader) {
+    return {
+      verified: false,
+      header: null,
+      expected: null,
+      reason: `Missing ${headerName} header`,
+    }
+  }
+
+  const secret = await resolveSecret(c, verifier)
+  const expected = digestBody({
+    body,
+    secret,
+    verifier,
+  })
+  const received = stripPrefix(signatureHeader, verifier.prefix)
+
+  return {
+    verified: secureCompare(received, expected),
+    header: signatureHeader,
+    expected,
+    reason: secureCompare(received, expected) ? undefined : 'Signature mismatch',
+  }
+}
+
+export function createTestSignature({
+  payload,
+  secret,
+  algorithm = 'sha256',
+  encoding = 'hex',
+}: {
+  payload: string
+  secret: string
+  algorithm?: EventIngestionVerifier['algorithm']
+  encoding?: EventIngestionVerifier['encoding']
+}) {
+  return createHmac(algorithm, secret).update(payload).digest(encoding)
+}
+
+export function signedHeaderValue(signature: string, prefix?: string) {
+  return prefix ? `${prefix}${signature}` : signature
+}
+
+export function getSignatureHeaderName(verifier?: EventIngestionVerifier) {
+  return verifier?.headerName ?? DEFAULT_SIGNATURE_HEADER
+}
+
+export function hasSignature(c: Context, verifier?: EventIngestionVerifier) {
+  return Boolean(c.req.raw.headers.get(getSignatureHeaderName(verifier)))
+}
diff --git a/src/middleware/event-ingestion/index.ts b/src/middleware/event-ingestion/index.ts
new file mode 100644
index 000000000..89a477e56
--- /dev/null
+++ b/src/middleware/event-ingestion/index.ts
@@ -0,0 +1,274 @@
+/**
+ * @module
+ * Event ingestion middleware for Hono.
+ */
+
+import type { MiddlewareHandler } from '../../types'
+import { readBodyForEventIngestion } from './body-reader'
+import { verifyEventSignature } from './signature'
+import {
+  DEFAULT_EVENT_VARIABLE,
+  DEFAULT_MAX_BODY_BYTES,
+  createMetadata,
+  defaultClock,
+  defaultInvalidPayloadResponse,
+  defaultInvalidSignatureResponse,
+  getPathValue,
+  parseContentLength,
+  stringifyHeaderValue,
+  type EventIngestionOptions,
+  type IngestedEvent,
+} from './types'
+
+function getHeader(c: Parameters<MiddlewareHandler>[0], name: string | undefined) {
+  if (!name) {
+    return null
+  }
+  return c.req.raw.headers.get(name)
+}
+
+function extractEventId({
+  c,
+  payload,
+  options,
+}: {
+  c: Parameters<MiddlewareHandler>[0]
+  payload: unknown
+  options: EventIngestionOptions
+}) {
+  const idOptions = options.id
+  if (!idOptions) {
+    return null
+  }
+
+  const headerValue = getHeader(c, idOptions.headerName)
+  if (headerValue) {
+    return headerValue
+  }
+
+  const bodyValue = stringifyHeaderValue(getPathValue(payload, idOptions.bodyPath))
+  if (bodyValue) {
+    return bodyValue
+  }
+
+  return null
+}
+
+function extractEventType({
+  c,
+  payload,
+  options,
+}: {
+  c: Parameters<MiddlewareHandler>[0]
+  payload: unknown
+  options: EventIngestionOptions
+}) {
+  const typeOptions = options.type
+  if (!typeOptions) {
+    return null
+  }
+
+  const headerValue = getHeader(c, typeOptions.headerName)
+  if (headerValue) {
+    return headerValue
+  }
+
+  const bodyValue = stringifyHeaderValue(getPathValue(payload, typeOptions.bodyPath))
+  if (bodyValue) {
+    return bodyValue
+  }
+
+  return typeOptions.fallback ?? null
+}
+
+function validateReplayWindow({
+  c,
+  options,
+  now,
+}: {
+  c: Parameters<MiddlewareHandler>[0]
+  options: EventIngestionOptions
+  now: number
+}) {
+  if (!options.replayWindow) {
+    return {
+      ok: true,
+      timestamp: null,
+      reason: null,
+    }
+  }
+
+  const timestampHeader = c.req.raw.headers.get(options.replayWindow.headerName)
+  if (!timestampHeader) {
+    return {
+      ok: false,
+      timestamp: null,
+      reason: `Missing ${options.replayWindow.headerName} header`,
+    }
+  }
+
+  const timestamp = Number(timestampHeader)
+  if (!Number.isFinite(timestamp)) {
+    return {
+      ok: false,
+      timestamp: timestampHeader,
+      reason: `Invalid ${options.replayWindow.headerName} header`,
+    }
+  }
+
+  const diffSeconds = Math.abs(now - timestamp * 1000) / 1000
+  if (diffSeconds > options.replayWindow.toleranceSeconds) {
+    return {
+      ok: false,
+      timestamp: timestampHeader,
+      reason: 'Event timestamp outside replay window',
+    }
+  }
+
+  return {
+    ok: true,
+    timestamp: timestampHeader,
+    reason: null,
+  }
+}
+
+function setEventVariables({
+  c,
+  variableName,
+  event,
+}: {
+  c: Parameters<MiddlewareHandler>[0]
+  variableName: string
+  event: IngestedEvent
+}) {
+  c.set(variableName, event)
+  c.set('eventPayload', event.payload)
+  if (event.rawBody !== undefined) {
+    c.set('eventRawBody', event.rawBody)
+  }
+}
+
+export const eventIngestion = (options: EventIngestionOptions = {}): MiddlewareHandler => {
+  const format = options.format ?? 'json'
+  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
+  const variableName = options.variableName ?? DEFAULT_EVENT_VARIABLE
+  const onInvalidSignature =
+    options.onInvalidSignature ?? ((c, reason) => defaultInvalidSignatureResponse(reason))
+  const onInvalidPayload =
+    options.onInvalidPayload ?? ((c, reason) => defaultInvalidPayloadResponse(reason))
+  const clock = options.clock ?? defaultClock()
+
+  return async function eventIngestionMiddleware(c, next) {
+    const now = clock.now()
+    const replay = validateReplayWindow({
+      c,
+      options,
+      now,
+    })
+    if (!replay.ok) {
+      return onInvalidSignature(c, replay.reason ?? 'Invalid replay timestamp')
+    }
+
+    let parsedResult: Awaited<ReturnType<typeof readBodyForEventIngestion>>
+    try {
+      parsedResult = await readBodyForEventIngestion({
+        c,
+        format,
+        maxBodyBytes,
+      })
+    } catch (error) {
+      const reason = error instanceof Error ? error.message : 'Unable to parse event body'
+      return onInvalidPayload(c, reason)
+    }
+
+    const signature = await verifyEventSignature({
+      c,
+      body: parsedResult.body,
+      verifier: options.verifier,
+    })
+
+    if (options.verifier && !signature.verified) {
+      return onInvalidSignature(c, signature.reason ?? 'Invalid signature')
+    }
+
+    const event: IngestedEvent = {
+      id: extractEventId({
+        c,
+        payload: parsedResult.parsed.payload,
+        options,
+      }),
+      type: extractEventType({
+        c,
+        payload: parsedResult.parsed.payload,
+        options,
+      }),
+      payload: parsedResult.parsed.payload,
+      rawBody: options.exposeRawBody ? parsedResult.parsed.rawBody : undefined,
+      metadata: createMetadata({
+        body: parsedResult.body,
+        signatureVerified: signature.verified,
+        signatureHeader: signature.header,
+        replayTimestamp: replay.timestamp,
+        clock,
+      }),
+    }
+
+    setEventVariables({
+      c,
+      variableName,
+      event,
+    })
+
+    const contentLength = parseContentLength(c.req.raw.headers.get('content-length'))
+    if (contentLength !== null && contentLength !== event.metadata.payloadBytes) {
+      c.res.headers.set('x-hono-event-ingestion-length-mismatch', '1')
+    }
+
+    await next()
+  }
+}
+
+export type {
+  EventIngestionBody,
+  EventIngestionClock,
+  EventIngestionFailure,
+  EventIngestionIdExtractor,
+  EventIngestionMetadata,
+  EventIngestionOptions,
+  EventIngestionPayloadFormat,
+  EventIngestionReplayWindow,
+  EventIngestionSignatureAlgorithm,
+  EventIngestionTypeExtractor,
+  EventIngestionVariables,
+  EventIngestionVerifier,
+  IngestedEvent,
+} from './types'
diff --git a/src/middleware/event-ingestion/index.test.ts b/src/middleware/event-ingestion/index.test.ts
new file mode 100644
index 000000000..55f6cda2e
--- /dev/null
+++ b/src/middleware/event-ingestion/index.test.ts
@@ -0,0 +1,386 @@
+import { describe, expect, it } from 'vitest'
+import { Hono } from '../../hono'
+import { eventIngestion } from './index'
+import { createTestSignature, signedHeaderValue } from './signature'
+
+function signedRequest(payload: string, secret = 'secret') {
+  const signature = createTestSignature({
+    payload,
+    secret,
+  })
+
+  return new Request('http://localhost/events', {
+    method: 'POST',
+    headers: {
+      'content-type': 'application/json',
+      'x-hono-signature': signedHeaderValue(signature),
+      'x-event-id': 'evt_123',
+      'x-event-type': 'checkout.completed',
+      'x-event-timestamp': String(Math.floor(Date.now() / 1000)),
+    },
+    body: payload,
+  })
+}
+
+describe('eventIngestion()', () => {
+  it('verifies signature and exposes parsed event', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        verifier: {
+          algorithm: 'sha256',
+          secret: 'secret',
+        },
+        id: {
+          headerName: 'x-event-id',
+        },
+        type: {
+          headerName: 'x-event-type',
+        },
+        exposeRawBody: true,
+      }),
+      (c) => {
+        const event = c.get('event')
+        return c.json({
+          id: event.id,
+          type: event.type,
+          payload: event.payload,
+          rawBody: c.get('eventRawBody'),
+          verified: event.metadata.signatureVerified,
+        })
+      }
+    )
+
+    const res = await app.request(
+      signedRequest(
+        JSON.stringify({
+          id: 'evt_body',
+          type: 'body.type',
+          data: {
+            object: 'invoice',
+          },
+        })
+      )
+    )
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'evt_123',
+      type: 'checkout.completed',
+      payload: {
+        id: 'evt_body',
+        type: 'body.type',
+        data: {
+          object: 'invoice',
+        },
+      },
+      rawBody: '{"id":"evt_body","type":"body.type","data":{"object":"invoice"}}',
+      verified: true,
+    })
+  })
+
+  it('can extract id and type from body paths', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        id: {
+          bodyPath: 'id',
+        },
+        type: {
+          bodyPath: 'event.type',
+        },
+      }),
+      (c) => {
+        const event = c.get('event')
+        return c.json({
+          id: event.id,
+          type: event.type,
+        })
+      }
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        id: 'evt_from_body',
+        event: {
+          type: 'user.created',
+        },
+      }),
+    })
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'evt_from_body',
+      type: 'user.created',
+    })
+  })
+
+  it('rejects invalid signatures', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        verifier: {
+          algorithm: 'sha256',
+          secret: 'secret',
+        },
+      }),
+      (c) => c.text('ok')
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+        'x-hono-signature': 'bad',
+      },
+      body: JSON.stringify({
+        id: 'evt_123',
+      }),
+    })
+
+    expect(res.status).toBe(401)
+    expect(await res.json()).toEqual({
+      error: 'invalid_signature',
+      message: 'Signature mismatch',
+    })
+  })
+
+  it('rejects payloads beyond max body bytes', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        maxBodyBytes: 8,
+      }),
+      (c) => c.text('ok')
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        id: 'too_large',
+      }),
+    })
+
+    expect(res.status).toBe(400)
+    expect(await res.json()).toEqual({
+      error: 'invalid_event_payload',
+      message: 'Event body exceeds 8 bytes',
+    })
+  })
+
+  it('rejects malformed JSON', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        format: 'json',
+      }),
+      (c) => c.text('ok')
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+      },
+      body: '{',
+    })
+
+    expect(res.status).toBe(400)
+    expect(await res.json()).toEqual({
+      error: 'invalid_event_payload',
+      message: 'Unexpected end of JSON input',
+    })
+  })
+
+  it('parses ndjson payloads', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        format: 'ndjson',
+      }),
+      (c) => c.json(c.get('eventPayload'))
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/x-ndjson',
+      },
+      body: '{"id":1}\n{"id":2}\n',
+    })
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual([{ id: 1 }, { id: 2 }])
+  })
+
+  it('supports raw event payloads', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        format: 'raw',
+      }),
+      (c) => c.json({ payload: c.get('eventPayload') })
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'text/plain',
+      },
+      body: 'raw-line',
+    })
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      payload: 'raw-line',
+    })
+  })
+
+  it('allows downstream handler to use parsed event without rereading body', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        id: {
+          bodyPath: 'id',
+        },
+      }),
+      (c) => {
+        const event = c.get('event')
+        return c.json({
+          id: event.id,
+          payload: event.payload,
+        })
+      }
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        id: 'evt_works',
+        data: {
+          ok: true,
+        },
+      }),
+    })
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'evt_works',
+      payload: {
+        id: 'evt_works',
+        data: {
+          ok: true,
+        },
+      },
+    })
+  })
+
+  it('leaves c.req.raw consumed after ingestion', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion(),
+      async (c) => {
+        return c.json({
+          bodyUsed: c.req.raw.bodyUsed,
+        })
+      }
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        id: 'evt_body_used',
+      }),
+    })
+
+    expect(await res.json()).toEqual({
+      bodyUsed: true,
+    })
+  })
+
+  it('returns length mismatch header for transformed bodies', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion(),
+      (c) => {
+        return c.json({
+          event: c.get('event').id,
+        })
+      }
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+        'content-length': '999',
+      },
+      body: JSON.stringify({
+        id: 'evt_123',
+      }),
+    })
+
+    expect(res.headers.get('x-hono-event-ingestion-length-mismatch')).toBe('1')
+  })
+})
diff --git a/src/middleware/event-ingestion/runtime.test.ts b/src/middleware/event-ingestion/runtime.test.ts
new file mode 100644
index 000000000..eed2bf463
--- /dev/null
+++ b/src/middleware/event-ingestion/runtime.test.ts
@@ -0,0 +1,244 @@
+import { describe, expect, it, vi } from 'vitest'
+import { Hono } from '../../hono'
+import { readRawBodyAsBuffer } from './body-reader'
+import { createTestSignature } from './signature'
+import { eventIngestion } from './index'
+
+describe('event ingestion runtime behavior', () => {
+  it('reads a request body through a Node Readable stream', async () => {
+    const app = new Hono()
+    app.post('/events', async (c) => {
+      const bytes = await readRawBodyAsBuffer(c)
+      return c.text(new TextDecoder().decode(bytes))
+    })
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      body: 'hello',
+    })
+
+    expect(await res.text()).toBe('hello')
+  })
+
+  it('verifies HMAC signatures with node crypto', async () => {
+    const payload = JSON.stringify({
+      id: 'evt_node_crypto',
+    })
+    const signature = createTestSignature({
+      payload,
+      secret: 'secret',
+    })
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        verifier: {
+          algorithm: 'sha256',
+          secret: 'secret',
+        },
+      }),
+      (c) => c.json(c.get('eventPayload'))
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+        'x-hono-signature': signature,
+      },
+      body: payload,
+    })
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'evt_node_crypto',
+    })
+  })
+
+  it('documents that edge workers need bundler polyfills for node stream', async () => {
+    const importNodeStream = vi.fn(async () => import('node:stream'))
+
+    await expect(importNodeStream()).resolves.toHaveProperty('Readable')
+  })
+
+  it('documents that edge workers need bundler polyfills for node crypto', async () => {
+    const importNodeCrypto = vi.fn(async () => import('node:crypto'))
+
+    await expect(importNodeCrypto()).resolves.toHaveProperty('createHmac')
+  })
+})
diff --git a/src/middleware/event-ingestion/composition.test.ts b/src/middleware/event-ingestion/composition.test.ts
new file mode 100644
index 000000000..2f76b827a
--- /dev/null
+++ b/src/middleware/event-ingestion/composition.test.ts
@@ -0,0 +1,362 @@
+import { describe, expect, it } from 'vitest'
+import { Hono } from '../../hono'
+import { validator } from '../../validator/validator'
+import { eventIngestion } from './index'
+import { createTestSignature } from './signature'
+
+function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
+  return new Request(`http://localhost${path}`, {
+    method: 'POST',
+    headers: {
+      'content-type': 'application/json',
+      ...headers,
+    },
+    body: JSON.stringify(body),
+  })
+}
+
+describe('event ingestion middleware composition', () => {
+  it('lets handlers validate the already parsed event payload', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        id: {
+          bodyPath: 'id',
+        },
+        type: {
+          bodyPath: 'type',
+        },
+      }),
+      async (c) => {
+        const payload = c.get('eventPayload') as { id?: string; type?: string }
+        if (!payload.id || !payload.type) {
+          return c.json({ error: 'invalid' }, 422)
+        }
+        return c.json({
+          id: payload.id,
+          type: payload.type,
+        })
+      }
+    )
+
+    const res = await app.request(
+      jsonRequest('/events', {
+        id: 'evt_payload_validation',
+        type: 'user.created',
+      })
+    )
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'evt_payload_validation',
+      type: 'user.created',
+    })
+  })
+
+  it('documents that Hono validator should run before event ingestion when it needs the raw request body', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      validator('json', (value) => {
+        return value
+      }),
+      eventIngestion({
+        id: {
+          bodyPath: 'id',
+        },
+      }),
+      async (c) => {
+        return c.json({
+          validated: c.req.valid('json'),
+          event: c.get('event').id,
+        })
+      }
+    )
+
+    const res = await app.request(
+      jsonRequest('/events', {
+        id: 'evt_validator_first',
+      })
+    )
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      validated: {
+        id: 'evt_validator_first',
+      },
+      event: 'evt_validator_first',
+    })
+  })
+
+  it('shows downstream handlers can use eventRawBody instead of reading c.req.text()', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        exposeRawBody: true,
+      }),
+      async (c) => {
+        return c.json({
+          raw: c.get('eventRawBody'),
+          payload: c.get('eventPayload'),
+        })
+      }
+    )
+
+    const res = await app.request(
+      jsonRequest('/events', {
+        id: 'evt_raw_body',
+      })
+    )
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      raw: '{"id":"evt_raw_body"}',
+      payload: {
+        id: 'evt_raw_body',
+      },
+    })
+  })
+
+  it('supports custom invalid signature responses', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        verifier: {
+          algorithm: 'sha256',
+          secret: 'secret',
+        },
+        onInvalidSignature: (c, reason) => {
+          return c.json(
+            {
+              code: 'signature_failed',
+              reason,
+            },
+            403
+          )
+        },
+      }),
+      (c) => c.text('ok')
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+        'x-hono-signature': 'bad',
+      },
+      body: JSON.stringify({
+        id: 'evt_invalid_signature',
+      }),
+    })
+
+    expect(res.status).toBe(403)
+    expect(await res.json()).toEqual({
+      code: 'signature_failed',
+      reason: 'Signature mismatch',
+    })
+  })
+
+  it('supports custom invalid payload responses', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        onInvalidPayload: (c, reason) => {
+          return c.json(
+            {
+              code: 'payload_failed',
+              reason,
+            },
+            422
+          )
+        },
+      }),
+      (c) => c.text('ok')
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+      },
+      body: '{',
+    })
+
+    expect(res.status).toBe(422)
+    expect(await res.json()).toEqual({
+      code: 'payload_failed',
+      reason: 'Unexpected end of JSON input',
+    })
+  })
+
+  it('rejects replay timestamps outside the allowed window', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        replayWindow: {
+          headerName: 'x-event-timestamp',
+          toleranceSeconds: 60,
+        },
+        clock: {
+          now: () => 1_800_000_000_000,
+        },
+      }),
+      (c) => c.text('ok')
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+        'x-event-timestamp': '1',
+      },
+      body: JSON.stringify({
+        id: 'evt_replay',
+      }),
+    })
+
+    expect(res.status).toBe(401)
+    expect(await res.json()).toEqual({
+      error: 'invalid_signature',
+      message: 'Event timestamp outside replay window',
+    })
+  })
+
+  it('accepts replay timestamps inside the allowed window', async () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        replayWindow: {
+          headerName: 'x-event-timestamp',
+          toleranceSeconds: 60,
+        },
+        clock: {
+          now: () => 1_800_000_000_000,
+        },
+      }),
+      (c) => c.json(c.get('eventPayload'))
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+        'x-event-timestamp': '1800000000',
+      },
+      body: JSON.stringify({
+        id: 'evt_replay_ok',
+      }),
+    })
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'evt_replay_ok',
+    })
+  })
+
+  it('supports secret lookup from context', async () => {
+    const body = JSON.stringify({
+      id: 'evt_context_secret',
+    })
+    const signature = createTestSignature({
+      payload: body,
+      secret: 'dynamic-secret',
+    })
+    const app = new Hono<{
+      Bindings: {
+        WEBHOOK_SECRET: string
+      }
+    }>()
+    app.post(
+      '/events',
+      eventIngestion({
+        verifier: {
+          algorithm: 'sha256',
+          secret: (c) => c.env.WEBHOOK_SECRET,
+        },
+      }),
+      (c) => c.json(c.get('eventPayload'))
+    )
+
+    const res = await app.request(
+      '/events',
+      {
+        method: 'POST',
+        headers: {
+          'content-type': 'application/json',
+          'x-hono-signature': signature,
+        },
+        body,
+      },
+      {
+        WEBHOOK_SECRET: 'dynamic-secret',
+      }
+    )
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'evt_context_secret',
+    })
+  })
+
+  it('supports prefixed signatures', async () => {
+    const body = JSON.stringify({
+      id: 'evt_prefixed_signature',
+    })
+    const signature = createTestSignature({
+      payload: body,
+      secret: 'secret',
+    })
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        verifier: {
+          algorithm: 'sha256',
+          secret: 'secret',
+          prefix: 'sha256=',
+        },
+      }),
+      (c) => c.json(c.get('eventPayload'))
+    )
+
+    const res = await app.request('/events', {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+        'x-hono-signature': `sha256=${signature}`,
+      },
+      body,
+    })
+
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'evt_prefixed_signature',
+    })
+  })
+})
diff --git a/src/middleware/event-ingestion/types.test.ts b/src/middleware/event-ingestion/types.test.ts
new file mode 100644
index 000000000..b3177c751
--- /dev/null
+++ b/src/middleware/event-ingestion/types.test.ts
@@ -0,0 +1,183 @@
+import { describe, expectTypeOf, it } from 'vitest'
+import { Hono } from '../../hono'
+import { eventIngestion } from './index'
+import type { IngestedEvent } from './types'
+
+describe('event ingestion types', () => {
+  it('exposes event variables on context', () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion(),
+      (c) => {
+        expectTypeOf(c.get('event')).toEqualTypeOf<IngestedEvent>()
+        expectTypeOf(c.get('eventPayload')).toEqualTypeOf<unknown>()
+        return c.text('ok')
+      }
+    )
+    expectTypeOf(app).not.toBeNever()
+  })
+
+  it('supports custom variable names at runtime', () => {
+    const app = new Hono()
+    app.post(
+      '/events',
+      eventIngestion({
+        variableName: 'stripeEvent',
+      }),
+      (c) => {
+        expectTypeOf(c.get('stripeEvent')).toEqualTypeOf<unknown>()
+        expectTypeOf(c.get('eventPayload')).toEqualTypeOf<unknown>()
+        return c.text('ok')
+      }
+    )
+    expectTypeOf(app).not.toBeNever()
+  })
+})
diff --git a/src/middleware/event-ingestion/README.md b/src/middleware/event-ingestion/README.md
new file mode 100644
index 000000000..790a102c2
--- /dev/null
+++ b/src/middleware/event-ingestion/README.md
@@ -0,0 +1,445 @@
+# Event Ingestion Middleware
+
+The event ingestion middleware verifies, parses, and attaches incoming webhook
+events to the Hono context.
+
+```ts
+import { Hono } from 'hono'
+import { eventIngestion } from 'hono/event-ingestion'
+
+const app = new Hono()
+
+app.post(
+  '/events',
+  eventIngestion({
+    verifier: {
+      algorithm: 'sha256',
+      secret: process.env.WEBHOOK_SECRET,
+      headerName: 'x-provider-signature',
+    },
+    id: {
+      bodyPath: 'id',
+    },
+    type: {
+      bodyPath: 'type',
+    },
+  }),
+  async (c) => {
+    const event = c.get('event')
+    return c.json({
+      received: event.id,
+    })
+  }
+)
+```
+
+## Runtime support
+
+The middleware is designed for serverless event endpoints. It can be used in:
+
+- Node.js
+- AWS Lambda
+- Cloudflare Workers with Node compatibility enabled
+- Vercel Edge with Node polyfills
+- Bun with Node compatibility
+- Deno with npm compatibility
+
+The middleware reads the request body into a Node `Readable` stream so signature
+verification and payload parsing share the same bytes. Edge runtimes should use
+the bundler's Node compatibility mode.
+
+## Body behavior
+
+`eventIngestion()` reads the incoming request body before your route handler
+runs. Handlers should use the parsed context variables:
+
+```ts
+app.post('/events', eventIngestion(), async (c) => {
+  const event = c.get('event')
+  await processEvent(event)
+  return c.text('ok')
+})
+```
+
+The middleware does not require handlers to call `c.req.json()`. If a route
+needs the raw body, enable `exposeRawBody`:
+
+```ts
+app.post(
+  '/events',
+  eventIngestion({
+    exposeRawBody: true,
+  }),
+  async (c) => {
+    const raw = c.get('eventRawBody')
+    return c.text(raw ?? '')
+  }
+)
+```
+
+If a downstream handler reads `c.req.raw` after ingestion, it will observe that
+the body has already been consumed. This is expected because the middleware owns
+event parsing for the route.
+
+## Signature verification
+
+Configure HMAC verification with a secret and algorithm:
+
+```ts
+eventIngestion({
+  verifier: {
+    algorithm: 'sha256',
+    secret: 'whsec_123',
+    headerName: 'x-provider-signature',
+  },
+})
+```
+
+The middleware supports signatures encoded as hex or base64:
+
+```ts
+eventIngestion({
+  verifier: {
+    algorithm: 'sha512',
+    encoding: 'base64',
+    secret: 'secret',
+  },
+})
+```
+
+Some providers prefix signatures:
+
+```ts
+eventIngestion({
+  verifier: {
+    algorithm: 'sha256',
+    secret: 'secret',
+    prefix: 'sha256=',
+  },
+})
+```
+
+## Replay protection
+
+Replay windows compare a provider timestamp header to the current clock:
+
+```ts
+eventIngestion({
+  replayWindow: {
+    headerName: 'x-event-timestamp',
+    toleranceSeconds: 300,
+  },
+})
+```
+
+Use a custom clock in tests:
+
+```ts
+eventIngestion({
+  clock: {
+    now: () => 1_800_000_000_000,
+  },
+})
+```
+
+## Event ids and types
+
+Event ids and types can come from headers:
+
+```ts
+eventIngestion({
+  id: {
+    headerName: 'x-event-id',
+  },
+  type: {
+    headerName: 'x-event-type',
+  },
+})
+```
+
+They can also come from body paths:
+
+```ts
+eventIngestion({
+  id: {
+    bodyPath: 'id',
+  },
+  type: {
+    bodyPath: 'event.type',
+  },
+})
+```
+
+## Formats
+
+JSON is the default:
+
+```ts
+eventIngestion()
+```
+
+NDJSON is supported for batch-style event delivery:
+
+```ts
+eventIngestion({
+  format: 'ndjson',
+})
+```
+
+Raw mode passes the request body as a string:
+
+```ts
+eventIngestion({
+  format: 'raw',
+})
+```
+
+## Error responses
+
+Invalid signatures return:
+
+```json
+{
+  "error": "invalid_signature",
+  "message": "Signature mismatch"
+}
+```
+
+Malformed payloads return:
+
+```json
+{
+  "error": "invalid_event_payload",
+  "message": "Unexpected end of JSON input"
+}
+```
+
+Customize responses with hooks:
+
+```ts
+eventIngestion({
+  onInvalidSignature: (c, reason) => c.json({ reason }, 403),
+  onInvalidPayload: (c, reason) => c.json({ reason }, 422),
+})
+```
+
+## Downstream validation
+
+The middleware is intended to parse the event before downstream handlers run.
+Use `c.get('eventPayload')` instead of reading the body again:
+
+```ts
+app.post('/events', eventIngestion(), async (c) => {
+  const payload = c.get('eventPayload')
+  const parsed = schema.parse(payload)
+  return c.json(parsed)
+})
+```
+
+If you also install Hono's `validator('json', ...)` after the event ingestion
+middleware, the validator will attempt to read the request body again. Prefer
+validating `eventPayload` directly.
+
+## Provider examples
+
+### Stripe-style events
+
+```ts
+app.post(
+  '/stripe',
+  eventIngestion({
+    verifier: {
+      algorithm: 'sha256',
+      secret: (c) => c.env.STRIPE_WEBHOOK_SECRET,
+      headerName: 'stripe-signature',
+      prefix: 'v1=',
+    },
+    id: {
+      bodyPath: 'id',
+    },
+    type: {
+      bodyPath: 'type',
+    },
+  }),
+  async (c) => {
+    const event = c.get('event')
+    switch (event.type) {
+      case 'checkout.session.completed':
+        await handleCheckout(event.payload)
+        break
+      case 'invoice.payment_failed':
+        await handleFailedPayment(event.payload)
+        break
+    }
+    return c.text('ok')
+  }
+)
+```
+
+### GitHub-style events
+
+```ts
+app.post(
+  '/github',
+  eventIngestion({
+    verifier: {
+      algorithm: 'sha256',
+      secret: (c) => c.env.GITHUB_WEBHOOK_SECRET,
+      headerName: 'x-hub-signature-256',
+      prefix: 'sha256=',
+    },
+    id: {
+      headerName: 'x-github-delivery',
+    },
+    type: {
+      headerName: 'x-github-event',
+    },
+  }),
+  async (c) => {
+    const event = c.get('event')
+    await githubEvents.enqueue(event)
+    return c.text('ok')
+  }
+)
+```
+
+### Batch NDJSON events
+
+```ts
+app.post(
+  '/batch',
+  eventIngestion({
+    format: 'ndjson',
+  }),
+  async (c) => {
+    const payload = c.get('eventPayload')
+    for (const event of payload as Array<{ id: string }>) {
+      await queue.add(event)
+    }
+    return c.text('ok')
+  }
+)
+```
+
+## Testing
+
+Use `createTestSignature` in tests:
+
+```ts
+const body = JSON.stringify({ id: 'evt_123' })
+const signature = createTestSignature({
+  payload: body,
+  secret: 'secret',
+})
+
+const res = await app.request('/events', {
+  method: 'POST',
+  headers: {
+    'x-hono-signature': signature,
+  },
+  body,
+})
+```
+
+## Operational notes
+
+The middleware owns parsing for routes where it is installed. This keeps event
+endpoints simple:
+
+1. Read the event body.
+2. Verify the signature.
+3. Parse the event payload.
+4. Attach `event`, `eventPayload`, and optionally `eventRawBody`.
+5. Run the handler.
+
+When a handler needs the original request bytes, read `eventRawBody`. When a
+handler needs structured data, read `eventPayload`.
+
+## Review checklist
+
+When reviewing event ingestion middleware, ask:
+
+- Does the middleware consume `c.req.raw` or use Hono's `c.req` body cache?
+- Can a downstream `validator('json', ...)` still read the request body?
+- Does the route handler still have access to the original request if needed?
+- Are signatures computed over exactly the bytes the provider sent?
+- Does the code use Web `ReadableStream`, `Request.clone()`, or `tee()` in
+  generic middleware?
+- Are Node APIs isolated to Node adapters, or imported by portable middleware?
+- Does the middleware work on Cloudflare Workers, Deno, Bun, Vercel Edge, and
+  Lambda Edge without Node compatibility flags?
+- Is replay-window validation independent from payload parsing?
+- Do tests cover downstream body reads, not only `c.get('eventPayload')`?
+- Do tests simulate edge runtimes without `node:stream`, `Buffer`, or
+  `node:crypto`?
diff --git a/src/index.ts b/src/index.ts
index 4b42d8a7e..1e4a9e823 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -44,6 +44,7 @@ export type { Context } from './context'
 export type { HonoRequest } from './request'
 export { Hono } from './hono'
 export type { MiddlewareHandler } from './types'
+export { eventIngestion } from './middleware/event-ingestion'
 export type {
   ContextVariableMap,
   Env,
diff --git a/package.json b/package.json
index 6f4b071da..58e496fd6 100644
--- a/package.json
+++ b/package.json
@@ -58,6 +58,15 @@
       "types": "./dist/types/middleware/body-limit/index.d.ts",
       "default": "./dist/middleware/body-limit/index.js"
     },
+    "./event-ingestion": {
+      "types": "./dist/types/middleware/event-ingestion/index.d.ts",
+      "default": "./dist/middleware/event-ingestion/index.js"
+    },
+    "./middleware/event-ingestion": {
+      "types": "./dist/types/middleware/event-ingestion/index.d.ts",
+      "default": "./dist/middleware/event-ingestion/index.js"
+    },
     "./bearer-auth": {
       "types": "./dist/types/middleware/bearer-auth/index.d.ts",
       "default": "./dist/middleware/bearer-auth/index.js"
```

## Intended Flaws

### Flaw 1: The middleware consumes the raw request body and breaks downstream body readers

The middleware reads from `c.req.raw.body` through `readRawBodyAsBuffer()` and never clones, tees, caches, or reconstructs the request body before calling `next()`. That means downstream handlers, validators, and middleware that call `c.req.json()`, `c.req.text()`, `c.req.arrayBuffer()`, or `cloneRawRequest(c.req)` will see a consumed body or an empty body. The tests mostly avoid this by using `c.get('eventPayload')`, and one test even locks in `c.req.raw.bodyUsed === true`.

Relevant line references:

- `src/middleware/event-ingestion/body-reader.ts:33-42` reads directly from `c.req.raw.body` and converts it into a Node stream.
- `src/middleware/event-ingestion/body-reader.ts:44-62` returns parsed bytes without writing to `c.req.bodyCache` or replacing `c.req.raw`.
- `src/middleware/event-ingestion/index.ts:141-151` calls the body reader before `next()`.
- `src/middleware/event-ingestion/index.ts:208-228` calls `await next()` without restoring the raw `Request` body.
- `src/middleware/event-ingestion/index.test.ts:264-294` asserts the raw body is consumed after ingestion.
- `src/middleware/event-ingestion/README.md:57-79` tells handlers not to read the body again and treats consumed `c.req.raw` as expected behavior.

Why this is a real flaw:

Fetch request bodies are single-consumption streams. Hono deliberately wraps body reads with `HonoRequest` caching so middleware and handlers can safely compose. A generic ingestion middleware that consumes `c.req.raw` breaks that composition. Routes that combine event ingestion with `validator('json', ...)`, schema middleware, logging, forwarding, or a handler that expects `await c.req.json()` will fail in production even though the event middleware itself appears to work.

Better implementation direction:

Read through Hono's cached API (`await c.req.text()` or `await c.req.arrayBuffer()`) so later reads can be derived from `bodyCache`, or clone/tee the raw `Request` before reading. If the middleware must consume a stream for size enforcement, reconstruct `c.req.raw = new Request(c.req.raw, { body: preservedReadableStream })` like Hono's body-limit middleware does. The contract should explicitly guarantee whether downstream body reads still work.

### Flaw 2: Generic middleware imports Node-only streams and crypto APIs

The PR puts `node:stream`, `NodeJS.ReadableStream`, `node:crypto`, `Buffer`, and `Readable.fromWeb()` inside the portable `src/middleware/event-ingestion` package. Hono middleware is expected to work across web-standard runtimes, but these APIs are not available by default in Cloudflare Workers, Vercel Edge, service workers, many Deno deployments, and other edge runtimes.

Relevant line references:

- `src/middleware/event-ingestion/body-reader.ts:1-42` imports `node:stream`, uses `NodeJS.ReadableStream`, and converts a Web stream with `Readable.fromWeb`.
- `src/middleware/event-ingestion/signature.ts:1-45` imports `node:crypto`, uses `Buffer`, `createHmac`, and `timingSafeEqual`.
- `src/middleware/event-ingestion/runtime.test.ts:53-64` documents that edge workers need Node stream polyfills.
- `src/middleware/event-ingestion/runtime.test.ts:66-71` documents that edge workers need Node crypto polyfills.
- `src/middleware/event-ingestion/README.md:25-40` tells edge users to enable Node compatibility or polyfills instead of preserving Hono's portability.
- `src/index.ts:44-47` exports the middleware from Hono's main package surface, so portable apps can import Node-only code accidentally.

Why this is a real flaw:

Hono's value proposition is runtime portability over the Fetch API. Generic middleware that imports Node builtins changes the deployment contract. An app that works on Cloudflare Workers can fail at import time before a request is handled. Bundler polyfills can increase bundle size, change crypto behavior, and still be unavailable on strict edge platforms. Node-specific code belongs in adapters or optional runtime-specific entrypoints, not in middleware exported from the core package.

Better implementation direction:

Use Web APIs in the portable middleware: `Request.clone()`, `ReadableStream.tee()`, `arrayBuffer()`, `TextEncoder`, and Web Crypto `crypto.subtle` for HMAC verification. If Node-specific optimizations are needed, place them behind a separate `hono/event-ingestion/node` export or runtime adapter, while the default middleware stays Fetch/Web-standard compatible.

## Hints

### Flaw 1 Hints

1. What happens in Fetch runtimes after you read `request.body` or `request.text()` once?
2. How does Hono make `c.req.text()`, `c.req.json()`, and `c.req.arrayBuffer()` compose today?
3. Which test proves the middleware leaves the raw body consumed instead of preserving it?

### Flaw 2 Hints

1. Would `import { Readable } from 'node:stream'` work in a strict Cloudflare Worker?
2. Where does Hono normally isolate Node-specific code: generic middleware or adapters?
3. Which Web APIs could compute the same signature and read the same body bytes without Node builtins?

## Expected Answer

A strong review should say that the middleware solves a real event-endpoint problem, but it violates two core Hono contracts. First, it consumes the raw request stream before downstream middleware runs, so Hono's body cache is bypassed and later body reads fail. Second, it imports Node stream and crypto APIs from a generic middleware package, breaking edge/runtime portability.

For flaw 1, the learner should identify direct reads from `c.req.raw.body` and the missing clone/tee/cache/reconstruction before `next()`. The impact is broken `validator('json')`, logging, forwarding, schema middleware, and handlers that still call `c.req.json()` after ingestion. The fix is to use HonoRequest cached body methods or clone/tee and restore the raw request body.

For flaw 2, the learner should identify Node-only imports and `Buffer`/`Readable.fromWeb`/`createHmac` in portable middleware. The impact is import-time/runtime failure on Cloudflare Workers, Vercel Edge, service workers, and strict Deno deployments. The fix is a Web API-compatible implementation or a separate Node-specific entrypoint.

The best answers should connect both flaws to middleware design: middleware is not an isolated function. It participates in a chain, so it must preserve downstream contracts and the runtime contract of the framework.

## Expert Debrief

At the product level, event ingestion is a useful middleware category. Webhook endpoints often need exactly the same work: read raw bytes, verify signatures, parse JSON or NDJSON, extract event ids, reject replayed requests, and attach normalized context for the route handler.

The first contract is body ownership. In Fetch, a request body is a stream, and streams are consumed once. Hono's `HonoRequest` abstraction exists partly to make body reads compose: read as text, then json, then arrayBuffer, and the cache can serve those later calls. A middleware that bypasses `c.req` and reads `c.req.raw.body` directly opts out of that safety.

The second contract is runtime portability. Hono is not only a Node framework. Its middleware surface is expected to run anywhere a web-standard `Request` exists. Node streams and Node crypto are valid inside Node adapters, but importing them from a generic middleware changes the install and deployment story for everyone.

The failure modes are concrete:

- A route installs `eventIngestion()` and then `validator('json', ...)`; validation fails because the body has already been consumed.
- A handler tries to forward the original request with `cloneRawRequest(c.req)`; cloning fails because bodyCache is empty.
- Logging middleware after ingestion cannot inspect the raw body.
- A Cloudflare Worker fails during module evaluation because `node:stream` is unavailable.
- Vercel Edge bundles a large Node polyfill for one middleware import and still fails on crypto compatibility.
- A strict Deno deployment passes tests in Node but fails at runtime.

The reviewer thought process should be: first inspect how the middleware composes with the rest of the chain. Any middleware that reads the body must say what happens to downstream readers. Then inspect import boundaries. If code lives under a generic `src/middleware` export, assume it must be Fetch/Web-standard unless the package creates a runtime-specific entrypoint.

The better design is portable and explicit: clone the request before signature verification, read through `c.req.text()` so Hono caches the body, or tee/reconstruct `c.req.raw` when stream-level control is required. Use Web Crypto by default. Keep Node-specific acceleration in an optional adapter.

## Correctness Verdict Rubric

- `correct`: The answer identifies both intended flaws: raw body consumption before downstream middleware and Node-only stream/crypto usage in portable middleware. It explains single-use Fetch body failure, broken Hono validators/body cache/cloneRawRequest, edge runtime import failures, and recommends clone/tee/cache/reconstruct plus Web APIs or a Node-only entrypoint.
- `partial`: The answer finds one flaw completely and gestures at either generic body parsing risk or generic runtime compatibility without tying it to HonoRequest bodyCache, downstream middleware composition, and Hono's runtime-portable package surface.
- `miss`: The answer focuses on signature algorithm choice, max body size, variable naming, response status wording, test coverage quantity, or docs wording while missing raw request consumption and Node-only runtime assumptions.
