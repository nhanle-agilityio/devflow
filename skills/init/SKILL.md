---
name: init
description: Set up devflow in the current project once: detect remotes, branches, scripts and CLAUDE.md, write .claude/devflow.json and its schema, configure risk and the merge gate, and optionally install the GitHub Actions. Idempotent.
argument-hint: "[--upgrade]"
disable-model-invocation: true
---

# /devflow:init

Arguments: $ARGUMENTS

Sets a project up for the devflow workflows. With `--upgrade`, skip to "Upgrade" below instead. Safe to re-run: when files exist, show a diff of the proposed changes and change nothing until the user agrees. The project's own rules stay in `CLAUDE.md`; mechanics go in `.claude/devflow.json`. Do not restate CLAUDE.md in the config.

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
   - Mention the newer keys with their defaults (`dispatch.ignoreHotspots`, `verify.lock`, `notify`, `release`, `accept`, `labels.priority`, `labels.triage`, `nextTask.reviewerAgent`) and ask only about `notify.push`; leave the others unset.
   - `format`: formatters the plugin runs after Claude edits a file (glob to command, `{file}` = the path). Propose one per detected formatter (`ruff format`, `black`, `prettier -w`, `gofmt -w`, ...) with the project's own binary path (e.g. `.venv/bin/ruff format {file}`), and say where each came from; none is fine. Globs are `fnmatch` patterns (no `{a,b}` braces: one entry per extension).
   - Mention `spec.testMatrix` (default on) and `spec.qaModel` (`opus` or `sonnet`, default `opus`) and ask whether to change them.
