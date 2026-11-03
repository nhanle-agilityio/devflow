---
name: doctor
description: Check that devflow works in this project (config, installed templates, GitHub access, worktrees, stale branches, claims, open PRs, allow-list) and report what to do. Read-only unless --fix, which fixes only what the user confirms item by item.
argument-hint: "[--fix]"
disable-model-invocation: true
---

# /devflow:doctor

Arguments: $ARGUMENTS

Reports the health of the devflow setup. Read-only by default. With `--fix`, change only what the user confirms, one item at a time (AskUserQuestion). Never merge, never force push, never push to the base branch or a protected branch, never delete a protected branch or the base. GitHub operations go through the GitHub MCP server (load its tools with ToolSearch). No `Co-Authored-By` or AI attribution anywhere.

**Merged state:** never trust a `merged` field from a PR list or search result; the GitHub MCP list tools report `merged: false` for merged PRs. A PR is merged when `pull_request_read` (method `get`) returns a non-null `merged_at`, or when `git merge-base --is-ancestor <head sha> <remote>/<baseBranch>` succeeds after a fetch. Closed with neither: closed without merging. Take "merged by" and "merged at" from `pull_request_read`, not from a list.

Run all checks even when one fails. If `.claude/devflow.json` is missing, report fail for check 1, suggest `/devflow:init`, and run only checks 3 and 8.

## Checks

1. **Config.** `.claude/devflow.json` parses and validates against `.claude/devflow.schema.json` (required keys, types, no unknown keys). Compare `devflowVersion` with the installed plugin version (`version` in `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`). A lower major or minor version, or a missing value: warn, suggest `/devflow:init --upgrade`. A lower patch version only is ok: patch releases never change templates, the schema or config keys.
2. **Templates.** Compare byte for byte every installed template file with the plugin's (the same list and comparison as `/devflow:init --upgrade`: the three workflows, `.github/scripts/devflow-merge-gate.cjs`, `.claude/devflow.schema.json`). List the drifted ones. Report only; the fix is `/devflow:init --upgrade`.
3. **GitHub access.** The GitHub MCP server is reachable (get the authenticated user). Check whether `gh` is installed (`gh --version`). Missing `gh` is only a warn; say that when `gh` is missing and the MCP connection drops, runs stop.
4. **Worktrees.** `git worktree list`, restricted to `worktree.dir`. For each: clean or dirty, branch, pushed or not (`git status --porcelain`, branch against `<remote>/<branch>`). `--fix`: remove (`git worktree remove`, no `--force`) the clean ones whose branch is pushed or merged; never a dirty one.
5. **Branches.** Local and remote branches matching `branchPattern` whose PR is merged (merged per the Merged state rule) or closed. `--fix`: delete the local ones (`git branch -d`; `-D` only when the PR is merged and the user confirms). Remote ones only after an explicit yes per branch (`git push <remote> --delete <branch>`); never the base, never `protectedBranches`, never a branch with an open PR.
6. **Claims.** Open issues labelled `labels.inProgress` with no running session (`claude agents`; none is working on it) and no open PR, older than 2 hours since the claim: stale. Also `<!-- devflow-claim ... -->` comments on issues that are not in progress: stale. Report both. `--fix`: after a yes per item, delete the stale claim comment and, for an in-progress issue, swap `labels.inProgress` for `labels.ready`.
7. **Open PRs.** Open PRs labelled `labels.devflow` that are behind their base, conflicting, or have red checks. Report them and point at `/devflow:sync #<pr>`. Never fix them here.
8. **Allow-list.** `.claude/settings.json` has the `permissions` rules background sessions need: the snippet in `${CLAUDE_PLUGIN_ROOT}/README.md`, a `Bash(<command>:*)` rule for each `checks[].run` and `worktree.setup` command, and the git commands the workflows use. List what is missing (warn). `--fix` after a yes: merge them in; never add a rule that allows merging a PR or pushing to a protected branch.

## Report

Print a table: check, status (`ok` / `warn` / `fail`), what to do. `fail` is something that stops the workflows (config invalid, MCP unreachable); `warn` is drift or leftovers. With `--fix`, add a line per fix applied or declined. End with the one command to run next, if any.
