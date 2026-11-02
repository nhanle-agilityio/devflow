# Changelog

All notable changes to devflow. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [2.4.0] - wave 4

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
