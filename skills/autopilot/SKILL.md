---
name: autopilot
description: Run one approved epic in a self-paced loop, sync its PRs, handle collaborator requests and start ready lanes until all sub-issues close. Never merges. Invoke only when the user types /devflow:autopilot or a scheduled /loop prompt names /devflow:autopilot; never on your own because an epic or PRs are mentioned.
argument-hint: "#<epic>"
---

# /devflow:autopilot

Arguments: $ARGUMENTS

Run one tick in this order — **sync, comments, ready, dispatch, report**. The epic's plan comment is the checkpoint for the next tick.

## 0. Preflight

1. Accept one positive epic issue number with an optional leading `#`. Read `CLAUDE.md` and parse `.claude/devflow.json`. If the config is missing or invalid, stop and point to `/devflow:init`.
2. Load GitHub MCP tools with ToolSearch and call `get_me`. Use this server and the configured `github.owner` and `github.repo` for all GitHub operations.
3. Check that `claude --version` succeeds and `git status --porcelain` is empty. Stop on a failed check.
4. Read the epic with `issue_read`. Verify it is an issue and confirm the epic by its `type:epic` label or its sub-issues as in `/devflow:approve`. Require `labels.epicApproved` (default `epic:approved`). If approval is missing, stop with “approve it with /devflow:approve #<epic>”, substituting the issue number, and stop the autopilot loop for this epic if one is running.

## 1. Load or create the plan

Read all pages of comments on the epic. Find the plan comment starting with `<!-- devflow-autopilot-plan -->` from the authenticated user or a trusted collaborator. Ignore markers from other authors. Load the helper with `require(process.env.CLAUDE_PLUGIN_ROOT + '/bin/devflow-autopilot')` in Node. Pass the comment body to `parsePlan` and retain its comment ID. On a restart, resume with the saved children, dependencies, sessions, progress and `lastTick`. If the marked plan is unreadable, ambiguous or belongs to another epic, report the problem and stop.

On the first run, follow step 1 of the eligibility sweep in `${CLAUDE_PLUGIN_ROOT}/skills/approve/SKILL.md`. Paginate native sub-issues (`get_sub_issues`) and search open and closed issues with an exact `Epic: #<epic>` body line. Deduplicate same-repository issues by number. For each child store its number and all `Depends on #N` numbers from its body. Create the plan with `epic`, `children`, empty `lanesStarted` and `progress` arrays, and null `lastTick` and `lastDigestDate`. Post `renderPlan(plan)` on the epic and keep its comment ID. Complete discovery before treating an empty list as a finished epic.

## 2. Tick

**(a) Sync.** Capture a UTC cutoff for this tick's comment scan before doing any work. Start the tick's agent-call counter at zero. Find the open PRs labelled `labels.devflow` that close the epic's children. For those PR numbers, follow `${CLAUDE_PLUGIN_ROOT}/skills/sync/SKILL.md` in unattended mode, parents first. Apply its retarget, branch update, conflict and review-thread rules. Defer any operation that would modify an issue carrying `labels.inProgress`. With no target PRs, continue to comments.

**(b) Comments.** Paginate issue and PR comments for the epic, its children and their PRs. Read the interval after the saved `lastTick` through the cutoff (all history through the cutoff on the first tick). Process requests in timestamp order. Only act on human comments whose GitHub `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. Ignore everyone else, the plan itself and generated status messages. Use the comment ID or permalink to identify each request across retries.

For a trusted answer to an outstanding question, follow `${CLAUDE_PLUGIN_ROOT}/skills/answer/SKILL.md`, including its rules for numbered answers, explicit `accept`, decisions and unblocking. Keep incomplete answers pending. For another in-scope request, record the request and source in the plan for the next lane run. Before that lane starts, put the instruction in the child's context so the lane can read it. For a running child, keep the request on the epic until the lane finishes. Record what was applied or queued, its source and the outcome in `plan.progress` as rows with string fields `item` and `detail`. On a retry, reconcile the decisions and prior rows before repeating a write.

**(c) Ready.** Refresh every planned child and its dependencies. Build the helper's JSON input using current GitHub data.

- Set `now` to the current UTC timestamp, `labels` to the configured label map and `autoReady` to `spec.autoReady` (default `off`). Set `maxLanes` from `autopilot.maxLanes`, then `dispatch.maxLanes`, then 3.
- Set `maxAgentCallsPerTick` from `autopilot.maxAgentCallsPerTick` (default 20), `agentCallsUsed` to the calls already made **this tick**, and `nextTaskMaxAgentCalls` from `nextTask.maxAgentCalls` (default 0). Count agent calls during sync and comment handling against the tick limit. Each lane start costs one more. Set `stallHours` from `autopilot.stallHours` (default 12) and `ignoreHotspots` from `dispatch.ignoreHotspots` (default `["README.md", "CHANGELOG.md"]`).
- For each entry in `children`, supply `number`, lowercase `state`, label names, current `body`, `hotspots` from the `## Hotspots` bullets as in dispatch, and all `dependsOn` numbers. Set `lastActivity` to the newest commit or comment timestamp on the issue or its PR, or null if neither exists.
- Supply the child's own `pr` as null or `{number, state, merged, aheadBy}`. Prefer a qualifying open PR over a closed one. For an open PR compare its actual `base...head` through MCP and take `ahead_by`. For a closed PR verify `merged_at` with `pull_request_read` method `get`. For dependencies outside the epic, put their `number`, `state`, `labels` and `pr` in `external` using the same rules. Leave unreadable external dependencies out and report the read failure. If a child's state or own PR data cannot be read, report it and retry before planning.

