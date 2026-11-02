# devflow

A Claude Code plugin with five project-agnostic workflows (v2 wave 3):

1. `/devflow:spec <idea>`: idea, analysis, grill-me interview, spec with a risk level per task, QA test matrix, spec PR, Gate 1 (a human merges, which also approves the risk levels), then one GitHub issue per task labelled ready and `risk:low|high`.
2. `/devflow:next-task [limit | #issue ...] [--isolated] [--chain]`: pick up to N ready issues, claim each, post a plan on it, implement (a QA agent writes the acceptance tests in parallel with the dev agent), run checks, verify against the running app, review, and open a PR labelled with its risk. An issue whose open dependencies all have open PRs is stacked on them. `--isolated` runs in its own git worktree.
3. `/devflow:dispatch [max lanes]`: split the ready issues into non-colliding lanes and start one background session per lane.
4. `/devflow:sync [#pr ...]`: keep those PRs mergeable: retarget stacked PRs, update behind branches, resolve conflicts, address review threads.
5. `/devflow:answer #issue [answers]`: answer the questions that blocked an issue; records them in the spec (PR) and the issue and sets it ready again.

Claude never merges. `risk:low` PRs are merged by an optional GitHub Action (the merge gate) once its checks are green; `risk:high` PRs wait for a human.

Nothing in the plugin knows about a specific stack. Project mechanics live in `.claude/devflow.json`; project rules (architecture, conventions, a "Never" list) live in the project's `CLAUDE.md`. See [DESIGN.md](DESIGN.md) for the full design.

## Install

```
/plugin marketplace add nhanle-agilityio/devflow
/plugin install devflow@nhanle-devflow
```

Requirements: Python 3.9+ (guard hook), the GitHub MCP server connected, and for verification either Playwright MCP or Claude in Chrome.

## Per-project setup

In the project, run `/devflow:init`. It detects remotes, branches and scripts, writes `.claude/devflow.json` (with its schema), asks about risk rules, the merge gate and `testing.e2eFramework`, checks that `CLAUDE.md` covers what the workflows rely on, and offers to install three GitHub Actions (each a separate yes): `claude-code-review.yml` (review check), `devflow-merge-gate.yml` with `.github/scripts/devflow-merge-gate.cjs`, and `claude.yml` (mention handler). Add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret for the review and mention workflows; the merge gate needs more, see the checklist below.

Required config keys: `github`, `baseBranch`, `checks`. Everything else has defaults; see `skills/init/templates/devflow.json` and `devflow.schema.json`. v2 wave 1 adds `labels.devflow|riskLow|riskHigh|stacked`, `risk` (`highWhen`, `highPaths`), `mergeGate` (`enabled` false, `dryRun` true, `requiredChecks`, `method`) and `testing.e2eFramework` (false). v2 wave 2 adds `worktree` (`dir` default `.claude/worktrees`, `setup` commands run once in a fresh worktree, e.g. `make setup`) and `dispatch` (`maxLanes` default 3, optional `pluginDir` passed as `--plugin-dir` to background sessions). v2 wave 3 adds `nextTask.parallelQa` (default true). `/devflow:init` also proposes `worktree.setup`, a `.gitignore` entry for the worktree dir and the allow rules background sessions need.

## Setup checklist for the merge gate

Skip this if humans merge everything. The gate exists for private repos on GitHub Free: no branch protection, no required checks, no native auto-merge.

1. Install `devflow-merge-gate.yml` and `.github/scripts/devflow-merge-gate.cjs` (via `/devflow:init`) and merge the PR that adds them. The workflow must be on the repository default branch: `workflow_run` and `status` triggers only run from there.
2. Add the repository secret `DEVFLOW_GATE_TOKEN`: a fine-grained personal access token limited to this repository with Contents and Pull requests read/write. `GITHUB_TOKEN` does not work: pushes and merges made with it do not trigger CI.
3. Add the repository secret `CLAUDE_CODE_OAUTH_TOKEN` for the review workflow.
4. Enable "Allow merge commits" in the repository settings (the gate merges with merge commits, which stacked PRs need).
5. In the gate workflow, list under `workflow_run.workflows` the `name:` of every workflow that produces a required check: your CI workflow(s) and `"Claude Code Review"`. The `devflow/review` status is made with `GITHUB_TOKEN` and does not fire `status` events; the review workflow finishing is what wakes the gate.
6. Set `mergeGate.requiredChecks` to the check run names or status contexts that must be green. Default `["devflow/review"]`; add your CI job names.
7. Set `mergeGate.enabled` to true but keep `dryRun` true at first. The run summary lists what each PR would get (merge, update, block, skip). Set `dryRun` to false when it looks right.

