---
name: release
description: Cut a release from merged devflow PRs (a spec, since a tag, or all of them): collect them, propose a semver version, write client-facing notes plus a changelog with a risk section, create the GitHub release (draft by default) and optionally run the deploy command after an explicit yes. Never merges.
argument-hint: "<spec path or slug | since <tag> | all> [--version X.Y.Z]"
disable-model-invocation: true
---

# /devflow:release

Arguments: $ARGUMENTS

Rules: use the GitHub MCP server for every GitHub operation (load its tools with ToolSearch); `gh` only if MCP is unavailable. Never merge a PR, never push to the base branch, never force-push, and never push tags from the shell: the tag is created by the GitHub release. Everything posted is English. No `Co-Authored-By` or AI attribution in notes or comments. Never write the review bot's at-sign handle anywhere. Follow `CLAUDE.md` and `.claude/devflow.json`. Config used: `release.tagPrefix` (default `v`), `release.draft` (default true), `release.deploy` (default empty), `release.notesFrom` (`prs`).

**Merged state:** never trust a `merged` field from a PR list or search result; the GitHub MCP list tools report `merged: false` for merged PRs. A PR is merged when `pull_request_read` (method `get`) returns a non-null `merged_at`, or when `git merge-base --is-ancestor <head sha> <remote>/<baseBranch>` succeeds after a fetch. Closed with neither: closed without merging. Take "merged by" and "merged at" from `pull_request_read`, not from a list.

## 0. Preflight

Fail fast with a clear message if any check fails.

1. `.claude/devflow.json` exists and parses as JSON. If not, tell the user to run `/devflow:init`.
2. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
3. `git fetch <remote> <baseBranch> --tags` succeeds (`remote` is `github.remote`, default `origin`). The working tree is not touched by this skill.
4. `$ARGUMENTS` has one form: a spec path or slug (under `specDir`, default `docs/specs`), or `since <tag>`, or `since` alone (use the latest tag that starts with `release.tagPrefix`; list tags with the MCP server), or `all`. Optional `--version X.Y.Z`. If no form is given: when no tag with `release.tagPrefix` exists yet, propose `all` as the default (the first release covers everything shipped) and ask for a yes; otherwise ask.

## 1. Collect the pull requests

Collect the merged PRs (merged per the Merged state rule) whose base is `baseBranch` and that are labelled `labels.devflow` or have a title starting with `spec:`:

- Spec form: read the spec on the base branch (`git show <remote>/<baseBranch>:<specDir>/<file>`), find the issues whose body links it, and take the merged PRs that close them (plus the spec PR itself).
- `since` form: those PRs merged after the tag's commit date.
- `all` form: every such PR merged into `baseBranch`, with no date limit.

For each PR keep: number, title, type (the Conventional Commit type of the title; a title starting with `spec:` maps to **Docs**), risk label, who merged it, merged at, closing issue.

Refuse if any of the spec's issues still has an open PR: list them (issue, PR) and stop, unless the user says to release anyway. An issue with no PR at all is listed as not shipped and does not block.

## 2. Version

1. `--version X.Y.Z` wins. The tag is `<release.tagPrefix><version>`; stop if that tag already exists.
2. Otherwise find the latest tag with the prefix and propose the next semver: any `feat` makes a minor bump, only `fix`, `chore`, `docs`, `refactor`, `test` makes a patch bump, a `BREAKING CHANGE` footer or a `!` after the type makes a major bump (read the PR bodies and commit messages for it). With no earlier tag propose `0.1.0`. Ask the user to confirm or give another version.

## 3. Notes

Build the notes in English from the PRs (`release.notesFrom` is `prs`):

- **What's new** comes first. It is written for clients and non-developers. Group the PRs by the spec their issues link; PRs with no spec go under "Other improvements". For each spec or feature write one short paragraph or 2-4 bullets that say what a user can now do or see, taken from the spec's Goals and acceptance criteria. Plain words only: no issue or PR numbers, no file, function or tool names, no internal labels. Leave out purely internal work (CI, devflow setup, tests, chores) unless it changes what users see.
- Then a **Changelog** heading holding the technical sections **Features** (`feat`), **Fixes** (`fix`), **Docs** (`docs`, and any title starting with `spec:`), **Chores** (`chore`, `refactor`, `test`, other). Omit empty ones. One line per PR: `- <title> (#<pr>)`.
- **Risk**: every `labels.riskHigh` PR with who merged it (`- #<pr> <title>: merged by <login>`), or "No high-risk changes." Say who merged each `risk:low` PR with the rule below.
- **Who merged**: a PR was merged by the merge gate when it has a comment starting with `<!-- devflow-gate-merged -->` or its merge commit message contains `Merged-by: devflow merge gate`. Otherwise, for a PR that predates the marker: when `merged_by` equals the gate token owner (the authenticated user), say "merger unknown (gate or owner)"; when a different user merged it, say "human: <login>".
- **Acceptance**: when `/devflow:accept` posted a comment (it starts with `<!-- devflow-accept -->`) on the spec PR, add its counts and the link to its gap issues; otherwise say acceptance was not run.

Show the notes and the version. Do not continue without a yes.

## 4. Create the release

After the yes: create the GitHub release with the MCP server: tag `<tagPrefix><version>`, target the head commit of `<remote>/<baseBranch>` (`git rev-parse <remote>/<baseBranch>`), title = the tag, body = the notes, `draft` = `release.draft`. Load the release tools with ToolSearch first. The release creates the tag on GitHub; do not push tags from the shell.

If the MCP server has no release-creation tool, give the user the pre-filled link `https://github.com/<owner>/<repo>/releases/new?tag=<tag>&target=<baseBranch>&title=<tag>` and the notes to paste, mark the release as not created and skip to the report.

## 5. Deploy

Only when `release.deploy` is non-empty:

1. Show the command. Say plainly when the release is still a draft (a draft has no tag yet, so a deploy that reads the tag would not find it).
2. Run it only after an explicit yes for this run; a yes for the release is not a yes for the deploy. Run it from the main checkout, never with `--force`-style flags the command did not already have.
3. Report the exit code and the last 20 lines of its output. A non-zero exit is reported as a failed deploy; do not retry on your own.

When `release.deploy` is empty, say no deploy command is configured.

## 6. Report

Print: tag, release URL (draft or published), the PR count by section, the high-risk PRs, and the deploy result (not configured, skipped, or exit code). If the release is a draft, say that publishing it is the user's action on GitHub.

Never merge a PR, never push to the base branch, never push tags.