5. Write plain JSON (no comments) to `.claude/devflow.json` with `"devflowVersion"` set to the installed plugin version (`version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`), and copy the schema to `.claude/devflow.schema.json` (the config's `$schema` is `./devflow.schema.json`). Write only what differs from the defaults: pipe the full config through `node "${CLAUDE_PLUGIN_ROOT}/bin/devflow-setup" minimal "${CLAUDE_SKILL_DIR}/templates/devflow.schema.json"` and write its output (required keys, `$schema` and `devflowVersion` always stay). If a config already exists, show the diff first and apply only after a yes; keys the project set explicitly stay, even when they equal a default.
6. Validate the written file against the schema (all required keys present, types right, no unknown keys).

## 3. Check CLAUDE.md

The workflows rely on CLAUDE.md for: architecture and layer rules, conventions (commit format, language), how tests are written, and a "Never" list. List what is missing or vague. Offer to draft additions. Never edit CLAUDE.md without an explicit yes.

## 4. GitHub Actions and permissions

Ask separately for each (a separate yes each; copy only if the target is absent, otherwise show a diff):

First choose the install mode for the review and the merge gate (AskUserQuestion, one answer for both):

- **Reusable, pinned to a tag** (recommended): thin callers from `${CLAUDE_SKILL_DIR}/templates/github/callers/` that run the workflows of the devflow repository (`nhanle-agilityio/devflow/.github/workflows/devflow-review.yml` and `devflow-merge-gate.yml`) at the tag `v<plugin version>`; replace every `{{DEVFLOW_REF}}` with that tag. Upgrades then only move the tag, and no gate script is copied. Before proposing it, check that the tag exists on the devflow repository (`list_tags`); if it does not, say so and recommend copy mode. When the devflow repository is private, its owner must allow Actions access from this repository (devflow Settings > Actions > General > Access > "Accessible from repositories owned by the user"), and the gate needs a `DEVFLOW_READ_TOKEN` secret that can read devflow; a public devflow needs neither.
- **Copy** (fallback, works everywhere): full copies of the templates in `${CLAUDE_SKILL_DIR}/templates/github/workflows/` plus the gate script, as before.

Then, for each (a separate yes each; write only if the target is absent, otherwise show a diff):

- Review: reusable mode copies `callers/claude-code-review.yml`, copy mode `workflows/claude-code-review.yml`, to `.github/workflows/claude-code-review.yml`.
- Merge gate: reusable mode copies `callers/devflow-merge-gate.yml` to `.github/workflows/devflow-merge-gate.yml`; copy mode copies `workflows/devflow-merge-gate.yml` there and `${CLAUDE_SKILL_DIR}/templates/github/scripts/devflow-merge-gate.cjs` to `.github/scripts/devflow-merge-gate.cjs` (one yes for the pair). In either file, fill the `workflow_run` `workflows:` list with the names of the project's CI workflows (the `name:` of each file in `.github/workflows/` that runs the checks; list what you chose) and keep `"Claude Code Review"`.
- Copy `${CLAUDE_SKILL_DIR}/templates/github/workflows/claude.yml` to `.github/workflows/claude.yml` (always a copy).

Tell the user the required setup for what was added:

- Repository secret `CLAUDE_CODE_OAUTH_TOKEN` (review and mention workflows).
- Merge gate: repository secret `DEVFLOW_GATE_TOKEN`, a fine-grained personal access token limited to this repository with Contents read/write and Pull requests read/write. The Actions `GITHUB_TOKEN` cannot be used: pushes and merges made with it do not trigger CI.
- Repository settings: enable "Allow merge commits" (stacked PRs need merge commits).
- The gate workflow must be on the repository's default branch: `workflow_run` and status triggers run from there. Merge the PR that adds it before expecting it to act.
- The gate stays inert until `mergeGate.enabled` is true and logs only while `mergeGate.dryRun` is true.

Worktrees: the worktree directory (`worktree.dir`, default `.claude/worktrees/`) must not be committed. Show the diff that adds it to `.gitignore` and apply it only after a yes.

Background sessions: the sessions `/devflow:dispatch` starts cannot answer permission prompts, so anything not allowed is refused and the run stalls. A plugin cannot grant permissions, so the project needs allow rules in `.claude/settings.json`. Generate them from the config: `node "${CLAUDE_PLUGIN_ROOT}/bin/devflow-setup" allow --github-mcp '<the GitHub MCP tool prefix shown by /mcp, e.g. mcp__github__*>' < .claude/devflow.json` (rules for the git commands the workflows use, `git push` to the configured remote, each `checks[].run`, `verify.devServer.run` and `worktree.setup` command, `curl` for `http` verify, the browser tool's MCP tools and the GitHub MCP tools). Merge them with the existing `allow` list, show the result as a diff and write only after a yes. The rules are specific prefixes: never a bare interpreter, shell or runner (`python3`, `node`, `bash`, `npx`, `uv`, `env`, `sudo`, ...); runners keep their flags and tool (`Bash(python3 -m pytest:*)`, `Bash(node --test:*)`), and `curl` is scoped to the dev server origin. Commands with no safe specific prefix (`bash -c "..."`, `env FOO=1 ...`, `python3 -c ...`) come back in `manual`: list them and tell the user to allow them by hand if they want to.

Write no `deny` rules: the plugin guard hook already blocks merging PRs, force pushes, pushes to protected branches, destructive git commands and `git add -A`. Leave existing deny rules alone; `/devflow:doctor` lists the ones the guard covers as removable.

## 5. Remind

Tell the user: the plugin hooks block merging PRs, pushing to protected branches (`baseBranch` plus `protectedBranches`), destructive git commands and `git add -A`; they also run the `format` commands after each edit and give every session the workflow rules. Project copies of those (a `block_git_add_all.py` hook, deny rules, a project `code-reviewer` agent) are no longer needed: `/devflow:doctor` lists them. GitHub MCP must be connected for the other workflows; run `/devflow:spec <idea>` next.

Do not commit or push anything.

## Upgrade (`--upgrade`)

For a project that already ran init. Needs a clean working tree and `.claude/devflow.json` (otherwise tell the user to run `/devflow:init` without the flag). Do not touch the project's other files.

1. Read the installed plugin version (`version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`) and the project's `devflowVersion` (missing means unknown).
2. Compare byte for byte every installed template file the project has with the plugin's template: `.github/workflows/claude-code-review.yml`, `.github/workflows/devflow-merge-gate.yml`, `.github/workflows/claude.yml`, `.github/scripts/devflow-merge-gate.cjs` (from `${CLAUDE_SKILL_DIR}/templates/github/`) and `.claude/devflow.schema.json` (from `${CLAUDE_SKILL_DIR}/templates/devflow.schema.json`, always managed: the project's copy must match the installed plugin). A workflow that `uses: nhanle-agilityio/devflow/.github/workflows/...@<tag>` is a reusable-mode caller: compare it with `templates/github/callers/` with `{{DEVFLOW_REF}}` set to the new tag, so an upgrade moves the tag (check the tag exists first). Skip templates the project never installed. List the drifted ones, and offer the switch from copy mode to reusable mode (or back) as one more item.
3. List the config keys present in the template but missing in the project's config, with their defaults. Do not add keys whose default is fine unless the user asks for them to be written; init writes only non-default keys, so a missing key is normal. Also list keys whose value now equals the default as removable (`devflow-setup minimal`), changed only after a yes.
4. Show the plan: the version change, the drifted files, the missing keys. For each drifted file show the diff and ask per file (we cannot tell whether the project edited it after install, so always show the diff); a file the user declines is left as it is. The merge gate workflow's `workflow_run` `workflows:` list was filled in by init: keep the project's list when copying that file.
5. After a yes: create branch `chore/devflow-upgrade-<version>` from `<remote>/<baseBranch>`, copy the accepted templates, update `.claude/devflow.schema.json`, set `devflowVersion` (and any keys the user asked for) in `.claude/devflow.json`, and validate it against the new schema.
6. Commit `chore(devflow): upgrade templates to devflow <version>` (stage the files by name, no attribution trailer), push the branch normally, and open a PR against `baseBranch` with the GitHub MCP, labelled `labels.devflow` and `labels.riskHigh` (it touches `.github/**` and `.claude/**`, so a human merges). If PR creation fails, print a pre-filled compare link instead (`https://github.com/<owner>/<repo>/compare/<baseBranch>...chore/devflow-upgrade-<version>?expand=1`).
7. Remind the user: a changed merge gate workflow only acts once it is on the default branch; secrets and settings from the first init still apply.

Never merge the PR, never push to the base branch, never force push.
