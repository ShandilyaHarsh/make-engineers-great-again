# Make Engineers Great Again

This repository is the curriculum workspace for a PR-review training product.

The product is aimed at engineers with roughly 3+ years of experience who want to become exceptional at understanding and reviewing large TypeScript code changes. The app itself can come later. The first-class asset is the curriculum: 100 realistic PR review exercises that train engineering judgment, not syntax trivia.

## Current Artifacts

- [Source repo classification](docs/repo-classification.md): the initial dataset of high-quality TypeScript-heavy repositories to mine or mutate.
- [Exercise authoring standard](docs/exercise-authoring-standard.md): the schema every PR review exercise must satisfy.
- [100 exercise map](curriculum/100-exercise-map.md): the curriculum-first blueprint for 100 separate PR review exercises.
- [Exercise authoring status](curriculum/exercises/README.md): the current learner-ready exercise count and next authoring queue.
- [Structured exercise JSON](public/exercises/index.json): committed app-readable exercise data generated from the Markdown curriculum.

Current curriculum status: 100 blueprint exercises, 100 learner-ready drafts, 0 full exercises remaining.

## Software App

This repo now includes a deployable-later Next.js training app around the curriculum.

Run locally:

```bash
npm install
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Useful commands:

```bash
npm run generate:exercises
npm run typecheck
npm run build
```

The app reads committed JSON files from `public/exercises`. Regenerate them after editing Markdown exercises:

```bash
npm run generate:exercises
```

Verifier/chat configuration:

- Without `OPENAI_API_KEY`, submissions reveal golden answers and mark verdicts as `unverified`.
- With `OPENAI_API_KEY`, `/api/verify` grades each flaw independently and returns one overall verdict.
- Copy `.env.example` to `.env` and set the key when ready.

## Product Thesis

AI makes it easy to ship 4,000-line PRs that look plausible. The missing skill is not "can you spot a missing semicolon?" It is:

- Can you understand what changed at the product level?
- Can you identify which contracts changed?
- Can you predict failure modes before production finds them?
- Can you tell when an implementation works today but makes the system worse tomorrow?
- Can you explain the flaw, its impact, and the shape of a better fix?

Every exercise should train one or more of those muscles.

## Out Of Scope For The Curriculum

- UI-only changes.
- Billing-specific flows.
- Syntax trivia or framework trivia.
- Formatting, naming, and style nits unless they hide a real system problem.
- Tiny bug hunts that can be solved without understanding the surrounding system.
