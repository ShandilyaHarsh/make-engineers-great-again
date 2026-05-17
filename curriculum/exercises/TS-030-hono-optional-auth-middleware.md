# TS-030: Hono Optional Auth Middleware Helper

## Metadata

- `id`: TS-030
- `source_repo`: [honojs/hono](https://github.com/honojs/hono)
- `repo_area`: middleware contracts, JWT/bearer auth, context variables, route-local Env typing, ContextVariableMap, middleware tests, package exports
- `mode`: synthetic_degraded
- `difficulty`: 3
- `target_diff_lines`: 1,150-1,450
- `represented_diff_lines`: 1152
- `flaw_count`: 2
- `discussion_chat_contract`: In the eventual app, this PR case must render an open model discussion chat below the review surface so the learner can ask questions about optional authentication, fail-open vs fail-closed middleware, Hono context typing, route-local variables, module augmentation, and protected-route contracts without reducing credit.
- `progress_persistence_contract`: The eventual app must persist current PR number, draft answers, submitted answers, line references, verdicts, revealed hints, expert debrief visibility, and chat history in local storage so the learner can return to this case later.

## PR Description Shown To Learner

This PR adds an optional-auth middleware helper for Hono.

Apps often have routes that work for both guests and signed-in users: a public article page can personalize bookmarks, a product page can show team-specific controls, and a docs API can rate-limit authenticated users differently from anonymous users. Today users typically compose `jwt`, `bearerAuth`, or custom middleware manually and write their own `try/catch` logic around missing credentials.

The new helper adds:

- `optionalAuth()` for routes that may have an authenticated user,
- `required: true` mode for routes that should reject missing credentials,
- bearer-token and JWT strategy adapters,
- context variables such as `authUser`, `authToken`, and `authError`,
- convenience helpers for reading the current user,
- package exports for `hono/optional-auth`,
- runtime tests for guest, authenticated, invalid-token, and required-route behavior,
- type tests showing `c.var.authUser` and `c.get("authUser")`.

## Existing Code Context

The real Hono codebase already has these relevant contracts:

- `src/middleware/jwt/jwt.ts` throws `HTTPException(401)` when the Authorization structure is invalid, when no token/cookie is present, and when JWT verification fails. On success it sets `ctx.set("jwtPayload", payload)`.
- `src/middleware/bearer-auth/index.ts` exports `bearerAuth`, throws `HTTPException(401)` for missing or invalid tokens and `HTTPException(400)` for malformed Authorization headers. It only calls `await next()` after authentication succeeds.
- `src/middleware/basic-auth/index.ts` exports `basicAuth`, throws `HTTPException(401)` when credentials are missing or invalid, and its tests assert that success callbacks do not run on failed auth.
- `src/http-exception.ts` documents `HTTPException` as the expected fatal-control-flow mechanism for authentication failures.
- `src/context.ts` implements `c.set`, `c.get`, and `c.var` using `Env["Variables"]` and `ContextVariableMap`. `c.get` returns `undefined` at runtime if a variable was never set.
- `src/types.ts` and `src/helper/factory/index.ts` let middleware contribute route-local variable types through generic `MiddlewareHandler` / `createMiddleware` rather than forcing every app route to share one global context shape.
- `src/types.test.ts` verifies that variables introduced by middleware are visible to routes in that middleware chain and are not automatically typed on unrelated routes.
- `src/middleware/jwt/index.ts` augments `ContextVariableMap` with `jwtPayload: unknown`, while precise JWT payload typing is still modeled by users supplying `Hono<{ Variables: JwtVariables<User> }>()`.
- `src/middleware/combine/index.ts` already provides explicit composition tools such as `some`, `every`, and `except` for paths that should skip or require middleware intentionally.

## Learner Task

Review the PR. Identify the two intended flaws. For each flaw:

1. Name the flaw.
2. Cite the relevant file and line range from the diff.
3. Explain the production impact.
4. Suggest the better implementation direction.

## Review Surface

Changed files in the synthetic PR:

- `src/middleware/optional-auth/types.ts`
- `src/middleware/optional-auth/index.ts`
- `src/middleware/optional-auth/index.test.ts`
- `src/middleware/optional-auth/types.test.ts`
- `src/middleware/jwt/index.ts`
- `src/index.ts`
- `package.json`

The line references below use synthetic PR line numbers. The represented diff is focused on middleware runtime behavior, auth failure semantics, context variable typing, and tests.

## Diff

```diff
diff --git a/src/middleware/optional-auth/types.ts b/src/middleware/optional-auth/types.ts
new file mode 100644
index 000000000..944120b22
--- /dev/null
+++ b/src/middleware/optional-auth/types.ts
@@ -0,0 +1,198 @@
+import type { Context } from '../../context'
+import type { SignatureAlgorithm } from '../../utils/jwt/jwa'
+import type { SignatureKey } from '../../utils/jwt/jws'
+import type { VerifyOptions } from '../../utils/jwt/jwt'
+
+export type AuthUserId = string | number
+
+export type AuthUser = {
+  id: AuthUserId
+  email?: string
+  name?: string
+  roles?: string[]
+  scopes?: string[]
+  metadata?: Record<string, unknown>
+}
+
+export type AuthIdentity<TUser extends AuthUser = AuthUser> = {
+  user: TUser
+  token?: string
+  provider: string
+  claims?: Record<string, unknown>
+}
+
+export type AuthErrorCode =
+  | 'missing'
+  | 'malformed'
+  | 'invalid'
+  | 'expired'
+  | 'provider_error'
+
+export type AuthErrorInfo = {
+  code: AuthErrorCode
+  message: string
+  provider?: string
+  cause?: unknown
+}
+
+export type AuthContext<TUser extends AuthUser = AuthUser> = {
+  isAuthenticated: boolean
+  user: TUser | null
+  token?: string
+  provider?: string
+  claims?: Record<string, unknown>
+  error?: AuthErrorInfo
+}
+
+export type OptionalAuthVariables<TUser extends AuthUser = AuthUser> = {
+  authUser?: TUser | null
+  authContext?: AuthContext<TUser>
+  authToken?: string
+  authError?: AuthErrorInfo
+}
+
+export type AuthStrategyResult<TUser extends AuthUser = AuthUser> =
+  | AuthIdentity<TUser>
+  | null
+  | undefined
+
+export type AuthStrategy<TUser extends AuthUser = AuthUser> = {
+  name: string
+  hasCredentials?: (c: Context) => boolean
+  getToken?: (c: Context) => string | null | undefined | Promise<string | null | undefined>
+  authenticate: (
+    c: Context,
+    token: string | null | undefined
+  ) => AuthStrategyResult<TUser> | Promise<AuthStrategyResult<TUser>>
+}
+
+export type AuthFailureMode = 'anonymous' | 'throw'
+
+export type OptionalAuthOptions<TUser extends AuthUser = AuthUser> = {
+  strategies: AuthStrategy<TUser>[]
+  required?: boolean
+  failureMode?: AuthFailureMode
+  realm?: string
+  exposeError?: boolean
+  variableName?: string
+}
+
+export type BearerTokenOptions<TUser extends AuthUser = AuthUser> = {
+  name?: string
+  headerName?: string
+  prefix?: string
+  verifyToken: (token: string, c: Context) => TUser | null | Promise<TUser | null>
+}
+
+export type JwtOptionalAuthOptions<TUser extends AuthUser = AuthUser> = {
+  name?: string
+  secret: SignatureKey
+  alg: SignatureAlgorithm
+  headerName?: string
+  mapPayload: (payload: Record<string, unknown>, c: Context) => TUser | null | Promise<TUser | null>
+  verification?: VerifyOptions
+}
+
+export type CurrentUserOptions = {
+  required?: boolean
+  message?: string
+}
+
+export type OptionalAuthResponseBody = {
+  error: string
+  message: string
+}
+
+export const defaultAuthContext = <TUser extends AuthUser>(
+  error?: AuthErrorInfo
+): AuthContext<TUser> => ({
+  isAuthenticated: false,
+  user: null,
+  error,
+})
+
+export const authenticatedContext = <TUser extends AuthUser>(
+  identity: AuthIdentity<TUser>
+): AuthContext<TUser> => ({
+  isAuthenticated: true,
+  user: identity.user,
+  token: identity.token,
+  provider: identity.provider,
+  claims: identity.claims,
+})
+
+export const isAuthUser = (value: unknown): value is AuthUser => {
+  if (!value || typeof value !== 'object') {
+    return false
+  }
+  const maybeUser = value as Partial<AuthUser>
+  return typeof maybeUser.id === 'string' || typeof maybeUser.id === 'number'
+}
+
+export const normalizeAuthError = (
+  error: unknown,
+  provider?: string,
+  fallbackCode: AuthErrorCode = 'invalid'
+): AuthErrorInfo => {
+  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
+    const typed = error as AuthErrorInfo
+    return {
+      code: typed.code,
+      message: typed.message,
+      provider: typed.provider ?? provider,
+      cause: typed.cause,
+    }
+  }
+
+  if (error instanceof Error) {
+    return {
+      code: fallbackCode,
+      message: error.message,
+      provider,
+      cause: error,
+    }
+  }
+
+  return {
+    code: fallbackCode,
+    message: 'Authentication failed',
+    provider,
+    cause: error,
+  }
+}
+
+export const unauthorizedBody = (message: string): OptionalAuthResponseBody => ({
+  error: 'unauthorized',
+  message,
+})
+
+export const malformedBody = (message: string): OptionalAuthResponseBody => ({
+  error: 'invalid_request',
+  message,
+})
+
+export const getAuthorizationHeader = (c: Context, headerName = 'Authorization') => {
+  return c.req.header(headerName) ?? null
+}
+
+export const hasAnyAuthorizationHeader = (c: Context, headerName = 'Authorization') => {
+  return Boolean(getAuthorizationHeader(c, headerName))
+}
+
+export const getBearerTokenFromHeader = (
+  headerValue: string | null | undefined,
+  prefix = 'Bearer'
+) => {
+  if (!headerValue) {
+    return null
+  }
+  if (prefix === '') {
+    return headerValue
+  }
+  const lowerHeader = headerValue.toLowerCase()
+  const lowerPrefix = prefix.toLowerCase()
+  if (!lowerHeader.startsWith(lowerPrefix) || headerValue[prefix.length] !== ' ') {
+    return null
+  }
+  return headerValue.slice(prefix.length).trimStart()
+}
diff --git a/src/middleware/optional-auth/index.ts b/src/middleware/optional-auth/index.ts
new file mode 100644
index 000000000..a03e39b9c
--- /dev/null
+++ b/src/middleware/optional-auth/index.ts
@@ -0,0 +1,322 @@
+/**
+ * @module
+ * Optional Auth Middleware for Hono.
+ */
+
+import type { Context } from '../../context'
+import { HTTPException } from '../../http-exception'
+import type { MiddlewareHandler } from '../../types'
+import { Jwt } from '../../utils/jwt'
+import type {
+  AuthContext,
+  AuthErrorInfo,
+  AuthIdentity,
+  AuthStrategy,
+  AuthUser,
+  BearerTokenOptions,
+  CurrentUserOptions,
+  JwtOptionalAuthOptions,
+  OptionalAuthOptions,
+  OptionalAuthVariables,
+} from './types'
+import {
+  authenticatedContext,
+  defaultAuthContext,
+  getAuthorizationHeader,
+  getBearerTokenFromHeader,
+  hasAnyAuthorizationHeader,
+  malformedBody,
+  normalizeAuthError,
+  unauthorizedBody,
+} from './types'
+import '../..'
+
+declare module '../..' {
+  interface ContextVariableMap extends OptionalAuthVariables {}
+}
+
+const DEFAULT_REALM = 'hono'
+
+const bearerChallenge = (realm = DEFAULT_REALM, error?: string, description?: string) => {
+  const params = [`realm="${realm.replace(/"/g, '\\"')}"`]
+  if (error) {
+    params.push(`error="${error}"`)
+  }
+  if (description) {
+    params.push(`error_description="${description.replace(/"/g, '\\"')}"`)
+  }
+  return `Bearer ${params.join(',')}`
+}
+
+const authResponse = (status: 400 | 401, body: object, challenge: string) => {
+  return new Response(JSON.stringify(body), {
+    status,
+    headers: {
+      'content-type': 'application/json',
+      'WWW-Authenticate': challenge,
+    },
+  })
+}
+
+const throwUnauthorized = (message: string, realm?: string): never => {
+  throw new HTTPException(401, {
+    message,
+    res: authResponse(401, unauthorizedBody(message), bearerChallenge(realm, 'invalid_token', message)),
+  })
+}
+
+const throwMalformed = (message: string, realm?: string): never => {
+  throw new HTTPException(400, {
+    message,
+    res: authResponse(400, malformedBody(message), bearerChallenge(realm, 'invalid_request', message)),
+  })
+}
+
+const setAnonymous = <TUser extends AuthUser>(
+  c: Context,
+  error?: AuthErrorInfo,
+  exposeError = false
+) => {
+  const context = defaultAuthContext<TUser>(exposeError ? error : undefined)
+  c.set('authUser', null)
+  c.set('authContext', context)
+  if (exposeError && error) {
+    c.set('authError', error)
+  }
+}
+
+const setAuthenticated = <TUser extends AuthUser>(c: Context, identity: AuthIdentity<TUser>) => {
+  c.set('authUser', identity.user)
+  c.set('authContext', authenticatedContext(identity))
+  if (identity.token) {
+    c.set('authToken', identity.token)
+  }
+}
+
+const tokenFromStrategy = async <TUser extends AuthUser>(
+  c: Context,
+  strategy: AuthStrategy<TUser>
+) => {
+  if (strategy.getToken) {
+    return await strategy.getToken(c)
+  }
+  return getBearerTokenFromHeader(getAuthorizationHeader(c))
+}
+
+const authenticateWithStrategies = async <TUser extends AuthUser>(
+  c: Context,
+  strategies: AuthStrategy<TUser>[]
+) => {
+  let lastError: AuthErrorInfo | undefined
+  for (const strategy of strategies) {
+    let token: string | null | undefined
+    try {
+      token = await tokenFromStrategy(c, strategy)
+    } catch (error) {
+      lastError = normalizeAuthError(error, strategy.name, 'malformed')
+      continue
+    }
+
+    if (!token) {
+      continue
+    }
+
+    try {
+      const identity = await strategy.authenticate(c, token)
+      if (identity?.user) {
+        return identity
+      }
+      lastError = {
+        code: 'invalid',
+        message: 'Authentication strategy returned no user',
+        provider: strategy.name,
+      }
+    } catch (error) {
+      lastError = normalizeAuthError(error, strategy.name)
+    }
+  }
+  return { identity: null, error: lastError }
+}
+
+/**
+ * Creates middleware that sets auth context when credentials are present.
+ *
+ * It is designed for endpoints that can render both guest and signed-in views.
+ */
+export const optionalAuth = <TUser extends AuthUser = AuthUser>(
+  options: OptionalAuthOptions<TUser>
+): MiddlewareHandler => {
+  if (!options.strategies.length) {
+    throw new Error('optional auth middleware requires at least one strategy')
+  }
+
+  return async function optionalAuth(c, next) {
+    const hasCredentials = options.strategies.some((strategy) => {
+      return strategy.hasCredentials?.(c) ?? hasAnyAuthorizationHeader(c)
+    })
+
+    if (!hasCredentials) {
+      if (options.required) {
+        throwUnauthorized('No authorization included in request', options.realm)
+      }
+      setAnonymous<TUser>(c)
+      await next()
+      return
+    }
+
+    const { identity, error } = await authenticateWithStrategies(c, options.strategies)
+    if (identity) {
+      setAuthenticated(c, identity)
+      await next()
+      return
+    }
+
+    if (options.failureMode === 'throw') {
+      if (error?.code === 'malformed') {
+        throwMalformed(error.message, options.realm)
+      }
+      throwUnauthorized(error?.message ?? 'Invalid credentials', options.realm)
+    }
+
+    setAnonymous<TUser>(c, error, options.exposeError)
+    await next()
+  }
+}
+
+export const bearerTokenStrategy = <TUser extends AuthUser = AuthUser>(
+  options: BearerTokenOptions<TUser>
+): AuthStrategy<TUser> => {
+  const name = options.name ?? 'bearer'
+  const headerName = options.headerName ?? 'Authorization'
+  const prefix = options.prefix ?? 'Bearer'
+
+  return {
+    name,
+    hasCredentials: (c) => Boolean(c.req.header(headerName)),
+    getToken: (c) => {
+      const header = c.req.header(headerName)
+      if (!header) {
+        return null
+      }
+      const token = getBearerTokenFromHeader(header, prefix)
+      if (!token) {
+        throw {
+          code: 'malformed',
+          message: 'Invalid Authorization header',
+          provider: name,
+        } satisfies AuthErrorInfo
+      }
+      return token
+    },
+    authenticate: async (c, token) => {
+      if (!token) {
+        return null
+      }
+      const user = await options.verifyToken(token, c)
+      if (!user) {
+        return null
+      }
+      return {
+        user,
+        token,
+        provider: name,
+      }
+    },
+  }
+}
+
+export const jwtStrategy = <TUser extends AuthUser = AuthUser>(
+  options: JwtOptionalAuthOptions<TUser>
+): AuthStrategy<TUser> => {
+  const name = options.name ?? 'jwt'
+  const headerName = options.headerName ?? 'Authorization'
+
+  return {
+    name,
+    hasCredentials: (c) => Boolean(c.req.header(headerName)),
+    getToken: (c) => {
+      const header = c.req.header(headerName)
+      if (!header) {
+        return null
+      }
+      const token = getBearerTokenFromHeader(header)
+      if (!token) {
+        throw {
+          code: 'malformed',
+          message: 'Invalid Authorization header',
+          provider: name,
+        } satisfies AuthErrorInfo
+      }
+      return token
+    },
+    authenticate: async (c, token) => {
+      if (!token) {
+        return null
+      }
+      const payload = await Jwt.verify(token, options.secret, {
+        alg: options.alg,
+        ...(options.verification ?? {}),
+      })
+      const user = await options.mapPayload(payload as Record<string, unknown>, c)
+      if (!user) {
+        return null
+      }
+      return {
+        user,
+        token,
+        provider: name,
+        claims: payload as Record<string, unknown>,
+      }
+    },
+  }
+}
+
+export const requireCurrentUser = <TUser extends AuthUser = AuthUser>(
+  c: Context,
+  options: CurrentUserOptions = {}
+): TUser => {
+  const user = c.get('authUser') as TUser | null | undefined
+  if (!user) {
+    throw new HTTPException(401, {
+      message: options.message ?? 'Authentication required',
+      res: authResponse(
+        401,
+        unauthorizedBody(options.message ?? 'Authentication required'),
+        bearerChallenge(DEFAULT_REALM, 'invalid_token', options.message ?? 'Authentication required')
+      ),
+    })
+  }
+  return user
+}
+
+export const currentUser = <TUser extends AuthUser = AuthUser>(c: Context): TUser | null => {
+  return (c.get('authUser') as TUser | null | undefined) ?? null
+}
+
+export const currentAuthContext = <TUser extends AuthUser = AuthUser>(
+  c: Context
+): AuthContext<TUser> => {
+  return (
+    (c.get('authContext') as AuthContext<TUser> | undefined) ?? defaultAuthContext<TUser>()
+  )
+}
+
+export const isAuthenticated = (c: Context) => {
+  return Boolean(currentAuthContext(c).isAuthenticated)
+}
+
+export type {
+  AuthContext,
+  AuthErrorCode,
+  AuthErrorInfo,
+  AuthIdentity,
+  AuthStrategy,
+  AuthStrategyResult,
+  AuthUser,
+  AuthUserId,
+  BearerTokenOptions,
+  CurrentUserOptions,
+  JwtOptionalAuthOptions,
+  OptionalAuthOptions,
+  OptionalAuthVariables,
+} from './types'
diff --git a/src/middleware/optional-auth/index.test.ts b/src/middleware/optional-auth/index.test.ts
new file mode 100644
index 000000000..e23838d53
--- /dev/null
+++ b/src/middleware/optional-auth/index.test.ts
@@ -0,0 +1,431 @@
+import { Hono } from '../../hono'
+import { sign } from '../../utils/jwt'
+import {
+  bearerTokenStrategy,
+  currentAuthContext,
+  currentUser,
+  jwtStrategy,
+  optionalAuth,
+  requireCurrentUser,
+} from '.'
+import type { AuthUser } from './types'
+
+type TestUser = AuthUser & {
+  id: string
+  email: string
+  roles: string[]
+}
+
+const usersByToken = new Map<string, TestUser>([
+  [
+    'valid-token',
+    {
+      id: 'usr_1',
+      email: 'first@example.com',
+      roles: ['member'],
+    },
+  ],
+  [
+    'admin-token',
+    {
+      id: 'usr_admin',
+      email: 'admin@example.com',
+      roles: ['admin'],
+    },
+  ],
+])
+
+const bearerStrategy = bearerTokenStrategy<TestUser>({
+  verifyToken: async (token) => usersByToken.get(token) ?? null,
+})
+
+describe('optionalAuth middleware', () => {
+  it('sets an anonymous auth context when no Authorization header is present', async () => {
+    const app = new Hono()
+
+    app.use('/article/*', optionalAuth({ strategies: [bearerStrategy] }))
+    app.get('/article/:id', (c) => {
+      const context = currentAuthContext<TestUser>(c)
+      return c.json({
+        articleId: c.req.param('id'),
+        signedIn: context.isAuthenticated,
+        userId: context.user?.id ?? null,
+      })
+    })
+
+    const res = await app.request('/article/intro')
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      articleId: 'intro',
+      signedIn: false,
+      userId: null,
+    })
+  })
+
+  it('sets the current user when a valid bearer token is present', async () => {
+    const app = new Hono()
+
+    app.use('/article/*', optionalAuth({ strategies: [bearerStrategy] }))
+    app.get('/article/:id', (c) => {
+      const user = currentUser<TestUser>(c)
+      return c.json({
+        articleId: c.req.param('id'),
+        signedIn: Boolean(user),
+        userId: user?.id ?? null,
+      })
+    })
+
+    const res = await app.request('/article/intro', {
+      headers: {
+        Authorization: 'Bearer valid-token',
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      articleId: 'intro',
+      signedIn: true,
+      userId: 'usr_1',
+    })
+  })
+
+  it('exposes auth errors for diagnostics when requested', async () => {
+    const app = new Hono()
+
+    app.use(
+      '/article/*',
+      optionalAuth({
+        strategies: [bearerStrategy],
+        exposeError: true,
+      })
+    )
+    app.get('/article/:id', (c) => {
+      const context = currentAuthContext<TestUser>(c)
+      return c.json({
+        signedIn: context.isAuthenticated,
+        error: c.get('authError')?.code ?? null,
+      })
+    })
+
+    const res = await app.request('/article/intro', {
+      headers: {
+        Authorization: 'Bearer wrong-token',
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      signedIn: false,
+      error: 'invalid',
+    })
+  })
+
+  it('treats malformed Authorization as anonymous on optional routes', async () => {
+    const app = new Hono()
+
+    app.use(
+      '/catalog/*',
+      optionalAuth({
+        strategies: [bearerStrategy],
+        exposeError: true,
+      })
+    )
+    app.get('/catalog/products', (c) => {
+      return c.json({
+        mode: currentUser<TestUser>(c) ? 'signed-in' : 'guest',
+        error: c.get('authError')?.code ?? null,
+      })
+    })
+
+    const res = await app.request('/catalog/products', {
+      headers: {
+        Authorization: 'Bearer',
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      mode: 'guest',
+      error: 'malformed',
+    })
+  })
+
+  it('rejects missing Authorization when required is true', async () => {
+    const app = new Hono()
+
+    app.use(
+      '/account/*',
+      optionalAuth({
+        strategies: [bearerStrategy],
+        required: true,
+      })
+    )
+    app.get('/account/settings', (c) => {
+      return c.json({
+        userId: requireCurrentUser<TestUser>(c).id,
+      })
+    })
+
+    const res = await app.request('/account/settings')
+    expect(res.status).toBe(401)
+    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
+  })
+
+  it('continues as anonymous when required route receives invalid Authorization', async () => {
+    const app = new Hono()
+
+    app.use(
+      '/account/*',
+      optionalAuth({
+        strategies: [bearerStrategy],
+        required: true,
+        exposeError: true,
+      })
+    )
+    app.get('/account/settings', (c) => {
+      const user = currentUser<TestUser>(c)
+      if (!user) {
+        return c.json({
+          mode: 'anonymous',
+          banner: 'sign in to save changes',
+          error: c.get('authError')?.code ?? null,
+        })
+      }
+      return c.json({
+        mode: 'user',
+        userId: user.id,
+      })
+    })
+
+    const res = await app.request('/account/settings', {
+      headers: {
+        Authorization: 'Bearer wrong-token',
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      mode: 'anonymous',
+      banner: 'sign in to save changes',
+      error: 'invalid',
+    })
+  })
+
+  it('continues as anonymous when required route receives malformed Authorization', async () => {
+    const app = new Hono()
+
+    app.use(
+      '/account/*',
+      optionalAuth({
+        strategies: [bearerStrategy],
+        required: true,
+        exposeError: true,
+      })
+    )
+    app.get('/account/audit', (c) => {
+      const user = currentUser<TestUser>(c)
+      return c.json({
+        auditVisible: user?.roles.includes('admin') ?? false,
+        authError: c.get('authError')?.code ?? null,
+      })
+    })
+
+    const res = await app.request('/account/audit', {
+      headers: {
+        Authorization: 'NotBearer abc',
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      auditVisible: false,
+      authError: 'malformed',
+    })
+  })
+
+  it('supports throw mode for applications that want fail-closed optional routes', async () => {
+    const app = new Hono()
+
+    app.use(
+      '/strict/*',
+      optionalAuth({
+        strategies: [bearerStrategy],
+        failureMode: 'throw',
+      })
+    )
+    app.get('/strict/profile', (c) => {
+      return c.json({
+        userId: currentUser<TestUser>(c)?.id ?? null,
+      })
+    })
+
+    const res = await app.request('/strict/profile', {
+      headers: {
+        Authorization: 'Bearer wrong-token',
+      },
+    })
+    expect(res.status).toBe(401)
+  })
+
+  it('supports custom bearer prefixes and header names', async () => {
+    const app = new Hono()
+    const apiKeyStrategy = bearerTokenStrategy<TestUser>({
+      headerName: 'X-Api-Key',
+      prefix: '',
+      verifyToken: async (token) => usersByToken.get(token) ?? null,
+    })
+
+    app.use('/keys/*', optionalAuth({ strategies: [apiKeyStrategy] }))
+    app.get('/keys/whoami', (c) => {
+      return c.json({
+        userId: currentUser<TestUser>(c)?.id ?? null,
+      })
+    })
+
+    const res = await app.request('/keys/whoami', {
+      headers: {
+        'X-Api-Key': 'admin-token',
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      userId: 'usr_admin',
+    })
+  })
+
+  it('tries later strategies when the first strategy has no credentials', async () => {
+    const app = new Hono()
+    const headerStrategy = bearerTokenStrategy<TestUser>({
+      name: 'api-key',
+      headerName: 'X-Api-Key',
+      prefix: '',
+      verifyToken: async (token) => usersByToken.get(token) ?? null,
+    })
+
+    app.use('/multi/*', optionalAuth({ strategies: [headerStrategy, bearerStrategy] }))
+    app.get('/multi/whoami', (c) => {
+      return c.json({
+        userId: currentUser<TestUser>(c)?.id ?? null,
+      })
+    })
+
+    const res = await app.request('/multi/whoami', {
+      headers: {
+        Authorization: 'Bearer valid-token',
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      userId: 'usr_1',
+    })
+  })
+
+  it('supports JWT strategies', async () => {
+    const app = new Hono()
+    const secret = 'test-secret'
+    const token = await sign(
+      {
+        sub: 'usr_1',
+        email: 'first@example.com',
+        roles: ['member'],
+      },
+      secret,
+      'HS256'
+    )
+    const strategy = jwtStrategy<TestUser>({
+      secret,
+      alg: 'HS256',
+      mapPayload: (payload) => ({
+        id: String(payload.sub),
+        email: String(payload.email),
+        roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
+      }),
+    })
+
+    app.use('/jwt/*', optionalAuth({ strategies: [strategy] }))
+    app.get('/jwt/whoami', (c) => {
+      return c.json({
+        userId: currentUser<TestUser>(c)?.id ?? null,
+      })
+    })
+
+    const res = await app.request('/jwt/whoami', {
+      headers: {
+        Authorization: `Bearer ${token}`,
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      userId: 'usr_1',
+    })
+  })
+
+  it('uses anonymous context when JWT mapPayload returns null', async () => {
+    const app = new Hono()
+    const secret = 'test-secret'
+    const token = await sign(
+      {
+        sub: 'deleted-user',
+        email: 'deleted@example.com',
+      },
+      secret,
+      'HS256'
+    )
+    const strategy = jwtStrategy<TestUser>({
+      secret,
+      alg: 'HS256',
+      mapPayload: () => null,
+    })
+
+    app.use('/jwt/*', optionalAuth({ strategies: [strategy], exposeError: true }))
+    app.get('/jwt/whoami', (c) => {
+      return c.json({
+        userId: currentUser<TestUser>(c)?.id ?? null,
+        error: c.get('authError')?.code ?? null,
+      })
+    })
+
+    const res = await app.request('/jwt/whoami', {
+      headers: {
+        Authorization: `Bearer ${token}`,
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      userId: null,
+      error: 'invalid',
+    })
+  })
+
+  it('supports requireCurrentUser after optionalAuth has set a user', async () => {
+    const app = new Hono()
+
+    app.use('/me/*', optionalAuth({ strategies: [bearerStrategy] }))
+    app.get('/me/profile', (c) => {
+      const user = requireCurrentUser<TestUser>(c)
+      return c.json({
+        id: user.id,
+        email: user.email,
+      })
+    })
+
+    const res = await app.request('/me/profile', {
+      headers: {
+        Authorization: 'Bearer valid-token',
+      },
+    })
+    expect(res.status).toBe(200)
+    expect(await res.json()).toEqual({
+      id: 'usr_1',
+      email: 'first@example.com',
+    })
+  })
+
+  it('throws from requireCurrentUser when optionalAuth has no user', async () => {
+    const app = new Hono()
+
+    app.use('/me/*', optionalAuth({ strategies: [bearerStrategy] }))
+    app.get('/me/profile', (c) => {
+      const user = requireCurrentUser<TestUser>(c)
+      return c.json({ id: user.id })
+    })
+
+    const res = await app.request('/me/profile')
+    expect(res.status).toBe(401)
+  })
+})
diff --git a/src/middleware/optional-auth/types.test.ts b/src/middleware/optional-auth/types.test.ts
new file mode 100644
index 000000000..18354f2f2
--- /dev/null
+++ b/src/middleware/optional-auth/types.test.ts
@@ -0,0 +1,117 @@
+import { expectTypeOf } from 'vitest'
+import { Hono } from '../../hono'
+import type { Handler, MiddlewareHandler } from '../../types'
+import {
+  bearerTokenStrategy,
+  currentAuthContext,
+  currentUser,
+  optionalAuth,
+  requireCurrentUser,
+} from '.'
+import type { AuthContext, AuthUser, OptionalAuthVariables } from './types'
+
+type User = AuthUser & {
+  id: string
+  email: string
+  roles: string[]
+}
+
+const strategy = bearerTokenStrategy<User>({
+  verifyToken: async (token) =>
+    token === 'token'
+      ? {
+          id: 'usr_1',
+          email: 'one@example.com',
+          roles: ['member'],
+        }
+      : null,
+})
+
+describe('optionalAuth type tests', () => {
+  it('adds auth variables to routes using the middleware', () => {
+    const app = new Hono()
+
+    app.get(
+      '/article',
+      optionalAuth({ strategies: [strategy] }),
+      (c) => {
+        expectTypeOf(c.get('authUser')).toEqualTypeOf<AuthUser | null | undefined>()
+        expectTypeOf(c.var.authContext).toEqualTypeOf<AuthContext | undefined>()
+        return c.json({
+          userId: c.var.authUser?.id ?? null,
+        })
+      }
+    )
+  })
+
+  it('also exposes authUser on routes that never installed the middleware', () => {
+    const app = new Hono()
+
+    app.get('/public', (c) => {
+      expectTypeOf(c.get('authUser')).toEqualTypeOf<AuthUser | null | undefined>()
+      expectTypeOf(c.var.authUser).toEqualTypeOf<AuthUser | null | undefined>()
+      return c.json({
+        userId: c.var.authUser?.id ?? null,
+      })
+    })
+  })
+
+  it('lets protected handlers compile even when the user is not required by the type', () => {
+    const protectedHandler: Handler = (c) => {
+      const maybeUser = currentUser<User>(c)
+      return c.json({
+        canWrite: maybeUser?.roles.includes('admin') ?? false,
+      })
+    }
+
+    expectTypeOf(protectedHandler).toEqualTypeOf<Handler>()
+  })
+
+  it('requireCurrentUser returns a concrete user but does not change downstream route types', () => {
+    const app = new Hono()
+
+    app.use('/account/*', optionalAuth({ strategies: [strategy], required: true }))
+    app.get('/account/settings', (c) => {
+      const user = requireCurrentUser<User>(c)
+      expectTypeOf(user).toEqualTypeOf<User>()
+      expectTypeOf(c.var.authUser).toEqualTypeOf<AuthUser | null | undefined>()
+      return c.json({
+        id: user.id,
+      })
+    })
+  })
+
+  it('supports app-level auth variable typing', () => {
+    type Env = {
+      Variables: OptionalAuthVariables<User>
+    }
+    const app = new Hono<Env>()
+
+    app.use('/account/*', optionalAuth({ strategies: [strategy] }))
+    app.get('/account/settings', (c) => {
+      expectTypeOf(c.var.authUser).toEqualTypeOf<User | null | undefined>()
+      return c.json({
+        id: c.var.authUser?.id ?? null,
+      })
+    })
+  })
+
+  it('does not distinguish optional and required auth by route type', () => {
+    const optionalMiddleware = optionalAuth({ strategies: [strategy] })
+    const requiredMiddleware = optionalAuth({ strategies: [strategy], required: true })
+
+    expectTypeOf(optionalMiddleware).toEqualTypeOf<MiddlewareHandler>()
+    expectTypeOf(requiredMiddleware).toEqualTypeOf<MiddlewareHandler>()
+  })
+
+  it('allows a shared helper to read authUser without declaring the route requirement', () => {
+    const readUserId = (c: Parameters<Handler>[0]) => {
+      return c.var.authUser?.id ?? 'guest'
+    }
+
+    const app = new Hono()
+    app.get('/anything', (c) => {
+      return c.text(readUserId(c))
+    })
+  })
+})
diff --git a/src/middleware/jwt/index.ts b/src/middleware/jwt/index.ts
index 64eb91e10..dbb36aa79 100644
--- a/src/middleware/jwt/index.ts
+++ b/src/middleware/jwt/index.ts
@@ -1,6 +1,9 @@
 import type { JwtVariables } from './jwt'
 export type { JwtVariables }
 export { jwt, verifyWithJwks, verify, decode, sign } from './jwt'
+export {
+  optionalAuth,
+  jwtStrategy,
+} from '../optional-auth'
 export { AlgorithmTypes } from '../../utils/jwt/jwa'
 import type {} from '../..'
 
diff --git a/src/index.ts b/src/index.ts
index 2bd11217a..3c1079178 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -31,6 +31,14 @@ export type {
  */
 export type { Context, ContextVariableMap, ContextRenderer, ExecutionContext } from './context'
 /**
+ * Types for optional authentication helpers.
+ */
+export type {
+  AuthContext,
+  AuthUser,
+  OptionalAuthVariables,
+} from './middleware/optional-auth'
+/**
  * Type for HonoRequest.
  */
 export type { HonoRequest } from './request'
diff --git a/package.json b/package.json
index b55c12b17..72690c7de 100644
--- a/package.json
+++ b/package.json
@@ -82,6 +82,11 @@
       "import": "./dist/middleware/bearer-auth/index.js",
       "require": "./dist/cjs/middleware/bearer-auth/index.js"
     },
+    "./optional-auth": {
+      "types": "./dist/types/middleware/optional-auth/index.d.ts",
+      "import": "./dist/middleware/optional-auth/index.js",
+      "require": "./dist/cjs/middleware/optional-auth/index.js"
+    },
     "./body-limit": {
       "types": "./dist/types/middleware/body-limit/index.d.ts",
       "import": "./dist/middleware/body-limit/index.js",
@@ -505,6 +510,9 @@
         "./dist/types/middleware/jwk",
         "./dist/types/middleware/jwk/index.d.ts",
         "./dist/types/middleware/language",
+        "./dist/types/middleware/optional-auth",
+        "./dist/types/middleware/optional-auth/index.d.ts",
+        "./dist/types/middleware/optional-auth/types.d.ts",
         "./dist/types/middleware/logger",
         "./dist/types/middleware/logger/index.d.ts",
         "./dist/types/middleware/method-override",
```

## Intended Flaws

### Flaw 1: Invalid Credentials Are Downgraded To Anonymous, Even On Required Routes

- `type`: `fail_open_auth_boundary`
- `location`: `src/middleware/optional-auth/index.ts:154-181`, `src/middleware/optional-auth/index.test.ts:171-234`, `src/middleware/optional-auth/index.test.ts:251-262`
- `learner_prompt`: What is the difference between no credential and a bad credential?

Expected answer:

- `identify`: `optionalAuth` only rejects the missing-header case when `required: true`. If a request includes an Authorization header but the token is invalid, malformed, expired, or rejected by the strategy, the middleware falls through to `setAnonymous` unless `failureMode: "throw"` is explicitly configured. The tests lock this in: a route configured with `required: true` returns `200` as an anonymous user for `Bearer wrong-token` and malformed `NotBearer abc`.
- `impact`: Protected routes can accidentally fail open. A route that relies on `required: true` for protection, but has guest fallback logic downstream, can serve the guest/public branch instead of rejecting the request. That is a policy bypass, not merely a nicer DX issue. It also breaks security observability: invalid tokens, tampered credentials, expired sessions, and missing credentials collapse into the same anonymous path unless every application opts into `failureMode: "throw"`.
- `fix_direction`: Model three states explicitly: no credential, valid credential, and invalid credential. Optional auth may allow the no-credential case to continue as anonymous, but a present malformed/invalid credential should fail closed by default. `requiredAuth` should be a separate helper or mode that rejects both missing and invalid credentials. If Hono wants a deliberately lenient mode for personalization, make it opt-in with a name like `ignoreInvalidCredentials`, not the default and not active under `required: true`.

Hints:

1. Compare this helper to `jwt`, `bearerAuth`, and `basicAuth`. When do those call `next()`?
2. In the tests, look for `required: true` plus an invalid Authorization header. What status code is expected?
3. "No token" and "bad token" are different security events. A reviewer should not let them share the same default branch.

### Flaw 2: Global Optional `authUser` Erases Route-Specific Auth Guarantees

- `type`: `type_contract_erodes_runtime_boundary`
- `location`: `src/middleware/optional-auth/index.ts:34-35`, `src/middleware/optional-auth/types.ts:47-72`, `src/middleware/optional-auth/types.test.ts:47-65`, `src/middleware/optional-auth/types.test.ts:99-110`
- `learner_prompt`: Does this type tell a handler that auth definitely ran, or only that some package globally declared a maybe-user?

Expected answer:

- `identify`: The PR augments Hono's global `ContextVariableMap` with `OptionalAuthVariables`, where `authUser` is optional and nullable. That makes `c.get("authUser")` and `c.var.authUser` available everywhere, including routes that never install the middleware. `optionalAuth({ required: true })` and `optionalAuth()` both return the same untyped `MiddlewareHandler`, so route handlers cannot know from the type system whether auth ran or whether a user is required. The tests even assert that a route with no middleware can read `c.var.authUser`.
- `impact`: The framework trains users into unsafe auth assumptions. Protected handlers can compile while treating the user as maybe-present, shared helpers can read global `authUser` without declaring an auth requirement, and application authors lose the route-level proof that Hono's generics normally provide. The result is maintainability debt and subtle security bugs: a route can be moved, middleware can be removed, or a helper can be reused outside an auth chain without TypeScript complaining.
- `fix_direction`: Do not globally add an optional user to every context. Export route-specific env types and middleware with distinct type contracts, for example `optionalAuth<TUser>(): MiddlewareHandler<{ Variables: { authUser: TUser | null; authContext: OptionalAuthContext<TUser> } }>` and `requiredAuth<TUser>(): MiddlewareHandler<{ Variables: { authUser: TUser; authContext: RequiredAuthContext<TUser> } }>` or helper factories using `createMiddleware`. Keep optional and required contexts separate, and let users opt into global augmentation only if they deliberately want it.

Hints:

1. Hono's existing type tests in `src/types.test.ts` check that middleware variables are visible only where middleware is chained. Does this PR preserve that?
2. Search for `declare module '../..'`. What does it add to every `Context`, even unrelated routes?
3. Optional route context and required route context should not have the same type.

## Expert Debrief

### Product-Level Change

The PR is trying to make a very common product pattern easier: routes that can personalize for signed-in users while still serving guests. That is useful. Public pages, docs, search, catalog browsing, and preview APIs often need exactly that.

The dangerous part is that optional authentication sits on the boundary between public and private behavior. A tiny convenience helper can change the meaning of every downstream policy check.

### Changed Contracts

- Middleware runtime contract: auth helpers now decide whether credential failures stop the request or continue to route handlers.
- Protected route contract: `required: true` claims to protect a route, but invalid credentials can still reach the handler as anonymous.
- Context contract: `authUser`, `authContext`, `authToken`, and `authError` become framework-recognized context variables.
- Type contract: global `ContextVariableMap` now exposes optional auth variables on every route.
- Package contract: `hono/optional-auth` becomes a public export, and `hono/jwt` re-exports optional-auth helpers.
- Test contract: invalid required-route credentials are documented as `200` anonymous responses instead of `401`.

### Failure Modes

- A protected account route handles `Bearer expired-token` as a guest request and returns public fallback data.
- A write route checks `if (user?.roles.includes("admin"))` and silently skips enforcement instead of rejecting an invalid credential.
- An attacker can use malformed Authorization headers to avoid audit logging attached to authenticated failures.
- A shared route helper reads `c.var.authUser` on a route where auth middleware was never installed.
- A route is refactored out of an auth group, but TypeScript still permits `c.var.authUser` because it is globally declared.
- Application authors cannot distinguish optional personalization context from required authorization context at compile time.

### Reviewer Thought Process

A strong reviewer should ask two questions before accepting an optional-auth helper:

1. What happens when credentials are absent?
2. What happens when credentials are present but bad?

Those are different states. Guest browsing is normal. Invalid credentials are a failed authentication attempt. Existing Hono middleware already treats invalid auth as fatal control flow through `HTTPException`, so a new helper should not casually invert that default.

The reviewer should also trace the type contract. Hono has a strong local-middleware typing story: middleware can contribute `Variables`, and route handlers see those variables only in the relevant chain. A global maybe-user gives up that advantage and leaves reviewers unable to tell which handlers are actually protected.

### Better Implementation Direction

Split the APIs by security meaning:

- `optionalAuth` should allow requests with no credentials to continue as anonymous.
- `optionalAuth` should reject malformed or invalid credentials by default, unless a deliberately named option opts into ignoring invalid credentials.
- `requiredAuth` should be a separate helper that rejects missing, malformed, and invalid credentials.
- The helper should preserve `WWW-Authenticate` headers and status-code behavior consistent with `jwt` and `bearerAuth`.
- Tests should cover no header, malformed header, invalid token, expired token, valid token, and `requiredAuth`.

Split the types by route contract:

- optional routes get `authUser: TUser | null`,
- required routes get `authUser: TUser`,
- routes without the middleware get no `authUser` unless the user explicitly augments `ContextVariableMap`,
- shared helpers should accept a `Context` whose `Variables` prove the auth state they require,
- type tests should assert that unrelated routes cannot read auth variables by accident.

## Correctness Verdict Rubric

- Full credit for flaw 1: The answer identifies that present invalid/malformed credentials are converted to anonymous even when `required: true`, explains protected-route policy bypass and security-observability impact, and proposes fail-closed invalid credentials plus a separate required-auth contract.
- Partial credit for flaw 1: The answer says invalid tokens should be `401` but does not distinguish absent credentials from bad credentials or explain why `required: true` is misleading.
- No credit for flaw 1: The answer focuses on JSON error body formatting, header casing, or token regex trivia without identifying fail-open auth behavior.

- Full credit for flaw 2: The answer identifies global `ContextVariableMap` augmentation with optional `authUser`, explains loss of route-specific proof and unsafe downstream assumptions, and proposes separate optional/required typed middleware without global maybe-user leakage.
- Partial credit for flaw 2: The answer notices `authUser` is nullable but does not connect that to route-local middleware typing or unrelated routes.
- No credit for flaw 2: The answer treats the issue as just "use non-null assertions carefully" or "add better docs."

## Golden Answer Summary

The PR adds a useful optional-auth helper, but it blurs two boundaries that reviewers must protect. Runtime auth collapses invalid credentials into anonymous context by default, even for `required: true` routes, so protected handlers can fail open. Type-level auth globally exposes `authUser?: User | null` on every Hono context, so TypeScript no longer proves that a route installed auth middleware or that required auth produced a real user. A correct implementation would treat absent credentials, invalid credentials, and authenticated users as separate states, fail closed on malformed/invalid credentials, expose a separate `requiredAuth` helper, and preserve route-specific context typing for optional vs required auth.
