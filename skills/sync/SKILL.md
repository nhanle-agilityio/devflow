---
name: sync
description: Keep devflow PRs mergeable: retarget stacked PRs whose parent merged, update behind branches, resolve merge conflicts, and address unresolved review threads. Never merges.
argument-hint: "[#pr ...]"
disable-model-invocation: true
---

# /devflow:sync

Arguments: $ARGUMENTS

Rules: GitHub operations go through the GitHub MCP server (load its tools with ToolSearch). Only new commits and normal pushes: never rebase, never rewrite pushed history, never force-push, never merge a PR, never push to a protected branch. No `Co-Authored-By` or AI attribution in commits, comments or replies. Never write the review bot's at-sign handle anywhere. Follow `CLAUDE.md` and `.claude/devflow.json` (if the config is missing, tell the user to run `/devflow:init` and stop).

**Merged state:** never trust a `merged` field from a PR list or search result; the GitHub MCP list tools report `merged: false` for merged PRs. A PR is merged when `pull_request_read` (method `get`) returns a non-null `merged_at`, or when `git merge-base --is-ancestor <head sha> <remote>/<baseBranch>` succeeds after a fetch. Closed with neither: closed without merging. Take "merged by" and "merged at" from `pull_request_read`, not from a list.

## 0. Targets

- Explicit `#pr` numbers in `$ARGUMENTS` are the targets.
- Otherwise: all open PRs labelled `labels.devflow` and authored by the current user (get the authenticated user).
- Require a clean working tree and note the current branch (restored at the end). Report and skip a PR whose head branch is on a different repository (fork).

Repeat steps 1 to 5 for each PR, one at a time, parents before children. Stop a PR's steps early when a step blocks it, and go on to the next PR.

## 1. Retarget

If the PR is stacked (its base is not `baseBranch`) and the PR for its base branch is merged, or the base branch no longer exists on the remote: change the PR's base to `baseBranch` with the MCP `update_pull_request` tool. Remove `labels.stacked` from the PR. Continue with the new base.

## 2. Update when behind

Compare base...head (`behind_by`), or use what the MCP server reports about mergeability. If the branch is behind and merges cleanly, update it with the MCP `update_pull_request_branch` tool. Then continue (the head changed; fetch before step 3).

## 3. Conflicts

Skip when the PR has no conflicts. Otherwise:

1. `git fetch <remote>`, check out the PR branch, `git merge <remote>/<base>`. Never rebase.
2. Resolve each conflict using the linked issue (`Closes #<n>`) and the spec it links to decide the intent of both sides; keep both behaviours when they do not exclude each other. Stage files by name.
3. Run every command in `checks`; all must pass.
4. Commit the merge (`merge(<scope>): sync with <base>`, scope from `commitScope`) and push normally (`git push <remote> <branch>`). The merge gate labels a conflicting PR and its linked issue(s) `labels.blocked` and skips any PR carrying that label, so after a successful push remove `labels.blocked` from the PR and from the linked issue(s). Remove it from an issue only when nothing else blocks it (no unanswered question comment from the engine on the issue). When unsure, remove it from the PR only and tell the user.
5. If you cannot resolve a conflict with confidence, or the checks fail and you cannot fix them inside the conflict resolution: `git merge --abort`, add `labels.blocked` to the linked issue, comment on the issue with the conflicting files and the one question a human must answer, and move on to the next PR.

## 4. Review

Read the unresolved review threads and the latest review summary comment (MCP). Keep only unresolved, actionable threads; ignore threads you already answered. Classify each:

- **fix**: valid and in scope.
- **answer**: a question; reply with the answer.
- **won't fix**: out of scope or wrong. Say why and cite `CLAUDE.md` or the linked spec.

If a thread needs a product decision, do not decide silently: ask the user.

Apply fixes as new commits, one per logical change: `fix(<scope>): address review - <what>` (scope from `commitScope`, issue number from the PR's `Closes` line). Stage files by name. Run every command in `checks`; all must pass. Push normally. Reply on every thread: "fixed in <sha>", the answer, or "won't fix" with the reason. The merge gate ignores threads whose last comment is by the PR author, so a reply on every handled thread stops it from blocking the merge.

Pushing new commits re-runs the automated review by itself (the pull request `synchronize` event). Do NOT post any re-review trigger comment.

## 5. Round limit

A sync round is a run of steps 3 or 4 that changed or answered something. Count prior rounds on the PR by the hidden marker comment `<!-- devflow-sync -->`.

- Before step 3 and step 4: if the count has reached `nextTask.maxReviewRounds` (default 2), do nothing more on this PR and tell the user instead.
- After a round: post one comment on the PR that starts with `<!-- devflow-sync -->` and then a one-line summary (for example "Round 2: merged main (2 conflicts resolved), fixed 3 threads, answered 1.").

Steps 1 and 2 (retarget, update) do not count as rounds.

## 6. Restore and summarise

Switch back to the starting branch. Print a table: PR, retargeted, updated, conflicts (resolved / blocked), threads fixed / answered / won't fix, rounds left.
