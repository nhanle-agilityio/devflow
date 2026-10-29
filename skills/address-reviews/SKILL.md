---
name: address-reviews
description: Resolve unresolved review comments on the PRs devflow opened: classify each thread, push fixes as new commits, reply on every thread, and optionally request one more automated review.
argument-hint: "[#pr ...]"
disable-model-invocation: true
---

# /devflow:address-reviews

Arguments: $ARGUMENTS

Rules: GitHub operations go through the GitHub MCP server (load its tools with ToolSearch). Fixes are new commits; never rewrite pushed history; never merge; never push to a protected branch. No `Co-Authored-By` or AI attribution in commits or replies. Follow `CLAUDE.md` and `.claude/devflow.json` (if the config is missing, tell the user to run `/devflow:init` and stop).

## 0. Targets

- Explicit `#pr` numbers in `$ARGUMENTS` are the targets.
- Otherwise: open PRs authored by the current user (get the authenticated user) whose linked issue (`Closes #<n>`) carries `labels.review`.
- Require a clean working tree and note the current branch (restored at the end). Report and skip a PR whose head branch is on a different repository (fork).

Repeat steps 1 to 6 for each PR, one at a time.

## 1. Read the threads

Read the review threads and the latest review summary comment. Keep only unresolved, actionable threads. Ignore threads already answered by you.

## 2. Classify

For each thread decide one of:

- **fix**: valid and in scope.
- **answer**: a question; reply with the answer.
- **won't fix**: out of scope or wrong. Say why and cite `CLAUDE.md` or the linked spec.

If a thread needs a product decision, do not decide silently: ask the user.

## 3. Apply fixes

Check out the PR branch. Apply the fixes as new commits, one per logical change: `fix(<scope>): address review - <what>` (scope from `commitScope`, issue number from the PR's `Closes` line). Stage files by name. Run every command in `checks`; all must pass. Push the branch (`git push <remote> <branch>`; plain push, no force).

## 4. Reply

Reply on every thread: "fixed in <sha>", the answer, or "won't fix" with the reason.

## 5. Re-review

If anything was fixed and the repo has `.github/workflows/claude-code-review.yml`, post one comment on the PR asking for another review, then count rounds:

- Round count = the number of such re-review comments already on the PR (comments by the current user whose body starts with the trigger below).
- If the count has reached `nextTask.maxReviewRounds` (default 2), do not post; tell the user instead.
- Otherwise post exactly this comment body (this is the one deliberate place the review bot's handle may be written): `@claude review again`

## 6. Restore and summarise

Switch back to the starting branch. Print a table: PR, fixed, answered, won't fix, rounds left.
