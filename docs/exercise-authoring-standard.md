# Exercise Authoring Standard

Every exercise is a realistic TypeScript PR review case. The learner gets a GitHub-style diff, can jump into relevant files, and answers in free text with required line references.

## Exercise Requirements

Each exercise must include:

- `id`: stable id, for example `TS-042`.
- `title`: short product-level change.
- `source_repo`: one selected repo from the classified dataset.
- `repo_area`: package/module/subsystem used as the review surface.
- `mode`: `synthetic_degraded`, `real_pr_with_review`, or `real_pr_adapted`.
- `difficulty`: 1 to 10.
- `target_diff_lines`: at least 500 lines, increasing through the curriculum.
- `pr_description`: what the PR claims to ship.
- `review_surface`: changed files plus enough unchanged surrounding files to review contracts.
- `changed_contracts`: API, database, event, queue, permission, or service contracts affected by the PR.
- `flaws`: 2-3 intended flaws, depending on PR size and difficulty.
- `golden_direction`: what a strong implementation would do instead.
- `expert_debrief`: the final reveal shown after submission.
- `discussion_chat_contract`: every PR case in the eventual app must include an open chat window below the review case where the learner can ask questions, explore hypotheses, and discuss the PR with the model without reducing credit.
- `progress_persistence_contract`: every PR case in the eventual app must persist the learner's current PR number, answers, hint usage, correctness verdicts, and chat history locally so progress is visible and recoverable without a server account.

## Flaw Object

Each flaw must include:

- `type`: one of the taxonomy values below.
- `location`: file and line range in the degraded PR.
- `learner_prompt`: the question the learner is answering.
- `expected_answer.identify`: what the flaw is.
- `expected_answer.impact`: why it matters in production or future development.
- `expected_answer.fix_direction`: the better implementation shape.
- `hints`: exactly three progressive hints.

Hints are per flaw and do not reduce score. They should move from judgment area to subsystem to near-line evidence:

1. Hint 1: what kind of concern to investigate.
2. Hint 2: which contract or subsystem to inspect.
3. Hint 3: the precise code path or invariant that should make the issue visible.

Every hint must be answerable from material visible in the exercise. If a hint asks the learner to compare against an existing helper, table, route, queue contract, permission boundary, or migration pattern, the relevant signature or contract snippet must appear in `Existing Code Context` or the shown diff. Do not reference repo knowledge that is only implied by the author.

## Flaw Taxonomy

- `contract_mismatch`: the code changes behavior without updating the public/internal contract.
- `tenant_boundary_leak`: organization, workspace, project, environment, or user scoping is incomplete.
- `permission_bypass`: a path skips the central authorization model.
- `unsafe_migration`: schema/data migration can break existing data, deploy order, or rollback.
- `invariant_drift`: business/data invariant is enforced in the wrong place or inconsistently.
- `idempotency_gap`: retrying or replaying work creates duplicate or corrupt state.
- `retry_semantics_bug`: retries hide permanent errors, amplify load, or violate ordering.
- `queue_design_flaw`: job granularity, scheduling, locking, or concurrency is wrong.
- `event_contract_flaw`: event shape, versioning, ordering, or deduplication is wrong.
- `backpressure_gap`: ingestion accepts work faster than downstream systems can process it.
- `consistency_gap`: read/write path exposes stale, partial, or impossible states.
- `performance_regression`: implementation scales poorly on realistic data volume.
- `observability_gap`: failure cannot be diagnosed because logs/metrics/traces are missing or misleading.
- `abstraction_misfit`: new abstraction hides important domain distinctions or creates wrong coupling.
- `ownership_boundary_violation`: module/service owns logic or data that belongs elsewhere.
- `rollout_risk`: PR lacks backward compatibility, migration staging, or feature-flag strategy.
- `test_confidence_gap`: tests pass while missing the actual behavioral contract.

## Expert Debrief Shape

After submission, show a correctness verdict for each intended flaw, then the expert explanation:

- Product-level change: what the PR was trying to ship.
- Changed contracts: API, database, event, queue, permission, or service contracts that moved.
- Failure modes: what can break under scale, retries, concurrency, partial deploys, bad data, or future changes.
- Reviewer thought process: what a strong reviewer would inspect first, which questions they would ask, and what evidence would confirm the concern.
- Better implementation direction: not a full patch, but enough to teach the architectural move.

The final explanation must compare thought process, not only text. The learner should see how an expert decomposed the PR.

## Discussion Chat Contract

Every exercise page in the app must include an open model discussion chat below the PR case. This is part of the training product, not an assessment escape hatch. The chat should help the learner ask clarifying questions, explore tradeoffs, test review hypotheses, and discuss the PR after or during their review.

The chat must preserve the curriculum goal: it should guide thinking about product-level change, changed contracts, failure modes, and fix direction rather than simply reveal the answer by default. Hints remain the explicit progressive reveal mechanism; chat is for Socratic discussion and deeper learning.

## Progress Persistence Contract

The eventual app must include a top menu button that opens curriculum progress. The menu should show which PR exercise the learner is currently on, completion state across all 100 PRs, submitted answers, correctness verdicts, hint usage, and saved discussion chats.

All learner state should persist in browser local storage for the initial product: current PR number, draft answers, submitted answers, line references, per-flaw verdicts, revealed hints, expert debrief visibility, and chat messages. This is training, not assessment, so persisted hint usage is for continuity and reflection rather than penalty.
