---
name: release
description: Cut a release from merged devflow PRs: collect them, propose a semver version, write grouped notes with a risk section, create the GitHub release (draft by default) and optionally run the deploy command after an explicit yes. Never merges.
argument-hint: "<spec path or slug | since <tag>> [--version X.Y.Z]"
disable-model-invocation: true
---

# /devflow:release

Arguments: $ARGUMENTS

Rules: use the GitHub MCP server for every GitHub operation (load its tools with ToolSearch); `gh` only if MCP is unavailable. Never merge a PR, never push to the base branch, never force-push, and never push tags from the shell: the tag is created by the GitHub release. Everything posted is English. No `Co-Authored-By` or AI attribution in notes or comments. Never write the review bot's at-sign handle anywhere. Follow `CLAUDE.md` and `.claude/devflow.json`. Config used: `release.tagPrefix` (default `v`), `release.draft` (default true), `release.deploy` (default empty), `release.notesFrom` (`prs`).

## 0. Preflight

Fail fast with a clear message if any check fails.

1. `.claude/devflow.json` exists and parses as JSON. If not, tell the user to run `/devflow:init`.
2. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
3. `git fetch <remote> <baseBranch> --tags` succeeds (`remote` is `github.remote`, default `origin`). The working tree is not touched by this skill.
4. `$ARGUMENTS` has one form: a spec path or slug (under `specDir`, default `docs/specs`), or `since <tag>`, or `since` alone (use the latest tag that starts with `release.tagPrefix`; list tags with the MCP server). Optional `--version X.Y.Z`. If neither form is given, ask.

## 1. Collect the pull requests

Collect the merged PRs labelled `labels.devflow` whose base is `baseBranch`:

- Spec form: read the spec on the base branch (`git show <remote>/<baseBranch>:<specDir>/<file>`), find the issues whose body links it, and take the merged PRs that close them (plus the spec PR itself).
- `since` form: the merged PRs labelled `labels.devflow` merged after the tag's commit date.

For each PR keep: number, title, type (the Conventional Commit type of the title), risk label, who merged it, merged at, closing issue.

Refuse if any of the spec's issues still has an open PR: list them (issue, PR) and stop, unless the user says to release anyway. An issue with no PR at all is listed as not shipped and does not block.

## 2. Version

1. `--version X.Y.Z` wins. The tag is `<release.tagPrefix><version>`; stop if that tag already exists.
2. Otherwise find the latest tag with the prefix and propose the next semver: any `feat` makes a minor bump, only `fix`, `chore`, `docs`, `refactor`, `test` makes a patch bump, a `BREAKING CHANGE` footer or a `!` after the type makes a major bump (read the PR bodies and commit messages for it). With no earlier tag propose `0.1.0`. Ask the user to confirm or give another version.

## 3. Notes

Build the notes in English from the PRs (`release.notesFrom` is `prs`):

- Sections **Features** (`feat`), **Fixes** (`fix`), **Docs** (`docs`), **Chores** (`chore`, `refactor`, `test`, other). Omit empty ones. One line per PR: `- <title> (#<pr>)`.
- **Risk**: every `labels.riskHigh` PR with who merged it (`- #<pr> <title>: merged by <login>`), or "No high-risk changes." Say whether each `risk:low` PR was merged by the merge gate or by a human when that is visible.
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
