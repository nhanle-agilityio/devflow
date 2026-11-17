# Changelog

All notable changes to devflow. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `/devflow:spec` creates an epic by default: no spec file and no PR; it builds every body first, measures it by JavaScript string `length` (over 65,000 characters creates nothing and points to `--file`), then creates one epic (`[<slug>] <title>`, `type:epic`, from the new `skills/spec/templates/epic.md` with Goal, Design, `## Decisions` and a Tasks table) and one sub-issue per task (`[<slug>] T<n>: <title>`, `Epic: #<n>`, risk label, `type:<type>`, `labels.e2e` when needed, never `labels.ready`), links them with `sub_issue_write`, reuses issues found by exact title on a re-run and fills the Tasks table with the issue numbers. The human approves each sub-issue by setting `labels.ready`. `--file` keeps the 2.9.0 flow (spec file, spec PR, Gate 1, issues labelled ready after the merge) (#58)
- Config key `review.github` (boolean, default `false`): the GitHub review workflow (`devflow-review.yml` and the `claude-code-review.yml` template) starts with a `flag` step that reads `.claude/devflow.json` through the API (the default-branch copy to learn `baseBranch`, then the copy at `baseBranch`, which wins; never the PR head) and runs every other step only when `review.github` is `true`. With the flag off the job still succeeds, makes no Claude call, creates no `devflow/review` status (not even pending) and writes `devflow review is off (review.github is not true)` to the step summary; when no copy can be read it is off with a warning. With the flag on every step runs under the 2.9.0 conditions. Inputs, secrets and permissions are unchanged. Accepted trade-off: with the flag off no independent party confirms the local review (`devflow:reviewer`) (#52)
- Merge gate uses CI checks when the GitHub review is off: the effective required checks are `mergeGate.requiredChecks` without `devflow/review` while `review.github` is off, the list as is when it is on (the bot-creator rule for `devflow/review` stays). Whenever the effective list is empty (flag off with only `devflow/review`, which is the default list, or `requiredChecks: []`) the gate changes nothing, also in a dry run, and reports every candidate as `skipped` with `no required checks (devflow/review is ignored while review.github is off); refusing to merge`. Behaviour change: `requiredChecks: []` used to merge with no check and now refuses. Workflow triggers are unchanged (#53)
- Init and doctor know `review.github`: `/devflow:init` asks for it (`false` recommended, trade-off stated) and proposes `devflow/review` in `mergeGate.requiredChecks` only when it is true; init and `/devflow:doctor` (check 1) warn when `mergeGate.enabled` is true and the effective required list is empty, whatever the flag, listing the `name:` of each workflow in `.github/workflows/` as CI check candidates; `/devflow:init --upgrade` offers `review.github: true` as one plan item when `claude-code-review.yml` is installed, written only after a yes (#54)
- `/devflow:doctor` cleans up branches of merged devflow PRs: check 5 lists the leftover remote branch, local branch and worktree of every devflow-labelled PR with `merged_at` set; `--fix` asks one confirmation for the whole merged list, re-checks each item before deleting it (still merged, no open PR with the branch as base or head, not `baseBranch`, a protected or the current branch, not the current directory) and skips it with the reason when a re-check fails. Worktrees go with `git worktree remove` (no `--force`, dirty ones are kept), local branches with `git branch -d` only (a refusal prints `git branch -D <branch>` for you), remote branches with `git push <remote> --delete`. Branches of PRs closed without merging keep the yes per branch. Doctor also reports the "Automatically delete head branches" repository setting (`warn` when off, `unknown` when unreadable); the README recommends turning it on. The guard hook is unchanged (#63)
- Engine short path for `risk:low` issues: an issue whose labels (read at Claim) include `labels.riskLow`, do not include `labels.riskHigh` or `labels.e2e`, and whose Test cases table has no `http` or `e2e` row takes the short path: no Plan agent and no plan comment, no QA or commit agent (one implement agent writes the failing test first, also with `nextTask.parallelQa`) and no Verify, also when Implement changes the UI. Check with its fix rounds, the weakened-checks scan, Review (`maxReviewRounds`), Risk and Ship run as on the full path; a short path PR escalated to `risk:high` by the Risk step still skips Verify. Every other issue (`risk:high`, both risk labels, no risk label, `needs-e2e`, an `http`/`e2e` row) takes the full path as before. Each result entry carries `path: "short"` or `"full"`. Behaviour change: `risk:low` issues no longer get a plan comment or Verify (#55)
- Ship records the review trace and run markers: every PR body gets a `## Review` section (`Review: pass after <n> round(s) - local devflow reviewer in this run (GitHub review: off|on)`, `Path: short (Plan and Verify skipped)|full`, `Verify: ran|skipped (short path)|not needed|could not run`) and one hidden line `<!-- devflow-run {"path":...,"reviewRounds":<n>,"claimedAt":<ISO or null>} -->`; each result entry carries `reviewRounds`. Exactly one comment per block carries `<!-- devflow-blocked -->`: the questions comment as its second line (the first stays `<!-- devflow-questions -->`), otherwise the reason comment (#56)
- Engine and reviewer read the epic as the spec source: an issue with no spec path and a line `Epic: #<n>` (first match of `^Epic: #(\d+)`) makes the Plan, Implement, QA, Fix and Review stages read epic `#<n>` (GitHub MCP `issue_read`; the `devflow:reviewer` agent with `gh issue view`) for shared design and decisions, with criteria, Test cases and `## Decisions` from the issue winning. `specRead` must contain `#<n>` as a whole token; the stage schemas gain an optional `epicRead`, and `false` blocks the issue with `epic #<n> could not be read`. A spec path still wins over an `Epic:` line, and an issue with neither uses the issue alone (#57)

## [2.9.0] - 2026-11-16

Wave 1 reliability fixes from the 2.7.0 review: claim and cleanup edge cases, a quieter and safer merge gate, trusted-author handling in sync and answer, stages that read the issue from GitHub, and init and doctor checks for the GitHub MCP server.

### Fixed
- Sync and answer act only on trusted authors' comments: sync handles threads started by the authenticated user, the review bot (`claude`, confirmed by a `claude[bot]` review) or a repository collaborator, uses a summary comment only from `claude[bot]` or the authenticated user, never resolves threads it did not start, and lists everything else as `ignored: not a collaborator`; answer takes the questions comment and answers only from the authenticated user or OWNER, MEMBER, COLLABORATOR authors, never bots. Sync skips updating a behind PR the merge gate updates (gate enabled, not dry run, devflow + `risk:low`, not stacked or blocked), and no longer claims an author reply clears a trusted human's thread. Answer says the engine resumes a branch with commits (#30)
- Merge gate blocks on unresolved collaborator threads: an unresolved, not outdated thread started by a human with association OWNER, MEMBER or COLLABORATOR blocks until it is resolved, even when the PR author replied last (`N unanswered review threads`). Threads started by the PR author or the review bot (`Bot` named `claude`) keep the last-comment rule; threads started by other bots, other associations (CONTRIBUTOR, NONE, ...), a deleted user or with no association do not block. Private organisation membership shows as CONTRIBUTOR and does not block (#32).
- Merge gate updates only the head of the queue: one run calls `updateBranch` once, for the first eligible behind PR in priority order; later behind PRs get `deferred: waits for its turn` (dry run: the first is `would update`). An up-to-date PR with a running required check and none failed holds the slot. Skipped, failed or missing-check PRs and an `updateBranch` error free it; no clock is used. Accepted windows: a `pending` status that never resolves blocks updates until the check is re-run or the status replaced, and an in-flight check can still fail after holding the slot for a run (#31).
- Claim treats an issue as taken only when it has an assignee other than the authenticated user, or the in-progress / blocked / review label; an issue assigned only to the authenticated user is claimed. The claim reports `assignedByRun`, and a blocked run (or a loser of the claim race with a different author) removes the authenticated user from the assignees only when the run added them (#28).
- Engine: a stage agent that throws after the claim was won now runs the blocked cleanup with stage `Error` (reason `Error: <first line>`; the assignee is removed only under the `assignedByRun` rule). A throw from the claim or release agent reports `Workflow error:` with the note `claim may be partial; run /devflow:doctor`; a throw from the cleanup itself reports `Workflow error:` with `cleanup failed; run /devflow:doctor`, and the run goes on with the next issue. `/devflow:doctor --fix` also removes the assignee of a stale in-progress issue, only when it is the authenticated user (#29).
- Engine: the run limit counts issues that were worked on. An issue skipped at Claim (already taken, or the claim race lost) does not count toward `limit`, so the next selected issue is worked on; a blocked issue, or a workflow error after Claim, still counts (#34).
- Engine: the Review loop exits on findings only. A `pass` verdict with a critical or warning finding starts a fix round, and a `changes` verdict with only suggestions ships. Any severity other than `suggestion` counts as blocking (fail closed) (#34).
- Init probes each connected GitHub MCP server by getting the authenticated user before generating the allow list: one answers, its tool prefix is used; several, it asks which; none (an auth error counts), it stops and tells the user to connect one. A different GitHub MCP prefix already allowed is replaced, shown in the diff. Doctor check 3 probes each server the same way, reports the prefix of the server it used and is `warn` only when `.claude/settings.json` allows another GitHub MCP prefix and no allowed prefix belongs to a server that answers (#36).
- Engine: Ship reuses an open PR for the branch. Step 0 looks for an open PR with head `<branch>`; if one exists it pushes, retargets the base when it differs, rewrites the body, adds the computed labels without removing any existing one (never `risk:high`) and opens no new PR. The ship schema gains `reused`, and the report notes `reused open PR #<n>`. Select no longer skips an issue whose only open PR is its own `devflow` PR (unless the issue is labelled `agent:review`) and returns `resumeBranch`, which the Branch stage resumes (#35).
- Engine: stages read the issue from GitHub themselves. The Plan, Integrate, Implement, QA, Fix, Verify and Review prompts no longer carry the Select copy of the issue body: each names issue `#<n>` in `<owner>/<repo>` and tells the agent to read it from GitHub as the source of truth; the Select copy is used only for parsing (Depends on, Test cases levels, spec path, Risk line, acceptance criteria count). With `ghCli` the Review stage runs on `devflow:reviewer` and reads the issue with `gh issue view <n> --repo <owner>/<repo> --json title,body,labels`; the review schema requires `issueRead`, and a reviewer that could not read the issue is re-run on the default agent (sticky for later rounds; a default agent that cannot read it blocks the issue at Review). Without `ghCli` the review runs on the default agent. `devflow-setup allow` adds `Bash(gh issue view:*)` and no broader `gh` rule. All seven stage schemas allow `problem`; an MCP-down `problem` stops the run as at Claim. Claim now returns `labels`, `specPath` and `introducedBy`, which decide risk, fix-issue detection, the e2e label and the spec path (differences are noted); Plan returns `httpOrE2eRows` (triggers Verify) and `acceptanceCriteria`, compared with the count in the Select copy (a mismatch or a missing count is noted, the run continues) (#33).

### Upgrade
- Copy-mode projects run `/devflow:init --upgrade` for the new merge gate script. The engine, sync, answer, init and doctor changes apply as soon as the plugin updates. A `v2.9.0` tag is published after this release is merged, for reusable-mode callers.

## [2.8.0] - 2026-11-11

Hardening release for the auto-merge path: the merge gate, the weakened-checks scan, the verification step and the guard all get stricter. No config change is required; every new config key is optional.

### Added
- Config key `scan.ignore`: globs the weakened-checks scan skips. `.claude/devflow.json` is never ignored.
- `tests/version.test.cjs`: the versions in `plugin.json`, `marketplace.json`, the init template, the README and DESIGN.md, the flows page and the changelog must agree.
- `/devflow:doctor` check 10, guard self-test: it runs the guard on a merge call and expects exit status 2, so a machine where the guard cannot run is reported instead of silently unprotected.
- Scan: new hits for `.github/scripts/**`, `.github/actions/**`, a `Makefile` at any depth when any simple command of a check runs `make`, `package.json` script and tool-config lines only (dependency changes are not hits), Go `t.Skip` in `_test.go`, JUnit `@Disabled` / `@Ignore`, Rust `#[ignore]`, `//nolint`, `# rubocop:disable`, pytest `collect_ignore` / `pytest_ignore_collect`, and hollow assertions (`assert True`, `expect(true).toBe(true)`) in test files. More test-file layouts are recognised.
- Guard: blocks MCP file writes (`push_files`, `create_or_update_file`, `delete_file`) to a protected or unnamed branch; `git commit --no-verify` / `-n` and `git push --no-verify`; `gh api` writes to a protected branch ref or to a commit status; removing the `risk:high` label with `gh pr edit` / `gh issue edit` (adding `risk:low` is allowed); `git add *`; `git checkout -f` and `git switch -f` / `--discard-changes`. `git clean -n` is allowed.

### Changed
- Merge gate: re-reads the PR's files on every run. A PR that touches `risk.highPaths` or the built-in `.github/**` / `.claude/**` is skipped and relabelled `risk:high` (dry run: `would skip`), before any update-branch, whatever its label says. A `devflow/review` commit status counts only when `github-actions[bot]` created it.
- Engine: a required verification that could not run (`ran: false`) raises the PR to `risk:high`, with the reason in the Risk line and in the notes.
- Scan: line patterns no longer run on prose files (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`, `docs/**`).
- Guard: fails closed. An internal error, including unparsable input, blocks with exit 2 instead of disabling the guard.
- Upgrade: copy-mode projects run `/devflow:init --upgrade` for the new merge gate script. The guard, scan and engine changes apply as soon as the plugin updates. A `v2.8.0` tag is published with this release for reusable-mode callers.

## [2.7.0] - 2026-11-10

Minor release: every new config key is optional and existing configs stay valid. Behaviour is stricter (the guard blocks more git commands, accept gaps wait for triage, weakened checks raise risk), but no setup change is required.

### Added
- Plugin hooks: `hooks/formatter.py` (PostToolUse) runs the new `format` config key's per-glob formatters on each edited file, quietly; `hooks/session_start.py` (SessionStart) gives every session the workflow rules built from `.claude/devflow.json`, and is silent without one.
- The `devflow:reviewer` agent (`agents/reviewer.md`), used by the Review stage (`nextTask.reviewerAgent`) and for local reviews.
- Reusable workflows `devflow-review.yml` and `devflow-merge-gate.yml` (`on: workflow_call`) and thin caller templates pinned to a tag; `/devflow:init` chooses reusable or copy mode, `--upgrade` moves the tag.
- `bin/devflow-setup`: the allow list from `checks`, `verify`, `worktree.setup` and the remote; the minimal config (non-default keys only); the leftovers list for doctor.
- `/devflow:doctor` check 9: project files and rules the plugin now owns (`block_git_add_all.py` and its `hook-test` check, deny rules, a maintenance `loop.md`, a project `code-reviewer` agent), reported as removable and never deleted.
- Guard: blocks git commands that discard work (`reset --hard`, `clean -f`, `branch -D`, `checkout .`, `restore .`, `stash drop|clear`, `filter-branch`, `update-ref -d`, `reflog expire`) and staging everything (`git add -A`, `--all`, `.`). `git add -u` is allowed. Replaces the per-project `block_git_add_all.py` hook.
- Engine: a deterministic weakened-checks scan of the diff before every review round, run by the shipped `bin/devflow-scan` script (new `noqa`, `type: ignore`, `eslint-disable`, `@ts-ignore`, skipped, focused or deleted tests, removed assertions, empty `except` / `catch`, edited check configuration). Hits are critical findings; hits the reviewer accepts as required by the issue make the PR `risk:high`.
- Review (engine and the `claude-code-review.yml` check): an out-of-scope item that leaves an acceptance criterion unmet is critical. Ship files the remaining real out-of-scope problems as follow-up issues labelled `needs-triage` and links them in the PR.

- Priority labels (`labels.priority`, default `priority:critical|high|normal|low`, no label = normal). `/devflow:next-task` orders by dependencies, then priority, then issue number, and a critical or high issue pulls its open parents forward. The merge gate tries candidates by the linked issue's priority, then PR number. No preemption, and priority never changes who merges.
- `labels.triage` (`needs-triage`): accept gaps and Ship's follow-up issues get it instead of ready, with a comment suggesting priority and risk; next-task and dispatch never pick such issues. Only a human sets ready.
- A shared bug issue template (`skills/spec/templates/bug.md`) and a "Filing a bug" section in the README.
- Fix PRs (bugs, gaps, `type:fix`) carry Root cause, Introduced by and Why it was missed.
- `/devflow:release` lists critical fixes first.

### Changed
- `/devflow:init` writes no deny rules (the guard covers them), generates the allow list, and writes only non-default keys to `devflow.json`.
- `/devflow:accept` no longer labels gaps ready or sets their risk label: a human triages them.
- `/devflow:doctor --fix` prints `git branch -D` for the user instead of running it (the guard blocks it).
- Upgrade: run `/devflow:init --upgrade` in each project for the new review prompt and gate script (or to switch to reusable mode), then `/devflow:doctor` to see which project files can go.

## [2.6.0] - 2026-11-04

### Added
- `/devflow:sync` can run unattended: `/loop 15m /devflow:sync --unattended` works in a temporary worktree that is always removed, asks nothing (threads needing a product decision are left unresolved and listed as "needs a human"), and stops with "nothing to sync" when there are no target PRs.

### Changed
- `/devflow:sync` no longer sets `disable-model-invocation`, because a scheduled `/loop` prompt can only run a skill through the Skill tool and that flag blocked it. Its description limits invocation to a user request or a `/loop` prompt naming it. Other skills are unchanged.

## [2.5.1] - 2026-11-03

### Fixed
- Merge gate: the `<!-- devflow-gate-merged -->` comment is posted right after the merge, before stacked PRs are retargeted and the head branch is deleted. A failure in either step (for example a 422 when GitHub already auto-deleted the branch) no longer loses the marker, which is the only gate marker for `rebase` merges.
- Upgrade: run `/devflow:init --upgrade` in each project to get the fixed gate script.

## [2.5.0] - 2026-11-03

### Added
- The merge gate marks what it merges: the merge commit message ends with `Merged-by: devflow merge gate` and the PR gets a comment starting with `<!-- devflow-gate-merged -->`.
- `/devflow:release all`: every merged devflow or `spec:` PR into the base branch. It is the proposed default when no tag exists yet, so the first release covers everything shipped.
- Release notes start with a "What's new" section written for clients, before the technical changelog.

### Changed
- `spec:` PRs go to Docs in the release notes, not Chores. The `since` form includes them too.
- `/devflow:release` and `/devflow:report` tell gate merges from human merges by the marker. An older PR merged by the gate token owner shows "merger unknown (gate or owner)".
- Upgrade: run `/devflow:init --upgrade` in each project to get the new gate script.

## [2.4.1] - 2026-11-03

### Fixed
- Merged state is read from `pull_request_read` `merged_at` or from git ancestry, never from list results, which report `merged: false` for merged PRs. Affects doctor, accept, report, release, sync and the engine's parent check.

### Changed
- Doctor warns about `devflowVersion` only for a major or minor difference.

## [2.4.0] - 2026-11-03 (wave 4)

### Added
- Engine regression tests (`tests/engine.test.cjs`).
- CI: the `test` workflow runs the Node and hook tests on every PR and on `main`.
- Versioning: `version` in `plugin.json` and `marketplace.json`, and this changelog.
- Report notes from the engine, used by `/devflow:report`.
- `verify.lock`: one session at a time runs Verify on a machine.
- Clear stop when the GitHub MCP is unavailable.
- Resume a blocked branch instead of starting over.
- Manual check results recorded in the PR.
- `dispatch.ignoreHotspots`: README and CHANGELOG hotspots no longer join lanes.
- `/devflow:init --upgrade` and the `devflowVersion` config key.
- `/devflow:doctor [--fix]`.
- `/devflow:accept`, with the `accept` config key.
- `/devflow:release`, with the `release` config key.
- `/devflow:report`.
- Push notifications, with the `notify` config key.

## [2.3.0] - wave 3

### Added
- Parallel QA: a QA agent writes the acceptance tests while the dev agent implements (`nextTask.parallelQa`).
- Merged questions: one comment per blocked issue.
- `/devflow:answer`.
- Flow map.

### Fixed
- QA and implement tests are named by the issue's pattern.

## [2.2.0] - wave 2

### Added
- Isolated worktrees, claim lock, posted plans and lane chaining in `/devflow:next-task`.
- `/devflow:dispatch`: plan lanes by shared hotspots and start one background session per lane.

### Fixed
- A lane keeps going when one of its issues does not ship.
- A parent PR merged while its child is built is handled.
- Workflow templates use `actions/checkout@v7` and `github-script@v9`.

## [2.1.0] - wave 1

### Added
- Risk levels per task and `risk:low|high` labels; the merge gate Action for low-risk PRs.
- Stacked PRs, including on several parents; a PR is held until every dependency of its issue is closed.
- `/devflow:sync` (replaces `/devflow:address-reviews`): retarget, update, conflicts and reviews.
- Review verdict read from a marker in the bot's summary comment; the review became a `devflow/review` status.
- Spec read rule: `next-task` reads the spec before implementing.

### Fixed
- The gate carries over only real review verdicts.

## [2.0.0] - test matrix

### Added
- QA step in `/devflow:spec` that drafts a test matrix from the acceptance criteria (`spec.testMatrix`, `spec.qaModel`).
- `next-task` requires a test for every `must` row.

## [1.0.0] - initial release

### Added
- `/devflow:spec`: idea to reviewed spec and GitHub issues.
- `/devflow:next-task`: implement ready issues test-first, check, verify, review, open PRs.
- `/devflow:init` and the guard hook.

## Release process

1. Bump `version` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
2. Move the items to a new version heading in this file.
3. Open a PR; after it merges, a human tags `vX.Y.Z` on `main` (Claude never merges or tags).
