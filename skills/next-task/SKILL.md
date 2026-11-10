---
name: next-task
description: Pick up ready GitHub issues and take each from implementation to an open PR (test first, checks, verification, review) by running the devflow:next-task-engine workflow. Never merges; the merge gate Action or a human does.
argument-hint: "[limit | #issue ...] [--isolated] [--chain]"
disable-model-invocation: true
---

# /devflow:next-task

Arguments: $ARGUMENTS

This skill is only the entry point. The work is done by the `devflow:next-task-engine` workflow. Running this command is the user's opt-in to run that workflow.

## 1. Preflight

Fail fast with a clear message if any check fails; do not start the workflow.

1. `.claude/devflow.json` exists and parses as JSON. If not, tell the user to run `/devflow:init`. Check `github`, `baseBranch` and `checks` are present.
2. The working tree is clean (`git status --porcelain` is empty).
3. Not isolated: note the current branch (`git branch --show-current`); it is restored after every issue. If HEAD is detached, stop and ask the user to switch to a branch. Isolated (`--isolated`): a detached HEAD is fine and there is no start branch.
4. `git fetch <remote> <baseBranch>` succeeds (`remote` is `github.remote`, default `origin`).
5. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
6. Note whether the `gh` CLI is installed (`command -v gh`); pass it as `ghCli`. Without it, a GitHub MCP outage stops the run with "GitHub MCP unavailable" instead of blocking issue after issue.

## 2. Parse the arguments

- A single number, e.g. `2`: `limit` = that number, `issues` = `[]`.
- Tokens like `#12 #15` (or `12,15` after a `#`): `issues` = those numbers, `limit` = their count.
- Empty: `limit` = `nextTask.defaultLimit` from the config (3 if unset), `issues` = `[]`.
- Flags, anywhere in the arguments: `--isolated` (run in a dedicated git worktree) and `--chain` (the explicit issues are a lane: run them in the given order, each stacked on the previous one). They combine with the forms above; `--chain` needs explicit issues.
- Anything else: ask the user what they meant.

## 2b. Isolated mode (only with `--isolated`)

Do this before calling the workflow.

1. If the session is already inside a linked worktree (`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`), use it as is. Otherwise: `name` = `issue-<first issue number>`, or `lane-<n1>-<n2>...` for several issues; run `git fetch <remote> <baseBranch>`, then `git worktree add --detach <worktree.dir>/<name> <remote>/<baseBranch>` (`worktree.dir` default `.claude/worktrees`; if that path already is a worktree from an earlier run, reuse it only when `git status --porcelain` there is empty, otherwise stop and report it), then call the EnterWorktree tool with that path (load it with ToolSearch `select:EnterWorktree` if it is deferred). If EnterWorktree is unavailable, stop and tell the user to start the session with `claude -w` instead.
2. In the worktree run each `worktree.setup` command, in order. If one fails, stop and show its output.
3. `claimId`: run `printf '%s-%s-%s' "$(date +%Y%m%dT%H%M%S)" "<name>" "$$$RANDOM"` and pass the output (the process id and random suffix keep two sessions started in the same second on the same issue apart). In a session already inside a worktree use the worktree folder name as `<name>`.

Not isolated: `claimId` is the same command with `<name>` = `main`.

## 3. Run the workflow

Call the Workflow tool with name `devflow:next-task-engine` and this `args` object (a real JSON object, not a string):

```json
{
  "config": "<the parsed contents of .claude/devflow.json>",
  "limit": 3,
  "issues": [],
  "startBranch": "<the current branch, \"\" when isolated>",
  "prTemplatePath": "${CLAUDE_SKILL_DIR}/templates/pr.md",
  "bugTemplatePath": "${CLAUDE_PLUGIN_ROOT}/skills/spec/templates/bug.md",
  "isolated": false,
  "chain": false,
  "claimId": "<from step 2b>",
  "ghCli": true
}
```

Fill `config` with the full parsed config object, and the other values from steps 1 and 2.

## 4. Report

Isolated mode first: if the worktree has no uncommitted changes (`git status --porcelain` empty) and every branch the run created is pushed, call ExitWorktree, then `git worktree remove <path>`. Otherwise call ExitWorktree and keep the worktree; tell the user its path and why.

Then print a table from the workflow result, one row per entry, using only its fields: issue, status, PR link with `risk` and `stackedOn` (a list, empty when not stacked), or the `reason` for blocked and skipped (including `already claimed` / `claimed by <id>`: another session works on that issue), and a Notes column with the entry's `notes` joined by "; " exactly as returned. Do not add your own account of what happened in between (timing, why something was or was not stacked): the notes already state it, and anything else is a guess. Mention that blocked issues have a comment explaining what a human must decide. An issue blocked with questions (the comment starts with `<!-- devflow-questions -->`, numbered and tagged [BA], [QA] or [Dev]) is unblocked with `/devflow:answer #<n>`, which records the answers in the spec and the issue and sets the issue ready again. If an entry says "GitHub MCP unavailable", say the run stopped there, that the issue keeps its in-progress label and claim, and that `/devflow:doctor --fix` cleans that up once GitHub is reachable again.

Issues labelled `labels.triage` (default `needs-triage`) are never picked up; a human triages them and sets the ready label. The run order is dependencies first, then `labels.priority` (no label = normal), then issue number; priority never changes who merges.

Explain who merges: `risk:low` PRs are merged by the merge gate GitHub Action when it is enabled (`mergeGate.enabled`) and its required checks are green; `risk:high` PRs (and PRs without a risk label) wait for a human. A PR stacked on one or more other PRs is merged by the gate only after every dependency is closed; `risk:high` still waits for a human. `/devflow:sync` handles conflicts, retargeting of stacked PRs and review comments.

## 5. Notify

Only when `notify.push` is true (default true) and the PushNotification tool is available (load it with ToolSearch `select:PushNotification`; skip this step silently when it does not exist). Send one notification, at most 200 characters, naming the repository:

- `notify.onBlocked` (default true) and some issue is blocked: "devflow <repo>: #<n> blocked at <stage>" (all blocked issues, comma separated).
- `notify.onHighRisk` (default true) and a PR has risk high: "devflow <repo>: PR #<pr> is risk:high and waits for your merge".
- Otherwise `notify.onDone` (default true): "devflow <repo>: <k> PR(s) opened, <m> skipped".

Combine them into one message when several apply. This lets you follow background lanes (`/devflow:dispatch`) from your phone.

Never merge a PR, never push to the base branch.
