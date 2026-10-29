---
name: next-task
description: Pick up ready GitHub issues and take each from implementation to an open PR (test first, checks, verification, review) by running the devflow:next-task-engine workflow. Humans merge.
argument-hint: "[limit | #issue ...]"
disable-model-invocation: true
---

# /devflow:next-task

Arguments: $ARGUMENTS

This skill is only the entry point. The work is done by the `devflow:next-task-engine` workflow. Running this command is the user's opt-in to run that workflow.

## 1. Preflight

Fail fast with a clear message if any check fails; do not start the workflow.

1. `.claude/devflow.json` exists and parses as JSON. If not, tell the user to run `/devflow:init`. Check `github`, `baseBranch` and `checks` are present.
2. The working tree is clean (`git status --porcelain` is empty).
3. Note the current branch (`git branch --show-current`); it is restored after every issue. If HEAD is detached, stop and ask the user to switch to a branch.
4. `git fetch <remote> <baseBranch>` succeeds (`remote` is `github.remote`, default `origin`).
5. The GitHub MCP server is reachable: load its tools with ToolSearch and get the authenticated user.

## 2. Parse the arguments

- A single number, e.g. `2`: `limit` = that number, `issues` = `[]`.
- Tokens like `#12 #15` (or `12,15` after a `#`): `issues` = those numbers, `limit` = their count.
- Empty: `limit` = `nextTask.defaultLimit` from the config (3 if unset), `issues` = `[]`.
- Anything else: ask the user what they meant.

## 3. Run the workflow

Call the Workflow tool with name `devflow:next-task-engine` and this `args` object (a real JSON object, not a string):

```json
{
  "config": "<the parsed contents of .claude/devflow.json>",
  "limit": 3,
  "issues": [],
  "startBranch": "<the current branch>",
  "prTemplatePath": "${CLAUDE_SKILL_DIR}/templates/pr.md"
}
```

Fill `config` with the full parsed config object, and the other values from steps 1 and 2.

## 4. Report

When the workflow returns, print a table: issue, then PR link, or blocked with the reason, or skipped with the reason. Mention that blocked issues have a comment explaining what a human must decide, and that PRs are open for human review and merge. Remind the user that `/devflow:address-reviews` handles review comments.

Never merge a PR, never push to the base branch.