Serialize the input as JSON and run the helper via Bash with a quoted heredoc. Stop the tick on a nonzero exit and show its diagnostic.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/devflow-autopilot" <<'JSON'
<state JSON>
JSON
```

For each number in `ready`, apply step 3 of the approve sweep. Immediately before writing, re-read the epic's approval and the child's state and labels. Stop if approval was withdrawn. Skip a child that closed or gained `labels.ready`, `labels.inProgress`, `labels.review`, `labels.blocked` or `labels.triage`. Preserve every existing label and add only `labels.ready`. After adding it, check all comments and post the following once if its marker is absent.

```text
<!-- devflow-auto-ready -->
Ready: epic #<epic> approved, all dependencies merged
```

Report a failed write and continue with the other entries. Use the real epic number in the comment.

**(d) Dispatch.** Start only lanes in `dispatch`. Recheck approval, the ready labels, open PRs and claims before launch. If eligibility or capacity changed, refresh the input and replan with the calls used so far. Check recorded session IDs and `claude agents --json` (it prints the sessions and exits) for still-running sessions, including lanes awaiting their first claim or handling later issues in a chain. Defer a lane if it overlaps an active session or starting it would exceed the concurrency limit. Never touch issues labelled `labels.inProgress` and never restart a stalled lane automatically.

Follow step 4 of `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/SKILL.md`. For lane `n` use its actual issue numbers in the helper's order, keeping both flags even for a single issue.

```bash
claude --bg --name devflow-lane-<n> "/devflow:next-task #a #b --chain --isolated"
```

When set, add `--plugin-dir <dispatch.pluginDir>` immediately after `--bg`. After each successful launch, append its issues and returned session ID to `lanesStarted` and checkpoint the plan comment in place. If a launch fails, stop starting lanes and print the exact manual command for the failed lane and each remaining lane, with the configured plugin directory when set.

```bash
claude -w lane-<n> "/devflow:next-task #a #b --chain --isolated"
```

**(e) Report.** Update the same comment by ID with `renderPlan(plan)`. Advance `lastTick` to the cutoff after the entire comment window has been processed or its outstanding requests saved. Preserve `lastDigestDate`, the session history and applied or pending requests. Refresh the progress rows for this tick with running and stalled issues, each waiting reason, stacked issues and their parents, actual starts, warnings and the used and remaining agent budget. Reconcile `budgetLeft` for any planned lanes that did not launch. Surface the helper's warning when `nextTask.maxAgentCalls` is 0 (unlimited inside each lane). Report write failures and resume from the last saved checkpoint.

When `lastDigestDate` differs from today's local date or the tick returns `done: true`, read `${CLAUDE_PLUGIN_ROOT}/skills/report/SKILL.md` and follow its `--daily` section for this epic to gather the data and render it with `bin/devflow-digest` (do not invoke `/devflow:report`: it is user-only). The completion tick refreshes the digest even if an earlier tick posted today.

Use the digest's date in the first line of the comment, `<!-- devflow-digest YYYY-MM-DD -->`, followed by the rendered Markdown. Read all pages of the epic's comments and find the matching dated marker from autopilot. If it exists, edit that comment in place. Otherwise post the digest on the epic. After the write succeeds, set `lastDigestDate` to the digest's date and save the plan comment by ID. On a failure, report it and retry from the saved plan, checking the dated marker again before posting.

## 3. Loop

If the helper returned `done: true`, go straight to Finish. Otherwise, when outside a loop, invoke the loop skill with `/loop /devflow:autopilot #<epic>`, substituting the number. Each later invocation runs one tick. Keep one loop per epic. Choose the next wake-up from the work pending. Allow about 20–30 minutes for running lanes or PRs awaiting checks or review, and a longer interval when only human action is pending.

## 4. Finish

When every sub-issue is closed, post a final report on the epic listing the closed sub-issues, linked PRs and who merged each, decisions taken, and bugs filed. Use individual PR reads and the merge gate's evidence as in `/devflow:report`. Identify any PR closed unmerged. Reuse the final report if a restart finds it already posted. Stop the loop for this epic.

## Rules

Never merge a PR, never push to a protected branch, never force push and never edit acceptance criteria. Report stalled lanes for human attention. Write everything posted to GitHub in English.
