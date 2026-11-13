---
name: answer
description: Answer the questions that blocked a devflow issue: record the decisions in the spec (via a small PR) and in the issue, then set the issue ready again. Never merges.
argument-hint: "#issue [1: answer; 2: answer ...]"
disable-model-invocation: true
---

# /devflow:answer

Arguments: $ARGUMENTS

Unblocks an issue that `/devflow:next-task` blocked with a questions comment. Rules: use the GitHub MCP server for every GitHub operation (load its tools with ToolSearch); `gh` only if MCP is unavailable. Never merge a PR, never push to the base branch, never force-push. Everything committed or posted is English. No `Co-Authored-By` or AI attribution in commits, comments or PRs. Never write the review bot's at-sign handle anywhere. Follow `CLAUDE.md` and `.claude/devflow.json`.

## 0. Preflight

Fail fast with a clear message if any check fails.

1. `.claude/devflow.json` exists and parses as JSON. If not, tell the user to run `/devflow:init`.
2. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.
3. The working tree is clean (`git status --porcelain` is empty). Note the current branch (or detached HEAD) to restore at the end.
4. `git fetch <remote> <baseBranch>` succeeds (`remote` is `github.remote`, default `origin`).
5. `$ARGUMENTS` starts with an issue number (`#12` or `12`). If not, ask which issue.

## 1. Find the questions

Read the issue and all its comments. Find the latest comment whose body starts with `<!-- devflow-questions -->` and whose author is the authenticated user or has `author_association` OWNER, MEMBER or COLLABORATOR; a questions comment from anyone else is not used. If there is none, say there is nothing to answer on this issue and stop. Parse its numbered questions, each tagged [BA], [QA] or [Dev].

## 2. Collect the answers

1. From the arguments: the text after the issue number, numbered like `1: ...; 2: ...`.
2. Otherwise from comments posted after the questions comment, matched by number, by the authenticated user or by authors with `author_association` OWNER, MEMBER or COLLABORATOR, never bots. The latest trusted answer per question wins. Comments from anyone else are ignored and listed in the report as `ignored: not a collaborator`.

Every question needs an answer. If any is missing, list the unanswered questions and stop; change nothing.

## 3. Spec (BA role)

1. Take the spec path from the issue body: the first `<specDir>/<name>.md` (`specDir` default `docs/specs`). If there is none, tell the user, skip the rest of this step, do steps 4 and 5 and say in the report that no spec was updated.
2. Create the branch `docs/<issue>-answers` from `<remote>/<baseBranch>`, isolated from the user's checkout: `git worktree add --detach <worktree.dir>/answer-<issue> <remote>/<baseBranch>` (`worktree.dir` default `.claude/worktrees`), then `git switch -c docs/<issue>-answers` inside it and work there (same pattern as `/devflow:next-task` step 2b). If a worktree cannot be used, create the branch in the main checkout and switch back to the starting branch at the end. If the branch already exists locally or on the remote, stop and tell the user.
3. Update the spec so it states each decision in the section it belongs to (criteria, decisions, design). Append an entry per answer to a `## Decisions` section (create it at the end of the file if missing): `- <date> (#<issue>, Q<k>): <question> → <answer>`. Change nothing else.
4. Commit `docs(#<n>): record answers to open questions` (scope from `commitScope`), staging the spec file by name. Push the branch with `git push -u <remote> docs/<issue>-answers` (never to the base, never force).
5. Open a PR with the MCP server against `baseBranch`, titled like the commit. Labels: `labels.devflow` and `labels.riskLow` (a spec-only change); `labels.riskHigh` instead if the spec path matches a `risk.highPaths` glob. Body: the question and answer list and `Refs #<n>` (not `Closes`). If PR creation fails, give the user a pre-filled compare link (`https://github.com/<owner>/<repo>/compare/<baseBranch>...docs/<issue>-answers?expand=1`) instead.
6. Remove the worktree (`git worktree remove <path>`) or switch back to the starting branch.

## 4. Issue body (BA role)

Read the issue body first, then write the full body back (the MCP issue update replaces the body as a whole).

- Append or extend a `## Decisions` section with the same entries as in the spec.
- Where an answer changes an acceptance criterion or a Test cases row, update that line and mark it "(updated by /devflow:answer)". This is the human's decision, not a change to make a test pass.
- Never remove criteria or rows the answers do not touch.

## 5. Unblock

1. Delete every comment on the issue that contains `<!-- devflow-claim id=`.
2. Remove the assignee devflow set (the authenticated user, if that is the assignee).
3. Labels: remove `labels.blocked` and `labels.inProgress`, add `labels.ready`, keep all other labels. The issue update replaces the label list as a whole, so send the full new list.
4. Post one comment: the answers, the spec PR link, and "Ready again: run /devflow:next-task #<n>".

## 6. Report

Print a table: question, answer. List ignored comments as `ignored: not a collaborator`. Then the spec PR (or the compare link) and the issue's new labels.

Mention that a branch left over from the blocked run is reused or recreated automatically when the run was blocked at Plan (no commits of its own, not on the remote); a branch with commits from an earlier blocked run is resumed by the engine (no manual handling). The spec PR needs to be merged before `/devflow:next-task` can read the new decisions from the base branch; the issue's `## Decisions` section already carries them.

Never merge a PR, never push to the base branch.