The gate merges at most one PR per run. A PR is merged only when: it has the `devflow` and `risk:low` labels and is not a draft or labelled blocked; its base is `baseBranch`; no `Depends on` issue of its linked issue is still open; it is mergeable; it is not behind its base (otherwise the branch is updated and CI runs again); every `requiredChecks` entry is green on the head SHA; and no review thread is unanswered. Then it merges with a merge commit, retargets PRs stacked on it to `baseBranch` and deletes the head branch. A conflicting PR and its issue get the blocked label and a comment pointing at `/devflow:sync`.

## Usage

- `/devflow:spec add CSV export to the reports page`: runs in a cloud session or locally. Each task gets `risk: low|high` with a one-line reason, judged against `risk.highWhen` and `risk.highPaths` (unsure means high), plus the files other tasks are likely to touch (hotspots, recorded only). Before the spec PR, a QA agent that sees only the written spec drafts a test matrix and asks about criteria it cannot test (`spec.testMatrix`, default on; `spec.qaModel`, default `opus`). Stops at Gate 1: merging the spec PR approves the tasks and their risk levels. Then it creates the issues with their risk label and test-case rows; `next-task` requires a test for every `must` row.
- `/devflow:next-task`: up to `nextTask.defaultLimit` ready issues, sequentially. `/devflow:next-task 2` or `/devflow:next-task #12 #15` for a specific number or issues. Per issue the stages are Claim → Branch → [Integrate] → Plan → Implement (→ Commit with parallel QA) → Check → Verify → Review → Ship. Your working tree must be clean. Without `--isolated` it works in your checkout and your branch is restored after each issue; see Parallel work for `--isolated` and `--chain`. The command also lists `/devflow:next-task-engine`: that is the workflow script it runs internally (Claude Code registers every plugin workflow as a command). Do not run it directly; without the arguments the skill builds it stops with a message.
- `/devflow:dispatch [max lanes]`: see Parallel work.
- `/devflow:sync [#pr ...]` (replaces `/devflow:address-reviews`): for your open PRs labelled `devflow`, parents before children: retargets a stacked PR to `baseBranch` once its parent merged, updates a behind branch, resolves merge conflicts with a merge commit (never a rebase or force push), then fixes, answers or declines each unresolved review thread with new commits and a reply on every thread. Pushing re-runs the automated review by itself, so it posts no re-review comment. A hidden `<!-- devflow-sync -->` marker comment counts rounds, limited by `nextTask.maxReviewRounds`. After resolving conflicts it removes the blocked label from the PR and its issue.

- `/devflow:answer #12 [1: answer; 2: answer]`: for an issue blocked with questions. Finds the latest `<!-- devflow-questions -->` comment, takes the answers from the arguments or from human replies after it (every question needs one, otherwise nothing changes), records them in the spec through a small PR (`docs(#12): record answers to open questions`, labelled `devflow` and `risk:low`, `Refs #12`) and in the issue body (`## Decisions`, updated criteria marked), then deletes the claim comments, swaps blocked and in-progress for ready and posts "Ready again: run /devflow:next-task #12". Never merges.

Issue state is a label state machine: ready, in-progress, review, blocked (names configurable). A blocked issue gets a comment saying which stage failed and what a human must decide; its branch is pushed so no work is lost. When the block is about questions, the comment is one merged list (see Plans and claims) and `/devflow:answer` unblocks it.

### Risk

Each issue and PR carries `labels.riskLow` or `labels.riskHigh`. The spec judges it per task; you approve it by merging the spec PR. `next-task` escalates a PR to high, deterministically, when a changed file matches `risk.highPaths` (and also labels the issue high). An issue with no risk label counts as high. The PR body has a `Risk: low|high - reason` line.

### Review check

