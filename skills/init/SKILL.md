---
name: init
description: Set up devflow in the current project once: detect remotes, branches, scripts and CLAUDE.md, write .claude/devflow.json and its schema, and optionally install the GitHub Actions. Idempotent.
disable-model-invocation: true
---

# /devflow:init

Sets a project up for the devflow workflows. Safe to re-run: when files exist, show a diff of the proposed changes and change nothing until the user agrees. The project's own rules stay in `CLAUDE.md`; mechanics go in `.claude/devflow.json`. Do not restate CLAUDE.md in the config.

Follow the steps in order and announce each by number.

## 1. Read the repo

Collect, with read-only commands:

- Git remotes (`git remote -v`): find the one that points at GitHub, and derive `owner` and `repo`.
- Default and current branch (`git symbolic-ref refs/remotes/<remote>/HEAD`, `git branch --show-current`).
- Build and test setup: `package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, lockfiles, framework config files, `docker-compose*`.
- `CLAUDE.md`, `.claude/settings.json`, existing `.claude/devflow.json`, `.github/workflows/`.
- Whether a dev server exists (a `dev`/`start`/`serve`/`run` script, its port) and whether the project has a UI or an HTTP API.

## 2. Propose `.claude/devflow.json`

1. Read `${CLAUDE_SKILL_DIR}/templates/devflow.json` (annotated example) and `${CLAUDE_SKILL_DIR}/templates/devflow.schema.json`.
2. Fill a config from what you detected. For each value say where it came from (file and key). Required: `github`, `baseBranch`, `checks`. Put into `checks` the project's real commands (tests, lint, type check, build), each runnable non-interactively and exiting non-zero on failure.
3. Use AskUserQuestion for anything ambiguous: which remote, base branch, which checks, dev server command and URL, verify modes (`http`, `browser`, both, or none), browser tool (`playwright` or `chrome`). Offer a recommended option each time.
4. Write plain JSON (no comments) to `.claude/devflow.json` and copy the schema to `.claude/devflow.schema.json` (the config's `$schema` is `./devflow.schema.json`). If a config already exists, show the diff first and apply only after a yes.
5. Validate the written file against the schema (all required keys present, types right, no unknown keys).

## 3. Check CLAUDE.md

The workflows rely on CLAUDE.md for: architecture and layer rules, conventions (commit format, language), how tests are written, and a "Never" list. List what is missing or vague. Offer to draft additions. Never edit CLAUDE.md without an explicit yes.

## 4. GitHub Actions and permissions

Ask separately for each (a separate yes each):

- Copy `${CLAUDE_SKILL_DIR}/templates/claude-code-review.yml` to `.github/workflows/claude-code-review.yml` (only if absent).
- Copy `${CLAUDE_SKILL_DIR}/templates/claude.yml` to `.github/workflows/claude.yml` (only if absent).

If either was added, tell the user to add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret. Then print the `permissions` snippet from `${CLAUDE_PLUGIN_ROOT}/README.md` for `.claude/settings.json` and offer to merge it; merge only after a yes.

## 5. Remind

Tell the user: the plugin hook blocks merging PRs and pushing to protected branches (`baseBranch` plus `protectedBranches`); GitHub MCP must be connected for the other workflows; run `/devflow:spec <idea>` next.

Do not commit or push anything.
