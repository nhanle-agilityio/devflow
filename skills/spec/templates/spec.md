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
-->

| Id | Title | Type | Area | Depends on | Size | Needs e2e |
| --- | --- | --- | --- | --- | --- | --- |
| T1 |  | feat |  | - | S | no |

### T1: <task title>

- **Type:** feat | fix | chore | docs | refactor | test
- **Area:** backend | frontend | infra | data | docs
- **Depends on:** none
- **Size:** S | M
- **Needs e2e:** yes | no

**Acceptance criteria**

- [ ] 

**Scope** (files and areas this task may touch)

- 

**Test plan**

- 
