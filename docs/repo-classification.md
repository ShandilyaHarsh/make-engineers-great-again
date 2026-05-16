# TypeScript Source Repo Classification

Snapshot date: 2026-05-16 local time.

This is the initial source dataset. A repo can be used in two ways:

- `exercise_base`: we create or adapt realistic degraded PRs inside this codebase.
- `reference_base`: we mine patterns, contracts, and failure modes from it, but may not use it directly for a full exercise.

Selection favors TypeScript-heavy backend/full-stack SaaS systems with real product complexity: APIs, database state, event ingestion, queues, auth, permissions, migrations, observability, and multi-tenant boundaries. UI-only surfaces and billing-specific flows are intentionally excluded.

## Quality Rubric

Repos should score well on:

- Mature product domain with real users and real operational pressure.
- TypeScript-heavy code, especially backend or full-stack service code.
- Clear domain boundaries: API layer, data layer, jobs, events, auth, or permissions.
- Enough size and history to support 500-4,000+ line PR exercises.
- Good public docs, contribution flow, tests, and release hygiene.
- Non-trivial contracts that a reviewer must understand before approving a PR.

## Primary Exercise Bases

| Repo | Use | Why It Belongs | Best Exercise Surfaces |
|---|---:|---|---|
| [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev) | exercise_base | TypeScript workflow platform with long-running tasks, retries, queues, observability, and scaling. | task lifecycle, queues, retry semantics, worker/runtime boundaries, event delivery |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | exercise_base | LLM observability product with ingestion, traces, metrics, datasets, API surface, and self-hosting complexity. | ingestion contracts, trace/event storage, API versioning, ClickHouse/Postgres boundaries, retention |
| [Infisical/infisical](https://github.com/Infisical/infisical) | exercise_base | Security SaaS with secrets, certificates, privileged access, org/project boundaries, and audit-sensitive flows. | auth, permissions, secret lifecycle, audit logs, environment scoping, safe migrations |
| [novuhq/novu](https://github.com/novuhq/novu) | exercise_base | Notification infrastructure with workflow engine, multi-channel delivery, providers, queues, preferences, and digest behavior. | workflow execution, message state, idempotency, queue concurrency, provider failure handling |
| [directus/directus](https://github.com/directus/directus) | exercise_base | Data/API platform that turns SQL databases into APIs with auth, permissions, schema introspection, and extensions. | permission evaluation, query shaping, schema metadata, migrations, REST/GraphQL contract design |
| [medusajs/medusa](https://github.com/medusajs/medusa) | exercise_base | Modular commerce backend with rich domain primitives, service boundaries, workflows, inventory/order state, and extensibility. | module boundaries, workflow steps, data invariants, API contracts, transaction boundaries |
| [payloadcms/payload](https://github.com/payloadcms/payload) | exercise_base | Full TypeScript backend/admin framework with auth, access control, schema-driven APIs, adapters, and extensibility. | access control, collection schema contracts, adapters, hooks, data consistency |
| [calcom/cal.diy](https://github.com/calcom/cal.diy) | exercise_base | Large scheduling app with backend-heavy booking, availability, teams/orgs, calendar state, and tRPC/Prisma patterns. | booking invariants, availability calculation, team/org boundaries, API contracts, migrations |

## Secondary Exercise Or Reference Bases

| Repo | Use | Why It Belongs | Best Exercise Surfaces |
|---|---:|---|---|
| [unkeyed/unkey](https://github.com/unkeyed/unkey) | exercise_base | Modern API platform with API keys, rate limiting, permissions, analytics, gateways, and control-plane/data-plane tension. | API key verification, rate-limit consistency, RBAC, analytics ingestion, gateway contracts |
| [prisma/prisma](https://github.com/prisma/prisma) | reference_base | High-quality reference for database modeling, generated clients, migration ergonomics, and TypeScript contract design. | schema evolution, generated contract changes, migration safety, client/runtime boundaries |
| [drizzle-team/drizzle-orm](https://github.com/drizzle-team/drizzle-orm) | reference_base | Lean TypeScript ORM with schema-first SQL modeling and strong type-safety tradeoffs. | schema declarations, migration generation, query builder contracts, type/runtime mismatch |
| [trpc/trpc](https://github.com/trpc/trpc) | reference_base | End-to-end typesafe API design reference, especially around contracts, errors, batching, and subscriptions. | API boundary contracts, type-only coupling, batching semantics, version/compatibility risk |
| [honojs/hono](https://github.com/honojs/hono) | reference_base | Small, fast, multi-runtime TypeScript web framework with strong API discipline and runtime portability. | middleware contracts, runtime assumptions, request context, edge/serverless portability |
| [nestjs/nest](https://github.com/nestjs/nest) | reference_base | Backend architecture reference for modular services, dependency injection, and scalable server-side TypeScript. | module boundaries, DI contracts, lifecycle hooks, adapter boundaries |
| [temporalio/sdk-typescript](https://github.com/temporalio/sdk-typescript) | reference_base | Durable workflow reference for long-running async logic, activities, replay, worker isolation, and versioning. | workflow determinism, activity retries, durable execution, worker/client boundaries |
| [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq) | reference_base | Queue and batch-processing reference with Redis-backed atomicity, job states, retries, events, and parent-child flows. | queue atomicity, job lifecycle, lock/concurrency behavior, retry and event semantics |

## Deferred Or Excluded

- Frontend/UI libraries and design systems: not aligned with this curriculum.
- Billing-heavy examples: explicitly out of scope for now.
- Integration catalog PRs: often become provider-specific trivia rather than engineering fundamentals.
- Tiny framework/library bug fixes: useful for maintainers, but weaker for training large-PR review judgment.

## Dataset Construction Strategy

1. Start with synthetic degraded PRs in primary exercise bases. This gives us control over the flaw and the expert answer.
2. Mine real PRs with meaningful review comments from the same repos, but only keep cases where the lesson is fundamental and transferable.
3. Use reference bases to sharpen flaws: for example, a Langfuse ingestion exercise can borrow expected reasoning from Temporal/BullMQ retry discipline or Prisma/Drizzle migration discipline.
4. Reject cases where the answer is mainly "know this obscure library behavior."
5. Each accepted case must teach a reusable review question an engineer can apply to their own 4,000-line AI-generated PRs.
