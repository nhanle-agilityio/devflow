# Changelog

All notable changes to devflow. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Guard: blocks git commands that discard work (`reset --hard`, `clean -f`, `branch -D`, `checkout .`, `restore .`, `stash drop|clear`, `filter-branch`, `update-ref -d`, `reflog expire`) and staging everything (`git add -A`, `--all`, `.`). `git add -u` is allowed. Replaces the per-project `block_git_add_all.py` hook.
- Engine: a deterministic weakened-checks scan of the diff before every review round, run by the shipped `bin/devflow-scan` script (new `noqa`, `type: ignore`, `eslint-disable`, `@ts-ignore`, skipped, focused or deleted tests, removed assertions, empty `except` / `catch`, edited check configuration). Hits are critical findings; hits the reviewer accepts as required by the issue make the PR `risk:high`.
- Review (engine and the `claude-code-review.yml` check): an out-of-scope item that leaves an acceptance criterion unmet is critical. Ship files the remaining real out-of-scope problems as follow-up issues labelled `needs-triage` and links them in the PR.

### Changed
- `/devflow:doctor --fix` prints `git branch -D` for the user instead of running it (the guard blocks it).
- Upgrade: run `/devflow:init --upgrade` to get the new review prompt.

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
