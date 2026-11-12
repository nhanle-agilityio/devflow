---
name: dispatch
description: Split the ready GitHub issues into non-colliding lanes (by hotspot files and dependencies) and start one background Claude session per lane, each running /devflow:next-task in its own worktree. Never merges.
argument-hint: "[max lanes]"
disable-model-invocation: true
---

# /devflow:dispatch

Arguments: $ARGUMENTS

Plans which ready issues can run in parallel and starts one background session per lane. Running this command is the user's go-ahead to start the sessions. This skill makes no commits, never merges and never pushes to a protected branch.

## 0. Preflight

Fail fast with a clear message if any check fails.

1. `.claude/devflow.json` exists and parses as JSON. If not, tell the user to run `/devflow:init`.
2. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
3. `claude --version` works (Bash).
4. The working tree is clean (`git status --porcelain` is empty).

## 1. Collect the schedulable issues

Using the GitHub MCP server (`github.owner` / `github.repo`), list open issues labelled `labels.ready` that are not labelled `labels.inProgress`, `labels.blocked` or `labels.triage` (default `needs-triage`). Lanes are planned by hotspots and dependencies only; inside a lane the issues run parents first, and priority (`labels.priority`) only breaks ties in that order. Apply the same rules as the `/devflow:next-task` engine's Select stage:

- Skip an issue that has an open PR closing it ("Closes"/"Fixes" lines, branch names, search open PRs for `#<n>`). Exception: do not skip it when its only open PR is labelled `labels.devflow` and has a `Closes #<n>` line for it, and the issue is not labelled `labels.review`; the run resumes that PR's branch. Any other open PR referencing the issue still skips it.
- Read `Depends on #N` lines from the body. Dependencies that are closed do not count.
- An issue with an open dependency that has no open PR and is not itself in this ready set is not schedulable. List it as "waiting for #N" and leave it out of the plan.
- An open dependency that has an open PR, or that is in the ready set, is fine.

For each schedulable issue build `{"number": N, "hotspots": [...], "dependsOn": [...]}`:

- `hotspots`: the bullet lines under the issue body's `## Hotspots` heading, backticks stripped, trimmed. Skip empty lines and a bare "None". Hotspots matching `dispatch.ignoreHotspots` are dropped by the planner in step 2.
- `dependsOn`: every issue number from its `Depends on #N` lines (open or closed; the planner ignores numbers outside the set).

## 2. Plan the lanes

`maxLanes` = the argument if it is a positive integer, else `dispatch.maxLanes` from the config (3 if unset). Run via Bash, with the JSON on stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/devflow-lanes" <<'JSON'
<json>
JSON
```

(A quoted heredoc, so quotes or `$` in hotspot paths cannot break the shell command.)

Input: `{"maxLanes": N, "ignoreHotspots": [...], "issues": [...]}`, with `ignoreHotspots` = `dispatch.ignoreHotspots` from the config (`["README.md", "CHANGELOG.md"]` if unset; exact paths or globs with `*` and `**`). Conflicts in such files are small and are resolved by the merge gate's branch update or `/devflow:sync`, so they do not join lanes. Output: `{"lanes": [{"issues": [...], "sharedHotspots": [...]}], "deferred": [{"issues": [...], "reason": "..."}], "ignoredHotspots": [...], "warnings": [...]}`. If it exits non-zero, show the message and stop. Show any `warnings`.

If there are no lanes, say so (and list the waiting issues) and stop.

## 3. Show the plan, then start

Print a table: lane, issues in run order, shared hotspots. Below it, list the ignored hotspots (`ignoredHotspots`, "not used for lanes: ..."), deferred lanes with their reason and the "waiting for #N" issues. Then continue straight to step 4; do not ask again.

## 4. Start one background session per lane

For lane `n` (1-based) with issues `#a #b ...`, run via Bash:

```bash
claude --bg --name devflow-lane-<n> "/devflow:next-task #a #b --chain --isolated"
```

Add `--plugin-dir <dispatch.pluginDir>` right after `--bg` when that config key is set. Capture the short session id the command prints. Keep `--chain --isolated` even for a single-issue lane.

If `claude --bg` fails (not available, "Workspace not trusted", or any other error), stop starting further lanes. For the failed lane and every lane not yet started, print the exact command the user can run in a separate terminal instead:

```bash
claude -w lane-<n> "/devflow:next-task #a #b --chain --isolated"
```

(with `--plugin-dir <dispatch.pluginDir>` when set).

## 5. Report

Print a table: lane, background session id, issues. Then explain:

- Follow the sessions with `claude agents`, `claude logs <id>`, `claude attach <id>`.
- Each session claims its issues first; if an issue in a lane was already claimed elsewhere or gets blocked, the lane continues with the next issue, stacked on the last issue that shipped (or from the base); only issues with a real `Depends on` the failed one are skipped. Each posts a plan on every issue, implements test-first, and opens PRs stacked on the previous issue's PR inside its lane.
- Who merges: the merge gate merges `risk:low` PRs bottom-up once its checks are green; `risk:high` PRs wait for a human. `/devflow:sync` handles conflicts and retargeting.
- Background sessions cannot answer permission prompts. If one stalls, check the permissions step of `/devflow:init` (the allow-list snippet) and re-run the lane.

Never merge a PR, never push to the base branch.
