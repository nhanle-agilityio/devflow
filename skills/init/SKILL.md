---
name: init
description: Set up devflow in the current project once: detect remotes, branches, scripts and CLAUDE.md, write .claude/devflow.json and its schema, configure risk and the merge gate, and optionally install the GitHub Actions. Idempotent.
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
4. Risk and merge gate (ask with AskUserQuestion, recommended option each time):
   - `risk.highWhen`: show the defaults from the schema and let the user edit them. `risk.highPaths`: ask for globs (`**`, `*`, `?`) of files whose change always needs a human merge (auth, migrations, payment code, CI config); default is none.
   - `mergeGate.enabled`: first explain it. A GitHub Action merges PRs labelled `labels.riskLow` when every `mergeGate.requiredChecks` entry is green; Claude itself never merges; risk:high PRs always wait for a human. Default `enabled` false, `dryRun` true (it only logs what it would merge until the user turns `dryRun` off).
   - `mergeGate.requiredChecks`: propose the job and check names found in `.github/workflows/*` plus `devflow/review`; the user picks. They must be names of check runs or commit-status contexts.
   - `testing.e2eFramework`: set true only when the repo has an automated e2e/browser test setup that can hold committed e2e tests (a Playwright or Cypress config, a `tests/e2e` folder, and so on); otherwise false. Say which signal you used.
   - `worktree.setup`: commands that make a fresh git worktree ready to work in (dependencies, virtualenv, build). Propose them from the detected tooling (`make setup`, `npm ci`, a venv plus `pip install -r requirements.txt`, `bundle install`, and so on) and say where each came from; empty is fine. Keep `worktree.dir` at `.claude/worktrees` unless the user wants another place.
   - `dispatch.maxLanes`: how many background sessions `/devflow:dispatch` may run at once (default 3). Leave `dispatch.pluginDir` unset unless the plugin is loaded from a local directory.
   - Mention `spec.testMatrix` (default on) and `spec.qaModel` (`opus` or `sonnet`, default `opus`) and ask whether to change them.
5. Write plain JSON (no comments) to `.claude/devflow.json` and copy the schema to `.claude/devflow.schema.json` (the config's `$schema` is `./devflow.schema.json`). If a config already exists, show the diff first and apply only after a yes.
6. Validate the written file against the schema (all required keys present, types right, no unknown keys).

## 3. Check CLAUDE.md

The workflows rely on CLAUDE.md for: architecture and layer rules, conventions (commit format, language), how tests are written, and a "Never" list. List what is missing or vague. Offer to draft additions. Never edit CLAUDE.md without an explicit yes.

## 4. GitHub Actions and permissions

Ask separately for each (a separate yes each; copy only if the target is absent, otherwise show a diff):

- Copy `${CLAUDE_SKILL_DIR}/templates/github/workflows/claude-code-review.yml` to `.github/workflows/claude-code-review.yml`.
- Copy `${CLAUDE_SKILL_DIR}/templates/github/workflows/devflow-merge-gate.yml` to `.github/workflows/devflow-merge-gate.yml` and `${CLAUDE_SKILL_DIR}/templates/github/scripts/devflow-merge-gate.cjs` to `.github/scripts/devflow-merge-gate.cjs` (one yes for the pair). In the copied workflow, fill the `workflow_run` `workflows:` list with the names of the project's CI workflows (the `name:` of each file in `.github/workflows/` that runs the checks; list what you chose).
- Copy `${CLAUDE_SKILL_DIR}/templates/github/workflows/claude.yml` to `.github/workflows/claude.yml`.

Tell the user the required setup for what was added:

- Repository secret `CLAUDE_CODE_OAUTH_TOKEN` (review and mention workflows).
- Merge gate: repository secret `DEVFLOW_GATE_TOKEN`, a fine-grained personal access token limited to this repository with Contents read/write and Pull requests read/write. The Actions `GITHUB_TOKEN` cannot be used: pushes and merges made with it do not trigger CI.
- Repository settings: enable "Allow merge commits" (stacked PRs need merge commits).
- The gate workflow must be on the repository's default branch: `workflow_run` and status triggers run from there. Merge the PR that adds it before expecting it to act.
- The gate stays inert until `mergeGate.enabled` is true and logs only while `mergeGate.dryRun` is true.

Worktrees: the worktree directory (`worktree.dir`, default `.claude/worktrees/`) must not be committed. Show the diff that adds it to `.gitignore` and apply it only after a yes.

Background sessions: the sessions `/devflow:dispatch` starts cannot answer permission prompts, so anything not allowed is refused and the run stalls. The project therefore needs allow rules in `.claude/settings.json`. Offer, as one proposal: the `permissions` snippet from `${CLAUDE_PLUGIN_ROOT}/README.md`, plus a `Bash(<command>:*)` allow rule for each `checks[].run` command and each `worktree.setup` command, plus the git commands the workflows use (`git worktree`, `git switch`, `git fetch`, `git push` to feature branches). Show the merged result as a diff; merge only after a yes. Never add a rule that allows merging a PR or pushing to a protected branch.

Then print the `permissions` snippet from `${CLAUDE_PLUGIN_ROOT}/README.md` for `.claude/settings.json` and offer to merge it; merge only after a yes (skip this if the proposal above already covered it).

## 5. Remind

Tell the user: the plugin hook blocks merging PRs and pushing to protected branches (`baseBranch` plus `protectedBranches`); GitHub MCP must be connected for the other workflows; run `/devflow:spec <idea>` next.

Do not commit or push anything.
