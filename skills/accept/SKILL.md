---
name: accept
description: BA acceptance after merge. Check the merged behavior of a spec against its acceptance criteria on a fresh checkout of the base branch, then turn every gap into a same-day gap issue and post the result on the spec PR. Never merges.
argument-hint: <spec path or slug>
disable-model-invocation: true
---

# /devflow:accept

Arguments: $ARGUMENTS

The BA step after merge: does what shipped match what the spec promised? Rules: use the GitHub MCP server for every GitHub operation (load its tools with ToolSearch); `gh` only if MCP is unavailable. Never merge a PR, never push to the base branch, never force-push. This skill changes no tracked file and makes no commit. Everything posted is English. No `Co-Authored-By` or AI attribution in issues or comments. Never write the review bot's at-sign handle anywhere. Follow `CLAUDE.md` and `.claude/devflow.json`. Run the checks with the model in `accept.model` (`sonnet` or `opus`, default `sonnet`): when the current model differs, do the walk in step 4 with an Agent of that model and give it the criteria and the run instructions.

**Merged state:** never trust a `merged` field from a PR list or search result; the GitHub MCP list tools report `merged: false` for merged PRs. A PR is merged when `pull_request_read` (method `get`) returns a non-null `merged_at`, or when `git merge-base --is-ancestor <head sha> <remote>/<baseBranch>` succeeds after a fetch. Closed with neither: closed without merging. Take "merged by" and "merged at" from `pull_request_read`, not from a list.

## 0. Preflight

Fail fast with a clear message if any check fails.

1. `.claude/devflow.json` exists and parses as JSON. If not, tell the user to run `/devflow:init`. `verify.devServer` and a non-empty `verify.modes` are needed; without them say acceptance cannot run and stop.
2. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
3. The working tree is clean (`git status --porcelain` is empty). Note the current branch (or detached HEAD) to restore at the end.
4. `git fetch <remote> <baseBranch>` succeeds (`remote` is `github.remote`, default `origin`).
5. `$ARGUMENTS` names a spec: a path under `specDir` (default `docs/specs`) or a slug. If empty, list the specs on the base branch (`git ls-tree --name-only <remote>/<baseBranch> <specDir>/`) and ask which one.

## 1. Resolve the spec and its issues

1. Find the file on the base branch only: `git show <remote>/<baseBranch>:<specDir>/<file>`. For a slug, match the file name that ends in `<slug>.md`; if several match, ask. If none, tell the user the spec is not on the base branch (its spec PR is not merged) and stop.
2. List its tasks (`T1..Tn`), the acceptance criteria of each and the Test matrix rows with level `http` or `e2e`.
3. Search the repository's issues (open and closed) whose body links the spec file; they are the spec's issues. Match them to tasks by the `T<n>` in the title.
4. Report each issue's state and its closing PR (merged or not, merged per the Merged state rule). If some are still open, say acceptance covers only the merged ones and continue with their criteria. If none is merged, say there is nothing to accept yet and stop.

## 2. Fresh worktree of the base

Run on what actually shipped, not on the user's checkout.

1. `git worktree add --detach <worktree.dir>/accept-<slug> <remote>/<baseBranch>` (`worktree.dir` default `.claude/worktrees`). If that path exists, remove the stale worktree first (`git worktree remove --force`) only when `git status --porcelain` inside it is empty; otherwise stop and report it.
2. In the worktree run each `worktree.setup` command, in order. If one fails, remove the worktree and stop with the output.

## 3. Verify lock

`verify.lock` (default true) keeps two verification runs from sharing the dev server port. When it is not `false`:

1. Acquire: `mkdir "$(git rev-parse --git-common-dir)/devflow-verify.lock"`. If it fails, retry every 10 seconds, up to 10 minutes, then stop and say who holds it.
2. A lock directory older than 30 minutes is stale: remove it and acquire again.
3. Release it (`rmdir`) at the end of step 4 in every case, also when a step fails. Never leave the lock behind.

## 4. Walk the criteria

Inside the worktree:

1. Start `verify.devServer.run` in the background and poll `verify.devServer.url` until it answers (give up after `readyTimeoutSec`, default 60).
2. Walk EVERY acceptance criterion of every merged task, plus every Test matrix row with level `http` or `e2e`. Use only the allowed `verify.modes`: `http` with curl (compare status and body to the criterion), `browser` with `verify.browserTool` (`playwright`: load the Playwright MCP tools with ToolSearch; `chrome`: Claude in Chrome tools) acting as the user and reading the page. Do not edit or commit any file.
3. Record per criterion: `pass`, `fail` or `not checkable` (no allowed mode can observe it, or the dev server cannot start), with expected versus actual evidence (request and response, or the visible result).
4. ALWAYS stop the dev server, make sure nothing still listens on its port, release the lock and remove the worktree (`git worktree remove --force <path>`), also when a step failed. Switch back to the starting branch if you changed it.

## 5. Gaps

For each `fail`:

1. Search open issues for a duplicate (same spec and criterion). If one exists, link it in the table and create nothing.
2. Otherwise draft a gap issue:
   - Title: `[<slug>] Gap: <criterion, short>`.
   - Body, following the issue template of `/devflow:spec`: **Context** (spec link on the base branch, the criterion, the original issue and PR), **Expected**, **Actual** (the evidence), **Acceptance criteria** (the spec's criterion as a checklist item), **Risk** (`Risk: low - <reason>`; `high` when the gap touches something `risk.highWhen` or `risk.highPaths` describes; unsure means high), **Depends on** none.
   - Labels: `labels.ready`, `labels.riskLow` or `labels.riskHigh`, plus every label in `accept.labels` (default `["type:gap"]`).

Show the drafted list (title, risk, criterion) and create the issues only after the user's yes: one confirmation for the whole batch. If the user declines, create nothing and say so in the report. `not checkable` items are listed for a human; they get no issue.

## 6. Report on the spec PR

Find the spec's PR (the merged PR that added the spec file; `git log <remote>/<baseBranch> --diff-filter=A -- <file>` then the PR for that commit). If it is not found, use the last merged PR among the spec's issues. Post one comment starting with `<!-- devflow-accept -->` containing the table (task, criterion, result, evidence in one line), the counts (pass, fail, not checkable), the issues not yet merged that were left out, and links to the new or existing gap issues. Edit this comment in place on a re-run instead of adding another.

Print the same table in the chat, then the gap issues created, the ones waiting for a human, and the comment link. Mention that `/devflow:next-task` picks up the gap issues like any other ready issue, and `/devflow:release` includes this result in the notes.

Never merge a PR, never push to the base branch.
