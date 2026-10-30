# devflow

A Claude Code plugin with two project-agnostic workflows:

1. `/devflow:spec <idea>`: idea, analysis, grill-me interview, spec, QA test matrix, spec PR, Gate 1 (a human merges), then one GitHub issue per task labelled ready.
2. `/devflow:next-task [limit | #issue ...]`: pick up to N ready issues, implement each test first, run checks, verify against the running app, review, and open a PR. `/devflow:address-reviews` then resolves review comments on those PRs.

Nothing in the plugin knows about a specific stack. Project mechanics live in `.claude/devflow.json`; project rules (architecture, conventions, a "Never" list) live in the project's `CLAUDE.md`. See [DESIGN.md](DESIGN.md) for the full design.

## Install

```
/plugin marketplace add nhanle-agilityio/devflow
/plugin install devflow@nhanle-devflow
```

Requirements: Python 3.9+ (guard hook), the GitHub MCP server connected, and for verification either Playwright MCP or Claude in Chrome.

## Per-project setup

In the project, run `/devflow:init`. It detects remotes, branches and scripts, writes `.claude/devflow.json` (with its schema), checks that `CLAUDE.md` covers what the workflows rely on, and offers to install the two GitHub Actions (review on PR open, mention handler). Add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret if you install them.

Required config keys: `github`, `baseBranch`, `checks`. Everything else has defaults; see `skills/init/templates/devflow.json` and `devflow.schema.json`.

## Usage

- `/devflow:spec add CSV export to the reports page`: runs in a cloud session or locally. Before the spec PR, a QA agent that sees only the written spec drafts a test matrix and asks about criteria it cannot test (`spec.testMatrix`, default on; `spec.qaModel`, default `opus`). Stops at Gate 1 until you merge the spec PR, then creates the issues with their test-case rows; `next-task` requires a test for every `must` row.
- `/devflow:next-task`: up to `nextTask.defaultLimit` ready issues, sequentially in your checkout. `/devflow:next-task 2` or `/devflow:next-task #12 #15` for a specific number or issues. Your working tree must be clean; your branch is restored after each issue. The command also lists `/devflow:next-task-engine`: that is the workflow script it runs internally (Claude Code registers every plugin workflow as a command). Do not run it directly; without the arguments the skill builds it stops with a message.
- `/devflow:address-reviews [#pr ...]`: fixes, answers or declines each unresolved review thread, pushes new commits, replies, and asks for one more automated review (limited by `nextTask.maxReviewRounds`).

Issue state is a label state machine: ready, in-progress, review, blocked (names configurable). A blocked issue gets a comment saying which stage failed and what a human must decide; its branch is pushed so no work is lost.

## Safety

- Humans own merges. The plugin pushes only its own feature branches, never merges, never pushes to `baseBranch` or `protectedBranches`, and never force-pushes (except `--force-with-lease` on its own branch).
- A PreToolUse hook (`hooks/guard.py`) enforces this: it blocks MCP `merge_pull_request`, `gh pr merge`, `gh api .../merge`, pushes to protected branches (explicit refspec, `--delete`, or a bare push while on one), `--force`, `-f`, `+refspec`, `--mirror` and `--all`. It reads the protected branches from `.claude/devflow.json` and falls back to `main`, `master`, `develop`. It guards against habit, not deliberate evasion.
- All committed content is English. No `Co-Authored-By` or AI attribution is added unless the project's `CLAUDE.md` says otherwise.
- Issues and PRs never contain the review bot's at-sign handle, except the deliberate re-review comment in `address-reviews`.

Run the hook tests with `python3 -m unittest discover -s hooks -p 'test_*.py' -v`.

## Permissions snippet

Merge into the project's `.claude/settings.json` so the workflow does not stop on routine prompts. Adjust the commands to your `checks`.

```json
{
  "permissions": {
    "allow": [
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git fetch:*)",
      "Bash(git switch:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push -u origin:*)",
      "Bash(git branch:*)",
      "Bash(git stash:*)",
      "Bash(curl:*)",
      "mcp__github__*"
    ],
    "deny": [
      "Bash(git push --force:*)",
      "Bash(gh pr merge:*)"
    ]
  }
}
```

The `mcp__github__*` pattern depends on how your GitHub MCP server is named; use the name shown by `/mcp`. Add each `checks[].run` command (for example `Bash(npm test:*)`).

## Out of scope for v1

Parallel task execution (worktrees), GitHub Projects board sync, uploading screenshots to PRs.

## License

MIT
