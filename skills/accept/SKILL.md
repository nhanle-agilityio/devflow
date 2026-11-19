---
name: accept
description: BA acceptance after merge. Check the merged behavior of a spec against its acceptance criteria on a fresh checkout of the base branch, then turn every gap into a same-day gap issue and post the result on the spec PR, or on the epic when given an epic. Never merges.
argument-hint: <epic #n | spec path or slug>
disable-model-invocation: true
---

# /devflow:accept

Arguments: $ARGUMENTS

The BA step after merge: does what shipped match what the spec promised? Rules: use the GitHub MCP server for every GitHub operation (load its tools with ToolSearch); `gh` only if MCP is unavailable. Never merge a PR, never push to the base branch, never force-push. This skill changes no tracked file and makes no commit. Everything posted is English. No `Co-Authored-By` or AI attribution in issues or comments. Never write the review bot's at-sign handle anywhere. Follow `CLAUDE.md` and `.claude/devflow.json`. Run the checks with the model in `accept.model` (`sonnet` or `opus`, default `sonnet`): when the current model differs, do the walk in step 4 with an Agent of that model and give it the criteria and the run instructions.

**Merged state:** never trust a `merged` field from a PR list or search result; the GitHub MCP list tools report `merged: false` for merged PRs. A PR is merged when `pull_request_read` (method `get`) returns a non-null `merged_at`, or when `git merge-base --is-ancestor <head sha> <remote>/<baseBranch>` succeeds after a fetch. Closed with neither: closed without merging. Take "merged by" and "merged at" from `pull_request_read`, not from a list.

## 0. Preflight

Fail fast with a clear message if any check fails.

1. `.claude/devflow.json` exists and parses as JSON. If not, tell the user to run `/devflow:init`. `verify.devServer` and a non-empty `verify.modes` are not required: without `verify.devServer`, or with empty `verify.modes`, acceptance does not stop at preflight but runs in evidence-only mode (see step 4). Say so in one line.
2. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
3. The working tree is clean (`git status --porcelain` is empty). Note the current branch (or detached HEAD) to restore at the end.
4. `git fetch <remote> <baseBranch>` succeeds (`remote` is `github.remote`, default `origin`).
5. `$ARGUMENTS` names an epic or a spec. `#<n>` or `<n>` is an epic's issue number: a number is always an issue number, never a slug. Otherwise it is a spec: a path under `specDir` (default `docs/specs`) or a slug. If empty, list the specs on the base branch (`git ls-tree --name-only <remote>/<baseBranch> <specDir>/`) and ask which one.

## 1. Resolve the spec and its issues

**Epic (`#<n>` or `<n>`).** Read issue `#<n>` and collect its issue set as the union of two sources: the native sub-issues of the epic (`issue_read` method `get_sub_issues`) and the issues (open and closed) whose body has `Epic: #<n>`. Remove duplicates. If both sources are empty, stop with `#<n> is not an epic` and post nothing. The slug is the one in `[<slug>]` at the start of the epic's title, else `epic-<n>`; the worktree is then `accept-<slug>` (for example `accept-epic-<n>`). The gap-title prefix is `[<slug>]` when the title has one, else `[epic #<n>]`. Take the acceptance criteria and the Test cases rows with level `http` or `e2e` from each sub-issue's body (there is no spec file to read), then continue at item 4 below (state and closing PR of each issue). The skill never closes the epic. The spec path and slug flow below is unchanged.

1. Find the file on the base branch only: `git show <remote>/<baseBranch>:<specDir>/<file>`. For a slug, match the file name that ends in `<slug>.md`; if several match, ask. If none, tell the user the spec is not on the base branch (its spec PR is not merged) and stop.
2. List its tasks (`T1..Tn`), the acceptance criteria of each and the Test matrix rows with level `http` or `e2e`.
3. Search the repository's issues (open and closed) whose body links the spec file; they are the spec's issues. Match them to tasks by the `T<n>` in the title.
4. Report each issue's state and its closing PR (merged or not, merged per the Merged state rule). If some are still open, say acceptance covers only the merged ones and continue with their criteria. If none is merged, say there is nothing to accept yet and stop.

## 2. Fresh worktree of the base

Evidence-only mode skips steps 2 and 3: nothing is started, so no worktree and no lock are needed.

Run on what actually shipped, not on the user's checkout.

1. `git worktree add --detach <worktree.dir>/accept-<slug> <remote>/<baseBranch>` (`worktree.dir` default `.claude/worktrees`). If that path exists, remove the stale worktree first (`git worktree remove --force`) only when `git status --porcelain` inside it is empty; otherwise stop and report it.
2. In the worktree run each `worktree.setup` command, in order. If one fails, remove the worktree and stop with the output.

## 3. Verify lock

`verify.lock` (default true) keeps two verification runs from sharing the dev server port. When it is not `false`:

1. Acquire: `mkdir "$(git rev-parse --git-common-dir)/devflow-verify.lock"`. If it fails, retry every 10 seconds, up to 10 minutes, then stop and say who holds it.
2. A lock directory older than 30 minutes is stale: remove it and acquire again.
3. Release it (`rmdir`) at the end of step 4 in every case, also when a step fails. Never leave the lock behind.

