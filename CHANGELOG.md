# Changelog

All notable changes to devflow. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Merge gate blocks on unresolved collaborator threads: an unresolved, not outdated thread started by a human with association OWNER, MEMBER or COLLABORATOR blocks until it is resolved, even when the PR author replied last (`N unanswered review threads`). Threads started by the PR author or the review bot (`Bot` named `claude`) keep the last-comment rule; threads started by other bots, other associations (CONTRIBUTOR, NONE, ...), a deleted user or with no association do not block. Private organisation membership shows as CONTRIBUTOR and does not block (#32).
- Merge gate updates only the head of the queue: one run calls `updateBranch` once, for the first eligible behind PR in priority order; later behind PRs get `deferred: waits for its turn` (dry run: the first is `would update`). An up-to-date PR with a running required check and none failed holds the slot. Skipped, failed or missing-check PRs and an `updateBranch` error free it; no clock is used. Accepted windows: a `pending` status that never resolves blocks updates until the check is re-run or the status replaced, and an in-flight check can still fail after holding the slot for a run (#31).
- Claim treats an issue as taken only when it has an assignee other than the authenticated user, or the in-progress / blocked / review label; an issue assigned only to the authenticated user is claimed. The claim reports `assignedByRun`, and a blocked run (or a loser of the claim race with a different author) removes the authenticated user from the assignees only when the run added them (#28).
- Engine: a stage agent that throws after the claim was won now runs the blocked cleanup with stage `Error` (reason `Error: <first line>`; the assignee is removed only under the `assignedByRun` rule). A throw from the claim or release agent reports `Workflow error:` with the note `claim may be partial; run /devflow:doctor`; a throw from the cleanup itself reports `Workflow error:` with `cleanup failed; run /devflow:doctor`, and the run goes on with the next issue. `/devflow:doctor --fix` also removes the assignee of a stale in-progress issue, only when it is the authenticated user (#29).
- Engine: the run limit counts issues that were worked on. An issue skipped at Claim (already taken, or the claim race lost) does not count toward `limit`, so the next selected issue is worked on; a blocked issue, or a workflow error after Claim, still counts (#34).
- Engine: the Review loop exits on findings only. A `pass` verdict with a critical or warning finding starts a fix round, and a `changes` verdict with only suggestions ships. Any severity other than `suggestion` counts as blocking (fail closed) (#34).

- Init probes each connected GitHub MCP server by getting the authenticated user before generating the allow list: one answers, its tool prefix is used; several, it asks which; none (an auth error counts), it stops and tells the user to connect one. A different GitHub MCP prefix already allowed is replaced, shown in the diff. Doctor check 3 probes each server the same way, reports the prefix of the server it used and is `warn` only when `.claude/settings.json` allows another GitHub MCP prefix and no allowed prefix belongs to a server that answers (#36).
- Engine: Ship reuses an open PR for the branch. Step 0 looks for an open PR with head `<branch>`; if one exists it pushes, retargets the base when it differs, rewrites the body, adds the computed labels without removing any existing one (never `risk:high`) and opens no new PR. The ship schema gains `reused`, and the report notes `reused open PR #<n>`. Select no longer skips an issue whose only open PR is its own `devflow` PR (unless the issue is labelled `agent:review`) and returns `resumeBranch`, which the Branch stage resumes (#35).

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
