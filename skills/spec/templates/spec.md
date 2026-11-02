# <Title>

<!-- File: <specDir>/<YYYY-MM-DD>-<slug>.md. Mocks and diagrams go in <specDir>/<slug>/. -->

- **Status:** draft
- **Date:** <YYYY-MM-DD>
- **Slug:** `<slug>`

## Problem

<!-- Who is affected, what hurts today, and why it matters now. Current behaviour in one paragraph. -->

## Goals

<!-- Outcomes a user or operator can observe. -->

- 

## Non-goals

<!-- What this spec deliberately does not do. Deferred items from the grill session go here with a reason. -->

- 

## Decisions

<!-- One row per question settled during the grill session. Keep the answer and the reason. -->

| Question | Decision | Why |
| --- | --- | --- |
|  |  |  |

## Design

<!-- Include only the subsections that apply. Be concrete enough that a task can be implemented without asking. -->

### API contracts

<!-- For each endpoint or function: method + path, request, response, error cases and status codes. -->

### Data model

<!-- New or changed entities, fields, constraints, migrations, backfill. -->

### UI

<!-- Screens, states (loading, empty, error, success), copy, accessibility. Link mocks stored in <specDir>/<slug>/. -->

### Other areas

<!-- Infra, jobs, configuration, observability, permissions. -->

## Risks and unknowns

<!-- What could go wrong, what is still unknown, and how each is mitigated or who will answer it. -->

- 

## Tasks

<!--
One block per task. Rules:
- Ids are stable: T1..Tn. Never renumber after the spec PR is merged.
- Size S or M only. Split anything bigger.
- Acceptance criteria are checkable behaviour. API: request -> response. UI: user action -> visible result.
- Every task has a test plan. needs-e2e is "yes" when the task changes a user-visible flow that needs the running app to verify.
- depends-on lists task ids; the issue creation step turns them into issue numbers.
- Risk is low or high with a one-line reason, judged against risk.highWhen / risk.highPaths in the config. Unsure means high.
- Hotspots: files likely to be touched by other tasks too (routes, registries, schema, shared config). `/devflow:dispatch` puts tasks sharing a hotspot in one lane.
-->

| Id | Title | Type | Area | Depends on | Size | Needs e2e | Risk | Risk reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 |  | feat |  | - | S | no | low |  |

### T1: <task title>

- **Type:** feat | fix | chore | docs | refactor | test
- **Area:** backend | frontend | infra | data | docs
- **Depends on:** none
- **Size:** S | M
- **Needs e2e:** yes | no
- **Risk:** low | high - <one-line reason>
- **Hotspot files:** <files other tasks are likely to touch too, or none>

**Acceptance criteria**

- [ ] 

**Scope** (files and areas this task may touch)

- 

**Test plan**

<!-- With the QA step on: "Test cases: T1.1-T1.n (see Test matrix)", plus any note the matrix cannot hold (fixtures, data setup). Without it: the tests that prove the criteria. -->

- 

## Test matrix

<!--
Written by the QA step (spec.testMatrix). The QA agent sees only the tasks and their acceptance
criteria, not the grill session, and writes one row per test case:
- Id: <task>.<n>, stable once the spec PR is merged. Escape a | inside a cell as \|.
- Case: happy | error | edge | boundary.
- Given / When / Then: concrete inputs and the observable result (status and body, or what the user sees).
- Level: unit | integration | http | e2e. http and e2e rows are also walked by the verify stage.
- Priority: must (a test is required before the PR opens) | should (nice to have).
Every acceptance criterion is covered by at least one must row. Criteria the QA agent could not turn into a
test were resolved with the user before this table was written; anything still open is listed under
Risks and unknowns.
Tests are named test_t<task>_<n>_<description> (e.g. test_t1_2_duplicate_name_returns_409) or carry a comment `# T1.2`.
-->

| Id | Task | Criterion | Case | Given / When / Then | Level | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| T1.1 | T1 |  | happy |  | http | must |