## 4. Walk the criteria

**Evidence-only mode** (without `verify.devServer`, or with empty `verify.modes`): start no server and use no `http` or `browser` mode. Criteria that need a running app are `not checkable`. The other criteria take their result from evidence of the merged PRs (the closing PR of each merged issue): the merged PRs' checks (check runs and statuses on the head or merge commit), test-matrix rows, and manual rows recorded as pass in the PR body. `pass` when that evidence covers the criterion and is green, `fail` when it shows the criterion failing (a failed check or a row recorded as fail), and a criterion with no such evidence is `not checkable`. Never guess a result without evidence. Put the evidence (PR number, check name, row id) in the table. Step 5 and step 6 run as usual: it still posts the `<!-- devflow-accept -->` result on the epic or spec PR.

Otherwise, inside the worktree:

1. Start `verify.devServer.run` in the background and poll `verify.devServer.url` until it answers (give up after `readyTimeoutSec`, default 60).
2. Walk EVERY acceptance criterion of every merged task, plus every Test matrix row with level `http` or `e2e`. Use only the allowed `verify.modes`: `http` with curl (compare status and body to the criterion), `browser` with `verify.browserTool` (`playwright`: load the Playwright MCP tools with ToolSearch; `chrome`: Claude in Chrome tools) acting as the user and reading the page. Do not edit or commit any file.
3. Record per criterion: `pass`, `fail` or `not checkable` (no allowed mode can observe it, or the dev server cannot start), with expected versus actual evidence (request and response, or the visible result).
4. ALWAYS stop the dev server, make sure nothing still listens on its port, release the lock and remove the worktree (`git worktree remove --force <path>`), also when a step failed. Switch back to the starting branch if you changed it.

## 5. Gaps

For each `fail`:

1. Search open issues for a duplicate (same spec and criterion). If one exists, link it in the table and create nothing.
2. Otherwise draft a gap issue from the bug template `${CLAUDE_PLUGIN_ROOT}/skills/spec/templates/bug.md` (keep every heading):
   - Title: `[<slug>] Gap: <criterion, short>`; for an epic the title is `<prefix> Gap: <criterion, short>`, where the prefix is `[<slug>]` from the epic title, else `[epic #<n>]` (so `[epic #<n>] Gap: ...`).
   - **Context** (spec link on the base branch, the criterion, the original issue and PR), **Expected**, **Actual** (the evidence), **Repro**, **Introduced by** (the PR that closed the task, and the criterion id, e.g. "PR #54, AC2.5"), **Risk** (a suggestion: `low` or `high` against `risk.highWhen` / `risk.highPaths`; unsure means high), **Acceptance criteria** (the spec's criterion as a checklist item), **Scope**, **Test cases** (at least one `must` regression row), **Dependencies** None.
   - Labels: `labels.triage` (default `needs-triage`) plus every label in `accept.labels` (default `["type:gap"]`). Not `labels.ready`, no risk or priority label: a human triages the gap.
   - After creating it, comment on the issue: a suggested priority (one of `labels.priority`) and a suggested risk, each with a one-line reason, and that a human sets the labels and ready.

Show the drafted list (title, risk, criterion) and create the issues only after the user's yes: one confirmation for the whole batch. If the user declines, create nothing and say so in the report. `not checkable` items are listed for a human; they get no issue.

## 6. Report on the spec PR

For an epic, post the comment on the epic issue itself (no PR lookup), edited in place on a re-run; never close the epic. Otherwise find the spec's PR (the merged PR that added the spec file; `git log <remote>/<baseBranch> --diff-filter=A -- <file>` then the PR for that commit). If it is not found, use the last merged PR among the spec's issues. Post one comment starting with `<!-- devflow-accept -->` containing the table (task, criterion, result, evidence in one line), the counts (pass, fail, not checkable), the issues not yet merged that were left out, and links to the new or existing gap issues. Edit this comment in place on a re-run instead of adding another.

**Open follow-ups.** The result lists the open follow-ups filed from the epic's PRs: open issues labelled `labels.triage` (default `needs-triage`) whose body has a `Found in: #<pr>` line naming one of the epic's merged PRs (the closing PRs of its issues), with the issue link, title and `file:line` when recorded. It is a list for a human to triage, not a criterion result: no issue is created, changed or closed for it. With none, the result says "no open follow-ups". For a spec, the PRs are the closing PRs of the spec's issues. Put the list in the `<!-- devflow-accept -->` comment and print it in the chat.

Print the same table in the chat, then the gap issues created, the ones waiting for a human, and the comment link. Mention that the gap issues wait in `needs-triage`: once a human sets the priority and risk labels and swaps `needs-triage` for ready, `/devflow:next-task` picks them up like any other ready issue (fix issues get Root cause, Introduced by and Why it was missed in their PR), and `/devflow:release` includes this result in the notes.

Never merge a PR, never push to the base branch.
