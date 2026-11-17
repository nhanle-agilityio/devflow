# Wave 2: lighter flow (epic specs, short path, optional GitHub review)

- **Status:** draft
- **Date:** 2026-11-17
- **Slug:** `wave2-lighter-flow`

## Problem

Running Wave 1 through devflow 2.9.0 showed where time and agent calls go without adding accuracy:

1. The spec PR is a wait and a review loop: the Wave 1 spec PR took several rounds of GitHub review comments, and no issue exists until it merges.
2. The GitHub review (`devflow-review.yml`, status `devflow/review`) repeats the engine's local Review stage (same model, fresh context in both) and produces comment → fix → new comment loops on task PRs.
3. A `risk:low` issue runs the same pipeline as a risky one (Plan, Verify included).
4. Two Wave 1 issues stopped mid-run for a decision that could have been asked while writing the spec.
5. There is no per-issue data (path, review rounds, blocks, duration), so improvements cannot be measured.
6. Branches of merged PRs are left behind: only the merge gate deletes the remote head branch after its own merges; human merges leave it, and local branches and worktrees stay in every case.

Today: `/devflow:spec` writes `docs/specs/<date>-<slug>.md`, opens a spec PR, waits for the merge, then creates issues labelled `agent:ready`. The engine finds the spec through the first `<specDir>/<name>.md` path in the issue body (`specPathFor`). The engine runs Claim → Branch → Plan → Implement → Check → Verify (when needed) → Review → Risk → Ship for every issue. The review workflow always reviews; the gate's `mergeGate.requiredChecks` defaults to `["devflow/review"]` and trusts that status only when `github-actions[bot]` created it.

## Goals

- `/devflow:spec` creates one epic issue and one native sub-issue per task by default; no spec PR, no merge wait. A human approves each sub-issue by setting `agent:ready`.
- `/devflow:spec --file` keeps the 2.9.0 behaviour.
- With `review.github: false` (the new default) the GitHub review makes no Claude call and the merge gate relies on the project's CI checks; it never merges with zero required checks.
- A `risk:low` issue runs the short path (no Plan, no Verify) and keeps test-first, checks, local Review, Risk and Ship.
- Every PR body records the path taken and the local review verdict; `/devflow:report` shows path, review rounds, times blocked, duration and who merged.
- `/devflow:doctor --fix` removes the remote branch, local branch and worktree of merged devflow PRs after one confirmation.
- Released as 3.0.0. Humans keep every decision they have today: approving the spec, setting risk, merging `risk:high`, publishing the release.

## Non-goals