`claude-code-review.yml` reviews each PR with Opus and publishes the commit status `devflow/review` (success or failure) from a hidden `devflow-verdict` marker that the review bot puts at the end of its summary comment (it carries the head SHA; only the bot's comment counts); a missing marker, or one for another SHA, is a failure. It re-runs on every push (`synchronize`), but when the only new commits are clean base merges made by GitHub's update-branch it carries the previous verdict over instead of reviewing again. Only a real verdict is carried (a pass, or "N critical, M warning"); a failure without a verdict, or a change to the review workflow itself in those commits, always gets a fresh review. The PR also gets one summary comment and inline comments; the review never approves or requests changes.

### Stacked PRs

If every open `Depends on` issue has an open PR, or shipped earlier in the same run, the issue is stacked and labelled `labels.stacked`. One parent: `next-task` branches from the parent PR's branch and opens the PR against it; after the parent merges, the merge gate (or `/devflow:sync`) retargets the child to `baseBranch`. Several parents: the branch starts from `baseBranch`, an Integrate stage (sonnet) merges every parent branch into it (resolving conflicts between them), and the PR targets `baseBranch`; its diff shrinks to the child's own changes as the parents merge. The merge gate never merges a PR while any `Depends on` issue of its linked issue is open. A parent that did not ship in the run, or an open dependency without a PR, skips the issue with the reason. A parent PR the merge gate merges while the child is still being built (its branch deleted) is handled too: Branch starts from `baseBranch` when the parent is already gone, Integrate skips a merged parent, and Ship re-reads the parent PR before opening the child, so a child whose single parent merged opens against `baseBranch`, not stacked.

Implement must read the spec: the engine takes the spec path from the issue body, tells the agent to start with `git show <base>:<path>`, and requires `specRead` in its result. If the path is missing there, one Fix round re-checks the change against the spec; if it is still missing, the issue is blocked.

### Verification and e2e rows

Verify runs when the issue is labelled `needs-e2e`, the diff touches UI, or its Test cases table has a row with level `http` or `e2e`. With `testing.e2eFramework` false (default), `e2e` must rows are covered by Verify against the running app instead of committed tests; with true they need committed tests like any other row.

### Plans and claims

- **Claim** is a lock on the issue. If it already has an assignee or the in-progress / blocked label, it is skipped. Otherwise the run assigns itself, swaps ready for in-progress and posts a `<!-- devflow-claim id=... -->` comment, then reads all claim comments back: the earliest wins (ties by comment id). A loser deletes only its own comment and skips the issue ("claimed by <id>"). Branch creation is a separate step after a won claim; if the branch name already exists locally with no commits of its own and is not on the remote (left over from a run blocked at Plan), Branch recreates it from the parent ref instead of blocking. A blocked run also deletes its own claim comment.
- **Parallel QA** (`nextTask.parallelQa`, default true): Plan also returns `qaFiles` (test files the QA agent owns, for the Test cases rows) and `devFiles` (files the dev agent changes); a file in both blocks the issue at Plan ("ownership overlap"). When `qaFiles` is non-empty, Implement runs two sonnet agents in parallel in the same checkout, neither committing: QA writes the acceptance tests for every `must` row from the spec and issue only (black box, it never reads the implementation diff) and touches only `qaFiles`; Dev writes the implementation and touches no `qaFiles` (extra tests go in other files). A Commit stage then commits the QA tests first (`test(#n): ...`), confirms they fail with the implementation stashed, and commits the implementation. The engine blocks the issue if QA changed a file outside `qaFiles` or dev changed a QA file. Fix rounds never edit `qaFiles`; a fix agent that thinks a QA test is wrong returns blocked with a `[QA]` question. With `parallelQa` false, or without `qaFiles` (for example docs-only issues), one Implement agent writes the test first, then the implementation.
- **Merged questions**: questions from Plan (BA: spec gaps; QA: Test cases rows not testable as written), from the QA agent and from the dev agent go into ONE comment whose first line is `<!-- devflow-questions -->`, numbered and tagged [BA], [QA] or [Dev], ending with "Answer with /devflow:answer #<n>, or reply on this issue with numbered answers." The issue is blocked once with all of them. Blocking also deletes the run's own claim comment. A `## Decisions` section in the issue body overrides the spec where they differ, in Plan and Implement.
- **Plan** runs after Branch (and Integrate): a sonnet agent reads the spec and the code, and posts a plan on the issue as a comment starting with `<!-- devflow-plan -->` (edited in place on a re-run): files to change, tests per Test cases row, risks, order of commits, open questions. Nobody approves it. If the spec and the issue leave a behaviour question open, the plan is posted and the issue is blocked with the merged questions comment before any code is written. Otherwise Implement follows the plan and records deviations under assumptions.

## Parallel work

One ticket per session, each in its own git worktree, so sessions never share a working tree.

- `/devflow:next-task #12 --isolated`: creates a worktree under `worktree.dir` (`git worktree add --detach` from `<remote>/<baseBranch>`), enters it, runs each `worktree.setup` command, then runs the workflow there. There is no start branch to restore and a detached HEAD is fine. Afterwards a worktree with no uncommitted changes and everything pushed is removed; otherwise it is kept and its path is reported. A fresh worktree needs its own setup (about 3 s for `make setup` on TaskBoard).
- Claims: each run gets a `claimId` (timestamp, name, pid, random). Two sessions on the same issue race on the claim comments; one wins, the other skips. See Plans and claims. Every ticket gets its plan posted on the issue.
- Lanes: `bin/devflow-lanes` groups issues that share a hotspot file (the `## Hotspots` list in the issue, exact path) or depend on each other (inside the set). A lane runs its issues in order, parents first, each stacked on the previous one's PR: `/devflow:next-task #a #b --chain`. Tasks that touch the same files therefore never run in parallel, so parallel lanes never conflict. Lanes beyond `dispatch.maxLanes` are deferred; a dependency cycle is kept in number order with a warning. If an issue of a lane does not ship (blocked, skipped, claimed elsewhere), the lane continues: the next issue stacks on the last issue that shipped, or starts from the base; only an issue with a real `Depends on` the failed one is skipped.
- `/devflow:dispatch N`: lists the schedulable ready issues (issues waiting for an open dependency that has no PR and is not in the set are left out and listed), plans the lanes (`N` overrides `dispatch.maxLanes`), prints the plan, and starts one background session per lane: `claude --bg "/devflow:next-task #a #b --chain --isolated"`. If `claude --bg` fails, it prints the equivalent `claude -w lane-<n> "..."` commands to run in a terminal. It never merges.
- Follow the sessions: `claude agents`, `claude logs <id>`, `claude attach <id>`.
- Background sessions need a trusted workspace and cannot answer permission prompts, so the project needs allow rules (or an auto permission mode); `/devflow:init` offers them (see Permissions snippet).
- Cleanup: finished worktrees remove themselves (above). A kept one: `git worktree remove <path>` after you have looked at it; `git worktree prune` for stale entries.

## Safety

- Claude never merges. The plugin pushes only its own feature branches, never merges, never pushes to `baseBranch` or `protectedBranches`, and never force-pushes (except `--force-with-lease` on its own branch). `/devflow:sync` only adds commits and pushes normally.
- Merging is done by a human, or for `risk:low` PRs by the merge gate Action, which runs outside Claude with its own token, merges at most one PR per run and is off until `mergeGate.enabled` (dry run first).
- A PreToolUse hook (`hooks/guard.py`) enforces this: it blocks MCP `merge_pull_request`, `gh pr merge`, `gh api .../merge`, GraphQL merge mutations, pushes to protected branches (explicit refspec, `--delete`, or a bare push while on one), `--force`, `-f`, `+refspec`, `--mirror` and `--all`. Retargeting a PR and updating its branch (`update_pull_request`, `update_pull_request_branch`) are allowed. It reads the protected branches from `.claude/devflow.json` and falls back to `main`, `master`, `develop`. It guards against habit, not deliberate evasion.
- All committed content is English. No `Co-Authored-By` or AI attribution is added unless the project's `CLAUDE.md` says otherwise.
- Issues, PRs, comments and replies never contain the review bot's at-sign handle. Pushing new commits re-triggers the review, so no trigger comment is needed. The only place the handle appears is the mention-handler workflow `claude.yml`, whose trigger it is.

Run the hook tests with `python3 -m unittest discover -s hooks -p 'test_*.py' -v` and the merge gate and lane planner tests with `node --test tests/*.test.cjs`.

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
      "Bash(git push origin:*)",
      "Bash(git merge:*)",
      "Bash(git branch:*)",
      "Bash(git worktree:*)",
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

The `mcp__github__*` pattern depends on how your GitHub MCP server is named; use the name shown by `/mcp`. Add each `checks[].run` command (for example `Bash(npm test:*)`). `git worktree` is for `--isolated` runs; also add each `worktree.setup` command and, for background sessions started by `/devflow:dispatch`, make sure everything above is allowed since they cannot answer prompts. `git merge` is for `/devflow:sync` (merging the base into a PR branch; the guard hook still blocks merging PRs and pushes to protected branches). Use your remote's name instead of `origin` if it differs.

## Out of scope

Later: updating the Flow Map (`docs/devflow-flows.html`). Not planned: GitHub Projects board sync, uploading screenshots to PRs. Within one session issues still run sequentially; parallelism is across sessions.

## License

MIT