- Parallel lanes, changelog fragments per task, an end-to-end smoke run before release, follow-up issue hygiene (Wave 3).
- Installing or requiring the `gh` CLI.
- Any change to who merges, to the guard hook, or to priority ordering.
- New commands, timers, cron or background processes.
- New config keys other than `review.github`.
- Changing the reusable workflows' inputs or secrets.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Default of `review.github` for existing projects on upgrade | `false` everywhere. `/devflow:init --upgrade` offers `review.github: true` as one item when the project has the review workflow installed; the CHANGELOG upgrade note says so. | One default; the owner opts back in explicitly. |
| Version | 3.0.0. | Two defaults change (spec mode, GitHub review). |
| How the review workflow learns the flag | It reads `.claude/devflow.json` through the API with the same lookup as the gate's `loadConfig`: the copy on the repository default branch only to learn `baseBranch`, then the file at `baseBranch`, which wins; any failure to read the `baseBranch` copy (404 included) falls back to the default-branch copy, exactly as the gate does. Never the PR head. No readable copy, or `review.github` not `true`: off; when no copy could be read a warning goes to the run log. | One source of truth; a PR cannot switch off its own review. A read error fails safe for the gate (no status → no merge). |
| Review off: what the workflow does | The job still runs and completes; a first step reads the flag and every later step is skipped. No `devflow/review` status (not even pending), no Claude call. The step summary says `devflow review is off (review.github is not true)`. | The gate still wakes on the review workflow's `workflow_run`; no token spent. |
| Gate with the flag off | Effective required checks = `mergeGate.requiredChecks` without `devflow/review` when the flag is off, the list as is when it is on. Whenever the effective list is empty (flag off with only `devflow/review`, or `[]` with either flag value) the gate changes nothing (no update, relabel, conflict block or merge) and reports every candidate as `skipped` with the reason `no required checks (devflow/review is ignored while review.github is off); refusing to merge`. The bot-creator rule for `devflow/review` stays. | Never merge with zero required checks; one rule. Closes today's gap where `[]` merged with no check. |
| Gate wake-up | No change: callers keep `workflow_run` on the CI workflows and "Claude Code Review", plus `status` and `workflow_dispatch`. | A skipped review still completes its run, and CI runs wake the gate. |
| Accepted trade-off of the flag off | With `review.github: false` no independent party confirms the review. A PR opened by hand (no `devflow` label) gets no review and is never a gate candidate; the owner runs a local review (`devflow:reviewer`). README and DESIGN state this. | Cost and loops versus an independent check; owner's choice per project. |
| Short path | An issue takes the short path when, at run start, its labels include `labels.riskLow`, do not include `labels.riskHigh` or `labels.e2e`, and its body has no Test cases row with level `http` or `e2e`. Then: no Plan agent (no plan comment), no Verify. One implement agent writes the failing test first, then the change (the parallel QA agent needs Plan's `qaFiles`). It keeps Check with its fix rounds, Review (scan + reviewer, `maxReviewRounds`), Risk and Ship. Every other issue (`risk:high`, both risk labels, no risk label, e2e label, http/e2e row): full path as today. A UI change found only during Implement (`touchesUi`) does not run Verify on the short path; the PR says `Verify: skipped (short path)`. | Fewer agent calls for low-risk work, same guarantees on tests and review; work that needs the running app keeps Verify. |
| Short path escalated to high by the Risk step | Verify does not run after the fact. The PR is `risk:high`; its body says `Verify: skipped (short path)` when Verify would have been needed, else `Verify: not needed`; the human who merges sees it. | Risk runs after Verify; going back a stage adds a special case. |
| Issue without spec or epic | The issue body alone is the contract, as today. | The bug template already carries criteria and test cases. |
| How the engine finds the epic | Each sub-issue body has the line `Epic: #<n>` (first match of `^Epic: #(\d+)` per line). Source rule: a spec path in the body → the spec file (as today); else an `Epic:` line → the epic issue; else the issue alone. Stages read the epic with the GitHub MCP (`issue_read`); the `devflow:reviewer` agent reads it with `gh issue view <n> --repo <owner>/<repo> --json title,body` (default agent when `ghCli` is false, as for the issue). `specRead` must contain `#<n>` as a whole token (not followed by a digit). The stages that read the epic return `epicRead` (boolean); `false` (epic missing, closed, a pull request or unreadable) blocks the issue with the reason `epic #<n> could not be read`. The sub-issue's criteria and Test cases are the contract; the epic gives shared design and decisions; where the sub-issue's `## Decisions` and the epic's differ, the sub-issue wins. The native sub-issue link is created but the engine does not depend on it. | Same pattern as `specPathFor`; no dependency on a sub-issue API in every stage. |
| Epic lifecycle | `/devflow:accept` and `/devflow:report` take `#<epic>` as well as a spec path or slug. Accept posts its result as one comment on the epic (edited in place on re-run). A human closes the epic; no skill closes it. | The human owns the epic. |
| QA test matrix vs the spec review (Q2) | Both stay, QA first. The QA step writes the rows and lists untestable criteria and missing cases (at most 2 rounds, as today). The spec review then checks the draft only against the user's brief: missing requirements, contradictions, tasks that claim independence but are not. It does not judge testability. | No duplicated work. |
| Spec review model | A fresh general-purpose agent with `spec.qaModel` (default `opus`); no new config key. | Reuse the existing setting. |
| Spec review rounds | Only critical findings start a round (the skill fixes the draft and runs the review again). At most 2 reviewer calls in total (the first review plus one after a fix); after the second the remaining critical findings are listed to the user, who decides (proceed or stop). Warnings and suggestions are reported once and never start a round. Runs in both modes, before creating issues or opening the spec PR. | Bounded cost; the owner decides on the rest. |
| Open questions during spec creation | The grill continues until no question is open; every answer goes into `## Decisions`. Issues are not created while a question is open unless the user defers it; a deferred question is written into an `## Open questions` section of each affected sub-issue (in `--file` mode also into the spec's Risks and unknowns, and the issues created after the merge get the same section). | The human sees it before setting `agent:ready`. |
| Issue template | One `skills/spec/templates/issue.md` for both modes; its Context line holds the spec link (`--file`) or `Epic: #<n>` (epic mode). | One template to keep in sync. |
| Sub-issue labels | Risk label (`labels.riskLow` / `labels.riskHigh`), `type:<type>`, `labels.e2e` when needed. Never `labels.ready`. The epic gets `type:epic` and no ready or risk label. | Approval is the human setting ready per sub-issue; the engine only picks ready issues. |
| Body size | Every epic and sub-issue body is built and measured (JavaScript string `length`, with issue numbers filled in at their widest expected width) before anything is created. Any body over 65,000 characters: create nothing, tell the user to run `/devflow:spec --file`. Never truncate. | GitHub's limit is 65,536; all-or-nothing keeps re-runs simple. |
| Draft location in epic mode | The draft is a scratchpad file (spec template structure). The QA and spec review agents read that file. It is not committed. | No spec file in the repository in epic mode. |
| Idempotent issue creation | Before creating, search issues (open and closed) by exact title (trimmed, case-sensitive); reuse what exists and leave its body as it is; skip a link that already exists. Create the epic first, sub-issues in dependency order, link each with `sub_issue_write` (method `add`), then update the epic's task list with the numbers. | Re-running after a partial failure is safe (as today). |
| Changes after approval (E3) | One rule in both modes: decisions are appended to `## Decisions` with a date, never by rewriting earlier text. `/devflow:answer` appends to the sub-issue and, when the issue has an `Epic:` line, also to the epic (with the sub-issue number). It no longer edits criteria or Test cases rows in the issue (the "(updated by /devflow:answer)" edit is removed). In epic mode it opens no PR. With a spec file (`--file` mode) it still opens the small spec PR, but that PR only appends to the spec's `## Decisions` (no rewrite of criteria, design or other sections). Entries: `- <YYYY-MM-DD> (Q<k>): <question> → <answer>` in the issue and `- <YYYY-MM-DD> (#<issue>, Q<k>): <question> → <answer>` in the epic (`Q<k>` numbered as in that questions comment); a missing `## Decisions` section is created at the end of the body; a failed append to the epic is reported, not rolled back. | Nothing overwrites the approved text; agents never edit criteria. |
| Review trace at Ship | The engine fills the values in the Ship prompt (Ship only runs after a passing review, since leftover findings block). The PR body gets a `## Review` section with `Review: pass after <n> round(s) - local devflow reviewer in this run (GitHub review: off \| on)` and `Path: short (Plan and Verify skipped) \| full`, plus `Verify: ran \| skipped (short path) \| not needed \| could not run`. Always, not only when the flag is off. | A trace in every PR. |
| Metrics markers (M1) | Ship writes one hidden line in the PR body: `<!-- devflow-run {"path":"short\|full","reviewRounds":<n>,"claimedAt":"<ISO>"} -->`. `claimedAt` is the `createdAt` of this run's winning claim comment (the claim agent already returns it), or `null` when not available. Exactly one comment per block contains `<!-- devflow-blocked -->`: the questions comment when there are questions (as its second line; its first stays `<!-- devflow-questions -->`), otherwise the reason comment. The report uses the merged PR that closes the issue (else the latest one), counts the comments with the blocked marker (= blocks), takes duration from `claimedAt` to `merged_at` in hours with one decimal, and who merged by the existing gate marker rule; missing data is `unknown`. The trace page shows five metrics (path, review rounds, times blocked, duration, merged by); `claimedAt` and `mergedAt` are in the data only. | The GitHub MCP has no issue-timeline read and claim comments are deleted on block, so the run records its own claim time. Duration covers the run that shipped. |
| Branch cleanup (B1) | `/devflow:doctor` lists leftover branches of merged devflow PRs (remote head branch, local branch, worktree). `--fix` asks one confirmation for the whole list. Each item is re-checked just before deletion: `merged_at` set, no open PR has the branch as its base or its head, not `baseBranch` and not in `protectedBranches`, not the current branch, and (for a worktree) not the directory doctor runs in. The remote is `github.remote` (default `origin`). Without `--fix` doctor only lists. Worktree: `git worktree remove` (no `--force`; dirty → kept and reported). Local: `git branch -d` only (refusal → print `git branch -D <branch>` for the user). Remote: `git push <remote> --delete <branch>`. The guard is unchanged. Branches of PRs closed without merging keep today's per-branch yes. | One rule; destructive git stays blocked for Claude. |
| Accept issue set | `/devflow:accept <n>` or `#<n>`: a number is always an issue number. The issues are the union of the epic's native sub-issues and issues whose body has `Epic: #<n>`. Gap titles use the slug from `[<slug>]` in the epic title, else `[epic #<n>]`. An issue with no sub-issues and no issue referencing it stops with `#<n> is not an epic`. | Robust when a link failed. |
| Repository "Automatically delete head branches" | README recommends it. Doctor reports it as `warn` when off, only when it can read the setting (`gh api repos/<owner>/<repo> --jq .delete_branch_on_merge`); otherwise it reports `unknown` and moves on. | No `gh` requirement. |
| Hotspots | Code and skill files only. DESIGN.md, README.md, CHANGELOG.md, `docs/devflow-flows.html`, `tests/docs.test.cjs` and `tests/skills.test.cjs` (append-only) are not hotspots; `/devflow:sync` resolves their conflicts. | Listing them would force every task into one lane. |
| CHANGELOG | Each task adds its entry under `## [Unreleased]` citing its issue number; the release task moves them to `3.0.0` and writes the upgrade note. | Keep a Changelog. |
| Tests for prompt and skill text | Deterministic code (gate script, engine logic, `bin/`) gets behaviour tests. Skill and prompt text gets only contract-point asserts a later stage depends on (marker strings, the `Epic:` line, flag names), never wording. | Brief constraint. |

- 2026-11-17 (#52, Q1): QA commit e669dc2 changed the fixture in 'minimalConfig does not change its input' (tests/setup.test.cjs) from `checks: []` to a non-empty `checks`, which the issue does not ask for; and should 33d5b4a be split into feat(#52) and docs(#52) commits? → Restore the fixture to `checks: []` with a new commit `test(#52)`; if that test then fails, report it as a finding and do not adapt the fixture. Do not rewrite or split 33d5b4a: no history rewrite and no force push; the docs stay in that commit.

## Design

### Config

New optional key in `skills/init/templates/devflow.schema.json` and the annotated `skills/init/templates/devflow.json`:

```json
"review": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "github": { "type": "boolean", "default": false, "description": "Run the GitHub review workflow (status devflow/review). false: the engine's local Review stage is the only review and the merge gate relies on the remaining mergeGate.requiredChecks." }
  }
}
```

Existing configs stay valid. Only `github === true` turns the review on.

### Review workflow (`.github/workflows/devflow-review.yml` and `skills/init/templates/github/workflows/claude-code-review.yml`, jobs kept identical)

New first step `flag` (actions/github-script): resolve the config as the gate does (default-branch copy for `baseBranch`, then the file at `baseBranch`), set output `enabled` to `'true'` only when `review.github === true` in the resolved config; when not, write the step summary line and return. Every existing step gets `steps.flag.outputs.enabled == 'true'` added to its condition (including the pending status step and the `always()` publish step). Inputs, secrets and permissions unchanged.

### Merge gate (`skills/init/templates/github/scripts/devflow-merge-gate.cjs`)

- `withDefaults` adds `review: { github: false, ...c.review }`.
- New exported `effectiveRequiredChecks(config)`: `config.review.github === true ? requiredChecks : requiredChecks.filter((n) => n !== 'devflow/review')`.
- In `gate()`, after loading the config and listing candidates: if the effective list is empty (whatever the flag), push one `skipped` row per candidate with the refusal reason and write the summary; no other call. Otherwise `evaluate` uses the effective list in `checksGreen`.

### Engine (`workflows/next-task-engine.js`)

- `pathFor(issue)`: `'short'` when `issue.labels` contains `labels.riskLow` and neither `labels.riskHigh` nor `labels.e2e`, and `hasHttpOrE2eRow(issue.body)` is false; else `'full'`. Decided once at run start.
- Short path: skip the Plan agent and its checks; implement with the non-parallel branch and plan text `none (short path: no plan stage)`; skip the Verify block (record `state.verify = 'skipped (short path)'` when `needsVerify` would be true, `'not needed'` otherwise).
- `epicFor(issue)`: the number from the first line matching `^Epic: #(\d+)`, or 0. Source rule as in Decisions. Prompts that today say "read the spec" get an epic variant: read epic `#<n>` (MCP `issue_read` method `get`; the reviewer: `gh issue view`), shared design and decisions from it, criteria and Test cases from the sub-issue, the sub-issue's Decisions win. `readSpec` for an epic checks `specRead` contains `#<n>` as a whole token. The Plan, Implement, QA, Fix and Review schemas gain `epicRead` (boolean); `false` blocks with `epic #<n> could not be read`.
- Result entry gains `path` and `reviewRounds` (number of reviewer calls that ran; Review always runs before Ship).
- Ship prompt: the `## Review` section and the `devflow-run` marker (Decisions), `claimedAt` from this run's winning claim.
- Blocked prompt: exactly one comment per block contains `<!-- devflow-blocked -->` (the questions comment, else the reason comment).

### Spec skill (`skills/spec/SKILL.md`)

Argument: the idea or a brief path, optionally `--file`.

Epic mode (default):
1. Analyse (as today).
2. Grill until nothing is open; deferrals only on the user's explicit word.
3. Draft in the scratchpad (`<slug>.draft.md`, spec template structure, tasks as today).
4. QA test matrix (as today, on the draft).
5. Spec review (Q2).
6. Build all bodies; size check (65,000).
7. Create the epic (template `skills/spec/templates/epic.md`: Goal, Design, `## Decisions`, Tasks table with id, title, risk with reason, depends-on, issue number), then sub-issues in dependency order (template `issue.md` with `Epic: #<n>` in Context instead of the spec link; `## Open questions` only when a deferral exists), link them with `sub_issue_write`, update the epic's Tasks table with the numbers.
8. Final message: table of task id, issue number, title, risk; and that the human approves each sub-issue by setting `labels.ready`.

`--file` mode: the 2.9.0 steps (spec file, spec PR, Gate 1, issues with `labels.ready` after merge), with the spec review inserted before the spec PR.

### Answer, accept, report, doctor, init

- `/devflow:answer`: append-only Decisions (sub-issue, plus epic when linked); epic mode opens no PR; issue criteria and rows are never edited.
- `/devflow:accept #<epic>`: the sub-issues are the issues (native sub-issues of the epic, else issues whose body has `Epic: #<n>`); criteria and http/e2e rows come from each sub-issue; the `<!-- devflow-accept -->` comment goes on the epic; gap titles use the epic's slug.
- `/devflow:report #<epic>`: same issue set; JSON gains `spec.epic` (`{ "number", "url" }` or `null`) and per issue `metrics`: `{ "path": "short|full|unknown", "reviewRounds": <int>|null, "blocked": <int>, "claimedAt": "<ISO>"|null, "mergedAt": "<ISO>"|null, "durationHours": <number>|null, "mergedBy": "gate|human|unknown" }`. The trace template shows them; `null` renders as "unknown". Review rounds: from the `devflow-run` marker, else today's verdict-marker count, else `null`.
- `/devflow:init`: asks `review.github` (explains the trade-off; default false); proposes `devflow/review` in `requiredChecks` only when it is true; warns whenever `mergeGate.enabled` is true and the effective required list is empty (whatever the flag). `--upgrade` offers `review.github: true` as one item when the review workflow is installed.
- `/devflow:doctor`: check 1 gives the same warning; check 5 implements B1; a new line reports the "Automatically delete head branches" setting.

### Docs

Each task updates what it makes stale: README.md, DESIGN.md, CHANGELOG.md (`[Unreleased]`), `docs/devflow-flows.html` (EN and VI), the schema and the example config.

## Risks and unknowns

- Several tasks change `workflows/next-task-engine.js` (T4, T5, T6): they share hotspots and run in one lane.
- T1 and T2 change reusable workflow behaviour for every project at the 3.0.0 tag; the major version and the upgrade note cover it. Inputs and secrets stay compatible.
- This repository's own config has `devflow/review` plus two CI checks in `requiredChecks` and no `review.github`: after 3.0.0 its gate relies on the two CI checks (gate is disabled here anyway).
- Native sub-issue support: if `sub_issue_write` fails (for example on a plan without sub-issues), the `Epic:` line still links them; the skill reports the failed links and continues.
- Duration covers only the run that shipped; earlier blocked runs are not counted (Decisions).
- With the flag off nobody independent confirms the review (accepted trade-off).
- Skill and prompt behaviour (create-nothing on oversize bodies, idempotent re-runs, one confirmation in doctor, read-only report, never closing the epic, never setting `labels.ready`) is covered only by contract asserts, per the brief; it is checked by hand when the skills are first run on this repository.
- T13's `risk:high` label and "tag only after a human merge" are release checklist steps, not automated tests.

## Tasks

| Id | Title | Type | Area | Depends on | Size | Needs e2e | Risk | Risk reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | `review.github` config key and the review workflow skips when it is off | feat | infra | - | M | no | high | touches .github/** and skills/init/templates/github/** (highPaths) |
| T2 | Merge gate uses CI checks when the GitHub review is off | feat | infra | T1 | S | no | high | touches skills/init/templates/github/** (highPaths) |
| T3 | Init and doctor: review flag prompt, upgrade offer, empty-checks warning | feat | docs | T1, T2 | S | no | low | skill text only, no highPaths file |
| T4 | Engine short path for risk:low issues | feat | backend | - | M | no | low | engine logic, no highPaths file |
| T5 | Ship records the review trace and run markers; block comments carry a marker | feat | backend | T4 | S | no | low | engine prompts, no highPaths file |
| T6 | Engine and reviewer read the epic as the spec source | feat | backend | - | M | no | low | engine prompts and reviewer agent text, no highPaths file |
| T7 | `/devflow:spec` creates an epic and sub-issues by default; `--file` keeps the spec PR | feat | docs | - | M | no | low | skill text and templates, no highPaths file |
| T8 | `/devflow:spec` closes open questions and runs one local spec review | feat | docs | T7 | S | no | low | skill text only, no highPaths file |
| T9 | `/devflow:answer` appends decisions only and opens no PR in epic mode | feat | docs | T7 | S | no | low | skill text only, no highPaths file |
| T10 | `/devflow:accept` takes an epic | feat | docs | T7 | S | no | low | skill text only, no highPaths file |
| T11 | `/devflow:report` takes an epic and shows per-issue metrics | feat | frontend | T5, T7 | M | no | low | skill text and trace template, no highPaths file |
| T12 | `/devflow:doctor` cleans up branches of merged devflow PRs | feat | docs | T3 | S | no | high | deletes remote branches (risk.highWhen: deleting stored data) |
| T13 | Release 3.0.0 | chore | docs | T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12 | S | no | high | release: moves the reusable workflows' tag for every project; human merges |

### T1: `review.github` config key and the review workflow skips when it is off

- **Type:** feat
- **Area:** infra
- **Depends on:** none
- **Size:** M
- **Needs e2e:** no
- **Risk:** high - touches .github/** and skills/init/templates/github/** (highPaths)
- **Hotspot files:** skills/init/templates/devflow.schema.json, skills/init/templates/devflow.json, .github/workflows/devflow-review.yml, skills/init/templates/github/workflows/claude-code-review.yml, tests/reusable.test.cjs

**Acceptance criteria**

- [ ] The schema has `review.github` (boolean, default false, no other properties); the example config documents it; a config without `review` and the existing example configs still validate.
- [ ] The review workflow's first job step reads `.claude/devflow.json` through the API: the default-branch copy to learn `baseBranch`, then the copy at `baseBranch`, which wins (any failure to read the `baseBranch` copy, 404 included, falls back to the default-branch copy); never the PR head. It sets `enabled` to `true` only when `review.github` is `true` (boolean) in that config; when neither copy can be read it is off and a warning is logged.
- [ ] When `enabled` is not `true`, no other step runs: no `devflow/review` status (also not pending) is created, `claude-code-action` is not called, and the step summary contains `devflow review is off (review.github is not true)`; the job ends successfully.
- [ ] When `enabled` is `true`, every step runs under the same conditions as in 2.9.0.
- [ ] The reusable workflow and the template copy keep identical jobs (`tests/reusable.test.cjs` passes); the workflow's inputs, secrets and permissions are unchanged.
- [ ] README.md, DESIGN.md (including the accepted trade-off), the flows page and the CHANGELOG describe the flag.

**Scope**

- skills/init/templates/devflow.schema.json, skills/init/templates/devflow.json
- .github/workflows/devflow-review.yml, skills/init/templates/github/workflows/claude-code-review.yml
- tests/reusable.test.cjs, tests/setup.test.cjs (schema), tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md, docs/devflow-flows.html

**Test plan**

- Test cases: T1.1-T1.12 (see Test matrix).

### T2: Merge gate uses CI checks when the GitHub review is off

- **Type:** feat
- **Area:** infra
- **Depends on:** T1
- **Size:** S
- **Needs e2e:** no
- **Risk:** high - touches skills/init/templates/github/** (highPaths)
- **Hotspot files:** skills/init/templates/github/scripts/devflow-merge-gate.cjs, tests/merge-gate.test.cjs

**Acceptance criteria**

- [ ] `effectiveRequiredChecks` is exported: with `review.github: true` it returns `mergeGate.requiredChecks` unchanged; otherwise (false or absent) the list without `devflow/review`.
- [ ] With the flag off and `requiredChecks` `["devflow/review", "test"]`, a `risk:low` candidate with a green `test` and no `devflow/review` status merges (or `would merge` in dry run).
- [ ] Whenever the effective list is empty (flag off with `requiredChecks` `["devflow/review"]` or the default; or `requiredChecks` `[]` with the flag on or off), the gate makes no update, relabel, conflict block or merge call, also in dry run, and every candidate's row is `skipped` with the reason `no required checks (devflow/review is ignored while review.github is off); refusing to merge`.
- [ ] With the flag on, behaviour is as in 2.9.0, including that a `devflow/review` success created by anyone other than `github-actions[bot]` does not count.
- [ ] The caller and template gate workflows keep their triggers (`workflow_run` on the CI workflows and "Claude Code Review", `status`, `workflow_dispatch`).
- [ ] README.md, DESIGN.md and the CHANGELOG describe the effective list and the refusal.

**Scope**

- skills/init/templates/github/scripts/devflow-merge-gate.cjs
- tests/merge-gate.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md, docs/devflow-flows.html

**Test plan**

- Test cases: T2.1-T2.11 (see Test matrix).

### T3: Init and doctor: review flag prompt, upgrade offer, empty-checks warning

- **Type:** feat
- **Area:** docs
- **Depends on:** T1, T2
- **Size:** S
- **Needs e2e:** no
- **Risk:** low - skill text only, no highPaths file
- **Hotspot files:** skills/init/SKILL.md, skills/doctor/SKILL.md

**Acceptance criteria**

- [ ] `/devflow:init` asks for `review.github` with false recommended and states the trade-off; it proposes `devflow/review` in `mergeGate.requiredChecks` only when the answer is true.
- [ ] `/devflow:init` and `/devflow:doctor` (check 1) warn whenever `mergeGate.enabled` is true and the effective required list (T2) is empty, whatever `review.github` is; the warning says the gate will refuse to merge and lists the `name:` of each workflow in `.github/workflows/` as candidates for CI checks.
- [ ] `/devflow:init --upgrade` lists `review.github: true` as one plan item when the project has `.github/workflows/claude-code-review.yml`, and writes it only after a yes.
- [ ] README.md, DESIGN.md and the CHANGELOG describe the prompt, the warning and the upgrade item.

**Scope**

- skills/init/SKILL.md, skills/doctor/SKILL.md
- tests/skills.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T3.1-T3.5 (see Test matrix).

### T4: Engine short path for risk:low issues

- **Type:** feat
- **Area:** backend
- **Depends on:** none
- **Size:** M
- **Needs e2e:** no
- **Risk:** low - engine logic, no highPaths file
- **Hotspot files:** workflows/next-task-engine.js, tests/engine.test.cjs

**Acceptance criteria**

- [ ] For an issue labelled `labels.riskLow` at run start, without `labels.riskHigh` or `labels.e2e` and without an http/e2e Test cases row, no Plan agent runs and no plan comment is posted; one implement agent runs (no QA agent, also with `parallelQa: true`) and its prompt asks for the failing test commit before the change.
- [ ] On the short path no Verify agent runs, also when Implement reports a UI change (`touchesUi`).
- [ ] On the short path Check (with fix rounds), the weakened-checks scan, Review (with `maxReviewRounds`), Risk and Ship run as on the full path.
- [ ] An issue labelled `labels.riskHigh` (also together with `labels.riskLow`), with no risk label, with `labels.e2e`, or with an http/e2e Test cases row runs the full path, unchanged.
- [ ] A short-path issue escalated to high by the Risk step (highPaths or weakened checks) ships `risk:high` and Verify still does not run.
- [ ] The run result entry has `path: "short"` or `"full"`.
- [ ] README.md, DESIGN.md, the flows page and the CHANGELOG describe the short path.

**Scope**

- workflows/next-task-engine.js
- tests/engine.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md, docs/devflow-flows.html

**Test plan**

- Test cases: T4.1-T4.11 (see Test matrix).

### T5: Ship records the review trace and run markers; block comments carry a marker

- **Type:** feat
- **Area:** backend
- **Depends on:** T4
- **Size:** S
- **Needs e2e:** no
- **Risk:** low - engine prompts, no highPaths file
- **Hotspot files:** workflows/next-task-engine.js, tests/engine.test.cjs

**Acceptance criteria**

- [ ] The Ship prompt asks for a `## Review` section with the lines `Review: pass after <n> round(s) - local devflow reviewer in this run (GitHub review: <off|on>)`, `Path: short (Plan and Verify skipped)` or `Path: full`, and `Verify: <ran|skipped (short path)|not needed|could not run>`, with the values filled in by the engine: `<n>` is the number of reviewer calls, `<off|on>` follows `review.github`, Verify is `skipped (short path)` only when Verify would have been needed.
- [ ] The Ship prompt asks for the line `<!-- devflow-run {"path":"<path>","reviewRounds":<n>,"claimedAt":"<createdAt of this run's winning claim>"} -->` in the PR body (`"claimedAt":null` when unknown).
- [ ] The run result entry has `reviewRounds`.
- [ ] Exactly one comment per block contains `<!-- devflow-blocked -->`: the questions comment (second line) when there are questions, otherwise the reason comment; the questions comment still starts with `<!-- devflow-questions -->`.
- [ ] DESIGN.md and the CHANGELOG describe the section and both markers.

**Scope**

- workflows/next-task-engine.js
- tests/engine.test.cjs, tests/docs.test.cjs
- DESIGN.md, CHANGELOG.md, README.md

**Test plan**

- Test cases: T5.1-T5.8 (see Test matrix).

### T6: Engine and reviewer read the epic as the spec source

- **Type:** feat
- **Area:** backend
- **Depends on:** none
- **Size:** M
- **Needs e2e:** no
- **Risk:** low - engine prompts and reviewer agent text, no highPaths file
- **Hotspot files:** workflows/next-task-engine.js, tests/engine.test.cjs, agents/reviewer.md

**Acceptance criteria**

- [ ] `epicFor` returns `<n>` for a body with a line `Epic: #<n>` and 0 when there is none.
- [ ] For an issue with an `Epic: #<n>` line and no spec path, the Plan, Implement, QA, Fix and Review prompts tell the agent to read epic `#<n>` for shared design and decisions, take criteria and Test cases from the issue, and let the issue's `## Decisions` win over the epic's.
- [ ] For such an issue, a stage whose `specRead` does not contain `#<n>` as a whole token (`#420` does not match epic 42) is handled like a missing spec read today (Plan blocks; Implement gets one corrective fix, then blocks).
- [ ] The Plan, Implement, QA, Fix and Review result schemas have `epicRead` (boolean). When a stage returns `epicRead: false` (epic missing, closed, a pull request or unreadable), the issue blocks with the reason `epic #<n> could not be read`.
- [ ] An issue with a spec path behaves as in 2.9.0, also when it has an `Epic:` line; an issue with neither uses the issue alone.
- [ ] `agents/reviewer.md` says to read the epic named by the `Epic:` line with `gh issue view`.
- [ ] DESIGN.md, README.md and the CHANGELOG describe the source rule.

**Scope**

- workflows/next-task-engine.js, agents/reviewer.md
- tests/engine.test.cjs, tests/docs.test.cjs
- DESIGN.md, README.md, CHANGELOG.md

**Test plan**

- Test cases: T6.1-T6.10 (see Test matrix).

### T7: `/devflow:spec` creates an epic and sub-issues by default; `--file` keeps the spec PR

- **Type:** feat
- **Area:** docs
- **Depends on:** none
- **Size:** M
- **Needs e2e:** no
- **Risk:** low - skill text and templates, no highPaths file
- **Hotspot files:** skills/spec/SKILL.md, skills/spec/templates/issue.md

**Acceptance criteria**

- [ ] Without `--file`, the skill writes no spec file, opens no PR, and creates one epic (`[<slug>] <title>`, label `type:epic`, from the new `skills/spec/templates/epic.md` with Goal, Design, `## Decisions` and a Tasks table with risk and dependencies) and one sub-issue per task (`[<slug>] T<n>: <title>`) whose body has `Epic: #<epic>`, its criteria, its Test cases rows, risk with reason, hotspots and `Depends on #<n>` lines.
- [ ] Sub-issues get the risk label, `type:<type>` and `labels.e2e` when needed, and never `labels.ready`; the epic gets no ready or risk label.
- [ ] Each sub-issue is linked to the epic with `sub_issue_write` (method `add`); a failed link is reported and does not stop the run; the epic's Tasks table is updated with the issue numbers.
- [ ] All bodies are built (issue numbers filled at their widest expected width) and measured by JavaScript string `length` before any is created; if one exceeds 65,000 characters, nothing is created and the user is told to use `--file`.
- [ ] A re-run reuses issues found by exact title (trimmed, case-sensitive; open or closed) instead of creating duplicates, leaves their bodies as they are, and skips links that already exist.
- [ ] With `--file`, the skill follows the 2.9.0 steps (spec file, spec PR, Gate 1, issues labelled ready after the merge).
- [ ] The final message says the human approves each sub-issue by setting `labels.ready`.
- [ ] README.md, DESIGN.md, the flows page and the CHANGELOG describe both modes.

**Scope**

- skills/spec/SKILL.md, skills/spec/templates/epic.md (new), skills/spec/templates/issue.md
- tests/skills.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md, docs/devflow-flows.html

**Test plan**

- Test cases: T7.1-T7.8 (see Test matrix).

### T8: `/devflow:spec` closes open questions and runs one local spec review

- **Type:** feat
- **Area:** docs
- **Depends on:** T7
- **Size:** S
- **Needs e2e:** no
- **Risk:** low - skill text only, no highPaths file
- **Hotspot files:** skills/spec/SKILL.md

**Acceptance criteria**

- [ ] The skill creates no issue (and opens no spec PR) while a grill question is open, unless the user defers it; a deferred question appears in an `## Open questions` section of each affected sub-issue (in `--file` mode also in the spec's Risks and unknowns, and the issues created after the merge get the section too).
- [ ] After the QA step, a fresh agent with `spec.qaModel` gets only the brief and the draft path and reports findings of three kinds (missing requirement, contradiction, not independent), each critical, warning or suggestion; it does not judge testability.
- [ ] Only critical findings start another round; at most 2 reviewer calls in total; after the second the remaining critical findings are shown to the user, who chooses to proceed or stop. Warnings and suggestions are shown once.
- [ ] The review runs in both modes, before the issues or the spec PR.
- [ ] README.md, DESIGN.md and the CHANGELOG describe the step and how it differs from the QA step.

**Scope**

- skills/spec/SKILL.md
- tests/skills.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T8.1-T8.4 (see Test matrix).

### T9: `/devflow:answer` appends decisions only and opens no PR in epic mode

- **Type:** feat
- **Area:** docs
- **Depends on:** T7
- **Size:** S
- **Needs e2e:** no
- **Risk:** low - skill text only, no highPaths file
- **Hotspot files:** skills/answer/SKILL.md

**Acceptance criteria**

- [ ] Answers are appended to the issue's `## Decisions` as `- <YYYY-MM-DD> (Q<k>): <question> → <answer>` (`Q<k>` as numbered in the questions comment; the section is created at the end of the body when missing); no acceptance criterion or Test cases row is edited (the "(updated by /devflow:answer)" rule is gone).
- [ ] When the issue has an `Epic: #<n>` line, the same entries are appended to the epic's `## Decisions` as `- <YYYY-MM-DD> (#<issue>, Q<k>): <question> → <answer>`, and no branch or PR is created when the issue has no spec path.
- [ ] When the issue has a spec path, the spec PR still opens but only appends the entries to the spec's `## Decisions`; no other line of the spec changes.
- [ ] A failed append to the epic is reported in the final table and the comment; the sub-issue's entries stay.
- [ ] The unblock step (claims, assignee, labels, comment) is unchanged; the comment says where the decisions were recorded.
- [ ] DESIGN.md, README.md and the CHANGELOG describe the rule.

**Scope**

- skills/answer/SKILL.md
- tests/skills.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T9.1-T9.5 (see Test matrix).

### T10: `/devflow:accept` takes an epic

- **Type:** feat
- **Area:** docs
- **Depends on:** T7
- **Size:** S
- **Needs e2e:** no
- **Risk:** low - skill text only, no highPaths file
- **Hotspot files:** skills/accept/SKILL.md

**Acceptance criteria**

- [ ] `/devflow:accept #<n>` (or `<n>`) on an epic uses the union of its native sub-issues and the issues whose body has `Epic: #<n>`; a number is always an issue number; criteria and http/e2e rows come from each sub-issue.
- [ ] The `<!-- devflow-accept -->` comment is posted on the epic and edited in place on a re-run; gap issue titles use the slug from `[<slug>]` in the epic title, else `[epic #<n>]`.
- [ ] `#<n>` with no sub-issues and no issue whose body has `Epic: #<n>` stops with `#<n> is not an epic` and posts nothing.
- [ ] A spec path or slug works as in 2.9.0; the skill never closes the epic.
- [ ] README.md, DESIGN.md and the CHANGELOG describe the epic argument.

**Scope**

- skills/accept/SKILL.md
- tests/skills.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T10.1-T10.5 (see Test matrix).

### T11: `/devflow:report` takes an epic and shows per-issue metrics

- **Type:** feat
- **Area:** frontend
- **Depends on:** T5, T7
- **Size:** M
- **Needs e2e:** no
- **Risk:** low - skill text and trace template, no highPaths file
- **Hotspot files:** skills/report/SKILL.md, skills/report/templates/trace.html

**Acceptance criteria**

- [ ] `/devflow:report #<n>` on an epic uses its sub-issues; the JSON has `spec.epic` `{number, url}` (null for a spec file) and `spec.pr` null in epic mode.
- [ ] The PR used is the merged PR that closes the issue, else the latest one. Each issue has `metrics` with `path`, `reviewRounds`, `blocked`, `claimedAt`, `mergedAt`, `durationHours`, `mergedBy`, filled from the `devflow-run` marker, the count of `<!-- devflow-blocked -->` comments and the existing who-merged rule; review rounds fall back to the verdict-marker count; `durationHours` has one decimal; anything missing is `unknown` / `null`.
- [ ] The trace page shows five metrics per issue (path, review rounds, times blocked, duration, merged by; not `claimedAt` or `mergedAt`) and renders `null` as "unknown"; it still renders 2.9.0-shaped data without `metrics`.
- [ ] The skill stays read-only and posts nothing.
- [ ] README.md, DESIGN.md and the CHANGELOG describe the metrics.

**Scope**

- skills/report/SKILL.md, skills/report/templates/trace.html
- tests/skills.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T11.1-T11.7 (see Test matrix).

### T12: `/devflow:doctor` cleans up branches of merged devflow PRs

- **Type:** feat
- **Area:** docs
- **Depends on:** T3
- **Size:** S
- **Needs e2e:** no
- **Risk:** high - deletes remote branches (risk.highWhen: deleting stored data)
- **Hotspot files:** skills/doctor/SKILL.md

**Acceptance criteria**

- [ ] Doctor lists, for every devflow-labelled PR with `merged_at` set, its leftover remote head branch, local branch and worktree.
- [ ] `--fix` asks one confirmation for the whole list; before each deletion it re-checks `merged_at`, that no open PR has the branch as base or head, that the branch is not `baseBranch`, not in `protectedBranches` and not the current branch, and that a worktree is not the directory doctor runs in; a failed re-check skips the item and reports why.
- [ ] Worktrees are removed with `git worktree remove` without `--force` (dirty ones are kept and reported), local branches with `git branch -d` only (a refusal prints `git branch -D <branch>` for the user), remote branches with `git push <remote> --delete <branch>` (`<remote>` is `github.remote`, default `origin`). Without `--fix` doctor only lists.
- [ ] Branches of PRs closed without merging keep the per-branch yes.
- [ ] Doctor reports "Automatically delete head branches" as `warn` when off and `unknown` when it cannot read it; README recommends turning it on.
- [ ] The guard hook is unchanged.
- [ ] README.md, DESIGN.md and the CHANGELOG describe the cleanup.

**Scope**

- skills/doctor/SKILL.md
- tests/skills.test.cjs, tests/docs.test.cjs
- README.md, DESIGN.md, CHANGELOG.md

**Test plan**

- Test cases: T12.1-T12.7 (see Test matrix).

### T13: Release 3.0.0

- **Type:** chore
- **Area:** docs
- **Depends on:** T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12
- **Size:** S
- **Needs e2e:** no
- **Risk:** high - release: moves the reusable workflows' tag for every project; human merges
- **Hotspot files:** .claude-plugin/plugin.json, .claude-plugin/marketplace.json

**Acceptance criteria**

- [ ] The version is 3.0.0 in every place `tests/version.test.cjs` checks, and that test passes.
- [ ] CHANGELOG `[Unreleased]` becomes `[3.0.0] - <release date>` with every entry from T1-T12 and an upgrade note: `review.github` defaults to false (how to turn it on, what the gate then requires), `/devflow:spec` creates an epic by default (`--file` for the old flow), the short path for `risk:low`.
- [ ] The PR is labelled `risk:high`; the tag `v3.0.0` is created only after a human merges it.
- [ ] The full Node and hook test suites pass on the release branch.

**Scope**

- version files listed in CLAUDE.md, CHANGELOG.md, docs/devflow-flows.html

**Test plan**

- Test cases: T13.1-T13.4 (see Test matrix).

## Test matrix

Tests are named `test_t<task>_<n>_<description>` as given per row; where a `node:test` title cannot hold the id, the test carries the comment `// T<task>.<n>`. Docs rows live in `tests/docs.test.cjs`, skill contract rows in `tests/skills.test.cjs`.

| Id | Task | Criterion | Case | Given / When / Then | Level | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| T1.1 | T1 | schema `review.github` | happy | Given the schema / When `{review:{github:true}}` and `{review:{github:false}}` are validated / Then both are valid; `properties.review.properties.github` has `type: "boolean"`, `default: false`. Name: test_t1_1_schema_accepts_review_github | unit | must |
| T1.2 | T1 | schema `review.github` | error | Given the schema / When `{review:{github:true,foo:1}}` and `{review:{github:"true"}}` are validated / Then both are invalid. Name: test_t1_2_schema_rejects_extra_or_string | unit | must |
| T1.3 | T1 | existing configs valid | edge | Given a config with no `review`, the example `skills/init/templates/devflow.json` and the repo's `.claude/devflow.json` / When validated / Then all are valid, and the example documents `review.github`. Name: test_t1_3_configs_without_review_still_validate | unit | must |
| T1.4 | T1 | flag lookup: baseBranch copy wins | happy | Given the `flag` github-script from the YAML, run with mocked `getContent`: default-branch copy `{baseBranch:"develop",review:{github:false}}`, `develop` copy `{review:{github:true}}` / When it runs / Then `enabled` is `'true'` and the second read used `ref: "develop"`. Name: test_t1_4_flag_reads_base_branch_copy | unit | must |
| T1.5 | T1 | flag lookup: never the PR head | error | Given the PR head copy has `review.github:true` and the base copy has no `review` / When it runs / Then no `getContent` call uses the head ref or sha and `enabled` is not `'true'`. Name: test_t1_5_flag_never_reads_pr_head | unit | must |
| T1.6 | T1 | only boolean true | boundary | Given the resolved config has `review.github` `"true"`, then `1`, then missing / When it runs / Then `enabled` is not `'true'` in all three, and the summary contains `devflow review is off (review.github is not true)`. Name: test_t1_6_flag_only_boolean_true | unit | must |
| T1.7 | T1 | no readable copy: off with warning | error | Given `getContent` throws for both copies / When it runs / Then `enabled` is not `'true'`, `core.warning` is called once, `core.setFailed` is not called. Name: test_t1_7_flag_read_error_off_with_warning | unit | must |
| T1.8 | T1 | baseBranch copy unreadable falls back | edge | Given the default-branch copy `{baseBranch:"develop",review:{github:true}}` and reading `develop` returns 404 / When it runs / Then `enabled` is `'true'` and no warning is logged. Name: test_t1_8_flag_falls_back_to_default_copy | unit | must |
| T1.9 | T1 | off: no other step runs | happy | Given both review YAMLs / When the job steps are parsed / Then `flag` is step 0 and every later step's `if` contains `steps.flag.outputs.enabled == 'true'`, including the pending-status step and the `always()` publish step. Name: test_t1_9_every_step_gated_on_flag | unit | must |
| T1.10 | T1 | on: 2.9.0 conditions kept | happy | Given the 2.9.0 step `if` expressions as fixtures / When each new `if` has the flag clause stripped / Then it equals the 2.9.0 expression (a step without one now has only the flag clause). Name: test_t1_10_conditions_unchanged_when_on | unit | must |
| T1.11 | T1 | jobs identical, interface unchanged | happy | Given `.github/workflows/devflow-review.yml` and the template `claude-code-review.yml` / When compared / Then the jobs are identical and `workflow_call` inputs, secrets and `permissions` equal the 2.9.0 fixture. Name: test_t1_11_jobs_identical_interface_unchanged | unit | must |
| T1.12 | T1 | docs | happy | Given README.md, DESIGN.md, docs/devflow-flows.html, CHANGELOG.md / When searched / Then each contains `review.github`, DESIGN.md states the trade-off (`devflow:reviewer`), and CHANGELOG `[Unreleased]` has an entry citing T1's issue. Name: test_t1_12_docs_describe_review_flag | unit | must |
| T2.1 | T2 | `effectiveRequiredChecks` flag on | happy | Given `{review:{github:true},mergeGate:{requiredChecks:["devflow/review","test"]}}` / When called / Then it returns `["devflow/review","test"]`. Name: test_t2_1_effective_checks_flag_on | unit | must |
| T2.2 | T2 | `effectiveRequiredChecks` flag off or absent | happy | Given the same checks with `review.github:false`, and with no `review` (after `withDefaults`) / When called / Then both return `["test"]`. Name: test_t2_2_effective_checks_flag_off_or_absent | unit | must |
| T2.3 | T2 | merge on CI checks | happy | Given flag off, `requiredChecks:["devflow/review","test"]`, a `devflow` + `risk:low` candidate with `test` success and no `devflow/review` status / When `gate()` runs with a mocked github / Then a merge call is made; in dry run the row is `would merge` and no merge call. Name: test_t2_3_merges_on_ci_when_review_off | integration | must |
| T2.4 | T2 | merge on CI checks | error | Given the T2.3 setup with `test` failing, then pending / When `gate()` runs / Then no merge call. Name: test_t2_4_no_merge_when_ci_not_green | integration | should |
| T2.5 | T2 | stale review status ignored | edge | Given flag off, a `devflow/review` failure from `github-actions[bot]`, `test` green / When `gate()` runs / Then the candidate merges. Name: test_t2_5_stale_review_status_ignored_when_off | integration | should |
| T2.6 | T2 | empty list refusal, flag off | error | Given flag off and `requiredChecks:["devflow/review"]`, then no `requiredChecks`; two candidates, one conflicting and one behind / When `gate()` runs, live and dry run / Then no update-branch, label, comment or merge call; both rows `skipped` with `no required checks (devflow/review is ignored while review.github is off); refusing to merge`; the summary is written. Name: test_t2_6_refuses_when_only_review_check_and_off | integration | must |
| T2.7 | T2 | empty list refusal, `[]` | boundary | Given `requiredChecks:[]` with `review.github` true, then false / When `gate()` runs / Then as T2.6. Name: test_t2_7_refuses_empty_required_checks_either_flag | integration | must |
| T2.8 | T2 | flag on: bot creator rule | error | Given flag on, `requiredChecks:["devflow/review"]`, a `devflow/review` success created by `alice` / When `gate()` runs / Then no merge; with creator `github-actions[bot]` it merges. Name: test_t2_8_review_status_requires_bot_creator_when_on | integration | must |
| T2.9 | T2 | flag on = 2.9.0 | happy | Given the existing gate fixtures run with `review.github:true` / When the existing merge-gate tests run / Then all pass unchanged. Name: test_t2_9_flag_on_matches_290 | integration | must |
| T2.10 | T2 | gate triggers kept | happy | Given the caller and template gate workflows / When parsed / Then `on.workflow_run.workflows` includes the CI names and `Claude Code Review`, and `status` and `workflow_dispatch` are present. Name: test_t2_10_gate_triggers_kept | unit | must |
| T2.11 | T2 | docs | happy | Given README.md, DESIGN.md, CHANGELOG.md / When searched / Then each contains `effective` and `refusing to merge`, and the CHANGELOG cites T2's issue. Name: test_t2_11_docs_describe_effective_list | unit | must |
| T3.1 | T3 | init asks the flag | happy | Given `skills/init/SKILL.md` / When searched / Then it contains `review.github`, `false`, and `devflow/review` in the requiredChecks proposal step. Name: test_t3_1_init_asks_review_github | unit | must |
| T3.2 | T3 | empty-checks warning | happy | Given `skills/init/SKILL.md` and `skills/doctor/SKILL.md` / When searched / Then both contain `mergeGate.enabled`, `requiredChecks`, `.github/workflows/` and `name:`; the doctor text is in check 1. Name: test_t3_2_empty_checks_warning_in_init_and_doctor | unit | must |
| T3.3 | T3 | warning whatever the flag | edge | Given the same files / When the warning rule is searched / Then it is not conditioned on `review.github` being false (it names the effective list). Name: test_t3_3_warning_regardless_of_flag | unit | should |
| T3.4 | T3 | upgrade item | happy | Given the `--upgrade` section of `skills/init/SKILL.md` / When searched / Then it contains `review.github: true` and `claude-code-review.yml`. Name: test_t3_4_upgrade_offers_review_flag | unit | must |
| T3.5 | T3 | docs | happy | Given README.md, DESIGN.md, CHANGELOG.md / When searched / Then each contains `review.github` and `--upgrade`, and the CHANGELOG cites T3's issue. Name: test_t3_5_docs_describe_init_prompt | unit | must |
| T4.1 | T4 | short path: no Plan, one implement agent | happy | Given an issue labelled `[risk:low]` with a `unit` Test cases row and stub agents / When the engine runs / Then no Plan agent, no plan comment, exactly one implement agent whose prompt contains `none (short path: no plan stage)` and the test-first instruction. Name: test_t4_1_short_path_skips_plan | integration | must |
| T4.2 | T4 | short path: no QA | edge | Given the T4.1 issue and `parallelQa:true` / When the engine runs / Then no QA agent is called. Name: test_t4_2_short_path_no_qa_with_parallel_qa | integration | must |
| T4.3 | T4 | short path: no Verify | edge | Given a short-path issue whose Implement returns `touchesUi:true` / When the engine runs / Then no Verify agent and `state.verify === 'skipped (short path)'`; with `touchesUi:false`, `'not needed'`. Name: test_t4_3_short_path_never_verifies | integration | must |
| T4.4 | T4 | later stages kept | happy | Given a short-path issue, Check failing once then passing, a reviewer with one critical finding then pass, `maxReviewRounds:2` / When the engine runs / Then the calls are implement, check, fix, check, scan, review, fix, check, scan, review, ship. Name: test_t4_4_short_path_keeps_check_review_risk_ship | integration | must |
| T4.5 | T4 | review round limit | boundary | Given a short-path issue whose reviewer always returns a critical finding, `maxReviewRounds:2` / When the engine runs / Then it blocks at Review as on the full path and Ship is not called. Name: test_t4_5_short_path_review_round_limit | integration | should |
| T4.6 | T4 | full path: high labels | happy | Given labels `[risk:high]`, then `[risk:low, risk:high]` / When the engine runs / Then Plan runs and the result has `path:"full"`. Name: test_t4_6_high_label_full_path | integration | must |
| T4.7 | T4 | full path: no risk label or e2e label | edge | Given labels `[]`, then `[risk:low, e2e]` / When the engine runs / Then Plan runs and `path:"full"`. Name: test_t4_7_no_risk_or_e2e_full_path | integration | must |
| T4.8 | T4 | full path: http/e2e row | edge | Given `[risk:low]` with a Test cases row of level `http`, then `e2e` / When `pathFor` is called / Then `'full'`; with only `unit` rows, `'short'`. Name: test_t4_8_http_or_e2e_row_full_path | unit | must |
| T4.9 | T4 | escalation to high | edge | Given a short-path issue with `touchesUi:true` whose diff touches a `risk.highPaths` file / When the engine runs / Then Ship gets `risk:high`, no Verify agent ran, and `state.verify === 'skipped (short path)'`. Name: test_t4_9_escalated_short_path_no_verify | integration | must |
| T4.10 | T4 | result `path` | happy | Given one short and one full issue / When the run ends / Then the entries have `path:"short"` and `path:"full"`. Name: test_t4_10_result_has_path | integration | must |
| T4.11 | T4 | docs | happy | Given README.md, DESIGN.md, docs/devflow-flows.html (EN and VI), CHANGELOG.md / When searched / Then each contains `short path` (VI: its translation) and `risk:low`, and the CHANGELOG cites T4's issue. Name: test_t4_11_docs_describe_short_path | unit | must |
| T5.1 | T5 | Review section, flag off | happy | Given a full-path issue with one passing review and no `review` in the config / When the Ship prompt is built / Then it contains `## Review`, `Review: pass after 1 round(s) - local devflow reviewer in this run (GitHub review: off)` and `Path: full`. Name: test_t5_1_ship_review_section_off | integration | must |
| T5.2 | T5 | Review section, flag on, short | happy | Given `review.github:true` and a short-path issue passing on the second reviewer call / When the Ship prompt is built / Then it contains `pass after 2 round(s)`, `(GitHub review: on)` and `Path: short (Plan and Verify skipped)`. Name: test_t5_2_ship_review_section_on_short | integration | must |
| T5.3 | T5 | Verify values | edge | Given in turn: full path with Verify run, short path with `touchesUi`, short path without UI, full path where Verify could not run / When the Ship prompt is built / Then it contains `Verify: ran`, `Verify: skipped (short path)`, `Verify: not needed`, `Verify: could not run`. Name: test_t5_3_ship_verify_values | integration | must |
| T5.4 | T5 | run marker | happy | Given the winning claim has `createdAt:"2026-11-17T10:00:00Z"`, short path, 1 round / When the Ship prompt is built / Then it contains `<!-- devflow-run {"path":"short","reviewRounds":1,"claimedAt":"2026-11-17T10:00:00Z"} -->`. Name: test_t5_4_ship_run_marker | integration | must |
| T5.5 | T5 | run marker without claim time | edge | Given the claim returns no `createdAt` / When the Ship prompt is built / Then the marker has `"claimedAt":null` and its JSON parses. Name: test_t5_5_run_marker_claimed_at_null | integration | must |
| T5.6 | T5 | result `reviewRounds` | happy | Given the reviewer is called twice / When the run ends / Then the entry has `reviewRounds:2`. Name: test_t5_6_result_has_review_rounds | integration | must |
| T5.7 | T5 | one blocked marker per block | happy | Given a block with questions, and a block without / When the blocked prompt is built / Then exactly one comment carries `<!-- devflow-blocked -->`: the questions comment (second line, first line `<!-- devflow-questions -->`), else the reason comment. Name: test_t5_7_one_blocked_marker_per_block | unit | must |
| T5.8 | T5 | docs | happy | Given DESIGN.md and CHANGELOG.md / When searched / Then each contains `## Review`, `devflow-run` and `devflow-blocked`, and the CHANGELOG cites T5's issue. Name: test_t5_8_docs_describe_markers | unit | must |
| T6.1 | T6 | `epicFor` | happy | Given a body with the line `Epic: #42`, and one without / When `epicFor` is called / Then 42 and 0. Name: test_t6_1_epic_for_basic | unit | must |
| T6.2 | T6 | `epicFor` anchoring | edge | Given `See Epic: #42` → 0; `Epic: #7\nEpic: #9` → 7; `Context\nEpic: #12\n` → 12 / When `epicFor` is called / Then as listed. Name: test_t6_2_epic_for_anchored_first_match | unit | must |
| T6.3 | T6 | epic prompts | happy | Given an issue with `Epic: #42` and no spec path / When the Plan, Implement, QA, Fix and Review prompts are built / Then each contains `#42` and `## Decisions`, the MCP stages contain `issue_read`, the Review prompt contains `gh issue view`, none contains a spec path. Name: test_t6_3_prompts_use_epic_source | integration | must |
| T6.4 | T6 | `specRead` whole token | boundary | Given epic 42 and a Plan result with `specRead:"#420"` / When the engine checks it / Then Plan blocks as for a missing spec read; with `"epic #42."` it passes. Name: test_t6_4_spec_read_whole_token | unit | must |
| T6.5 | T6 | Implement missing epic read | error | Given epic 42 and Implement returning `specRead:""` twice / When the engine runs / Then one corrective fix runs, then the issue blocks. Name: test_t6_5_implement_missing_epic_read_fix_then_block | integration | must |
| T6.6 | T6 | `epicRead: false` blocks | error | Given epic 42 and a Plan result with `epicRead:false` / When the engine runs / Then the issue blocks with reason `epic #42 could not be read`; the stage schemas list `epicRead`. Name: test_t6_6_unreadable_epic_blocks | integration | must |
| T6.7 | T6 | spec path wins | edge | Given a body with `docs/specs/2026-11-17-x.md` and `Epic: #42` / When the prompts are built / Then they reference the spec file, not `issue_read` for #42, and `specRead` is checked against the path. Name: test_t6_7_spec_path_wins_over_epic | integration | must |
| T6.8 | T6 | issue alone | edge | Given a body with no spec path and no `Epic:` line / When the prompts are built / Then neither a spec nor an epic read is asked, and no `specRead` block happens. Name: test_t6_8_issue_alone_source | integration | should |
| T6.9 | T6 | reviewer.md | happy | Given `agents/reviewer.md` / When searched / Then it contains `Epic:` and `gh issue view`. Name: test_t6_9_reviewer_reads_epic | unit | must |
| T6.10 | T6 | docs | happy | Given DESIGN.md, README.md, CHANGELOG.md / When searched / Then each contains `Epic: #`, and the CHANGELOG cites T6's issue. Name: test_t6_10_docs_describe_source_rule | unit | must |
| T7.1 | T7 | epic template | happy | Given `skills/spec/templates/epic.md` / When read / Then it contains `Goal`, `Design`, `## Decisions` and a Tasks table header with risk and depends-on columns. Name: test_t7_1_epic_template_sections | unit | must |
| T7.2 | T7 | titles, label, `Epic:` line | happy | Given `skills/spec/SKILL.md` and `templates/issue.md` / When searched / Then SKILL.md contains `[<slug>]`, `T<n>:` and `type:epic`; issue.md contains `Epic: #`, the spec link variant and `Depends on #`. Name: test_t7_2_epic_mode_titles_and_epic_line | unit | must |
| T7.3 | T7 | sub-issue labels | happy | Given the epic-mode section of SKILL.md / When searched / Then it names `labels.riskLow`, `labels.riskHigh`, `labels.e2e` and `type:`, and `labels.ready` appears only in the final-message step. Name: test_t7_3_sub_issue_labels_no_ready | unit | must |
| T7.4 | T7 | linking | happy | Given SKILL.md / When searched / Then it contains `sub_issue_write` and `add`. Name: test_t7_4_links_with_sub_issue_write | unit | must |
| T7.5 | T7 | size check | boundary | Given SKILL.md / When searched / Then it contains `65,000`, `length` and `--file`, and the size-check step comes before the create step. Name: test_t7_5_size_check_before_create | unit | must |
| T7.6 | T7 | `--file` mode | happy | Given the `--file` section of SKILL.md / When searched / Then it contains `Gate 1`, the spec PR step and `labels.ready`. Name: test_t7_6_file_mode_keeps_290_steps | unit | must |
| T7.7 | T7 | final message | happy | Given the final-message step of SKILL.md / When searched / Then it contains `labels.ready`. Name: test_t7_7_final_message_ready | unit | should |
| T7.8 | T7 | docs | happy | Given README.md, DESIGN.md, docs/devflow-flows.html, CHANGELOG.md / When searched / Then each contains `epic` and `--file`, and the CHANGELOG cites T7's issue. Name: test_t7_8_docs_describe_both_modes | unit | must |
| T8.1 | T8 | open questions | happy | Given `skills/spec/SKILL.md` and `templates/issue.md` / When searched / Then both contain `## Open questions`, and SKILL.md also names `Risks and unknowns` for `--file`. Name: test_t8_1_open_questions_section | unit | must |
| T8.2 | T8 | spec review agent | happy | Given SKILL.md / When searched / Then it contains `spec.qaModel`, `missing requirement`, `contradiction`, `not independent`, `critical`, `warning`, `suggestion`. Name: test_t8_2_spec_review_contract | unit | must |
| T8.3 | T8 | step order | edge | Given SKILL.md / When section offsets are compared / Then QA comes before the spec review, which comes before issue creation (epic mode) and before the spec PR (`--file`). Name: test_t8_3_spec_review_order_both_modes | unit | must |
| T8.4 | T8 | docs | happy | Given README.md, DESIGN.md, CHANGELOG.md / When searched / Then each contains `spec review` and `QA`, and the CHANGELOG cites T8's issue. Name: test_t8_4_docs_describe_spec_review | unit | must |
| T9.1 | T9 | append format | happy | Given `skills/answer/SKILL.md` / When searched / Then it contains `(Q<k>):`, `(#<issue>, Q<k>):`, `→` and `## Decisions`, and not `(updated by /devflow:answer)`. Name: test_t9_1_append_only_format | unit | must |
| T9.2 | T9 | epic append, no PR | happy | Given SKILL.md / When searched / Then it contains `Epic: #`, and the epic branch states no branch or PR without a spec path. Name: test_t9_2_epic_append_no_pr | unit | must |
| T9.3 | T9 | spec PR appends only | edge | Given the spec-path section of SKILL.md / When searched / Then it names the spec's `## Decisions` as the only change and no longer says "in the section it belongs to". Name: test_t9_3_spec_pr_appends_decisions_only | unit | must |
| T9.4 | T9 | unblock unchanged | happy | Given the 2.9.0 unblock marker strings (claim marker, `assignee`, label names) / When the new SKILL.md is searched / Then all are present. Name: test_t9_4_unblock_step_unchanged | unit | must |
| T9.5 | T9 | docs | happy | Given DESIGN.md, README.md, CHANGELOG.md / When searched / Then each contains `/devflow:answer` and `## Decisions`, and the CHANGELOG cites T9's issue. Name: test_t9_5_docs_describe_answer_rule | unit | must |
| T10.1 | T10 | epic argument | happy | Given `skills/accept/SKILL.md` / When searched / Then it contains `#<n>`, `Epic: #` and the native sub-issue source. Name: test_t10_1_accept_takes_epic | unit | must |
| T10.2 | T10 | comment and gap titles | happy | Given SKILL.md / When searched / Then it contains `<!-- devflow-accept -->`, `[<slug>]` and `[epic #`. Name: test_t10_2_accept_comment_and_gap_titles | unit | must |
| T10.3 | T10 | not an epic | error | Given SKILL.md / When searched / Then it contains `is not an epic`. Name: test_t10_3_accept_not_an_epic | unit | must |
| T10.4 | T10 | spec path or slug kept | happy | Given SKILL.md / When searched / Then the 2.9.0 spec-path and slug contract strings are present. Name: test_t10_4_accept_spec_path_kept | unit | should |
| T10.5 | T10 | docs | happy | Given README.md, DESIGN.md, CHANGELOG.md / When searched / Then each contains `/devflow:accept #`, and the CHANGELOG cites T10's issue. Name: test_t10_5_docs_describe_accept_epic | unit | must |
| T11.1 | T11 | JSON shape | happy | Given `skills/report/SKILL.md` / When searched / Then it contains `spec.epic`, `spec.pr`, `metrics`, `path`, `reviewRounds`, `blocked`, `claimedAt`, `mergedAt`, `durationHours`, `mergedBy`. Name: test_t11_1_report_json_contract | unit | must |
| T11.2 | T11 | sources | happy | Given SKILL.md / When searched / Then it contains `devflow-run`, `<!-- devflow-blocked -->` and the verdict-marker fallback. Name: test_t11_2_report_metric_sources | unit | must |
| T11.3 | T11 | five metrics shown | happy | Given `trace.html`'s script run in `node:vm` with a stub document and a fixture issue with full `metrics` / When it renders / Then path, review rounds, times blocked, duration and merged by appear; `claimedAt` and `mergedAt` values do not. Name: test_t11_3_trace_renders_five_metrics | unit | must |
| T11.4 | T11 | null renders unknown | edge | Given `reviewRounds:null`, `durationHours:null` / When it renders / Then those cells show `unknown`. Name: test_t11_4_trace_null_renders_unknown | unit | must |
| T11.5 | T11 | 2.9.0 data | edge | Given a 2.9.0-shaped fixture without `metrics` or `spec.epic` / When it renders / Then no exception and the issue rows render. Name: test_t11_5_trace_renders_290_data | unit | must |
| T11.6 | T11 | read-only | happy | Given SKILL.md / When searched / Then it names no write tool (`add_issue_comment`, `issue_write`, `create_pull_request`). Name: test_t11_6_report_read_only | unit | should |
| T11.7 | T11 | docs | happy | Given README.md, DESIGN.md, CHANGELOG.md / When searched / Then each contains `/devflow:report #` and `metrics`, and the CHANGELOG cites T11's issue. Name: test_t11_7_docs_describe_metrics | unit | must |
| T12.1 | T12 | lists merged leftovers | happy | Given check 5 of `skills/doctor/SKILL.md` / When searched / Then it contains `merged_at`, `devflow`, and the worktree, local and remote branch kinds. Name: test_t12_1_doctor_lists_merged_leftovers | unit | must |
| T12.2 | T12 | re-checks | edge | Given SKILL.md / When searched / Then it names `baseBranch`, `protectedBranches`, the open-PR base and head check, the current branch and the current directory. Name: test_t12_2_doctor_rechecks_before_delete | unit | must |
| T12.3 | T12 | delete commands | error | Given SKILL.md / When searched / Then it contains `git worktree remove`, `git branch -d`, `git branch -D <branch>` (printed for the user), `git push <remote> --delete` and `github.remote`, and not `git worktree remove --force`. Name: test_t12_3_doctor_safe_delete_commands | unit | must |
| T12.4 | T12 | closed-unmerged per-branch yes | happy | Given SKILL.md / When searched / Then the per-branch confirmation for closed PRs is present. Name: test_t12_4_closed_unmerged_per_branch_yes | unit | should |
| T12.5 | T12 | auto-delete setting | happy | Given SKILL.md and README.md / When searched / Then SKILL.md contains `delete_branch_on_merge`, `warn`, `unknown`; README recommends "Automatically delete head branches". Name: test_t12_5_auto_delete_setting_reported | unit | must |
| T12.6 | T12 | guard unchanged | happy | Given the task branch / When the hook suite runs and `git diff <base>...HEAD -- hooks/guard.py` is checked / Then all pass and the diff is empty. Name: test_t12_6_guard_unchanged | integration | must |
| T12.7 | T12 | docs | happy | Given README.md, DESIGN.md, CHANGELOG.md / When searched / Then each contains `--fix` and `merged`, and the CHANGELOG cites T12's issue. Name: test_t12_7_docs_describe_cleanup | unit | must |
| T13.1 | T13 | version | happy | Given the release branch / When `node --test tests/version.test.cjs` runs / Then it passes with `3.0.0` everywhere. Name: test_t13_1_version_3_0_0 | unit | must |
| T13.2 | T13 | CHANGELOG section | happy | Given CHANGELOG.md / When parsed / Then a heading matches `## [3.0.0] - YYYY-MM-DD`, `[Unreleased]` has no entries, and the T1-T12 issue numbers appear under 3.0.0. Name: test_t13_2_changelog_3_0_0_entries | unit | must |
| T13.3 | T13 | upgrade note | happy | Given the 3.0.0 section / When searched / Then it contains `review.github`, `requiredChecks`, `--file`, `epic` and `short path`. Name: test_t13_3_upgrade_note_keywords | unit | must |
| T13.4 | T13 | full suites | happy | Given the release branch / When `node --test tests/*.test.cjs` and the hook suite run / Then both exit 0. Name: test_t13_4_full_suites_pass | integration | must |
